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

  beforeEach(async () => {
    tempDir = join(tmpdir(), `jiny-trail-test-${Date.now()}`);
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_11-00-00"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reads interleaved received.md and reply.md", async () => {
    // Older message dir
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "received.md"),
      `---\ntopic: "First"\ntimestamp: "2026-03-22T10:00:00.000Z"\n---\n\n## Alice (10:00 AM)\n\nHello from Alice.\n\n--- `);
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "reply.md"),
      `---\ntype: auto-reply\n---\n\n## AI Assistant\n\nHello Alice, I can help!\n\n--- `);

    // Newer message dir
    await writeFile(join(tempDir, "messages", "2026-03-22_11-00-00", "received.md"),
      `---\ntopic: "Second"\ntimestamp: "2026-03-22T11:00:00.000Z"\n---\n\n## Alice (11:00 AM)\n\nFollow-up question.\n\n--- `);

    const trail = await buildThreadTrail(tempDir, { maxEntries: 10 });

    // Most recent first: newer received, then older received + reply
    expect(trail.length).toBe(3);
    expect(trail[0]!.bodyText).toContain("Follow-up question");
    expect(trail[0]!.type).toBe("received");
    expect(trail[1]!.bodyText).toContain("Hello from Alice");
    expect(trail[1]!.type).toBe("received");
    expect(trail[2]!.bodyText).toContain("Hello Alice, I can help");
    expect(trail[2]!.type).toBe("reply");
  });

  test("respects maxEntries limit", async () => {
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "received.md"),
      `---\ntopic: "First"\ntimestamp: "2026-03-22T10:00:00.000Z"\n---\n\n## Alice (10:00 AM)\n\nMessage 1.\n\n--- `);
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "reply.md"),
      `---\ntype: auto-reply\n---\n\n## AI Assistant\n\nReply 1.\n\n--- `);
    await writeFile(join(tempDir, "messages", "2026-03-22_11-00-00", "received.md"),
      `---\ntopic: "Second"\ntimestamp: "2026-03-22T11:00:00.000Z"\n---\n\n## Alice (11:00 AM)\n\nMessage 2.\n\n--- `);

    const trail = await buildThreadTrail(tempDir, { maxEntries: 2 });
    expect(trail.length).toBe(2);
  });

  test("strips quoted history from received.md", async () => {
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
    const replyWithQuotes = `---
type: auto-reply
---

## AI Assistant

The AI response text.

---
### Alice (10:00 AM)
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

  test("includes current message when provided", async () => {
    const trail = await buildThreadTrail(tempDir, {
      maxEntries: 10,
      includeCurrentMessage: {
        sender: "Bob",
        timestamp: new Date("2026-03-22T12:00:00.000Z"),
        topic: "Current",
        bodyText: "This is the current message.",
      },
    });

    expect(trail.length).toBeGreaterThanOrEqual(1);
    expect(trail[0]!.sender).toBe("Bob");
    expect(trail[0]!.bodyText).toBe("This is the current message.");
    expect(trail[0]!.type).toBe("received");
  });

  test("truncates per-entry when maxPerEntry is set", async () => {
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "received.md"),
      `---\ntopic: "Test"\ntimestamp: "2026-03-22T10:00:00.000Z"\n---\n\n## Alice (10:00 AM)\n\n${"A".repeat(500)}\n\n--- `);

    const trail = await buildThreadTrail(tempDir, { maxEntries: 10, maxPerEntry: 100 });
    expect(trail.length).toBe(1);
    expect(trail[0]!.bodyText.length).toBeLessThanOrEqual(125); // truncateText adds "..." marker
  });

  test("returns empty trail for nonexistent thread", async () => {
    const trail = await buildThreadTrail("/nonexistent/path", { maxEntries: 10 });
    expect(trail).toEqual([]);
  });
});

// ============================================================================
// prepareBodyForQuoting (integration with buildThreadTrail)
// ============================================================================

describe("prepareBodyForQuoting", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `jiny-quoting-test-${Date.now()}`);
    // Create two historical message dirs + a "current" one (most recent, will be skipped)
    await mkdir(join(tempDir, "messages", "2026-03-22_10-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_11-00-00"), { recursive: true });
    await mkdir(join(tempDir, "messages", "2026-03-22_12-00-00"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("produces interleaved quoted blocks", async () => {
    // Oldest dir — historical received + reply
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "received.md"),
      `---\ntopic: "Hello"\ntimestamp: "2026-03-22T10:00:00.000Z"\n---\n\n## Alice (10:00 AM)\n\nOlder message from Alice.\n\n--- `);
    await writeFile(join(tempDir, "messages", "2026-03-22_10-00-00", "reply.md"),
      `---\ntype: auto-reply\n---\n\n## AI Assistant\n\nAI replied to Alice.\n\n--- `);

    // Middle dir — another historical received
    await writeFile(join(tempDir, "messages", "2026-03-22_11-00-00", "received.md"),
      `---\ntopic: "Hello"\ntimestamp: "2026-03-22T11:00:00.000Z"\n---\n\n## Alice (11:00 AM)\n\nMiddle message.\n\n--- `);

    // Most recent dir — this is the "current" message dir, will be skipped by prepareBodyForQuoting
    await writeFile(join(tempDir, "messages", "2026-03-22_12-00-00", "received.md"),
      `---\ntopic: "Hello"\ntimestamp: "2026-03-22T12:00:00.000Z"\n---\n\n## Alice (12:00 PM)\n\nLatest message (skipped as current).\n\n--- `);

    const result = await prepareBodyForQuoting(
      tempDir,
      { sender: "Alice", timestamp: new Date(), topic: "Hello", bodyText: "New message from Alice." },
    );

    // Should contain current message and historical entries
    expect(result).toContain("New message from Alice");
    expect(result).toContain("Older message from Alice");
    expect(result).toContain("AI replied to Alice");
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
