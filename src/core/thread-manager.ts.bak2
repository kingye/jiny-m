/**
 * Thread Manager — per-thread queues with concurrency-limited workers.
 *
 * Each thread has its own FIFO queue. Messages within a thread are processed
 * sequentially (order matters for conversation coherence). Different threads
 * process in parallel, up to maxConcurrentThreads.
 *
 * The queue is in-memory — lost on restart. IMAP re-fetch handles recovery.
 */

import type {
  InboundMessage,
  PatternMatch,
  ChannelPattern,
  AttachmentDownloadConfig,
  WorkerConfig,
} from '../channels/types';
import type { ReplyConfig, AiGeneratedReply } from '../types';
import { ChannelRegistry } from '../channels/registry';
import { MessageStorage } from './message-storage';
import { OpenCodeService } from '../services/opencode';
import { CommandRegistry } from './command-handler';
import { formatQuotedReply, prepareBodyForQuoting } from './email-parser';
import { logger } from './logger';

/** Queued item waiting to be processed. */
interface QueueItem {
  message: InboundMessage;
  threadName: string;
  patternMatch: PatternMatch;
  pattern?: ChannelPattern;
}

/** Per-thread queue state. */
class ThreadQueue {
  readonly threadName: string;
  private queue: QueueItem[] = [];
  processing: boolean = false;

  constructor(threadName: string) {
    this.threadName = threadName;
  }

  push(item: QueueItem): void {
    this.queue.push(item);
  }

  shift(): QueueItem | undefined {
    return this.queue.shift();
  }

  get size(): number {
    return this.queue.length;
  }

  get isEmpty(): boolean {
    return this.queue.length === 0;
  }
}

export class ThreadManager {
  private threadQueues = new Map<string, ThreadQueue>();
  private activeWorkers = 0;
  private pendingThreads: string[] = [];

  private maxConcurrentThreads: number;
  private maxQueueSizePerThread: number;

  private storage: MessageStorage;
  private opencode: OpenCodeService | undefined;
  private channelRegistry: ChannelRegistry;
  private replyConfig: ReplyConfig;

  constructor(options: {
    storage: MessageStorage;
    opencode?: OpenCodeService;
    channelRegistry: ChannelRegistry;
    replyConfig: ReplyConfig;
    workerConfig?: WorkerConfig;
  }) {
    this.storage = options.storage;
    this.opencode = options.opencode;
    this.channelRegistry = options.channelRegistry;
    this.replyConfig = options.replyConfig;
    this.maxConcurrentThreads = options.workerConfig?.maxConcurrentThreads ?? 3;
    this.maxQueueSizePerThread = options.workerConfig?.maxQueueSizePerThread ?? 10;
  }

  /**
   * Enqueue a message for processing. Non-blocking (fire-and-forget).
   * The message will be processed when a worker slot is available.
   */
  enqueue(
    message: InboundMessage,
    threadName: string,
    patternMatch: PatternMatch,
    pattern?: ChannelPattern,
  ): void {
    let queue = this.threadQueues.get(threadName);
    if (!queue) {
      queue = new ThreadQueue(threadName);
      this.threadQueues.set(threadName, queue);
    }

    if (queue.size >= this.maxQueueSizePerThread) {
      logger.warn('Thread queue full, dropping message', {
        thread: threadName,
        queueSize: queue.size,
        maxSize: this.maxQueueSizePerThread,
        channel: message.channel,
      });
      return;
    }

    queue.push({ message, threadName, patternMatch, pattern });
    logger.debug('Message enqueued', {
      thread: threadName,
      queueSize: queue.size,
      activeWorkers: this.activeWorkers,
      channel: message.channel,
    });

    this.tryProcessNext(threadName);
  }

