import { join } from 'node:path';
import { EmailMonitor } from '../../services/imap/monitor';
import type { GeneratedFile, AttachmentConfig, Email } from '../../types';
import { ConfigManager } from '../../config';
import { EmailStorage } from '../../services/storage';
import { SmtpService } from '../../services/smtp';
import { OpenCodeService } from '../../services/opencode';
import { OutputFormatter } from '../../output';
import { logger } from '../../core/logger';
import { StateManager } from '../../core/state-manager';
import { parseFileSize } from '../../utils/helpers';
import { CommandRegistry } from '../../core/command-handler/CommandRegistry';
import { EmailCommandExtractor } from '../../core/command-parser';

export interface MonitorCommandOptions {
  config?: string;
  once?: boolean;
  noIdle?: boolean;
  verbose?: boolean;
  debug?: boolean;
  reset?: boolean;
}

let monitorInstance: EmailMonitor | undefined;

export async function monitorCommand(options: MonitorCommandOptions): Promise<void> {
  let opencodeService: OpenCodeService | undefined;
  
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

    // Initialize OpenCode service if opencode mode is enabled
    if (replyConfig.enabled && replyConfig.mode === 'opencode' && replyConfig.opencode) {
      opencodeService = new OpenCodeService(replyConfig.opencode);
      logger.info('OpenCode AI service initialized');
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
    
    monitorInstance = monitor;
    await monitor.start({
      once: options.once ?? false,
      useIdle: options.noIdle ? false : (watchConfig.useIdle ?? true),
      verbose: options.verbose ?? false,
      onMatch: async (email, patternMatch) => {
        console.log(formatter.format(email));

        // Find the matched pattern's inboundAttachments config
        const matchedPattern = patterns.find(p => p.name === patternMatch.patternName);
        const inboundAttachmentConfig = matchedPattern?.inboundAttachments;

        // Store email as markdown in thread folder
        let threadPath: string | undefined;
        let messageDir: string | undefined;
        try {
          const result = await storage.store(email, patternMatch, inboundAttachmentConfig);
          threadPath = result.threadPath;
          messageDir = result.messageDir;
          logger.info('Email saved to workspace', { messageDir: result.messageDir, pattern: patternMatch.patternName });
        } catch (err) {
          logger.error('Failed to save email to workspace', { error: err instanceof Error ? err.message : 'Unknown error' });
        }

        // Send auto-reply if enabled
        if (replyConfig.enabled && smtpService && threadPath) {
          try {
            await handleAutoReply(
              email,
              threadPath,
              replyConfig,
              opencodeService,
              storage,
              smtpService,
              options,
              monitorInstance,
              messageDir
            );
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
  } finally {
    // Cleanup OpenCode service
    if (opencodeService) {
      await opencodeService.close();
    }
  }
}

// Helper function to handle auto-reply with command extraction
async function handleAutoReply(
  email: Email,
  threadPath: string,
  replyConfig: { enabled: boolean; mode: 'static' | 'opencode'; text?: string; opencode?: any; attachments?: AttachmentConfig },
  opencodeService: OpenCodeService | undefined,
  storage: EmailStorage,
  smtpService: SmtpService,
  options: MonitorCommandOptions,
  monitorInstance: any,
  messageDir?: string
): Promise<void> {
  // Extract commands from email body
  const extractor = new EmailCommandExtractor();
  const emailBody = email.body.text || email.body.html || '';
  const { cleanedBody, commandLines } = extractor.extractCommands(emailBody);

  // If commands exist, let AttachCommandHandler handle the entire flow
  if (commandLines.length > 0 && replyConfig.attachments?.enabled) {
    logger.info('Found commands in email, let AttachCommandHandler handle reply', { commandCount: commandLines.length });

    const commandRegistry = new CommandRegistry();
    const commands = commandRegistry.parseCommands(emailBody);

    for (const command of commands) {
      const result = await commandRegistry.execute(command, {
        email: {
          id: email.id,
          from: email.from,
          subject: email.subject,
          body: email.body,
          threadId: email.threadId,
          headers: email.headers,
          messageId: email.messageId,
          references: email.references,
          date: email.date
        },
        threadPath,
        config: replyConfig.attachments,
        cleanedBody,
        smtpService,
        opencodeService,
        storage,
        replyConfig: {
          mode: replyConfig.mode,
          text: replyConfig.text
        }
      });

      if (result.success) {
        logger.info('Command-based email sent successfully', { handler: command.handler.name });
      } else {
        logger.warn('Command execution failed', { handler: command.handler.name, error: result.error });
      }
    }

    return;
  }

  // Normal flow: no commands detected
  let replyText: string;
  let attachments: Array<{ filename: string; path: string; contentType: string }> | undefined;

  // Get thread directory files before AI processing (for fallback detection)
  const filesBeforeAI = replyConfig.mode === 'opencode' && replyConfig.attachments?.enabled
    ? await (await import('node:fs')).promises.readdir(threadPath).then(files => new Set(files.filter(f => !f.startsWith('.'))))
    : null;

  if (replyConfig.mode === 'opencode' && opencodeService) {
    // Generate AI reply (OpenCode may use MCP reply_email tool to send directly)
    logger.info('Generating AI reply...', { to: email.from });
    const aiReply = await opencodeService.generateReply(email, threadPath, messageDir);

    // If the MCP reply_email tool was used, the reply was already sent and stored
    if (aiReply.replySentByTool) {
      logger.info('Reply sent via MCP reply_email tool', { to: email.from });
      return;
    }

    // Fallback: MCP tool was not used, send reply directly
    logger.info('MCP tool not used, falling back to direct SMTP send', { to: email.from });
    replyText = aiReply.text;

    if (!replyText || replyText.trim().length === 0) {
      logger.warn('Generated reply is empty, skipping send', { to: email.from });
      await storage.storeReply(threadPath, '[Empty reply - not sent]', email, messageDir);
      return;
    }

    if (aiReply.attachments.length > 0) {
      attachments = await prepareAttachments(
        aiReply.attachments,
        threadPath,
        replyConfig.attachments
      );
    } else if (filesBeforeAI && replyConfig.attachments?.enabled) {
      attachments = await detectNewFiles(
        filesBeforeAI,
        threadPath,
        replyConfig.attachments
      );
    }

    await storage.storeReply(threadPath, replyText, email, messageDir);
  } else if (replyConfig.mode === 'static') {
    replyText = replyConfig.text || '';
  } else {
    logger.warn('No reply mode configured, skipping reply');
    return;
  }

  await smtpService.replyToEmail(email, replyText, attachments);
  logger.info('Auto-reply sent', {
    to: email.from,
    subject: email.subject,
    mode: replyConfig.mode,
    attachmentCount: attachments?.length || 0
  });
}

// Helper methods for attachment handling
async function prepareAttachments(
  aiAttachments: GeneratedFile[],
  threadPath: string,
  attachmentConfig: AttachmentConfig | undefined
): Promise<Array<{ filename: string; path: string; contentType: string }>> {
  if (!attachmentConfig || !attachmentConfig.enabled) {
    return [];
  }

  const fs = await import('node:fs');
  const attachments: Array<{ filename: string; path: string; contentType: string }> = [];

  for (const file of aiAttachments) {
    const filePath = join(threadPath, file.filename);

    try {
      const fileExists = await fs.promises.access(filePath).then(() => true).catch(() => false);
      if (!fileExists) {
        logger.warn('File not found, skipping attachment', { filename: file.filename });
        continue;
      }

      const stats = await fs.promises.stat(filePath);
      if (stats.size > parseFileSize(attachmentConfig.maxFileSize)) {
        logger.warn('File exceeds size limit, skipping attachment', {
          filename: file.filename,
          size: stats.size,
          maxSize: parseFileSize(attachmentConfig.maxFileSize),
        });
        continue;
      }

      const ext = '.' + file.filename.split('.').pop()?.toLowerCase() || '';
      if (!attachmentConfig.allowedExtensions.includes(ext)) {
        logger.debug('File extension not in allowed list, skipping', {
          filename: file.filename,
          ext,
          allowed: attachmentConfig.allowedExtensions.join(', ')
        });
        continue;
      }

      attachments.push({
        filename: file.filename,
        path: filePath,
        contentType: file.mime || 'application/octet-stream',
      });
      logger.debug('Will attach file', {
        filename: file.filename,
        size: stats.size,
        contentType: file.mime
      });
    } catch (error) {
      logger.error('Failed to prepare attachment', {
        filename: file.filename,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  return attachments;
}

async function detectNewFiles(
  filesBeforeAI: Set<string>,
  threadPath: string,
  attachmentConfig: AttachmentConfig
): Promise<Array<{ filename: string; path: string; contentType: string }>> {
  if (!attachmentConfig || !attachmentConfig.enabled) {
    return [];
  }

  const fs = await import('node:fs');
  const filesAfterAI = await fs.promises.readdir(threadPath);
  const attachments: Array<{ filename: string; path: string; contentType: string }> = [];

  for (const file of filesAfterAI) {
    if (file.startsWith('.') || filesBeforeAI.has(file)) {
      continue;
    }

    const filePath = join(threadPath, file);

    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.isDirectory()) continue;

      if (stats.size > parseFileSize(attachmentConfig.maxFileSize)) {
        logger.warn('File exceeds size limit, skipping', { filename: file, size: stats.size, maxSize: parseFileSize(attachmentConfig.maxFileSize) });
        continue;
      }

      const ext = '.' + file.split('.').pop()?.toLowerCase() || '';
      if (!attachmentConfig.allowedExtensions.includes(ext)) {
        logger.debug('File extension not in allowed list, skipping', { filename: file, ext });
        continue;
      }

      attachments.push({
        filename: file,
        path: filePath,
        contentType: `application/${ext.substring(1)}`,
      });
      logger.info('Found new AI-generated file via fallback detection', { filename: file, size: stats.size });
    } catch (error) {
      logger.warn('Failed to check file for attachment', { filename: file, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  return attachments;
}

