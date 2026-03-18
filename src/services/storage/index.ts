import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Email, WorkspaceConfig, PatternMatch } from '../../types';
import { sanitizeForFilename, deriveThreadName, stripQuotedHistory } from '../../core/email-parser';
import { logger } from '../../core/logger';

// @ts-ignore - turndown module import
import TurndownService from 'turndown';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

/**
 * Format a date as YYYY-MM-DD_HH-mm-ss for use in filenames.
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

  // Remove quoted reply history to keep files small
  const cleanedBody = stripQuotedHistory(bodyContent);
  lines.push(cleanedBody);
  lines.push('');

  // Attachments
  if (email.attachments && email.attachments.length > 0) {
    lines.push('*📎 Attachments:*');
    for (const att of email.attachments) {
      lines.push(`  - **${att.filename}** (${att.contentType}, ${att.size} bytes)`);
    }
    lines.push('');
  }

  lines.push('--- ');

  return lines.join('\n');
}

/**
 * EmailStorage handles persisting matched emails as markdown files
 * organized into thread-based folders under the workspace directory.
 *
 * Directory structure:
 *   <workspace>/
 *     <thread-name>/
 *       2026-03-17_14-30-00_subject.md
 *       2026-03-17_15-00-00_Re_subject.md
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
   * Store an email as a markdown file in the appropriate thread folder.
   * Returns the file path where the email was saved and the thread directory.
   */
  async store(email: Email, patternMatch?: PatternMatch): Promise<{
    filePath: string;
    threadPath: string;
  }> {
    // Derive thread folder name from the subject
    // Strip reply/forward prefixes and also the matched prefix if any
    const additionalPrefixes = patternMatch?.matches.subject?.prefix
      ? [patternMatch.matches.subject.prefix]
      : undefined;

    const threadName = sanitizeForFilename(deriveThreadName(email.subject, additionalPrefixes));
    const threadDir = join(this.workspaceFolder, threadName);

    // Create thread directory
    await mkdir(threadDir, { recursive: true });

    // Create .jiny subfolder for state files (emails, replies, sessions)
    const stateDir = join(threadDir, '.jiny');
    await mkdir(stateDir, { recursive: true });

    // Build filename: date_subject.md
    const dateStr = formatDateForFilename(email.date);
    const subjectSlug = sanitizeForFilename(deriveThreadName(email.subject)).substring(0, 60);
    const filename = `${dateStr}_${subjectSlug}.md`;
    const filePath = join(stateDir, filename);

    // Convert to markdown and write
    const markdown = emailToMarkdown(email);
    await writeFile(filePath, markdown, 'utf-8');

    logger.info('Email stored', { thread: threadName, file: filename });
    return {
      filePath,
      threadPath: threadDir,
    };
  }

  /**
   * Get the thread directory path for a file path.
   */
  getThreadPath(filePath: string): string {
    return dirname(filePath);
  }

  /**
   * Store an AI reply in the thread folder.
   * Returns the file path where the reply was saved.
   */
  async storeReply(threadPath: string, replyText: string, email: Email): Promise<string> {
    const dateStr = formatDateForFilename(new Date());
    const filename = `${dateStr}_auto-reply.md`;
    const stateDir = join(threadPath, '.jiny');
    const filePath = join(stateDir, filename);

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
    
    logger.info('AI reply stored', { file: filename, thread: dirname(threadPath).split('/').pop() });
    return filePath;
  }
}
