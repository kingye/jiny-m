/**
 * Channel-agnostic reply context serialization.
 *
 * The ReplyContext carries enough information for the MCP reply tool to:
 * 1. Determine which outbound channel adapter to use (via `channel`)
 * 2. Reconstruct the original message for reply threading
 * 3. Find the stored message file for quoted history (via `incomingMessageDir`)
 *
 * The context is embedded in the AI prompt as <reply_context>JSON</reply_context>.
 * The AI must pass it verbatim to the reply_message tool.
 */

import type { InboundMessage, ChannelType } from '../channels/types';
import { stripQuotedHistory, truncateText } from '../core/email-parser';

/**
 * Channel-agnostic reply context.
 * Carries all information needed to send a reply back through the originating channel.
 */
export interface ReplyContext {
  /** Channel type — routing key for outbound adapter. */
  channel: ChannelType;
  /** Thread name (for logging/reference). */
  threadName: string;
  /** Who sent the original message. */
  sender: string;
  /** Who to reply to (channel-specific address). */
  recipient: string;
  /** Topic / subject / title. */
  topic: string;
  /** When the original message was sent (ISO string). */
  timestamp: string;
  /** Stripped/truncated body for AI display only. */
  contentPreview?: string;
  /** Per-message directory name under messages/ (for reading full body). */
  incomingMessageDir?: string;
  /** External message ID (email: Message-ID; feishu: msg_id). */
  externalId?: string;
  /** Thread reference IDs (email: References; feishu: thread_id). */
  threadRefs?: string[];
  /** Channel-specific unique ID (email UID, feishu msg ID). */
  uid: string;
  /**
   * Channel-specific metadata needed for reply construction.
   * Email: { messageId, references, inReplyTo, headers, from (original From header), fromName }
   * FeiShu: { chatId, messageType, ... }
   */
  channelMetadata?: Record<string, any>;
}

/**
 * Serialize an InboundMessage + threadName into a JSON string for the <reply_context> block.
 *
 * The contentPreview is stripped and truncated — it's in the AI prompt for display only.
 * The full message body is NOT included; incomingMessageDir points to the stored
 * messages/<dir>/received.md that the MCP reply tool reads for quoted history.
 */
export function serializeContext(
  message: InboundMessage,
  threadName: string,
  incomingMessageDir?: string,
): string {
  const MAX_BODY_IN_CONTEXT = 500;

  // Build content preview (stripped + truncated) for AI display
  let contentPreview = message.content.text || message.content.markdown;
  if (contentPreview) {
    contentPreview = stripQuotedHistory(contentPreview);
    if (contentPreview.length > MAX_BODY_IN_CONTEXT) {
      contentPreview = truncateText(contentPreview, MAX_BODY_IN_CONTEXT);
    }
  }
  if (!contentPreview && message.content.html) {
    contentPreview = truncateText(message.content.html, MAX_BODY_IN_CONTEXT);
  }

  // Determine recipient (who to reply to)
  // For email: use reply-to header if present, otherwise sender address
  const recipient = message.metadata?.headers?.['reply-to'] || message.senderAddress || message.sender;

  const context: ReplyContext = {
    channel: message.channel,
    threadName,
    sender: message.sender,
    recipient,
    topic: message.topic,
    timestamp: message.timestamp.toISOString(),
    contentPreview,
    incomingMessageDir,
    externalId: message.externalId,
    threadRefs: message.threadRefs,
    uid: message.channelUid,
    channelMetadata: {
      // Preserve channel-specific data needed for reply construction
      ...message.metadata,
      // Ensure key email fields are always present for email channel
      ...(message.channel === 'email' ? {
        messageId: message.externalId,
        references: message.threadRefs,
        inReplyTo: message.replyToId,
        from: message.metadata?.from || message.senderAddress,
        fromName: message.sender,
      } : {}),
    },
  };

  return JSON.stringify(context);
}

/**
 * Deserialize a context JSON string and validate required fields.
 * Includes JSON sanitization for common AI-generated corruption.
 */
export function deserializeAndValidateContext(contextJson: string): ReplyContext {
  let context: ReplyContext;

  // First attempt: parse as-is
  try {
    context = JSON.parse(contextJson);
  } catch (firstError) {
    // Second attempt: sanitize common AI-generated JSON issues
    try {
      const sanitized = sanitizeContextJson(contextJson);
      context = JSON.parse(sanitized);
    } catch {
      const preview = contextJson?.substring(0, 300) || '(empty)';
      throw new Error(`Invalid context JSON: failed to parse. Preview: ${preview}`);
    }
  }

  // Required fields
  if (!context.threadName || !context.recipient || !context.sender || !context.topic) {
    const missing = ['threadName', 'recipient', 'sender', 'topic'].filter(f => !(context as any)[f]);
    throw new Error(`Invalid context: missing required fields: ${missing.join(', ')}`);
  }

  // Default channel to "email" for backward compatibility
  if (!context.channel) {
    context.channel = 'email';
  }

  return context;
}

/**
 * Reconstruct an InboundMessage from a ReplyContext.
 * Used by the MCP reply tool to pass to OutboundAdapter.sendReply().
 *
 * Note: content.text is the stripped/truncated preview from the context.
 * The MCP reply tool should replace it with the full body read from
 * messages/<incomingMessageDir>/received.md before sending.
 */
export function contextToInboundMessage(context: ReplyContext): InboundMessage {
  return {
    id: `ctx-${context.uid}`,
    channel: context.channel,
    channelUid: context.uid,
    sender: context.sender,
    senderAddress: context.channelMetadata?.from || context.sender,
    recipients: [context.recipient],
    topic: context.topic,
    content: {
      text: context.contentPreview,
    },
    timestamp: new Date(context.timestamp),
    threadRefs: context.threadRefs,
    replyToId: context.channelMetadata?.inReplyTo,
    externalId: context.externalId,
    metadata: context.channelMetadata || {},
  };
}

/**
 * Sanitize common AI-generated JSON issues.
 */
function sanitizeContextJson(json: string): string {
  let sanitized = json;

  // Strip <reply_context>...</reply_context> wrapper tags if the AI included them
  sanitized = sanitized.replace(/^[\s]*<reply_context>\s*/i, '');
  sanitized = sanitized.replace(/\s*<\/reply_context>[\s]*$/i, '');

  // Fix smart quotes
  sanitized = sanitized
    .replace(/\u201C/g, '\\"')  // " left double quotation mark
    .replace(/\u201D/g, '\\"')  // " right double quotation mark
    .replace(/\u201E/g, '\\"')  // „ double low-9 quotation mark
    .replace(/\u00AB/g, '\\"')  // « left-pointing double angle
    .replace(/\u00BB/g, '\\"'); // » right-pointing double angle

  try {
    sanitized = sanitized.replace(/,\s*([}\]])/g, '$1');
    return sanitized;
  } catch {
    return sanitized;
  }
}
