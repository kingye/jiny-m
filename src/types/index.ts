// ============================================================================
// Re-export channel types (canonical source)
// ============================================================================
import type {
  ChannelType as _ChannelType,
  InboundMessage as _InboundMessage,
  MessageContent as _MessageContent,
  MessageAttachment as _MessageAttachment,
  InboundAdapter as _InboundAdapter,
  InboundAdapterOptions as _InboundAdapterOptions,
  OutboundAdapter as _OutboundAdapter,
  ChannelPattern as _ChannelPattern,
  PatternMatch as _PatternMatch,
  AttachmentDownloadConfig as _AttachmentDownloadConfig,
  WorkerConfig as _WorkerConfig,
} from '../channels/types';

export type ChannelType = _ChannelType;
export type InboundMessage = _InboundMessage;
export type MessageContent = _MessageContent;
export type MessageAttachment = _MessageAttachment;
export type InboundAdapter = _InboundAdapter;
export type InboundAdapterOptions = _InboundAdapterOptions;
export type OutboundAdapter = _OutboundAdapter;
export type ChannelPattern = _ChannelPattern;
export type PatternMatch = _PatternMatch;
export type AttachmentDownloadConfig = _AttachmentDownloadConfig;
export type WorkerConfig = _WorkerConfig;

// ============================================================================
// Email-specific types (used internally by email channel adapter)
// ============================================================================

export interface ImapConfig {
  host: string;
  port?: number;
  username: string;
  password: string;
  tls: boolean;
  authTimeout?: number;
}

export interface SmtpConfig {
  host: string;
  port?: number;
  username: string;
  password: string;
  tls?: boolean;
}

export interface ReconnectConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

export interface WatchConfig {
  checkInterval: number;
  maxRetries: number;
  useIdle?: boolean;
  folder?: string;
  reconnect?: ReconnectConfig;
  maxNewEmailThreshold?: number;
  enableRecoveryMode?: boolean;
  disableConsistencyCheck?: boolean;
}

/** Email channel config (inbound IMAP + outbound SMTP + watch settings). */
export interface EmailChannelConfig {
  inbound: ImapConfig;
  outbound: SmtpConfig;
  watch?: WatchConfig;
}

/** Multi-mailbox: Named channel config with type, settings, and optional per-channel workspace. */
export interface ChannelConfig {
  type: 'email' | 'feishu' | string;
  inbound?: ImapConfig;
  outbound?: SmtpConfig;
  watch?: WatchConfig;
  patterns?: ChannelPattern[];
  workspace?: string;
  reply?: Partial<ReplyConfig>;
}

/**
 * Legacy pattern type (email-only, pre-channel-agnostic).
 * Kept for backward compatibility during config migration.
 * @deprecated Use ChannelPattern from channels/types.ts instead.
 */
export interface Pattern {
  name: string;
  sender?: SenderPattern;
  subject?: SubjectPattern;
  caseSensitive?: boolean;
  enabled?: boolean;
  inboundAttachments?: InboundAttachmentConfig;
}

export interface SenderPattern {
  regex?: string;
  exact?: string[];
  domain?: string[];
}

export interface SubjectPattern {
  prefix?: string[];
  regex?: string;
}

// ============================================================================
// Email internal types (used by IMAP/SMTP services and email parser)
// ============================================================================

