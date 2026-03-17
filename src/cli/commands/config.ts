import { writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG_PATH, DEFAULT_IMAP_CONFIG, DEFAULT_SMTP_CONFIG, DEFAULT_WATCH_CONFIG, DEFAULT_OUTPUT_CONFIG } from '../../utils/constants';

export async function initConfigCommand(configPath?: string): Promise<void> {
  const filePath = configPath || DEFAULT_CONFIG_PATH;
  const fullPath = join(process.cwd(), filePath);
  const dirName = join(process.cwd(), '.jiny');
  
  const defaultConfig = {
    imap: {
      ...DEFAULT_IMAP_CONFIG,
      host: '${IMAP_HOST}',
      username: '${IMAP_USER}',
      password: '${IMAP_PASSWORD}',
      tls: true,
    },
    smtp: {
      ...DEFAULT_SMTP_CONFIG,
      host: '${IMAP_HOST}',
      username: '${IMAP_USER}',
      password: '${IMAP_PASSWORD}',
      tls: true,
    },
    watch: {
      ...DEFAULT_WATCH_CONFIG,
      checkInterval: 30,
      maxRetries: 5,
      useIdle: true,
      folder: 'INBOX',
    },
    patterns: [
      {
        name: 'example-pattern',
        enabled: true,
        caseSensitive: false,
        sender: {
          domain: ['example.com'],
        },
        subject: {
          prefix: ['Urgent', 'Alert', 'Notice'],
          regex: '\\[Ticket\\#\\d+\\]',
        },
      },
    ],
    output: {
      ...DEFAULT_OUTPUT_CONFIG,
      format: 'text',
      includeHeaders: true,
      includeAttachments: false,
      truncateLength: 1000,
    },
    workspace: {
      folder: './workspace',
    },
    reply: {
      enabled: false,
      text: 'Thanks for reaching out! We have received your message and will get back to you shortly.',
    },
  };
  
  try {
    // Check if config already exists
    try {
      await access(fullPath);
      console.error(`Configuration file already exists at: ${filePath}`);
      console.error('Use --force to overwrite, or edit the file directly.');
      process.exit(1);
    } catch {
      // File doesn't exist, safe to create
    }

    // Create .jiny directory if it doesn't exist
    await mkdir(dirName, { recursive: true });
    await writeFile(fullPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    console.log(`Configuration file created at: ${filePath}`);
    console.log('\nPlease edit the configuration file with your IMAP credentials and patterns.');
    console.log('You can use environment variables (e.g., ${IMAP_HOST}) for sensitive data.');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Failed to create configuration file: ${errorMessage}`);
    process.exit(1);
  }
}

export async function validateConfigCommand(configPath?: string): Promise<void> {
  const filePath = configPath || DEFAULT_CONFIG_PATH;
  
  try {
    const configManager = (await import('../../config')).ConfigManager;
    const manager = await configManager.create(filePath);
    const config = manager.getConfig();
    
    console.log('Configuration is valid! ✓');
    console.log(`IMAP Server: ${config.imap.host}:${config.imap.port}`);
    console.log(`Patterns: ${manager.getPatterns().length}`);
    console.log(`Watch interval: ${config.watch.checkInterval}s`);
    console.log(`Output format: ${config.output.format}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Configuration validation failed: ${errorMessage}`);
    process.exit(1);
  }
}