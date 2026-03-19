export interface CommandContext {
  email: {
    id: string;
    from: string;
    subject: string;
    body?: { text?: string; html?: string };
    threadId?: string;
    headers?: Record<string, string>;
    messageId?: string;
    references?: string[];
    date?: Date;
  };
  threadPath: string;
  config: {
    maxFileSize: number;
    allowedExtensions: string[];
  };
  args?: string[];
  cleanedBody?: string;
  smtpService?: any;
  opencodeService?: any;
  storage?: any;
  replyConfig?: {
    mode: 'static' | 'opencode';
    text?: string;
  };
}

export interface CommandResult {
  success: boolean;
  attachments?: Array<{
    timestamp: string;
    filename: string;
    path: string;
    contentType: string;
  }>;
  error?: string;
}

export interface CommandHandler {
  name: string;
  description: string;
  execute(context: CommandContext): Promise<CommandResult>;
}

export interface ParsedCommand {
  handler: CommandHandler;
  args: string[];
  rawLine: string;
}
