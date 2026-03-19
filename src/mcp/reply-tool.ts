#!/usr/bin/env bun
/**
 * MCP Reply Tool - Stateless MCP server for email replies.
 *
 * Spawned by OpenCode via stdio transport, one instance per thread.
 * OpenCode sets the subprocess cwd to the thread directory.
 * JINY_ROOT env var points to the project root for config loading.
 *
 * Provides a `reply_email` tool that sends email replies scoped to the current thread.
 * Reuses existing project modules: SmtpService, EmailStorage, PathValidator, ConfigManager.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join, normalize } from 'node:path';
import { stat } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';

import { deserializeAndValidateContext, contextToEmail } from './context';
import { ConfigManager } from '../config';
import { SmtpService } from '../services/smtp';
import { EmailStorage } from '../services/storage';
import { PathValidator } from '../core/security';

const EXCLUDED_DIRS = ['.opencode', '.jiny'];

// File-based logging since stdout is used for MCP protocol
const LOG_FILE = '/tmp/jiny-mcp-reply-tool.log';
function log(level: string, msg: string, data?: Record<string, unknown>) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore logging failures
  }
}

const server = new McpServer({
  name: 'jiny_reply',
  version: '1.0.0',
});

server.tool(
  'reply_email',
  'Send an email reply scoped to the current thread. The tool handles quoted mail history, SMTP sending, and reply storage. Attachments must be files within the thread directory (excluding .opencode and .jiny directories).',
  {
    message: z.string().describe('The reply text to send to the email sender'),
    context: z.string().describe('The <reply_context> JSON block from the prompt. Pass it verbatim without modification.'),
    attachments: z.array(z.string()).optional().describe('Optional list of filenames within the thread directory to attach to the reply'),
  },
  async ({ message, context: contextJson, attachments: attachmentFilenames }) => {
    log('INFO', 'reply_email tool called', {
      messageLength: message?.length,
      hasContext: !!contextJson,
      attachments: attachmentFilenames || [],
      cwd: process.cwd(),
      JINY_ROOT: process.env.JINY_ROOT || 'not set',
    });

    try {
      return await handleReplyEmail(message, contextJson, attachmentFilenames);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      const stack = error instanceof Error ? error.stack : undefined;
      log('ERROR', 'Unhandled error in reply_email', { error: msg, stack });
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

async function handleReplyEmail(
  message: string,
  contextJson: string,
  attachmentFilenames?: string[],
) {
  // 1. Validate context
  let emailContext;
  try {
    emailContext = deserializeAndValidateContext(contextJson);
    log('INFO', 'Context validated', { to: emailContext.to, from: emailContext.from, subject: emailContext.subject });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown validation error';
    log('ERROR', 'Context validation failed', { error: msg });
    return {
      content: [{ type: 'text' as const, text: `Error: Context validation failed - ${msg}` }],
      isError: true,
    };
  }

  // 2. Validate message is non-empty
  if (!message || message.trim().length === 0) {
    log('ERROR', 'Empty message');
    return {
      content: [{ type: 'text' as const, text: 'Error: Message cannot be empty' }],
      isError: true,
    };
  }

  // 3. Load config from project root via JINY_ROOT
  const rootDir = process.env.JINY_ROOT;
  if (!rootDir) {
    log('ERROR', 'JINY_ROOT not set');
    return {
      content: [{ type: 'text' as const, text: 'Error: JINY_ROOT environment variable is not set' }],
      isError: true,
    };
  }

  let config;
  try {
    const configPath = join(rootDir, '.jiny', 'config.json');
    const configManager = new ConfigManager(configPath);
    await configManager.load();
    config = configManager.getConfig();
    log('INFO', 'Config loaded', { configPath, hasSmtp: !!config.smtp });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    log('ERROR', 'Failed to load config', { error: msg, rootDir });
    return {
      content: [{ type: 'text' as const, text: `Error: Failed to load config - ${msg}` }],
      isError: true,
    };
  }

  if (!config.smtp) {
    return {
      content: [{ type: 'text' as const, text: 'Error: SMTP configuration is not defined in config' }],
      isError: true,
    };
  }

  // 4. Thread path = cwd (set by OpenCode to the thread directory)
  const threadPath = process.cwd();
  log('INFO', 'Using thread path from cwd', { threadPath });

  // 5. Validate attachments if provided
  const validatedAttachments: Array<{ filename: string; path: string; contentType: string }> = [];

  if (attachmentFilenames && attachmentFilenames.length > 0) {
    const attachmentConfig = config.reply.attachments;
    const allowedExtensions = attachmentConfig?.allowedExtensions || ['.ppt', '.pptx', '.doc', '.docx', '.txt', '.md'];
    const maxFileSize = attachmentConfig?.maxFileSize || 10 * 1024 * 1024;

    for (const filename of attachmentFilenames) {
      try {
        // PathValidator checks: traversal, null bytes, hidden files, extension
        const safePath = PathValidator.validateFilePath(threadPath, filename);

        // Check that the resolved path does not land in excluded directories
        const normalizedSafe = normalize(safePath);
        const normalizedThread = normalize(threadPath);
        const relativePath = normalizedSafe.slice(normalizedThread.length + 1);
        const pathSegments = relativePath.split('/');
        const isExcluded = pathSegments.some(segment => EXCLUDED_DIRS.includes(segment));
        if (isExcluded) {
          log('ERROR', 'Attachment in excluded directory', { filename, relativePath });
          return {
            content: [{ type: 'text' as const, text: `Error: Cannot attach files from excluded directories (${EXCLUDED_DIRS.join(', ')}): ${filename}` }],
            isError: true,
          };
        }

        PathValidator.validateExtension(filename, allowedExtensions);

        const fileStat = await stat(safePath);
        if (fileStat.isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `Error: Cannot attach a directory: ${filename}` }],
            isError: true,
          };
        }

        PathValidator.validateFileSize(fileStat.size, maxFileSize);

        const ext = '.' + (filename.split('.').pop()?.toLowerCase() || '');
        const contentType = getContentType(ext);

        validatedAttachments.push({
          filename,
          path: safePath,
          contentType,
        });
        log('INFO', 'Attachment validated', { filename, safePath, contentType, size: fileStat.size });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        log('ERROR', 'Attachment validation failed', { filename, error: msg });
        return {
          content: [{ type: 'text' as const, text: `Error: Attachment validation failed for "${filename}" - ${msg}` }],
          isError: true,
        };
      }
    }
  }

  // 6. Reconstruct Email object from context
  const email = contextToEmail(emailContext);

  // 7. Send reply via SmtpService (reuses quoteOriginalEmail, threading headers, HTML conversion)
  log('INFO', 'Sending reply via SMTP', {
    to: emailContext.to,
    subject: emailContext.subject,
    messageLength: message.length,
    attachmentCount: validatedAttachments.length,
    attachments: validatedAttachments.map(a => a.filename),
  });

  const smtpService = new SmtpService(config.smtp);
  let sentMessageId: string;
  try {
    await smtpService.connect();
    sentMessageId = await smtpService.replyToEmail(
      email,
      message,
      validatedAttachments.length > 0 ? validatedAttachments : undefined,
    );
    log('INFO', 'SMTP reply sent', { messageId: sentMessageId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    log('ERROR', 'SMTP send failed', { error: msg });
    return {
      content: [{ type: 'text' as const, text: `Error: Failed to send email - ${msg}` }],
      isError: true,
    };
  } finally {
    await smtpService.disconnect().catch(() => {});
  }

  // 8. Store reply in thread folder (reuses auto-reply.md format)
  try {
    const storage = new EmailStorage(config.workspace);
    await storage.storeReply(threadPath, message, email);
    log('INFO', 'Reply stored', { threadPath });
  } catch (error) {
    // Non-fatal: email was already sent, just log the storage failure
    log('ERROR', 'Failed to store reply after sending', {
      error: error instanceof Error ? error.message : 'Unknown',
      threadPath,
    });
  }

  // 9. Return success
  log('INFO', 'reply_email completed successfully', {
    sentTo: emailContext.to,
    attachmentCount: validatedAttachments.length,
  });

  return {
    content: [{
      type: 'text' as const,
      text: `Email reply sent successfully to ${emailContext.to}` +
        (validatedAttachments.length > 0 ? ` with ${validatedAttachments.length} attachment(s): ${validatedAttachments.map(a => a.filename).join(', ')}` : ''),
    }],
  };
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    '.ppt': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.csv': 'text/csv',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[ext] || 'application/octet-stream';
}

// Start the MCP server with stdio transport
async function main() {
  log('INFO', 'MCP Reply Tool starting', {
    cwd: process.cwd(),
    JINY_ROOT: process.env.JINY_ROOT || 'not set',
    pid: process.pid,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('INFO', 'MCP Reply Tool connected to transport');
}

main().catch((error) => {
  log('ERROR', 'MCP Reply Tool failed to start', { error: error?.message });
  process.exit(1);
});
