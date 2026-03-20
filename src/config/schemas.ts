import type { Config, Pattern, ImapConfig, SmtpConfig, WatchConfig, OutputConfig, WorkspaceConfig, ReplyConfig, OpenCodeConfig, InboundAttachmentConfig } from '../types';
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

function validateInboundAttachmentConfig(config: any): InboundAttachmentConfig {
  if (typeof config !== 'object' || config === null) {
    throw new ConfigValidationError('inboundAttachments must be an object');
  }

  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new ConfigValidationError('inboundAttachments.enabled must be a boolean');
  }

  if (config.allowedExtensions !== undefined) {
    if (!Array.isArray(config.allowedExtensions)) {
      throw new ConfigValidationError('inboundAttachments.allowedExtensions must be an array');
    }
    for (const ext of config.allowedExtensions) {
      if (typeof ext !== 'string' || !ext.startsWith('.')) {
        throw new ConfigValidationError(`Invalid extension in inboundAttachments: "${ext}" (must start with ".")`);
      }
    }
  }

  if (config.maxFileSize !== undefined) {
    try {
      parseFileSize(config.maxFileSize);
    } catch (e) {
      throw new ConfigValidationError(`inboundAttachments.maxFileSize: ${(e as Error).message}`);
    }
  }

  if (config.maxAttachmentsPerEmail !== undefined) {
    if (typeof config.maxAttachmentsPerEmail !== 'number' || config.maxAttachmentsPerEmail < 1) {
      throw new ConfigValidationError('inboundAttachments.maxAttachmentsPerEmail must be a positive number');
    }
  }

  return {
    enabled: config.enabled ?? false,
    allowedExtensions: config.allowedExtensions || ['.pdf', '.pptx', '.docx', '.xlsx', '.png', '.jpg', '.txt', '.md'],
    maxFileSize: config.maxFileSize ?? '25mb',
    maxAttachmentsPerEmail: config.maxAttachmentsPerEmail ?? 10,
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

  return {
    enabled: config.enabled ?? false,
    mode: config.mode ?? 'static',
    text: config.text ?? '',
    opencode: opencodeConfig,
    attachments: attachmentConfig,
  };
}

export function validateConfig(config: any): Config {
  if (!config) {
    throw new ConfigValidationError('Configuration is required');
  }
  
  return {
    imap: validateImapConfig(config.imap),
    smtp: validateSmtpConfig(config.smtp),
    watch: validateWatchConfig(config.watch),
    patterns: Array.isArray(config.patterns) ? config.patterns.map(validatePattern) : [],
    output: validateOutputConfig(config.output),
    workspace: validateWorkspaceConfig(config.workspace),
    reply: validateReplyConfig(config.reply),
  };
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