import type { ImapConfig } from '../../types';
import { logger } from '../../core/logger';
import { RETRY_DELAYS } from '../../utils/constants';
import { sleep } from '../../utils/helpers';

export interface ImapEmail {
  uid: number;
  flags: string[];
  envelope: {
    from: { address: string }[];
    subject: string;
    date: Date;
  };
}

export class ImapClient {
  private config: ImapConfig;
  private connected: boolean = false;
  private retryCount: number = 0;
  private client: any = null;
  private verbose: boolean = false;
  private debug: boolean = false;

  constructor(config: ImapConfig, verbose: boolean = false, debug: boolean = false) {
    this.config = config;
    this.verbose = verbose;
    this.debug = debug;
  }
  
  private async createConnection(): Promise<any> {
    try {
      const ImapFlow = await import('imapflow');
      const client = new ImapFlow.ImapFlow({
        host: this.config.host,
        port: this.config.port ?? 993,
        secure: this.config.tls,
        auth: {
          user: this.config.username,
          pass: this.config.password,
        },
        logger: this.verbose ? undefined : false,
      });

      client.on('close', () => {
        if (this.connected) {
          logger.warn('IMAP connection closed by server');
          this.connected = false;
        }
      });

      client.on('error', (err: Error) => {
        if (this.connected) {
          logger.error('IMAP connection error', { error: err.message });
          this.connected = false;
        }
      });

      return client;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to create IMAP connection', { error: errorMessage });
      throw new Error(`IMAP flow library not available. Please run: bun install imapflow. Original error: ${errorMessage}`);
    }
  }
  
