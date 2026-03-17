import { test, expect, describe } from "bun:test";
import { stripReplyPrefix } from "../src/utils/helpers";

describe("stripReplyPrefix", () => {
  test("removes Re: prefix", () => {
    expect(stripReplyPrefix("Re: Hello World")).toBe("Hello World");
  });

  test("removes RE: prefix (uppercase)", () => {
    expect(stripReplyPrefix("RE: Hello World")).toBe("Hello World");
  });

  test("removes re: prefix (lowercase)", () => {
    expect(stripReplyPrefix("re: Hello World")).toBe("Hello World");
  });

  test("removes Fwd: prefix", () => {
    expect(stripReplyPrefix("Fwd: Hello World")).toBe("Hello World");
  });

  test("removes FWD: prefix (uppercase)", () => {
    expect(stripReplyPrefix("FWD: Hello World")).toBe("Hello World");
  });

  test("removes fwd: prefix (lowercase)", () => {
    expect(stripReplyPrefix("fwd: Hello World")).toBe("Hello World");
  });

  test("removes 中文回复 prefix", () => {
    expect(stripReplyPrefix("回复: Hello World")).toBe("Hello World");
  });

  test("removes 中文转发 prefix", () => {
    expect(stripReplyPrefix("转发: Hello World")).toBe("Hello World");
  });

  test("removes RÉ: prefix", () => {
    expect(stripReplyPrefix("RÉ: Hello World")).toBe("Hello World");
  });

  test("removes multiple prefixes sequentially", () => {
    expect(stripReplyPrefix("Re: Fwd: Hello World")).toBe("Hello World");
  });

  test("removes three prefixes sequentially", () => {
    expect(stripReplyPrefix("Re: RE: Fwd: Hello World")).toBe("Hello World");
  });

  test("removes many prefixes sequentially", () => {
    expect(stripReplyPrefix("re: RE: Fwd: fwd: Re: FWD: Hello World")).toBe("Hello World");
  });

  test("handles mixed case multiple prefixes", () => {
    expect(stripReplyPrefix("Re: re: RE: Fwd: fwd: FWD: Hello World")).toBe("Hello World");
  });

  test("handles whitespace around prefixes", () => {
    expect(stripReplyPrefix("  Re:  Hello World")).toBe("Hello World");
  });

  test("handles colon variants (Chinese colon)", () => {
    expect(stripReplyPrefix("Re：Hello World")).toBe("Hello World");
  });

  test("returns original if no prefix", () => {
    expect(stripReplyPrefix("Hello World")).toBe("Hello World");
  });

  test("handles empty string", () => {
    expect(stripReplyPrefix("")).toBe("");
  });

  test("handles only prefix", () => {
    expect(stripReplyPrefix("Re:")).toBe("");
  });
});
