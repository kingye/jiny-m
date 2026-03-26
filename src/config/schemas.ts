import type { Config, Pattern, ImapConfig, SmtpConfig, WatchConfig, OutputConfig, WorkspaceConfig, ReplyConfig, OpenCodeConfig, InboundAttachmentConfig, ChannelPattern, AlertingConfig, HealthCheckConfig, ChannelConfig } from '../types';
import { validateRegex, extractDomain, parseFileSize } from '../utils/helpers';

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export function validateImapConfig(config: any): ImapConfig {
  if (!config) {
    throw new ConfigValidationError('IMAP configuration is required');
  }
  if (!config.host || typeof config.host !== 'string') {
    throw new ConfigValidationError('IMAP host is required and must be a string');
  }
  if (config.port !== undefined && (typeof config.port !== 'number' || config.port < 1 || config.port > 65535)) {
    throw new ConfigValidationError('IMAP port must be a valid port number (1-65535)');
  }
  if (!config.username || typeof config.username !== 'string') {
    throw new ConfigValidationError('IMAP username is required and must be a string');
  }
  if (!config.password || typeof config.password !== 'string') {
    throw new ConfigValidationError('IMAP password is required and must be a string');
  }
  if (config.tls !== undefined && typeof config.tls !== 'boolean') {
    throw new ConfigValidationError('IMAP tls must be a boolean');
  }
  
  return {
    host: config.host,
    port: config.port ?? 993,
    username: config.username,
    password: config.password,
    tls: config.tls ?? true,
    authTimeout: config.authTimeout,
  };
}

export function validateSmtpConfig(config: any): SmtpConfig | undefined {
  if (!config) return undefined;
  
  if (!config.host || typeof config.host !== 'string') {
    throw new ConfigValidationError('SMTP host is required and must be a string');
  }
  if (config.port !== undefined && (typeof config.port !== 'number' || config.port < 1 || config.port > 65535)) {
    throw new ConfigValidationError('SMTP port must be a valid port number (1-65535)');
  }
  if (!config.username || typeof config.username !== 'string') {
    throw new ConfigValidationError('SMTP username is required and must be a string');
  }
  if (!config.password || typeof config.password !== 'string') {
    throw new ConfigValidationError('SMTP password is required and must be a string');
  }
  
  return {
    host: config.host,
    port: config.port ?? 587,
    username: config.username,
    password: config.password,
    tls: config.tls ?? true,
  };
}

export function validateWatchConfig(config: any): WatchConfig {
  if (!config) {
    throw new ConfigValidationError('Watch configuration is required');
  }
  if (!config.checkInterval || typeof config.checkInterval !== 'number' || config.checkInterval < 1) {
    throw new ConfigValidationError('Watch checkInterval is required and must be a positive number');
  }
  if (!config.maxRetries || typeof config.maxRetries !== 'number' || config.maxRetries < 0) {
    throw new ConfigValidationError('Watch maxRetries is required and must be a non-negative number');
  }
  
  return {
    checkInterval: config.checkInterval,
    maxRetries: config.maxRetries,
    useIdle: config.useIdle ?? true,
    folder: config.folder ?? 'INBOX',
  };
}

export function validateOutputConfig(config: any): OutputConfig {
  if (!config) {
    throw new ConfigValidationError('Output configuration is required');
  }
  if (config.format && !['text', 'json'].includes(config.format)) {
    throw new ConfigValidationError('Output format must be "text" or "json"');
  }
  if (config.includeHeaders !== undefined && typeof config.includeHeaders !== 'boolean') {
    throw new ConfigValidationError('Output includeHeaders must be a boolean');
  }
  if (config.includeAttachments !== undefined && typeof config.includeAttachments !== 'boolean') {
    throw new ConfigValidationError('Output includeAttachments must be a boolean');
  }
  
  return {
    format: config.format ?? 'text',
    includeHeaders: config.includeHeaders ?? true,
    includeAttachments: config.includeAttachments ?? false,
    truncateLength: config.truncateLength,
  };
}

