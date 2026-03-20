export function validateRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export function extractDomain(email: string): string | null {
  const parts = email.toLowerCase().split('@');
  return parts.length === 2 ? (parts[1] ?? null) : null;
}

/**
 * Strip common reply/forward prefixes from the subject.
 * Handles: Re:, RE:, re:, Fwd:, FWD:, fwd:, 回复, 转发
 * Strips ALL sequential prefixes from the beginning.
 */
export function stripReplyPrefix(subject: string): string {
  const prefixRegex = /^\s*(re|fwd?|回复|转发|RÉ|RÉF|FS)\s*[:：]\s*/i;
  let result = subject;

  while (prefixRegex.test(result)) {
    result = result.replace(prefixRegex, '');
  }

  return result;
}

export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...';
}

export function formatDate(date: Date): string {
  return date.toLocaleString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Parse a human-readable file size string (e.g. "25mb", "150kb", "1gb") into bytes.
 * Also accepts plain numbers (treated as bytes).
 */
export function parseFileSize(input: string | number): number {
  if (typeof input === 'number') return input;
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid file size format: "${input}". Use e.g. "25mb", "150kb", "1gb"`);
  }
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };
  return Math.round(value * multipliers[unit]!);
}