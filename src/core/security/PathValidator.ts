import { normalize, join, basename } from 'node:path';

const MAX_FILENAME_LENGTH = 255;
const SAFE_FILENAME_PATTERN = /^[\w\-. ]+$/;

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class PathValidator {
  static validateFilePath(threadPath: string, filename: string): string {
    if (!filename || typeof filename !== 'string') {
      throw new SecurityError('Invalid filename');
    }

    if (filename.includes('\0')) {
      throw new SecurityError('Null byte detected in filename');
    }

    if (filename.length > MAX_FILENAME_LENGTH) {
      throw new SecurityError(`Filename exceeds maximum length of ${MAX_FILENAME_LENGTH}`);
    }

    if (!SAFE_FILENAME_PATTERN.test(filename)) {
      throw new SecurityError('Filename contains invalid characters');
    }

    const baseName = basename(filename);
    if (baseName !== filename) {
      throw new SecurityError('Path components not allowed in filename');
    }

    if (filename.startsWith('.')) {
      throw new SecurityError('Hidden filenames are not allowed');
    }

    const normalizedThread = normalize(threadPath);
    const fullPath = join(threadPath, filename);
    const normalizedPath = normalize(fullPath);

    const separator = process.platform === 'win32' ? '\\' : '/';
    
    if (!normalizedPath.startsWith(normalizedThread)) {
      throw new SecurityError('Path traversal detected');
    }

    if (normalizedPath !== normalizedThread && normalizedPath[normalizedThread.length] !== separator) {
      throw new SecurityError('Path traversal detected');
    }

    return normalizedPath;
  }

  static validateExtension(filename: string, allowedExtensions: string[]): void {
    const ext = '.' + filename.split('.').pop()?.toLowerCase() || '';
    
    if (!allowedExtensions.includes(ext)) {
      throw new SecurityError(`File extension '${ext}' is not allowed`);
    }
  }

  static validateFileSize(size: number, maxSize: number): void {
    if (!Number.isFinite(size) || size < 0) {
      throw new SecurityError('Invalid file size');
    }

    if (size > maxSize) {
      throw new SecurityError(`File size ${size} exceeds maximum allowed size of ${maxSize}`);
    }
  }
}
