import type { ImapConfig, WatchConfig, Pattern, OutputConfig } from '../../types';
import { ImapClient } from './index';
import { type ImapEmail } from './index';
import { emailParser } from '../../core/email-parser';
import { logger } from '../../core/logger';
import { StateManager } from '../../core/state-manager';
import { sleep } from '../../utils/helpers';

export interface MonitorOptions {
  once: boolean;
  useIdle: boolean;
  verbose?: boolean;
  onMatch?: (email: any, patternMatch: any) => void | Promise<void>;
  onError?: (error: Error) => void;
}

export class EmailMonitor {
  private imapClient: ImapClient;
  private watchConfig: WatchConfig;
  private outputConfig: OutputConfig;
  private folder: string;
  private verbose: boolean = false;
  private debug: boolean = false;
  private running: boolean = false;
  private lastUid: number | null = null;
  private reconnectAttempts: number = 0;
  private lastSuccessfulPoll: number = 0;
  private hadMessagesInLastCheck: boolean = false;
  private channelName: string;
  private sm: StateManager;
  private log!: {
    info: (msg: string, data?: Record<string, any>) => void;
    warn: (msg: string, data?: Record<string, any>) => void;
    error: (msg: string, data?: Record<string, any>) => void;
    debug: (msg: string, data?: Record<string, any>) => void;
  };

  constructor(
    channelName: string,
    imapConfig: ImapConfig,
    watchConfig: WatchConfig,
    patterns: Pattern[],
    outputConfig: OutputConfig,
    folder: string = 'INBOX',
    verbose: boolean = false,
    debug: boolean = false
  ) {
    this.channelName = channelName;
    this.sm = StateManager.forChannel(channelName);
    this.imapClient = new ImapClient(imapConfig, verbose, debug);
    this.watchConfig = watchConfig;
    this.outputConfig = outputConfig;
    this.folder = folder;
    this.verbose = verbose;
    this.debug = debug;
    // Create channel-scoped logger that auto-includes channel name
    this.log = {
      info: (msg: string, data?: Record<string, any>) => logger.info(msg, { ch: channelName, ...data }),
      warn: (msg: string, data?: Record<string, any>) => logger.warn(msg, { ch: channelName, ...data }),
      error: (msg: string, data?: Record<string, any>) => logger.error(msg, { ch: channelName, ...data }),
      debug: (msg: string, data?: Record<string, any>) => logger.debug(msg, { ch: channelName, ...data }),
    };
  }

