// IME composition gate for xterm running inside macOS WKWebView (Tauri).
//
// Why this exists: WKWebView never fires compositionstart/compositionend
// for Korean (and likely other CJK) IMEs. Instead it lowers all composition
// state into `input` events with these inputTypes:
//
//   insertText             — first jamo of a new char, or any committed char
//   insertReplacementText  — in-progress composition (replaces previous data)
//   deleteContentBackward  — backspace
//   insertFromPaste        — paste
//
// Without intervention every keystroke leaks to PTY as a separate char,
// and the TUI never sees a final composed glyph. We model the gate as a
// pure state machine: feed inputType/data + non-IME keydowns, get back
// whatever should be written to PTY (or null). Pure logic so it can be
// covered by jsdom unit tests.
//
// Buffering rule: while the user is composing a single Hangul/CJK glyph,
// pending holds the latest in-progress form. The buffer flushes when:
//   - a new insertText with CJK arrives (previous glyph committed)
//   - a non-IME keydown arrives (Space/Enter/Tab/arrow/printable ASCII)
//   - paste happens
//   - blur

const HANGUL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xac00, 0xd7af], // Hangul syllables
  [0x1100, 0x11ff], // Hangul jamo
  [0x3130, 0x318f], // Hangul compatibility jamo
  [0xa960, 0xa97f], // Hangul jamo extended-A
  [0xd7b0, 0xd7ff], // Hangul jamo extended-B
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0x3400, 0x4dbf], // CJK ext A
];

export function isCJKLike(s: string): boolean {
  if (!s) return false;
  const c = s.charCodeAt(0);
  for (const [lo, hi] of HANGUL_RANGES) {
    if (c >= lo && c <= hi) return true;
  }
  return false;
}

export interface InputResult {
  /** Bytes to write to PTY now (the previously-buffered glyph, or paste, or
   *  a glyph we've decided to commit eagerly). null means no PTY write. */
  write: string | null;
}

export interface ImeGate {
  /** Feed an `input` event from the xterm helper textarea. Caller should
   *  also stopPropagation + clear textarea.value to keep xterm's own
   *  bubble-phase handler from re-processing. */
  handleInput(inputType: string, data: string): InputResult;
  /** Called from a capture-phase keydown listener for any non-IME key (i.e.
   *  e.key !== "Process" / "Dead" / "Unidentified"). Returns whatever was
   *  buffered so the caller can write it BEFORE xterm's bubble-phase
   *  keydown handler sends the actual key. */
  flushPending(): string | null;
  /** Used by tests; reads internal state. */
  _peekPending(): string;
}

export function createImeGate(): ImeGate {
  let pending = "";

  const flush = (): string | null => {
    if (!pending) return null;
    const out = pending;
    pending = "";
    return out;
  };

  return {
    handleInput(inputType, data) {
      // In-progress composition — overwrite buffer, no PTY write.
      if (inputType === "insertReplacementText") {
        pending = data;
        return { write: null };
      }

      // A new CJK glyph started: previous glyph (if any) is now committed.
      if (inputType === "insertText" && isCJKLike(data)) {
        const flushed = pending;
        pending = data;
        return { write: flushed || null };
      }

      // Paste: dump everything pending plus the pasted text together.
      if (inputType === "insertFromPaste" && data) {
        const flushed = pending;
        pending = "";
        return { write: (flushed ?? "") + data };
      }

      // Anything else (ASCII insertText, deleteContentBackward, insertLineBreak,
      // etc.) was already handled by xterm's keydown handler. Just commit any
      // buffered glyph so its order with the upcoming key is preserved.
      return { write: flush() };
    },
    flushPending() {
      return flush();
    },
    _peekPending() {
      return pending;
    },
  };
}
