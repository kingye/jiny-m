/**
 * Channel-agnostic message storage.
 *
 * Stores inbound messages as markdown files in per-thread directories.
 * Uses InboundMessage (not Email) as the input type.
 *
 * Directory structure:
 *   <workspace>/
 *     <thread-name>/
 *       messages/
 *         2026-03-19_23-02-20/      # Per-message directory (turn)
 *           received.md             # Incoming message
 *           reply.md                # AI reply
 *           attachment.pptx         # Saved inbound attachment
 *       .jiny/                      # Internal state (session, logs, signals)
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import type {
  InboundMessage,
  MessageAttachment,
  AttachmentDownloadConfig,
} from '../channels/types';
import type { WorkspaceConfig } from '../types';
import { logger } from './logger';
import { parseFileSize } from '../utils/helpers';

// @ts-ignore - turndown module import
import TurndownService from 'turndown';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

/**
 * Format a date as YYYY-MM-DD_HH-mm-ss in UTC for use in directory/file names.
 * This is the SINGLE SOURCE OF TRUTH for message directory naming.
 * Uses UTC to ensure consistency across timezone/DST changes.
 */
export function formatDateForFilename(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`;
}

/**
 * Convert an InboundMessage to markdown format (chat-style) with unified frontmatter.
 */
function messageToMarkdown(message: InboundMessage): string {
  const lines: string[] = [];

  // Unified frontmatter with channel field
  lines.push('---');
  lines.push(`channel: ${message.channel}`);
  lines.push(`uid: "${message.channelUid}"`);
  if (message.externalId) {
    lines.push(`external_id: "${message.externalId}"`);
  }
  if (message.matchedPattern) {
    lines.push(`matched_pattern: "${message.matchedPattern}"`);
  }
  lines.push('---');
  lines.push('');

  // Chat-style formatting: ## SenderName (HH:MM AM/PM)
  const timeStr = message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  lines.push(`## ${message.sender} (${timeStr})`);
  lines.push('');

  // Body content — prefer text, then markdown, then convert HTML
  let bodyContent: string;
  if (message.content.text) {
    bodyContent = message.content.text;
  } else if (message.content.markdown) {
    bodyContent = message.content.markdown;
  } else if (message.content.html) {
    bodyContent = turndownService.turndown(message.content.html);
  } else {
    bodyContent = '[No content]';
  }

  // Store body as-is — cleaning is done at InboundAdapter boundary.
  lines.push(bodyContent);
  lines.push('');

  // Attachments metadata
  if (message.attachments && message.attachments.length > 0) {
    lines.push('*📎 Attachments:*');
    for (const att of message.attachments) {
      const status = att.savedPath ? '✅ saved' : (att.savedPath === undefined ? '' : '⛔ skipped');
      const sizeStr = att.size > 0 ? `${att.size} bytes` : 'unknown size';
      lines.push(`  - **${att.filename}** (${att.contentType}, ${sizeStr}) ${status}`.trimEnd());
    }
    lines.push('');
  }

  lines.push('--- ');

  return lines.join('\n');
}

/**
 * Sanitize an attachment filename for safe disk storage.
 */
function sanitizeAttachmentFilename(filename: string): string {
  let safe = basename(filename);
  safe = safe.normalize('NFC');
  safe = safe.replace(/[^\w\-. ]/g, '_');
  safe = safe.replace(/^\.+/, '');
  if (!safe || safe === '') safe = 'attachment';

  const MAX_NAME_LENGTH = 200;
  if (safe.length > MAX_NAME_LENGTH) {
    const ext = extname(safe);
    const nameWithoutExt = safe.substring(0, safe.length - ext.length);
    safe = nameWithoutExt.substring(0, MAX_NAME_LENGTH - ext.length) + ext;
  }

  return safe;
}

/**
 * Resolve filename collision by adding a counter suffix.
 */
async function resolveFilenameCollision(dirPath: string, filename: string): Promise<string> {
  let candidate = filename;
  let counter = 1;

  while (true) {
    try {
      await access(join(dirPath, candidate));
      counter++;
      const ext = extname(filename);
      const nameWithoutExt = filename.substring(0, filename.length - ext.length);
      candidate = `${nameWithoutExt}_${counter}${ext}`;
    } catch {
      return candidate;
    }
  }
}

/**
 * Resolve message directory collision by adding a counter suffix.
 */
async function resolveMessageDirCollision(parentDir: string, dirName: string): Promise<string> {
  let candidate = dirName;
  let counter = 1;

  while (true) {
    try {
      await access(join(parentDir, candidate));
      counter++;
      candidate = `${dirName}_${counter}`;
    } catch {
      return candidate;
    }
  }
}

/**
 * Channel-agnostic message storage.
 * Stores inbound messages and AI replies as markdown in per-thread directories.
 */
export class MessageStorage {
  private workspaceFolder: string;

  constructor(config: WorkspaceConfig) {
    this.workspaceFolder = join(process.cwd(), config.folder);
  }

  /** Get the workspace root folder path. */
  getWorkspaceFolder(): string {
    return this.workspaceFolder;
  }

  /** Ensure the workspace root directory exists. */
  async init(): Promise<void> {
    await mkdir(this.workspaceFolder, { recursive: true });
    logger.info('Workspace initialized', { folder: this.workspaceFolder });
  }

