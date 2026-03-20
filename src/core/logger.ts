import { EventEmitter } from 'node:events';
import { LOG_LEVELS } from '../utils/constants';

export type LogLevel = keyof typeof LOG_LEVELS;

export interface LogEvent {
  level: LogLevel;
  message: string;
  meta?: any;
  timestamp: string;
}

export class Logger extends EventEmitter {
  private level: keyof typeof LOG_LEVELS;
  private levelOrder: Record<LogLevel, number>;
  private silent: boolean;
  
  constructor(level: LogLevel = 'INFO', silent: boolean = false) {
    super();
    this.level = level;
    this.silent = silent;
    this.levelOrder = {
      ERROR: 0,
      WARN: 1,
      INFO: 2,
      DEBUG: 3,
    };
  }
  
  setLevel(level: LogLevel): void {
    this.level = level;
  }
  
  setSilent(silent: boolean): void {
    this.silent = silent;
  }
  
  private shouldLog(level: LogLevel): boolean {
    if (this.silent) return false;
    return this.levelOrder[level] <= this.levelOrder[this.level];
  }
  
  private formatMessage(level: LogLevel, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}]`;

    if (meta) {
      let metaJson: string;
      try {
        // Convert Set to Array before stringifying
        const safeMeta = meta instanceof Set
          ? Array.from(meta)
          : meta;
        metaJson = JSON.stringify(safeMeta, (_key, value) => {
          // Convert BigInt to number
          if (typeof value === 'bigint') {
            return Number(value);
          }
          return value;
        });
      } catch (error) {
        metaJson = String(meta);
      }
      return `${prefix} ${message} ${metaJson}`;
    }

    return `${prefix} ${message}`;
  }

  /** Emit a log event for subscribers (e.g. AlertService). */
  private emitLogEvent(level: LogLevel, message: string, meta?: any): void {
    if (this.listenerCount('log') > 0) {
      const event: LogEvent = {
        level,
        message,
        meta,
        timestamp: new Date().toISOString(),
      };
      this.emit('log', event);
    }
  }
  
  error(message: string, meta?: any): void {
    this.emitLogEvent('ERROR', message, meta);
    if (this.shouldLog('ERROR')) {
      console.error(this.formatMessage('ERROR', message, meta));
    }
  }
  
  warn(message: string, meta?: any): void {
    this.emitLogEvent('WARN', message, meta);
    if (this.shouldLog('WARN')) {
      console.warn(this.formatMessage('WARN', message, meta));
    }
  }
  
  info(message: string, meta?: any): void {
    this.emitLogEvent('INFO', message, meta);
    if (this.shouldLog('INFO')) {
      console.log(this.formatMessage('INFO', message, meta));
    }
  }
  
  debug(message: string, meta?: any): void {
    this.emitLogEvent('DEBUG', message, meta);
    if (this.shouldLog('DEBUG')) {
      console.log(this.formatMessage('DEBUG', message, meta));
    }
  }
  
  success(message: string, meta?: any): void {
    if (this.shouldLog('INFO')) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [OK]`;
      const output = meta ? `${prefix} ${message} ${JSON.stringify(meta)}` : `${prefix} ${message}`;
      console.log(output);
    }
  }
}

export const logger = new Logger('INFO');
