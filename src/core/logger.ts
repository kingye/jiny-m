import { LOG_LEVELS } from '../utils/constants';

export type LogLevel = keyof typeof LOG_LEVELS;

export class Logger {
  private level: keyof typeof LOG_LEVELS;
  private levelOrder: Record<LogLevel, number>;
  private silent: boolean;
  
  constructor(level: LogLevel = 'INFO', silent: boolean = false) {
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
      return `${prefix} ${message} ${JSON.stringify(meta)}`;
    }
    
    return `${prefix} ${message}`;
  }
  
  error(message: string, meta?: any): void {
    if (this.shouldLog('ERROR')) {
      console.error(this.formatMessage('ERROR', message, meta));
    }
  }
  
  warn(message: string, meta?: any): void {
    if (this.shouldLog('WARN')) {
      console.warn(this.formatMessage('WARN', message, meta));
    }
  }
  
  info(message: string, meta?: any): void {
    if (this.shouldLog('INFO')) {
      console.log(this.formatMessage('INFO', message, meta));
    }
  }
  
  debug(message: string, meta?: any): void {
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