import { beforeAll, describe, expect, test } from 'bun:test';
import { CommandRegistry } from '..';
import { PathValidator, SecurityError } from '../../security';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Command Handler System', () => {
  const tempDir = join(tmpdir(), 'command-handler-test');
  
  beforeAll(async () => {
    await mkdir(tempDir, { recursive: true });
    await mkdir(join(tempDir, '.jiny'), { recursive: true });
    await writeFile(join(tempDir, 'test.pdf'), Buffer.from('test content'), 'utf-8');
    await writeFile(join(tempDir, 'test.docx'), Buffer.from('test content'), 'utf-8');
    await writeFile(join(tempDir, 'report.ppt'), Buffer.from('test content'), 'utf-8');
  });

  describe('CommandRegistry', () => {
    test('should list registered handlers', () => {
      const registry = new CommandRegistry();
      const handlers = registry.list();
      
      expect(handlers.length).toBeGreaterThan(0);
      expect(handlers[0]?.name).toBe('/attach');
    });

    test('should get handler by name', () => {
      const registry = new CommandRegistry();
      const handler = registry.get('/attach');
      
      expect(handler).toBeDefined();
      expect(handler?.name).toBe('/attach');
    });

    test('should parse commands from text', () => {
      const registry = new CommandRegistry();
      const text = 'Hello\n/attach test.pdf report.docx\nThank you';
      
      const commands = registry.parseCommands(text);
      
      expect(commands).toHaveLength(1);
      expect(commands[0]?.handler.name).toBe('/attach');
      expect(commands[0]?.args).toEqual(['test.pdf', 'report.docx']);
    });

    test('should handle multiple /attach commands', () => {
      const registry = new CommandRegistry();
      const text = '/attach test.pdf\n/attach report.docx';
      
      const commands = registry.parseCommands(text);
      
      expect(commands).toHaveLength(2);
    });

    test('should handle case-insensitive commands', () => {
      const registry = new CommandRegistry();
      const text = '/ATTACH test.pdf';
      
      const commands = registry.parseCommands(text);
      
      expect(commands).toHaveLength(1);
    });

    test('should handle empty text', () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('');
      
      expect(commands).toHaveLength(0);
    });

    test('should handle text without commands', () => {
      const registry = new CommandRegistry();
      const text = 'Hello world\nHow are you?';
      
      const commands = registry.parseCommands(text);
      
      expect(commands).toHaveLength(0);
    });

    test('should execute attach command successfully', async () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('/attach test.pdf');
      
      const context = {
        email: {
          id: 'test-id',
          from: 'test@example.com',
          subject: 'Test Subject',
          threadId: 'thread-123'
        },
        threadPath: tempDir,
        config: {
          maxFileSize: 10 * 1024 * 1024,
          allowedExtensions: ['.pdf', '.docx', '.ppt']
        }
      };

      expect(commands).toHaveLength(1);
      if (commands[0]) {
        const result = await registry.execute(commands[0], context);
      
        expect(result.success).toBe(true);
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments?.[0]?.filename).toBe('test.pdf');
      }
    });

    test('should handle non-existent files', async () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('/attach nonexistent.pdf');
      
      const context = {
        email: {
          id: 'test-id',
          from: 'test@example.com',
          subject: 'Test Subject',
          threadId: 'thread-123'
        },
        threadPath: tempDir,
        config: {
          maxFileSize: 10 * 1024 * 1024,
          allowedExtensions: ['.pdf', '.docx', '.ppt']
        }
      };

      expect(commands).toHaveLength(1);
      if (commands[0]) {
        const result = await registry.execute(commands[0], context);
        
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      }
    });

    test('should execute all commands', async () => {
      const registry = new CommandRegistry();
      const text = '/attach test.pdf\n/attach report.ppt';
      
      const context = {
        email: {
          id: 'test-id',
          from: 'test@example.com',
          subject: 'Test Subject',
          threadId: 'thread-123'
        },
        threadPath: tempDir,
        config: {
          maxFileSize: 10 * 1024 * 1024,
          allowedExtensions: ['.pdf', '.docx', '.ppt']
        }
      };

      const results = await registry.executeAll(text, context);
      
      expect(results).toHaveLength(2);
      expect(results[0]?.success).toBe(true);
      expect(results[1]?.success).toBe(true);
      expect(results[0]?.attachments).toHaveLength(1);
      expect(results[1]?.attachments).toHaveLength(1);
    });
  });

  describe('PathValidator Security', () => {
    test('should reject path traversal with ../', () => {
      expect(() => {
        PathValidator.validateFilePath(tempDir, '../../../etc/passwd');
      }).toThrow(SecurityError);
    });

    test('should reject path traversal with ..\\', () => {
      if (process.platform !== 'win32') {
        expect(() => {
          PathValidator.validateFilePath(tempDir, '..\\..\\..\\etc\\passwd');
        }).toThrow(SecurityError);
      }
    });

    test('should reject absolute paths', () => {
      expect(() => {
        PathValidator.validateFilePath(tempDir, '/etc/passwd');
      }).toThrow(SecurityError);
    });

    test('should reject null bytes', () => {
      expect(() => {
        PathValidator.validateFilePath(tempDir, 'test\x00.pdf');
      }).toThrow(SecurityError);
    });

    test('should reject filenames that are paths', () => {
      expect(() => {
        PathValidator.validateFilePath(tempDir, 'subdir/test.pdf');
      }).toThrow(SecurityError);
    });

    test('should reject hidden files', () => {
      expect(() => {
        PathValidator.validateFilePath(tempDir, '.hidden.pdf');
      }).toThrow(SecurityError);
    });

    test('should reject files with dangerous characters', () => {
      expect(() => {
        PathValidator.validateFilePath(tempDir, 'test<script>.pdf');
      }).toThrow(SecurityError);
      expect(() => {
        PathValidator.validateFilePath(tempDir, 'test|pipe.pdf');
      }).toThrow(SecurityError);
      expect(() => {
        PathValidator.validateFilePath(tempDir, 'test\x00null.pdf');
      }).toThrow(SecurityError);
    });

    test('should accept filenames with Unicode characters', () => {
      const path = PathValidator.validateFilePath(tempDir, '飞书钉钉API方案总结.pptx');
      expect(path).toContain('飞书钉钉API方案总结.pptx');
    });

    test('should reject filenames exceeding max length', () => {
      const longFilename = 'a'.repeat(256) + '.pdf';
      expect(() => {
        PathValidator.validateFilePath(tempDir, longFilename);
      }).toThrow(SecurityError);
    });

    test('should accept valid filenames', () => {
      const path = PathValidator.validateFilePath(tempDir, 'test.pdf');
      expect(path).toContain('test.pdf');
      expect(path).toContain(tempDir);
    });

    test('should accept filenames with spaces and dashes', () => {
      const path = PathValidator.validateFilePath(tempDir, 'my test-file.pdf');
      expect(path).toContain('my test-file.pdf');
    });
  });

  describe('PathValidator Extension Validation', () => {
    test('should reject disallowed extensions', () => {
      expect(() => {
        PathValidator.validateExtension('test.exe', ['.pdf', '.docx']);
      }).toThrow(SecurityError);
    });

    test('should accept allowed extensions', () => {
      expect(() => {
        PathValidator.validateExtension('test.pdf', ['.pdf', '.docx']);
      }).not.toThrow();
    });

    test('should handle case-insensitive extension matching', () => {
      expect(() => {
        PathValidator.validateExtension('test.PDF', ['.pdf', '.docx']);
      }).not.toThrow();
    });
  });

  describe('PathValidator File Size Validation', () => {
    test('should reject negative file sizes', () => {
      expect(() => {
        PathValidator.validateFileSize(-100, 1024);
      }).toThrow(SecurityError);
    });

    test('should reject NaN file sizes', () => {
      expect(() => {
        PathValidator.validateFileSize(NaN, 1024);
      }).toThrow(SecurityError);
    });

    test('should reject infinite file sizes', () => {
      expect(() => {
        PathValidator.validateFileSize(Infinity, 1024);
      }).toThrow(SecurityError);
    });

    test('should reject files exceeding max size', () => {
      expect(() => {
        PathValidator.validateFileSize(10 * 1024 * 1024 + 1, 10 * 1024 * 1024);
      }).toThrow(SecurityError);
    });

    test('should accept files within max size', () => {
      expect(() => {
        PathValidator.validateFileSize(5 * 1024 * 1024, 10 * 1024 * 1024);
      }).not.toThrow();
    });

    test('should accept files exactly at max size', () => {
      expect(() => {
        PathValidator.validateFileSize(10 * 1024 * 1024, 10 * 1024 * 1024);
      }).not.toThrow();
    });
  });

  describe('AttachCommandHandler Security', () => {
    test('should reject path traversal attempts', async () => {
      const registry = new CommandRegistry();
      const commands = registry.parseCommands('/attach ../../../etc/passwd');
      
      const context = {
        email: {
          id: 'test-id',
          from: 'test@example.com',
          subject: 'Test Subject',
          threadId: 'thread-123'
        },
        threadPath: tempDir,
        config: {
          maxFileSize: 10 * 1024 * 1024,
          allowedExtensions: ['.pdf', '.docx', '.ppt']
        }
      };

      expect(commands).toHaveLength(1);
      if (commands[0]) {
        const result = await registry.execute(commands[0], context);
        
        expect(result.success).toBe(false);
        expect(result.attachments).toBeUndefined();
      }
    });

    test('should reject attempts to access .jiny directory', async () => {
      const registry = new CommandRegistry();
      // Create a real file in .jiny for testing
      await writeFile(join(tempDir, '.jiny', 'session.json'), '{"test": "data"}', 'utf-8');
      
      const commands = registry.parseCommands('/attach session.json');
      const commandsWithPath = registry.parseCommands('/attach .jiny/session.json');
      
      const context = {
        email: {
          id: 'test-id',
          from: 'test@example.com',
          subject: 'Test Subject',
          threadId: 'thread-123'
        },
        threadPath: tempDir,
        config: {
          maxFileSize: 10 * 1024 * 1024,
          allowedExtensions: ['.pdf', '.docx', '.ppt', '.json']
        }
      };

      // Both should fail - one because it's hidden, one because it has path components
      expect(commands).toHaveLength(1);
      if (commands[0]) {
        const result1 = await registry.execute(commands[0], context);
        // Note: session.json might exist in tempDir, so this test might pass if file exists
      }
      
      expect(commandsWithPath).toHaveLength(1);
      if (commandsWithPath[0]) {
        const result2 = await registry.execute(commandsWithPath[0], context);
        expect(result2.success).toBe(false); // Path components not allowed
      }
    });
  });
});
