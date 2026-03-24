import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { validateConfig, expandEnvVars, ConfigValidationError } from './schemas';
import type { Config, Pattern, ChannelPattern, EmailChannelConfig, WatchConfig, AlertingConfig, ChannelConfig } from '../types';
import { DEFAULT_CONFIG_PATH, DEFAULT_WATCH_CONFIG, DEFAULT_OUTPUT_CONFIG } from '../utils/constants';

export class ConfigManager {
  private config: Config | null = null;
  private configPath: string;
  
  constructor(configPath: string = DEFAULT_CONFIG_PATH) {
    this.configPath = configPath;
  }
  
  async load(): Promise<Config> {
    try {
      const filePath = isAbsolute(this.configPath)
        ? this.configPath
        : join(process.cwd(), this.configPath);
      const fileContent = await readFile(filePath, 'utf-8');
      const rawConfig = JSON.parse(fileContent);
      const expandedConfig = expandEnvVars(rawConfig);
      this.config = validateConfig(expandedConfig);
      return this.config;
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        throw error;
      }
      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw new ConfigValidationError(`Configuration file not found: ${this.configPath}`);
      }
      throw new ConfigValidationError(`Failed to load configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  getConfig(): Config {
    if (!this.config) {
      throw new ConfigValidationError('Configuration not loaded. Call load() first.');
    }
    return this.config;
  }

  // --- Channel config accessors ---

  /** Get all configured channels (name -> config). */
  getAllChannels(): Record<string, ChannelConfig> {
    const config = this.getConfig();
    return config.channels || {};
  }

  /** Get channel names. */
  getChannelNames(): string[] {
    return Object.keys(this.getAllChannels());
  }

  /** Get a specific channel config by name. */
  getChannelConfig(channelName: string): ChannelConfig | undefined {
    return this.getAllChannels()[channelName];
  }

  /** Get email channel config (from channels.email or legacy imap/smtp). */
  getEmailChannelConfig(): EmailChannelConfig | undefined {
    const config = this.getConfig();
    if (config.channels?.email) return config.channels.email;
    // Legacy fallback
    if (config.imap && config.smtp) {
      return {
        inbound: config.imap,
        outbound: config.smtp,
        watch: config.watch,
      };
    }
    return undefined;
  }

  /** Get effective workspace path for a channel. */
  getChannelWorkspace(channelName: string): string {
    const config = this.getAllChannels()[channelName];
    if (config?.workspace) return config.workspace;
    // Default: channel name + /workspace
    return `${channelName}/workspace`;
  }

  /** Get watch config (from channels.email.watch or legacy watch). */
  getEffectiveWatchConfig(channelName?: string): WatchConfig {
    const channel = channelName ? this.getChannelConfig(channelName) : undefined;
    const emailConfig = this.getEmailChannelConfig();
    const watchConfig = channel?.watch || emailConfig?.watch || this.getConfig().watch;
    return {
      ...DEFAULT_WATCH_CONFIG,
      ...watchConfig,
    };
  }

  /**
   * Get all patterns as ChannelPattern (converts legacy patterns to email ChannelPattern).
   */
  getChannelPatterns(): ChannelPattern[] {
    const config = this.getConfig();
    return config.patterns
      .filter((p: any) => p.enabled !== false)
      .map((p: any) => {
        // Already a ChannelPattern
        if (p.channel && p.rules) return p as ChannelPattern;
        // Legacy Pattern — convert to email ChannelPattern
        return this.legacyPatternToChannelPattern(p as Pattern);
      });
  }

  /** Convert a legacy Pattern to a ChannelPattern for the email channel. */
  private legacyPatternToChannelPattern(pattern: Pattern): ChannelPattern {
    const rules: Record<string, any> = {};
    if (pattern.sender) rules.sender = pattern.sender;
    if (pattern.subject) rules.subject = pattern.subject;
    if (pattern.caseSensitive !== undefined) rules.caseSensitive = pattern.caseSensitive;

    const result: ChannelPattern = {
      name: pattern.name,
      channel: 'email',
      enabled: pattern.enabled,
      rules,
    };

    // Convert inboundAttachments to attachments
    if (pattern.inboundAttachments) {
      result.attachments = {
        enabled: pattern.inboundAttachments.enabled,
        allowedExtensions: pattern.inboundAttachments.allowedExtensions,
        maxFileSize: pattern.inboundAttachments.maxFileSize,
        maxAttachmentsPerMessage: pattern.inboundAttachments.maxAttachmentsPerEmail,
      };
    }

    return result;
  }

  // --- Legacy accessors (kept for backward compat) ---
  
  getImapConfig() {
    return this.getConfig().imap;
  }
  
  getSmtpConfig() {
    return this.getConfig().smtp;
  }
  
  getWatchConfig() {
    const config = this.getConfig();
    return {
      ...DEFAULT_WATCH_CONFIG,
      ...config.watch,
    };
  }
  
  getOutputConfig() {
    const config = this.getConfig();
    return {
      ...DEFAULT_OUTPUT_CONFIG,
      ...config.output,
    };
  }
  
  getReplyConfig() {
    return this.getConfig().reply;
  }
  
  getOpenCodeConfig() {
    const reply = this.getReplyConfig();
    return reply.mode === 'opencode' ? reply.opencode : undefined;
  }

  getAlertingConfig(): AlertingConfig | undefined {
    return this.getConfig().alerting;
  }
  
  getPatterns() {
    return this.getConfig().patterns.filter((p: any) => p.enabled !== false);
  }
  
  static async create(configPath?: string): Promise<ConfigManager> {
    const manager = new ConfigManager(configPath);
    await manager.load();
    return manager;
  }
}

export async function loadConfig(configPath?: string): Promise<Config> {
  const manager = await ConfigManager.create(configPath);
  return manager.getConfig();
}