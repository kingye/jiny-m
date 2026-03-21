import { join, basename, resolve, dirname } from 'node:path';
import { readFile as fsReadFile, mkdir, unlink, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type { OpenCodeConfig, ThreadSession, AiGeneratedReply, GeneratedFile, InboundMessage } from '../../types';
import { logger } from '../../core/logger';
import { PromptBuilder } from './prompt-builder';
import { readModelOverride } from '../../core/command-handler/handlers/ModelCommandHandler';

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

export class OpenCodeService {
  private config: OpenCodeConfig;
  private promptBuilder: PromptBuilder;
  private server: { close: () => void } | null = null;
  private client: OpenCodeClient | null = null;
  private port: number | null = null;

  constructor(config: OpenCodeConfig) {
    this.config = config;
    this.promptBuilder = new PromptBuilder(config);
  }

  private async ensureServerStarted(): Promise<void> {
    // If we already have a server and client, verify the server is still alive
    if (this.server && this.client) {
      const alive = await this.isServerAlive();
      if (alive) {
        return;
      }
      // Server died — clean up stale references and restart
      logger.warn('OpenCode server is no longer responsive, restarting...', { port: this.port });
      try { this.server.close(); } catch { /* already dead */ }
      this.server = null;
      this.client = null;
      this.port = null;
    }

    const port = await this.findFreePort();

    const result = await createOpencode({
      hostname: this.config.hostname || '127.0.0.1',
      port,
      timeout: 15_000, // 15 seconds — opencode CLI can be slow to start
    });

    this.server = result.server;
    this.client = result.client;
    this.port = port;

    logger.info('OpenCode server started', { port });
  }

  /**
   * Quick health check — try a lightweight API call to see if the server is alive.
   */
  private async isServerAlive(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const result = await Promise.race([
        this.client.session.list(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Health check timed out')), 3000)
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure .opencode directory and opencode.json exist in the thread directory.
   * opencode.json configures the MCP reply_email tool so OpenCode discovers it
   * as a project-level MCP server when session.prompt() uses this directory.
   * Only writes the file if it doesn't already exist or has stale config.
   */
  private async ensureThreadOpencodeSetup(threadPath: string): Promise<boolean> {
    const opencodeDir = join(threadPath, '.opencode');
    await mkdir(opencodeDir, { recursive: true });

    const configPath = join(threadPath, 'opencode.json');
    const { toolCommand } = this.getReplyToolCommand();

    // Build expected model strings in "provider/model" format for opencode.json
    // Model override from /model command takes priority over config
    const modelOverride = await readModelOverride(threadPath);
    const expectedModel = modelOverride || this.getModelString();
    const expectedSmallModel = modelOverride ? undefined : this.getSmallModelString();

    // Check if config already exists and is up to date
    try {
      const existing = Bun.file(configPath);
      if (await existing.exists()) {
        const content = await existing.json();
        const existingCommand = JSON.stringify(content?.mcp?.['jiny_reply']?.command);
        const expectedCommand = JSON.stringify(toolCommand);
        if (existingCommand === expectedCommand &&
            content?.mcp?.['jiny_reply']?.environment?.JINY_ROOT === process.cwd() &&
            content?.tools?.question === false &&
            (content?.model ?? undefined) === expectedModel &&
            (content?.small_model ?? undefined) === expectedSmallModel) {
          return false; // Config already up to date
        }
      }
    } catch {
      // File doesn't exist or is invalid, will be created below
    }

    const opencodeConfig: Record<string, any> = {
      $schema: 'https://opencode.ai/config.json',
    };

    // Only write model fields if configured
    if (expectedModel) {
      opencodeConfig.model = expectedModel;
    }
    if (expectedSmallModel) {
      opencodeConfig.small_model = expectedSmallModel;
    }

    opencodeConfig.permission = { '*': 'allow' };
    // Disable interactive tools — jiny-M runs headless (no terminal)
    opencodeConfig.tools = {
      question: false,
    };
    opencodeConfig.mcp = {
      'jiny_reply': {
        type: 'local',
        command: toolCommand,
        environment: { JINY_ROOT: process.cwd() },
        enabled: true,
        timeout: 60000,
      },
    };

    try {
      await Bun.write(configPath, JSON.stringify(opencodeConfig, null, 2));
      logger.info('OpenCode config written', {
        configPath,
        toolCommand,
        model: expectedModel || '(default)',
        smallModel: expectedSmallModel || '(default)',
      });
      return true; // Freshly written
    } catch (error) {
      logger.warn('Failed to write opencode.json', {
        error: error instanceof Error ? error.message : 'Unknown',
        configPath,
      });
      return false;
    }
  }

  /**
   * Get the model string for opencode.json ("provider/model" format).
   * Returns undefined if no model is configured (OpenCode uses its global default).
   */
  private getModelString(): string | undefined {
    return this.config.model || undefined;
  }

  /**
   * Build the small model string for opencode.json.
   * Accepts "provider/model" format directly.
   */
  private getSmallModelString(): string | undefined {
    return this.config.smallModel || undefined;
  }

  private async findFreePort(): Promise<number> {
    // Use IANA dynamic/ephemeral port range (49152-65535) to avoid conflicts with:
    // - macOS AirPlay (5000-5001)
    // - OpenCode TUI (4096+)
    // - Common dev servers (3000, 8000, 8080, etc.)
    const startPort = 49152;
    const endPort = startPort + 100;

    logger.debug('Searching for free port', { range: `${startPort}-${endPort - 1}` });

    for (let port = startPort; port < endPort; port++) {
      // First check if something is already listening on this port
      const inUse = await this.isPortInUse(port);
      if (inUse) {
        logger.debug('Port in use (active listener detected), skipping', { port });
        continue;
      }

      try {
        const testServer = Bun.serve({
          port,
          fetch: () => new Response('test'),
        });
        testServer.stop();
        logger.info('Found free port', { port });
        return port;
      } catch {
        logger.debug('Port bind failed, skipping', { port });
        continue;
      }
    }

    logger.error('No free ports available', { range: `${startPort}-${endPort - 1}` });
    throw new Error(`No free ports available in range ${startPort}-${endPort - 1}`);
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const { createConnection } = require('node:net');
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve(true); // Connection succeeded = port is in use
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false); // Connection failed = port is free
      });
      socket.setTimeout(200, () => {
        socket.destroy();
        resolve(false); // Timeout = port is free
      });
    });
  }

  async generateReply(message: InboundMessage, threadPath: string, messageDir?: string): Promise<AiGeneratedReply> {
    await this.ensureServerStarted();

    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }

    // Ensure .opencode directory and opencode.json config exist in thread directory.
    // opencode.json configures the MCP reply tool so OpenCode discovers it as a project-level tool.
    // Returns true if a new config was written (meaning existing sessions won't have the tool).
    const configFreshlyWritten = await this.ensureThreadOpencodeSetup(threadPath);

    // If the MCP config was just written, any existing session was created without
    // the tool. Force a new session so it picks up the MCP config.
    let session: ThreadSession;
    if (configFreshlyWritten) {
      logger.info('MCP config freshly written, creating new session to pick up tool', { threadPath });
      session = await this.createNewSession(threadPath);
    } else {
      session = await this.getOrCreateSession(threadPath);
    }

    const systemPrompt = await this.promptBuilder.buildSystemPrompt(threadPath);
    const prompt = await this.promptBuilder.buildPrompt(message, threadPath, messageDir);

    logger.debug('Sending prompt to OpenCode', { sessionId: session.sessionId, threadPath });

    logger.debug('System prompt', {
      systemLength: systemPrompt.length,
      systemPreview: systemPrompt.substring(0, 300),
    });

    logger.debug('User prompt being sent', {
      promptLength: prompt.length,
      promptPreview: prompt.length > 1000
        ? prompt.substring(0, 500) + ' ... ' + prompt.substring(prompt.length - 500)
        : prompt,
    });

    // Model config is in per-thread opencode.json (not passed per-prompt).
    // Use SSE streaming (promptAsync + event subscription) for progress visibility
    // and activity-based timeout. Falls back to blocking prompt() if SSE fails.
    // Clean up any stale signal file from a previous run before starting.
    await this.cleanupStaleSignalFile(threadPath);
    const { parts: resultParts, replySentByTool } = await this.promptWithProgress(
      session,
      threadPath,
      systemPrompt,
      prompt,
    );

    const aiReply = this.extractAiReply(resultParts as Array<any>);
    aiReply.replySentByTool = replySentByTool || this.checkToolUsed(resultParts as Array<any>);

    // Last-resort fallback: check signal file (SSE may have missed tool call events)
    if (!aiReply.replySentByTool) {
      aiReply.replySentByTool = await this.checkSignalFile(threadPath);
    }

    // Verify: if SSE says reply was sent but signal file is missing, the tool
    // was never actually invoked (stale session replaying cached results).
    // Delete the session and retry with a fresh one.
    if (aiReply.replySentByTool) {
      const signalConfirmed = await this.checkSignalFile(threadPath);
      if (!signalConfirmed) {
        logger.error('Reply tool reported success via SSE but signal file not found — stale session detected', {
          sessionId: session.sessionId,
          thread: basename(threadPath),
        });
        // Delete session to force a fresh one on retry
        await this.deleteSession(threadPath);
        // Retry once with a new session
        logger.info('Retrying with new session...', { thread: basename(threadPath) });
        const newSession = await this.getOrCreateSession(threadPath);
        await this.cleanupStaleSignalFile(threadPath);
        const retryResult = await this.promptWithProgress(newSession, threadPath, systemPrompt, prompt);
        const retryReply = this.extractAiReply(retryResult.parts as Array<any>);
        retryReply.replySentByTool = retryResult.replySentByTool || this.checkToolUsed(retryResult.parts as Array<any>);
        if (!retryReply.replySentByTool) {
          retryReply.replySentByTool = await this.checkSignalFile(threadPath);
        }
        await this.updateSessionState(threadPath, newSession);
        logger.info('Generated reply (retry)', {
          sessionId: newSession.sessionId,
          textLength: retryReply.text.length,
          attachmentCount: retryReply.attachments.length,
          attachments: retryReply.attachments.map(a => a.filename),
          replySentByTool: retryReply.replySentByTool,
        });
        return retryReply;
      }
    }

    await this.updateSessionState(threadPath, session);

    logger.info('Generated reply', {
      sessionId: session.sessionId,
      textLength: aiReply.text.length,
      attachmentCount: aiReply.attachments.length,
      attachments: aiReply.attachments.map(a => a.filename),
      replySentByTool: aiReply.replySentByTool,
    });

    return aiReply;
  }

  async close(): Promise<void> {
    if (this.server) {
      this.server.close();
      logger.info('OpenCode server closed', { port: this.port });
      this.server = null;
      this.client = null;
      this.port = null;
    }
  }

  private async createNewSession(threadPath: string): Promise<ThreadSession> {
    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }

    const threadName = basename(threadPath);
    const sessionResult = await this.client.session.create({
      body: { title: threadName },
      query: { directory: threadPath },
    });

    if (!sessionResult.data) {
      throw new Error('Failed to create session');
    }

    const newSession: ThreadSession = {
      sessionId: sessionResult.data.id,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      emailCount: 0,
    };

    const stateDir = join(threadPath, '.jiny');
    const sessionFile = join(stateDir, 'session.json');
    await Bun.write(sessionFile, JSON.stringify(newSession, null, 2));

    logger.info('Created new session (replacing old one)', { sessionId: newSession.sessionId, thread: threadName, directory: threadPath });

    return newSession;
  }

  /**
   * Delete session file to force a fresh session on next use.
   * Used when a stale session is detected (SSE reports tool success but tool was never invoked).
   */
  private async deleteSession(threadPath: string): Promise<void> {
    const sessionFile = join(threadPath, '.jiny', 'session.json');
    try {
      await unlink(sessionFile);
      logger.info('Deleted stale session file', { sessionFile, thread: basename(threadPath) });
    } catch {
      // File may not exist — that's fine
    }
  }

  private async getOrCreateSession(threadPath: string): Promise<ThreadSession> {
    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }

    const stateDir = join(threadPath, '.jiny');
    const sessionFile = join(stateDir, 'session.json');

    try {
      const file = Bun.file(sessionFile);
      if (await file.exists()) {
        const session: ThreadSession = await file.json();
        
        try {
          const result = await this.client.session.get({
            path: { id: session.sessionId }
          });

    if (!result || !result.data) {
            logger.warn('Session no longer exists, creating new one', { sessionId: session.sessionId });
            return this.createNewSession(threadPath);
          }

          logger.debug('Reusing existing session', { sessionId: session.sessionId });

          return session;
        } catch (error) {
          if ((error as any)?.code === 'NOT_FOUND') {
            logger.warn('Session NOT_FOUND, creating new one', { sessionId: session.sessionId });
            return this.createNewSession(threadPath);
          }
          throw error;
        }
      } else {
        logger.info('No existing session found, creating new one', { threadPath });
        return this.createNewSession(threadPath);
      }
    } catch (error) {
      logger.info('No previous session found, creating fresh instance');
      return this.createNewSession(threadPath);
    }
  }

  private async updateSessionState(threadPath: string, session: ThreadSession): Promise<void> {
    session.lastUsedAt = new Date().toISOString();

    const stateDir = join(threadPath, '.jiny');
    const sessionFile = join(stateDir, 'session.json');
    await Bun.write(sessionFile, JSON.stringify(session, null, 2));
  }

  private extractAiReply(parts: Array<{ type: string; text?: string; filename?: string; url?: string; mime?: string }>): AiGeneratedReply {
    const textParts = parts.filter(p => p.type === 'text' && p.text);
    const text = textParts.map(p => p.text || '').join('');

    const fileParts = parts.filter(p => p.type === 'file' && p.filename);
    const attachments: GeneratedFile[] = fileParts.map(p => ({
      filename: p.filename!,
      url: p.url!,
      mime: p.mime!,
    }));

    logger.debug('Extracted AI reply', {
      textLength: text.length,
      attachmentCount: attachments.length,
      attachments: attachments.map(a => ({ filename: a.filename, mime: a.mime }))
    });

    return { text, attachments, replySentByTool: false };
  }

  /**
   * Send a prompt using promptAsync() + SSE event streaming.
   * Provides activity-based timeout (no fixed deadline — only times out if AI goes silent)
   * and throttled progress logging.
   *
   * Falls back to blocking prompt() if SSE subscription fails.
   */
  private async promptWithProgress(
    session: ThreadSession,
    threadPath: string,
    systemPrompt: string,
    prompt: string,
  ): Promise<{ parts: Array<any>; replySentByTool: boolean }> {
    if (!this.client) throw new Error('OpenCode client not initialized');

    const ACTIVITY_TIMEOUT = 120_000;  // 2 minutes of silence → timeout
    const TOOL_ACTIVITY_TIMEOUT = 300_000; // 5 minutes when a tool is actively running
    const PROGRESS_LOG_INTERVAL = 10_000; // Log progress every 10 seconds
    const sessionId = session.sessionId;

    // Try SSE streaming approach first — scope to thread directory so we receive
    // events for sessions in this project context (per OpenCode server docs).
    let sseStream: AsyncGenerator<any> | null = null;
    try {
      const subscription = await this.client.event.subscribe({
        query: { directory: threadPath },
      });
      sseStream = subscription.stream;
    } catch (error) {
      logger.warn('SSE subscription failed, falling back to blocking prompt()', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return this.promptBlocking(session, threadPath, systemPrompt, prompt);
    }

    // Fire the prompt asynchronously (returns immediately with HTTP 204)
    try {
      await this.client.session.promptAsync({
        path: { id: sessionId },
        query: { directory: threadPath },
        body: {
          system: systemPrompt,
          parts: [{ type: 'text', text: prompt }],
        },
      });
    } catch (error) {
      logger.error('promptAsync failed', { error: error instanceof Error ? error.message : 'Unknown' });
      throw error;
    }

    logger.info('Prompt sent (async), waiting for events...', { sessionId });

    // State for the event loop
    const accumulatedParts: Array<any> = [];
    const toolLoggedStatus = new Map<string, string>(); // partId → last logged status (dedup tool logs)
    let replySentByTool = false;
    let lastActivityTime = Date.now();
    let lastProgressLog = Date.now();
    let lastPartType = ''; // Track what the AI is doing (e.g. "reasoning", "text", "tool")
    let lastToolName = '';
    let lastSessionStatus = '';
    let currentModel = ''; // Model used in the current message (from message.updated)
    let stepCount = 0;
    let rawEventCount = 0;
    let done = false;
    let sessionError: any = null;
    const startTime = Date.now();

    // Activity timeout checker — runs in the background
    const activityCheckInterval = setInterval(() => {
      const silenceMs = Date.now() - lastActivityTime;
      const elapsedMs = Date.now() - startTime;

      // Throttled progress logging
      if (Date.now() - lastProgressLog >= PROGRESS_LOG_INTERVAL) {
        lastProgressLog = Date.now();
        const activity = lastToolName
          ? `tool: ${lastToolName}`
          : lastPartType || 'waiting';
        logger.info('AI processing...', {
          elapsed: `${Math.round(elapsedMs / 1000)}s`,
          parts: accumulatedParts.length,
          activity,
          silence: `${Math.round(silenceMs / 1000)}s`,
        });
      }

      // Use a longer timeout when a tool is actively running — OpenCode doesn't emit
      // SSE events during tool execution, so long-running tools (write, bash) cause
      // silence that doesn't indicate a real hang.
      const activeTimeout = lastToolName ? TOOL_ACTIVITY_TIMEOUT : ACTIVITY_TIMEOUT;
      if (silenceMs > activeTimeout) {
        logger.warn(`Activity timeout: no events for ${Math.round(activeTimeout / 1000)}s`, {
          elapsed: `${Math.round(elapsedMs / 1000)}s`,
          parts: accumulatedParts.length,
          lastTool: lastToolName || 'none',
        });
        done = true;
        sessionError = new Error(`No activity from OpenCode for ${Math.round(activeTimeout / 1000)} seconds`);
        // Force-close the SSE stream so the for-await loop unblocks immediately
        if (sseStream) {
          try { sseStream.return(undefined); } catch { /* ignore */ }
        }
      }
    }, 5000);

    try {
      for await (const event of sseStream) {
        if (done) break;

        const eventType = (event as any)?.type;
        const properties = (event as any)?.properties;
        if (!eventType || !properties) continue;

        // Diagnostic: log first few raw events to confirm SSE stream is delivering
        rawEventCount++;
        if (rawEventCount <= 5) {
          const sid = properties.sessionID || properties.part?.sessionID;
          logger.debug('SSE raw event', {
            type: eventType,
            sessionID: sid || 'none',
            eventCount: rawEventCount,
          });
        }

        // Handle stream-level events (not session-scoped)
        if (eventType === 'server.connected') {
          logger.debug('SSE stream connected to OpenCode server');
          continue;
        }

        // Capture model info from message.updated events
        // (AssistantMessage has modelID/providerID but sessionID is nested in info)
        if (eventType === 'message.updated') {
          const info = properties.info;
          if (info?.sessionID === sessionId && info?.role === 'assistant') {
            const model = info.providerID && info.modelID
              ? `${info.providerID}/${info.modelID}`
              : info.modelID || '';
            if (model && model !== currentModel) {
              currentModel = model;
            }
            lastActivityTime = Date.now();
          }
          continue;
        }

        // Filter events: only process events that positively match our session.
        // Events without a sessionID (global events like file.watcher.updated)
        // must be skipped — otherwise they reset the activity timer without contributing parts.
        const eventSessionId = properties.sessionID || properties.part?.sessionID;
        if (!eventSessionId || eventSessionId !== sessionId) continue;

        // Update activity timer — only reached for events from OUR session
        lastActivityTime = Date.now();

        switch (eventType) {
          case 'message.part.updated': {
            const part = properties.part;
            if (!part) break;

            // Track what the AI is doing for progress logging
            lastPartType = part.type || '';

            // Log model on each new step
            if (part.type === 'step-start') {
              stepCount++;
              logger.info('AI step started', {
                step: stepCount,
                model: currentModel || '(unknown)',
              });
            }

            // Accumulate parts (deduplicate by ID — parts may be updated multiple times)
            const existingIdx = accumulatedParts.findIndex((p: any) => p.id === part.id);
            if (existingIdx >= 0) {
              accumulatedParts[existingIdx] = part;
            } else {
              accumulatedParts.push(part);
            }

            // Log tool calls — only on new tool call or status change (dedup repeated updates)
            if (part.type === 'tool' && part.tool) {
              lastToolName = part.tool;
              const toolStatus = part.state?.status || 'unknown';
              const prevStatus = toolLoggedStatus.get(part.id);
              const isReplyTool = part.tool.includes('reply_email') || part.tool.includes('reply_message');

              if (prevStatus !== toolStatus) {
                toolLoggedStatus.set(part.id, toolStatus);
                logger.info('AI calling tool', { tool: part.tool, status: toolStatus });

                // Log tool details on first meaningful status (not on completed/error — already seen)
                if ((toolStatus === 'pending' || toolStatus === 'running') && part.state?.input) {
                  const details = this.summarizeToolInput(part.tool, part.state.input as Record<string, unknown>);
                  if (details) {
                    logger.info('Tool details', details);
                  }
                }

                // Log reply tool input at 'running' status (input is empty at 'pending')
                if (isReplyTool && toolStatus === 'running' && part.state?.input) {
                  const input = part.state.input;
                  const contextVal = input.context;
                  logger.info('Reply tool input from AI', {
                    messageLength: typeof input.message === 'string' ? input.message.length : 0,
                    messagePreview: typeof input.message === 'string' ? input.message.substring(0, 100) : '(empty)',
                    contextType: typeof contextVal,
                    contextLength: typeof contextVal === 'string' ? contextVal.length : 0,
                    attachments: input.attachments || [],
                  });
                }
              }

              // Detect reply tool usage in real-time (reply_email or reply_message)
              if (isReplyTool) {
                if (toolStatus === 'completed') {
                  // Check output for error indicators — OpenCode reports "completed"
                  // even when the MCP tool returns isError: true
                  const output = (part.state?.output || '').toString();
                  logger.info('Reply tool output', { output: output.substring(0, 300) });
                  const isErrorOutput = output.toLowerCase().startsWith('error') ||
                    output.toLowerCase().startsWith('mcp error');
                  if (isErrorOutput) {
                    logger.error('Reply tool completed with error output', {
                      tool: part.tool,
                      output: output.substring(0, 300),
                    });
                  } else {
                    replySentByTool = true;
                    logger.info('Reply MCP tool completed successfully (detected via SSE)', {
                      tool: part.tool,
                    });
                  }
                } else if (toolStatus === 'error') {
                  logger.error('Reply tool call failed', {
                    tool: part.tool,
                    error: part.state?.error,
                  });
                }
              }
            } else {
              // Clear tool name when AI moves on to non-tool parts
              lastToolName = '';
            }

            // Log step completion with cost/token info
            if (part.type === 'step-finish') {
              logger.debug('AI step finished', {
                step: stepCount,
                model: currentModel || '(unknown)',
                reason: part.reason,
                cost: part.cost,
                tokens: part.tokens,
              });
            }

            // Log text deltas at debug level (too noisy for info)
            if (properties.delta && part.type === 'text') {
              logger.debug('AI text delta', {
                length: properties.delta.length,
                preview: properties.delta.substring(0, 80),
              });
            }
            break;
          }

          case 'session.status': {
            const status = properties.status;
            const statusType = status?.type || 'unknown';
            if (statusType !== lastSessionStatus) {
              lastSessionStatus = statusType;
              if (statusType === 'busy') {
                logger.debug('Session busy');
              } else if (statusType === 'retry') {
                logger.warn('Session retrying', {
                  attempt: status.attempt,
                  message: status.message,
                });
              }
            }
            break;
          }

          case 'session.idle': {
            const elapsedMs = Date.now() - startTime;
            logger.info('AI session idle (prompt complete)', {
              elapsed: `${Math.round(elapsedMs / 1000)}s`,
              parts: accumulatedParts.length,
            });
            done = true;
            break;
          }

          case 'session.error': {
            const error = properties.error;
            logger.error('Session error received via SSE', {
              errorName: error?.name,
              errorMessage: error?.data?.message || error?.message,
            });

            // Handle ContextOverflowError: create new session and retry
            if (error?.name === 'ContextOverflowError') {
              logger.warn('ContextOverflowError via SSE, will retry with new session');
              sessionError = { name: 'ContextOverflowError', data: error.data };
            } else {
              sessionError = error;
            }
            done = true;
            break;
          }

          default:
            // Ignore other event types (file.edited, vcs.branch.updated, etc.)
            break;
        }

        if (done) break;
      }
    } catch (error) {
      // SSE stream error (disconnection, etc.)
      logger.warn('SSE stream error', { error: error instanceof Error ? error.message : 'Unknown' });
      // If we already have accumulated parts, use them
      if (accumulatedParts.length === 0) {
        // No data at all — check signal file as last resort
        const sentByTool = await this.checkSignalFile(threadPath);
        if (sentByTool) {
          return { parts: [], replySentByTool: true };
        }
        throw error;
      }
    } finally {
      clearInterval(activityCheckInterval);
    }

    // Handle ContextOverflowError: create new session and retry with blocking prompt
    if (sessionError?.name === 'ContextOverflowError') {
      logger.warn('Retrying with new session after ContextOverflowError');
      const newSession = await this.createNewSession(threadPath);
      return this.promptBlocking(newSession, threadPath, systemPrompt, prompt);
    }

    // Handle activity timeout
    if (sessionError && !replySentByTool) {
      // Check signal file before throwing — the tool may have sent the reply
      const sentByTool = await this.checkSignalFile(threadPath);
      if (sentByTool) {
        return { parts: accumulatedParts, replySentByTool: true };
      }
      throw sessionError;
    }

    logger.debug('Accumulated parts from SSE', {
      count: accumulatedParts.length,
      types: accumulatedParts.map((p: any) => p.type),
    });

    return { parts: accumulatedParts, replySentByTool };
  }

  /**
   * Blocking prompt fallback — used when SSE subscription fails or for ContextOverflow retry.
   */
  private async promptBlocking(
    session: ThreadSession,
    threadPath: string,
    systemPrompt: string,
    prompt: string,
  ): Promise<{ parts: Array<any>; replySentByTool: boolean }> {
    if (!this.client) throw new Error('OpenCode client not initialized');

    const PROMPT_TIMEOUT = 300_000; // 5 minutes

    let result;
    try {
      result = await Promise.race([
        this.client.session.prompt({
          path: { id: session.sessionId },
          query: { directory: threadPath },
          body: {
            system: systemPrompt,
            parts: [{ type: 'text', text: prompt }],
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('OpenCode prompt timed out (blocking fallback)')), PROMPT_TIMEOUT)
        ),
      ]);
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.includes('timed out');
      if (isTimeout) {
        const sentByTool = await this.checkSignalFile(threadPath);
        if (sentByTool) {
          return { parts: [], replySentByTool: true };
        }
      }
      throw error;
    }

    if (!result || !result.data) {
      throw new Error('Failed to get response from OpenCode (blocking fallback)');
    }

    const parts = (result.data.parts || []) as Array<any>;
    const replySentByTool = this.checkToolUsed(parts);
    return { parts, replySentByTool };
  }

  /**
   * Check if the reply_email MCP tool was called and completed successfully.
   * Inspects all parts for tool-related entries referencing reply_email.
   *
   * OpenCode SDK ToolPart has: { type: "tool", tool: string, state: { status: "completed"|"running"|... } }
   * The `state` field is a nested object with a `status` string, not a flat string.
   */
  private checkToolUsed(parts: Array<Record<string, any>>): boolean {
    if (!parts || parts.length === 0) return false;

    for (const part of parts) {
      const partType = (part.type || '').toString().toLowerCase();

      // The tool identifier lives in part.tool (SDK ToolPart) or fallback fields
      const toolId = (
        part.tool || part.toolName || part.name || ''
      ).toString().toLowerCase();

      // State can be a nested object { status: "completed" } (SDK ToolPart)
      // or a flat string (other formats). Handle both.
      let partStatus = '';
      if (part.state && typeof part.state === 'object' && part.state.status) {
        partStatus = String(part.state.status).toLowerCase();
      } else if (typeof part.state === 'string') {
        partStatus = part.state.toLowerCase();
      } else if (typeof part.status === 'string') {
        partStatus = part.status.toLowerCase();
      }

      // Match any part that references the reply tool (reply_email or reply_message)
      if (toolId.includes('reply_email') || toolId.includes('reply_message') || (partType === 'tool' && toolId.includes('reply'))) {
        logger.info('Reply tool part detected', {
          type: partType,
          tool: toolId,
          status: partStatus,
          stateType: typeof part.state,
        });

        // "completed" status means the tool call finished, but NOT necessarily that it succeeded.
        // OpenCode reports "completed" even when the MCP tool returns isError: true.
        // Check the output field for error indicators.
        if (partStatus === 'completed' || partStatus === 'success' || partStatus === 'done') {
          const output = (part.state?.output || '').toString();
          const isErrorOutput = output.toLowerCase().startsWith('error') ||
            output.toLowerCase().startsWith('mcp error');
          if (isErrorOutput) {
            logger.error('Reply tool completed with error output (post-hoc)', {
              tool: toolId,
              output: output.substring(0, 300),
            });
            continue; // Don't count this as a successful send
          }
          logger.info('Reply MCP tool was used successfully');
          return true;
        }

        // Accept if no state is present (some responses don't include state)
        if (!partStatus) {
          logger.info('Reply MCP tool detected (no state), assuming success');
          return true;
        }

        // If state indicates failure, log and continue checking other parts
        logger.warn('reply_email tool call detected but state indicates failure', { status: partStatus });
      }
    }

    return false;
  }

  /**
   * Clean up any stale signal file from a previous run.
   * Must be called before starting a new prompt to avoid detecting leftover files.
   */
  private async cleanupStaleSignalFile(threadPath: string): Promise<void> {
    const signalFile = join(threadPath, '.jiny', 'reply-sent.flag');
    try {
      await access(signalFile);
      await unlink(signalFile);
      logger.info('Cleaned up stale signal file from previous run', { signalFile });
    } catch {
      // No stale file — expected case
    }
  }

  /**
   * Check if the MCP reply tool left a signal file indicating it sent the reply.
   * This is a reliable fallback when tool parts are not included in the prompt response.
   * The signal file is cleaned up after detection.
   */
  private async checkSignalFile(threadPath: string): Promise<boolean> {
    const signalFile = join(threadPath, '.jiny', 'reply-sent.flag');
    try {
      await access(signalFile);
      const content = await fsReadFile(signalFile, 'utf-8');
      logger.info('Signal file detected: MCP reply tool sent the email', {
        signalFile,
        content: content.substring(0, 200),
      });

      // Clean up signal file
      try {
        await unlink(signalFile);
        logger.debug('Signal file cleaned up', { signalFile });
      } catch {
        // Non-fatal
      }

      return true;
    } catch {
      // No signal file — tool didn't send (or file was already cleaned up)
      return false;
    }
  }

  /**
   * Determine the command to spawn the MCP reply tool.
   *
   * In compiled mode: looks for jiny-m-reply-tool binary next to the main binary
   * (or in the same directory as the compiled executable).
   * In development mode: uses `bun run src/mcp/reply-tool.ts`.
   */
  private getReplyToolCommand(): { toolCommand: string[] } {
    // Check if we're running as a compiled binary
    // Bun sets process.argv[0] to the binary path when compiled
    const mainBinary = process.argv[0];
    if (mainBinary) {
      const binDir = dirname(mainBinary);
      const replyToolBinary = join(binDir, 'jiny-m-reply-tool');
      if (existsSync(replyToolBinary)) {
        logger.debug('Reply tool: using compiled binary', { path: replyToolBinary });
        return { toolCommand: [replyToolBinary] };
      }
    }

    // Also check common installed locations (for container/system installs)
    const commonPaths = ['/usr/local/bin/jiny-m-reply-tool', '/usr/bin/jiny-m-reply-tool'];
    for (const p of commonPaths) {
      if (existsSync(p)) {
        logger.debug('Reply tool: found at common path', { path: p });
        return { toolCommand: [p] };
      }
    }

    // Development mode: use bun run with the .ts source
    const toolPath = resolve(__dirname, '../../mcp/reply-tool.ts');
    logger.debug('Reply tool: using development mode', { path: toolPath });
    return { toolCommand: ['bun', 'run', toolPath] };
  }

  /**
   * Extract a concise summary from tool input for logging.
   * Returns null for tools that already have their own detailed logging (reply_email).
   */
  private summarizeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> | null {
    // Skip reply_email — already has its own detailed DEBUG logging
    if (toolName.includes('reply_email') || toolName.includes('reply_message')) {
      return null;
    }

    const str = (val: unknown, maxLen = 200): string => {
      if (typeof val === 'string') return val.length > maxLen ? val.substring(0, maxLen) + '...' : val;
      if (val === undefined || val === null) return '';
      return String(val);
    };

    if (toolName === 'bash' || toolName.endsWith('_bash')) {
      return {
        command: str(input.command),
        ...(input.workdir ? { workdir: str(input.workdir) } : {}),
      };
    }

    if (toolName === 'read' || toolName.endsWith('_read')) {
      return { path: str(input.filePath || input.path) };
    }

    if (toolName === 'write' || toolName.endsWith('_write')) {
      return { path: str(input.filePath || input.path) };
    }

    if (toolName === 'edit' || toolName.endsWith('_edit')) {
      return { path: str(input.filePath || input.path) };
    }

    if (toolName === 'glob' || toolName.endsWith('_glob')) {
      return {
        pattern: str(input.pattern),
        ...(input.path ? { path: str(input.path) } : {}),
      };
    }

    if (toolName === 'grep' || toolName.endsWith('_grep')) {
      return {
        pattern: str(input.pattern),
        ...(input.include ? { include: str(input.include) } : {}),
        ...(input.path ? { path: str(input.path) } : {}),
      };
    }

    if (toolName === 'task' || toolName.endsWith('_task')) {
      return {
        description: str(input.description),
        ...(input.subagent_type ? { type: str(input.subagent_type) } : {}),
      };
    }

    if (toolName === 'webfetch' || toolName.endsWith('_webfetch')) {
      return { url: str(input.url) };
    }

    if (toolName === 'skill' || toolName.endsWith('_skill')) {
      return { name: str(input.name) };
    }

    if (toolName === 'todowrite' || toolName.endsWith('_todowrite')) {
      const todos = input.todos;
      if (Array.isArray(todos)) {
        const summary = todos.map((t: any) => `[${t.status}] ${str(t.content, 80)}`);
        return { tasks: summary };
      }
      return { inputKeys: Object.keys(input) };
    }

    // Fallback: show input keys for unknown tools
    const keys = Object.keys(input);
    if (keys.length > 0) {
      return { inputKeys: keys };
    }

    return null;
  }

}
