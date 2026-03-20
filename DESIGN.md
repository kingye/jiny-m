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
storage.store(email) → { threadPath, filePath }
       ↓                  (filePath = .jiny/<incomingFileName>)
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
  (includes incomingFileName, NOT full body)
       ↓
promptWithProgress() via SSE streaming:
  - Subscribe to events → promptAsync() → process events
  - Detect tool calls in real-time via message.part.updated
  - Activity-based timeout (2 min silence, not fixed deadline)
  - Progress logged every 30s while AI is working
       ↓
OpenCode calls reply_email MCP tool
       ↓
MCP Tool:
  → Read .jiny/<incomingFileName> for full body
  → SmtpService.replyToEmail() (quotes full history)
  → EmailStorage.storeReply()
  → Write .jiny/reply-sent.flag (signal file)
       ↓
Update session.json
       ↓
Check replySentByTool:
  1. Accumulated SSE parts → tool call detected in real-time
  2. checkToolUsed(parts) — from accumulated parts
  3. checkSignalFile() — from .jiny/reply-sent.flag (last-resort fallback)
       ↓
(fallback: if tool not used, monitor sends SMTP directly)
(on activity timeout: check signal file — if sent, treat as success)
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
   - Files store full body (including quoted history) as canonical record
   - When loaded into prompt context, `stripQuotedHistory()` + truncation applied
   - Files are limited to 400 chars each (1,000 chars total) in prompt

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
- Email files: Extract body only (between `## Name (time)` and `---`), then `stripQuotedHistory()` at prompt load time
- Auto-reply files: Skipped (already visible in conversation history)
- General files: Included as-is (useful for reference documents)
- Method: `buildPromptContext()` (formerly `buildThreadContext()`)

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
  contextSecret?: string;          // Reserved for future HMAC context validation
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
- **Single server** - Auto-started on first request, auto-finds free port (49152+)
- **Health check** - Before reusing server, `isServerAlive()` pings with 3s timeout; restarts if dead
- **Startup timeout** - 15 seconds for `opencode serve` CLI to start (default SDK is 5s)
- **Shared client** - One client instance for all sessions
- **MCP tool per-thread** - `opencode.json` in each thread dir configures `jiny_reply` MCP server
- **Per-session directory** - `query.directory` parameter tells OpenCode where to work
- **Thread isolation** - Each thread has its own session and `.opencode/` directory
- **Prompt timeout** - Activity-based: no fixed deadline, only times out if AI goes silent for 2 min
- **SSE streaming** - `promptAsync()` + `event.subscribe()` for real-time progress and tool detection
- **Fallback** - If SSE subscription fails, falls back to blocking `prompt()` with 5-min timeout
- **Signal file detection** - Last-resort: checks `.jiny/reply-sent.flag` if SSE missed tool call events

#### Server Lifecycle Flow

