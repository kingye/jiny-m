#!/usr/bin/env bun
/**
 * MCP Reply Tool - Stateless MCP server for channel-agnostic message replies.
 *
 * Spawned by OpenCode via stdio transport, one instance per thread.
 * OpenCode sets the subprocess cwd to the thread directory.
 * JINY_ROOT env var points to the project root for config loading.
 *
 * Provides a `reply_message` tool that sends replies through the originating
 * channel (email, feishu, etc.) based on the context.channel field.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join, normalize } from 'node:path';
import { stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';

import { deserializeContext, contextToInboundMessage } from './context';
import type { ReplyContext } from './context';
import type { OutboundAdapter, InboundMessage } from '../channels/types';
import { ConfigManager } from '../config';
import { MessageStorage } from '../core/message-storage';
import { PathValidator } from '../core/security';

// Email-specific imports (loaded on demand when channel is "email")
import { SmtpService } from '../services/smtp';
import { EmailOutboundAdapter } from '../channels/email/outbound';

const EXCLUDED_DIRS = ['.opencode', '.jiny'];

// File-based logging since stdout is used for MCP protocol.
let LOG_FILE = '/tmp/jiny-mcp-reply-tool.log';
function initLogFile() {
  try {
    const jinyDir = join(process.cwd(), '.jiny');
    mkdirSync(jinyDir, { recursive: true });
    LOG_FILE = join(jinyDir, 'reply-tool.log');
  } catch {
    // keep fallback
  }
}
initLogFile();

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
  'reply_message',
  'Send a reply message back through the originating channel. Handles quoting, threading, and reply storage. Attachments must be files within the thread directory (excluding .opencode and .jiny directories).',
  {
    message: z.string().describe('The reply text to send'),
    context: z.string().describe('The opaque context token from the <reply_context> block. Pass it exactly as-is.'),
    attachments: z.array(z.string()).optional().describe('Optional list of filenames within the thread directory to attach'),
  },
  async ({ message, context: contextToken, attachments: attachmentFilenames }) => {
    log('INFO', 'reply_message tool called', {
      messageLength: message?.length,
      messagePreview: message ? message.substring(0, 100) : '(empty)',
      hasContext: !!contextToken,
      contextLength: contextToken?.length || 0,
      attachments: attachmentFilenames || [],
      cwd: process.cwd(),
      JINY_ROOT: process.env.JINY_ROOT || 'not set',
    });

    try {
      const result = await handleReplyMessage(message, contextToken, attachmentFilenames);
      // Log final outcome clearly
      const isError = result.isError === true;
      const text = result.content?.[0]?.text || '';
      if (isError) {
        log('ERROR', 'reply_message FAILED', { error: text });
      }
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      const stack = error instanceof Error ? error.stack : undefined;
      log('ERROR', 'reply_message FAILED (unhandled)', { error: msg, stack });
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

async function handleReplyMessage(
  message: string,
  contextToken: string,
  attachmentFilenames?: string[],
) {
  // 1. Decode and validate context (base64 → JSON → ReplyContext)
  let replyContext: ReplyContext;
  try {
    replyContext = deserializeContext(contextToken);
    log('INFO', 'Context validated', {
      channel: replyContext.channel,
      recipient: replyContext.recipient,
      sender: replyContext.sender,
      topic: replyContext.topic,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown validation error';
    log('ERROR', 'Context validation failed', {
      error: msg,
      contextLength: contextToken?.length,
      contextPreview: contextToken?.substring(0, 100),
    });
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
    log('INFO', 'Config loaded', { configPath });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    log('ERROR', 'Failed to load config', { error: msg, rootDir });
    return {
      content: [{ type: 'text' as const, text: `Error: Failed to load config - ${msg}` }],
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
        const safePath = PathValidator.validateFilePath(threadPath, filename);

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

        validatedAttachments.push({ filename, path: safePath, contentType });
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

  // 6. Reconstruct InboundMessage from context
  const originalMessage = contextToInboundMessage(replyContext);

  // 7. Load full message body from stored received.md for quoted history.
  const incomingDir = replyContext.incomingMessageDir;
  if (incomingDir) {
    try {
      let mdPath = join(threadPath, 'messages', incomingDir, 'received.md');
      let mdContent: string;
      try {
        mdContent = await readFile(mdPath, 'utf-8');
      } catch {
        // Fallback: legacy .jiny/ path
        mdPath = join(threadPath, '.jiny', incomingDir);
        mdContent = await readFile(mdPath, 'utf-8');
      }
      const fullBody = extractBodyFromMd(mdContent);
      if (fullBody) {
        originalMessage.content.text = fullBody;
        log('INFO', 'Loaded full body from stored message', { path: mdPath, bodyLength: fullBody.length });
      } else {
        log('WARN', 'Could not extract body from stored message, using context preview', { path: mdPath });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log('WARN', 'Failed to read stored message, using context preview as fallback', { incomingDir, error: msg });
    }
  }

  // 8. Instantiate outbound adapter based on channel type
  let outboundAdapter: OutboundAdapter;
  try {
    outboundAdapter = createOutboundAdapter(replyContext.channel, config);
    await outboundAdapter.connect();
    log('INFO', 'Outbound adapter created', { channel: replyContext.channel });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    log('ERROR', 'Failed to create outbound adapter', { channel: replyContext.channel, error: msg });
    return {
      content: [{ type: 'text' as const, text: `Error: Failed to create ${replyContext.channel} outbound adapter - ${msg}` }],
      isError: true,
    };
  }

  // 9. Send reply via outbound adapter
  log('INFO', 'Sending reply', {
    channel: replyContext.channel,
    recipient: replyContext.recipient,
    topic: replyContext.topic,
    messageLength: message.length,
    attachmentCount: validatedAttachments.length,
  });

  let sentMessageId: string;
  try {
    const result = await outboundAdapter.sendReply(
      originalMessage,
      message,
      validatedAttachments.length > 0 ? validatedAttachments : undefined,
    );
    sentMessageId = result.messageId;
    log('INFO', 'Reply sent', { channel: replyContext.channel, messageId: sentMessageId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    log('ERROR', 'Send failed', { channel: replyContext.channel, error: msg });
    return {
      content: [{ type: 'text' as const, text: `Error: Failed to send reply via ${replyContext.channel} - ${msg}` }],
      isError: true,
    };
  } finally {
    await outboundAdapter.disconnect().catch(() => {});
  }

  // 10. Store reply in thread folder
  try {
    const storage = new MessageStorage(config.workspace);
    await storage.storeReply(threadPath, message, replyContext.incomingMessageDir);
    log('INFO', 'Reply stored', { threadPath });
  } catch (error) {
    log('ERROR', 'Failed to store reply after sending', {
      error: error instanceof Error ? error.message : 'Unknown',
      threadPath,
    });
  }

  // 11. Write signal file
  try {
    const jinyDir = join(threadPath, '.jiny');
    await mkdir(jinyDir, { recursive: true });
    const signalFile = join(jinyDir, 'reply-sent.flag');
    const signalData = JSON.stringify({
      sentAt: new Date().toISOString(),
      channel: replyContext.channel,
      recipient: replyContext.recipient,
      messageId: sentMessageId,
      attachmentCount: validatedAttachments.length,
    });
    await writeFile(signalFile, signalData, 'utf-8');
    log('INFO', 'Signal file written', { signalFile });
  } catch (error) {
    log('WARN', 'Failed to write signal file', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
  }

  // 12. Return success
  log('INFO', 'reply_message completed successfully', {
    channel: replyContext.channel,
    recipient: replyContext.recipient,
    attachmentCount: validatedAttachments.length,
  });

  return {
    content: [{
      type: 'text' as const,
      text: `Reply sent successfully via ${replyContext.channel} to ${replyContext.recipient}` +
        (validatedAttachments.length > 0 ? ` with ${validatedAttachments.length} attachment(s): ${validatedAttachments.map(a => a.filename).join(', ')}` : ''),
    }],
  };
}

/**
 * Create an outbound adapter based on channel type.
 * Loads channel-specific config from the project config.
 */
