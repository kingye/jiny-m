# Jiny-M: Mail-Based AI Agent

## Overview
Jiny-M is an AI agent that operates through email. Users interact with the agent by sending emails, and the agent responds autonomously using OpenCode AI. The agent maintains conversation context per thread, enabling coherent multi-turn interactions.

**Core Concept:** Email is the interface; AI is the brain.

## Use Cases
- **Support Agent** - Automatically respond to support inquiries with context-aware replies
- **Task Automation** - Execute tasks requested via email and respond with results
- **Notification Processor** - Process notifications and take action based on content
- **Personal Assistant** - Manage schedules, reminders, and information requests via email

## Architecture

### High-Level Flow
```
User sends email → Pattern Match → AI Agent → Reply via Email
                              ↓
                    Thread-based context
                    (remembers conversation)
```

### Components
1. **AI Agent (OpenCode Service)** - Generate intelligent responses, maintain session context
2. **Pattern Matcher** - Route emails to appropriate agent behavior based on sender/subject
3. **Thread Manager** - Organize conversations, persist AI sessions per thread
4. **IMAP Client** - Receive emails from mail server
5. **SMTP Client** - Send AI-generated replies
6. **Email Parser** - Extract content (body, attachments) from email
7. **Storage** - Persist emails and session state per thread
8. **Command System** - Parse and execute email-embedded commands (e.g., `/attach`)
9. **State Manager** - Track processed UIDs, handle migrations, enable recovery mode
10. **Security Module** - Path validation, file size/extension checks for attachments
11. **MCP Reply Tool** - Stateless MCP server providing OpenCode with a `reply_email` tool for sending thread-scoped replies

## AI Agent Core

### Session-Based Thread Management
Each email thread has a dedicated OpenCode session persisted in `session.json`. This enables:
- **Memory** - AI remembers previous replies in the conversation
- **Coherence** - Consistent responses across the thread
- **Context** - Full conversation history available
- **Debugging** - Can inspect/replay sessions in OpenCode TUI

### Agent Flow Diagram
```
New Email Arrives
       ↓
Pattern Match
       ↓
storage.store(email) → threadPath
       ↓
Check session.json in threadPath
       ↓
   ┌───┴───┐
   │       │
Exists   Not Exists
   │       │
   ↓       ↓
Verify   Create new
session  session
   │       │
   └───┬───┘
       ↓
Build prompt with <reply_context> block
       ↓
session.prompt(prompt + context)
       ↓
OpenCode calls reply_email MCP tool
       ↓
MCP Tool: validate context hash
        → compose threadPath from threadName
        → SmtpService.replyToEmail()
        → EmailStorage.storeReply()
       ↓
Update session.json
       ↓
(fallback: if tool not used, monitor sends SMTP directly)
```

### Thread Context Flow
```
Email 1 → New Session → AI: "I need help" → Reply 1
          session.json: { id: "abc", emailCount: 1 }

Email 2 → Load Session "abc" → AI sees history:
          - Email 1 + Reply 1
          - Email 2: "Thanks, but still broken"
          → Reply 2 (context-aware)

          session.json: { id: "abc", emailCount: 2 }

Email 3 (after restart) → Session lost → Create new session "xyz"
          → AI sees history from thread context files
          → Reply 3 (context via files, no session memory)

          session.json: { id: "xyz", emailCount: 1 }
```

### Context Management Strategy

To balance context depth with token limits, the agent uses a multi-layered approach:

1. **Thread Files (Durable)** - Last 5 markdown files stored in thread folder
   - Includes both received emails and AI auto-replies
   - Files are limited to 400 chars each (1,000 chars total)
   - Email files have quoted history stripped for cleanliness
   - General files are included as-is (no stripping)

2. **OpenCode Session (Ephemeral)** - Conversation memory maintained by OpenCode
   - Persists only while server instance is alive
   - Lost on jiny-m restart
   - Contains condensed message history
   - More efficient than raw files

3. **Incoming Email (Current)** - Latest email being processed
   - Body stripped of quoted reply history
   - Subject cleaned of repeated Reply/Fwd prefixes
   - Limited to 2,000 chars

**Context Limits Configured:**
```
MAX_FILES_IN_CONTEXT = 10          // Total markdown files to load
MAX_EMAIL_REPLY_FILES = 2          // Email reply files specifically
MAX_BODY_IN_PROMPT = 2000          // Incoming email body
MAX_PER_FILE = 400                 // Per-file context
MAX_TOTAL_CONTEXT = 2000           // Combined thread context
MAX_TOTAL_PROMPT = 6000            // Total prompt to AI
```

**Email Body Cleaning:**
- Remove deeply nested quoted lines (≥3 levels of `>`)
- Strip reply headers (`发件人:`, `发件时间:`, `From:`, `Sent:`, etc.)
- Remove divider lines (`---`, `===`, `***`)
- Collapse multiple empty lines to max 2
- Keep only the new content from the sender

