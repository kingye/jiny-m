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

export class StateManager {
  private static readonly CURRENT_MIGRATION_VERSION = 3;
  private static readonly UID_SET_FILE = '.processed-uids.txt';
  private static stateFilePath: string = '.jiny/email/.state.json';
  private static stateDir: string = '.jiny/email';
  private static migrationDisabled: boolean = false;
  private static currentChannel: string = 'email';
  private static state: MonitorState = {
    lastSequenceNumber: 0,
    lastProcessedTimestamp: new Date().toISOString(),
    lastProcessedUid: 0,
  };

  static setStateFilePath(path: string): void {
    StateManager.stateFilePath = path;
    StateManager.stateDir = dirname(path);
  }

  /** Set the current channel name (e.g., 'work', 'personal'). Updates paths accordingly. */
  static setChannel(channelName: string): void {
    StateManager.currentChannel = channelName;
    StateManager.stateFilePath = `.jiny/${channelName}/.email/.state.json`;
    StateManager.stateDir = `.jiny/${channelName}/.email`;
  }

  /** Get the current channel name. */
  static getChannel(): string {
    return StateManager.currentChannel;
  }

  private static getDir(): string {
    return StateManager.stateDir;
  }

  static async ensureInitialized(): Promise<void> {
    await StateManager.load();

    if (StateManager.migrationDisabled) {
      return;
    }

    const currentVersion = StateManager.state.migrationVersion || 0;

    if (currentVersion < StateManager.CURRENT_MIGRATION_VERSION) {
      logger.info('Migration required', {
        currentVersion,
        targetVersion: StateManager.CURRENT_MIGRATION_VERSION,
      });

      if (currentVersion < 1) {
        await StateManager.runMigrationV1();
      }
      if (currentVersion < 2) {
        await StateManager.runMigrationV2();
      }
      if (currentVersion < 3) {
        await StateManager.runMigrationV3();
      }

      StateManager.state.migrationVersion = StateManager.CURRENT_MIGRATION_VERSION;
      await StateManager.save();

      logger.info('Migration completed successfully', {
        newVersion: StateManager.CURRENT_MIGRATION_VERSION,
      });
    }
  }

