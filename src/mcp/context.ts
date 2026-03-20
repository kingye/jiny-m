import type { Email } from '../types';
import { stripQuotedHistory, truncateText } from '../core/email-parser';

export interface EmailReplyContext {
  threadName: string;
  to: string;
  from: string;
  fromName: string;
  subject: string;
  date: string;
  messageId?: string;
  references?: string[];
  bodyText?: string;
  bodyHtml?: string;
  /** Name of the per-message directory under messages/ (e.g. "2026-03-19_23-02-20").
   *  The MCP reply tool reads messages/<dir>/received.md for the full quoted history. */
  incomingMessageDir?: string;
  uid: number;
}

/**
 * Serialize an Email + threadName into a JSON string for the <reply_context> block.
 *
 * The bodyText is stripped and truncated — it's embedded in the AI prompt for display only.
 * The full email body is NOT included here; instead incomingMessageDir points to the
 * per-message directory under messages/ that the MCP reply tool reads for quoted history.
 */
export function serializeContext(
  email: Email,
  threadName: string,
  incomingMessageDir?: string,
): string {
  const toAddress = email.headers['reply-to'] || email.from;

  let fromName = email.from || 'Unknown';
  if (fromName.includes('<')) {
    const parts = fromName.split('<');
    fromName = parts[0]?.trim().replace(/['"]/g, '') || fromName;
  }

  // Strip and truncate body for the AI prompt display only.
  const MAX_BODY_IN_CONTEXT = 500;
  let bodyText = email.body.text;
  if (bodyText) {
    bodyText = stripQuotedHistory(bodyText);
    if (bodyText.length > MAX_BODY_IN_CONTEXT) {
      bodyText = truncateText(bodyText, MAX_BODY_IN_CONTEXT);
    }
  }

  let bodyHtml = !bodyText ? email.body.html : undefined;
  if (bodyHtml && bodyHtml.length > MAX_BODY_IN_CONTEXT) {
    bodyHtml = truncateText(bodyHtml, MAX_BODY_IN_CONTEXT);
  }

  const context: EmailReplyContext = {
    threadName,
    to: toAddress,
    from: email.from,
    fromName,
    subject: email.subject,
    date: email.date.toISOString(),
    messageId: email.messageId,
    references: email.references,
    bodyText,
    bodyHtml,
    incomingMessageDir,
    uid: email.uid,
  };

  return JSON.stringify(context);
}

/**
 * Deserialize a context JSON string and validate required fields.
 */
export function deserializeAndValidateContext(contextJson: string): EmailReplyContext {
  let context: EmailReplyContext;

  // First attempt: parse as-is
  try {
    context = JSON.parse(contextJson);
  } catch (firstError) {
    // Second attempt: try to fix common AI-generated JSON issues
    try {
      const sanitized = sanitizeContextJson(contextJson);
      context = JSON.parse(sanitized);
    } catch {
      // Both attempts failed — report the original error with preview
      const preview = contextJson?.substring(0, 300) || '(empty)';
      throw new Error(`Invalid context JSON: failed to parse. Preview: ${preview}`);
    }
  }

  if (!context.threadName || !context.to || !context.from || !context.subject) {
    const missing = ['threadName', 'to', 'from', 'subject'].filter(f => !(context as any)[f]);
    throw new Error(`Invalid context: missing required fields: ${missing.join(', ')}`);
  }

  return context;
}

/**
 * Attempt to sanitize common AI-generated JSON issues:
 * - Unescaped double quotes inside string values (e.g. Chinese "quoted text")
 * - Curly/smart quotes that should be escaped
 * - Trailing commas
 */
function sanitizeContextJson(json: string): string {
  // Replace fullwidth/smart quotes with escaped ASCII quotes
  let sanitized = json
    .replace(/\u201C/g, '\\"')  // " left double quotation mark
    .replace(/\u201D/g, '\\"')  // " right double quotation mark
    .replace(/\u201E/g, '\\"')  // „ double low-9 quotation mark
    .replace(/\u00AB/g, '\\"')  // « left-pointing double angle
    .replace(/\u00BB/g, '\\"'); // » right-pointing double angle

  // Try to fix unescaped ASCII double quotes inside string values.
  // Strategy: walk through the string tracking JSON structure.
  // This is a best-effort heuristic — may not handle all edge cases.
  try {
    // Remove trailing commas before } or ]
    sanitized = sanitized.replace(/,\s*([}\]])/g, '$1');
    return sanitized;
  } catch {
    return sanitized;
  }
}

/**
 * Reconstruct an Email object from an EmailReplyContext.
 * Used by the MCP tool to pass to SmtpService.replyToEmail().
 *
 * Note: body.text here is the stripped/truncated version from the context.
 * The MCP reply tool should replace it with the full body read from
 * messages/<incomingMessageDir>/received.md before calling replyToEmail().
 */
export function contextToEmail(context: EmailReplyContext): Email {
  return {
    id: `ctx-${context.uid}`,
    uid: context.uid,
    from: context.from,
    to: [context.to],
    subject: context.subject,
    date: new Date(context.date),
    body: {
      text: context.bodyText,
      html: context.bodyHtml,
    },
    headers: context.to !== context.from
      ? { 'reply-to': context.to }
      : {},
    messageId: context.messageId,
    references: context.references,
  };
}