```
Email Arrives
       ↓
ensureServerStarted()
       ↓
Server exists? → Yes → isServerAlive()? → Yes → Use existing
       │                      │
       No                    No (dead)
       │                      │
       ↓                      ↓
Find free port            Close stale refs
       ↓                      │
Start OpenCode server     └──→ Restart
  (timeout: 15s)
       ↓
Store server/client
       ↓
Create session with directory=threadPath
       ↓
Build prompt with <reply_context> block
       ↓
promptWithProgress() (SSE streaming):
  1. Subscribe to SSE events (client.event.subscribe({ directory: threadPath }))
  2. Fire promptAsync() (returns immediately)
  3. Process events (filtered by sessionID, deduped):
     - server.connected → confirm SSE stream alive
     - message.part.updated → accumulate parts, detect tool calls
     - session.status → track busy/retry (deduped by status type)
     - session.idle → done, collect result
     - session.error → handle (e.g. ContextOverflow → new session + retry)
  4. Activity-based timeout: 2 min of silence → timeout
  5. Progress log every 10s while busy (shows elapsed, parts, activity, silence)
  6. Tool call logging: deduped by part ID + status (only logs on status change)
  7. reply_email detection: checks output for errors (OpenCode reports "completed"
     even when MCP tool returns isError: true)
  8. On SSE failure → fallback to blocking prompt() with 5-min timeout
       ↓
Check replySentByTool (SSE parts → checkToolUsed → signal file fallback)
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
  
  constructor(config: OpenCodeConfig) {
    this.config = config;
  }
  
  private async ensureServerStarted(): Promise<void> {
    if (this.server && this.client) {
      if (await this.isServerAlive()) return;
      try { this.server.close(); } catch {}
      this.server = null; this.client = null; this.port = null;
    }
    
    const port = await this.findFreePort();
    const result = await createOpencode({
      hostname: this.config.hostname || '127.0.0.1',
      port,
      timeout: 15_000,
    });
    
    this.server = result.server;
    this.client = result.client;
    this.port = port;
  }

  private async isServerAlive(): Promise<boolean> {
    try {
      await Promise.race([
        this.client.session.list(),
        new Promise((_, r) => setTimeout(() => r(new Error()), 3000)),
      ]);
      return true;
    } catch { return false; }
  }
  
  async generateReply(email: Email, threadPath: string, storedEmailFile?: string): Promise<AiGeneratedReply> {
    await this.ensureServerStarted();
    const session = await this.getOrCreateSession(threadPath);
    const prompt = await this.buildPrompt(email, threadPath, storedEmailFile);
    
    // SSE streaming with activity-based timeout
    const { parts, replySentByTool } = await this.promptWithProgress(
      session, threadPath, systemPrompt, modelConfig, prompt,
    );
    
    const aiReply = this.extractAiReply(parts);
    aiReply.replySentByTool = replySentByTool || this.checkToolUsed(parts);
    if (!aiReply.replySentByTool) {
      aiReply.replySentByTool = await this.checkSignalFile(threadPath);
    }
    return aiReply;
  }

  private async promptWithProgress(...): Promise<{ parts, replySentByTool }> {
    // 1. Subscribe to SSE (scoped to thread directory)
    const subscription = await this.client.event.subscribe({
      query: { directory: threadPath },
    });
    
    // 2. Fire prompt asynchronously
    await this.client.session.promptAsync({ path: { id: sessionId }, ... });
    
    // 3. Process events with deduplication + activity-based timeout
    const toolLoggedStatus = new Map<string, string>();
    let lastSessionStatus = '';
    for await (const event of subscription.stream) {
      // Skip events without sessionID (global: server.connected, file.watcher, etc.)
      if (event.type === 'server.connected') continue;
      const sid = event.properties?.sessionID || event.properties?.part?.sessionID;
      if (!sid || sid !== sessionId) continue;
      
      lastActivityTime = Date.now(); // Reset activity timer
      
      switch (event.type) {
        case 'message.part.updated':
          // Accumulate parts (dedup by ID)
          // Log tool calls only on status change (dedup by partId+status)
          // Detect reply_email: check output for "Error:" prefix
          // Log reply_email input args at debug level
          break;
        case 'session.status':
          // Log only on status type change (dedup)
          break;
        case 'session.idle':
          // Done — break event loop
          break;
        case 'session.error':
          // Handle ContextOverflow → retry with new session
          break;
      }
    }
    
    // Falls back to promptBlocking() if SSE fails
  }

  // Tool detection: "completed" does NOT mean success.
  // OpenCode reports "completed" even for isError: true MCP responses.
  // Must check output field for "Error:" prefix.
  private checkToolUsed(parts): boolean { ... }
  
  // Blocking fallback with 5-min timeout + signal file check
  private async promptBlocking(...): Promise<{ parts, replySentByTool }> { ... }
  
  // Cross-process signal file (written by MCP tool, read+deleted here)
  private async checkSignalFile(threadPath): Promise<boolean> { ... }
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

## MCP Reply Tool

### Overview

OpenCode is given a `reply_email` MCP tool so the AI agent can send email replies directly. The tool is a stateless local MCP server (`src/mcp/reply-tool.ts`) spawned via stdio transport, configured per-thread via `opencode.json`.

The email context (recipient, subject, threading headers) is serialized as a JSON block in the user prompt. Tool usage instructions are provided via the `system` prompt parameter for higher priority. OpenCode must pass this context verbatim when calling the tool.

### Directory Structure

```
<root-dir>/                              # jiny-m started here (process.cwd() for jiny-m)
├── .jiny/
│   ├── config.json                      # Project config (IMAP, SMTP, patterns, workspace, etc.)
│   ├── .state.json                      # Monitor state
│   └── .processed-uids.txt             # Processed UIDs
├── workspace/
│   ├── <thread-dir-1>/                  # Thread directory (OpenCode cwd for this thread)
│   │   ├── messages/                    # Per-message directories (conversation turns)
│   │   │   ├── 2026-03-19_23-02-20/    # Turn 1
│   │   │   │   ├── received.md          # Incoming email (full body, canonical record)
│   │   │   │   ├── reply.md             # AI reply (alongside received)
│   │   │   │   ├── report.pdf           # Saved inbound attachment
│   │   │   │   └── slides.pptx          # Saved inbound attachment
│   │   │   └── 2026-03-19_23-10-00/    # Turn 2
│   │   │       ├── received.md
│   │   │       └── reply.md
│   │   ├── .jiny/                       # Internal state only (session, logs, signals)
│   │   │   ├── session.json
│   │   │   ├── reply-tool.log
│   │   │   └── reply-sent.flag
│   │   ├── .opencode/                   # OpenCode internal directory
│   │   ├── opencode.json               # Per-thread OpenCode config (MCP tool, permissions)
│   │   └── opencode_skills.pptx        # AI-generated working files (stay at root)
│   └── <thread-dir-2>/
│       └── ...
└── src/
    └── mcp/
        ├── reply-tool.ts               # MCP server (spawned by OpenCode per thread)
        └── context.ts                  # Email context serialization