  /**
   * Try to start processing the next message in a thread's queue.
   * Respects the concurrency limit.
   */
  private tryProcessNext(threadName: string): void {
    const queue = this.threadQueues.get(threadName);
    if (!queue || queue.isEmpty || queue.processing) return;

    if (this.activeWorkers >= this.maxConcurrentThreads) {
      // No slot available — add to pending list
      if (!this.pendingThreads.includes(threadName)) {
        this.pendingThreads.push(threadName);
        logger.debug('Thread waiting for worker slot', {
          thread: threadName,
          activeWorkers: this.activeWorkers,
          pendingThreads: this.pendingThreads.length,
        });
      }
      return;
    }

    this.activeWorkers++;
    queue.processing = true;

    logger.info('Worker started for thread', {
      thread: threadName,
      activeWorkers: this.activeWorkers,
      maxConcurrent: this.maxConcurrentThreads,
    });

    // Process asynchronously — fire-and-forget from the queue's perspective
    this.processMessage(queue).finally(() => {
      queue.processing = false;
      this.activeWorkers--;

      logger.debug('Worker finished', {
        thread: threadName,
        activeWorkers: this.activeWorkers,
        queueRemaining: queue.size,
      });

      // If more messages in this queue, continue
      if (!queue.isEmpty) {
        this.tryProcessNext(threadName);
      } else {
        // Clean up empty queues to prevent memory growth
        // (keep for a short time in case more messages arrive)
      }

      // Check if any pending threads can start
      while (this.pendingThreads.length > 0 && this.activeWorkers < this.maxConcurrentThreads) {
        const next = this.pendingThreads.shift()!;
        this.tryProcessNext(next);
      }
    });
  }

