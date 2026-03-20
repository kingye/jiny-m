import { mkdir, writeFile, readFile, stat, access } from 'node:fs/promises';
import { join, dirname, extname, basename } from 'node:path';
import type { Email, WorkspaceConfig, PatternMatch, InboundAttachmentConfig, Attachment } from '../../types';
import { sanitizeForFilename, deriveThreadName } from '../../core/email-parser';
import { logger } from '../../core/logger';
import { parseFileSize } from '../../utils/helpers';

// @ts-ignore - turndown module import
import TurndownService from 'turndown';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

/**
 * Format a date as YYYY-MM-DD_HH-mm-ss for use in directory/file names.
 */
function formatDateForFilename(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/**
 * Convert an email to markdown format (chat-style).
 */
function emailToMarkdown(email: Email): string {
  const lines: string[] = [];

  // YAML-like frontmatter (minimal)
  lines.push('---');
  lines.push(`uid: ${email.uid}`);
  if (email.messageId) {
    lines.push(`message_id: "${email.messageId}"`);
  }
  if (email.inReplyTo) {
    lines.push(`in_reply_to: "${email.inReplyTo}"`);
  }
  if (email.matchedPattern) {
    lines.push(`matched_pattern: "${email.matchedPattern}"`);
  }
  lines.push('---');
  lines.push('');

  // Chat-style formatting
  const timeStr = email.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let fromName = email.from || 'Unknown';
  if (fromName.includes('<')) {
    const parts = fromName.split('<');
    fromName = parts[0]?.trim().replace(/['"]/g, '') || fromName;
  }

  lines.push(`## ${fromName} (${timeStr})`);
  lines.push('');

  // Body - prefer markdown, convert HTML to markdown if needed
  let bodyContent: string;
  if (email.body.text) {
    bodyContent = email.body.text;
  } else if (email.body.html) {
    bodyContent = turndownService.turndown(email.body.html);
  } else {
    bodyContent = '[No content]';
  }

  // Store full body content (including quoted history) as the canonical record.
  // Stripping is only done at AI prompt consumption time, not at storage time.
  lines.push(bodyContent);
  lines.push('');

  // Attachments metadata
  if (email.attachments && email.attachments.length > 0) {
    lines.push('*📎 Attachments:*');
    for (const att of email.attachments) {
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
 * - Strip path components (keep basename only)
 * - Replace unsafe characters
 * - Truncate to 200 chars (preserving extension)
 * - Normalize Unicode to NFC
 */
function sanitizeAttachmentFilename(filename: string): string {
  // Take basename only (strip any path components)
  let safe = basename(filename);

  // Normalize Unicode
  safe = safe.normalize('NFC');

  // Replace unsafe characters (keep alphanumeric, -, _, ., space)
  safe = safe.replace(/[^\w\-. ]/g, '_');

  // Remove leading dots (hidden files)
  safe = safe.replace(/^\.+/, '');

  // Fallback if empty
  if (!safe || safe === '') {
    safe = 'attachment';
  }

  // Truncate to 200 chars, preserving extension
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
 * report.pdf → report_2.pdf → report_3.pdf
 */
async function resolveFilenameCollision(dirPath: string, filename: string): Promise<string> {
  let candidate = filename;
  let counter = 1;

  while (true) {
    try {
      await access(join(dirPath, candidate));
      // File exists — try next counter
      counter++;
      const ext = extname(filename);
      const nameWithoutExt = filename.substring(0, filename.length - ext.length);
      candidate = `${nameWithoutExt}_${counter}${ext}`;
    } catch {
      // File doesn't exist — use this name
      return candidate;
    }
  }
}

/**
 * Resolve message directory collision by adding a counter suffix.
 * 2026-03-19_23-02-20 → 2026-03-19_23-02-20_2
 */
async function resolveMessageDirCollision(parentDir: string, dirName: string): Promise<string> {
  let candidate = dirName;
  let counter = 1;

  while (true) {
    try {
      await access(join(parentDir, candidate));
      // Directory exists — try next counter
      counter++;
      candidate = `${dirName}_${counter}`;
    } catch {
      // Directory doesn't exist — use this name
      return candidate;
    }
  }
}

/**
 * EmailStorage handles persisting matched emails as markdown files
 * organized into thread-based folders under the workspace directory.
 *
 * Directory structure:
 *   <workspace>/
 *     <thread-name>/
 *       messages/
 *         2026-03-19_23-02-20/      # Per-message directory (turn)
 *           received.md             # Incoming email
 *           reply.md                # AI reply
 *           attachment.pptx         # Saved inbound attachment
 *       .jiny/                      # Internal state (session, logs, signals)
 *         session.json
 *         reply-tool.log
 *         reply-sent.flag
 */
export class EmailStorage {
  private workspaceFolder: string;

  constructor(config: WorkspaceConfig) {
    this.workspaceFolder = join(process.cwd(), config.folder);
  }

  /**
   * Ensure the workspace root directory exists.
   */
  async init(): Promise<void> {
    await mkdir(this.workspaceFolder, { recursive: true });
    logger.info('Workspace initialized', { folder: this.workspaceFolder });
  }

  /**
   * Store an email as received.md in a per-message directory.
   * Returns the thread directory path and the message directory name.
   */
  async store(email: Email, patternMatch?: PatternMatch, inboundAttachmentConfig?: InboundAttachmentConfig): Promise<{
    messageDir: string;
    threadPath: string;
  }> {
    // Derive thread folder name from the subject
    const additionalPrefixes = patternMatch?.matches.subject?.prefix
      ? [patternMatch.matches.subject.prefix]
      : undefined;

    const threadName = sanitizeForFilename(deriveThreadName(email.subject, additionalPrefixes));
    const threadDir = join(this.workspaceFolder, threadName);

    // Create thread directory and messages/ subfolder
    const messagesDir = join(threadDir, 'messages');
    await mkdir(messagesDir, { recursive: true });

    // Create .jiny subfolder for internal state
    await mkdir(join(threadDir, '.jiny'), { recursive: true });

    // Create per-message directory: messages/<timestamp>/
    const dateStr = formatDateForFilename(email.date);
    const messageDirName = await resolveMessageDirCollision(messagesDir, dateStr);
    const messageDirPath = join(messagesDir, messageDirName);
    await mkdir(messageDirPath, { recursive: true });

    // Save inbound attachments (before writing markdown, so we can update status)
    if (inboundAttachmentConfig?.enabled && email.attachments && email.attachments.length > 0) {
      await this.saveAttachments(email.attachments, messageDirPath, inboundAttachmentConfig);
    }

    // Convert to markdown and write as received.md
    const markdown = emailToMarkdown(email);
    const filePath = join(messageDirPath, 'received.md');
    await writeFile(filePath, markdown, 'utf-8');

    logger.info('Email stored', { thread: threadName, messageDir: messageDirName });
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
    attachments: Attachment[],
    messageDirPath: string,
    config: InboundAttachmentConfig,
  ): Promise<void> {
    const maxSizeBytes = parseFileSize(config.maxFileSize);
    const allowedExts = config.allowedExtensions.map(e => e.toLowerCase());
    let savedCount = 0;

    for (const att of attachments) {
      // Check per-email attachment count limit
      if (savedCount >= config.maxAttachmentsPerEmail) {
        logger.debug('Skipping attachment: max per-email limit reached', {
          filename: att.filename,
          limit: config.maxAttachmentsPerEmail,
        });
        att.savedPath = ''; // Mark as skipped (empty string = skipped)
        continue;
      }

      // Must have content to save
      if (!att.content || att.content.length === 0) {
        logger.debug('Skipping attachment: no content', { filename: att.filename });
        att.savedPath = '';
        continue;
      }

      // Check extension whitelist (last extension only to prevent double-extension attacks)
      const ext = extname(att.filename).toLowerCase();
      if (!ext || !allowedExts.includes(ext)) {
        logger.debug('Skipping attachment: extension not allowed', {
          filename: att.filename,
          ext,
          allowed: allowedExts,
        });
        att.savedPath = '';
        continue;
      }

      // Check file size
      if (att.size > maxSizeBytes) {
        logger.debug('Skipping attachment: exceeds max size', {
          filename: att.filename,
          size: att.size,
          maxSize: maxSizeBytes,
        });
        att.savedPath = '';
        continue;
      }

      // Sanitize filename and resolve collisions
      const safeName = sanitizeAttachmentFilename(att.filename);
      const finalName = await resolveFilenameCollision(messageDirPath, safeName);
      const targetPath = join(messageDirPath, finalName);

      try {
        await writeFile(targetPath, att.content);
        att.savedPath = targetPath;
        savedCount++;
        logger.info('Attachment saved', {
          filename: finalName,
          size: att.size,
          dir: basename(messageDirPath),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Failed to save attachment', { filename: att.filename, error: msg });
        att.savedPath = '';
      }

      // Free the buffer to release memory
      att.content = undefined;
    }
  }

  /**
   * Store an AI reply in the same message directory as the incoming email.
   * If messageDir is provided, writes reply.md alongside received.md.
   * Otherwise creates a new message directory.
   */
  async storeReply(threadPath: string, replyText: string, email: Email, messageDir?: string): Promise<string> {
    let replyDirPath: string;

    if (messageDir) {
      // Write alongside the incoming email
      replyDirPath = join(threadPath, 'messages', messageDir);
      await mkdir(replyDirPath, { recursive: true });
    } else {
      // Fallback: create a new message directory
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
