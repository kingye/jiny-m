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
import { stripQuotedHistory, truncateText, buildThreadTrail, formatDateTimeISO } from '../../core/email-parser';
import { serializeContext } from '../../mcp/context';

const MAX_FILES_IN_CONTEXT = 10;
const MAX_BODY_IN_PROMPT = 2000;
const MAX_PER_FILE = 800;
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
    parts.push('## Security: Directory Boundaries');
    parts.push('- NEVER use `..` or any relative path that resolves outside your working directory.');
    parts.push('- Do NOT access, read, write, list, or reference any parent directories or sibling workspaces.');
    parts.push('- Do NOT use absolute paths outside your working directory.');
    parts.push('- If a task requires files outside this directory, refuse and explain you cannot access them.');
    parts.push('');
    parts.push('## Important: Focus on the Current Message');
    parts.push('You will see a "Conversation history" section and an "Incoming Message" section in the user prompt.');
    parts.push('The conversation history is for CONTEXT ONLY — do NOT act on previous messages.');
    parts.push('You MUST only respond to the CURRENT "Incoming Message". Do NOT continue work from previous messages.');
    parts.push('After you have replied to the current message, STOP. Do not do anything else.');
    parts.push('');
    parts.push('## Reply Instructions');
    parts.push('When replying to a message, use the jiny_reply_reply_message tool:');
    parts.push('- `token`: Pass the opaque token from the <reply_context> block exactly as-is (do not decode or modify it)');
    parts.push('CRITICAL: DO NOT decode, modify, re-encode, or add any formatting (backticks, quotes, spaces, newlines) to the token.');
    parts.push('Any change—even a single character—will break the reply.');
    parts.push('- `message`: Your reply text');
    parts.push('- `attachments`: Optional filenames to attach from the working directory');
    parts.push('After a successful reply, STOP immediately. Do NOT call any other tools or perform further actions.');
    parts.push('');

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
   * Uses buildThreadTrail() for interleaved received/reply entries with
   * stripped quoted history, truncated per-entry and capped by total size.
   */
  async buildPromptContext(threadPath: string): Promise<string> {
    try {
      const messagesDir = join(threadPath, 'messages');

      // Check if messages/ directory exists, fall back to legacy .jiny/ if not
      try {
        const entries = await readdir(messagesDir, { withFileTypes: true });
        const hasDirs = entries.some(e => e.isDirectory() && !e.name.startsWith('.'));
        if (!hasDirs) {
          return this.buildPromptContextLegacy(threadPath);
        }
      } catch {
        return this.buildPromptContextLegacy(threadPath);
      }

      const trail = await buildThreadTrail(threadPath, {
        maxEntries: MAX_FILES_IN_CONTEXT,
        maxPerEntry: MAX_PER_FILE,
      });

      if (trail.length === 0) {
        return this.buildPromptContextLegacy(threadPath);
      }

      // Trail comes back most-recent-first; reverse for chronological order in prompt
      const chronological = trail.reverse();

      const contextParts: string[] = [];
      let totalLength = 0;

      for (const entry of chronological) {
        const label = entry.type === 'reply' ? 'AI Assistant' : entry.sender;
        const timeStr = formatTimeForContext(entry.timestamp);
        const part = `### ${label} (${timeStr})\n${entry.bodyText}`;

        totalLength += part.length;
        contextParts.push(part);

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

/**
 * Format a timestamp for display in prompt context (YYYY-MM-DD HH:MM).
 */
function formatTimeForContext(timestamp: Date): string {
  try {
    if (timestamp instanceof Date && !isNaN(timestamp.getTime())) {
      return formatDateTimeISO(timestamp);
    }
  } catch { /* fallback */ }
  return formatDateTimeISO(new Date());
}
