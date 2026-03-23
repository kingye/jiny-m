import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deriveThreadName,
  sanitizeForFilename,
  parseStoredMessage,
  parseStoredReply,
  buildThreadTrail,
  prepareBodyForQuoting,
  formatQuotedReply,
  formatDateTimeISO,
} from "../src/core/email-parser";

describe("deriveThreadName", () => {
  describe("basic case - no prefixes to strip", () => {
    test("simple subject", () => {
      expect(deriveThreadName("Hello World")).toBe("Hello World");
    });

    test("empty string returns untitled", () => {
      expect(deriveThreadName("")).toBe("untitled");
    });

    test("whitespace only returns untitled", () => {
      expect(deriveThreadName("   ")).toBe("untitled");
    });
  });

  describe("strip reply/forward prefixes only", () => {
    test("strip Re: prefix", () => {
      expect(deriveThreadName("Re: Hello World")).toBe("Hello World");
    });

    test("strip multiple reply prefixes", () => {
      expect(deriveThreadName("Re: Re: Re: Hello World")).toBe("Hello World");
    });

    test("strip mixed reply/forward prefixes", () => {
      expect(deriveThreadName("Re: Fwd: Re: Hello World")).toBe("Hello World");
    });

    test("strip mixed case prefixes", () => {
      expect(deriveThreadName("re: RE: Fwd: fwd: Hello World")).toBe("Hello World");
    });

    test("handle whitespace around prefixes", () => {
      expect(deriveThreadName("  Re:  Hello World")).toBe("Hello World");
    });
  });

  describe("strip reply/forward + pattern prefix", () => {
    test("Re: + Urgent: pattern", () => {
      expect(deriveThreadName("Re: Urgent: Server is down", ["Urgent"])).toBe("Server is down");
    });

    test("Re: RE: Fwd: + Urgent: pattern (your scenario)", () => {
      expect(deriveThreadName("Re: RE: Fwd: Urgent: Server is down", ["Urgent"])).toBe("Server is down");
    });

    test("multiple reply prefixes + different pattern prefix", () => {
      expect(deriveThreadName("Re: Fwd: Re: Alert: CPU usage high", ["Alert"])).toBe("CPU usage high");
    });

    test("pattern prefix without reply prefix", () => {
      expect(deriveThreadName("Urgent: Server is down", ["Urgent"])).toBe("Server is down");
    });

    test("no match for pattern prefix - still strips reply prefixes", () => {
      expect(deriveThreadName("Re: Fwd: Normal update", ["Urgent"])).toBe("Normal update");
    });

    test("no pattern prefix to strip", () => {
      expect(deriveThreadName("Re: Fwd: Server is down")).toBe("Server is down");
    });

    test("pattern prefix case insensitive", () => {
      expect(deriveThreadName("Re: URGENT: Server is down", ["urgent"])).toBe("Server is down");
    });
  });

  describe("multiple pattern prefixes (OR logic - only first matched is stripped)", () => {
    test("matches first prefix in array", () => {
      expect(deriveThreadName("Re: Urgent: Server down", ["Urgent", "Alert", "Notice"])).toBe("Server down");
    });

    test("matches second prefix in array", () => {
      expect(deriveThreadName("Re: Alert: CPU high", ["Urgent", "Alert", "Notice"])).toBe("CPU high");
    });

    test("matches third prefix in array", () => {
      expect(deriveThreadName("Re: Notice: Deploy complete", ["Urgent", "Alert", "Notice"])).toBe("Deploy complete");
    });

    test("no pattern prefix matched", () => {
      expect(deriveThreadName("Re: Normal: Just checking", ["Urgent", "Alert", "Notice"])).toBe("Normal: Just checking");
    });
  });

  describe("longer prefix matched first", () => {
    test("matches longer prefix when both could match", () => {
      // "Urgent:" should match, not just "Urgent"
      expect(deriveThreadName("Urgent Priority: Server down", ["Urgent Priority", "Urgent"])).toBe("Server down");
    });
  });

  describe("edge cases", () => {
    test("pattern prefix at end of subject", () => {
      expect(deriveThreadName("Server is down Urgent", ["Urgent"])).toBe("Server is down Urgent");
    });

    test("pattern prefix with colon variations", () => {
      expect(deriveThreadName("Urgent：Server is down", ["Urgent"])).toBe("Server is down");
    });

    test("pattern prefix without colon", () => {
      expect(deriveThreadName("Urgent Server is down", ["Urgent"])).toBe("Server is down");
    });

    test("only pattern prefix - no content", () => {
      expect(deriveThreadName("Re: Urgent", ["Urgent"])).toBe("untitled");
    });

    test("only reply prefixes - no pattern", () => {
      expect(deriveThreadName("Re: Fwd: Re:")).toBe("untitled");
    });
  });

  describe("combined scenarios", () => {
    test("complex: multiple reply + pattern + case insensitive", () => {
      expect(deriveThreadName("re: RE: fWd: Alert: System Alert", ["alert"])).toBe("System Alert");
    });

    test("pattern with regex in subject (not stripped)", () => {
      expect(deriveThreadName("Re: Urgent: [Ticket#123] Server down", ["Urgent"])).toBe("[Ticket#123] Server down");
    });
  });
});

