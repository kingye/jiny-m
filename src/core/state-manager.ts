import { readFile, writeFile, mkdir, unlink, appendFile, readdir, rename } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { ImapClient } from '../services/imap/index';
import { logger } from './logger';

export interface MonitorState {
  lastSequenceNumber: number;
  lastProcessedTimestamp: string;
  lastProcessedUid: number;
  uidValidity?: number;
  migrationVersion?: number;
}

/**
 * Per-channel state manager. Each IMAP monitor gets its own instance
 * to avoid race conditions when multiple channels run concurrently.
 */
export class StateManager {
  private static readonly CURRENT_MIGRATION_VERSION = 3;
  private static readonly UID_SET_FILE = '.processed-uids.txt';

  // Instance fields — per-channel
  readonly channelName: string;
  private stateFilePath: string;
  private stateDir: string;
  private migrationDisabled: boolean = false;
  private state: MonitorState = {
    lastSequenceNumber: 0,
    lastProcessedTimestamp: new Date().toISOString(),
    lastProcessedUid: 0,
  };

  constructor(channelName: string) {
    this.channelName = channelName;
    this.stateFilePath = `${channelName}/.email/.state.json`;
    this.stateDir = `${channelName}/.email`;
  }

  /** Create a StateManager for a specific channel. */
  static forChannel(channelName: string): StateManager {
    return new StateManager(channelName);
  }

  // --- Legacy static singleton support (for CLI commands, tests) ---
  private static defaultInstance: StateManager = new StateManager('email');

  /** @deprecated Use instance methods. Set the default channel for legacy code. */
  static setChannel(channelName: string): void {
    StateManager.defaultInstance = new StateManager(channelName);
  }

  /** @deprecated Use instance methods. */
  static getChannel(): string {
    return StateManager.defaultInstance.channelName;
  }

  /** @deprecated Use instance methods. */
  static setStateFilePath(path: string): void {
    StateManager.defaultInstance.stateFilePath = path;
    StateManager.defaultInstance.stateDir = dirname(path);
  }

  /** @deprecated Use instance methods. Static wrappers delegate to defaultInstance. */
  static async ensureInitialized(): Promise<void> { return StateManager.defaultInstance.ensureInitialized(); }
  static async load(): Promise<void> { return StateManager.defaultInstance.load(); }
  static async save(): Promise<void> { return StateManager.defaultInstance.save(); }
  static getLastSequenceNumber(): number { return StateManager.defaultInstance.getLastSequenceNumber(); }
  static getLastProcessedTimestamp(): Date { return StateManager.defaultInstance.getLastProcessedTimestamp(); }
  static getLastProcessedTimestampString(): string { return StateManager.defaultInstance.getLastProcessedTimestampString(); }
  static getLastProcessedUid(): number { return StateManager.defaultInstance.getLastProcessedUid(); }
  static getState(): MonitorState { return StateManager.defaultInstance.getState(); }
  static updateState(seqNum: number, uid: number): void { StateManager.defaultInstance.updateState(seqNum, uid); }
  static updateSequence(seq: number): void { StateManager.defaultInstance.updateSequence(seq); }
  static updateUidValidity(uidValidity: number): void { StateManager.defaultInstance.updateUidValidity(uidValidity); }
  static async loadProcessedUids(): Promise<Set<number>> { return StateManager.defaultInstance.loadProcessedUids(); }
  static async trackUid(uid: number): Promise<void> { return StateManager.defaultInstance.trackUid(uid); }
  static async saveProcessedUids(uids: number[]): Promise<void> { return StateManager.defaultInstance.saveProcessedUids(uids); }
  static async resetProcessedUids(): Promise<void> { return StateManager.defaultInstance.resetProcessedUids(); }
  static async reset(): Promise<void> { return StateManager.defaultInstance.reset(); }
  static async skipMigrationForTests(): Promise<void> { StateManager.defaultInstance.migrationDisabled = true; }
  static restoreAfterTests(): void { StateManager.defaultInstance = new StateManager('email'); }

  // --- Instance methods ---

  private getDir(): string {
    return this.stateDir;
  }