**Thread File Processing:**
- Email files: Extract body only (between `## Name (time)` and `---`), then strip quoted history
- Auto-reply files: Skipped (already visible in conversation history)
- General files: Included as-is (useful for reference documents)

### Types (`src/types/index.ts`)

```typescript
interface ReplyConfig {
  enabled: boolean;
  mode: 'static' | 'opencode';
  text?: string;                 // for static mode (fallback/testing)
  opencode?: OpenCodeConfig;     // for opencode mode
}

interface OpenCodeConfig {
  enabled: boolean;
  hostname?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  includeThreadHistory?: boolean;
  contextSecret?: string;          // HMAC secret for reply context validation (supports ${ENV_VAR})
}

interface AiGeneratedReply {
  text: string;
  attachments: GeneratedFile[];
  replySentByTool: boolean;        // true if MCP reply_email tool already sent the reply
}

interface ReconnectConfig {
  maxAttempts: number;           // max reconnection attempts (default: 10)
  baseDelay: number;             // base delay in ms (default: 5000)
  maxDelay: number;              // max delay in ms (default: 60000)
}

interface WatchConfig {
  checkInterval: number;         // seconds between checks (default: 30)
  maxRetries: number;            // max connection retries (default: 5)
  useIdle?: boolean;             // use IMAP IDLE (default: true)
  folder?: string;               // mailbox to monitor (default: "INBOX")
  reconnect?: ReconnectConfig;   // reconnection behavior
  maxNewEmailThreshold?: number; // max new emails before triggering recovery (default: 50)
  enableRecoveryMode?: boolean;  // enable UID-based recovery (default: true)
  disableConsistencyCheck?: boolean; // disable suspicious jump detection (default: false)
}
```

### OpenCode Server Architecture

A single shared OpenCode server handles all email threads. Each thread session operates in its designated directory via the `query.directory` parameter.

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenCodeService                          │
│                                                             │
│  Single Server (auto-port: 5000+)                           │
│       ↓                                                     │
│  Shared Client                                              │
│       ↓                                                     │
│  MCP Tool: jiny-reply (registered once at startup)          │
│  └─ reply_email tool (stdio, spawns src/mcp/reply-tool.ts)  │
│       ↓                                                     │
│  ┌─────────────────────────────────────┐                    │
│  │ Sessions (per-thread directory)     │                    │
│  │                                     │                    │
│  │ Thread A → session.json + .opencode/│                    │
│  │ Thread B → session.json + .opencode/│                    │
│  │ Thread C → session.json + .opencode/│                    │
│  └─────────────────────────────────────┘                    │
│                                                             │
│  Server lives until CLI exits                               │
└─────────────────────────────────────────────────────────────┘
```

#### Key Points:
- **Single server** - Auto-started on first request, auto-finds free port from 5000
- **Shared client** - One client instance for all sessions
- **MCP tool registered once** - `jiny-reply` MCP server spawned at startup, stays alive for all emails
- **Per-session directory** - `query.directory` parameter tells OpenCode where to work
- **Thread isolation** - Each thread has its own session and `.opencode/` directory
- **Simple lifecycle** - Server starts on first use, closes when CLI exits

#### Server Lifecycle Flow

```
First Email Arrives
       ↓
ensureServerStarted()
       ↓
Server not running?
       ↓
Yes → Find free port (5000+)
     → Start OpenCode server
     → Store server/client
     → Register jiny-reply MCP tool (once)
       ↓
No → Use existing client
       ↓
Create session with directory=threadPath
       ↓
Build prompt with <reply_context> block
       ↓
Generate AI reply (OpenCode calls reply_email tool)
       ↓
CLI exits → close()
```

### OpenCode Service (`src/services/opencode/index.ts`)

```typescript
export class OpenCodeService {
  private config: OpenCodeConfig;
  private server: { close: () => void } | null = null;
  private client: OpenCodeClient | null = null;
  private port: number | null = null;
  private contextSecret: string;
  
  constructor(config: OpenCodeConfig) {
    this.config = config;
    // Resolve from config (supports ${ENV_VAR}) or generate random
    this.contextSecret = config.contextSecret || crypto.randomUUID();
  }
  
  private async ensureServerStarted(): Promise<void> {
    if (this.server && this.client) return;
    
    const port = await this.findFreePort();
    const result = await createOpencode({
      hostname: this.config.hostname || '127.0.0.1',
      port,
    });
    
    this.server = result.server;
    this.client = result.client;
    this.port = port;

    // Register MCP reply tool once at startup
    await this.client.mcp.add({
      body: {
        name: 'jiny-reply',
        config: {
          type: 'local',
          command: ['bun', 'run', resolve('src/mcp/reply-tool.ts')],
          environment: { JINY_CONTEXT_SECRET: this.contextSecret },
          enabled: true,
          timeout: 60000,
        }
      }
    });
  }
  