describe("sanitizeForFilename", () => {
  test("simple text", () => {
    expect(sanitizeForFilename("Hello World")).toBe("Hello_World");
  });

  test("replaces spaces with underscores", () => {
    expect(sanitizeForFilename("Multiple   spaces   here")).toBe("Multiple_spaces_here");
  });

  test("removes special characters", () => {
    expect(sanitizeForFilename("file/name.txt")).toBe("file_name.txt");
  });

  test("handles path separators", () => {
    expect(sanitizeForFilename("folder/subfolder\\file")).toBe("folder_subfolder_file");
  });

  test("handles wildcard characters", () => {
    expect(sanitizeForFilename("file*.txt?")).toBe("file_.txt");
  });

  test("handles colons and pipes", () => {
    expect(sanitizeForFilename("file:name|test")).toBe("file_name_test");
  });

  test("limits length to 200 chars", () => {
    const long = "a".repeat(300);
    expect(sanitizeForFilename(long).length).toBe(200);
  });

  test("empty or invalid returns untitled", () => {
    expect(sanitizeForFilename("")).toBe("untitled");
    expect(sanitizeForFilename("/:\\*?|<>")).toBe("untitled");
  });
});

describe("full thread name workflow", () => {
  test("complete flow: Re: RE: Fwd: Urgent: Server is down", () => {
    const derived = deriveThreadName("Re: RE: Fwd: Urgent: Server is down", ["Urgent"]);
    const sanitized = sanitizeForFilename(derived);
    expect(sanitized).toBe("Server_is_down");
  });

  test("complete flow with regex in subject", () => {
    const derived = deriveThreadName("Re: Urgent: [Ticket#12345] CPU overload at 99%", ["Urgent"]);
    const sanitized = sanitizeForFilename(derived);
    expect(sanitized).toBe("[Ticket#12345]_CPU_overload_at_99%");
  });

  test("complete flow: forward with notification pattern", () => {
    const derived = deriveThreadName("Fwd: Notice: Deployment scheduled", ["Notice"]);
    const sanitized = sanitizeForFilename(derived);
    expect(sanitized).toBe("Deployment_scheduled");
  });

  test("complete flow: no reply prefix, just pattern", () => {
    const derived = deriveThreadName("Alert: Database connection timeout", ["Alert"]);
    const sanitized = sanitizeForFilename(derived);
    expect(sanitized).toBe("Database_connection_timeout");
  });

  test("complete flow: only reply prefix, no pattern", () => {
    const derived = deriveThreadName("Re: Documentation update");
    const sanitized = sanitizeForFilename(derived);
    expect(sanitized).toBe("Documentation_update");
  });
});

// ============================================================================
// parseStoredMessage
// ============================================================================

describe("parseStoredMessage", () => {
  test("parses valid received.md with frontmatter", () => {
    const md = `---
channel: email
topic: "Test Subject"
timestamp: "2026-03-22T10:00:00.000Z"
---

## John Doe (10:00 AM)

Hello, this is a test message.
Second line.

--- `;
    const result = parseStoredMessage(md);
    expect(result).not.toBeNull();
    expect(result!.sender).toBe("John Doe");
    expect(result!.topic).toBe("Test Subject");
    expect(result!.bodyText).toBe("Hello, this is a test message.\nSecond line.");
  });

  test("returns null for invalid format", () => {
    expect(parseStoredMessage("just some text")).toBeNull();
    expect(parseStoredMessage("")).toBeNull();
  });
});

