import { ConfigManager } from '../../config';
import { EmailMonitor } from '../../services/imap/monitor';
import { EmailStorage } from '../../services/storage';
import { SmtpService } from '../../services/smtp';
import { OutputFormatter } from '../../output';
import { logger } from '../../core/logger';
import { StateManager } from '../../core/state-manager';

export interface MonitorCommandOptions {
  config?: string;
  once?: boolean;
  noIdle?: boolean;
  verbose?: boolean;
  debug?: boolean;
  reset?: boolean;
}

export async function monitorCommand(options: MonitorCommandOptions): Promise<void> {
  try {
    if (options.reset) {
      logger.info('Resetting monitoring state...');
      await StateManager.reset();
    }
    
    if (options.debug) {
      logger.setLevel('DEBUG');
      logger.info('Debug logging enabled');
    }
    
    logger.info('Starting email monitor...');
    
    const configManager = await ConfigManager.create(options.config);
    const config = configManager.getConfig();
    logger.info(`Loaded configuration with ${configManager.getPatterns().length} pattern(s)`);
    
    const imapConfig = configManager.getImapConfig();
    const watchConfig = configManager.getWatchConfig();
    const patterns = configManager.getPatterns();
    const outputConfig = configManager.getOutputConfig();
    const folder = watchConfig.folder || 'INBOX';
    
    if (patterns.length === 0) {
      logger.warn('No patterns configured. Monitor will not match any emails.');
    }
    
    const formatter = new OutputFormatter({
      format: outputConfig.format,
      includeHeaders: outputConfig.includeHeaders,
      includeAttachments: outputConfig.includeAttachments,
      truncateLength: outputConfig.truncateLength,
    });
    
    // Initialize workspace storage
    const workspaceConfig = configManager.getWorkspaceConfig();
    const storage = new EmailStorage(workspaceConfig);
    await storage.init();
    logger.info('Workspace storage ready', { folder: workspaceConfig.folder });

    // Initialize SMTP service if reply is enabled
    let smtpService: SmtpService | undefined;
    const replyConfig = configManager.getReplyConfig();
    if (replyConfig.enabled) {
      const smtpConfig = configManager.getSmtpConfig();
      if (!smtpConfig) {
        logger.warn('Reply is enabled but SMTP config is missing. Auto-reply will not be sent.');
      } else {
        smtpService = new SmtpService(smtpConfig);
        try {
          await smtpService.connect();
          logger.info('SMTP service ready for auto-reply');
        } catch (error) {
          logger.error('Failed to connect to SMTP server, auto-reply will not be sent', { error: error instanceof Error ? error.message : 'Unknown error' });
          smtpService = undefined;
        }
      }
    }
    
    const monitor = new EmailMonitor(
      imapConfig,
      watchConfig,
      patterns,
      outputConfig,
      folder,
      options.verbose ?? false,
      options.debug ?? false
    );
    
    await monitor.start({
      once: options.once ?? false,
      useIdle: options.noIdle ? false : (watchConfig.useIdle ?? true),
      verbose: options.verbose ?? false,
      onMatch: async (email, patternMatch) => {
        console.log(formatter.format(email));
        
        // Store email as markdown in thread folder
        try {
          const filePath = await storage.store(email, patternMatch);
          logger.info('Email saved to workspace', { file: filePath, pattern: patternMatch.patternName });
        } catch (err) {
          logger.error('Failed to save email to workspace', { error: err instanceof Error ? err.message : 'Unknown error' });
        }

        // Send auto-reply if enabled
        if (replyConfig.enabled && smtpService) {
          try {
            await smtpService.replyToEmail(email, replyConfig.text);
            logger.info('Auto-reply sent', { to: email.from, subject: email.subject });
          } catch (err) {
            logger.error('Failed to send auto-reply', { error: err instanceof Error ? err.message : 'Unknown error' });
          }
        }
      },
      onError: (error) => {
        logger.error('Monitor error callback', { error: error.message });
      },
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Monitor command failed', { error: errorMessage });
    process.exit(1);
  }
}