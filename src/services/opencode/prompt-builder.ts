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
import { stripReplyPrefix as stripReplyPrefixes } from '../../utils/helpers';
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
   */
  buildSystemPrompt(threadPath: string): string {
    const parts: string[] = [];

    if (this.config.systemPrompt) {
      parts.push(this.config.systemPrompt);
      parts.push('');
    }

    parts.push(`Your working directory is "${threadPath}". You MUST only read, write, and access files within this directory. Do NOT access files outside this directory.`);
    parts.push('');
    parts.push('## Reply Instructions');
    parts.push('When you need to reply to a message, you MUST use the jiny_reply_reply_message tool.');
    parts.push('The reply context is provided in a <reply_context>JSON</reply_context> block in the user message.');
    parts.push('');
    parts.push('CRITICAL RULES for calling jiny_reply_reply_message:');
    parts.push('1. The `context` parameter MUST be the raw JSON string from inside the <reply_context> tags.');
    parts.push('   - Copy ONLY the JSON object: starts with { and ends with }');
    parts.push('   - Do NOT include the <reply_context> or </reply_context> tags themselves');
    parts.push('   - Do NOT modify, reformat, summarize, or reconstruct the JSON in any way');
    parts.push('   - Do NOT add or remove any fields, fix quotes, or change values');
    parts.push('   - Pass it character-for-character EXACTLY as it appears between the tags');
    parts.push('2. The `message` parameter is your reply text.');
    parts.push('3. If you need to attach files, pass filenames in the `attachments` parameter.');
    parts.push('4. After calling jiny_reply_reply_message successfully, you are DONE. Do NOT call any other tools. Just confirm.');

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

    const cleanTopic = stripReplyPrefixes(message.topic);

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