  async generateReply(email: Email, threadPath: string): Promise<AiGeneratedReply> {
    await this.ensureServerStarted();
    
    const session = await this.getOrCreateSession(threadPath);
    const prompt = await this.buildPrompt(email, threadPath);
    
    const result = await this.client.session.prompt({
      path: { id: session.sessionId },
      query: { directory: threadPath },
      body: {
        model: this.getModelConfig(),
        parts: [{ type: 'text', text: prompt }],
      },
    });
    
    const aiReply = this.extractAiReply(result.data.parts);
    // Check if reply_email tool was called successfully
    aiReply.replySentByTool = this.checkToolUsed(result.data.parts);
    return aiReply;
  }

  private async buildPrompt(email: Email, threadPath: string): Promise<string> {
    // ... thread context + incoming email (unchanged) ...

    // Embed reply context for the MCP tool
    const threadName = basename(threadPath);
    const replyContext = serializeContext(email, threadName, this.contextSecret);
    parts.push('');
    parts.push('<reply_context>' + replyContext + '</reply_context>');
    parts.push('');
    parts.push('Use the reply_email tool to send your reply.');
    parts.push('Pass the <reply_context> block content verbatim as the `context` parameter.');

    return parts.join('\n');
  }
}
```

### ContextOverflow Recovery

When the accumulated conversation history in an OpenCode session exceeds the model's context limit:

```
AI Prompt → ContextOverflowError
    ↓
Detect Error (error.name === 'ContextOverflowError')
    ↓
Log warning with old sessionId
    ↓
Create new session (clears history)
    ↓
Retry prompt with new session
    ↓
If still empty → Log full response
```

**Key Behavior:**
- Only happens when session history becomes too large to compact
- Creates fresh session with no accumulated memory
- Thread files still provide recent conversation context
- Logs both old and new session IDs for debugging
- Allows continued operation without manual intervention
    if (this.server) {
      this.server.close();
      this.server = null;
      this.client = null;
    }
  }
}
```

## MCP Reply Tool

### Overview

OpenCode is given a `reply_email` MCP tool so the AI agent can send email replies directly. The tool is a stateless local MCP server (`src/mcp/reply-tool.ts`) spawned via stdio transport. It is registered once when the OpenCode server starts and stays alive for all email processing.

The email context (recipient, subject, threading headers, thread name) is serialized as a JSON block in the prompt text. OpenCode must pass this context verbatim when calling the tool. An HMAC-SHA256 hash prevents the AI from tampering with the context (e.g., redirecting emails to a different recipient).

### Architecture

```
Monitor receives email
    ↓
OpenCodeService.generateReply(email, threadPath)
    ↓
buildPrompt() embeds context:
  <reply_context>{"threadName":"Server_is_down","to":"user@example.com",
    "subject":"Re: Server is down","messageId":"<abc@mail>",
    "references":["<xyz@mail>"],"from":"user@example.com",
    "fromName":"John","date":"2026-03-19T10:00:00Z",
    "bodyText":"original body...","contextHash":"hmac..."}
  </reply_context>
    ↓
System prompt instructs: "Use reply_email tool.
  Pass the <reply_context> block verbatim as the `context` parameter."
    ↓
OpenCode calls MCP tool: reply_email(message, context, attachments?)
    ↓
MCP Server (stdio subprocess):
  1. Parse context JSON, validate contextHash (HMAC-SHA256)
  2. Load config via ConfigManager (reuses ${ENV_VAR} expansion)
  3. Compose threadPath = join(cwd, workspace.folder, context.threadName)
  4. Validate attachments via PathValidator (exclude .opencode/, .jiny/)
  5. Reconstruct Email object from context
  6. SmtpService.replyToEmail(email, message, attachments)
  7. EmailStorage.storeReply(threadPath, message, email)
  8. Return { success, sentTo, attachmentCount }
```

### Tool Definition

**Tool name:** `reply_email`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | yes | The reply text to send |
| `context` | string | yes | The `<reply_context>` JSON from the prompt, passed verbatim |
| `attachments` | string[] | no | Filenames within the thread directory to attach |

### Context Object (`src/mcp/context.ts`)

```typescript
interface EmailReplyContext {
  threadName: string;        // Thread directory name (NOT a path)
  to: string;                // Recipient (from reply-to header or from)
  from: string;              // Original sender address
  fromName: string;          // Sender display name
  subject: string;           // Email subject
  date: string;              // ISO date string
  messageId?: string;        // For In-Reply-To header
  references?: string[];     // For References header
  bodyText?: string;         // Original body text (for quoting)
  bodyHtml?: string;         // Original body HTML (fallback for quoting)
  uid: number;               // Email UID
  contextHash: string;       // HMAC-SHA256 for tamper detection
}
```

**Serialization helpers:**
- `serializeContext(email, threadName, secret)` → JSON string with computed `contextHash`
- `deserializeAndValidateContext(json, secret)` → validated `EmailReplyContext` (throws on tamper)
- `contextToEmail(context)` → reconstructed `Email` object for `SmtpService.replyToEmail()`

### Context Security

