import type { Email, Attachment } from '../types';
import * as mailparser from 'mailparser';
import { stripReplyPrefix } from '../utils/helpers';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_HISTORY_QUOTE = 2;

/**
 * Derive a thread name from the subject by stripping Re:/Fwd: and optional additional prefixes.
 * This groups replies and forwards under the same thread folder.
 */
function deriveThreadName(subject: string, additionalPrefixes?: string[]): string {
  let result = subject;
  
  // First strip reply/forward prefixes
  result = stripReplyPrefix(result);
  
  // Then strip any additional prefixes (e.g., "Urgent:", "Alert:")
  if (additionalPrefixes && additionalPrefixes.length > 0) {
    // Sort by length (longest first) to match most specific first
    const sortedPrefixes = [...additionalPrefixes].sort((a, b) => b.length - a.length);
    
    for (const prefix of sortedPrefixes) {
      // Match prefix followed by optional whitespace and any common separator
      // Separators: : ： - _ ~ | / & $ # @ ! + = > » →
      const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedPrefix}\\s*[:\\-_~|/&$#@!+=»→：]?\\s*`, 'i');
      if (regex.test(result)) {
        result = result.replace(regex, '');
        break; // Only strip one additional prefix (the matched one)
      }
    }
  }
  
  // Strip any remaining leading punctuation/separators
  result = result.replace(/^[\s\-_~|/&$#@!+=»→：:]+/, '');
  
  return result.trim() || 'untitled';
}

/**
 * Sanitize a string for use as a filesystem directory/file name.
 */
function sanitizeForFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 200) || 'untitled';
}

/**
 * Strip quoted reply history from email body.
 * Removes reply headers, deeply nested quotes, and dividers.
 * Keeps only the new content from the sender.
 */
export function stripQuotedHistory(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];

  const replyHeaderPatterns = [
    /^发件人[:：]/,
    /^发件时间[:：]/,
    /^收件人[:：]/,
    /^抄送[:：]/,
    /^主题[:：]/,
    /^From[:：]/i,
    /^Sent[:：]/i,
    /^To[:：]/i,
    /^Cc[:：]/i,
    /^Subject[:：]/i,
  ];

  const dividerPatterns = [
    /^[-=_~\*]{3,}\s*$/,
    /^[_~\*]{8,}\s*$/,
  ];

  const englishOnPattern = /^On\s+.*wrote[:.]?$/i;
  const quotedLinePattern = /^>+?\s*\S/;

  let foundReply = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const trimmed = line.trim();

    if (foundReply) {
      continue;
    }

    let isReplyLine = false;

    for (const pattern of replyHeaderPatterns) {
      if (pattern.test(trimmed)) {
        isReplyLine = true;
        break;
      }
    }

    if (isReplyLine) {
      foundReply = true;
      continue;
    }

    for (const pattern of dividerPatterns) {
      if (pattern.test(trimmed)) {
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          if (!nextLine) continue;
          const nextTrimmed = nextLine.trim();
          let nextIsHeader = false;
          for (const headerPattern of replyHeaderPatterns) {
            if (headerPattern.test(nextTrimmed)) {
              nextIsHeader = true;
              break;
            }
          }
          if (nextIsHeader) {
            foundReply = true;
            continue;
          }
        }
      }
    }

    if (englishOnPattern.test(trimmed)) {
      foundReply = true;
      continue;
    }

    if (quotedLinePattern.test(trimmed)) {
      const match = trimmed.match(/^>+/);
      if (match && match[0]) {
        const quoteDepth = match[0].length;
        if (quoteDepth >= 2) {
          foundReply = true;
          continue;
        }
      }
    }

    if (trimmed === '') {
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (!nextLine) continue;
        const nextTrimmed = nextLine.trim();
        let nextIsHeader = false;
        for (const headerPattern of replyHeaderPatterns) {
          if (headerPattern.test(nextTrimmed)) {
            nextIsHeader = true;
            break;
          }
        }
        if (nextIsHeader) {
          foundReply = true;
          continue;
        }
      }
    }

    result.push(line);
  }

  let cleaned = result.join('\n').trim();

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  cleaned = cleaned.replace(/^>\s*/gm, '');

  return cleaned.trim();
}