  async connect(): Promise<void> {
    while (this.retryCount < 5) {
      try {
        this.client = await this.createConnection();
        await this.client.connect();
        this.connected = true;
        logger.success('Connected to IMAP server', { host: this.config.host, user: this.config.username });
        return;
      } catch (error) {
        this.retryCount++;
        if (this.retryCount >= 5) {
          logger.error('Failed to connect to IMAP server after retries', { attempts: this.retryCount });
          throw new Error(`Failed to connect to IMAP server: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        
        const delayIndex = Math.min(this.retryCount - 1, RETRY_DELAYS.length - 1);
        const delay = RETRY_DELAYS[delayIndex] ?? 30000;
        logger.warn(`Connection failed, retrying in ${delay}ms...`, { attempt: this.retryCount, maxRetries: 5 });
        await sleep(delay);
      }
    }
  }
  
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch (error) {
        logger.debug('Error disconnecting client', { error: error instanceof Error ? error.message : 'Unknown error' });
      }
      this.client = null;
    }
    this.connected = false;
    this.retryCount = 0;
  }

  async reconnect(): Promise<void> {
    logger.info('Attempting to reconnect to IMAP server...');
    await this.disconnect();
    await this.connect();
  }

  private ensureConnected(): void {
    if (!this.connected || !this.client) {
      throw new Error('Not connected to IMAP server');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async fetchMessages(folder: string = 'INBOX', limit: number = 10): Promise<ImapEmail[]> {
    this.ensureConnected();
    
    try {
      const mailbox = await this.client.mailboxOpen(folder);
      logger.info(`Opened mailbox: ${folder}`, { total: mailbox.exists });
      
      const messages: ImapEmail[] = [];
      
      const exists = mailbox.exists ?? 0;
      const startUid = exists ? Math.max(1, exists - limit + 1) : 1;
      
      if (exists === 0) {
        return [];
      }
      
      for await (const message of this.client.fetch(`${startUid}:${exists}`, { envelope: true, uid: true })) {
        messages.push({
          uid: message.uid,
          flags: message.flags || [],
          envelope: {
            from: message.envelope.from || [],
            subject: message.envelope.subject || '',
            date: message.envelope.date || new Date(),
          },
        });
        
        if (messages.length >= limit) break;
      }
      
      return messages;
    } catch (error) {
      logger.error('Failed to fetch messages', { error: error instanceof Error ? error.message : 'Unknown error' });
      throw error;
    }
  }
  
  async fetchMessageBody(seqNum: number, folder: string = 'INBOX'): Promise<string> {
    this.ensureConnected();
    
    try {
      const mailbox = await this.client.mailboxOpen(folder);
      logger.debug(`Mailbox opened: ${folder}, exists: ${mailbox.exists}, uidNext: ${mailbox.uidNext}, uidValidity: ${mailbox.uidValidity}`);
      
      logger.debug(`Fetching message body for sequence ${seqNum}, mailbox has ${mailbox.exists} messages`);
      
      let messageSource: string | null = null;
      let messageCount = 0;
      
      try {
        for await (const message of this.client.fetch(seqNum, { source: true, body: true })) {
          messageCount++;
          const keys = Object.keys(message).join(', ');
          logger.debug(`Message ${messageCount}, available keys: ${keys}`);
          logger.debug(`Has source: ${!!message.source}, Has body: ${!!message.body}`);
          
          if (message.source) {
            let tempSource: string;
            if (Buffer.isBuffer(message.source)) {
              tempSource = message.source.toString('utf-8');
            } else if (typeof message.source === 'string') {
              tempSource = message.source;
            } else {
              tempSource = JSON.stringify(message.source);
            }
            logger.debug(`Got source, length: ${tempSource.length}`);
            messageSource = tempSource;
            break;
          } else if (message.body && typeof message.body === 'string') {
            logger.debug(`No source, using body, length: ${message.body.length}`);
            messageSource = message.body;
            break;
          }
        }
      } catch (fetchError: any) {
        logger.debug(`Fetch loop error: ${fetchError?.message}`);
      }
      
      if (messageCount === 0) {
        logger.debug(`No messages fetched for sequence ${seqNum}`);
      }
      
      if (messageSource === null) {
        throw new Error(`No message source returned for sequence ${seqNum}`);
      }
      
      return messageSource;
    } catch (error: any) {
      logger.error('Failed to fetch message body', { seqNum, error: error?.message ?? 'Unknown error' });
      throw error;
    }
  }
  async getNewestUid(folder: string = 'INBOX'): Promise<number | null> {
    this.ensureConnected();
    
    try {
      const mailbox = await this.client.mailboxOpen(folder);
      return mailbox.exists;
    } catch (error) {
      logger.error('Failed to get newest UID', { folder, error: error instanceof Error ? error.message : 'Unknown error' });
      return null;
    }
  }
  
  async searchNewMessages(lastMessageCount: number, folder: string = 'INBOX'): Promise<Array<ImapEmail & { seq: number }>> {
    this.ensureConnected();
    
    try {
      const mailbox = await this.client.mailboxOpen(folder);
      const currentCount = mailbox.exists || 0;
      
      logger.debug(`Searching for new messages: last count ${lastMessageCount}, current count ${currentCount}`);
      
      const messages: Array<ImapEmail & { seq: number }> = [];
      
      if (currentCount <= lastMessageCount) {
        logger.debug('No new messages');
        return messages;
      }
      
      // Get the newest messages (from lastMessageCount + 1 to currentCount)
      const newMessageStart = lastMessageCount + 1;
      const newMessageEnd = currentCount;
      
      logger.debug(`Fetching messages ${newMessageStart} to ${newMessageEnd}`);
      
      // Use sequence numbers instead of UIDs for getting recent messages
      for (let seq = newMessageStart; seq <= newMessageEnd; seq++) {
        try {
          for await (const message of this.client.fetch(seq, { envelope: true, uid: true })) {
            messages.push({
              seq: seq,
              uid: message.uid,
              flags: message.flags || [],
              envelope: {
                from: message.envelope.from || [],
                subject: message.envelope.subject || '',
                date: message.envelope.date || new Date(),
              },
            });
            break;
          }
        } catch {
          logger.debug(`Failed to fetch sequence ${seq}`);
        }
      }
      
      logger.debug(`Found ${messages.length} new messages`);
      return messages;
    } catch (error) {
      logger.error('Failed to search new messages', { lastMessageCount, folder, error: error instanceof Error ? error.message : 'Unknown error' });
      throw error;
    }
  }
}

async function tryFetchUid(client: any, uid: number): Promise<any> {
  for await (const message of client.fetch(uid, { source: true, body: true })) {
    return message;
  }
  return null;
}