  async ensureInitialized(): Promise<void> {
    await this.load();

    if (this.migrationDisabled) {
      return;
    }

    const currentVersion = this.state.migrationVersion || 0;

    if (currentVersion < StateManager.CURRENT_MIGRATION_VERSION) {
      logger.info('Migration required', {
        ch: this.channelName,
        currentVersion,
        targetVersion: StateManager.CURRENT_MIGRATION_VERSION,
      });

      if (currentVersion < 1) {
        await StateManager.runMigrationV1(this);
      }
      if (currentVersion < 2) {
        await StateManager.runMigrationV2(this);
      }
      if (currentVersion < 3) {
        await StateManager.runMigrationV3(this);
      }

      this.state.migrationVersion = StateManager.CURRENT_MIGRATION_VERSION;
      await this.save();

      logger.info('Migration completed successfully', {
        ch: this.channelName,
        newVersion: StateManager.CURRENT_MIGRATION_VERSION,
      });
    }
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.stateFilePath, 'utf-8');
      this.state = JSON.parse(content);
      logger.debug('Loaded state', { ch: this.channelName, ...this.state });
    } catch (error) {
      // Fallback: try legacy .jiny/email/ path for backward compatibility
      try {
        const legacyPath = `.jiny/${this.channelName}/.state.json`;
        const content = await readFile(legacyPath, 'utf-8');
        this.state = JSON.parse(content);
        logger.debug('Loaded state from legacy path', { ch: this.channelName, path: legacyPath });
        return;
      } catch {
        // Legacy path also doesn't exist — start fresh
      }
      logger.debug('No previous state found, starting fresh', { ch: this.channelName });
    }
  }

  async save(): Promise<void> {
    try {
      await mkdir(this.getDir(), { recursive: true });
    } catch {
      // Directory already exists
    }
    await writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  updateState(seqNum: number, uid: number): void {
    this.state.lastSequenceNumber = seqNum;
    this.state.lastProcessedUid = uid;
    this.state.lastProcessedTimestamp = new Date().toISOString();
  }

  updateSequence(seq: number): void {
    this.state.lastSequenceNumber = seq;
  }

  updateUidValidity(uidValidity: number): void {
    this.state.uidValidity = uidValidity;
  }

  getLastSequenceNumber(): number {
    return this.state.lastSequenceNumber;
  }

  getLastProcessedTimestamp(): Date {
    return new Date(this.state.lastProcessedTimestamp);
  }

  getLastProcessedTimestampString(): string {
    return this.state.lastProcessedTimestamp;
  }

  getLastProcessedUid(): number {
    return this.state.lastProcessedUid;
  }

  getState(): MonitorState {
    return { ...this.state };
  }

  async loadProcessedUids(): Promise<Set<number>> {
    try {
      const content = await readFile(
        join(this.getDir(), StateManager.UID_SET_FILE),
        'utf-8'
      );
      const lines = content.trim().split('\n');
      const uids = lines
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(Number);
      return new Set(uids);
    } catch (error) {
      // File doesn't exist yet — return empty set (will be created on first trackUid)
      if (error instanceof Error && error.message.includes('ENOENT')) {
        return new Set();
      }
      throw new Error(
        `Failed to load UID set: ${error instanceof Error ? error.message : 'Unknown'}`
      );
    }
  }

  async trackUid(uid: number): Promise<void> {
    try {
      const uidSet = await this.loadProcessedUids();

      if (uidSet.has(uid)) {
        return;
      }

      const uidSetFile = join(this.getDir(), StateManager.UID_SET_FILE);
      await mkdir(this.getDir(), { recursive: true });

      await appendFile(uidSetFile, `${uid}\n`, 'utf-8');
    } catch (error) {
      logger.error('Failed to track UID', {
        ch: this.channelName,
        uid,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  async saveProcessedUids(uids: number[]): Promise<void> {
    const uidSetFile = join(this.getDir(), StateManager.UID_SET_FILE);
    await mkdir(this.getDir(), { recursive: true });
    const uidContent = uids.join('\n') + '\n';
    await writeFile(uidSetFile, uidContent, 'utf-8');
  }

  async resetProcessedUids(): Promise<void> {
    const uidSetFile = join(this.getDir(), StateManager.UID_SET_FILE);
    await mkdir(this.getDir(), { recursive: true });
    await writeFile(uidSetFile, '', 'utf-8');
  }

  async reset(): Promise<void> {
    this.state = {
      lastSequenceNumber: 0,
      lastProcessedTimestamp: new Date().toISOString(),
      lastProcessedUid: 0,
      uidValidity: 1,
    };
    await this.save();
    await this.resetProcessedUids();
  }

  // --- Static migration helpers (shared logic, called with instance context) ---

  private static async runMigrationV1(sm: StateManager): Promise<void> {
    let processedCount = 0;
    let failed = false;

    try {
      logger.info('Starting migration v1: Initialize UID set from mailbox', { ch: sm.channelName });

      const { ConfigManager } = await import('../config');
      const config = await ConfigManager.create();
      const emailConfig = config.getEmailChannelConfig();
      const imapConfig = emailConfig?.inbound || config.getImapConfig();

      if (!imapConfig) {
        logger.warn('No IMAP config found, skipping migration v1');
        return;
      }

      const imapClient = new ImapClient(imapConfig, false, false);
      await imapClient.connect();

      const client = (imapClient as any).client;
      const mailbox = await client.mailboxOpen('INBOX');
      const currentCount = mailbox.exists;

      logger.info('Fetching all messages to build UID set', { totalMessages: currentCount });

      const uids: number[] = [];

      for (let seq = 1; seq <= currentCount; seq++) {
        try {
          for await (const msg of client.fetch(seq, { uid: true })) {
            if (msg.uid) {
              uids.push(Number(msg.uid));
              processedCount++;
            }
            break;
          }
        } catch (error) {
          logger.error('Failed to fetch message during migration', {
            seq,
            error: error instanceof Error ? error.message : 'Unknown',
          });
          failed = true;
          break;
        }
      }

      await imapClient.disconnect();

      if (failed) {
        throw new Error(`Migration failed: Failed to process sequence ${processedCount + 1}`);
      }

      if (uids.length !== currentCount) {
        throw new Error(`Migration failed: Expected ${currentCount} UIDs, got ${uids.length}`);
      }

      if (!uids.includes(sm.state.lastProcessedUid)) {
        uids.push(sm.state.lastProcessedUid);
        uids.sort((a, b) => a - b);
      }

      const uidSetFile = join(sm.getDir(), StateManager.UID_SET_FILE);
      await mkdir(sm.getDir(), { recursive: true });
      const uidContent = uids.join('\n') + '\n';
      await writeFile(uidSetFile, uidContent, 'utf-8');

      logger.info('UID set created successfully', { uidCount: uids.length, file: uidSetFile });
    } catch (error) {
      logger.error('Migration v1 failed', {
        processedCount,
        error: error instanceof Error ? error.message : 'Unknown',
      });

      try {
        const uidSetFile = join(sm.getDir(), StateManager.UID_SET_FILE);
        await unlink(uidSetFile).catch(() => {});
      } catch (e) {}

      throw error;
    }
  }

  private static async runMigrationV2(sm: StateManager): Promise<void> {
    logger.info('Skipping migration v2: Global workspace folder is deprecated');
    return;
  }

  private static async runMigrationV3(sm: StateManager): Promise<void> {
    try {
      logger.info('Starting migration v3: Move state to channel-specific directory');

      const oldStatePath = `.jiny/email/.state.json`;
      const oldStateDir = '.jiny/email';

      try {
        const content = await readFile(oldStatePath, 'utf-8');
        await mkdir(sm.getDir(), { recursive: true });
        await writeFile(sm.stateFilePath, content, 'utf-8');
        logger.info('Migrated state file', { from: oldStatePath, to: sm.stateFilePath });
      } catch {
        // Old state doesn't exist — nothing to migrate
      }

      const oldUidSetPath = join(oldStateDir, StateManager.UID_SET_FILE);
      const newUidSetPath = join(sm.getDir(), StateManager.UID_SET_FILE);

      try {
        const content = await readFile(oldUidSetPath, 'utf-8');
        await mkdir(sm.getDir(), { recursive: true });
        await writeFile(newUidSetPath, content, 'utf-8');
        logger.info('Migrated UID set file', { from: oldUidSetPath, to: newUidSetPath });
      } catch {
        // Old UID set doesn't exist — nothing to migrate
      }

      logger.info('Migration v3 complete');
    } catch (error) {
      logger.error('Migration v3 failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }
}