// ============================================================================
// parseStoredReply
// ============================================================================

describe("parseStoredReply", () => {
  test("extracts AI text from reply.md without quoted history", () => {
    const md = `---
type: auto-reply
---

## AI Assistant

This is the AI's response.
It has multiple lines.

--- `;
    const result = parseStoredReply(md);
    expect(result).not.toBeNull();
    expect(result!.sender).toBe("AI Assistant");
    expect(result!.bodyText).toBe("This is the AI's response.\nIt has multiple lines.");
  });

  test("stops before quoted history blocks", () => {
    const md = `---
type: auto-reply
---

## AI Assistant

This is the AI's response.

---
### User (10:00 AM)
> Original subject

> This is the quoted original message.

--- `;
    const result = parseStoredReply(md);
    expect(result).not.toBeNull();
    expect(result!.bodyText).toBe("This is the AI's response.");
  });

  test("returns null for invalid format", () => {
    expect(parseStoredReply("just text")).toBeNull();
    expect(parseStoredReply("---\ntype: auto-reply\n---\nno header")).toBeNull();
  });
});

// ============================================================================
// buildThreadTrail
// ============================================================================

describe("buildThreadTrail", () => {
  let tempDir: string;

  // Helper: create a received.md in a message dir
  const mkReceived = async (dir: string, sender: string, ts: string, body: string) => {
    await writeFile(join(tempDir, "messages", dir, "received.md"),
      `---\ntopic: "Test"\ntimestamp: "${ts}"\n---\n\n## ${sender} (10:00 AM)\n\n${body}\n\n--- `);
  };

  // Helper: create a reply.md in a message dir
  const mkReply = async (dir: string, body: string) => {
    await writeFile(join(tempDir, "messages", dir, "reply.md"),
      `---\ntype: auto-reply\n---\n\n## AI Assistant\n\n${body}\n\n--- `);
  };

  beforeEach(async () => {
    tempDir = join(tmpdir(), `jiny-trail-test-${Date.now()}`);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("ordering: reply comes BEFORE received within each directory", async () => {
    // Single dir with both received and reply
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkReceived("2026-03-22_10-00-00", "Alice", "2026-03-22T10:00:00.000Z", "User message.");
    await mkReply("2026-03-22_10-00-00", "AI response.");

    const trail = await buildThreadTrail(tempDir, { maxEntries: 10 });

    expect(trail.length).toBe(2);
    expect(trail[0]!.type).toBe("reply");
    expect(trail[0]!.bodyText).toBe("AI response.");
    expect(trail[1]!.type).toBe("received");
    expect(trail[1]!.bodyText).toBe("User message.");
  });

  test("ordering: full 3-directory scenario matches expected email trail", async () => {
    // Simulate 3 message directories (oldest to newest):
    //   dir1 (10:00) — received + reply
    //   dir2 (11:00) — received + reply
    //   dir3 (12:00) — received only (current message, being replied to now)
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_11-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_12-00-00"), { recursive: true });

    await mkReceived("2026-03-22_10-00-00", "Alice", "2026-03-22T10:00:00.000Z", "Message 1 from Alice.");
    await mkReply("2026-03-22_10-00-00", "Reply 1 from AI.");
    await mkReceived("2026-03-22_11-00-00", "Alice", "2026-03-22T11:00:00.000Z", "Message 2 from Alice.");
    await mkReply("2026-03-22_11-00-00", "Reply 2 from AI.");
    await mkReceived("2026-03-22_12-00-00", "Alice", "2026-03-22T12:00:00.000Z", "Message 3 from Alice (current).");

    // Call with includeCurrentMessage — simulates what prepareBodyForQuoting does
    const trail = await buildThreadTrail(tempDir, {
      maxEntries: 10,
      includeCurrentMessage: {
        sender: "Alice",
        timestamp: new Date("2026-03-22T12:00:00.000Z"),
        topic: "Test",
        bodyText: "Message 3 from Alice (current).",
      },
    });

    // Expected order:
    //   [0] current received  (from includeCurrentMessage)
    //   [1] dir2 reply        (AI Reply 2 — most recent historical dir)
    //   [2] dir2 received     (Message 2)
    //   [3] dir1 reply        (AI Reply 1 — older dir)
    //   [4] dir1 received     (Message 1)
    expect(trail.length).toBe(5);
    expect(trail[0]!.type).toBe("received");
    expect(trail[0]!.bodyText).toContain("Message 3 from Alice (current)");
    expect(trail[1]!.type).toBe("reply");
    expect(trail[1]!.bodyText).toBe("Reply 2 from AI.");
    expect(trail[2]!.type).toBe("received");
    expect(trail[2]!.bodyText).toBe("Message 2 from Alice.");
    expect(trail[3]!.type).toBe("reply");
    expect(trail[3]!.bodyText).toBe("Reply 1 from AI.");
    expect(trail[4]!.type).toBe("received");
    expect(trail[4]!.bodyText).toBe("Message 1 from Alice.");
  });

  test("ordering: directory with only received (no reply) still works", async () => {
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_11-00-00"), { recursive: true });

    await mkReceived("2026-03-22_10-00-00", "Alice", "2026-03-22T10:00:00.000Z", "First message.");
    await mkReply("2026-03-22_10-00-00", "AI reply.");
    // dir2: received only, no reply.md
    await mkReceived("2026-03-22_11-00-00", "Alice", "2026-03-22T11:00:00.000Z", "Second message.");

    const trail = await buildThreadTrail(tempDir, { maxEntries: 10 });

    // dir2 (most recent): only received (no reply)
    // dir1: reply then received
    expect(trail.length).toBe(3);
    expect(trail[0]!.type).toBe("received");
    expect(trail[0]!.bodyText).toBe("Second message.");
    expect(trail[1]!.type).toBe("reply");
    expect(trail[1]!.bodyText).toBe("AI reply.");
    expect(trail[2]!.type).toBe("received");
    expect(trail[2]!.bodyText).toBe("First message.");
  });

  test("ordering: directory with only reply (no received) still works", async () => {
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    // Only reply.md, no received.md
    await mkReply("2026-03-22_10-00-00", "Orphan AI reply.");

    const trail = await buildThreadTrail(tempDir, { maxEntries: 10 });
    expect(trail.length).toBe(1);
    expect(trail[0]!.type).toBe("reply");
    expect(trail[0]!.bodyText).toBe("Orphan AI reply.");
  });

  test("respects maxEntries limit", async () => {
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_11-00-00"), { recursive: true });
    await mkReceived("2026-03-22_10-00-00", "Alice", "2026-03-22T10:00:00.000Z", "Message 1.");
    await mkReply("2026-03-22_10-00-00", "Reply 1.");
    await mkReceived("2026-03-22_11-00-00", "Alice", "2026-03-22T11:00:00.000Z", "Message 2.");
    await mkReply("2026-03-22_11-00-00", "Reply 2.");

    const trail = await buildThreadTrail(tempDir, { maxEntries: 3 });
    // dir2: reply + received = 2 entries, dir1: reply = 1 entry → total 3
    expect(trail.length).toBe(3);
    expect(trail[0]!.bodyText).toBe("Reply 2.");
    expect(trail[1]!.bodyText).toBe("Message 2.");
    expect(trail[2]!.bodyText).toBe("Reply 1.");
  });

  test("strips quoted history from received.md", async () => {
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    const receivedWithQuotes = `---
topic: "Test"
timestamp: "2026-03-22T10:00:00.000Z"
---

## Alice (10:00 AM)

This is Alice's actual message.

On 2026-03-21 Bob wrote:
> Previous message that should be stripped.

--- `;
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "received.md"), receivedWithQuotes);

    const trail = await buildThreadTrail(tempDir, { maxEntries: 10 });
    expect(trail.length).toBe(1);
    expect(trail[0]!.bodyText).toContain("Alice's actual message");
    expect(trail[0]!.bodyText).not.toContain("Previous message that should be stripped");
  });

  test("extracts only AI text from reply.md (no quoted blocks)", async () => {
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    const replyWithQuotes = `---
type: auto-reply
---

## AI Assistant

The AI response text.

---
### Alice (2026-03-22 10:00)
> Test Subject

> This is quoted and should not appear.

--- `;
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "reply.md"), replyWithQuotes);

    const trail = await buildThreadTrail(tempDir, { maxEntries: 10 });
    const replyEntry = trail.find(e => e.type === "reply");
    expect(replyEntry).toBeDefined();
    expect(replyEntry!.bodyText).toBe("The AI response text.");
    expect(replyEntry!.bodyText).not.toContain("quoted and should not appear");
  });

  test("uses dir name as reply timestamp (not current time)", async () => {
    await mkdir(join(tempDir, "messages", "2026-03-22_14-30-00"), { recursive: true });
    await mkReply("2026-03-22_14-30-00", "Reply text.");

    const trail = await buildThreadTrail(tempDir, { maxEntries: 10 });
    expect(trail.length).toBe(1);
    // Timestamp should be derived from dir name, not Date.now()
    const ts = trail[0]!.timestamp;
    expect(ts.getFullYear()).toBe(2026);
    expect(ts.getMonth()).toBe(2); // March = 2
    expect(ts.getDate()).toBe(22);
    expect(ts.getHours()).toBe(14);
    expect(ts.getMinutes()).toBe(30);
  });

  test("includes current message as first entry when provided", async () => {
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkReceived("2026-03-22_10-00-00", "Alice", "2026-03-22T10:00:00.000Z", "Old message.");

    const trail = await buildThreadTrail(tempDir, {
      maxEntries: 10,
      includeCurrentMessage: {
        sender: "Bob",
        timestamp: new Date("2026-03-22T12:00:00.000Z"),
        topic: "Current",
        bodyText: "This is the current message.",
      },
    });

    expect(trail[0]!.sender).toBe("Bob");
    expect(trail[0]!.bodyText).toBe("This is the current message.");
    expect(trail[0]!.type).toBe("received");
  });

  test("truncates per-entry when maxPerEntry is set", async () => {
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkReceived("2026-03-22_10-00-00", "Alice", "2026-03-22T10:00:00.000Z", "A".repeat(500));

    const trail = await buildThreadTrail(tempDir, { maxEntries: 10, maxPerEntry: 100 });
    expect(trail.length).toBe(1);
    expect(trail[0]!.bodyText.length).toBeLessThanOrEqual(125);
  });

  test("returns empty trail for nonexistent thread", async () => {
    const trail = await buildThreadTrail("/nonexistent/path", { maxEntries: 10 });
    expect(trail).toEqual([]);
  });

  test("excludeMessageDir skips the specified directory", async () => {
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_11-00-00"), { recursive: true });
    await mkReceived("2026-03-22_10-00-00", "Alice", "2026-03-22T10:00:00.000Z", "Keep this.");
    await mkReceived("2026-03-22_11-00-00", "Alice", "2026-03-22T11:00:00.000Z", "Skip this.");

    const trail = await buildThreadTrail(tempDir, {
      maxEntries: 10,
      excludeMessageDir: "2026-03-22_11-00-00",
    });

    expect(trail.length).toBe(1);
    expect(trail[0]!.bodyText).toBe("Keep this.");
  });
});

