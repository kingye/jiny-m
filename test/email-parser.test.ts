import { test, expect, describe } from "bun:test";
import { deriveThreadName, sanitizeForFilename } from "../src/core/email-parser";

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
