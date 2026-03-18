export const DEFAULT_CONFIG_PATH = '.jiny/config.json';
export const DEFAULT_PATTERNS_PATH = '.jiny/patterns.json';

export const DEFAULT_IMAP_CONFIG = {
  tls: true,
  authTimeout: 30000,
};

export const DEFAULT_SMTP_CONFIG = {
  tls: true,
};

export const DEFAULT_REPLY_CONFIG = {
  enabled: false,
  mode: 'static' as 'static' | 'opencode',
  text: '',
  attachments: {
    enabled: true,
    maxFileSize: 10 * 1024 * 1024,  // 10MB
    allowedExtensions: ['.ppt', '.pptx', '.doc', '.docx', '.txt', '.md'],
  },
};

export const DEFAULT_WATCH_CONFIG = {
  checkInterval: 30,
  maxRetries: 5,
  useIdle: true,
  folder: 'INBOX',
  reconnect: {
    maxAttempts: 10,
    baseDelay: 5000,
    maxDelay: 60000,
  },
};

export const DEFAULT_OUTPUT_CONFIG = {
  format: 'text' as const,
  includeHeaders: true,
  includeAttachments: false,
  truncateLength: 1000,
};

export const SUPPORTED_PATTERN_TYPES = ['regex', 'exact', 'domain', 'contains'] as const;

export const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000] as const;

export const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
} as const;