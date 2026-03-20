import type { Email, Attachment } from '../types';
import * as mailparser from 'mailparser';
import { stripReplyPrefix } from '../utils/helpers';

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
 * Fixes artifacts that accumulate with each reply round in email clients:
 * 1. Bracket-nested duplicate addresses/URLs:
 *    `addr [addr] [addr [addr]]` → `addr`
 *    These brackets can span multiple lines due to line wrapping.
 * 2. URL-encoded brackets in URLs: `[https://...%5D]` patterns
 * 3. Redundant Re:/回复: prefixes in quoted 主題/Subject lines
 *
 * Applied once at InboundAdapter boundary so all downstream consumers
 * (storage, prompt builder, reply tool) get clean data.
 */
export function cleanEmailBody(text: string): string {
  let cleaned = text;

  // Step 1: Join bracket continuation lines.
  // When a line has unbalanced [ and the NEXT line starts with [ (after > prefix),
  // that next line is a bracket continuation — join it to the current line.
  // This is safe because real content lines never start with [.
  cleaned = joinBracketContinuations(cleaned);

  // Step 2: Remove all [...] blocks line by line. Work from inside out.
  // After joining, brackets that previously spanned lines are now on single lines.
  cleaned = cleaned
    .split('\n')
    .map(line => {
      let result = line;

      // Remove all balanced [...] blocks from inside out
      let prev = '';
      while (prev !== result) {
        prev = result;
        result = result.replace(/\s*\[[^\[\]]*\]/g, '');
      }

      // Remove orphaned [ before email addresses/URLs (from unbalanced brackets)
      result = result.replace(/\s*\[(?=[A-Za-z0-9._%+\-]+@|https?:\/\/)/g, ' ');

      // Remove orphaned ] at start of line or after whitespace
      result = result.replace(/^\s*\]\s*/g, '');
      result = result.replace(/\s+\]\s*/g, ' ');

      // Clean 主題/Subject lines: normalize to single Re:
      result = result.replace(/((?:^|\s)(?:>\s*)*)(主题[:：]\s*|Subject[:：]\s*)((?:Re[:：]\s*|回复[:：]\s*|Fwd?[:：]\s*|转发[:：]\s*)*)(.*)/gi,
        (_match, prefix, label, _prefixes, subject) => {
          const cleanSubject = stripReplyPrefix(subject);
          return `${prefix}${label}Re: ${cleanSubject}`;
        }
      );

      return result;
    })
    .join('\n');

  // Step 3: Remove lines that became empty after cleanup (just whitespace or quote prefix)
  cleaned = cleaned.replace(/^(>\s*)+$/gm, '>');
  // Clean up excessive whitespace
  cleaned = cleaned.replace(/ {2,}/g, ' ');

  return cleaned;
}

/**
 * Join bracket continuation lines into the preceding line.
 *
 * When a line ends with unbalanced brackets and the next line starts with `[`
 * (after optional `> ` quote prefixes), that next line is a continuation of the
 * bracket expression — not real content. Join it to the current line.
 *
 * This is safe because actual content lines never start with `[` in email bodies.
 */
function joinBracketContinuations(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let current = lines[i]!;

    // Keep joining next lines as long as they start with [ (after quote prefix)
    while (i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      // Strip quote prefix to check if the content starts with [
      const nextContent = nextLine.replace(/^(>\s*)*/, '').trim();
      if (nextContent.startsWith('[')) {
        // It's a bracket continuation — join it
        current += ' ' + nextContent;
        i++;
      } else {
        break;
      }
    }

    result.push(current);
  }

  return result.join('\n');
}