export function validatePattern(pattern: any): Pattern {
  if (!pattern) {
    throw new ConfigValidationError('Pattern is required');
  }
  if (!pattern.name || typeof pattern.name !== 'string') {
    throw new ConfigValidationError('Pattern name is required and must be a string');
  }
  
  const validatedPattern: Pattern = {
    name: pattern.name,
    enabled: pattern.enabled !== undefined ? pattern.enabled : true,
    caseSensitive: pattern.caseSensitive ?? false,
  };
  
  if (pattern.sender) {
    validatedPattern.sender = validateSenderPattern(pattern.sender);
  }
  
  if (pattern.subject) {
    validatedPattern.subject = validateSubjectPattern(pattern.subject);
  }
  
  if (!validatedPattern.sender && !validatedPattern.subject) {
    throw new ConfigValidationError(`Pattern "${pattern.name}" must have at least sender or subject rules`);
  }
  
  if (pattern.inboundAttachments) {
    validatedPattern.inboundAttachments = validateInboundAttachmentConfig(pattern.inboundAttachments);
  }
  
  return validatedPattern;
}

function validateSenderPattern(pattern: any): Pattern['sender'] {
  if (!pattern) return undefined;
  
  if (pattern.regex && !validateRegex(pattern.regex)) {
    throw new ConfigValidationError(`Invalid sender regex: ${pattern.regex}`);
  }
  
  if (pattern.exact && !Array.isArray(pattern.exact)) {
    throw new ConfigValidationError('Sender exact must be an array');
  }
  
  if (pattern.domain && !Array.isArray(pattern.domain)) {
    throw new ConfigValidationError('Sender domain must be an array');
  }
  
  if (pattern.domain) {
    for (const domain of pattern.domain) {
      if (!domain || typeof domain !== 'string') {
        throw new ConfigValidationError(`Invalid domain in sender pattern: ${domain}`);
      }
    }
  }
  
  return pattern;
}

function validateSubjectPattern(pattern: any): Pattern['subject'] {
  if (!pattern) return undefined;
  
  if (pattern.regex && !validateRegex(pattern.regex)) {
    throw new ConfigValidationError(`Invalid subject regex: ${pattern.regex}`);
  }

  if (pattern.prefix && !Array.isArray(pattern.prefix)) {
    throw new ConfigValidationError('Subject prefix must be an array');
  }

  if (pattern.prefix) {
    for (const pref of pattern.prefix) {
      if (!pref || typeof pref !== 'string') {
        throw new ConfigValidationError(`Invalid prefix value in subject pattern: ${pref}`);
      }
    }
  }
  
  // Remove exact and contains if present (deprecated)
  const { exact, contains, ...validated } = pattern;
  
  return validated;
}

function validateInboundAttachmentConfig(config: any): InboundAttachmentConfig & { maxAttachmentsPerMessage: number } {
  if (typeof config !== 'object' || config === null) {
    throw new ConfigValidationError('attachments config must be an object');
  }

  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new ConfigValidationError('attachments.enabled must be a boolean');
  }

  if (config.allowedExtensions !== undefined) {
    if (!Array.isArray(config.allowedExtensions)) {
      throw new ConfigValidationError('attachments.allowedExtensions must be an array');
    }
    for (const ext of config.allowedExtensions) {
      if (typeof ext !== 'string' || !ext.startsWith('.')) {
        throw new ConfigValidationError(`Invalid extension in attachments: "${ext}" (must start with ".")`);
      }
    }
  }

  if (config.maxFileSize !== undefined) {
    try {
      parseFileSize(config.maxFileSize);
    } catch (e) {
      throw new ConfigValidationError(`attachments.maxFileSize: ${(e as Error).message}`);
    }
  }

  // Support both old field name (maxAttachmentsPerEmail) and new (maxAttachmentsPerMessage)
  const maxCount = config.maxAttachmentsPerMessage ?? config.maxAttachmentsPerEmail ?? 10;
  if (typeof maxCount !== 'number' || maxCount < 1) {
    throw new ConfigValidationError('attachments.maxAttachmentsPerMessage must be a positive number');
  }

  return {
    enabled: config.enabled ?? false,
    allowedExtensions: config.allowedExtensions || ['.pdf', '.pptx', '.docx', '.xlsx', '.png', '.jpg', '.txt', '.md'],
    maxFileSize: config.maxFileSize ?? '25mb',
    maxAttachmentsPerEmail: maxCount,
    maxAttachmentsPerMessage: maxCount,
  };
}

export function validateWorkspaceConfig(config: any): WorkspaceConfig {
  if (!config) {
    return { folder: './workspace' };
  }
  if (config.folder !== undefined && typeof config.folder !== 'string') {
    throw new ConfigValidationError('Workspace folder must be a string');
  }

  return {
    folder: config.folder ?? './workspace',
  };
}

