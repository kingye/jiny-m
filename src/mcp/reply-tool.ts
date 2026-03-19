#!/usr/bin/env bun
/**
 * MCP Reply Tool - Stateless MCP server for email replies.
 *
 * Spawned by OpenCode via stdio transport. Provides a `reply_email` tool
 * that sends email replies scoped to a specific thread.
 *
 * Context (recipient, subject, threading headers, thread name) is passed
 * as a JSON string parameter validated with HMAC-SHA256.
 *
 * Reuses existing project modules: SmtpService, EmailStorage, PathValidator, ConfigManager.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join, resolve, normalize } from 'node:path';
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
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown validation error';
      return {
        content: [{ type: 'text' as const, text: `Error: Context validation failed - ${msg}` }],
        isError: true,
      };
    }

    // 2. Validate message is non-empty
    if (!message || message.trim().length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Message cannot be empty' }],
        isError: true,
      };
    }

    // 3. Load config via ConfigManager (reuses ${ENV_VAR} expansion)
    let config;
    try {
      const configManager = await ConfigManager.create();
      config = configManager.getConfig();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
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

    // 4. Compose threadPath from workspace.folder + threadName
    const workspaceFolder = join(process.cwd(), config.workspace.folder);
    const threadPath = join(workspaceFolder, emailContext.threadName);

    // Verify threadPath exists and is within workspace
    const normalizedThread = normalize(threadPath);
    const normalizedWorkspace = normalize(workspaceFolder);
    if (!normalizedThread.startsWith(normalizedWorkspace)) {
      return {
        content: [{ type: 'text' as const, text: 'Error: Thread name resolves outside workspace directory' }],
        isError: true,
      };
    }

    try {
      const threadStat = await stat(threadPath);
      if (!threadStat.isDirectory()) {
        return {
          content: [{ type: 'text' as const, text: `Error: Thread path is not a directory: ${emailContext.threadName}` }],
          isError: true,
        };
      }
    } catch {
      return {
        content: [{ type: 'text' as const, text: `Error: Thread directory does not exist: ${emailContext.threadName}` }],
        isError: true,
      };
    }

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
          const relativePath = normalize(safePath).slice(normalizedThread.length + 1);
          const pathSegments = relativePath.split('/');
          const isExcluded = pathSegments.some(segment => EXCLUDED_DIRS.includes(segment));
          if (isExcluded) {
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
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
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
    } catch (error) {
      // Non-fatal: email was already sent, just log the storage failure
      log('ERROR', 'Failed to store reply after sending', {
        error: error instanceof Error ? error.message : 'Unknown',
        threadPath,
      });
    }

    // 9. Return success
    const result = {
      success: true,
      sentTo: emailContext.to,
      subject: emailContext.subject,
      messageId: sentMessageId,
      attachmentCount: validatedAttachments.length,
      attachments: validatedAttachments.map(a => a.filename),
    };

    return {
      content: [{
        type: 'text' as const,
        text: `Email reply sent successfully to ${result.sentTo}` +
          (result.attachmentCount > 0 ? ` with ${result.attachmentCount} attachment(s): ${result.attachments.join(', ')}` : ''),
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
  log('INFO', 'MCP Reply Tool starting', { cwd: process.cwd(), pid: process.pid });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('INFO', 'MCP Reply Tool connected to transport');
}

main().catch((error) => {
  console.error('MCP Reply Tool failed to start:', error);
  process.exit(1);
});