```

### Architecture

```
Monitor receives email
    ↓
storage.store(email, patternMatch, inboundAttachmentConfig)
    ↓   → creates messages/<timestamp>/ directory
    ↓   → saves whitelisted inbound attachments
    ↓   → writes received.md
    ↓   → returns { messageDir, threadPath }
OpenCodeService.generateReply(email, threadPath, messageDir)
    ↓
ensureThreadOpencodeSetup(threadPath)
  → writes opencode.json in thread dir with:
    - MCP config: jiny_reply server (command + JINY_ROOT env var)
    - permission: { "*": "allow" }
    ↓
session.promptAsync({ system: systemPrompt, directory: threadPath })
    ↓
event.subscribe({ directory: threadPath })  ← SSE scoped to thread dir
    ↓
OpenCode reads opencode.json, spawns MCP subprocess:
  - cwd = threadPath (set by OpenCode via query.directory)
  - JINY_ROOT = <root-dir> (set via opencode.json environment)
    ↓
System prompt instructs model to use jiny_reply_reply_email tool
    ↓
OpenCode calls MCP tool: reply_email(message, context, attachments?)
    ↓
MCP Server (stdio subprocess, cwd = thread dir):
  1. Parse context JSON, validate required fields (with JSON sanitization fallback)
  2. Load config from JINY_ROOT/.jiny/config.json (absolute path)
  3. threadPath = process.cwd() (already the thread dir)
  4. Validate attachments via PathValidator (exclude .opencode/, .jiny/)
  5. Reconstruct Email object from context
  6. Read messages/<incomingMessageDir>/received.md → extract full body for quoted history
     (fallback: legacy .jiny/<filename> path for pre-migration threads)
  7. SmtpService.replyToEmail(emailWithFullBody, message, attachments)
  8. EmailStorage.storeReply(threadPath, message, email, messageDir) → writes reply.md alongside received.md
  9. Write .jiny/reply-sent.flag (signal file for cross-process detection)
  10. Return success message