The `contextHash` field is an HMAC-SHA256 computed over all context fields (excluding the hash itself) using a secret key:

```
contextHash = HMAC-SHA256(secret, JSON.stringify(contextFieldsSorted))
```

**Secret configuration:**
- Configured via `reply.opencode.contextSecret` in `.jiny/config.json`
- Supports `${ENV_VAR}` syntax via the existing `expandEnvVars()` mechanism
- If not provided, a random UUID is generated at startup (logged as a warning)
- The secret is passed to the MCP subprocess via the `JINY_CONTEXT_SECRET` environment variable (set once at MCP registration time, not per-email)

**Validation flow:**
1. Monitor embeds context with hash in prompt
2. OpenCode passes context verbatim to `reply_email` tool
3. MCP tool recomputes hash from received context fields + secret from env
4. If hash mismatch → tool returns error, monitor falls back to direct SMTP

### Code Reuse

The MCP tool directly imports existing project modules (Bun resolves imports relative to the file location):

| Module | Usage in MCP Tool |
|--------|-------------------|
| `SmtpService` | `replyToEmail(email, message, attachments)` -- handles quoting, threading headers, HTML conversion |
| `EmailStorage` | `storeReply(threadPath, message, email)` -- writes `auto-reply.md` |
| `PathValidator` | `validateFilePath()`, `validateExtension()`, `validateFileSize()` -- attachment security |
| `ConfigManager` | `ConfigManager.create()` -- loads config with `${ENV_VAR}` expansion |

### Attachment Validation

When the `attachments` parameter is provided:

1. For each filename: `PathValidator.validateFilePath(threadPath, filename)` → safe absolute path
2. Reject if the resolved path contains `.opencode` or `.jiny` path segments
3. `PathValidator.validateExtension(filename, config.reply.attachments.allowedExtensions)`
4. `PathValidator.validateFileSize(stat.size, config.reply.attachments.maxFileSize)`
5. Check file exists and is not a directory

### Thread Path Composition

The tool receives `threadName` (not a raw path) and composes the thread path server-side:

```typescript
const config = await ConfigManager.create();
const workspaceFolder = join(process.cwd(), config.getWorkspaceConfig().folder);
const threadPath = join(workspaceFolder, context.threadName);
```

This ensures OpenCode cannot specify arbitrary filesystem paths.

### Fallback Behavior

| Scenario | What Happens |
|----------|-------------|
| OpenCode uses `reply_email` tool successfully | Monitor sees `replySentByTool: true`, skips its own SMTP/store |
| OpenCode returns text without using tool | Monitor sees `replySentByTool: false`, sends reply via current direct SMTP flow |
| Context hash fails validation | Tool returns error to OpenCode, monitor falls back to direct SMTP |
| SMTP fails in tool | Tool returns error, monitor falls back to direct SMTP |
| Attachment rejected (security) | Tool returns error with explanation, email may still be sent without attachments |

### File Structure

```
src/mcp/
├── reply-tool.ts          # MCP server (standalone, spawned by OpenCode via stdio)
└── context.ts             # EmailReplyContext serialization + HMAC validation
```

## Email Command System

Users can embed commands in email bodies to trigger special behaviors. Commands are extracted before the email body is sent to the AI agent.

### Architecture

```
Email Body
    ↓
EmailCommandExtractor.extractCommands()
    ↓
┌──────────────────┐
│ Has commands?     │
│                   │
│ Yes → CommandRegistry.parseCommands()
│       → CommandHandler.execute()
│       → Send reply with attachments
│                   │
│ No  → Normal AI reply flow
└──────────────────┘
```

### Components

1. **EmailCommandExtractor** (`src/core/command-parser.ts`) - Scans email body for command lines (e.g., `/attach file.pptx`), extracts them, and returns a cleaned body with commands removed.

2. **CommandRegistry** (`src/core/command-handler/CommandRegistry.ts`) - Registry of available command handlers. Parses command lines into `ParsedCommand` objects and dispatches to the appropriate handler.

3. **CommandHandler** (`src/core/command-handler/CommandHandler.ts`) - Interface for command handlers. Each handler receives a `CommandContext` with email metadata, thread path, config, and service references.

4. **AttachCommandHandler** (`src/core/command-handler/handlers/AttachCommandHandler.ts`) - Handles `/attach <filename>` commands. Validates file paths via `PathValidator`, checks file size/extension, attaches files to the reply email. If the email body (after command extraction) is non-empty, it generates an AI reply alongside the attachments.

### Supported Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/attach <file1> [file2] ...` | Attach files from thread directory | `/attach report.pptx summary.docx` |

### Command Flow

```
Email: "Please see attached\n/attach report.pptx"
    ↓
Extract commands: ["/attach report.pptx"]
Cleaned body: "Please see attached"
    ↓
CommandRegistry.parseCommands() → [{ handler: AttachCommandHandler, args: ["report.pptx"] }]
    ↓
AttachCommandHandler.execute()
    ↓
PathValidator.validateFilePath(threadPath, "report.pptx") → safe path
    ↓
Generate AI reply from cleaned body
    ↓
SMTP reply with AI text + attached report.pptx
```

