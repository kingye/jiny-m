/**
 * AlertService — monitors application logs for errors and sends batched
 * alert digest emails via the OutboundAdapter. Also provides periodic
 * health check reports summarizing message processing activity.
 *
 * Subscribes to the Logger's EventEmitter and:
 * 1. Maintains a rolling window of recent log lines (for error context)
 * 2. Buffers ERROR-level entries
 * 3. On a configurable interval, flushes the buffer into a digest email
 *    including surrounding log context and per-thread reply-tool.log tails
 * 4. Tracks processing stats from log events for health check reports
 * 5. Periodically sends a health check summary email
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AlertingConfig, OutboundAdapter } from '../types';
import { logger, type LogEvent } from './logger';

/** A buffered error entry with context. */
interface ErrorEntry {
  timestamp: string;
  message: string;
  meta?: any;
  /** Thread name extracted from meta (if available). */
  thread?: string;
  /** Surrounding log lines captured at the time of the error. */
  context: string[];
}

/** Per-thread processing stats for health check reports. */
interface ThreadStats {
  received: number;
  processed: number;
  errors: number;
}

/** Cumulative stats tracked from log events, reset after each health report. */
interface HealthStats {
  messagesReceived: number;
  messagesMatched: number;
  messagesProcessed: number;
  repliesSent: number;
  repliesByTool: number;
  repliesByFallback: number;
  errors: number;
  dropped: number;
  perThread: Map<string, ThreadStats>;
  periodStart: Date;
}

/** Stats getter interface — allows injecting ThreadManager without tight coupling. */
export interface QueueStatsProvider {
  getStats(): {
    activeWorkers: number;
    pendingThreads: number;
    threadQueues: Array<{ thread: string; size: number; processing: boolean }>;
  };
}

export class AlertService {
  private config: AlertingConfig;
  private outboundAdapter: OutboundAdapter;
  private workspaceFolder: string;
  private queueStatsProvider?: QueueStatsProvider;

  /** Buffered error entries waiting to be flushed. */
  private errorBuffer: ErrorEntry[] = [];
  /** Rolling window of recent formatted log lines (for error context). */
  private recentLogs: string[] = [];
  /** Max lines to keep in the rolling window. */
  private readonly ROLLING_WINDOW_SIZE = 100;
  /** Number of context lines to capture before each error. */
  private readonly CONTEXT_LINES = 10;

  /** Health check stats, reset after each report. */
  private healthStats: HealthStats = this.createEmptyStats();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private logHandler: ((event: LogEvent) => void) | null = null;
  private started = false;

  constructor(
    outboundAdapter: OutboundAdapter,
    config: AlertingConfig,
    workspaceFolder: string,
    queueStatsProvider?: QueueStatsProvider,
  ) {
    this.outboundAdapter = outboundAdapter;
    this.config = config;
    this.workspaceFolder = workspaceFolder;
    this.queueStatsProvider = queueStatsProvider;
  }

  /**
   * Start listening to logger events and schedule periodic flushes.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Subscribe to all log events
    this.logHandler = (event: LogEvent) => this.handleLogEvent(event);
    logger.on('log', this.logHandler);

    // Schedule periodic error alert flush
    const intervalMs = (this.config.batchIntervalMinutes ?? 5) * 60 * 1000;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error(`[AlertService] Failed to flush alerts: ${err instanceof Error ? err.message : 'Unknown'}`);
      });
    }, intervalMs);

    // Schedule periodic health check (if configured)
    const hcConfig = this.config.healthCheck;
    if (hcConfig?.enabled) {
      const hcIntervalMs = (hcConfig.intervalHours ?? 24) * 60 * 60 * 1000;
      this.healthCheckTimer = setInterval(() => {
        this.sendHealthReport().catch((err) => {
          console.error(`[AlertService] Failed to send health report: ${err instanceof Error ? err.message : 'Unknown'}`);
        });
      }, hcIntervalMs);

      logger.info('Health check enabled', {
        intervalHours: hcConfig.intervalHours ?? 24,
        recipient: hcConfig.recipient || this.config.recipient,
        _alertInternal: true,
      });
    }

    logger.info('AlertService started', {
      recipient: this.config.recipient,
      batchIntervalMinutes: this.config.batchIntervalMinutes ?? 5,
      _alertInternal: true,
    });
  }

  /**
   * Stop the alert service. Flushes any pending errors before returning.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // Unsubscribe from logger events
    if (this.logHandler) {
      logger.removeListener('log', this.logHandler);
      this.logHandler = null;
    }

    // Clear timers
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Flush remaining errors
    if (this.errorBuffer.length > 0) {
      try {
        await this.flush();
      } catch (err) {
        console.error(`[AlertService] Failed to flush on shutdown: ${err instanceof Error ? err.message : 'Unknown'}`);
      }
    }
  }

  /**
   * Handle a log event from the Logger.
   */
  private handleLogEvent(event: LogEvent): void {
    // Skip self-generated log events to prevent infinite loops
    if (event.meta?._alertInternal) return;

    // Add to rolling context window
    const formatted = this.formatLogLine(event);
    this.recentLogs.push(formatted);
    if (this.recentLogs.length > this.ROLLING_WINDOW_SIZE) {
      this.recentLogs.shift();
    }

    // Track health stats from log events
    this.trackHealthStats(event);

    // Buffer ERROR-level events
    if (event.level === 'ERROR') {
      const maxErrors = this.config.maxErrorsPerBatch ?? 50;
      if (this.errorBuffer.length >= maxErrors) return; // Buffer full, drop

      const entry: ErrorEntry = {
        timestamp: event.timestamp,
        message: event.message,
        meta: event.meta,
        thread: event.meta?.thread,
        context: this.recentLogs.slice(-this.CONTEXT_LINES),
      };

      this.errorBuffer.push(entry);
    }
  }

