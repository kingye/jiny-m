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
import { AlertService } from '../../core/alert-service';
import { OutputFormatter } from '../../output';
import { logger } from '../../core/logger';
import { StateManager } from '../../core/state-manager';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import pkg from '../../../package.json';

export interface MonitorCommandOptions {
  config?: string;
  once?: boolean;
  noIdle?: boolean;
  verbose?: boolean;
  debug?: boolean;
  reset?: boolean;
}

let activeAdapters: Array<{ stop: () => Promise<void> }> = [];
let activeAlertService: AlertService | null = null;
let shutdownCleanup: (() => Promise<void>) | null = null;

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

    logger.info(`Starting jiny-m v${pkg.version}`);

    // 1. Load config
    const configManager = await ConfigManager.create(options.config);
    const config = configManager.getConfig();
    const channelPatterns = configManager.getChannelPatterns();
    logger.info(`Loaded configuration with ${channelPatterns.length} pattern(s)`);

    // 2. Create channel registry
    const registry = new ChannelRegistry();

    // 3. Register all configured channels
    const allChannels = configManager.getAllChannels();
    const channelNames = Object.keys(allChannels);

    for (const channelName of channelNames) {
      const channelConfig = allChannels[channelName];
      if (!channelConfig || channelConfig.type !== 'email') continue;
      if (!channelConfig.inbound && !channelConfig.outbound) continue;

      logger.info(`Setting up channel: ${channelName}`);

      // Get channel-specific watch config
      const watchConfig = configManager.getEffectiveWatchConfig(channelName);

      // Inbound adapter (IMAP)
      if (channelConfig.inbound) {
        const emailInbound = new EmailInboundAdapter(
          channelName,
          channelConfig.inbound,
          watchConfig,
          {
            outputConfig: configManager.getOutputConfig(),
            verbose: options.verbose,
            debug: options.debug,
          },
        );
        registry.registerInbound(emailInbound);
        logger.info(`Email inbound adapter registered for channel: ${channelName}`);
      }

      // Outbound adapter (SMTP) — needed for reply and/or alerting
      const replyConfig = configManager.getReplyConfig();
      const alertingConfig = configManager.getAlertingConfig();
      const needsOutbound = (replyConfig.enabled || alertingConfig?.enabled) && channelConfig.outbound;

      if (needsOutbound && channelConfig.outbound) {
        const emailOutbound = new EmailOutboundAdapter(channelName, channelConfig.outbound);
        try {
          await emailOutbound.connect();
          registry.registerOutbound(emailOutbound);
          logger.info(`Email outbound (SMTP) ready for channel: ${channelName}`);
        } catch (error) {
          logger.error('Failed to connect email outbound (SMTP)', {
            channel: channelName,
            error: error instanceof Error ? error.message : 'Unknown',
          });
        }
      }
    }

    // Legacy support: also check for single-channel config via getEmailChannelConfig
    if (registry.getAllInbound().length === 0) {
      const emailConfig = configManager.getEmailChannelConfig();
      if (emailConfig) {
        const watchConfig = configManager.getEffectiveWatchConfig();

        const emailInbound = new EmailInboundAdapter(
          'email',
          emailConfig.inbound,
          watchConfig,
          {
            outputConfig: configManager.getOutputConfig(),
            verbose: options.verbose,
            debug: options.debug,
          },
        );
        registry.registerInbound(emailInbound);

        const replyConfig = configManager.getReplyConfig();
        const alertingConfig = configManager.getAlertingConfig();
        if ((replyConfig.enabled || alertingConfig?.enabled) && emailConfig.outbound) {
          const emailOutbound = new EmailOutboundAdapter('email', emailConfig.outbound);
          try {
            await emailOutbound.connect();
            registry.registerOutbound(emailOutbound);
          } catch (error) {
            logger.error('Failed to connect email outbound (SMTP)', {
              error: error instanceof Error ? error.message : 'Unknown',
            });
          }
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

    // 4b. Initialize channel-specific workspaces
    for (const channelName of channelNames) {
      const channelConfig = allChannels[channelName];
      if (channelConfig?.workspace) {
        storage.setChannelWorkspace(channelName, channelConfig.workspace);
      }
      await storage.initChannelWorkspace(channelName);
    }

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

    // 8. Start AlertService (if configured, now that ThreadManager exists for queue stats)
    const alertingConfig = configManager.getAlertingConfig();
    if (alertingConfig?.enabled) {
      try {
        // Get the first available outbound adapter for alerting
        const outboundAdapters = registry.getAllOutbound();
        const emailOutbound = outboundAdapters[0];
        if (!emailOutbound) throw new Error('No outbound adapters available');
        const workspaceFolder = configManager.getWorkspaceConfig().folder;
        const alertService = new AlertService(emailOutbound, alertingConfig, workspaceFolder, threadManager);
        alertService.start();
        activeAlertService = alertService;
      } catch {
        logger.warn('AlertService not started: no email outbound adapter registered', {
          _alertInternal: true,
        });
      }
    }

    // 9. Create formatter for display
    const outputConfig = configManager.getOutputConfig();
    const formatter = new OutputFormatter({
      format: outputConfig.format,
      includeHeaders: outputConfig.includeHeaders,
      includeAttachments: outputConfig.includeAttachments,
      truncateLength: outputConfig.truncateLength,
    });

    // 9. Send startup notification email (before starting inbound adapters which block)
    if (activeAlertService && alertingConfig?.enabled) {
      try {
        const outboundAdapters = registry.getAllOutbound();
        const emailOutbound = outboundAdapters[0];
        if (emailOutbound?.sendAlert) {
          const recipient = alertingConfig.healthCheck?.recipient || alertingConfig.recipient;
          const subject = `${alertingConfig.subjectPrefix || 'Jiny-M'}: Started v${pkg.version}`;
          const body = [
            `Jiny-M Monitor Started`,
            `======================`,
            ``,
            `Version: ${pkg.version}`,
            `Time: ${new Date().toISOString()}`,
            `Status: Ready`,
          ].join('\n');
          await emailOutbound.sendAlert(recipient, subject, body);
          logger.info('Startup notification sent', { recipient, version: pkg.version, _alertInternal: true });
        }
      } catch (err) {
        logger.warn('Failed to send startup notification', {
          error: err instanceof Error ? err.message : 'Unknown',
          _alertInternal: true,
        });
      }
    }

    // 10. Start all inbound adapters (blocks — starts monitoring loop)
    // 10. Start all inbound adapters concurrently (each blocks in its own monitoring loop)
    const adapterPromises = registry.getAllInbound().map(adapter => {
      const promise = adapter.start({
        onMessage: async (message) => {
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
      logger.info('Inbound adapter started', { channel: adapter.channelName, type: adapter.channelType });
      return promise;
    });

    // Wait for all adapters (they block until stopped)
    await Promise.all(adapterPromises);

    // 11. Register shutdown cleanup (delete session files to prevent stale sessions on restart)
    shutdownCleanup = async () => {
      try {
        const entries = await readdir(workspaceConfig.folder, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const sessionFile = join(workspaceConfig.folder, entry.name, '.jiny', 'session.json');
          try {
            await unlink(sessionFile);
            logger.debug('Deleted session file on shutdown', { thread: entry.name });
          } catch {
            // File doesn't exist — fine
          }
        }
      } catch {
        // Workspace dir may not exist — fine
      }
    };

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
  if (activeAlertService) {
    try { await activeAlertService.stop(); } catch {}
    activeAlertService = null;
  }
  if (shutdownCleanup) {
    try { await shutdownCleanup(); } catch {}
  }
  for (const adapter of activeAdapters) {
    try { await adapter.stop(); } catch {}
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  if (activeAlertService) {
    try { await activeAlertService.stop(); } catch {}
    activeAlertService = null;
  }
  if (shutdownCleanup) {
    try { await shutdownCleanup(); } catch {}
  }
  for (const adapter of activeAdapters) {
    try { await adapter.stop(); } catch {}
  }
  process.exit(0);
});