export function validateOpenCodeConfig(config: any): OpenCodeConfig | undefined {
  if (!config) return undefined;
  
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new ConfigValidationError('OpenCode enabled must be a boolean');
  }
  
  if (config.hostname !== undefined && typeof config.hostname !== 'string') {
    throw new ConfigValidationError('OpenCode hostname must be a string');
  }
  if (config.model !== undefined && typeof config.model !== 'string') {
    throw new ConfigValidationError('OpenCode model must be a string');
  }
  if (config.smallModel !== undefined && typeof config.smallModel !== 'string') {
    throw new ConfigValidationError('OpenCode smallModel must be a string');
  }
  if (config.systemPrompt !== undefined && typeof config.systemPrompt !== 'string') {
    throw new ConfigValidationError('OpenCode systemPrompt must be a string');
  }
  if (config.includeThreadHistory !== undefined && typeof config.includeThreadHistory !== 'boolean') {
    throw new ConfigValidationError('OpenCode includeThreadHistory must be a boolean');
  }
  if (config.contextSecret !== undefined && typeof config.contextSecret !== 'string') {
    throw new ConfigValidationError('OpenCode contextSecret must be a string');
  }
  
  return {
    enabled: config.enabled ?? true,
    hostname: config.hostname,
    model: config.model,
    smallModel: config.smallModel,
    systemPrompt: config.systemPrompt,
    includeThreadHistory: config.includeThreadHistory ?? true,
    contextSecret: config.contextSecret,
  };
}

export function validateReplyConfig(config: any): ReplyConfig {
  if (!config) {
    return { enabled: false, mode: 'static', text: '' };
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new ConfigValidationError('Reply enabled must be a boolean');
  }
  if (config.mode && !['static', 'opencode'].includes(config.mode)) {
    throw new ConfigValidationError('Reply mode must be "static" or "opencode"');
  }
  if (config.text !== undefined && typeof config.text !== 'string') {
    throw new ConfigValidationError('Reply text must be a string');
  }

  const opencodeConfig = validateOpenCodeConfig(config.opencode);

  const attachmentConfig = config.attachments && config.attachments.enabled
    ? {
        enabled: true,
        maxFileSize: config.attachments.maxFileSize ?? 10 * 1024 * 1024,
        allowedExtensions: config.attachments.allowedExtensions || ['.ppt', '.pptx', '.doc', '.docx', '.txt', '.md'],
      }
    : undefined;

  const progressConfig = config.progress
    ? validateProgressConfig(config.progress)
    : undefined;

  return {
    enabled: config.enabled ?? false,
    mode: config.mode ?? 'static',
    text: config.text ?? '',
    opencode: opencodeConfig,
    attachments: attachmentConfig,
    progress: progressConfig,
  };
}

function validateProgressConfig(config: any): ReplyConfig['progress'] {
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new ConfigValidationError('Progress enabled must be a boolean');
  }
  if (config.initialDelayMs !== undefined && typeof config.initialDelayMs !== 'number') {
    throw new ConfigValidationError('Progress initialDelayMs must be a number');
  }
  if (config.initialDelayMs !== undefined && config.initialDelayMs < 1000) {
    throw new ConfigValidationError('Progress initialDelayMs must be at least 1000ms');
  }
  if (config.intervalMs !== undefined && typeof config.intervalMs !== 'number') {
    throw new ConfigValidationError('Progress intervalMs must be a number');
  }
  if (config.intervalMs !== undefined && config.intervalMs < 1000) {
    throw new ConfigValidationError('Progress intervalMs must be at least 1000ms');
  }
  if (config.maxMessages !== undefined && typeof config.maxMessages !== 'number') {
    throw new ConfigValidationError('Progress maxMessages must be a number');
  }
  if (config.maxMessages !== undefined && (config.maxMessages < 1 || config.maxMessages > 10)) {
    throw new ConfigValidationError('Progress maxMessages must be between 1 and 10');
  }

  return {
    enabled: config.enabled,
    initialDelayMs: config.initialDelayMs ?? 180000,
    intervalMs: config.intervalMs ?? 180000,
    maxMessages: config.maxMessages ?? 5,
  };
}