### Security (`src/core/security/`)

The `PathValidator` class prevents path traversal and other file-based attacks:

- **Path traversal prevention** - Validates that resolved paths stay within `threadPath`
- **Null byte detection** - Rejects filenames containing null bytes
- **Filename sanitization** - Only allows `[\w\-. ]` characters, no hidden files (`.` prefix)
- **Extension allowlist** - Only configured extensions can be attached
- **File size limits** - Enforced via `AttachmentConfig.maxFileSize`

```typescript
class PathValidator {
  static validateFilePath(threadPath: string, filename: string): string;
  static validateExtension(filename: string, allowedExtensions: string[]): void;
  static validateFileSize(size: number, maxSize: number): void;
}
```

## UID-Based State Management

### Problem

Sequence-number-based tracking (`lastSequenceNumber`) breaks when emails are deleted or the mailbox is reorganized, since IMAP sequence numbers are reassigned. This can cause:
- **Missed emails** - if earlier emails are deleted, sequence numbers shift down
- **Duplicate processing** - if the monitor sees a "new" sequence number that was already processed
- **Suspicious jumps** - bulk imports or server-side moves can jump sequence count

### Solution: UID Set + Recovery Mode

The `StateManager` now maintains a persistent set of processed UIDs alongside the sequence-based state.

```
.jiny/
├── .state.json              # Sequence state + migration version + uidValidity
└── .processed-uids.txt      # One UID per line, append-only
```

### State Fields

```typescript
interface MonitorState {
  lastSequenceNumber: number;
  lastProcessedTimestamp: string;
  lastProcessedUid: number;
  uidValidity?: number;          // IMAP UIDVALIDITY for invalidation
  migrationVersion?: number;     // Tracks applied migrations
}
```

### Normal Mode vs Recovery Mode

```
Check for new emails
    ↓
currentCount = mailbox.exists
lastSeq = state.lastSequenceNumber
    ↓
┌─────────────────────────────────┐
│ currentCount < lastSeq?         │ → Deletion detected → Recovery
│ currentCount > lastSeq + 50?    │ → Suspicious jump   → Recovery
│ Otherwise                       │ → Normal fetch (lastSeq+1 : currentCount)
└─────────────────────────────────┘

Recovery Mode:
    ↓
Load .processed-uids.txt → Set<number>
    ↓
Check UIDVALIDITY (reset set if changed)
    ↓
Fetch ALL messages (1:currentCount)
    ↓
Filter: only process UIDs not in processed set
    ↓
Process new messages, track UIDs
    ↓
Update lastSequenceNumber = currentCount
```

### Migration System

On first startup after upgrade, `StateManager.ensureInitialized()` runs migrations:

- **Migration v1**: Connects to IMAP, fetches all current message UIDs, writes them to `.processed-uids.txt`. This seeds the UID set so existing emails are not reprocessed.

```
First start after upgrade
    ↓
StateManager.ensureInitialized()
    ↓
migrationVersion < 1?
    ↓
Yes → Connect to IMAP
    → Fetch all UIDs from mailbox
    → Write to .processed-uids.txt
    → Set migrationVersion = 1
    → Save state
```

### UID Tracking

- **On pattern match**: `StateManager.trackUid(uid)` appends the UID to `.processed-uids.txt`
- **On recovery**: Loads the full UID set, filters out already-processed UIDs
- **On UIDVALIDITY change**: Resets the UID set (UIDs are no longer valid)

## Configuration