export interface Email {
  id: string;
  uid: number;
  from: string;
  to: string[];
  subject: string;
  date: Date;
  body: EmailBody;
  headers: Record<string, string>;
  attachments?: Attachment[];
  matchedPattern?: string;
  threadId?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface EmailBody {
  text?: string;
  html?: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  disposition?: string;
  /** Binary content from mailparser (only present during processing, not serialized). */
  content?: Buffer;
  /** Path where inbound attachment was saved to disk (set after storage.saveAttachments()). */
  savedPath?: string;
}

// ============================================================================
// Output / Display
// ============================================================================

export interface OutputConfig {
  format: OutputFormat;
  includeHeaders: boolean;
  includeAttachments: boolean;
  truncateLength?: number;
}

export type OutputFormat = 'text' | 'json';

// ============================================================================
// Workspace / Storage
// ============================================================================

export interface WorkspaceConfig {
  folder: string;
}

// ============================================================================
// AI / OpenCode
// ============================================================================

export interface ThreadSession {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  emailCount: number;
}

export interface OpenCodeConfig {
  enabled: boolean;
  hostname?: string;
  model?: string;                   // "provider/model" format, e.g. "SiliconFlow/Pro/zai-org/GLM-4.7"
  smallModel?: string;              // "provider/model" format for lightweight tasks
  systemPrompt?: string;
  includeThreadHistory?: boolean;
  contextSecret?: string;
}

export interface AiGeneratedReply {
  text: string;
  attachments: GeneratedFile[];
  replySentByTool: boolean;
}

export interface GeneratedFile {
  filename: string;
  url: string;
  mime: string;
  size?: number;
}

// ============================================================================
// Reply / Attachment Config
// ============================================================================

export interface ReplyConfig {
  enabled: boolean;
  mode: 'static' | 'opencode';
  text?: string;
  opencode?: OpenCodeConfig;
  attachments?: AttachmentConfig;
}

export interface AttachmentConfig {
  enabled: boolean;
  maxFileSize: number | string;  // bytes or human-readable like "10mb"
  allowedExtensions: string[];
}

/**
 * @deprecated Use AttachmentDownloadConfig from channels/types.ts instead.
 */
export interface InboundAttachmentConfig {
  enabled: boolean;
  allowedExtensions: string[];
  maxFileSize: number | string;
  maxAttachmentsPerEmail: number;
}

// ============================================================================
// Alerting
// ============================================================================

/** Configuration for error alerting via email. */
export interface AlertingConfig {
  /** Whether alerting is enabled. */
  enabled: boolean;
  /** Email address to send alerts to. */
  recipient: string;
  /** How often to flush buffered errors (in minutes, default: 5). */
  batchIntervalMinutes?: number;
  /** Maximum errors to include in a single alert email (default: 50). */
  maxErrorsPerBatch?: number;
  /** Subject prefix for alert emails (default: "Jiny-M Alert"). */
  subjectPrefix?: string;
  /** Whether to include reply-tool.log content in alerts (default: true). */
  includeReplyToolLog?: boolean;
  /** Number of lines to tail from reply-tool.log (default: 50). */
  replyToolLogTailLines?: number;
  /** Periodic health check email configuration. */
  healthCheck?: HealthCheckConfig;
}

/** Configuration for periodic health check reports. */
export interface HealthCheckConfig {
  /** Whether health check is enabled (default: false). */
  enabled: boolean;
  /** How often to send health reports (in hours, default: 24). */
  intervalHours?: number;
  /** Recipient override (defaults to alerting.recipient). */
  recipient?: string;
}

// ============================================================================
// Top-level Config
// ============================================================================

/**
 * Channel-agnostic config structure.
 */
export interface Config {
  /** Named channel configurations (e.g., work, personal). Each has its own IMAP/SMTP/patterns/workspace. */
  channels?: Record<string, ChannelConfig>;
  /** Unified pattern list with channel-specific rules. */
  patterns: (ChannelPattern | Pattern)[];
  /** Worker pool settings. */
  worker?: WorkerConfig;
  /** Reply generation settings (global default). */
  reply: ReplyConfig;
  /** Error alerting settings. */
  alerting?: AlertingConfig;
  /** Output formatting. */
  output?: OutputConfig;
  /** @internal Legacy fields used during config migration. */
  imap?: ImapConfig;
  smtp?: SmtpConfig;
  watch?: WatchConfig;
}

// ============================================================================
// Monitor / CLI
// ============================================================================

export interface MonitorOptions {
  configPath: string;
  once: boolean;
  noIdle: boolean;
}