  // ========================================================================
  // Health stats tracking (from log event messages)
  // ========================================================================

  /**
   * Inspect log events to track processing stats for health reports.
   * Pattern-matches on well-known log messages emitted by the system.
   */
  private trackHealthStats(event: LogEvent): void {
    const msg = event.message;
    const meta = event.meta;
    const thread = meta?.thread as string | undefined;

    // Message received (from monitor.ts onMessage callback)
    if (msg === 'Message received') {
      this.healthStats.messagesReceived++;
      return;
    }

    // Pattern matched (from message-router.ts)
    if (msg === 'Pattern matched') {
      this.healthStats.messagesMatched++;
      return;
    }

    // Reply sent via MCP tool (from thread-manager.ts)
    if (msg === 'Reply sent via MCP reply_message tool') {
      this.healthStats.messagesProcessed++;
      this.healthStats.repliesSent++;
      this.healthStats.repliesByTool++;
      if (thread) this.getThreadStats(thread).processed++;
      return;
    }

    // Reply sent via fallback (from thread-manager.ts)
    if (msg === 'Reply sent via outbound adapter (fallback)') {
      this.healthStats.messagesProcessed++;
      this.healthStats.repliesSent++;
      this.healthStats.repliesByFallback++;
      if (thread) this.getThreadStats(thread).processed++;
      return;
    }

    // Generated reply (from opencode service — covers all reply paths)
    if (msg === 'Generated reply') {
      // Only count if not already counted by the more specific tool/fallback messages
      return;
    }

    // Worker finished (from thread-manager.ts)
    if (msg === 'Worker finished') {
      // Worker finished processing a message for a thread
      if (thread) this.getThreadStats(thread).received++;
      return;
    }

    // Failed to process message (from thread-manager.ts)
    if (msg === 'Failed to process message') {
      this.healthStats.errors++;
      if (thread) this.getThreadStats(thread).errors++;
      return;
    }

    // Queue full, dropping message (from thread-manager.ts)
    if (msg.includes('Queue full') || msg.includes('dropping message')) {
      this.healthStats.dropped++;
      return;
    }
  }

  private getThreadStats(thread: string): ThreadStats {
    let stats = this.healthStats.perThread.get(thread);
    if (!stats) {
      stats = { received: 0, processed: 0, errors: 0 };
      this.healthStats.perThread.set(thread, stats);
    }
    return stats;
  }

  private createEmptyStats(): HealthStats {
    return {
      messagesReceived: 0,
      messagesMatched: 0,
      messagesProcessed: 0,
      repliesSent: 0,
      repliesByTool: 0,
      repliesByFallback: 0,
      errors: 0,
      dropped: 0,
      perThread: new Map(),
      periodStart: new Date(),
    };
  }

  // ========================================================================
  // Health check report
  // ========================================================================