### Full Config Structure

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
    tls?: boolean;
  };
  watch: {
    checkInterval: number;    // seconds
    maxRetries: number;
    useIdle?: boolean;        // use IMAP IDLE
    folder?: string;          // mailbox to monitor
  };
  patterns: Pattern[];
  output: {
    format: 'text' | 'json';
    includeHeaders: boolean;
    includeAttachments: boolean;
    truncateLength?: number;
  };
  workspace: {
    folder: string;           // where threads and sessions are stored
  };
  reply: ReplyConfig;         // AI agent configuration
}
```

### Configuration Example (`.jiny/config.json`)

```json
{
  "imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "username": "agent@example.com",
    "password": "${IMAP_PASSWORD}",
    "tls": true
  },
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "username": "agent@example.com",
    "password": "${SMTP_PASSWORD}",
    "tls": true
  },
  "watch": {
    "checkInterval": 30,
    "maxRetries": 3,
    "useIdle": true,
    "folder": "INBOX",
    "reconnect": {
      "maxAttempts": 10,
      "baseDelay": 5000,
      "maxDelay": 60000
    },
    "maxNewEmailThreshold": 50,
    "enableRecoveryMode": true,
    "disableConsistencyCheck": false
  },
  "patterns": [
    {
      "name": "support",
      "sender": { "domain": ["company.com"] },
      "subject": { "regex": ".*\\[SUPPORT\\].*" }
    },
    {
      "name": "tasks",
      "sender": { "exact": ["boss@company.com"] },
      "subject": { "prefix": ["Task:", "TODO:"] }
    }
  ],
  "output": {
    "format": "text",
    "includeHeaders": true,
    "includeAttachments": true
  },
  "workspace": {
    "folder": "./workspace"
  },
  "reply": {
    "enabled": true,
    "mode": "opencode",
    "opencode": {
      "enabled": true,
      "provider": "SiliconFlow",
      "model": "Pro/zai-org/GLM-5",
      "contextSecret": "${JINY_CONTEXT_SECRET}",
      "systemPrompt": "You are an email-based AI assistant.\nRespond professionally and concisely.\nReference previous context when relevant.",
      "includeThreadHistory": true
    },
    "attachments": {
      "enabled": true,
      "maxFileSize": 10485760,
      "allowedExtensions": [".ppt", ".pptx", ".doc", ".docx", ".txt", ".md"]
    }
  }
}
```

## Agent Processing Flow

```
 1. Load configuration from file/CLI args
 2. Run state migrations (ensureInitialized → seed UID set if needed)
 3. Connect to IMAP server (with retry logic)
 4. Start monitoring loop:
    a. Check mailbox count vs lastSequenceNumber
    b. If deletion detected or suspicious jump → Recovery mode
       - Load processed UID set
       - Check UIDVALIDITY (reset if changed)
       - Fetch all messages, filter by UID set
       - Process only unprocessed UIDs
    c. Normal mode: fetch range (lastSeq+1 : currentCount)
    d. On connection loss → exponential backoff reconnection
    e. On ContextOverflowError → create new session + retry
    f. Continue until max reconnection attempts reached
 5. For each new email:
    a. Fetch headers (From, To, Subject, MessageId, InReplyTo, References)
    b. Run pattern matching
    c. If match:
       - Track UID in processed set
       - Fetch full body and attachments
       - Parse email content
       - **STAGE 1: Apply semantic cleaning** (remove quoted history, headers)
       - Save email to disk (clean version: ~2KB instead of 900KB)
       - **Extract commands** from email body (`/attach`, etc.)
       - If commands found:
         - Parse commands via CommandRegistry
         - Execute each command (e.g., AttachCommandHandler)
         - Validate file paths via PathValidator
         - Generate AI reply from cleaned body (commands stripped)
         - Send reply with attachments via SMTP
       - If no commands (normal OpenCode flow):
         - Load last 5 thread context files (email/reply limit: 2)
         - Get or create OpenCode session for thread
         - **STAGE 3: Build context** (semantic + truncation)
         - Embed `<reply_context>` block with HMAC-signed email context
         - Send prompt to OpenCode (which has reply_email MCP tool)
         - OpenCode calls reply_email tool → MCP tool sends SMTP + stores reply
         - If tool was used (replySentByTool=true): done
         - If tool was NOT used: monitor falls back to direct SMTP send + store
         - If response empty → skip sending, log warning
 6. Continue monitoring (IDLE or polling)
 7. On shutdown: close OpenCode server
```

### Connection Resilience

**IMAP Connection Recovery:**
- Listens for imapflow `close` and `error` events
- On disconnection → exponential backoff (5s, 10s, 20s, 40s, 60s...)
- Retries up to `reconnect.maxAttempts` (default: 10)
- Resets counter on successful poll
- Exhausts attempts → monitor exits with error

**SMTP Connection Recovery:**
- On send failure with connection error → reconnect + retry once
- If retry also fails → logs error, continues email processing
- No reconnection on non-connection errors (e.g., invalid recipient)

**Session Overflow Recovery:**
- Detects `ContextOverflowError` from OpenCode
- Creates new session (clears accumulated history)
- Retries prompt with new session
- Logs old and new session IDs for tracking

**Mailbox Recovery Mode:**
- Triggered by deletion detection (currentCount < lastSeq) or suspicious jump (> threshold)
- Loads processed UID set from `.jiny/.processed-uids.txt`
- Checks UIDVALIDITY; resets UID set if changed
- Fetches all messages and filters by processed UID set
- Only processes genuinely new emails
- Configurable via `maxNewEmailThreshold` (default: 50) and `disableConsistencyCheck`

## Pattern Matching

### Types
- **Exact match** - Sender email equals pattern
- **Domain match** - Email domain matches  
- **Regex match** - Regular expression on sender/subject
- **Prefix match** - Subject starts with pattern

### Matching Logic
```
For each pattern:
  senderMatch = checkSender(email.from, pattern.sender)
  subjectMatch = checkSubject(email.subject, pattern.subject)
  
  Return pattern.name if (senderMatch AND subjectMatch)
```

### Use Pattern Matching for Agent Routing
Different patterns can route to different agent behaviors:
```yaml
patterns:
  - name: urgent-support
    subject:
      regex: ".*\\[URGENT\\].*"
    # Could configure different systemPrompt per pattern

  - name: general-inquiry
    sender:
      domain: [company.com]
