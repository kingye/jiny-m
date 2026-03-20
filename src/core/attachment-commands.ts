import { join } from 'node:path';
import type { GeneratedFile, AttachmentConfig } from '../types/index';
import { logger } from './logger';
import { parseFileSize } from '../utils/helpers';

export function extractAttachmentCommands(text: string): string[] {
  const commands: string[] = [];
  const lines = text.split('\n');
  let currentCommand: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.toLowerCase().startsWith('/attach')) {
      const parts = trimmed.split(/\s+/);
      for (let i = 1; i < parts.length; i++) {
        const filename = parts[i]?.trim() || '';
        if (filename.length > 0) {
          commands.push(filename);
        }
      }
      currentCommand = [];
    } else if (trimmed.length > 0 && currentCommand.length > 0) {
      currentCommand.push(trimmed);
    } else {
      currentCommand = [];
    }
  }

  logger.debug('Extracted attachment commands from email body', {
    count: commands.length,
    commands: commands.join(', '),
  });

  return commands;
}

export interface PreparedAttachment {
  timestamp: string;
  filename: string;
  path: string;
  contentType: string;
}

export async function prepareCommandAttachments(
  commands: string,
  threadPath: string,
  attachmentConfig: AttachmentConfig | undefined,
): Promise<PreparedAttachment[]> {
  if (commands.trim().length === 0 || !attachmentConfig || !attachmentConfig.enabled) {
    return [];
  }

  const fs = await import('node:fs');
  const attachments: PreparedAttachment[] = [];

  const commandNames = commands.split(',').map(c => c.trim()).filter(Boolean);

  for (const filename of commandNames) {
    if (filename.length === 0) continue;

    const filePath = join(threadPath, filename);

    try {
      const fileExists = await fs.promises
        .access(filePath)
        .then(() => true)
        .catch(() => false);
      if (!fileExists) {
        logger.warn('Cannot find file for attachment command', { filename });
        continue;
      }

      const stats = await fs.promises.stat(filePath);

      if (stats.isDirectory()) {
        logger.warn('Cannot attach directory via command', { filename });
        continue;
      }

      if (stats.size > parseFileSize(attachmentConfig.maxFileSize)) {
        logger.warn('File exceeds size limit', { filename, size: stats.size, maxSize: parseFileSize(attachmentConfig.maxFileSize) });
        continue;
      }

      const ext = '.' + filename.split('.').pop()?.toLowerCase() || '';
      if (!attachmentConfig.allowedExtensions.includes(ext)) {
        logger.debug('File extension not in allowed list, skipping', { filename, ext });
        continue;
      }

      const contentType = getContentTypeByExtension(ext);

      attachments.push({
        timestamp: new Date().toISOString(),
        filename,
        path: filePath,
        contentType,
      });
      logger.info('Will attach file via command', { filename });
    } catch (error) {
      logger.error('Failed to prepare command attachment', { filename, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  return attachments;
}

function getContentTypeByExtension(ext: string): string {
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
