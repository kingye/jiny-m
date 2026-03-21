import type { CommandHandler, ParsedCommand } from './CommandHandler';
import type { CommandContext, CommandResult } from './CommandHandler';
import { logger } from '../logger';
import { ModelCommandHandler } from './handlers/ModelCommandHandler';

export class CommandRegistry {
  private handlers: Map<string, CommandHandler> = new Map();

  constructor() {
    this.registerDefaultHandlers();
  }

  private registerDefaultHandlers(): void {
    this.register(new ModelCommandHandler());
  }

  register(handler: CommandHandler): void {
    if (this.handlers.has(handler.name)) {
      logger.warn('Command handler already registered, overwriting', { name: handler.name });
    }
    this.handlers.set(handler.name, handler);
    logger.debug('Command handler registered', { name: handler.name });
  }

  unregister(name: string): boolean {
    const result = this.handlers.delete(name);
    if (result) {
      logger.debug('Command handler unregistered', { name });
    }
    return result;
  }

  list(): CommandHandler[] {
    return Array.from(this.handlers.values());
  }

  get(name: string): CommandHandler | undefined {
    return this.handlers.get(name);
  }

  parseCommands(text?: string): ParsedCommand[] {
    if (!text) {
      return [];
    }

    const commands: ParsedCommand[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('/')) {
        continue;
      }

      const parts = trimmed.split(/\s+/);
      const commandName = parts[0]?.toLowerCase();
      
      if (!commandName) {
        continue;
      }

      const handler = this.handlers.get(commandName);
      if (!handler) {
        logger.debug('Unknown command, skipping', { command: commandName });
        continue;
      }

      const args = parts.slice(1).filter(arg => arg.length > 0);

      commands.push({
        handler,
        args,
        rawLine: trimmed
      });
    }

    logger.debug('Commands parsed', { count: commands.length });
    return commands;
  }

  async execute(command: ParsedCommand, context: CommandContext): Promise<CommandResult> {
    logger.info('Executing command', { 
      handler: command.handler.name, 
      args: command.args,
      emailId: context.email.id 
    });

    try {
      const result = await command.handler.execute({
        ...context,
        args: command.args
      });

      if (result.success) {
        logger.info('Command executed successfully', { 
          handler: command.handler.name,
          attachmentCount: result.attachments?.length || 0
        });
      } else {
        logger.warn('Command execution failed', { 
          handler: command.handler.name,
          error: result.error
        });
      }

      return result;
    } catch (error) {
      logger.error('Command execution threw error', { 
        handler: command.handler.name,
        error: error instanceof Error ? error.message : 'Unknown error'
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  async executeAll(text: string, context: CommandContext): Promise<CommandResult[]> {
    const commands = this.parseCommands(text);
    const results: CommandResult[] = [];

    for (const command of commands) {
      const result = await this.execute(command, context);
      results.push(result);
    }

    return results;
  }
}
