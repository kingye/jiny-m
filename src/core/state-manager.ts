import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface MonitorState {
  lastSequenceNumber: number;
  lastProcessedTimestamp: string;
  lastProcessedUid: number;
}

export class StateManager {
  private static stateFilePath: string = '.jiny/.state.json';
  private static state: MonitorState = {
    lastSequenceNumber: 0,
    lastProcessedTimestamp: new Date().toISOString(),
    lastProcessedUid: 0,
  };

  static setStateFilePath(path: string): void {
    StateManager.stateFilePath = path;
  }

  static async load(): Promise<void> {
    try {
      const content = await readFile(join(process.cwd(), StateManager.stateFilePath), 'utf-8');
      StateManager.state = JSON.parse(content);
      console.log('Loaded previous state:', StateManager.state);
    } catch (error) {
      console.log('No previous state found, starting fresh');
    }
  }

  static async save(): Promise<void> {
    const stateDir = join(process.cwd(), '.jiny');
    const stateFilePath = join(stateDir, '.state.json');
    
    // Create .jiny directory if it doesn't exist
    try {
      await mkdir(stateDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, which is fine
      console.debug('.jiny directory already exists or created');
    }
    
    await writeFile(stateFilePath, JSON.stringify(StateManager.state, null, 2), 'utf-8');
  }

  static updateState(seqNum: number, uid: number): void {
    StateManager.state.lastSequenceNumber = seqNum;
    StateManager.state.lastProcessedUid = uid;
    StateManager.state.lastProcessedTimestamp = new Date().toISOString();
  }

  static getLastSequenceNumber(): number {
    return StateManager.state.lastSequenceNumber;
  }

  static getLastProcessedTimestamp(): Date {
    return new Date(StateManager.state.lastProcessedTimestamp);
  }

  static getLastProcessedUid(): number {
    return StateManager.state.lastProcessedUid;
  }

  static getState(): MonitorState {
    return { ...StateManager.state };
  }

  static async reset(): Promise<void> {
    StateManager.state = {
      lastSequenceNumber: 0,
      lastProcessedTimestamp: new Date().toISOString(),
      lastProcessedUid: 0,
    };
    await StateManager.save();
  }
}