```

### MCP Process Model

Each thread gets its own MCP subprocess (spawned by OpenCode from that thread's `opencode.json`):

```
Thread 1 session → opencode.json → MCP process A (cwd = thread-1 dir, stdio pipe A)
Thread 2 session → opencode.json → MCP process B (cwd = thread-2 dir, stdio pipe B)
```

- Each process is isolated via stdio pipe (no cross-thread calls possible)
- Each process is stateless (loads config, sends email, returns)
- Processes stay alive while the OpenCode session is active
- Resource overhead: ~30-50MB per process (acceptable for typical workloads)

### Environment Variables

| Variable | Set by | Used by | Value |
|----------|--------|---------|-------|
| `JINY_ROOT` | `opencode.json` environment config | MCP tool | Absolute path to `<root-dir>` |

The MCP tool uses `JINY_ROOT` to find the project config at `<root-dir>/.jiny/config.json`, since its own `process.cwd()` is the thread directory (not the project root).

### Tool Definition

**Tool name:** `jiny_reply_reply_email` (server prefix `jiny_reply` + tool name `reply_email`)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | yes | The reply text to send |
| `context` | string | yes | The `<reply_context>` JSON from the prompt, passed verbatim |
| `attachments` | string[] | no | Filenames within the thread directory to attach |

### Context Object (`src/mcp/context.ts`)

```typescript
interface EmailReplyContext {
  threadName: string;        // Thread directory name (informational, not used for path)
  to: string;                // Recipient (from reply-to header or from)
  from: string;              // Original sender address
  fromName: string;          // Sender display name
  subject: string;           // Email subject
  date: string;              // ISO date string
  messageId?: string;        // For In-Reply-To header
  references?: string[];     // For References header
  bodyText?: string;         // Original body text (stripped + truncated, for AI display only)
  bodyHtml?: string;         // Original body HTML (fallback, only if no bodyText)
  incomingMessageDir?: string; // Per-message directory name under messages/ (e.g. "2026-03-19_23-02-20")
                             // MCP tool reads messages/<dir>/received.md for full quoted history
  uid: number;               // Email UID
}
```

**Serialization helpers:**
- `serializeContext(email, threadName, incomingMessageDir?)` → JSON string
- `deserializeAndValidateContext(json)` → validated `EmailReplyContext` (with JSON sanitization fallback for AI-corrupted input: smart quotes, trailing commas)
- `contextToEmail(context)` → reconstructed `Email` object (stripped body; MCP tool replaces with full body from messages/<dir>/received.md)

### Prompt Structure

Tool instructions are sent via the `system` parameter of `session.prompt()` (higher priority than user content):

**System prompt** (`buildSystemPrompt()`):
- Config's system prompt (e.g., "You are an email-based AI assistant...")
- Working directory constraint
- Tool usage instructions: MUST use `jiny_reply_reply_email`, pass context verbatim, stop after calling

**User prompt** (`buildPrompt()`):
- Conversation history (last N thread files)
- Incoming email (from, subject, date, body)
- `<reply_context>` JSON block (for the tool's `context` parameter)

### Per-Thread OpenCode Config (`opencode.json`)

Written by `ensureThreadOpencodeSetup()` in each thread directory:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "*": "allow" },
  "mcp": {
    "jiny_reply": {
      "type": "local",
      "command": ["bun", "run", "<absolute-path>/src/mcp/reply-tool.ts"],
      "environment": { "JINY_ROOT": "<root-dir>" },
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

- `permission: { "*": "allow" }` prevents headless permission blocks
- `JINY_ROOT` tells the MCP tool where to find the project config
- Config is written once per thread (checked for freshness on each call)
- A new OpenCode session is created when config is freshly written

### Code Reuse

The MCP tool directly imports existing project modules:

| Module | Usage in MCP Tool |
|--------|-------------------|
| `SmtpService` | `replyToEmail(email, message, attachments)` -- handles quoting, threading headers, HTML |
| `EmailStorage` | `storeReply(threadPath, message, email)` -- writes `auto-reply.md` |
| `PathValidator` | `validateFilePath()`, `validateExtension()`, `validateFileSize()` -- attachment security |
| `ConfigManager` | Loads config via absolute path from `JINY_ROOT` |

### Attachment Validation

When the `attachments` parameter is provided:

1. For each filename: `PathValidator.validateFilePath(threadPath, filename)` → safe absolute path
2. Reject if the resolved path contains `.opencode` or `.jiny` path segments
3. `PathValidator.validateExtension(filename, config.reply.attachments.allowedExtensions)`
4. `PathValidator.validateFileSize(stat.size, config.reply.attachments.maxFileSize)`
5. Check file exists and is not a directory

### Fallback Behavior

| Scenario | What Happens |
|----------|-------------|
| OpenCode uses `reply_email` tool successfully | Detected in real-time via SSE `message.part.updated` events (checks output for errors); `replySentByTool: true`, skips SMTP/store |
| `reply_email` tool called but fails (e.g. invalid JSON) | SSE shows `completed` but output starts with "Error:" → `replySentByTool` stays false; AI may retry and succeed |
| AI reconstructs context instead of passing verbatim | JSON sanitization attempts repair (smart quotes, trailing commas); if parse still fails, tool returns error |
| OpenCode returns text without using tool | `session.idle` fires, accumulated parts have no tool call; monitor falls back to direct SMTP |
| AI takes very long (10+ min) but keeps working | SSE events keep arriving → activity timer resets → no timeout; progress logged every 10s |
| AI goes silent for 2 minutes | Activity timeout fires → checks signal file → if sent, success; otherwise error |
| SSE subscription fails | Falls back to blocking `prompt()` with 5-min fixed timeout |
| Prompt times out (blocking fallback) | Checks signal file — if MCP tool already sent, treats as success |
| SMTP fails in tool | Tool returns error, monitor falls back to direct SMTP |
| Attachment rejected (security) | Tool returns error with explanation |
| OpenCode server dies between emails | Health check detects it, restarts server automatically |
| ContextOverflowError | Detected via SSE `session.error` → creates new session → retries with blocking prompt |

### Signal File (`.jiny/reply-sent.flag`)

Cross-process detection mechanism for when the MCP tool sends the reply but tool parts are missing from the prompt response (or the prompt times out).

**Format:** Single-line JSON
```json
{"sentAt":"2026-03-19T13:09:43Z","to":"user@example.com","messageId":"<123@smtp>","attachmentCount":1}
```

**Lifecycle:**
1. Written by MCP reply-tool after successful SMTP send
2. Read by `OpenCodeService.checkSignalFile()` as fallback detection
3. Deleted immediately after detection to prevent stale signals

### MCP Tool Logging

The MCP tool logs to `<thread-dir>/.jiny/reply-tool.log` (file-based, since stdout is reserved for MCP stdio protocol). Each thread gets its own log file. Logs include:
- Tool startup (cwd, JINY_ROOT, pid)
- Each handler step (context validation, config loading, path resolution, attachment validation, SMTP send, storage)
- On context validation failure: raw context preview (first 500 chars) + length for debugging AI-corrupted JSON
- Errors with stack traces

### SSE Event Logging

Events from `promptWithProgress()` are logged with deduplication:
- **Tool calls**: Logged at INFO only on status change per part ID (pending → running → completed). Avoids duplicate "running" logs from repeated SSE updates.
- **Tool input**: reply_email tool args logged at DEBUG on `pending` (message preview, context preview, attachments)
- **Tool errors**: reply_email `completed` with error output logged at WARN (not treated as success)
- **Session status**: Logged at DEBUG only on status type change (avoids duplicate "Session busy" logs)
- **Progress**: Every 10s at INFO with elapsed time, part count, current activity (reasoning/text/tool name), silence duration
- **Raw SSE**: First 5 events logged at DEBUG (before session filter) for diagnostics

### File Structure

```
src/mcp/
├── reply-tool.ts          # MCP server (standalone, spawned by OpenCode via stdio)
└── context.ts             # EmailReplyContext serialization + validation
```

### Known Issues / TODO

- Model sometimes uses built-in tools (glob, read, task) before calling `jiny_reply_reply_email`. System prompt instructions mitigate this but model behavior varies.
- Some models (e.g. GLM-4.7) reconstruct the `<reply_context>` JSON instead of passing it verbatim, causing parse failures. Defensive JSON sanitization handles common corruption (smart quotes, trailing commas). Models may need multiple retry attempts before succeeding.

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
       - **STAGE 1: Save full body** (no stripping, no truncation)
       - Save email to disk (full body as canonical record)
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
          - **Build prompt context** (strip quoted history + truncation via `buildPromptContext()`)
          - Embed `<reply_context>` block with `incomingFileName` pointer
          - Send prompt via `promptWithProgress()` (SSE streaming with activity-based timeout)
          - SSE events provide real-time progress logging + tool call detection
          - OpenCode calls reply_email tool → MCP tool reads .md for full body → sends SMTP + stores reply + writes signal file
          - If tool was used (detected via SSE events or signal file): done
          - If tool was NOT used: monitor falls back to direct SMTP send + store
          - If SSE fails: fallback to blocking prompt() with 5-min timeout
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
    ├── messages/                         # Per-message directories (conversation turns)
    │   ├── 2026-03-18_18-18-35/         # Turn 1
    │   │   ├── received.md               # Incoming email (full body)
    │   │   ├── reply.md                  # AI reply
    │   │   └── report.pdf                # Saved inbound attachment
    │   └── 2026-03-18_18-25-00/         # Turn 2
    │       ├── received.md
    │       └── reply.md
    ├── .jiny/                            # Internal state only
    │   ├── session.json                  # AI session state
    │   ├── reply-tool.log                # MCP tool log (per-thread)
    │   └── reply-sent.flag               # Signal file (transient, deleted after detection)
    ├── .opencode/                        # OpenCode working directory
    ├── opencode.json                     # Per-thread OpenCode config (MCP tool, permissions)
    └── opencode_skills.pptx              # AI-generated working files

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
  "migrationVersion": 2
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

**Note:** Email files are stored as `received.md` inside per-message directories (`messages/<timestamp>/`). They store the full body including quoted history (canonical record). Stripping is only applied when loading into AI prompt context.

```markdown
---
uid: 12345
message_id: "<abc123@mail.example.com>"
matched_pattern: "support"
---

