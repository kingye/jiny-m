import { join, basename, resolve } from 'node:path';
import { readdir, readFile as fsReadFile, mkdir } from 'node:fs/promises';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type { OpenCodeConfig, ThreadSession, Email, AiGeneratedReply, GeneratedFile } from '../../types';
import { logger } from '../../core/logger';
import { stripReplyPrefix as stripReplyPrefixes } from '../../utils/helpers';
import { stripQuotedHistory, truncateText } from '../../core/email-parser';
import { serializeContext } from '../../mcp/context';

type OpenCodeClient = ReturnType<typeof createOpencodeClient>;

const MAX_FILES_IN_CONTEXT = 10;
const MAX_EMAIL_REPLY_FILES = 2;
const MAX_BODY_IN_PROMPT = 2000;
const MAX_PER_FILE = 400;
const MAX_TOTAL_CONTEXT = 2000;
const MAX_TOTAL_PROMPT = 6000;

export class OpenCodeService {
  private config: OpenCodeConfig;
  private server: { close: () => void } | null = null;
  private client: OpenCodeClient | null = null;
  private port: number | null = null;

  constructor(config: OpenCodeConfig) {
    this.config = config;
  }

  private async ensureServerStarted(): Promise<void> {
    if (this.server && this.client) {
      return;
    }

    const port = await this.findFreePort();

    const result = await createOpencode({
      hostname: this.config.hostname || '127.0.0.1',
      port,
    });

    this.server = result.server;
    this.client = result.client;
    this.port = port;

    logger.info('OpenCode server started', { port });
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
    const toolPath = resolve(__dirname, '../../mcp/reply-tool.ts');

    // Check if config already exists with correct tool path
    try {
      const existing = Bun.file(configPath);
      if (await existing.exists()) {
        const content = await existing.json();
        if (content?.mcp?.['jiny_reply']?.command?.[2] === toolPath &&
            content?.mcp?.['jiny_reply']?.environment?.JINY_ROOT === process.cwd()) {
          return false; // Config already up to date
        }
      }
    } catch {
      // File doesn't exist or is invalid, will be created below
    }

    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      permission: {
        '*': 'allow',
      },
      mcp: {
        'jiny_reply': {
          type: 'local',
          command: ['bun', 'run', toolPath],
          environment: { JINY_ROOT: process.cwd() },
          enabled: true,
          timeout: 60000,
        },
      },
    };

    try {
      await Bun.write(configPath, JSON.stringify(opencodeConfig, null, 2));
      logger.info('OpenCode config written with MCP reply tool', { configPath, toolPath });
      return true; // Freshly written
    } catch (error) {
      logger.warn('Failed to write opencode.json', {
        error: error instanceof Error ? error.message : 'Unknown',
        configPath,
      });
      return false;
    }
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