```

## Thread Storage

### Directory Structure
```
workspace/
└── Test4/
    ├── session.json              # AI session state
    ├── .opencode/                # OpenCode working directory
    │   └── opencode.json         # OpenCode config
    ├── 2026-03-18_18-18-35_jiny_Test4.md
    ├── 2026-03-18_18-19-01_auto-reply.md
    └── README.md                 # General context file (any .md file)

.jiny/
├── .state.json                   # Monitor state (seq, uid, migration version)
└── .processed-uids.txt           # One UID per line, append-only
```

### .state.json Format
```json
{
  "lastSequenceNumber": 42,
  "lastProcessedTimestamp": "2026-03-19T09:00:00Z",
  "lastProcessedUid": 1234,
  "uidValidity": 1,
  "migrationVersion": 1
}
```

### session.json Format (per-thread)
```json
{
  "sessionId": "sess_abc123",
  "createdAt": "2026-03-18T10:15:00Z",
  "lastUsedAt": "2026-03-19T09:00:00Z",
  "emailCount": 2
}
```

### Email Markdown Format

**Note:** Email files are saved with semantic cleaning applied (quoted history removed).

```markdown
---
uid: 12345
message_id: "<abc123@mail.example.com>"
matched_pattern: "support"
---

## User Name (10:15 AM)

Email body content here (quoted history stripped at save time)

---
*📎 Attachments:*
  - screenshot.png (image/png, 245kb)
---
```

**Storage Size:** ~2KB (vs 900KB+ before cleaning)

### AI Auto-Reply Format
```markdown
---
type: auto-reply
---

## AI Assistant

AI-generated reply content here...

---
```

### SMTP Reply Format

**Note:** SMTP replies quote the cleaned version of the original email (semantic cleaning applied).

```
AI reply text here

---
### Sender Name (10:15 AM)
> Subject: Original subject
>
> > Cleaned email body
> > (no deep quoted history)
---
```

**Reply Size:** ~5KB (vs 1MB+ before cleaning)

### Email Filename Format

**Before (with reply prefixes):**
```
2026-03-18_17-59-37_回复_Re_回复_Re_回复_Re_回复_Re_回复_Re_回复_Re_..._ji.md
(≈150 chars)
```

**After (clean):**
```
2026-03-18_18-18-35_jiny_Test4.md
(≈35 chars)
```

**Structure:**
- `YYYY-MM-DD_HH-mm-ss_` - Timestamp
- Clean subject (Reply/Fwd prefixes stripped)
- Max 60 chars for subject portion
- Identifiable as email (timestamp pattern) vs auto-reply (`*_auto-reply.md`)

## CLI Interface

```
jiny-m monitor [options]

Options:
  -c, --config <file>    Config file path (default: ./jiny-m.config.json)
  --once                 Check once and exit
  --no-idle              Use polling instead of IMAP IDLE
  --reset                Reset monitoring state
  --verbose              Verbose output
  --debug                Debug logging

