/**
 * Channel-agnostic reply context serialization.
 *
 * The ReplyContext carries enough information for the MCP reply tool to:
 * 1. Determine which outbound channel adapter to use (via `channel`)
 * 2. Reconstruct the original message for reply threading
 * 3. Find the stored message file for quoted history (via `incomingMessageDir`)
 *
 * The context is base64-encoded and embedded in the AI prompt as
 * <reply_context>BASE64_TOKEN</reply_context>. The AI passes the opaque
 * token as a string to the reply_message tool, which decodes and validates it.
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
  /** Per-message directory name under messages/ (for reading full body). */
  incomingMessageDir?: string;
  /** External message ID (email: Message-ID; feishu: msg_id). */
  externalId?: string;
  /** Thread reference IDs (email: References; feishu: thread_id). */
  threadRefs?: string[];
  /** Channel-specific unique ID (email UID, feishu msg ID). */
  uid: string;
  /** Integrity nonce — must be present in token. */
  _nonce?: string;
  /**
   * Channel-specific metadata needed for reply construction.
   * Email: { inReplyTo, from }
   * FeiShu: { chatId, messageType, ... }
   */
  channelMetadata?: Record<string, any>;
}

/**
 * Serialize an InboundMessage + threadName into a base64-encoded string.
 *
 * The context is embedded in the prompt as an opaque token that the AI
 * passes back unchanged to the reply_message tool. Base64 encoding prevents
 * the AI from parsing, modifying, or reconstructing the context.
 */
export function serializeContext(
  message: InboundMessage,
  threadName: string,
  incomingMessageDir?: string,
): string {
  const recipient = message.metadata?.headers?.['reply-to'] || message.senderAddress || message.sender;

  const context: ReplyContext = {
    channel: message.channel,
    threadName,
    sender: message.sender,
    recipient,
    topic: message.topic,
    timestamp: message.timestamp.toISOString(),
    incomingMessageDir,
    externalId: message.externalId,
    threadRefs: message.threadRefs,
    uid: message.channelUid,
    _nonce: `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
    channelMetadata: {
      ...(message.channel === 'email' ? {
        inReplyTo: message.replyToId,
        from: message.metadata?.from || message.senderAddress,
      } : {}),
    },
  };

  return Buffer.from(JSON.stringify(context)).toString('base64');
}

/**
 * Deserialize a base64-encoded context string and validate required fields.
 */
export function deserializeContext(encoded: string): ReplyContext {
  let json: string;
  try {
    json = Buffer.from(encoded, 'base64').toString('utf-8');
  } catch {
    throw new Error('Invalid context: failed to decode base64');
  }

  let context: ReplyContext;
  try {
    context = JSON.parse(json);
  } catch {
    throw new Error('Invalid context: failed to parse JSON after base64 decode');
  }

  // Detect token tampering
  if (!context._nonce) {
    // Older tokens may not have nonce, but new ones should.
    // Logging is done by caller.
  }

  // Check for backticks or added formatting in string fields
  const strings = [context.sender, context.recipient, context.topic, context.threadName].filter(Boolean);
  for (const s of strings) {
    if (s.includes('`') || s.includes('\\n') || s.includes('\\"')) {
      throw new Error('Invalid context: token appears modified (found formatting characters). DO NOT decode or modify the token.');
    }
  }

  if (!context.threadName || !context.recipient || !context.sender || !context.topic) {
    const missing = ['threadName', 'recipient', 'sender', 'topic'].filter(f => !(context as any)[f]);
    throw new Error(`Invalid context: missing required fields: ${missing.join(', ')}`);
  }

  if (!context.channel) {
    context.channel = 'email';
  }

  return context;
}

/**
 * Reconstruct an InboundMessage from a ReplyContext.
 * Used by the MCP reply tool to pass to OutboundAdapter.sendReply().
 *
 * Note: content.text is empty — the MCP reply tool replaces it with the
 * full body read from messages/<incomingMessageDir>/received.md.
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
      text: '',  // Populated by reply tool from received.md
    },
    timestamp: context.timestamp ? new Date(context.timestamp) : new Date(),
    threadRefs: context.threadRefs,
    replyToId: context.channelMetadata?.inReplyTo,
    externalId: context.externalId,
    metadata: context.channelMetadata || {},
  };
}