  /**
   * Send a health check report and reset stats.
   * Can be called manually or by the periodic timer.
   */
  async sendHealthReport(): Promise<void> {
    if (!this.outboundAdapter.sendAlert) {
      console.error('[AlertService] OutboundAdapter does not support sendAlert()');
      return;
    }

    const stats = this.healthStats;
    this.healthStats = this.createEmptyStats();

    const hcConfig = this.config.healthCheck;
    const recipient = hcConfig?.recipient || this.config.recipient;
    const subject = this.buildHealthSubject(stats);
    const body = this.buildHealthBody(stats);

    try {
      const result = await this.outboundAdapter.sendAlert(recipient, subject, body);
      logger.info('Health check email sent', {
        recipient,
        messageId: result.messageId,
        _alertInternal: true,
      });
    } catch (err) {
      console.error(`[AlertService] Failed to send health check: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }

  /** Expose current stats for testing. */
  getHealthStats(): Readonly<HealthStats> {
    return this.healthStats;
  }

  private buildHealthSubject(stats: HealthStats): string {
    const prefix = this.config.subjectPrefix ?? 'Jiny-M';
    const status = stats.errors > 0 ? 'DEGRADED' : 'OK';
    return `${prefix} Health: ${status} | ${stats.messagesProcessed} processed, ${stats.errors} errors`;
  }

  private buildHealthBody(stats: HealthStats): string {
    const lines: string[] = [];
    const now = new Date();
    const periodStart = stats.periodStart;

    lines.push(`Jiny-M Health Check Report`);
    lines.push(`==========================`);
    lines.push(``);
    lines.push(`Period: ${this.formatDateTime(periodStart)} -- ${this.formatDateTime(now)}`);
    lines.push(`Status: ${stats.errors > 0 ? 'DEGRADED' : 'OK'}`);
    lines.push(``);

    // --- Summary ---
    lines.push(`Summary`);
    lines.push(`-------`);
    lines.push(`Messages received:     ${stats.messagesReceived}`);
    lines.push(`Messages matched:      ${stats.messagesMatched}`);
    lines.push(`Messages processed:    ${stats.messagesProcessed}`);
    lines.push(`Replies sent:          ${stats.repliesSent}`);
    lines.push(`  - via MCP tool:      ${stats.repliesByTool}`);
    lines.push(`  - via fallback:      ${stats.repliesByFallback}`);
    lines.push(`Errors:                ${stats.errors}`);
    lines.push(`Dropped (queue full):  ${stats.dropped}`);
    lines.push(``);

    // --- Per-thread activity ---
    if (stats.perThread.size > 0) {
      lines.push(`Per-Thread Activity`);
      lines.push(`-------------------`);
      for (const [thread, ts] of stats.perThread) {
        lines.push(`Thread: ${thread}`);
        lines.push(`  Received: ${ts.received} | Processed: ${ts.processed} | Errors: ${ts.errors}`);
      }
      lines.push(``);
    }

    // --- Current queue status (live) ---
    if (this.queueStatsProvider) {
      const queueStats = this.queueStatsProvider.getStats();
      lines.push(`Current Queue Status`);
      lines.push(`--------------------`);
      lines.push(`Active workers: ${queueStats.activeWorkers}`);
      lines.push(`Pending threads: ${queueStats.pendingThreads}`);
      if (queueStats.threadQueues.length > 0) {
        for (const q of queueStats.threadQueues) {
          lines.push(`  ${q.thread}: ${q.size} queued, ${q.processing ? 'processing' : 'idle'}`);
        }
      } else {
        lines.push(`  (all queues empty)`);
      }
      lines.push(``);
    }

    return lines.join('\n');
  }

  private formatDateTime(date: Date): string {
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  }

  // ========================================================================
  // Error alert digest
  // ========================================================================

  /**
   * Flush buffered errors into a digest email.
   */
  async flush(): Promise<void> {
    if (this.errorBuffer.length === 0) return;

    // Drain the buffer
    const errors = this.errorBuffer.splice(0);
    const maxErrors = this.config.maxErrorsPerBatch ?? 50;
    const truncated = errors.length > maxErrors;
    const batch = truncated ? errors.slice(0, maxErrors) : errors;

    // Build the email
    const subject = this.buildAlertSubject(batch.length, truncated);
    const body = await this.buildAlertBody(batch, truncated, errors.length);

    // Send via outbound adapter
    if (!this.outboundAdapter.sendAlert) {
      console.error('[AlertService] OutboundAdapter does not support sendAlert()');
      return;
    }

    try {
      const result = await this.outboundAdapter.sendAlert(
        this.config.recipient,
        subject,
        body,
      );
      logger.info('Alert email sent', {
        recipient: this.config.recipient,
        errorCount: batch.length,
        messageId: result.messageId,
        _alertInternal: true,
      });
    } catch (err) {
      // Use console.error to avoid re-triggering alert loop
      console.error(`[AlertService] Failed to send alert email: ${err instanceof Error ? err.message : 'Unknown'}`);
    }
  }

  private buildAlertSubject(errorCount: number, truncated: boolean): string {
    const prefix = this.config.subjectPrefix ?? 'Jiny-M Alert';
    const suffix = truncated ? '+' : '';
    return `${prefix}: ${errorCount}${suffix} error(s)`;
  }

  private async buildAlertBody(
    errors: ErrorEntry[],
    truncated: boolean,
    totalErrors: number,
  ): Promise<string> {
    const lines: string[] = [];
    const intervalMinutes = this.config.batchIntervalMinutes ?? 5;

    lines.push(`Jiny-M Alert Digest`);
    lines.push(`====================`);
    lines.push(``);
    lines.push(`${errors.length} error(s) in the last ${intervalMinutes} minutes.`);
    if (truncated) {
      lines.push(`(${totalErrors - errors.length} additional error(s) were dropped due to batch limit.)`);
    }
    lines.push(`Time: ${new Date().toISOString()}`);
    lines.push(``);

    // --- Error details ---
    lines.push(`Errors`);
    lines.push(`------`);
    lines.push(``);

    for (let i = 0; i < errors.length; i++) {
      const error = errors[i]!;
      const time = error.timestamp.split('T')[1]?.replace('Z', '') || error.timestamp;

      lines.push(`### [${time}] ${error.message}`);

      if (error.meta) {
        const meta = { ...error.meta };
        delete meta._alertInternal;
        const metaStr = JSON.stringify(meta, null, 2);
        if (metaStr !== '{}') {
          lines.push(metaStr);
        }
      }

      // Context lines
      if (error.context.length > 0) {
        lines.push(``);
        lines.push(`Context:`);
        for (const line of error.context) {
          lines.push(`  ${line}`);
        }
      }

      lines.push(``);
      if (i < errors.length - 1) lines.push(`---`);
      lines.push(``);
    }

    // --- Reply tool logs ---
    if (this.config.includeReplyToolLog !== false) {
      const threadNames = this.getUniqueThreadNames(errors);
      if (threadNames.length > 0) {
        lines.push(``);
        lines.push(`Reply Tool Logs`);
        lines.push(`---------------`);

        for (const threadName of threadNames) {
          const logContent = await this.readReplyToolLog(threadName);
          lines.push(``);
          lines.push(`### Thread: ${threadName}`);
          lines.push(``);
          if (logContent) {
            lines.push(logContent);
          } else {
            lines.push(`(no reply-tool.log found)`);
          }
          lines.push(``);
        }
      }
    }

    return lines.join('\n');
  }

  // ========================================================================
  // Shared helpers
  // ========================================================================

  /**
   * Extract unique thread names from error entries.
   */
  private getUniqueThreadNames(errors: ErrorEntry[]): string[] {
    const seen = new Set<string>();
    for (const error of errors) {
      if (error.thread && !seen.has(error.thread)) {
        seen.add(error.thread);
      }
    }
    return Array.from(seen);
  }

  /**
   * Read the last N lines of a thread's reply-tool.log.
   */
  private async readReplyToolLog(threadName: string): Promise<string | null> {
    const tailLines = this.config.replyToolLogTailLines ?? 50;
    const logPath = join(this.workspaceFolder, threadName, '.jiny', 'reply-tool.log');

    try {
      const content = await readFile(logPath, 'utf-8');
      const lines = content.split('\n');
      if (lines.length <= tailLines) {
        return content;
      }
      return `... (${lines.length - tailLines} earlier lines omitted)\n` +
        lines.slice(-tailLines).join('\n');
    } catch {
      return null;
    }
  }

  /**
   * Format a log event as a single-line string for the context window.
   */
  private formatLogLine(event: LogEvent): string {
    const time = event.timestamp.split('T')[1]?.replace('Z', '') || event.timestamp;
    const meta = event.meta
      ? ' ' + JSON.stringify(event.meta, (_key, value) => {
          if (typeof value === 'bigint') return Number(value);
          return value;
        })
      : '';
    return `[${time}] [${event.level}] ${event.message}${meta}`;
  }
}