  /**
   * Process a single message from a thread queue.
   * This is the worker's main logic: store → generate reply → send.
   */
  private async processMessage(queue: ThreadQueue): Promise<void> {
    const item = queue.shift();
    if (!item) return;

    const { message, threadName, patternMatch, pattern } = item;

    try {
      // 1. Store the inbound message
      const attachmentConfig = pattern?.attachments;
      const { threadPath, messageDir } = await this.storage.store(
        message,
        threadName,
        attachmentConfig,
      );

      logger.info('Message stored, generating reply...', {
        thread: threadName,
        messageDir,
        channel: message.channel,
      });

      // 2. Process commands (e.g., /model) and strip them from the body
      const commandRegistry = new CommandRegistry();
      const commands = commandRegistry.parseCommands(message.content.text);
      const commandResults: string[] = [];
      if (commands.length > 0) {
        for (const cmd of commands) {
          const result = await commandRegistry.execute(cmd, {
            email: {
              id: message.id,
              from: message.senderAddress || message.sender,
              subject: message.topic,
            },
            threadPath,
            config: { maxFileSize: '25mb', allowedExtensions: [] },
          });
          if (result.message) {
            logger.info('Command result', { command: cmd.handler.name, message: result.message });
            commandResults.push(`${cmd.handler.name}: ${result.message}`);
          }
          if (!result.success && result.error) {
            logger.warn('Command failed', { command: cmd.handler.name, error: result.error });
            commandResults.push(`${cmd.handler.name}: ${result.error}`);
          }
        }
        // Strip executed command lines from the message body so the AI doesn't see them
        const commandNames = new Set(commands.map(c => c.handler.name));
        if (message.content.text) {
          message.content.text = message.content.text
            .split('\n')
            .filter(line => {
              const trimmed = line.trim();
              if (!trimmed.startsWith('/')) return true;
              const cmdName = trimmed.split(/\s+/)[0]?.toLowerCase();
              return !cmdName || !commandNames.has(cmdName);
            })
            .join('\n');
        }

        // If body is empty after stripping commands, send command results directly
        // and skip AI processing.
        if (commandResults.length > 0 && (!message.content.text || !message.content.text.trim())) {
          // Reply disabled → store only, no outbound reply
          if (!this.replyConfig.enabled) {
            logger.info('Reply disabled, command results stored only', { thread: threadName });
            return;
          }

          const summary = commandResults.join('\n');
          await this.sendDirectReply(message, summary, threadPath, messageDir);
          return;
        }
      }

      // 3. Check if reply is enabled
      if (!this.replyConfig.enabled) {
        logger.info('Reply disabled, message stored only', { thread: threadName });
        return;
      }

      // 4. Generate AI reply
      if (this.replyConfig.mode === 'opencode' && this.opencode) {
        const aiReply = await this.opencode.generateReply(message, threadPath, messageDir);

        // If the MCP tool sent the reply, we're done
        if (aiReply.replySentByTool) {
          logger.info('Reply sent via MCP reply_message tool', {
            thread: threadName,
            channel: message.channel,
          });
          return;
        }

        // Fallback: MCP tool not used, send via outbound adapter directly
        logger.info('MCP tool not used, sending reply via outbound adapter', {
          thread: threadName,
          channel: message.channel,
        });

        await this.sendFallbackReply(message, aiReply, threadPath, messageDir);

      } else if (this.replyConfig.mode === 'static') {
        const replyText = this.replyConfig.text || '';
        if (replyText) {
          await this.sendDirectReply(message, replyText, threadPath, messageDir);
        }
      }

    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to process message', {
        thread: threadName,
        channel: message.channel,
        error: msg,
      });
    }
  }

  /**
   * Send a fallback reply when the MCP tool wasn't used.
   * Uses the outbound adapter for the originating channel.
   */
  private async sendFallbackReply(
    message: InboundMessage,
    aiReply: AiGeneratedReply,
    threadPath: string,
    messageDir: string,
  ): Promise<void> {
    const replyText = aiReply.text;

    if (!replyText || replyText.trim().length === 0) {
      logger.warn('Generated reply is empty, skipping send', { channel: message.channel });
      await this.storage.storeReply(threadPath, '[Empty reply - not sent]', messageDir);
      return;
    }

    // Build full reply with quoted history (same as MCP tool path)
    const fullReplyText = await this.buildFullReplyText(replyText, message, threadPath, messageDir);

    try {
      const adapter = this.channelRegistry.getOutbound(message.channel);
      await adapter.sendReply(message, fullReplyText);
      logger.info('Fallback reply sent', { channel: message.channel });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to send fallback reply', { channel: message.channel, error: msg });
    }

    await this.storage.storeReply(threadPath, fullReplyText, messageDir);
  }

  /**
   * Send a direct reply (e.g. static mode).
   */
  private async sendDirectReply(
    message: InboundMessage,
    replyText: string,
    threadPath: string,
    messageDir: string,
  ): Promise<void> {
    // Build full reply with quoted history
    const fullReplyText = await this.buildFullReplyText(replyText, message, threadPath, messageDir);

    try {
      const adapter = this.channelRegistry.getOutbound(message.channel);
      await adapter.sendReply(message, fullReplyText);
      logger.info('Direct reply sent', { channel: message.channel });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to send direct reply', { channel: message.channel, error: msg });
    }

    await this.storage.storeReply(threadPath, fullReplyText, messageDir);
  }

  /**
   * Build full reply text with quoted history from the in-memory message.
   * The message.content.text contains the full body (cleaned at InboundAdapter boundary,
   * NOT stripped — stripping only happens in PromptBuilder for AI token budget).
   */
  private async buildFullReplyText(replyText: string, message: InboundMessage, threadPath: string, messageDir: string): Promise<string> {
    let quotedHistory: string;
    try {
      quotedHistory = await prepareBodyForQuoting(
        threadPath,
        {
          sender: message.sender,
          timestamp: message.timestamp,
          topic: message.topic,
          bodyText: message.content.text || '',
        },
        undefined, // maxHistory (default)
        messageDir,
      );
    } catch (error) {
      // Fallback to single message quoting if historical quoting fails
      logger.warn('Failed to prepare quoted history, falling back to single message', {
        thread: threadPath,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      quotedHistory = formatQuotedReply(
        message.sender,
        message.timestamp,
        message.topic,
        message.content.text || '',
      );
    }
    return quotedHistory
      ? `${replyText}\n\n${quotedHistory}`
      : replyText;
  }

  /** Get current queue statistics. */
  getStats(): {
    activeWorkers: number;
    pendingThreads: number;
    threadQueues: Array<{ thread: string; size: number; processing: boolean }>;
  } {
    return {
      activeWorkers: this.activeWorkers,
      pendingThreads: this.pendingThreads.length,
      threadQueues: Array.from(this.threadQueues.entries()).map(([name, queue]) => ({
        thread: name,
        size: queue.size,
        processing: queue.processing,
      })),
    };
  }
}
