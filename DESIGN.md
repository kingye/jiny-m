# Jiny-M Email Monitor Design

## Overview
Email monitoring CLI that connects to IMAP servers, watches for incoming emails, and displays content when sender/subject match configurable patterns.

## Architecture

### Components
1. **Config Manager** - Load and validate configuration
2. **IMAP Client** - Connect to email server and monitor inbox
3. **Pattern Matcher** - Check sender and subject against rules
4. **Email Parser** - Extract content (body, attachments) from email
5. **CLI Output** - Format and display matched emails
6. **Log Manager** - Handle logging and error reporting

## Configuration Structure

```typescript
interface Config {
  imap: {
    host: string;
    port: number;
    username: string;
    password: string;
    tls: boolean;
  };
  smtp?: {
    host: string;
    port: number;
    username: string;
    password: string;
  };
  watch: {
    checkInterval: number; // seconds
    maxRetries: number;
  };
  patterns: Pattern[];
  output: {
    format: 'text' | 'json';
    includeHeaders: boolean;
    includeAttachments: boolean;
  };
}

interface Pattern {
  name: string;
  sender?: {
    regex?: string;
    exact?: string[];
    domain?: string[];
  };
  subject?: {
    regex?: string;
    exact?: string[];
    contains?: string[];
  };
  caseSensitive?: boolean;
}
```

## Email Processing Flow

```
1. Load configuration from file/CLI args
2. Connect to IMAP server
3. Start monitoring loop:
   - Check for new emails (IDLE or polling)
   - For each new email:
     a. Fetch headers (From, Subject)
     b. Run pattern matching
     c. If match: fetch full body and attachments
     d. Parse email content
     e. Display to console
     f. Optionally mark as read or move to folder
```

## Pattern Matching Strategy

### Types
- **Exact match** - Sender email equals pattern
- **Domain match** - Email domain matches  
- **Regex match** - Regular expression on sender/subject
- **Contains match** - String contains pattern

### Matching Logic
```
For each pattern:
  senderMatch = checkSender(email.from, pattern.sender)
  subjectMatch = checkSubject(email.subject, pattern.subject)
  
  Return pattern.name if (senderMatch AND subjectMatch)
```

## CLI Interface

```
jiny-m monitor [options]

Options:
  -c, --config <file>    Config file path (default: ./jiny-m.config.json)
  --patterns <file>      Patterns file path
  --once                 Check once and exit
  --no-idle              Use polling instead of IMAP IDLE
  
jiny-m config init      Generate default config file
jiny-m patterns add      Add new pattern interactively
jiny-m list              List active patterns
```

## Technical Decisions

### IMAP Library
- Use `imapflow` - Modern, Promise-based IMAP client with IDLE support

### Email Parsing  
- Use `mailparser` - Parse MIME messages reliably

### Configuration
- JSON config for simplicity
- Environment variable support for credentials

### Error Handling
- Connection retry with exponential backoff
- Graceful degradation if server doesn't support IDLE
- Detailed logging for troubleshooting

## File Structure
```
jiny-m/
├── src/
│   ├── cli/
│   │   ├── index.ts         # CLI entry point and command setup
│   │   └── commands/        # Individual CLI commands
│   │       ├── monitor.ts   # Monitor command implementation
│   │       ├── config.ts    # Config management commands
│   │       └── patterns.ts  # Pattern management commands
│   ├── config/
│   │   ├── index.ts         # Config loader and validator
│   │   └── schemas.ts       # Configuration validation schemas
│   ├── services/
│   │   ├── imap/
│   │   │   ├── index.ts     # IMAP connection service
│   │   │   └── monitor.ts   # IMAP email monitoring logic
│   │   └── smtp/
│   │       └── index.ts     # SMTP service (future)
│   ├── core/
│   │   ├── pattern-matcher.ts # Pattern matching logic
│   │   ├── email-parser.ts   # Email content parsing
│   │   └── logger.ts          # Logging utilities
│   ├── output/
│   │   ├── index.ts         # Output formatting interface
│   │   └── formatters.ts    # Text/JSON formatters
│   ├── types/
│   │   └── index.ts         # TypeScript type definitions
│   └── utils/
│       ├── helpers.ts       # Helper functions
│       └── constants.ts     # Application constants
├── jiny-m                   # CLI executable
├── DESIGN.md               # Design documentation
└── package.json
```

## Security Considerations
- Support environment variables for credentials
- Encrypt password storage option
- Validate regex patterns to prevent DoS
- Rate limiting for API calls

## Future Enhancements
- SMTP support for sending notifications
- Multiple IMAP account monitoring
- Webhook integration for matched emails
- Database logging of matches
- Filter rules based on email content
- Attachment processing