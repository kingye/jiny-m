import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { validateConfig, expandEnvVars, ConfigValidationError } from './schemas';
import type { Config } from '../types';
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
  
  getWorkspaceConfig() {
    return this.getConfig().workspace;
  }
  
  getReplyConfig() {
    return this.getConfig().reply;
  }
  
  getOpenCodeConfig() {
    const reply = this.getReplyConfig();
    return reply.mode === 'opencode' ? reply.opencode : undefined;
  }
  
  getPatterns() {
    return this.getConfig().patterns.filter(p => p.enabled !== false);
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