// ============================================================================
// prepareBodyForQuoting (integration with buildThreadTrail)
// ============================================================================

describe("prepareBodyForQuoting", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `jiny-quoting-test-${Date.now()}`);
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_11-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_12-00-00"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("produces correctly ordered quoted blocks: current → reply → received → ...", async () => {
    // dir1: oldest — received + reply
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "received.md"),
      `---\ntopic: "Hello"\ntimestamp: "2026-03-22T10:00:00.000Z"\n---\n\n## Alice (10:00 AM)\n\nFirst message.\n\n--- `);
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "reply.md"),
      `---\ntype: auto-reply\n---\n\n## AI Assistant\n\nFirst AI reply.\n\n--- `);

    // dir2: middle — received + reply
    await writeFile(join(tempDir, "messages", "2026-03-22_11-00-00", "received.md"),
      `---\ntopic: "Hello"\ntimestamp: "2026-03-22T11:00:00.000Z"\n---\n\n## Alice (11:00 AM)\n\nSecond message.\n\n--- `);
    await writeFile(join(tempDir, "messages", "2026-03-22_11-00-00", "reply.md"),
      `---\ntype: auto-reply\n---\n\n## AI Assistant\n\nSecond AI reply.\n\n--- `);

    // dir3: most recent — current message dir (will be skipped, replaced by includeCurrentMessage)
    await writeFile(join(tempDir, "messages", "2026-03-22_12-00-00", "received.md"),
      `---\ntopic: "Hello"\ntimestamp: "2026-03-22T12:00:00.000Z"\n---\n\n## Alice (12:00 PM)\n\nLatest (skipped).\n\n--- `);

    const result = await prepareBodyForQuoting(
      tempDir,
      { sender: "Alice", timestamp: new Date("2026-03-22T12:00:00.000Z"), topic: "Hello", bodyText: "Current message from Alice." },
    );

    // Verify ordering in the output string
    const currentPos = result.indexOf("Current message from Alice");
    const reply2Pos = result.indexOf("Second AI reply");
    const msg2Pos = result.indexOf("Second message");
    const reply1Pos = result.indexOf("First AI reply");
    const msg1Pos = result.indexOf("First message");

    expect(currentPos).toBeGreaterThanOrEqual(0);
    expect(reply2Pos).toBeGreaterThanOrEqual(0);
    expect(msg2Pos).toBeGreaterThanOrEqual(0);
    expect(reply1Pos).toBeGreaterThanOrEqual(0);
    expect(msg1Pos).toBeGreaterThanOrEqual(0);

    // Order: current < reply2 < msg2 < reply1 < msg1
    expect(currentPos).toBeLessThan(reply2Pos);
    expect(reply2Pos).toBeLessThan(msg2Pos);
    expect(msg2Pos).toBeLessThan(reply1Pos);
    expect(reply1Pos).toBeLessThan(msg1Pos);

    // Should NOT contain the skipped current dir's content
    expect(result).not.toContain("Latest (skipped)");
  });

  test("returns empty string when no messages", async () => {
    const emptyDir = join(tmpdir(), `jiny-empty-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });

    const result = await prepareBodyForQuoting(
      emptyDir,
      { sender: "Alice", timestamp: new Date(), topic: "Hello", bodyText: "" },
    );

    expect(result).toBe("");
    await rm(emptyDir, { recursive: true, force: true });
  });
});

// ============================================================================
// formatQuotedReply — date+time format
// ============================================================================

describe("formatQuotedReply", () => {
  test("includes date in YYYY-MM-DD HH:MM format", () => {
    const result = formatQuotedReply(
      "Alice",
      new Date("2026-03-22T14:30:00.000Z"),
      "Subject",
      "Hello world",
    );

    // Should contain ISO-like date+time, not just time
    expect(result).toContain("2026-03-22");
    expect(result).toContain("### Alice (2026-03-22");
  });

  test("handles string timestamp", () => {
    const result = formatQuotedReply(
      "Bob",
      "2026-03-23T09:15:00.000Z",
      "Topic",
      "Message body",
    );

    expect(result).toContain("2026-03-23");
    expect(result).toContain("> Topic");
    expect(result).toContain("> Message body");
  });

  test("returns empty string for empty body", () => {
    expect(formatQuotedReply("Alice", new Date(), "Subject", "")).toBe("");
    expect(formatQuotedReply("Alice", new Date(), "Subject", "   ")).toBe("");
  });
});

// ============================================================================
// formatDateTimeISO
// ============================================================================

describe("formatDateTimeISO", () => {
  test("formats date as YYYY-MM-DD HH:MM", () => {
    // Use a fixed date to avoid timezone issues
    const d = new Date(2026, 2, 22, 14, 5); // March 22, 2026 14:05 local
    const result = formatDateTimeISO(d);
    expect(result).toBe("2026-03-22 14:05");
  });

  test("pads single-digit months, days, hours, minutes", () => {
    const d = new Date(2026, 0, 5, 8, 3); // Jan 5, 2026 08:03 local
    const result = formatDateTimeISO(d);
    expect(result).toBe("2026-01-05 08:03");
  });
});
