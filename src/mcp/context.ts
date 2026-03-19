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
  /** Filename of the stored incoming email in .jiny/ (e.g. "2026-03-19_21-07-06_Jiny_xxx.md").
   *  The MCP reply tool reads this file for the full quoted history. */
  incomingFileName?: string;
  uid: number;
}

/**
 * Serialize an Email + threadName into a JSON string for the <reply_context> block.
 *
 * The bodyText is stripped and truncated — it's embedded in the AI prompt for display only.
 * The full email body is NOT included here; instead incomingFileName points to the
 * stored .jiny/*.md file that the MCP reply tool reads for quoted history.
 */
export function serializeContext(
  email: Email,
  threadName: string,
  incomingFileName?: string,
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
    incomingFileName,
    uid: email.uid,
  };

  return JSON.stringify(context);
}

/**
 * Deserialize a context JSON string and validate required fields.
 */
export function deserializeAndValidateContext(contextJson: string): EmailReplyContext {
  let context: EmailReplyContext;

  try {
    context = JSON.parse(contextJson);
  } catch {
    throw new Error('Invalid context JSON: failed to parse');
  }

  if (!context.threadName || !context.to || !context.from || !context.subject) {
    throw new Error('Invalid context: missing required fields (threadName, to, from, subject)');
  }

  return context;
}

/**
 * Reconstruct an Email object from an EmailReplyContext.
 * Used by the MCP tool to pass to SmtpService.replyToEmail().
 *
 * Note: body.text here is the stripped/truncated version from the context.
 * The MCP reply tool should replace it with the full body read from
 * .jiny/<incomingFileName> before calling replyToEmail().
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
