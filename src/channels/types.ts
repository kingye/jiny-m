/**
 * Core channel abstractions for the channel-agnostic architecture.
 *
 * These types define the contract between inbound/outbound channel adapters
 * and the rest of the system (MessageRouter, ThreadManager, Worker, MCP tool).
 */

// ============================================================================
// Channel Type
// ============================================================================

export type ChannelType = 'email' | 'feishu' | 'slack' | (string & {});

// ============================================================================
// Inbound Message (channel-agnostic)
// ============================================================================

/**
 * A normalized message from any inbound channel.
 * Channel-specific details are stored in `metadata`.
 */
export interface InboundMessage {
  /** Internal unique ID (generated at receive time). */
  id: string;
  /** Which channel this message came from. */
  channel: ChannelType;
  /** Channel-specific unique ID (email UID, feishu msg ID, etc.). */
  channelUid: string;
  /** Sender display name (e.g. "King Ye"). */
  sender: string;
  /** Sender canonical address (e.g. "kingye@petalmail.com", feishu user ID). */
  senderAddress: string;
  /** Recipient addresses/IDs. */
  recipients: string[];
  /** Topic / subject / title of the conversation. */
  topic: string;
  /** Message content in various formats. */
  content: MessageContent;
  /** When the message was sent/received. */
  timestamp: Date;
  /** Thread reference IDs (email: References header; feishu: thread ID). */
  threadRefs?: string[];
  /** ID of the message being replied to (email: In-Reply-To; feishu: parent msg). */
  replyToId?: string;
  /** External message ID (email: Message-ID; feishu: message ID). */
  externalId?: string;
  /** Attachments with optional binary content. */
  attachments?: MessageAttachment[];
  /** Channel-specific metadata (email headers, feishu chat_id, etc.). */
  metadata: Record<string, any>;
  /** Name of the matched pattern (set after pattern matching). */
  matchedPattern?: string;
}

/**
 * Message content in one or more formats.
 * At least one of text/html/markdown should be present.
 */
export interface MessageContent {
  /** Plain text content. */
  text?: string;
  /** HTML content (primarily email). */
  html?: string;
  /** Markdown content (feishu, slack). */
  markdown?: string;
}

/**
 * An attachment on an inbound message.
 */
export interface MessageAttachment {
  /** Original filename. */
  filename: string;
  /** MIME content type (e.g. "application/pdf"). */
  contentType: string;
  /** Size in bytes. */
  size: number;
  /** Binary content buffer (present during processing, cleared after saving). */
  content?: Buffer;
  /** Path where the attachment was saved to disk (set after storage). */
  savedPath?: string;
}

// ============================================================================
// Channel Adapters
// ============================================================================

/**
 * Inbound adapter — receives messages from a channel and delivers them
 * to the MessageRouter via the onMessage callback.
 *
 * Each adapter also implements channel-specific pattern matching and
 * thread name derivation.
 */
export interface InboundAdapter {
  /** Channel type this adapter handles (e.g., 'email'). */
  readonly channelType: ChannelType;
  /** Channel name (e.g., 'work', 'personal', '283a'). Used as unique identifier. */
  readonly channelName: string;

  /**
   * Derive a thread name from a message using channel-specific logic.
   * For email: strip reply prefixes + configured subject prefix.
   * For feishu: derive from group name or topic.
   */
  deriveThreadName(message: InboundMessage, patternMatch?: PatternMatch): string;

  /**
   * Match a message against channel-specific patterns.
   * Returns the first matching pattern or null.
   */
  matchMessage(message: InboundMessage, patterns: ChannelPattern[]): PatternMatch | null;

  /**
   * Start listening for messages.
   * Calls onMessage for ALL received messages (router handles filtering).
   */
  start(options: InboundAdapterOptions): Promise<void>;

  /** Stop listening and clean up resources. */
  stop(): Promise<void>;
}

/**
 * Options passed to InboundAdapter.start().
 */
export interface InboundAdapterOptions {
  /** Called for each received message (fire-and-forget from adapter's perspective). */
  onMessage: (message: InboundMessage) => Promise<void>;
  /** Called when an error occurs in the adapter. */
  onError: (error: Error) => void;
}

/**
 * Outbound adapter — sends replies back through a channel.
 */
export interface OutboundAdapter {
  /** Channel type this adapter handles (e.g., 'email'). */
  readonly channelType: ChannelType;
  /** Channel name (e.g., 'work', 'personal', '283a'). Used as unique identifier. */
  readonly channelName: string;

  /** Connect to the outbound service. */
  connect(): Promise<void>;
  /** Disconnect and clean up. */
  disconnect(): Promise<void>;

  /**
   * Send a reply to the original message through this channel.
   * Returns the external message ID of the sent reply.
   */
  sendReply(
    originalMessage: InboundMessage,
    replyText: string,
    attachments?: Array<{ filename: string; path: string; contentType: string }>,
  ): Promise<{ messageId: string }>;

  /**
   * Send a fresh (non-reply) alert/notification through this channel.
   * Optional — not all channels may support this.
   * Returns the external message ID of the sent message.
   */
  sendAlert?(
    recipient: string,
    subject: string,
    body: string,
  ): Promise<{ messageId: string }>;
}

// ============================================================================
// Pattern Matching
// ============================================================================

/**
 * A pattern configuration for matching inbound messages.
 * Each pattern is channel-specific — the `rules` object contains
 * channel-specific matching criteria.
 */
export interface ChannelPattern {
  /** Pattern name (used for logging and storage). */
  name: string;
  /** Which channel this pattern applies to. */
  channel: ChannelType;
  /** Whether this pattern is active. */
  enabled?: boolean;
  /**
   * Channel-specific matching rules.
   *
   * For email:
   *   { sender?: { exact?: string[], domain?: string[], regex?: string },
   *     subject?: { prefix?: string[], regex?: string } }
   *
   * For feishu (future):
   *   { sender?: { exact?: string[] }, groupId?: string[] }
   */
  rules: Record<string, any>;
  /** Inbound attachment download config for messages matching this pattern. */
  attachments?: AttachmentDownloadConfig;
}

/**
 * Result of a successful pattern match.
 */
export interface PatternMatch {
  /** Name of the matched pattern. */
  patternName: string;
  /** Channel type of the matched pattern. */
  channel: ChannelType;
  /** Channel-specific match details (e.g. which sender/subject rule matched). */
  matches: Record<string, any>;
}

// ============================================================================
// Attachment Config
// ============================================================================

/**
 * Configuration for downloading inbound attachments.
 * Scoped per-pattern so different patterns can have different rules.
 */
export interface AttachmentDownloadConfig {
  /** Whether to download inbound attachments. */
  enabled: boolean;
  /** Allowed file extensions (e.g. [".pdf", ".pptx"]). Only these are saved. */
  allowedExtensions: string[];
  /** Max file size per attachment (bytes or human-readable like "25mb"). */
  maxFileSize: number | string;
  /** Max number of attachments to save per message (default: 10). */
  maxAttachmentsPerMessage: number;
}

// ============================================================================
// Worker Config
// ============================================================================

/**
 * Configuration for the thread manager's worker pool.
 */
export interface WorkerConfig {
  /** Max number of threads processing in parallel (default: 3). */
  maxConcurrentThreads: number;
  /** Max messages queued per thread before dropping (default: 10). */
  maxQueueSizePerThread: number;
}
