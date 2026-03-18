import type { ImapConfig, WatchConfig, Pattern, OutputConfig } from '../../types';
import { ImapClient, type ImapEmail } from './index';
import { PatternMatcher } from '../../core/pattern-matcher';
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
  private patternMatcher: PatternMatcher;
  private watchConfig: WatchConfig;
  private outputConfig: OutputConfig;
  private folder: string;
  private verbose: boolean = false;
  private debug: boolean = false;
  private running: boolean = false;
  private lastUid: number | null = null;
  private reconnectAttempts: number = 0;
  private lastSuccessfulPoll: number = 0;

  constructor(
    imapConfig: ImapConfig,
    watchConfig: WatchConfig,
    patterns: Pattern[],
    outputConfig: OutputConfig,
    folder: string = 'INBOX',
    verbose: boolean = false,
    debug: boolean = false
  ) {
    this.imapClient = new ImapClient(imapConfig, verbose, debug);
    this.patternMatcher = new PatternMatcher(patterns);
    this.watchConfig = watchConfig;
    this.outputConfig = outputConfig;
    this.folder = folder;
    this.verbose = verbose;
    this.debug = debug;
  }
  
  async start(options: MonitorOptions): Promise<void> {
    this.running = true;

    try {
      await StateManager.load();
      const lastSeqNum = StateManager.getLastSequenceNumber();
      logger.info('Resuming from sequence number', { lastSeqNum });

      await this.imapClient.connect();

      const mailboxInfo = await this.imapClient.getNewestUid(this.folder);
      this.lastUid = mailboxInfo || lastSeqNum;

      logger.info('Monitoring started', { folder: this.folder, lastUid: this.lastUid, lastSequenceNumber: lastSeqNum });

      if (options.once) {
        await this.checkForNewEmails(options);
        return;
      }

      const reconnectConfig = this.watchConfig.reconnect || { maxAttempts: 10, baseDelay: 5000, maxDelay: 60000 };

      while (this.running) {
        try {
          await this.checkForNewEmails(options);

          if (this.reconnectAttempts > 0) {
            logger.info('Connection restored', { reconnectAttempts: this.reconnectAttempts });
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
          logger.error('Monitor error, will retry...', { error: errorMessage });

          this.reconnectAttempts++;

          if (this.reconnectAttempts >= reconnectConfig.maxAttempts) {
            logger.error('Max reconnection attempts reached, stopping monitor', { reconnectAttempts: this.reconnectAttempts });
            if (options.onError) {
              options.onError(new Error(`Max reconnection attempts (${reconnectConfig.maxAttempts}) reached: ${errorMessage}`));
            }
            throw new Error(`Max reconnection attempts (${reconnectConfig.maxAttempts}) reached: ${errorMessage}`);
          }

          const delay = Math.min(
            reconnectConfig.baseDelay * Math.pow(2, this.reconnectAttempts - 1),
            reconnectConfig.maxDelay
          );

          logger.warn(`Waiting ${delay}ms before reconnection attempt ${this.reconnectAttempts}/${reconnectConfig.maxAttempts}...`);
          await sleep(delay);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Monitor error', { error: errorMessage });
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
      logger.warn('Not connected to IMAP server, attempting to reconnect...');
      await this.imapClient.reconnect();
    }

    const lastSeqNum = StateManager.getLastSequenceNumber();

    try {
      const newMessages = await this.imapClient.searchNewMessages(lastSeqNum, this.folder);

      if (newMessages.length === 0) {
        return;
      }

      logger.info(`Found ${newMessages.length} new email(s)`, { lastSeqNum });

      for (const message of newMessages) {
        await this.processMessage(message, message.seq, options);

        StateManager.updateState(message.seq, message.uid);
        await StateManager.save();
      }

      const currentInfo = await this.imapClient.getNewestUid(this.folder);
      this.lastUid = currentInfo || lastSeqNum;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error checking for new emails', { error: errorMessage });
      if (options.onError) {
        options.onError(new Error(errorMessage));
      }
      throw error;
    }
  }
  
  private async processMessage(imapEmail: ImapEmail, seqNum: number, options: MonitorOptions): Promise<void> {
    try {
      const fromAddress = (imapEmail.envelope.from[0]?.address) ?? '';
      const subject = imapEmail.envelope.subject ?? '';
      
      logger.debug('Processing email', { from: fromAddress, subject, seqNum });
      
      const patternMatch = this.patternMatcher.match(fromAddress, subject);
      
      if (!patternMatch) {
        return;
      }
      
      logger.info('Pattern matched!', { pattern: patternMatch.patternName, from: fromAddress, subject });
      
      try {
        const emailBody = await this.imapClient.fetchMessageBody(seqNum, this.folder);
        const parsedEmail = await emailParser.parseEmail(emailBody, imapEmail.uid.toString(), imapEmail.uid);
        parsedEmail.matchedPattern = patternMatch.patternName;
        
        if (options.onMatch) {
          await options.onMatch(parsedEmail, patternMatch);
        } else {
          this.displayEmail(parsedEmail);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Error parsing email body', { seqNum, error: errorMessage });
        if (options.onError) {
          options.onError(new Error(errorMessage));
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error processing message', { seqNum, error: errorMessage });
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
      console.log(`Date: ${email.date.toLocaleString()}`);
      
      if (Object.keys(email.headers).length > 0) {
        console.log('\nHeaders:');
        for (const [key, value] of Object.entries(email.headers)) {
          console.log(`  ${key}: ${value}`);
        }
      }
    }
    
    console.log('\nBody:');
    
    if (email.body.text) {
      console.log(email.body.text);
    }
    
    if (email.body.html && this.outputConfig.format === 'text') {
      console.log('\nHTML content available but not displayed in text mode');
    }
    
    if (this.outputConfig.includeAttachments && email.attachments && email.attachments.length > 0) {
      console.log('\nAttachments:');
      for (const attachment of email.attachments) {
        console.log(`  - ${attachment.filename} (${attachment.contentType}, ${attachment.size} bytes)`);
      }
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
  }
  
  private async idleWait(): Promise<void> {
    try {
      await sleep(this.watchConfig.checkInterval * 1000);
    } catch (error) {
      logger.debug('IDLE wait interrupted');
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Trigger an immediate check for new emails, bypassing the normal polling schedule.
   * This is useful after a long-running operation (like AI processing) where the
   * IMAP connection may have become stale.
   */
  async checkNow(): Promise<void> {
    if (!this.running) {
      logger.warn('Cannot check emails: monitor is not running');
      return;
    }

    try {
      logger.debug('Triggering immediate email check...');
      await this.checkForNewEmails({
        once: false,
        useIdle: false,
        verbose: this.verbose,
        onError: undefined,
      });
      logger.debug('Immediate check complete');
    } catch (error) {
      logger.error('Failed to check emails immediately', { error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
}