import { test, expect, describe } from "bun:test";
import { PatternMatcher } from "../src/core/pattern-matcher";
import type { Pattern } from "../src/types";

describe("PatternMatcher.matchSubject", () => {
  test("no pattern defined returns null", () => {
    const patterns: Pattern[] = [{
      name: "test",
      sender: { domain: ["example.com"] },
    }];

    const matcher = new PatternMatcher(patterns);
    const result = matcher.match("test@example.com", "Hello World");
    expect(result).not.toBeNull();
    expect(result?.matches.subject).toBeUndefined();
  });

  test("empty subjectPattern returns null", () => {
    const patterns: Pattern[] = [{
      name: "test",
      subject: {},
    }];

    const matcher = new PatternMatcher(patterns);
    const result = matcher.match("test@example.com", "Hello World");
    expect(result).toBeNull();
  });

  describe("prefix only (single)", () => {
    test("exact match with prefix", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Urgent: Action required");

      expect(result).not.toBeNull();
      expect(result?.patternName).toBe("test");
      expect(result?.matches.subject?.prefix).toBe("Urgent");
    });

    test("case sensitive prefix match", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
        },
        caseSensitive: true,
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Urgent: Action required");

      expect(result).not.toBeNull();
      expect(result?.matches.subject?.prefix).toBe("Urgent");
    });

    test("case sensitive prefix no match", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
        },
        caseSensitive: true,
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "urgent: Action required");

      expect(result).toBeNull();
    });

    test("no match - different prefix", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Alert: Something happened");

      expect(result).toBeNull();
    });
  });

  describe("prefix only (multiple - OR logic)", () => {
    test("matches first prefix in array", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent", "Alert", "Notice"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Urgent: Action required");

      expect(result).not.toBeNull();
      expect(result?.matches.subject?.prefix).toBe("Urgent");
    });

    test("matches second prefix in array", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent", "Alert", "Notice"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Alert: Something happened");

      expect(result).not.toBeNull();
      expect(result?.matches.subject?.prefix).toBe("Alert");
    });

    test("matches third prefix in array", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent", "Alert", "Notice"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Notice: System update");

      expect(result).not.toBeNull();
      expect(result?.matches.subject?.prefix).toBe("Notice");
    });
  });

  describe("prefix with reply/forward prefixes", () => {
    test("matches after Re: prefix", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Re: Urgent: Action required");

      expect(result).not.toBeNull();
      expect(result?.matches.subject?.prefix).toBe("Urgent");
    });

    test("matches after RE: prefix", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Alert"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "RE: Alert: Something happened");

      expect(result).not.toBeNull();
    });

    test("matches after Fwd: prefix", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Notice"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Fwd: Notice: System update");

      expect(result).not.toBeNull();
    });

    test("matches after multiple reply prefixes", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Re: Fwd: Re: Urgent: Action required");

      expect(result).not.toBeNull();
    });

    test("handles multiple prefixes of different types", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Notice"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "RE: RE: Fwd: Notice: This is important");

      expect(result).not.toBeNull();
    });

    test("handles mixed case multiple prefixes", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Alert"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "re: RE: fwd: Fwd: Re: Alert: Something");

      expect(result).not.toBeNull();
    });
  });

  describe("regex only", () => {
    test("matches simple regex", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          regex: " Urgent ",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "This is Urgent right now");

      expect(result).not.toBeNull();
      expect(result?.matches.subject?.regex).toBe(" Urgent ");
    });

    test("matching pattern with special characters", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          regex: "\\[\\d+\\]",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Ticket [12345]: Issue description");

      expect(result).not.toBeNull();
    });

    test("no match - regex not found", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          regex: "Urgent",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "This is just a normal email");

      expect(result).toBeNull();
    });

    test("regex works on full subject (not stripped)", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          regex: "^Re:",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Re: Hello World");

      expect(result).not.toBeNull();
    });
  });

  describe("prefix + regex (AND logic)", () => {
    test("both conditions true - matches", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
          regex: "\\[Ticket#\\d+\\]",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Urgent: [Ticket#12345] Action required");

      expect(result).not.toBeNull();
      expect(result?.matches.subject?.prefix).toBe("Urgent");
      expect(result?.matches.subject?.regex).toBe("\\[Ticket#\\d+\\]");
    });

    test("prefix matches but regex doesn't - no match", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
          regex: "\\[Ticket#\\d+\\]",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Urgent: Action required");

      expect(result).toBeNull();
    });

    test("regex matches but prefix doesn't - no match", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
          regex: "\\[Ticket#\\d+\\]",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Alert: [Ticket#12345] Action required");

      expect(result).toBeNull();
    });

    test("neither matches - no match", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
          regex: "\\[Ticket#\\d+\\]",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Normal: Action required");

      expect(result).toBeNull();
    });

    test("prefix works after reply prefix, regex on full subject", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["Urgent"],
          regex: "\\[Ticket#\\d+\\]",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Re: Urgent: [Ticket#12345] Response");

      expect(result).not.toBeNull();
    });
  });

  describe("multiple patterns - OR logic between patterns", () => {
    test("matches first pattern", () => {
      const patterns: Pattern[] = [
        {
          name: "pattern1",
          subject: { prefix: ["Urgent"] },
        },
        {
          name: "pattern2",
          subject: { prefix: ["Alert"] },
        },
      ];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Urgent: Something");

      expect(result).not.toBeNull();
      expect(result?.patternName).toBe("pattern1");
    });

    test("matches second pattern", () => {
      const patterns: Pattern[] = [
        {
          name: "pattern1",
          subject: { prefix: ["Urgent"] },
        },
        {
          name: "pattern2",
          subject: { prefix: ["Alert"] },
        },
      ];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Alert: Something");

      expect(result).not.toBeNull();
      expect(result?.patternName).toBe("pattern2");
    });

    test("no pattern matches", () => {
      const patterns: Pattern[] = [
        {
          name: "pattern1",
          subject: { prefix: ["Urgent"] },
        },
        {
          name: "pattern2",
          subject: { prefix: ["Alert"] },
        },
      ];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Normal: Something");

      expect(result).toBeNull();
    });
  });

  describe("case sensitivity", () => {
    test("case insensitive by default - prefix", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["urgent"],
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Urgent: Action");

      expect(result).not.toBeNull();
    });

    test("case sensitive - prefix no match", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          prefix: ["urgent"],
        },
        caseSensitive: true,
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "Urgent: Action");

      expect(result).toBeNull();
    });

    test("case insensitive by default - regex", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          regex: "urgent",
        },
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "This is URGENT!");

      expect(result).not.toBeNull();
    });

    test("case sensitive - regex no match", () => {
      const patterns: Pattern[] = [{
        name: "test",
        subject: {
          regex: "urgent",
        },
        caseSensitive: true,
      }];

      const matcher = new PatternMatcher(patterns);
      const result = matcher.match("test@example.com", "This is URGENT!");

      expect(result).toBeNull();
    });
  });
});