  async generateReply(email: Email, threadPath: string): Promise<AiGeneratedReply> {
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

    const systemPrompt = this.buildSystemPrompt(threadPath);
    const prompt = await this.buildPrompt(email, threadPath);

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

    const modelConfig = this.getModelConfig();
    logger.debug('Using model config', { modelConfig });

    const PROMPT_TIMEOUT = 120_000; // 2 minutes

    let result = await Promise.race([
      this.client.session.prompt({
        path: { id: session.sessionId },
        query: { directory: threadPath },
        body: {
          system: systemPrompt,
          model: modelConfig,
          parts: [{ type: 'text', text: prompt }],
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('OpenCode prompt timed out after 2 minutes')), PROMPT_TIMEOUT)
      ),
    ]);

    if (!result.data) {
      throw new Error('Failed to get response from OpenCode');
    }

    logger.debug('Received response', { partsCount: result.data.parts?.length });

    // Log raw parts for debugging tool call detection
    if (result.data.parts) {
      for (let i = 0; i < result.data.parts.length; i++) {
        const part = result.data.parts[i] as any;
        logger.debug(`Response part [${i}]`, {
          type: part.type,
          tool: part.tool,
          toolName: part.toolName,
          name: part.name,
          state: part.state,
          hasText: !!part.text,
          textPreview: part.text ? part.text.substring(0, 100) : undefined,
        });
      }
    }

    if (!result.data.parts || result.data.parts.length === 0) {
      const errorInfo = result.data.info?.error;
      if ((errorInfo as any)?.name === 'ContextOverflowError') {
        logger.warn('ContextOverflowError detected, creating new session and retrying...', {
          sessionId: session.sessionId,
          errorMessage: (errorInfo as any)?.data?.message || (errorInfo as any)?.message,
        });

        const sessionId = session.sessionId;
        const newSession = await this.createNewSession(threadPath);

        result = await this.client.session.prompt({
          path: { id: newSession.sessionId },
          query: { directory: threadPath },
          body: {
            system: systemPrompt,
            model: modelConfig,
            parts: [{ type: 'text', text: prompt }],
          },
        });
      }
    }

    if (!result.data) {
      throw new Error('Failed to get response from OpenCode after retry');
    }

    const aiReply = this.extractAiReply(result.data.parts as Array<any>);

    // Check if the reply_email MCP tool was called successfully
    aiReply.replySentByTool = this.checkToolUsed(result.data.parts as Array<any>);

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

          if (!result.data) {
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

  private buildSystemPrompt(threadPath: string): string {
    const parts: string[] = [];

    if (this.config.systemPrompt) {
      parts.push(this.config.systemPrompt);
      parts.push('');
    }

    parts.push(`Your working directory is "${threadPath}". You MUST only read, write, and access files within this directory. Do NOT access files outside this directory.`);
    parts.push('');
    parts.push('## Email Reply Instructions');
    parts.push('When you need to reply to an email, you MUST use the jiny_reply_reply_email tool.');
    parts.push('The email context is provided in a <reply_context> block in the user message. Pass it verbatim as the `context` parameter.');
    parts.push('Pass your reply text as the `message` parameter.');
    parts.push('If you need to attach files from the working directory, pass their filenames in the `attachments` parameter.');
    parts.push('After calling jiny_reply_reply_email successfully, you are DONE. Do NOT call any other tools or perform any further actions. Just provide a brief confirmation message.');

    return parts.join('\n');
  }

  private async buildPrompt(email: Email, threadPath: string): Promise<string> {
    const parts: string[] = [];
    const threadName = basename(threadPath);

    if (this.config.includeThreadHistory !== false) {
      const threadContext = await this.buildThreadContext(threadPath);
      if (threadContext) {
        parts.push('## Conversation history (most recent messages):');
        parts.push(threadContext);
        parts.push('');
      }
    }

    let emailBody = email.body.text || email.body.html || '';
    emailBody = stripQuotedHistory(emailBody);

    if (emailBody.length > MAX_BODY_IN_PROMPT) {
      emailBody = truncateText(emailBody, MAX_BODY_IN_PROMPT);
    }

    const cleanSubject = stripReplyPrefixes(email.subject);

    parts.push('## Incoming Email');
    parts.push(`**From:** ${email.from}`);
    parts.push(`**Subject:** ${cleanSubject}`);
    parts.push(`**Date:** ${email.date.toISOString()}`);
    parts.push('');
    parts.push(`**Body:**`);
    parts.push(emailBody);

    // Truncate the conversation content BEFORE appending reply context
    let conversationPrompt = parts.join('\n');

    const contextBudget = 500;
    const conversationBudget = MAX_TOTAL_PROMPT - contextBudget;

    if (conversationPrompt.length > conversationBudget) {
      logger.warn('Conversation prompt exceeds budget, truncating', {
        promptLength: conversationPrompt.length,
        budget: conversationBudget,
      });
      conversationPrompt = truncateText(conversationPrompt, conversationBudget);
    }

    // Append reply context (AFTER truncation so it is never cut)
    const replyContext = serializeContext(email, threadName);
    const contextBlock = '\n\n<reply_context>' + replyContext + '</reply_context>';

    const prompt = conversationPrompt + contextBlock;

    logger.debug('Prompt composition', {
      conversationLength: conversationPrompt.length,
      contextLength: contextBlock.length,
      totalLength: prompt.length,
    });

    return prompt;
  }

  private async buildThreadContext(threadPath: string): Promise<string> {
    try {
      const stateDir = join(threadPath, '.jiny');
      const entries = await readdir(stateDir, { withFileTypes: true });

      const allFiles = entries
        .filter(dirent => dirent.isFile())
        .filter(dirent => !dirent.name.startsWith('.'))
        .filter(dirent => dirent.name !== '.opencode')
        .filter(dirent => dirent.name.endsWith('.md'))
        .map(dirent => dirent.name)
        .sort()
        .slice(-MAX_FILES_IN_CONTEXT);

      if (allFiles.length === 0) {
        return '';
      }

      const contextParts: string[] = [];

      let totalLength = 0;
      for (const fileName of allFiles) {
        try {
          const content = await fsReadFile(join(stateDir, fileName), 'utf-8');

          let fileContent = content;
          if (fileContent.length > MAX_PER_FILE) {
            fileContent = truncateText(fileContent, MAX_PER_FILE);
          }

          const trimmedContent = trimEmailReplyContent(fileName, fileContent);
          totalLength += trimmedContent.length;

          if (totalLength > MAX_TOTAL_CONTEXT) {
            contextParts.push(trimmedContent);
            break;
          }

          contextParts.push(trimmedContent);
        } catch (error) {
          logger.debug(`Failed to read file: ${fileName}`, {
            error: error instanceof Error ? error.message : 'Unknown',
          });
        }
      }

      return contextParts.join('\n\n');
    } catch (error) {
      logger.debug('Failed to build thread context', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return '';
    }
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
   * Check if the reply_email MCP tool was called and completed successfully.
   * Inspects all parts for tool-related entries referencing reply_email.
   */
  private checkToolUsed(parts: Array<Record<string, any>>): boolean {
    if (!parts || parts.length === 0) return false;

    for (const part of parts) {
      // Check all possible field names that might contain the tool identifier
      const toolId = (
        part.tool || part.toolName || part.name || part.id || ''
      ).toString().toLowerCase();

      const partType = (part.type || '').toString().toLowerCase();
      const partState = (part.state || part.status || '').toString().toLowerCase();

      // Match any part that references reply_email
      if (toolId.includes('reply_email') || (partType === 'tool' && toolId.includes('reply'))) {
        logger.info('reply_email tool part detected', {
          type: partType,
          tool: toolId,
          state: partState,
        });

        // Accept completed/success/done states, or if no state is present
        // (some responses don't include state for successful tool calls)
        if (!partState || partState === 'completed' || partState === 'success' || partState === 'done') {
          logger.info('reply_email MCP tool was used successfully');
          return true;
        }

        // If state indicates failure, log and continue checking other parts
        logger.warn('reply_email tool call detected but state indicates failure', { state: partState });
      }
    }

    return false;
  }

  private getModelConfig(): { providerID: string; modelID: string } | undefined {
    if (!this.config.provider && !this.config.model) {
      return undefined;
    }

    if (this.config.provider && this.config.model) {
      return { providerID: this.config.provider, modelID: this.config.model };
    }

    if (this.config.model) {
      const slashIndex = this.config.model.indexOf('/');
      if (slashIndex > 0 && slashIndex < this.config.model.length - 1) {
        return {
          providerID: this.config.model.substring(0, slashIndex),
          modelID: this.config.model.substring(slashIndex + 1),
        };
      }
      logger.warn('Model specified without provider, using OpenCode default provider');
      return { providerID: '', modelID: this.config.model };
    }

    if (this.config.provider) {
      logger.warn('Provider specified without model, using OpenCode default model');
      return { providerID: this.config.provider, modelID: '' };
    }

    return undefined;
  }
}

function trimEmailReplyContent(fileName: string, content: string): string {
  const lines = content.split('\n');
  let isEmailBody = false;
  const replyLines: string[] = [];

  for (const line of lines) {
    if (typeof line !== 'string') continue;

    if (isEmailBody) {
      if (line.startsWith('================================================================================')) {
        break;
      }
      replyLines.push(line);
    } else if (line.includes('__ ')) {
      continue;
    } else if (line.startsWith('## ') && line.match(/## .+ \(\d{1,2}:\d{2} [AP]M\)/)) {
      isEmailBody = true;
      continue;
    }
  }

  return replyLines.join('\n').trim();
}
