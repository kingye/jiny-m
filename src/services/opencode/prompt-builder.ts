/**
 * Channel-agnostic prompt builder for the OpenCode worker.
 *
 * Builds system prompts and user prompts from InboundMessage (not Email).
 * Extracted from OpenCodeService to separate prompt construction concerns
 * from server/session/SSE management.
 */

import { join, basename } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import type { InboundMessage } from '../../channels/types';
import type { OpenCodeConfig } from '../../types';
import { logger } from '../../core/logger';
import { stripQuotedHistory, truncateText } from '../../core/email-parser';
import { serializeContext } from '../../mcp/context';

const MAX_FILES_IN_CONTEXT = 10;
const MAX_BODY_IN_PROMPT = 2000;
const MAX_PER_FILE = 400;
const MAX_TOTAL_CONTEXT = 2000;
const MAX_TOTAL_PROMPT = 6000;

export class PromptBuilder {
  private config: OpenCodeConfig;

  constructor(config: OpenCodeConfig) {
    this.config = config;
  }

  /**
   * Build the system prompt (instructions for the AI).
   * Channel-agnostic — references reply_message tool, not reply_email.
   * If a system.md file exists in the thread directory, its content is appended.
   */
  async buildSystemPrompt(threadPath: string): Promise<string> {
    const parts: string[] = [];

    if (this.config.systemPrompt) {
      parts.push(this.config.systemPrompt);
      parts.push('');
    }

    parts.push(`Your working directory is "${threadPath}". You MUST only read, write, and access files within this directory. Do NOT access files outside this directory.`);
    parts.push('');
    parts.push('## Reply Instructions');
    parts.push('When replying to a message, use the jiny_reply_reply_message tool:');
    parts.push('- `context`: Pass the opaque token from the <reply_context> block exactly as-is (do not decode or modify it)');
    parts.push('- `message`: Your reply text');
    parts.push('- `attachments`: Optional filenames to attach from the working directory');
    parts.push('After a successful reply, confirm and stop.');
    parts.push('');
    parts.push('## Modes');
    parts.push('Determine the mode from the user\'s message:');
    parts.push('- **Plan mode** (plan/计划/analyze/分析/propose/提议/design/设计/review/审查): Only read, search, and think. Do NOT edit files or run commands that modify state. Output your analysis and plan, then ask the user to confirm before executing.');
    parts.push('- **Build mode** (implement/实现/build/构建/fix/修复/create/创建/deploy/部署): Execute the full workflow — edit files, run tests, commit, etc.');
    parts.push('- **If unclear**: Default to plan mode. Present your plan and ask the user to confirm before making changes.');

    // Append thread-specific system prompt if system.md exists
    try {
      const systemMdPath = join(threadPath, 'system.md');
      const threadSystemPrompt = await readFile(systemMdPath, 'utf-8');
      if (threadSystemPrompt.trim()) {
        logger.info('Loaded thread system.md', { path: systemMdPath, length: threadSystemPrompt.trim().length });
        parts.push('');
        parts.push(threadSystemPrompt.trim());
      }
    } catch (err) {
      logger.debug('No system.md found', { threadPath, error: err instanceof Error ? err.message : 'Unknown' });
    }

    return parts.join('\n');
  }

  /**
   * Build the user prompt from an inbound message.
   * Includes conversation history, incoming message body, and reply context.
   */
  async buildPrompt(message: InboundMessage, threadPath: string, messageDir?: string): Promise<string> {
    const parts: string[] = [];
    const threadName = basename(threadPath);

    // Include thread context (conversation history)
    if (this.config.includeThreadHistory !== false) {
      const threadContext = await this.buildPromptContext(threadPath);
      if (threadContext) {
        parts.push('## Conversation history (most recent messages):');
        parts.push(threadContext);
        parts.push('');
      }
    }

    // Incoming message body (stripped + truncated)
    let bodyText = message.content.text || message.content.markdown || message.content.html || '';
    bodyText = stripQuotedHistory(bodyText);
    if (bodyText.length > MAX_BODY_IN_PROMPT) {
      bodyText = truncateText(bodyText, MAX_BODY_IN_PROMPT);
    }

    const cleanTopic = message.topic;

    parts.push('## Incoming Message');
    parts.push(`**From:** ${message.sender} <${message.senderAddress}>`);
    parts.push(`**Subject:** ${cleanTopic}`);
    parts.push(`**Date:** ${message.timestamp.toISOString()}`);
    parts.push('');
    parts.push(`**Body:**`);
    parts.push(bodyText);

    // Truncate conversation content BEFORE appending reply context
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
    const replyContext = serializeContext(message, threadName, messageDir);
    const contextBlock = '\n\n<reply_context>' + replyContext + '</reply_context>';

    const prompt = conversationPrompt + contextBlock;

    logger.debug('Prompt composition', {
      conversationLength: conversationPrompt.length,
      contextLength: contextBlock.length,
      totalLength: prompt.length,
    });

    return prompt;
  }

