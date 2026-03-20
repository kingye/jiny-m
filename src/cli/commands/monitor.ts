/**
 * Monitor command — wires channel adapters, router, and thread manager.
 *
 * This is the main entry point for the jiny-m monitor. It:
 * 1. Loads config and creates the channel registry
 * 2. Registers email channel adapters (inbound IMAP + outbound SMTP)
 * 3. Creates MessageStorage, OpenCodeService, ThreadManager, MessageRouter
 * 4. Starts all inbound adapters (fire-and-forget message delivery)
 */

import { ConfigManager } from '../../config';
import { ChannelRegistry } from '../../channels/registry';
import { EmailInboundAdapter } from '../../channels/email/inbound';
import { EmailOutboundAdapter } from '../../channels/email/outbound';
import { MessageStorage } from '../../core/message-storage';
import { MessageRouter } from '../../core/message-router';
import { ThreadManager } from '../../core/thread-manager';
import { OpenCodeService } from '../../services/opencode';
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

let activeAdapters: Array<{ stop: () => Promise<void> }> = [];

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

    logger.info('Starting monitor...');

    // 1. Load config
    const configManager = await ConfigManager.create(options.config);
    const config = configManager.getConfig();
    const channelPatterns = configManager.getChannelPatterns();
    logger.info(`Loaded configuration with ${channelPatterns.length} pattern(s)`);

    // 2. Create channel registry
    const registry = new ChannelRegistry();

    // 3. Register email channel (if configured)
    const emailConfig = configManager.getEmailChannelConfig();
    if (emailConfig) {
      const watchConfig = configManager.getEffectiveWatchConfig();

      // Inbound adapter (IMAP)
      const emailInbound = new EmailInboundAdapter(
        emailConfig.inbound,
        watchConfig,
        {
          outputConfig: configManager.getOutputConfig(),
          verbose: options.verbose,
          debug: options.debug,
        },
      );
      registry.registerInbound(emailInbound);

      // Outbound adapter (SMTP) — only if reply is enabled
      const replyConfig = configManager.getReplyConfig();
      if (replyConfig.enabled && emailConfig.outbound) {
        const emailOutbound = new EmailOutboundAdapter(emailConfig.outbound);
        try {
          await emailOutbound.connect();
          registry.registerOutbound(emailOutbound);
          logger.info('Email outbound (SMTP) ready');
        } catch (error) {
          logger.error('Failed to connect email outbound (SMTP)', {
            error: error instanceof Error ? error.message : 'Unknown',
          });
        }
      }
    }

    if (registry.getAllInbound().length === 0) {
      logger.warn('No inbound channels configured. Nothing to monitor.');
      return;
    }

    // 4. Create storage
    const workspaceConfig = configManager.getWorkspaceConfig();
    const storage = new MessageStorage(workspaceConfig);
    await storage.init();

    // 5. Create OpenCode service (if opencode mode)
    const replyConfig = configManager.getReplyConfig();
    if (replyConfig.enabled && replyConfig.mode === 'opencode' && replyConfig.opencode) {
      opencodeService = new OpenCodeService(replyConfig.opencode);
      logger.info('OpenCode AI service initialized');
    }

    // 6. Create ThreadManager
    const threadManager = new ThreadManager({
      storage,
      opencode: opencodeService,
      channelRegistry: registry,
      replyConfig,
      workerConfig: config.worker,
    });

    // 7. Create MessageRouter
    const router = new MessageRouter({
      channelRegistry: registry,
      threadManager,
      patterns: channelPatterns,
    });

    // 8. Create formatter for display
    const outputConfig = configManager.getOutputConfig();
    const formatter = new OutputFormatter({
      format: outputConfig.format,
      includeHeaders: outputConfig.includeHeaders,
      includeAttachments: outputConfig.includeAttachments,
      truncateLength: outputConfig.truncateLength,
    });

    // 9. Start all inbound adapters
    for (const adapter of registry.getAllInbound()) {
      await adapter.start({
        onMessage: async (message) => {
          // Display the message
          // (For email, we'd format it — for now just log)
          logger.info('Message received', {
            channel: message.channel,
            sender: message.senderAddress,
            topic: message.topic.substring(0, 80),
          });

          // Route to ThreadManager (fire-and-forget)
          await router.handleMessage(message);
        },
        onError: (error) => {
          logger.error('Inbound adapter error', {
            channel: adapter.channelType,
            error: error.message,
          });
        },
      });

      activeAdapters.push(adapter);
      logger.info('Inbound adapter started', { channel: adapter.channelType });
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Monitor command failed', { error: errorMessage });
    process.exit(1);
  } finally {
    // Cleanup is handled by process exit handlers
    // The adapters and OpenCode service will be cleaned up
  }
}

// Graceful shutdown handler
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  for (const adapter of activeAdapters) {
    try { await adapter.stop(); } catch {}
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  for (const adapter of activeAdapters) {
    try { await adapter.stop(); } catch {}
  }
  process.exit(0);
});
