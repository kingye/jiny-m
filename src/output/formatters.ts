import type { Email, OutputFormat } from '../types';
import { truncateString, formatDate, formatFileSize } from '../utils/helpers';

export interface FormatterOptions {
  format: OutputFormat;
  includeHeaders: boolean;
  includeAttachments: boolean;
  truncateLength?: number;
}

export class OutputFormatter {
  private options: FormatterOptions;
  
  constructor(options: FormatterOptions) {
    this.options = options;
  }
  
  format(email: Email): string {
    if (this.options.format === 'json') {
      return this.formatJson(email);
    }
    return this.formatText(email);
  }
  
  private formatText(email: Email): string {
    const lines: string[] = [];
    const separator = '='.repeat(80);
    
    lines.push(separator);
    lines.push(`📧 MATCHED EMAIL: ${email.matchedPattern || 'Unknown Pattern'}`);
    lines.push(separator);
    
    if (this.options.includeHeaders) {
      lines.push('');
      lines.push(`From: ${email.from}`);
      lines.push(`To: ${email.to.join(', ')}`);
      lines.push(`Subject: ${email.subject}`);
      lines.push(`Date: ${formatDate(email.date)}`);
      
      if (Object.keys(email.headers).length > 0) {
        lines.push('');
        lines.push('Headers:');
        for (const [key, value] of Object.entries(email.headers)) {
          lines.push(`  ${key}: ${value}`);
        }
      }
    }
    
    lines.push('');
    lines.push('Body:');
    
    if (email.body.text) {
      const text = this.options.truncateLength 
        ? truncateString(email.body.text, this.options.truncateLength)
        : email.body.text;
      lines.push(text);
    }
    
    if (email.body.html) {
      lines.push('');
      lines.push('HTML content available');
    }
    
    if (this.options.includeAttachments && email.attachments && email.attachments.length > 0) {
      lines.push('');
      lines.push('Attachments:');
      for (const attachment of email.attachments) {
        lines.push(`  - ${attachment.filename} (${attachment.contentType}, ${formatFileSize(attachment.size)})`);
      }
    }
    
    lines.push('');
    lines.push(separator);
    
    return lines.join('\n');
  }
  
  private formatJson(email: Email): string {
    const jsonOutput: any = {
      matchedPattern: email.matchedPattern,
      from: email.from,
      to: email.to,
      subject: email.subject,
      date: email.date.toISOString(),
    };
    
    if (this.options.includeHeaders) {
      jsonOutput.headers = email.headers;
    }
    
    if (email.body.text) {
      jsonOutput.body = {
        text: this.options.truncateLength 
          ? truncateString(email.body.text, this.options.truncateLength)
          : email.body.text,
      };
    }
    
    if (email.body.html) {
      jsonOutput.body = jsonOutput.body || {};
      jsonOutput.body.hasHtml = true;
    }
    
    if (this.options.includeAttachments && email.attachments) {
      jsonOutput.attachments = email.attachments.map(att => ({
        filename: att.filename,
        contentType: att.contentType,
        size: att.size,
      }));
    }
    
    return JSON.stringify(jsonOutput, null, 2);
  }
  
  static create(options: FormatterOptions): OutputFormatter {
    return new OutputFormatter(options);
  }
}

export const defaultFormatter = new OutputFormatter({
  format: 'text',
  includeHeaders: true,
  includeAttachments: false,
  truncateLength: 1000,
});