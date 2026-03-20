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
  private static readonly CURRENT_MIGRATION_VERSION = 2;
  private static readonly UID_SET_FILE = '.processed-uids.txt';
  private static stateFilePath: string = '.jiny/.state.json';
  private static stateDir: string = '.jiny';
  private static migrationDisabled: boolean = false;
  private static state: MonitorState = {
    lastSequenceNumber: 0,
    lastProcessedTimestamp: new Date().toISOString(),
    lastProcessedUid: 0,
  };

  static setStateFilePath(path: string): void {
    StateManager.stateFilePath = path;
    StateManager.stateDir = dirname(path);
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
      const imapConfig = config.getImapConfig();

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

  static async load(): Promise<void> {
    try {
      const content = await readFile(StateManager.stateFilePath, 'utf-8');
      StateManager.state = JSON.parse(content);
      console.log('Loaded previous state:', StateManager.state);
    } catch (error) {
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
    StateManager.stateFilePath = '.jiny/.state.json';
    StateManager.stateDir = '.jiny';
    StateManager.state = {
      lastSequenceNumber: 0,
      lastProcessedTimestamp: new Date().toISOString(),
      lastProcessedUid: 0,
    };
  }
}
