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

export interface OutputConfig {
  format: OutputFormat;
  includeHeaders: boolean;
  includeAttachments: boolean;
  truncateLength?: number;
}

export interface WorkspaceConfig {
  folder: string;
}

export interface ThreadSession {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  emailCount: number;
}

export interface OpenCodeConfig {
  enabled: boolean;
  hostname?: string;
  provider?: string;
  model?: string;
  smallModel?: string;
  systemPrompt?: string;
  includeThreadHistory?: boolean;
  contextSecret?: string;
}

export interface AttachmentConfig {
  enabled: boolean;
  maxFileSize: number | string;  // bytes or human-readable like "10mb"
  allowedExtensions: string[];  // default: .ppt, .pptx, .doc, .docx, .txt, .md
}

export interface InboundAttachmentConfig {
  enabled: boolean;
  allowedExtensions: string[];   // e.g. [".pdf", ".pptx", ".docx", ".xlsx", ".png", ".jpg"]
  maxFileSize: number | string;  // bytes or human-readable like "25mb"
  maxAttachmentsPerEmail: number; // default: 10
}

export interface ReplyConfig {
  enabled: boolean;
  mode: 'static' | 'opencode';
  text?: string;
  opencode?: OpenCodeConfig;
  attachments?: AttachmentConfig;  // NEW
}

export interface Config {
  imap: ImapConfig;
  smtp?: SmtpConfig;
  watch: WatchConfig;
  patterns: Pattern[];
  output: OutputConfig;
  workspace: WorkspaceConfig;
  reply: ReplyConfig;
}

export type OutputFormat = 'text' | 'json';

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

export interface PatternMatch {
  patternName: string;
  matches: {
    sender?: {
      type: 'regex' | 'exact' | 'domain';
      value: string;
    };
    subject?: {
      prefix?: string;
      regex?: string;
    };
  };
}

export interface GeneratedFile {
  filename: string;
  url: string;
  mime: string;
  size?: number;
}

export interface AiGeneratedReply {
  text: string;
  attachments: GeneratedFile[];
  replySentByTool: boolean;
}

export interface MonitorOptions {
  configPath: string;
  once: boolean;
  noIdle: boolean;
}
