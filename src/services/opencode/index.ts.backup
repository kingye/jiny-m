import { join, basename } from 'node:path';
import { readdir, readFile as fsReadFile, mkdir } from 'node:fs/promises';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type { OpenCodeConfig, ThreadSession, Email, AiGeneratedReply, GeneratedFile } from '../../types';
import { logger } from '../../core/logger';
import { stripReplyPrefix as stripReplyPrefixes } from '../../utils/helpers';
import { stripQuotedHistory, truncateText } from '../../core/email-parser';

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

  private async findFreePort(): Promise<number> {
    const startPort = 5000;

    for (let port = startPort; port < startPort + 100; port++) {
      try {
        const testServer = Bun.serve({
          port,
          fetch: () => new Response('test'),
        });
        testServer.stop();
        return port;
      } catch {
        continue;
      }
    }

    throw new Error('No free ports available');
  }

  async generateReply(email: Email, threadPath: string): Promise<AiGeneratedReply> {
    await this.ensureServerStarted();

    if (!this.client) {
      throw new Error('OpenCode client not initialized');
    }

    const opencodeDir = join(threadPath, '.opencode');
    await mkdir(opencodeDir, { recursive: true });

    const session = await this.getOrCreateSession(threadPath);

    const prompt = await this.buildPrompt(email, threadPath);

    logger.debug('Sending prompt to OpenCode', { sessionId: session.sessionId, threadPath });

    logger.debug('Prompt being sent', {
      promptLength: prompt.length,
      promptPreview: prompt.length > 1000
        ? prompt.substring(0, 500) + ' ... ' + prompt.substring(prompt.length - 500)
        : prompt,
    });

    const modelConfig = this.getModelConfig();
    logger.debug('Using model config', { modelConfig });

    let result = await this.client.session.prompt({
      path: { id: session.sessionId },
      query: { directory: threadPath },
      body: {
        model: modelConfig,
        parts: [{ type: 'text', text: prompt }],
      },
    });

    if (!result.data) {
      throw new Error('Failed to get response from OpenCode');
    }

    logger.debug('Received response', { partsCount: result.data.parts?.length });

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
            model: modelConfig,
            parts: [{ type: 'text', text: prompt }],
          },
        });
      }
    }

    const aiReply = this.extractAiReply(result.data.parts as Array<any>);

    await this.updateSessionState(threadPath, session);

    logger.info('Generated reply', {
      sessionId: session.sessionId,
      textLength: aiReply.text.length,
      attachmentCount: aiReply.attachments.length,
      attachments: aiReply.attachments.map(a => a.filename)
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

  private async buildPrompt(email: Email, threadPath: string): Promise<string> {
    const parts: string[] = [];

    if (this.config.systemPrompt) {
      parts.push(this.config.systemPrompt);
      parts.push('');
    }

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
    parts.push('');
    parts.push(`---`);
    parts.push(`Please write a reply to this email.`);

    let prompt = parts.join('\n');

    if (prompt.length > MAX_TOTAL_PROMPT) {
      logger.warn('Prompt exceeds total limit, truncating', { promptLength: prompt.length, maxLength: MAX_TOTAL_PROMPT });
      prompt = truncateText(prompt, MAX_TOTAL_PROMPT);
    }

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

    return { text, attachments };
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
