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
    // contentPreview omitted — AI already sees the message body in the prompt
    incomingMessageDir,
    externalId: message.externalId,
    threadRefs: message.threadRefs,
    uid: message.channelUid,
    // Minimal channelMetadata — only fields not already top-level
    channelMetadata: {
      ...(message.channel === 'email' ? {
        inReplyTo: message.replyToId,
        from: message.metadata?.from || message.senderAddress,
      } : {}),
    },
  };

  return JSON.stringify(context);
}

/**
 * Validate a context object (already parsed) and return a typed ReplyContext.
 * Used when the AI passes context as a JSON object via MCP tool calling.
 */
export function validateContext(context: Record<string, any>): ReplyContext {
  if (!context.threadName || !context.recipient || !context.sender || !context.topic) {
    const missing = ['threadName', 'recipient', 'sender', 'topic'].filter(f => !context[f]);
    throw new Error(`Invalid context: missing required fields: ${missing.join(', ')}`);
  }

  if (!context.channel) {
    context.channel = 'email';
  }

  return context as ReplyContext;
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
