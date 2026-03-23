import { test, expect, describe } from "bun:test";
import { stripJsonComments } from "../../src/utils/jsonc";

describe("stripJsonComments", () => {
  test("returns empty string unchanged", () => {
    expect(stripJsonComments("")).toBe("");
  });

  test("returns plain JSON unchanged", () => {
    const json = `{"key": "value"}`;
    expect(stripJsonComments(json)).toBe(json);
  });

  test("removes line comment at end of line", () => {
    const input = `{"key": "value"} // comment`;
    const expected = `{"key": "value"} `;
    expect(stripJsonComments(input)).toBe(expected);
  });

  test("removes line comment on its own line", () => {
    const input = `// comment\n{"key": "value"}\n// another`;
    const expected = `\n{"key": "value"}\n`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  test("removes block comment on single line", () => {
    const input = `{"key": /* comment */ "value"}`;
    const expected = `{"key":  "value"}`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  test("removes multi-line block comment", () => {
    const input = `{"key": /*\ncomment\n*/ "value"}`;
    const expected = `{"key":  "value"}`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  test("preserves // inside string", () => {
    const input = `{"url": "https://example.com"}`;
    expect(stripJsonComments(input)).toBe(input);
  });

  test("preserves // inside string with line comment after", () => {
    const input = `{"url": "https://example.com"} // comment`;
    const expected = `{"url": "https://example.com"} `;
    expect(stripJsonComments(input)).toBe(expected);
  });

  test("preserves escaped quote inside string", () => {
    const input = `{"path": "C:\\\\\\"Program Files\\""}`;
    expect(stripJsonComments(input)).toBe(input);
  });

  test("handles escaped backslash before quote", () => {
    const input = `{"key": "value\\\\\\""}`;
    expect(stripJsonComments(input)).toBe(input);
  });

  test("handles empty strings", () => {
    const input = `{"key": ""}`;
    expect(stripJsonComments(input)).toBe(input);
  });

  test("handles line comment inside block comment (should be removed as part of block)", () => {
    const input = `/* // inner */ "value"`;
    const expected = ` "value"`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  test("handles block comment inside line comment (should be removed as part of line)", () => {
    const input = `// /* inner */\n"value"`;
    const expected = `\n"value"`;
    expect(stripJsonComments(input)).toBe(expected);
  });

  test("handles complex JSONC with all comment types", () => {
    const input = `
{
  // API base URL
  "baseURL": "https://api.example.com/v1",
  /* providers config */
  "provider": {
    "openai": {
      // API key
      "apiKey": "sk-xxx"
    }
  },
  "model": "gpt-4"
}
`;
    const expected = `
{
  
  "baseURL": "https://api.example.com/v1",
  
  "provider": {
    "openai": {
      
      "apiKey": "sk-xxx"
    }
  },
  "model": "gpt-4"
}
`;
    expect(stripJsonComments(input)).toBe(expected);
  });
});