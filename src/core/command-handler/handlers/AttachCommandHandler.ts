import type { CommandHandler, CommandContext, CommandResult } from '../CommandHandler';
import { PathValidator } from '../../security';
import { logger } from '../../logger';

export class AttachCommandHandler implements CommandHandler {
  name = '/attach';
  description = 'Attach files from the thread directory to the email reply';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { args, threadPath, config } = context;
    const attachments: Array<{ timestamp: string; filename: string; path: string; contentType: string }> = [];

    if (!args || args.length === 0) {
      return {
        success: false,
        error: 'No files specified for attachment'
      };
    }

    const fs = await import('node:fs');
    let hasSecurityViolation = false;

    for (const filename of args) {
      try {
        const safePath = PathValidator.validateFilePath(threadPath, filename);
        PathValidator.validateExtension(filename, config.allowedExtensions);

        const exists = await fs.promises.access(safePath).then(() => true).catch(() => false);
        if (!exists) {
          logger.warn('File not found for attachment', { filename });
          continue;
        }

        const stats = await fs.promises.stat(safePath);
        if (stats.isDirectory()) {
          logger.warn('Cannot attach directory', { filename });
          continue;
        }

        PathValidator.validateFileSize(stats.size, config.maxFileSize);

        const ext = '.' + filename.split('.').pop()?.toLowerCase() || '';
        const contentType = this.getContentTypeByExtension(ext);

        attachments.push({
          timestamp: new Date().toISOString(),
          filename,
          path: safePath,
          contentType
        });

        logger.info('File attached via command', { filename, size: stats.size });
      } catch (error) {
        if (error instanceof Error && error.name === 'SecurityError') {
          logger.error('Security violation in attachment command', { filename, error: error.message });
          hasSecurityViolation = true;
          continue;
        }
        logger.error('Failed to attach file', { filename, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    if (hasSecurityViolation) {
      return {
        success: false,
        error: 'Security violation detected during attachment processing'
      };
    }

    if (attachments.length === 0) {
      return {
        success: false,
        error: 'No valid files could be attached'
      };
    }

    // If full command context is provided (with smtpService), handle email sending
    if (context.smtpService && context.email) {
      await this.sendCommandBasedEmail(context, attachments);
    }

    return {
      success: true,
      attachments
    };
  }

  private async sendCommandBasedEmail(
    context: CommandContext,
    attachments: Array<{ timestamp: string; filename: string; path: string; contentType: string }>
  ): Promise<void> {
    const { smtpService, opencodeService, storage, cleanedBody, replyConfig, email } = context;

    if (!smtpService || !email) {
      logger.warn('Cannot send command-based email: missing smtpService or email');
      return;
    }

    let replyText: string;

    // If cleaned body is empty, send a simple message with attachments
    if (!cleanedBody || cleanedBody.trim().length === 0) {
      logger.info('Email body is empty after command extraction, sending simple reply');
      replyText = `I've attached ${attachments.length} file(s) as requested.`;
    } else {
      // Generate reply text based on cleaned body
      if (replyConfig?.mode === 'opencode' && opencodeService) {
        logger.info('Generating AI reply for command-based email');
        const modifiedEmail = {
          ...email,
          body: {
            ...email.body,
            text: cleanedBody
          }
        };
        const aiReply = await opencodeService.generateReply(modifiedEmail, context.threadPath);
        replyText = aiReply.text;

        if (!replyText || replyText.trim().length === 0) {
          logger.warn('Generated reply is empty, sending simple reply');
          replyText = `I've attached ${attachments.length} file(s) as requested.`;
        }

        if (storage) {
          await storage.storeReply(context.threadPath, replyText, email);
        }
      } else if (replyConfig?.mode === 'static') {
        replyText = replyConfig.text || `I've attached ${attachments.length} file(s) as requested.`;
      } else {
        replyText = `I've attached ${attachments.length} file(s) as requested.`;
      }
    }

    const smtpAttachments = attachments.map(att => ({
      filename: att.filename,
      path: att.path,
      contentType: att.contentType
    }));

    await smtpService.replyToEmail(email, replyText, smtpAttachments);
    logger.info('Command-based email sent with attachments', {
      to: email.from,
      subject: email.subject,
      attachmentCount: attachments.length
    });
  }

  private getContentTypeByExtension(ext: string): string {
    const extensionsToTypes: Record<string, string> = {
      '.ppt': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
    };
    return extensionsToTypes[ext] || 'application/octet-stream';
  }
}