function createOutboundAdapter(channel: string, config: any): OutboundAdapter {
  switch (channel) {
    case 'email': {
      // Support both new (channels.email.outbound) and legacy (smtp) config
      const smtpConfig = config.channels?.email?.outbound || config.smtp;
      if (!smtpConfig) {
        throw new Error('SMTP/email outbound configuration not found in config');
      }
      return new EmailOutboundAdapter(smtpConfig);
    }
    // Future channels:
    // case 'feishu': { ... }
    // case 'slack': { ... }
    default:
      throw new Error(`Unsupported channel type: ${channel}`);
  }
}

/**
 * Extract message body from a stored received.md file.
 */
function extractBodyFromMd(mdContent: string): string | null {
  const lines = mdContent.split('\n');
  let inFrontmatter = false;
  let pastFrontmatter = false;
  let foundHeader = false;
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (!pastFrontmatter) {
      if (line.trimEnd() === '---') {
        if (inFrontmatter) {
          pastFrontmatter = true;
          inFrontmatter = false;
        } else {
          inFrontmatter = true;
        }
      }
      continue;
    }

    if (!foundHeader) {
      if (line.startsWith('## ') && /\(\d{1,2}:\d{2}\s*(AM|PM)?\)/.test(line)) {
        foundHeader = true;
      }
      continue;
    }

    if (line.trimEnd() === '---' || line.trimEnd() === '--- ') {
      break;
    }

    bodyLines.push(line);
  }

  if (!foundHeader || bodyLines.length === 0) return null;

  const body = bodyLines.join('\n').trim();
  return body.length > 0 ? body : null;
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

// Start the MCP server
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
