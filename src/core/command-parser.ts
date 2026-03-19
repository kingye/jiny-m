import { logger } from './logger';

export interface EmailCommandExtractorOptions {
  commandPrefix: string;
}

export interface CommandAndLine {
  commandLine: string;
  lineNumber: number;
}

export interface ExtractedCommandsResult {
  cleanedBody: string;
  commandLines: CommandAndLine[];
  originalBody: string;
}

export class EmailCommandExtractor {
  private options: EmailCommandExtractorOptions;

  constructor(options: Partial<EmailCommandExtractorOptions> = {}) {
    this.options = {
      commandPrefix: options.commandPrefix || '/attach',
    };
  }

  extractCommands(emailBody: string): ExtractedCommandsResult {
    if (!emailBody) {
      return {
        cleanedBody: '',
        commandLines: [],
        originalBody: '',
      };
    }

    const lines = emailBody.split('\n');
    const commandLines: CommandAndLine[] = [];
    const nonCommandLines: string[] = [];
    let inCommand = false;
    let currentCommand: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!line) {
        nonCommandLines.push('');
        continue;
      }

      const trimmed = line.trim();

      if (this.isCommandStart(trimmed)) {
        if (currentCommand.length > 0) {
          nonCommandLines.push(...currentCommand);
        }
        inCommand = true;
        currentCommand = [trimmed];
      } else if (inCommand && this.isContinuationCharacter(trimmed)) {
        currentCommand.push(trimmed);
      } else {
        if (inCommand) {
          commandLines.push({
            commandLine: currentCommand.join(' '),
            lineNumber: i,
          });
        }
        inCommand = false;
        currentCommand = [];

        nonCommandLines.push(line);
      }
    }

    if (inCommand && currentCommand.length > 0) {
      commandLines.push({
        commandLine: currentCommand.join(' '),
        lineNumber: lines.length - 1,
      });
    }

    const cleanedBody = nonCommandLines.join('\n');
    const originalBody = lines.join('\n');

    logger.debug('Email command extraction complete', {
      commandCount: commandLines.length,
      originalLength: emailBody.length,
      cleanedLength: cleanedBody.length,
      commandLines: commandLines.map(c => c.commandLine),
    });

    return {
      cleanedBody,
      commandLines,
      originalBody,
    };
  }

  private isCommandStart(line: string): boolean {
    if (!line) return false;
    return line.trim().toLowerCase().startsWith(this.options.commandPrefix.toLowerCase());
  }

  private isContinuationCharacter(line: string): boolean {
    if (!line) return false;
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.toLowerCase().startsWith(this.options.commandPrefix.toLowerCase());
  }

  cleanBody(emailBody: string): string {
    const { cleanedBody } = this.extractCommands(emailBody);
    return cleanedBody;
  }

  private parseCommandName(commandLine: string): string {
    if (!commandLine || !commandLine.trim()) {
      return '';
    }

    const parts = commandLine.trim().split(/\s+/);
    if (parts.length === 1) {
      return '';
    }

    return parts[1]?.trim() || '';
  }
}