/**
 * Truncate text to a maximum length, showing head and tail.
 * Used for fitting content within token limits.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const half = Math.floor(maxLength / 2);
  return text.substring(0, half) + ' ... [truncated] ... ' + text.substring(text.length - half);
}

export class EmailParser {
  async parseEmail(rawEmail: string | Buffer, emailId: string, uid: number): Promise<Email> {
    try {
      const parsed = await mailparser.simpleParser(rawEmail);
      
      const fromAddress = parsed.from 
        ? (Array.isArray(parsed.from) ? parsed.from[0]?.text || '' : parsed.from.text || '')
        : '';
        
      const toAddresses = parsed.to 
        ? (Array.isArray(parsed.to) 
            ? parsed.to.map((a: any) => a.text || '').filter(Boolean)
            : [parsed.to.text || ''].filter(Boolean))
        : [];

      // Extract thread-related headers
      const messageId = parsed.messageId || undefined;
      const inReplyTo = parsed.inReplyTo || undefined;
      const references = parsed.references
        ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
        : undefined;

      // Derive thread ID: use the first reference (original message) or the inReplyTo or messageId
      const threadId = (references && references.length > 0 ? references[0] : undefined)
        || inReplyTo
        || messageId
        || undefined;

      const subject = parsed.subject || '';
      const threadName = sanitizeForFilename(deriveThreadName(subject));

      return {
        id: emailId,
        uid,
        from: fromAddress,
        to: toAddresses,
        subject,
        date: parsed.date || new Date(),
        body: {
          text: parsed.text || '',
          html: parsed.html || '',
        },
        headers: parsed.headers as unknown as Record<string, string>,
        attachments: parsed.attachments && parsed.attachments.length > 0 
          ? parsed.attachments.map((att: any) => ({
              filename: att.filename || 'attachment',
              contentType: att.contentType || 'application/octet-stream',
              size: att.size || 0,
              contentId: att.contentId,
              disposition: att.contentDisposition,
              content: att.content, // Preserve binary Buffer for inbound attachment saving
            }))
          : undefined,
        threadId,
        messageId,
        inReplyTo,
        references,
      };
    } catch (error) {
      console.error('Error parsing email:', error);
      throw new Error(`Failed to parse email: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

export const emailParser = new EmailParser();
export { deriveThreadName, sanitizeForFilename };

/**
 * Clean up email body text at ingest time.
 *
 * Fixes redundant Re:/回复: prefixes in quoted 主題/Subject lines
 * within the email body.
 *
 * Note: bracket-nested duplicate addresses/URLs (e.g. `addr [addr]`) are
 * NOT cleaned here. The root cause was `marked.parse()` auto-linking email
 * addresses into `<a>` tags, which recipients' email clients converted to
 * `ADDR [addr]` in plain text. This is fixed at the source by disabling
 * auto-linking in SmtpService.markdownToHtml().
 *
 * Applied once at InboundAdapter boundary so all downstream consumers
 * (storage, prompt builder, reply tool) get clean data.
 */
export function cleanEmailBody(text: string): string {
  return text
    .split('\n')
    .map(line => {
      // Clean 主題/Subject lines: normalize to single Re:
      // May appear at start of line (with optional > quote prefix) or mid-line
      return line.replace(/((?:^|\s)(?:>\s*)*)(主题[:：]\s*|Subject[:：]\s*)((?:Re[:：]\s*|回复[:：]\s*|Fwd?[:：]\s*|转发[:：]\s*)*)(.*)/gi,
        (_match, prefix, label, _prefixes, subject) => {
          const cleanSubject = stripReplyPrefix(subject);
          return `${prefix}${label}Re: ${cleanSubject}`;
        }
      );
    })
    .join('\n');
}

/**
 * Parse a stored markdown message (received.md) into its components.
 * Returns null if the format is invalid.
 */
export function parseStoredMessage(mdContent: string): { sender: string; timestamp: Date; topic: string; bodyText: string } | null {
  const lines = mdContent.split('\n');
  let inFrontmatter = false;
  let pastFrontmatter = false;
  const frontmatter: Record<string, string> = {};
  let headerLine = '';
  const bodyLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    if (!pastFrontmatter) {
      if (trimmed === '---') {
        if (inFrontmatter) {
          pastFrontmatter = true;
          inFrontmatter = false;
        } else {
          inFrontmatter = true;
        }
        continue;
      }
      if (inFrontmatter) {
        const match = /^(\w+):\s*(.+)$/.exec(trimmed);
        if (match) {
          const key = match[1];
          let value = match[2];
          // Remove surrounding quotes if present
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.substring(1, value.length - 1);
          }
          frontmatter[key] = value;
        }
      }
      continue;
    }

    // After frontmatter, look for header line
    if (!headerLine) {
      if (trimmed.startsWith('## ') && /\(\d{1,2}:\d{2}\s*(AM|PM)?\)/.test(trimmed)) {
        headerLine = trimmed;
        continue;
      }
      // Skip lines until header found
      continue;
    }

    // After header, collect body lines until closing separator
    if (trimmed === '---' || trimmed === '--- ') {
      break;
    }
    bodyLines.push(line);
  }

  if (!headerLine) {
    return null;
  }

  // Extract sender from header line: "## SenderName (HH:MM AM/PM)"
  const senderMatch = headerLine.match(/^##\s+(.+?)\s+\(/);
  const sender = senderMatch ? senderMatch[1].trim() : 'Unknown';

  // Parse timestamp from frontmatter (ISO string) or default to current date
  let timestamp: Date;
  if (frontmatter.timestamp) {
    try {
      timestamp = new Date(frontmatter.timestamp);
      if (isNaN(timestamp.getTime())) {
        timestamp = new Date();
      }
    } catch {
      timestamp = new Date();
    }
  } else {
    timestamp = new Date();
  }

  const topic = frontmatter.topic || '';
  const bodyText = bodyLines.join('\n').trim();
  return { sender, timestamp, topic, bodyText };
}