export function validateAlertingConfig(config: any): AlertingConfig | undefined {
  if (!config) return undefined;

  if (typeof config !== 'object' || config === null) {
    throw new ConfigValidationError('alerting config must be an object');
  }

  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new ConfigValidationError('alerting.enabled must be a boolean');
  }

  // If not enabled, return minimal config without requiring other fields
  if (config.enabled === false) {
    return { enabled: false, recipient: '' };
  }

  if (!config.recipient || typeof config.recipient !== 'string') {
    throw new ConfigValidationError('alerting.recipient is required and must be a string (email address)');
  }

  if (config.batchIntervalMinutes !== undefined) {
    if (typeof config.batchIntervalMinutes !== 'number' || config.batchIntervalMinutes < 1) {
      throw new ConfigValidationError('alerting.batchIntervalMinutes must be a positive number');
    }
  }

  if (config.maxErrorsPerBatch !== undefined) {
    if (typeof config.maxErrorsPerBatch !== 'number' || config.maxErrorsPerBatch < 1) {
      throw new ConfigValidationError('alerting.maxErrorsPerBatch must be a positive number');
    }
  }

  if (config.subjectPrefix !== undefined && typeof config.subjectPrefix !== 'string') {
    throw new ConfigValidationError('alerting.subjectPrefix must be a string');
  }

  if (config.includeReplyToolLog !== undefined && typeof config.includeReplyToolLog !== 'boolean') {
    throw new ConfigValidationError('alerting.includeReplyToolLog must be a boolean');
  }

  if (config.replyToolLogTailLines !== undefined) {
    if (typeof config.replyToolLogTailLines !== 'number' || config.replyToolLogTailLines < 1) {
      throw new ConfigValidationError('alerting.replyToolLogTailLines must be a positive number');
    }
  }

  // Health check sub-config
  let healthCheck: HealthCheckConfig | undefined;
  if (config.healthCheck) {
    healthCheck = validateHealthCheckConfig(config.healthCheck);
  }

  // Alert channel validation
  if (config.channel !== undefined && typeof config.channel !== 'string') {
    throw new ConfigValidationError('alerting.channel must be a string');
  }

  return {
    enabled: config.enabled ?? true,
    recipient: config.recipient,
    channel: config.channel,
    batchIntervalMinutes: config.batchIntervalMinutes ?? 5,
    maxErrorsPerBatch: config.maxErrorsPerBatch ?? 50,
    subjectPrefix: config.subjectPrefix ?? 'Jiny-M Alert',
    includeReplyToolLog: config.includeReplyToolLog ?? true,
    replyToolLogTailLines: config.replyToolLogTailLines ?? 50,
    healthCheck,
  };
}

function validateHealthCheckConfig(config: any): HealthCheckConfig | undefined {
  if (!config) return undefined;

  if (typeof config !== 'object' || config === null) {
    throw new ConfigValidationError('alerting.healthCheck must be an object');
  }

  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new ConfigValidationError('alerting.healthCheck.enabled must be a boolean');
  }

  if (config.intervalHours !== undefined) {
    if (typeof config.intervalHours !== 'number' || config.intervalHours < 0.1) {
      throw new ConfigValidationError('alerting.healthCheck.intervalHours must be a positive number (minimum 0.1)');
    }
  }

  if (config.recipient !== undefined && typeof config.recipient !== 'string') {
    throw new ConfigValidationError('alerting.healthCheck.recipient must be a string');
  }

  return {
    enabled: config.enabled ?? true,
    intervalHours: config.intervalHours ?? 24,
    recipient: config.recipient,
  };
}

