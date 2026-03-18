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
session.prompt(email + context)
       ↓
Update session.json
       ↓
SMTP reply
       ↓
Store reply in thread folder
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
       ↓
No → Use existing client
       ↓
Create session with directory=threadPath
       ↓
Generate AI reply
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
    // Start server if not running
    if (this.server && this.client) return;
    
    const port = await this.findFreePort();
    const result = await createOpencode({
      hostname: this.config.hostname || '127.0.0.1',
      port,
    });
    
    this.server = result.server;
    this.client = result.client;
    this.port = port;
  }
  
  private async findFreePort(): Promise<number> {
    // Try ports starting from 5000
    for (let port = 5000; port < 5100; port++) {
      try {
        const testServer = Bun.serve({ port, fetch: () => new Response('test') });
        testServer.stop();
        return port;
      } catch { continue; }
    }
    throw new Error('No free ports available');
  }
  
  async generateReply(email: Email, threadPath: string): Promise<string> {
    await this.ensureServerStarted();
    
    // Create .opencode directory in thread folder
    const opencodeDir = join(threadPath, '.opencode');
    await mkdir(opencodeDir, { recursive: true });
    
    // Get or create session with directory pointing to thread
    const session = await this.getOrCreateSession(threadPath);
    
    // Pass directory to session.prompt
    const result = await this.client.session.prompt({
      path: { id: session.sessionId },
      query: { directory: threadPath },
      body: {
        model: this.getModelConfig(),
        parts: [{ type: 'text', text: prompt }],
      },
    });
    
    return this.extractText(result.data.parts);
  }

  private async getOrCreateSession(threadPath: string): Promise<ThreadSession> {
    // Pass directory when creating session
    const sessionResult = await this.client.session.create({
      body: { title: path.basename(threadPath) },
      query: { directory: threadPath },
    });

    // Save session to threadPath/session.json
    // ...
  }

  async close(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.client = null;
    }
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

### Configuration Example (`jiny-m.config.yaml`)

```yaml
imap:
  host: imap.gmail.com
  port: 993
  username: agent@example.com
  password: ${IMAP_PASSWORD}
  tls: true

smtp:
  host: smtp.gmail.com
  port: 587
  username: agent@example.com
  password: ${SMTP_PASSWORD}
  tls: true

 watch:
   checkInterval: 30
   maxRetries: 3
   useIdle: true
   folder: INBOX
   reconnect:
     maxAttempts: 10
     baseDelay: 5000
     maxDelay: 60000

patterns:
  - name: support
    sender:
      domain: [company.com]
    subject:
      regex: ".*\\[SUPPORT\\].*"
  
  - name: tasks
    sender:
      exact: [boss@company.com]
    subject:
      prefix: ["Task:", "TODO:"]

output:
  format: text
  includeHeaders: true
  includeAttachments: true

workspace:
  folder: ./workspace

reply:
  enabled: true
  mode: opencode
  opencode:
    enabled: true
    provider: SiliconFlow
    model: "Pro/zai-org/GLM-5"
    systemPrompt: |
      You are an email-based AI assistant.
      Respond professionally and concisely.
      Reference previous context when relevant.
    includeThreadHistory: true
```

## Agent Processing Flow

```
 1. Load configuration from file/CLI args
 2. Connect to IMAP server (with retry logic)
 3. Start monitoring loop:
    a. Check for new emails
    b. On connection loss → exponential backoff reconnection
    c. On ContextOverflowError → create new session + retry
    d. Continue until max reconnection attempts reached
 4. For each new email:
    a. Fetch headers (From, Subject)
    b. Run pattern matching
    c. If match:
       - Fetch full body and attachments
       - Parse email content
       - **STAGE 1: Apply semantic cleaning** (remove quoted history, headers)
       - Save email to disk (clean version: ~2KB instead of 900KB)
       - Load last 5 thread context files (email/reply limit: 2)
       - Get or create thread-specific OpenCode server
       - Get or create AI session for thread
       - **STAGE 3: Build context** (semantic + truncation)
         - Thread files: 400 chars per file, max 2,000 chars total
         - Incoming email: 2,000 chars (semantic cleaned + truncated)
         - Total prompt: max 6,000 chars
       - Generate AI response with cleaned context
       - If response empty → skip sending, log warning
       - **STAGE 2: SMTP reply** (semantic cleaning only)
         - Quote cleaned version of original email (no quoted history)
         - Send reply via SMTP
       - Store AI response in thread folder
 5. Continue monitoring (IDLE or polling)
 6. On shutdown: close OpenCode server
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
```

### session.json Format
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

### Email Parsing
- Use `mailparser` - Parse MIME messages reliably
- Integrated cleaning functions: `stripQuotedHistory()`, `truncateText()`

### Three-Stage Cleaning
- **STAGE 1 (Save):** Semantic cleaning, no truncation - applied in storage.store()
- **STAGE 2 (SMTP):** Semantic cleaning, no truncation - applied in smtp.quoteOriginalEmail()
- **STAGE 3 (Context):** Semantic cleaning + truncation - applied in opencode.buildThreadContext()

### Configuration
- YAML config for readability and multi-line string support
- Environment variable interpolation for credentials

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

## Future Enhancements
- Multiple IMAP account support
- Attachment analysis with AI
- Pattern-specific system prompts
- Webhook integration
- Multi-language reply support
- Scheduled/delayed responses
- Human-in-the-loop approval workflow
- Thread context summarization for very long conversations
- Real-time chat interface alongside email