jiny-m config init       Generate default config file
jiny-m config validate   Validate configuration
```

## Technical Decisions

### AI Integration
- Use `@opencode-ai/sdk` - Official TypeScript SDK for OpenCode
- Thread-specific server instances with connection pooling
- Session-per-thread pattern for context persistence
- Automatic idle timeout for resource management
- Bun native APIs for file operations

### IMAP Library
- Use `imapflow` - Modern, Promise-based IMAP client with IDLE support
- Extended envelope parsing: `to`, `messageId`, `inReplyTo`, `references` fields
- `fetchRange()` for efficient sequence-based batch fetching
- `getMailboxCount()` for mailbox size checks

### Email Parsing
- Use `mailparser` - Parse MIME messages reliably
- Integrated cleaning functions: `stripQuotedHistory()`, `truncateText()`

### Email Command System
- Prefix-based command detection (`/attach`, extensible to other commands)
- `EmailCommandExtractor` separates commands from email body before AI processing
- `CommandRegistry` pattern for extensible command handling
- `PathValidator` ensures attachment security (path traversal, extension, size)

### State Management
- Dual tracking: sequence numbers (fast path) + UID set (recovery path)
- Append-only `.processed-uids.txt` for efficient UID tracking
- Migration system for seamless upgrades (seeds UID set from existing mailbox)
- UIDVALIDITY checking for mailbox invalidation

### MCP Reply Tool
- Stateless local MCP server (`src/mcp/reply-tool.ts`) spawned via stdio by OpenCode
- Registered once at OpenCode server startup, stays alive for all emails
- Email context passed via prompt text as `<reply_context>` JSON block
- Context validated with HMAC-SHA256 (`contextSecret` from config, supports `${ENV_VAR}`)
- Directly reuses `SmtpService`, `EmailStorage`, `PathValidator`, `ConfigManager`
- Thread path composed from `workspace.folder` + `context.threadName` (no raw paths in prompt)
- Attachment paths validated to exclude `.opencode/` and `.jiny/` directories
- Dependency: `@modelcontextprotocol/sdk` for stdio transport
- Fallback: if OpenCode doesn't call the tool, monitor sends reply via direct SMTP

### Three-Stage Cleaning
- **STAGE 1 (Save):** Semantic cleaning, no truncation - applied in storage.store()
- **STAGE 2 (SMTP):** Semantic cleaning, no truncation - applied in smtp.quoteOriginalEmail()
- **STAGE 3 (Context):** Semantic cleaning + truncation - applied in opencode.buildThreadContext()

### Configuration
- JSON config (`.jiny/config.json`) with environment variable interpolation (`${ENV_VAR}`)
- `contextSecret` for MCP reply tool HMAC validation supports `${ENV_VAR}` syntax

### Context Optimization

**Problem:** Email replies contain full conversation history in quoted blocks (900KB+), causing:
- Massive storage waste (5 files × 900KB = 4.5MB per thread)
- Slow I/O (reading large files)
- Bloated SMTP replies (1MB+ with full quoted history)
- Context overflow when loading thread files

**Solution: Three-Stage Cleaning Strategy**

#### STAGE 1: Save Time (Storage)
- Apply semantic cleaning when saving emails to disk
- Remove: reply headers, deeply nested quotes (≥3 levels), dividers
- Remove: English/chinese sender/time/footer metadata
- Result: 900KB → ~2KB (99.8% reduction)
- Apply to: All incoming emails before `storage.store()`

#### STAGE 2: SMTP Reply Time
- Apply semantic cleaning when quoting original email in reply
- Quote the cleaned version (already no quoted history)
- Result: 1MB reply → ~5KB (99.5% reduction)
- Benefits: Faster delivery, cleaner reply threads

#### STAGE 3: OpenCode Context Time
- Load already-cleaned thread files (no re-cleaning needed)
- Apply semantic cleaning to incoming email body (already done at STAGE 1)
- Apply truncation to fit token limits:
  - Thread files: 400 chars per file, max 2,000 chars total
  - Incoming email: 2,000 chars max
  - Total prompt: 6,000 chars (~1,500 tokens for GLM-4.7)
- Result: Clean context within model limits

**Quote Stripping Rules (Semantic Cleaning):**
- Remove reply headers: `发件人:`, `发件时间:`, `From:`, `Sent:`, `To:`, `Cc:`, `Subject:`
- Remove deeply nested quoted lines (≥3 levels of `>`)
- Remove divider lines: `---`, `===`, `***` (≥3 chars)
- Remove English reply markers: `On ... wrote:`
- Collapse multiple empty lines to max 2
- Keep only new content from the sender (immediate context preserved)

**Truncation Rules (for token limits):**
- Show head + tail with `[truncated]...` marker
- Token budget enforcement at context loading time
- No truncation at save or SMTP reply time (only at context time)

**Code Organization:**
- `stripQuotedHistory()` and `truncateText()` in `src/core/email-parser.ts`
- `stripReplyPrefix()` in `src/utils/helpers.ts`
- Shared functions used across storage, smtp, and opencode modules
- No code duplication

**Redundancy Elimination:**
- Incoming email's quoted history covers older conversation
- Clean files on disk remove 99% of redundant content
- SMTP replies quote clean versions (no bloat)
- Context uses cleaned files + 1-2 recent filtered emails
- Prevents 5-10x duplication across storage, replies, and context

**Backward Compatibility:**
- Old unclean email files (pre-change) still load correctly
- `stripQuotedHistory()` handles uncleaned input gracefully
- No migration needed - old files age out naturally from context window
- Old files can be reprocessed with `jiny-m workspace clean` (optional future feature)

## Security Considerations
- Environment variables for credentials (never commit passwords)
- Validate regex patterns to prevent ReDoS
- Rate limiting for AI API calls
- Sanitize email content before processing
- TLS for IMAP/SMTP connections
- **PathValidator** for attachment commands: path traversal prevention, null byte detection, filename sanitization, extension allowlist, file size limits
- Command extraction runs before AI processing to prevent prompt injection via command syntax
- **MCP Reply Tool context security**: HMAC-SHA256 validation prevents OpenCode from tampering with email context (redirecting recipients, modifying threading headers)
- **`contextSecret`** supports `${ENV_VAR}` syntax via existing `expandEnvVars()` mechanism -- never hardcoded in config
- **Thread name only**: MCP tool receives `threadName` (not raw filesystem paths) -- path composed server-side from config
- **Attachment directory exclusion**: MCP tool rejects attachments from `.opencode/` and `.jiny/` directories

## Future Enhancements
- Multiple IMAP account support
- Pattern-specific system prompts
- Webhook integration
- Multi-language reply support
- Scheduled/delayed responses
- Human-in-the-loop approval workflow
- Thread context summarization for very long conversations
- Real-time chat interface alongside email
- Additional email commands (e.g., `/summarize`, `/forward`, `/schedule`)
- `jiny-m workspace clean` to reprocess old unclean email files