/**
 * Prepare quoted history for a reply, combining the current message with recent historical messages.
 * Reads stored messages from the thread's messages/ directory, sorts by timestamp (descending),
 * includes up to maxHistory messages (default MAX_HISTORY_QUOTE).
 * Each message is formatted as a quoted block using formatQuotedReply.
 * The current message (the one being replied to) is included as the first (most recent) quoted block.
 * Returns the combined quoted history string, empty if no messages.
 */
export async function prepareBodyForQuoting(
  threadPath: string,
  currentMessage: { sender: string; timestamp: Date; topic: string; bodyText: string },
  maxHistory?: number,
  excludeMessageDir?: string,
): Promise<string> {
  const limit = maxHistory ?? MAX_HISTORY_QUOTE;
  const messagesDir = join(threadPath, 'messages');
  let storedMessages: Array<{ sender: string; timestamp: Date; topic: string; bodyText: string }> = [];

  try {
    const entries = await readdir(messagesDir, { withFileTypes: true });
    let dirNames = entries
      .filter(dirent => dirent.isDirectory())
      .filter(dirent => !dirent.name.startsWith('.'))
      .map(dirent => dirent.name)
      .sort()
      .reverse(); // most recent first

    if (excludeMessageDir) {
      dirNames = dirNames.filter(name => name !== excludeMessageDir);
    } else {
      // Assume the most recent directory is the current message, skip it
      dirNames = dirNames.slice(1);
    }
    // Take up to limit - 1 historical messages (excluding current)
    dirNames = dirNames.slice(0, limit - 1);

    for (const dirName of dirNames) {
      const receivedPath = join(messagesDir, dirName, 'received.md');
      try {
        const content = await readFile(receivedPath, 'utf-8');
        const parsed = parseStoredMessage(content);
        if (parsed) {
          storedMessages.push(parsed);
        }
      } catch {
        // skip missing or unreadable files
      }
    }
  } catch {
    // If messages/ directory doesn't exist, fallback to legacy .jiny/ or empty
  }

  // Start with current message (most recent)
  const allMessages = [currentMessage, ...storedMessages].slice(0, limit);
  const quotedBlocks: string[] = [];

  for (const msg of allMessages) {
    const quoted = formatQuotedReply(msg.sender, msg.timestamp, msg.topic, msg.bodyText);
    if (quoted) {
      quotedBlocks.push(quoted);
    }
  }

  return quotedBlocks.join('\n\n');
}

/**
 * Format a quoted reply block in markdown.
 * Takes the FULL body as-is — NO stripping, NO cleaning.
 * Cleaning happens at ingest time in InboundAdapter, not here.
 *
 * Returns empty string if bodyText is empty (no quoted block needed).
 */
export function formatQuotedReply(
  sender: string,
  timestamp: Date | string,
  subject: string,
  bodyText: string,
): string {
  if (!bodyText.trim()) return '';

  // Format time with Invalid Date fallback
  let timeStr: string;
  try {
    const d = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
    timeStr = (d instanceof Date && !isNaN(d.getTime()))
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Extract display name — strip angle brackets and nested brackets
  let fromName = sender || 'Unknown';
  if (fromName.includes('<')) {
    fromName = fromName.split('<')[0]?.trim().replace(/['"]/g, '') || fromName;
  }
  fromName = fromName.replace(/\s*\[.*$/, '').trim();
  if (!fromName) fromName = sender || 'Unknown';

  const lines: string[] = [];
  lines.push('---');
  lines.push(`### ${fromName} (${timeStr})`);
  lines.push('> ' + subject);
  lines.push('');

  const quotedBody = bodyText
    .split('\n')
    .map((line: string) => `> ${line}`)
    .join('\n');
  lines.push(quotedBody);

  return lines.join('\n');
}