export function validateConfig(config: any): Config {
  if (!config) {
    throw new ConfigValidationError('Configuration is required');
  }

  // Support multiple channel formats:
  // 1. New multi-channel: channels.{name}.{type, inbound, outbound, watch, patterns, workspace}
  // 2. Single-channel: channels.email.{inbound, outbound, watch}
  // 3. Legacy: top-level imap/smtp/watch
  const channels: Record<string, ChannelConfig> = {};

  // Process new multi-channel format (channels: { work: {...}, personal: {...} })
  if (config.channels && typeof config.channels === 'object') {
    for (const [channelName, channelConfig] of Object.entries(config.channels)) {
      if (!channelConfig || typeof channelConfig !== 'object') continue;
      
      const validated: ChannelConfig = {
        type: channelConfig.type || 'email',
      };

      if (channelConfig.inbound) {
        validated.inbound = validateImapConfig(channelConfig.inbound);
      }
      if (channelConfig.outbound) {
        validated.outbound = validateSmtpConfig(channelConfig.outbound);
      }
      if (channelConfig.watch) {
        validated.watch = validateWatchConfig(channelConfig.watch);
      }
      if (channelConfig.workspace && typeof channelConfig.workspace === 'string') {
        validated.workspace = channelConfig.workspace;
      }
      if (channelConfig.reply && typeof channelConfig.reply === 'object') {
        validated.reply = validateReplyConfig(channelConfig.reply);
      }

      // Channel-specific patterns
      if (channelConfig.patterns && Array.isArray(channelConfig.patterns)) {
        validated.patterns = channelConfig.patterns.map((p: any) => {
          if (p.channel && p.rules) return validateChannelPattern(p);
          return { ...validatePattern(p), channel: channelName };
        });
      }

      if (validated.inbound || validated.outbound) {
        channels[channelName] = validated;
      }
    }
  }

  // Legacy format: channels.email (single email channel)
  if (!channels.email && config.channels?.email) {
    const emailConfig = config.channels.email;
    channels.email = {
      type: 'email',
      inbound: emailConfig.inbound ? validateImapConfig(emailConfig.inbound) : undefined,
      outbound: emailConfig.outbound ? validateSmtpConfig(emailConfig.outbound) : undefined,
      watch: emailConfig.watch ? validateWatchConfig(emailConfig.watch) : undefined,
    };
  }

  // Legacy format fallback: top-level imap/smtp
  let imapConfig: ImapConfig | undefined;
  let smtpConfig: SmtpConfig | undefined;
  let watchConfig: WatchConfig | undefined;

  if (!channels.email && config.imap) {
    imapConfig = validateImapConfig(config.imap);
  }
  if (!channels.email && config.smtp) {
    smtpConfig = validateSmtpConfig(config.smtp);
  }
  if (!channels.email && config.watch) {
    watchConfig = validateWatchConfig(config.watch);
  }

  if (imapConfig || smtpConfig) {
    channels.email = {
      type: 'email',
      inbound: imapConfig,
      outbound: smtpConfig,
      watch: watchConfig,
    };
  }

  // Convert patterns: support both legacy Pattern and new ChannelPattern
  const rawPatterns = Array.isArray(config.patterns) ? config.patterns : [];
  const patterns = rawPatterns.map((p: any) => {
    if (p.channel && p.rules) {
      // New ChannelPattern format
      return validateChannelPattern(p);
    }
    // Legacy Pattern format — validate and keep as-is for backward compat
    return validatePattern(p);
  });

  const result: Config = {
    patterns,
    output: validateOutputConfig(config.output),
    reply: validateReplyConfig(config.reply),
  };

  // Store channel configs
  if (Object.keys(channels).length > 0) {
    result.channels = channels;
  }

  // Keep legacy fields for backward compat
  if (imapConfig) result.imap = imapConfig;
  if (smtpConfig) result.smtp = smtpConfig;
  if (watchConfig) result.watch = watchConfig;

  // Worker config
  if (config.worker) {
    result.worker = {
      maxConcurrentThreads: config.worker.maxConcurrentThreads ?? 3,
      maxQueueSizePerThread: config.worker.maxQueueSizePerThread ?? 10,
    };
  }

  // Alerting config
  const alertingConfig = validateAlertingConfig(config.alerting);
  if (alertingConfig) {
    result.alerting = alertingConfig;
  }

  return result;
}

/**
 * Validate a new-format ChannelPattern with channel + rules.
 */
function validateChannelPattern(pattern: any): ChannelPattern {
  if (!pattern.name || typeof pattern.name !== 'string') {
    throw new ConfigValidationError('Pattern name is required');
  }
  if (!pattern.channel || typeof pattern.channel !== 'string') {
    throw new ConfigValidationError(`Pattern "${pattern.name}" must have a channel field`);
  }
  if (!pattern.rules || typeof pattern.rules !== 'object') {
    throw new ConfigValidationError(`Pattern "${pattern.name}" must have a rules object`);
  }

  const result: ChannelPattern = {
    name: pattern.name,
    channel: pattern.channel,
    enabled: pattern.enabled,
    rules: pattern.rules,
  };

  if (pattern.attachments) {
    result.attachments = validateInboundAttachmentConfig(pattern.attachments);
  }

  return result;
}

export function expandEnvVars(config: any): any {
  if (typeof config !== 'object' || config === null) {
    return config;
  }
  
  if (Array.isArray(config)) {
    return config.map(expandEnvVars);
  }
  
  const expanded: any = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      expanded[key] = value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
        return process.env[envVar] || '';
      });
    } else if (typeof value === 'object') {
      expanded[key] = expandEnvVars(value);
    } else {
      expanded[key] = value;
    }
  }
  
  return expanded;
}