  /**
   * Store an inbound message as received.md in a per-message directory.
   *
   * The thread name is provided by the caller (derived by the channel adapter).
   * This keeps storage channel-agnostic — it doesn't know how to derive thread names.
   *
   * Returns the thread directory path and the message directory name.
   */
  async store(
    message: InboundMessage,
    threadName: string,
    attachmentConfig?: AttachmentDownloadConfig,
  ): Promise<{ messageDir: string; threadPath: string }> {
    const threadDir = join(this.workspaceFolder, threadName);

    // Create thread directory and messages/ subfolder
    const messagesDir = join(threadDir, 'messages');
    await mkdir(messagesDir, { recursive: true });

    // Create .jiny subfolder for internal state
    await mkdir(join(threadDir, '.jiny'), { recursive: true });

    // Create per-message directory: messages/<timestamp>/
    const dateStr = formatDateForFilename(message.timestamp);
    const messageDirName = await resolveMessageDirCollision(messagesDir, dateStr);
    const messageDirPath = join(messagesDir, messageDirName);
    await mkdir(messageDirPath, { recursive: true });

    // Save inbound attachments (before writing markdown, so we can update status)
    if (attachmentConfig?.enabled && message.attachments && message.attachments.length > 0) {
      await this.saveAttachments(message.attachments, messageDirPath, attachmentConfig);
    }

    // Convert to markdown and write as received.md
    const markdown = messageToMarkdown(message);
    const filePath = join(messageDirPath, 'received.md');
    await writeFile(filePath, markdown, 'utf-8');

    logger.info('Message stored', { thread: threadName, messageDir: messageDirName, channel: message.channel });
    return {
      messageDir: messageDirName,
      threadPath: threadDir,
    };
  }

  /**
   * Save whitelisted inbound attachments to the message directory.
   * Sets savedPath on each saved attachment and clears content Buffer to free memory.
   */
  async saveAttachments(
    attachments: MessageAttachment[],
    messageDirPath: string,
    config: AttachmentDownloadConfig,
  ): Promise<void> {
    const maxSizeBytes = parseFileSize(config.maxFileSize);
    const allowedExts = config.allowedExtensions.map(e => e.toLowerCase());
    let savedCount = 0;

    for (const att of attachments) {
      if (savedCount >= config.maxAttachmentsPerMessage) {
        logger.debug('Skipping attachment: max per-message limit reached', {
          filename: att.filename,
          limit: config.maxAttachmentsPerMessage,
        });
        att.savedPath = '';
        continue;
      }

      if (!att.content || att.content.length === 0) {
        logger.debug('Skipping attachment: no content', { filename: att.filename });
        att.savedPath = '';
        continue;
      }

      const ext = extname(att.filename).toLowerCase();
      if (!ext || !allowedExts.includes(ext)) {
        logger.debug('Skipping attachment: extension not allowed', {
          filename: att.filename, ext, allowed: allowedExts,
        });
        att.savedPath = '';
        continue;
      }

      if (att.size > maxSizeBytes) {
        logger.debug('Skipping attachment: exceeds max size', {
          filename: att.filename, size: att.size, maxSize: maxSizeBytes,
        });
        att.savedPath = '';
        continue;
      }

      const safeName = sanitizeAttachmentFilename(att.filename);
      const finalName = await resolveFilenameCollision(messageDirPath, safeName);
      const targetPath = join(messageDirPath, finalName);

      try {
        await writeFile(targetPath, att.content);
        att.savedPath = targetPath;
        savedCount++;
        logger.info('Attachment saved', { filename: finalName, size: att.size, dir: basename(messageDirPath) });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Failed to save attachment', { filename: att.filename, error: msg });
        att.savedPath = '';
      }

      att.content = undefined; // Free memory
    }
  }

  /**
   * Store an AI reply in the same message directory as the incoming message.
   * If messageDir is provided, writes reply.md alongside received.md.
   * Otherwise creates a new message directory.
   */
  async storeReply(threadPath: string, replyText: string, messageDir?: string): Promise<string> {
    let replyDirPath: string;

    if (messageDir) {
      replyDirPath = join(threadPath, 'messages', messageDir);
      // Verify the directory and received.md exist — if not, the messageDir may be
      // from a different format/timezone. Log a warning but still create it.
      const receivedPath = join(replyDirPath, 'received.md');
      try {
        await access(receivedPath);
      } catch {
        logger.warn('storeReply: received.md not found in messageDir, reply may be orphaned', {
          messageDir,
          expected: receivedPath,
        });
      }
      await mkdir(replyDirPath, { recursive: true });
    } else {
      const messagesDir = join(threadPath, 'messages');
      await mkdir(messagesDir, { recursive: true });
      const dateStr = formatDateForFilename(new Date());
      const dirName = await resolveMessageDirCollision(messagesDir, dateStr);
      replyDirPath = join(messagesDir, dirName);
      await mkdir(replyDirPath, { recursive: true });
    }

    const filePath = join(replyDirPath, 'reply.md');

    const lines: string[] = [];
    lines.push('---');
    lines.push('type: auto-reply');
    lines.push('---');
    lines.push('');
    lines.push('## AI Assistant');
    lines.push('');
    lines.push(replyText);
    lines.push('');
    lines.push('--- ');

    await writeFile(filePath, lines.join('\n'), 'utf-8');

    logger.info('AI reply stored', { file: 'reply.md', messageDir: messageDir || basename(replyDirPath) });
    return filePath;
  }
}