## User Name (10:15 AM)

Email body content here (full body including quoted history preserved)

*📎 Attachments:*
  - **report.pdf** (application/pdf, 52410 bytes) ✅ saved
  - **malware.exe** (application/x-msdownload, 12345 bytes) ⛔ skipped
---
```

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

**Note:** SMTP replies quote the full original email body (preserving thread history, standard email behavior).

```
AI reply text here

---
### Sender Name (10:15 AM)
> Subject: Original subject
>
> > Full email body including quoted history
> > (entire thread preserved for proper email threading)
---
```

### Message Directory Naming

Per-message directories use the email timestamp:
```
messages/2026-03-19_23-02-20/     # Timestamp from email date
messages/2026-03-19_23-02-20_2/   # Collision: counter suffix added
```

Each directory contains:
- `received.md` — incoming email (always present)
- `reply.md` — AI reply (written alongside received when reply is sent)
- `<attachment>.pdf` — saved inbound attachments (if whitelist config enabled)

### Inbound Attachment Download

Configurable per pattern in `config.json`:

```json
{
  "patterns": [{
    "name": "support",
    "sender": { "exact": ["user@example.com"] },
    "inboundAttachments": {
      "enabled": true,
      "allowedExtensions": [".pdf", ".pptx", ".docx", ".xlsx", ".png", ".jpg", ".txt", ".md"],
      "maxFileSize": "25mb",
      "maxAttachmentsPerEmail": 10
    }
  }]
}
```

**Processing flow:**
1. `mailparser.simpleParser()` parses MIME and provides `att.content` (Buffer)
2. `email-parser.ts` preserves the Buffer on the `Attachment` object
3. `storage.store()` calls `saveAttachments()` before writing `received.md`
4. For each attachment: check extension whitelist → check size limit → check count limit → sanitize filename → resolve collisions → write to disk
5. Buffer freed after write (`att.content = undefined`)
6. Attachment metadata in `received.md` shows saved/skipped status

**Security measures:**
- Extension allowlist (not blocklist) — only explicitly permitted types saved
- File size limit per attachment (human-readable: `"25mb"`, `"150kb"`)
- Max attachments per email (prevents resource exhaustion)
- Filename sanitization: basename only, no path traversal, no hidden files, no null bytes, max 200 chars, Unicode NFC normalized
- Double extension defense: only the **last** extension is checked
- Collision handling: counter suffix (e.g. `report_2.pdf`)

**Memory note:** In-memory approach (Phase 1). Attachment Buffers are loaded by mailparser during parsing. A future optimization could use streaming (`imapflow.download()` + `MailParser` streaming API) for constant memory usage regardless of email size.

### Migration v2: .jiny/*.md → messages/ Structure

Runs automatically on first startup after upgrade (via `StateManager.ensureInitialized()`):

1. Scans all thread directories under `workspace/`
2. For each thread, reads `.jiny/*.md` files
3. Groups received emails and replies by timestamp
4. Creates `messages/<timestamp>/` directories
5. Moves received `.md` → `messages/<timestamp>/received.md`
6. Moves reply `.md` → `messages/<timestamp>/reply.md`
7. Non-`.md` files in `.jiny/` (session.json, logs) are untouched

**Backward compatibility:** `buildPromptContext()` has a legacy fallback that reads `.jiny/*.md` if `messages/` directory doesn't exist. The MCP reply-tool also falls back to `.jiny/` paths. This handles threads that haven't been migrated yet.

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
- One MCP subprocess per thread (spawned from per-thread `opencode.json`)
- MCP subprocess cwd = thread directory (set by OpenCode); `JINY_ROOT` env var = project root
- Config loaded from `JINY_ROOT/.jiny/config.json` (absolute path, not relative to cwd)
- Thread path = `process.cwd()` (no path composition needed)
- Email context passed via user prompt as `<reply_context>` JSON block
- Tool instructions in system prompt (`session.prompt({ system: ... })`) for higher model compliance
- Directly reuses `SmtpService`, `EmailStorage`, `PathValidator`, `ConfigManager`
- Attachment paths validated to exclude `.opencode/` and `.jiny/` directories
- `opencode.json` per thread: `permission: { "*": "allow" }` prevents headless permission blocks
- Dependency: `@modelcontextprotocol/sdk` for stdio transport
- Fallback: if OpenCode doesn't call the tool, monitor sends reply via direct SMTP
- MCP tool logs to `<thread-dir>/.jiny/reply-tool.log` (per-thread, stdout reserved for MCP protocol)
- Signal file `.jiny/reply-sent.flag` for cross-process tool-usage detection (written by MCP tool, read/deleted by monitor)

### Stripping Strategy

`stripQuotedHistory()` is only applied at **AI prompt consumption time**, never at storage or SMTP output time.

| Stage | Where | Strips? | Purpose |
|-------|-------|---------|---------|
| **Storage** (`.md` files) | `storage.store()` | **No** | Canonical record — full body preserved |
| **AI Prompt Context** | `buildPromptContext()` | **Yes** | Keep AI focused on latest message |
| **AI Prompt Body** | `buildPrompt()` | **Yes** | Incoming email body for AI |
| **`<reply_context>`** | `serializeContext()` | **Yes** (bodyText only) | Lean context in prompt |
| **SMTP Quoting** | `quoteOriginalEmail()` | **No** | Full thread history in reply |
| **MCP Tool Quoting** | `reply-tool.ts` | **No** | Reads `.md` file for full body |

### Configuration
- JSON config (`.jiny/config.json`) with environment variable interpolation (`${ENV_VAR}`)
- `contextSecret` for future HMAC validation (supports `${ENV_VAR}` syntax)

### Context Optimization

**Problem:** Email replies contain full conversation history in quoted blocks (900KB+), causing:
- Context overflow when loading thread files into AI prompt
- Slow AI inference from excessive tokens

**Solution: Strip at Consumption Time, Not Storage Time**

Email files (`.md`) store the full body as canonical records. Stripping is only applied when building the AI prompt:

#### Storage (Full Body)
- Save complete email body including all quoted history
- Enables proper SMTP quoting with full thread history
- MCP tool reads these files for reply quoting
- No data loss — the canonical record is always complete

#### AI Prompt (Stripped + Truncated)
- `buildPromptContext()` reads `.md` files, applies `stripQuotedHistory()` + truncation
- `buildPrompt()` strips incoming email body
- `<reply_context>` contains only `incomingFileName` pointer (not full body)
- Token budget enforcement:
  - Thread files: 400 chars per file, max 2,000 chars total
  - Incoming email: 2,000 chars max
  - Total prompt: 6,000 chars (~1,500 tokens)

#### SMTP Reply (Full History)
- `quoteOriginalEmail()` uses full email body (no stripping)
- Direct SMTP path: uses original `Email` object from IMAP parser
- MCP tool path: reads `.jiny/<incomingFileName>` for full body

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
- Stripping called only in `buildPromptContext()` and `buildPrompt()` (AI prompt construction)
- Storage and SMTP modules do NOT call stripping functions

## Security Considerations
- Environment variables for credentials (never commit passwords)
- Validate regex patterns to prevent ReDoS
- Rate limiting for AI API calls
- Sanitize email content before processing
- TLS for IMAP/SMTP connections
- **PathValidator** for attachment commands: path traversal prevention, null byte detection, filename sanitization, extension allowlist, file size limits
- Command extraction runs before AI processing to prevent prompt injection via command syntax
- **MCP tool isolation**: each thread's MCP subprocess runs in its own cwd with isolated stdio pipe
- **JINY_ROOT**: MCP tool uses env var for config path, cannot access arbitrary filesystem locations
- **Attachment directory exclusion**: MCP tool rejects attachments from `.opencode/` and `.jiny/` directories
- **Permission config**: `opencode.json` sets `permission: { "*": "allow" }` to prevent headless blocking; consider tightening for production

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
