/**
 * Strip JSONC (JSON with Comments) comments from a string.
 * Removes both line comments (// ...) and block comments (/* ... *\/)
 * while respecting strings and escape sequences.
 */
export function stripJsonComments(content: string): string {
  enum State {
    NORMAL,
    STRING,
    ESCAPE,
    LINE_COMMENT,
    BLOCK_COMMENT,
  }

  let state: State = State.NORMAL;
  let result = '';
  let i = 0;

  while (i < content.length) {
    const ch = content[i];
    const next = i + 1 < content.length ? content[i + 1] : '';

    switch (state) {
      case State.NORMAL:
        if (ch === '"') {
          state = State.STRING;
          result += ch;
        } else if (ch === '/' && next === '/') {
          state = State.LINE_COMMENT;
          i++; // skip second '/'
        } else if (ch === '/' && next === '*') {
          state = State.BLOCK_COMMENT;
          i++; // skip '*'
        } else {
          result += ch;
        }
        break;

      case State.STRING:
        if (ch === '\\') {
          state = State.ESCAPE;
          result += ch;
        } else if (ch === '"') {
          state = State.NORMAL;
          result += ch;
        } else {
          result += ch;
        }
        break;

      case State.ESCAPE:
        // Any character after backslash is part of escape sequence
        state = State.STRING;
        result += ch;
        break;

      case State.LINE_COMMENT:
        // Skip until newline
        if (ch === '\n') {
          state = State.NORMAL;
          result += ch;
        }
        break;

      case State.BLOCK_COMMENT:
        // Skip until */
        if (ch === '*' && next === '/') {
          state = State.NORMAL;
          i++; // skip '/'
        }
        break;
    }

    i++;
  }

  // If we end inside a string, it's probably malformed, but keep what we have
  return result;
}