  private static async runMigrationV1(): Promise<void> {
    let processedCount = 0;
    let failed = false;

    try {
      logger.info('Starting migration v1: Initialize UID set from mailbox');

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

      logger.info('Fetching all messages to build UID set', {
        totalMessages: currentCount,
      });

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
        logger.error('Migration failed partially', {
          processedCount,
          totalExpected: currentCount,
          error: 'Failed to fetch message',
        });
        throw new Error(
          `Migration failed: Failed to process sequence ${processedCount + 1}`
        );
      }

      if (uids.length !== currentCount) {
        throw new Error(
          `Migration failed: Expected ${currentCount} UIDs, got ${uids.length}`
        );
      }

      if (!uids.includes(StateManager.state.lastProcessedUid)) {
        logger.info('Adding existing lastProcessedUid to UID set', {
          uid: StateManager.state.lastProcessedUid,
        });
        uids.push(StateManager.state.lastProcessedUid);
        uids.sort((a, b) => a - b);
      }

      const uidSetFile = join(StateManager.getDir(), StateManager.UID_SET_FILE);

      await mkdir(StateManager.getDir(), { recursive: true });

      const uidContent = uids.join('\n') + '\n';
      await writeFile(uidSetFile, uidContent, 'utf-8');

      logger.info('UID set created successfully', {
        uidCount: uids.length,
        file: uidSetFile,
      });
    } catch (error) {
      logger.error('Migration v1 failed with error', {
        processedCount,
        error: error instanceof Error ? error.message : 'Unknown',
        stack: error instanceof Error ? error.stack : undefined,
      });

      try {
        const uidSetFile = join(StateManager.getDir(), StateManager.UID_SET_FILE);
        await unlink(uidSetFile).catch(() => {});
        logger.info('Cleaned up partial UID set file');
      } catch (e) {
      }

      throw error;
    }
  }

  /**
   * Migration v2: Move email .md files from .jiny/ to messages/<timestamp>/ structure.
   * Groups received emails and replies into per-message directories.
   */
  private static async runMigrationV2(): Promise<void> {
    try {
      logger.info('Starting migration v2: Move .jiny/*.md to messages/ structure');

      // Find the workspace folder from config
      const { ConfigManager } = await import('../config');
      const config = await ConfigManager.create();
      const workspaceFolder = join(process.cwd(), config.getWorkspaceConfig().folder);

      let threadDirs: string[];
      try {
        const entries = await readdir(workspaceFolder, { withFileTypes: true });
        threadDirs = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => join(workspaceFolder, e.name));
      } catch {
        logger.info('No workspace directory found, skipping migration v2');
        return;
      }

      let totalMoved = 0;

      for (const threadDir of threadDirs) {
        const jinyDir = join(threadDir, '.jiny');
        let mdFiles: string[];

        try {
          const entries = await readdir(jinyDir);
          mdFiles = entries
            .filter(f => f.endsWith('.md'))
            .sort();
        } catch {
          continue; // No .jiny/ or can't read — skip this thread
        }

        if (mdFiles.length === 0) continue;

        const messagesDir = join(threadDir, 'messages');
        await mkdir(messagesDir, { recursive: true });

        // Separate received emails and auto-replies
        const receivedFiles = mdFiles.filter(f => !f.includes('auto-reply'));
        const replyFiles = mdFiles.filter(f => f.includes('auto-reply'));

        // Extract timestamp from filename: "2026-03-19_23-02-20_Jiny_subject.md" → "2026-03-19_23-02-20"
        const extractTimestamp = (filename: string): string => {
          const match = filename.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
          return match?.[1] ?? filename.replace('.md', '');
        };

        // Build pairs: each received email may have a reply
        // Reply files are paired with the closest preceding received email
        const pairs: Array<{ received?: string; reply?: string; timestamp: string }> = [];

        for (const received of receivedFiles) {
          pairs.push({
            received,
            timestamp: extractTimestamp(received),
          });
        }

        // Match replies to received emails
        for (const reply of replyFiles) {
          const replyTs = extractTimestamp(reply);
          // Find closest preceding received email
          let bestPair = pairs.length > 0 ? pairs[pairs.length - 1] : undefined;
          for (let i = pairs.length - 1; i >= 0; i--) {
            if (pairs[i]!.timestamp <= replyTs) {
              bestPair = pairs[i];
              break;
            }
          }
          if (bestPair) {
            bestPair.reply = reply;
          } else {
            // Orphan reply — create its own pair
            pairs.push({ reply, timestamp: replyTs });
          }
        }

        // Move files into messages/<timestamp>/ directories
        for (const pair of pairs) {
          let dirName = pair.timestamp;
          // Check collision
          try {
            await readdir(join(messagesDir, dirName));
            // Directory exists — add counter
            let counter = 2;
            while (true) {
              try {
                await readdir(join(messagesDir, `${pair.timestamp}_${counter}`));
                counter++;
              } catch {
                dirName = `${pair.timestamp}_${counter}`;
                break;
              }
            }
          } catch {
            // Directory doesn't exist — good
          }

          const msgDir = join(messagesDir, dirName);
          await mkdir(msgDir, { recursive: true });

          if (pair.received) {
            await rename(
              join(jinyDir, pair.received),
              join(msgDir, 'received.md'),
            );
            totalMoved++;
          }

          if (pair.reply) {
            await rename(
              join(jinyDir, pair.reply),
              join(msgDir, 'reply.md'),
            );
            totalMoved++;
          }
        }

        logger.debug('Migrated thread', {
          thread: basename(threadDir),
          pairs: pairs.length,
        });
      }

      logger.info('Migration v2 completed', { totalFilesMoved: totalMoved });
    } catch (error) {
      logger.error('Migration v2 failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      // Non-fatal: don't throw — old .jiny/ files will still work via legacy fallback
    }
  }

  /**
   * Migration v3: Move state files from .jiny/ to .jiny/email/ (per-channel state).
   * Also adds `channel: email` to received.md frontmatter if missing.
   */
  private static async runMigrationV3(): Promise<void> {
    try {
      logger.info('Starting migration v3: Relocate state files to .jiny/email/');

      const jinyDir = join(process.cwd(), '.jiny');
      const emailStateDir = join(jinyDir, 'email');

      // Create .jiny/email/ directory
      await mkdir(emailStateDir, { recursive: true });

      // Move .state.json if it exists in .jiny/ (not already in .jiny/email/)
      const oldStatePath = join(jinyDir, '.state.json');
      const newStatePath = join(emailStateDir, '.state.json');
      try {
        await readFile(oldStatePath, 'utf-8');
        // Old state file exists — check if new one already exists
        try {
          await readFile(newStatePath, 'utf-8');
          // New file already exists — skip (don't overwrite)
          logger.debug('State file already in .jiny/email/, skipping move');
        } catch {
          // New file doesn't exist — move
          await rename(oldStatePath, newStatePath);
          logger.info('Moved .state.json to .jiny/email/');
        }
      } catch {
        // Old state file doesn't exist — nothing to move
        logger.debug('No .jiny/.state.json to migrate');
      }

      // Move .processed-uids.txt
      const oldUidsPath = join(jinyDir, '.processed-uids.txt');
      const newUidsPath = join(emailStateDir, '.processed-uids.txt');
      try {
        await readFile(oldUidsPath, 'utf-8');
        try {
          await readFile(newUidsPath, 'utf-8');
          logger.debug('UIDs file already in .jiny/email/, skipping move');
        } catch {
          await rename(oldUidsPath, newUidsPath);
          logger.info('Moved .processed-uids.txt to .jiny/email/');
        }
      } catch {
        logger.debug('No .jiny/.processed-uids.txt to migrate');
      }

      // Update StateManager to use the new paths
      StateManager.stateFilePath = newStatePath;
      StateManager.stateDir = emailStateDir;

      // Reload state from new location
      try {
        const content = await readFile(newStatePath, 'utf-8');
        StateManager.state = JSON.parse(content);
      } catch {
        // No state file — will be created on first save
      }

      // Add channel: email to received.md files that don't have it
      try {
        const { ConfigManager: CM } = await import('../config');
        const config = await CM.create();
        const workspaceFolder = join(process.cwd(), config.getWorkspaceConfig().folder);

        const entries = await readdir(workspaceFolder, { withFileTypes: true });
        const threadDirs = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => join(workspaceFolder, e.name));

        let updatedFiles = 0;
        for (const threadDir of threadDirs) {
          const messagesDir = join(threadDir, 'messages');
          try {
            const msgDirEntries = await readdir(messagesDir, { withFileTypes: true });
            for (const msgDir of msgDirEntries.filter(e => e.isDirectory())) {
              const receivedPath = join(messagesDir, msgDir.name, 'received.md');
              try {
                const content = await readFile(receivedPath, 'utf-8');
                if (content.includes('channel:')) continue; // Already has channel field
                // Add channel: email after the first ---
                const updated = content.replace(
                  /^---\n/,
                  '---\nchannel: email\n',
                );
                if (updated !== content) {
                  await writeFile(receivedPath, updated, 'utf-8');
                  updatedFiles++;
                }
              } catch {
                // No received.md or can't read — skip
              }
            }
          } catch {
            // No messages/ dir — skip
          }
        }

        if (updatedFiles > 0) {
          logger.info('Added channel field to received.md files', { count: updatedFiles });
        }
      } catch (error) {
        // Non-fatal: frontmatter update is optional
        logger.debug('Could not update received.md frontmatter', {
          error: error instanceof Error ? error.message : 'Unknown',
        });
      }

      logger.info('Migration v3 completed');
    } catch (error) {
      logger.error('Migration v3 failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      // Non-fatal: old .jiny/ paths will still work via StateManager fallback
    }
  }

  static async load(): Promise<void> {
    try {
      const content = await readFile(StateManager.stateFilePath, 'utf-8');
      StateManager.state = JSON.parse(content);
      console.log('Loaded previous state:', StateManager.state);
    } catch (error) {
      // Fallback: try legacy .jiny/.state.json if new path not found
      if (StateManager.stateFilePath.includes('/email/')) {
        try {
          const legacyPath = StateManager.stateFilePath.replace('/email/', '/');
          const content = await readFile(legacyPath, 'utf-8');
          StateManager.state = JSON.parse(content);
          console.log('Loaded previous state from legacy path:', StateManager.state);
          return;
        } catch {
          // Legacy path also doesn't exist — start fresh
        }
      }
      console.log('No previous state found, starting fresh');
    }
  }

  static async save(): Promise<void> {
    try {
      await mkdir(StateManager.getDir(), { recursive: true });
    } catch (error) {
      console.debug('.jiny directory already exists or created');
    }

    await writeFile(StateManager.stateFilePath, JSON.stringify(StateManager.state, null, 2), 'utf-8');
  }

  static updateState(seqNum: number, uid: number): void {
    StateManager.state.lastSequenceNumber = seqNum;
    StateManager.state.lastProcessedUid = uid;
    StateManager.state.lastProcessedTimestamp = new Date().toISOString();
  }

  static updateSequence(seq: number): void {
    StateManager.state.lastSequenceNumber = seq;
  }

  static updateUidValidity(uidValidity: number): void {
    StateManager.state.uidValidity = uidValidity;
  }

  static getLastSequenceNumber(): number {
    return StateManager.state.lastSequenceNumber;
  }

  static getLastProcessedTimestamp(): Date {
    return new Date(StateManager.state.lastProcessedTimestamp);
  }

  static getLastProcessedTimestampString(): string {
    return StateManager.state.lastProcessedTimestamp;
  }

  static getLastProcessedUid(): number {
    return StateManager.state.lastProcessedUid;
  }

  static getState(): MonitorState {
    return { ...StateManager.state };
  }

  static async loadProcessedUids(): Promise<Set<number>> {
    try {
      const content = await readFile(
        join(StateManager.getDir(), StateManager.UID_SET_FILE),
        'utf-8'
      );
      const lines = content.trim().split('\n');
      const uids = lines
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(Number);
      return new Set(uids);
    } catch (error) {
      throw new Error(
        `Failed to load UID set: ${error instanceof Error ? error.message : 'Unknown'}`
      );
    }
  }

  static async trackUid(uid: number): Promise<void> {
    try {
      const uidSet = await StateManager.loadProcessedUids();

      if (uidSet.has(uid)) {
        return;
      }

      const uidSetFile = join(StateManager.getDir(), StateManager.UID_SET_FILE);
      await mkdir(StateManager.getDir(), { recursive: true });

      await appendFile(uidSetFile, `${uid}\n`, 'utf-8');
    } catch (error) {
      logger.error('Failed to track UID', {
        uid,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  static async saveProcessedUids(uids: number[]): Promise<void> {
    const uidSetFile = join(StateManager.getDir(), StateManager.UID_SET_FILE);

    await mkdir(StateManager.getDir(), { recursive: true });

    const uidContent = uids.join('\n') + '\n';
    await writeFile(uidSetFile, uidContent, 'utf-8');
  }

  static async resetProcessedUids(): Promise<void> {
    const uidSetFile = join(StateManager.getDir(), StateManager.UID_SET_FILE);
    await mkdir(StateManager.getDir(), { recursive: true });
    await writeFile(uidSetFile, '', 'utf-8');
  }

  static async reset(): Promise<void> {
    StateManager.state = {
      lastSequenceNumber: 0,
      lastProcessedTimestamp: new Date().toISOString(),
      lastProcessedUid: 0,
      uidValidity: 1,
    };
    await StateManager.save();
    await StateManager.resetProcessedUids();
  }

  static async skipMigrationForTests(): Promise<void> {
    StateManager.migrationDisabled = true;
  }

  /**
   * Restore StateManager to production defaults after tests.
   * Call in afterEach to prevent test state from leaking.
   */
  static restoreAfterTests(): void {
    StateManager.migrationDisabled = false;
    StateManager.currentChannel = 'email';
    StateManager.stateFilePath = '.jiny/email/.state.json';
    StateManager.stateDir = '.jiny/email';
    StateManager.state = {
      lastSequenceNumber: 0,
      lastProcessedTimestamp: new Date().toISOString(),
      lastProcessedUid: 0,
    };
  }
}
