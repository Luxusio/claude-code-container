import { describe, it, expect } from "vitest";
import { createImeGate, isCJKLike } from "../imeGate";

describe("isCJKLike", () => {
  it("recognizes Hangul syllables", () => {
    expect(isCJKLike("가")).toBe(true);
    expect(isCJKLike("한")).toBe(true);
  });
  it("recognizes Hangul jamo", () => {
    expect(isCJKLike("ㄱ")).toBe(true);
  });
  it("recognizes Japanese kana and CJK ideographs", () => {
    expect(isCJKLike("あ")).toBe(true);
    expect(isCJKLike("中")).toBe(true);
  });
  it("rejects ASCII and empty input", () => {
    expect(isCJKLike("a")).toBe(false);
    expect(isCJKLike(" ")).toBe(false);
    expect(isCJKLike("")).toBe(false);
  });
});

describe("createImeGate — Korean IME on WKWebView pattern", () => {
  it("buffers an in-progress composition without writing to PTY", () => {
    const gate = createImeGate();
    expect(gate.handleInput("insertText", "ㄱ")).toEqual({ write: null });
    expect(gate.handleInput("insertReplacementText", "가")).toEqual({ write: null });
    expect(gate.handleInput("insertReplacementText", "간")).toEqual({ write: null });
    expect(gate._peekPending()).toBe("간");
  });

  it("commits the buffered glyph when a new CJK insertText starts the next char", () => {
    const gate = createImeGate();
    gate.handleInput("insertText", "ㄱ");
    gate.handleInput("insertReplacementText", "가");
    // user starts typing the next char "나" — previous "가" must commit.
    expect(gate.handleInput("insertText", "ㄴ")).toEqual({ write: "가" });
    expect(gate._peekPending()).toBe("ㄴ");
  });

  it("commits buffered glyph on a non-CJK insertText (ASCII after Korean)", () => {
    const gate = createImeGate();
    gate.handleInput("insertText", "ㄱ");
    gate.handleInput("insertReplacementText", "가");
    // user types 'a' on US keyboard while pending="가"
    expect(gate.handleInput("insertText", "a")).toEqual({ write: "가" });
    expect(gate._peekPending()).toBe("");
  });

  it("commits buffered glyph on backspace inputType (xterm keydown wrote \\x7f already)", () => {
    const gate = createImeGate();
    gate.handleInput("insertText", "ㄱ");
    gate.handleInput("insertReplacementText", "가");
    expect(gate.handleInput("deleteContentBackward", "")).toEqual({ write: "가" });
    expect(gate._peekPending()).toBe("");
  });

  it("flushPending drains buffer and clears it", () => {
    const gate = createImeGate();
    gate.handleInput("insertText", "ㄱ");
    gate.handleInput("insertReplacementText", "가");
    expect(gate.flushPending()).toBe("가");
    expect(gate.flushPending()).toBe(null);
    expect(gate._peekPending()).toBe("");
  });

  it("paste prepends pending and writes pasted data together", () => {
    const gate = createImeGate();
    gate.handleInput("insertText", "ㄱ");
    gate.handleInput("insertReplacementText", "가");
    expect(gate.handleInput("insertFromPaste", "hello")).toEqual({ write: "가hello" });
    expect(gate._peekPending()).toBe("");
  });

  it("ASCII insertText with no pending returns no write (xterm keydown owns it)", () => {
    const gate = createImeGate();
    expect(gate.handleInput("insertText", "a")).toEqual({ write: null });
    expect(gate._peekPending()).toBe("");
  });

  it("backspace with no pending returns no write (xterm keydown owns it)", () => {
    const gate = createImeGate();
    expect(gate.handleInput("deleteContentBackward", "")).toEqual({ write: null });
  });

  it("simulates the user log: typing '가나다라마사' produces correct flushes", () => {
    const gate = createImeGate();
    const writes: string[] = [];
    const apply = (t: string, d: string) => {
      const r = gate.handleInput(t, d);
      if (r.write) writes.push(r.write);
    };
    // 가
    apply("insertText", "ㄱ");
    apply("insertReplacementText", "가");
    apply("insertReplacementText", "간");
    apply("insertReplacementText", "가");
    // user moves to next char 나
    apply("insertText", "ㄴ"); // commits "가"
    apply("insertReplacementText", "나");
    apply("insertReplacementText", "낟");
    apply("insertReplacementText", "나");
    // 다
    apply("insertText", "ㄷ"); // commits "나"
    apply("insertReplacementText", "다");
    apply("insertReplacementText", "달");
    apply("insertReplacementText", "다");
    // user presses Space — caller calls flushPending() from keydown capture
    const tail = gate.flushPending();
    if (tail) writes.push(tail);

    expect(writes).toEqual(["가", "나", "다"]);
  });

  it("two consecutive Korean glyphs followed by Enter flush in order", () => {
    const gate = createImeGate();
    const writes: string[] = [];
    const apply = (t: string, d: string) => {
      const r = gate.handleInput(t, d);
      if (r.write) writes.push(r.write);
    };
    apply("insertText", "ㅎ");
    apply("insertReplacementText", "한");
    apply("insertText", "ㄱ"); // commits 한
    apply("insertReplacementText", "글");
    const tail = gate.flushPending(); // user presses Enter
    if (tail) writes.push(tail);
    expect(writes).toEqual(["한", "글"]);
  });
});