  async start(options: MonitorOptions): Promise<void> {
    this.running = true;

    try {
      await this.sm.ensureInitialized();
      await this.sm.load();
      const lastSeq = this.sm.getLastSequenceNumber();
      this.log.info('Resuming sequence-based monitoring', { lastSequenceNumber: lastSeq });

      await this.imapClient.connect();

      const currentInfo = await this.imapClient.getNewestUid(this.folder);
      this.lastUid = currentInfo || lastSeq;

      this.log.info('Monitoring started', { folder: this.folder, lastUid: this.lastUid });

      if (options.once) {
        await this.checkForNewEmails(options);
        return;
      }

      const reconnectConfig = this.watchConfig.reconnect || { maxAttempts: 10, baseDelay: 5000, maxDelay: 60000 };

      while (this.running) {
        try {
          await this.checkForNewEmails(options);

          if (this.reconnectAttempts > 0) {
            this.log.info('Connection restored', { reconnectAttempts: this.reconnectAttempts });
            this.reconnectAttempts = 0;
          }

          this.lastSuccessfulPoll = Date.now();

          if (options.useIdle && this.imapClient.isConnected()) {
            await this.idleWait();
          } else {
            await sleep(this.watchConfig.checkInterval * 1000);
          }
        } catch (error) {
          if (!this.running) break;

          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          this.log.error('Monitor error, will retry...', { error: errorMessage });

          this.reconnectAttempts++;

          if (this.reconnectAttempts >= reconnectConfig.maxAttempts) {
            this.log.error('Max reconnection attempts reached, stopping monitor', { reconnectAttempts: this.reconnectAttempts });
            if (options.onError) {
              options.onError(new Error(`Max reconnection attempts (${reconnectConfig.maxAttempts}) reached: ${errorMessage}`));
            }
            throw new Error(`Max reconnection attempts (${reconnectConfig.maxAttempts}) reached: ${errorMessage}`);
          }

          const delay = Math.min(
            reconnectConfig.baseDelay * Math.pow(2, this.reconnectAttempts - 1),
            reconnectConfig.maxDelay
          );

          this.log.warn(`Waiting ${delay}ms before reconnection attempt ${this.reconnectAttempts}/${reconnectConfig.maxAttempts}...`);
          await sleep(delay);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log.error('Monitor error', { error: errorMessage });
      if (options.onError) {
        options.onError(new Error(errorMessage));
      }
      throw error;
    } finally {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.imapClient.disconnect();
    logger.info('Monitoring stopped');
  }

  private async checkForNewEmails(options: MonitorOptions): Promise<void> {
    if (!this.imapClient.isConnected()) {
      this.log.warn('Not connected to IMAP server, attempting to reconnect...');
      await this.imapClient.reconnect();
    }

    const currentCount = await this.imapClient.getMailboxCount(this.folder);
    const lastSeq = this.sm.getLastSequenceNumber();
    const maxThreshold = this.watchConfig.maxNewEmailThreshold || 50;
    const disableCheck = this.watchConfig.disableConsistencyCheck || false;

    if (currentCount < lastSeq) {
      this.log.warn('Deletion detected, triggering recovery', {
        lastSequenceNumber: lastSeq,
        currentCount,
      });
      await this.triggerRecovery(currentCount, lastSeq, 'deletion', options);
      return;
    }

    if (!disableCheck && currentCount > lastSeq + maxThreshold) {
      this.log.warn('Suspicious jump in email count, triggering recovery', {
        lastSequenceNumber: lastSeq,
        currentCount,
        threshold: maxThreshold,
      });
      await this.triggerRecovery(currentCount, lastSeq, 'suspicious-jump', options);
      return;
    }

    await this.normalFetchNewMessages(lastSeq, currentCount, options);
  }

  private async normalFetchNewMessages(
    lastSeq: number,
    currentCount: number,
    options: MonitorOptions
  ) {
    const hasNewMessages = currentCount > lastSeq;

    if (!hasNewMessages) {
      if (this.hadMessagesInLastCheck) {
        this.log.debug('No new messages', { lastSeq, currentCount });
        this.hadMessagesInLastCheck = false;
      }
      return;
    }

    logger.debug('Normal mode: fetching new messages', {
      from: lastSeq + 1,
      to: currentCount,
    });

    const newMessages = await this.imapClient.fetchRange(lastSeq + 1, currentCount, this.folder);

    if (newMessages.length === 0) {
      this.hadMessagesInLastCheck = false;
      return;
    }

    this.hadMessagesInLastCheck = true;
    logger.info(`Found ${newMessages.length} new email(s)`);

    for (const message of newMessages) {
      await this.processMessage(message, message.seq, options);
      this.sm.updateSequence(message.seq);
      await this.sm.save();
    }

    const currentInfo = await this.imapClient.getNewestUid(this.folder);
    this.lastUid = currentInfo || lastSeq;
  }

  private async triggerRecovery(
    currentCount: number,
    lastSeq: number,
    reason: string,
    options: MonitorOptions
  ) {
    logger.warn('Recovery mode triggered', {
      currentCount,
      lastSeq,
      reason,
    });

    let processedUids: Set<number>;

    try {
      processedUids = await this.sm.loadProcessedUids();
      this.log.info('Loaded processed UID set', { count: processedUids.size });
    } catch (error) {
      this.log.error('Failed to load UID set for recovery', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      throw new Error('Recovery failed: Unable to load UID set. Please check .jiny/.processed-uids.json');
    }

    const mailbox = await (this.imapClient as any).client.mailboxOpen(this.folder);
    const serverUidValidity = Number(mailbox.uidValidity);
    const stateUidValidity = Number(this.sm.getState().uidValidity);

    if (serverUidValidity !== stateUidValidity) {
      this.log.warn('UIDVALIDITY changed, resetting UID set', {
        serverUidValidity,
        stateUidValidity,
      });
      await this.sm.resetProcessedUids();
      processedUids = new Set();
      this.sm.updateUidValidity(serverUidValidity);
      await this.sm.save();
    }

    logger.info('Fetching all messages for recovery', { totalMessages: currentCount });

    const allMessages = await this.imapClient.fetchRange(1, currentCount, this.folder);

    const newMessages = allMessages.filter((msg) => !processedUids.has(msg.uid));

    logger.info(`Recovery: ${newMessages.length} new messages, ${allMessages.length - newMessages.length} already processed`);

    for (const msg of newMessages) {
      await this.processMessage(msg, msg.seq, options);
      await this.sm.save();
    }

    this.sm.updateSequence(currentCount);
    await this.sm.save();

    logger.info('Recovery complete', { newMessages: newMessages.length });
  }

  private async processMessage(imapEmail: ImapEmail, seqNum: number, options: MonitorOptions): Promise<void> {
    try {
      const fromAddress = (imapEmail.envelope.from[0]?.address) ?? '';
      const subject = imapEmail.envelope.subject ?? '';

      this.log.debug('Processing email', { from: fromAddress, subject, uid: imapEmail.uid });

      await this.sm.trackUid(imapEmail.uid);

      try {
        const emailBody = await this.imapClient.fetchMessageBody(seqNum, this.folder);
        const parsedEmail = await emailParser.parseEmail(emailBody, imapEmail.uid.toString(), imapEmail.uid);

        if (options.onMatch) {
          // Deliver ALL emails — filtering is handled by the inbound adapter
          await options.onMatch(parsedEmail, { patternName: '__all__', channel: 'email', matches: {} });
        } else {
          this.displayEmail(parsedEmail);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.log.error('Error parsing email body', { uid: imapEmail.uid, error: errorMessage });
        if (options.onError) {
          options.onError(new Error(errorMessage));
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.log.error('Error processing message', { uid: imapEmail.uid, error: errorMessage });
      if (options.onError) {
        options.onError(new Error(errorMessage));
      }
    }
  }

  private displayEmail(email: any): void {
    console.log('\n' + '='.repeat(80));
    console.log(`📧 MATCHED EMAIL: ${email.matchedPattern}`);
    console.log('='.repeat(80));

    if (this.outputConfig.includeHeaders) {
      console.log(`\nFrom: ${email.from}`);
      console.log(`To: ${email.to.join(', ')}`);
      console.log(`Subject: ${email.subject}`);
      console.log(`Date: ${email.date}`);
    }

    if (email.body.text) {
      console.log('\n' + email.body.text);
    }

    if (this.outputConfig.includeAttachments && email.attachments && email.attachments.length > 0) {
      console.log('\n📎 Attachments:');
      email.attachments.forEach((att: any) => {
        console.log(`  - ${att.filename} (${att.contentType}, ${att.size} bytes)`);
      });
    }

    console.log('\n' + '='.repeat(80) + '\n');
  }

  private async idleWait(): Promise<void> {
    if (!this.imapClient.isConnected()) {
      return;
    }

    try {
      const client = (this.imapClient as any).client;
      const mailbox = await client.mailboxOpen(this.folder);

      if (client.idle) {
        this.log.debug('Starting IDLE mode');
        await client.idle();
      }
    } catch (error) {
      this.log.error('IDLE wait failed', { error: error instanceof Error ? error.message : 'Unknown error' });
      throw error;
    }
  }

  async checkNow(): Promise<void> {
    if (!this.running) {
      this.log.warn('Cannot check emails: monitor is not running');
      return;
    }

    try {
      this.log.debug('Triggering immediate email check...');
      await this.checkForNewEmails({
        once: false,
        useIdle: false,
        verbose: this.verbose,
        onError: undefined,
      });
      this.log.debug('Immediate check complete');
    } catch (error) {
      this.log.error('Failed to check emails immediately', { error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
}