  /**
   * Build prompt context from thread message files.
   * Reads received.md and reply.md from message directories,
   * strips quoted history, truncates to fit token budget.
   */
  async buildPromptContext(threadPath: string): Promise<string> {
    try {
      const messagesDir = join(threadPath, 'messages');
      let messageDirs: string[];

      try {
        const entries = await readdir(messagesDir, { withFileTypes: true });
        messageDirs = entries
          .filter(dirent => dirent.isDirectory())
          .filter(dirent => !dirent.name.startsWith('.'))
          .map(dirent => dirent.name)
          .sort()
          .slice(-MAX_FILES_IN_CONTEXT);
      } catch {
        return this.buildPromptContextLegacy(threadPath);
      }

      if (messageDirs.length === 0) {
        return this.buildPromptContextLegacy(threadPath);
      }

      const contextParts: string[] = [];
      let totalLength = 0;

      for (const dirName of messageDirs) {
        const dirPath = join(messagesDir, dirName);

        // Read received.md
        try {
          const receivedPath = join(dirPath, 'received.md');
          const content = await readFile(receivedPath, 'utf-8');
          let fileContent = content.length > MAX_PER_FILE ? truncateText(content, MAX_PER_FILE) : content;
          const trimmedContent = trimMessageContent('received.md', fileContent);
          const strippedContent = stripQuotedHistory(trimmedContent);
          totalLength += strippedContent.length;

          if (totalLength > MAX_TOTAL_CONTEXT) {
            contextParts.push(strippedContent);
            break;
          }
          contextParts.push(strippedContent);
        } catch {
          // No received.md — skip
        }

        if (totalLength > MAX_TOTAL_CONTEXT) break;

        // Read reply.md
        try {
          const replyPath = join(dirPath, 'reply.md');
          const content = await readFile(replyPath, 'utf-8');
          let fileContent = content.length > MAX_PER_FILE ? truncateText(content, MAX_PER_FILE) : content;
          const trimmedContent = trimMessageContent('reply.md', fileContent);
          totalLength += trimmedContent.length;

          if (totalLength > MAX_TOTAL_CONTEXT) {
            contextParts.push(trimmedContent);
            break;
          }
          contextParts.push(trimmedContent);
        } catch {
          // No reply.md — skip
        }

        if (totalLength > MAX_TOTAL_CONTEXT) break;
      }

      return contextParts.join('\n\n');
    } catch (error) {
      logger.debug('Failed to build prompt context', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return '';
    }
  }

  /**
   * Legacy: read from .jiny/*.md for threads not yet migrated.
   */
  private async buildPromptContextLegacy(threadPath: string): Promise<string> {
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

      if (allFiles.length === 0) return '';

      const contextParts: string[] = [];
      let totalLength = 0;

      for (const fileName of allFiles) {
        try {
          const content = await readFile(join(stateDir, fileName), 'utf-8');
          let fileContent = content.length > MAX_PER_FILE ? truncateText(content, MAX_PER_FILE) : content;
          const trimmedContent = trimMessageContent(fileName, fileContent);
          const strippedContent = stripQuotedHistory(trimmedContent);
          totalLength += strippedContent.length;

          if (totalLength > MAX_TOTAL_CONTEXT) {
            contextParts.push(strippedContent);
            break;
          }
          contextParts.push(strippedContent);
        } catch {
          // skip unreadable files
        }
      }

      return contextParts.join('\n\n');
    } catch {
      return '';
    }
  }
}

/**
 * Trim message content — extract body from markdown file format.
 * Looks for the ## SenderName (HH:MM AM/PM) header and extracts body after it.
 */
function trimMessageContent(fileName: string, content: string): string {
  const lines = content.split('\n');
  let isBody = false;
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (typeof line !== 'string') continue;

    if (isBody) {
      if (line.startsWith('================================================================================')) {
        break;
      }
      bodyLines.push(line);
    } else if (line.includes('__ ')) {
      continue;
    } else if (line.startsWith('## ') && line.match(/## .+ \(\d{1,2}:\d{2}\s*(AM|PM)?\)/)) {
      isBody = true;
      continue;
    }
  }

  return bodyLines.join('\n').trim();
}
