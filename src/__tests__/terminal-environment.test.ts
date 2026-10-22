import { describe, expect, it } from "vitest";
import { terminalEnvironment } from "../domain/terminal-environment.js";

describe("interactive terminal capabilities", () => {
    it("preserves host color depth, background and terminal identity", () => {
        expect(terminalEnvironment({ TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: "3.5", COLORFGBG: "0;15", HOME: "/host" }, "darwin"))
            .toEqual([["TERM", "xterm-256color"], ["COLORTERM", "truecolor"], ["TERM_PROGRAM", "iTerm.app"], ["TERM_PROGRAM_VERSION", "3.5"], ["COLORFGBG", "0;15"]]);
    });
    it.each([{ WT_SESSION: "session" }, { TERM_PROGRAM: "vscode" }])("recognizes modern Windows color support from %j", host => {
        expect(terminalEnvironment({ TERM: "dumb", ...host }, "win32"))
            .toEqual(expect.arrayContaining([["TERM", "xterm-256color"], ["COLORTERM", "truecolor"]]));
    });
    it("keeps an explicitly advertised host color mode", () => {
        expect(terminalEnvironment({ WT_SESSION: "session", TERM: "vt100", COLORTERM: "256color" }, "win32"))
            .toEqual([["TERM", "vt100"], ["COLORTERM", "256color"]]);
    });
    it("does not infer capabilities for an unknown terminal", () => {
        expect(terminalEnvironment({}, "win32")).toEqual([]);
        expect(terminalEnvironment({ TERM: "dumb" }, "linux")).toEqual([["TERM", "dumb"]]);
    });
    it("leaves explicit session overrides in the env file authoritative", () => {
        expect(terminalEnvironment({ TERM: "xterm-256color", COLORTERM: "truecolor", COLORFGBG: "15;0", WT_SESSION: "session" }, "win32", [["TERM", "dumb"], ["COLORTERM", ""], ["COLORFGBG", "0;15"]]))
            .toEqual([]);
    });
    it("does not manufacture truecolor when the session explicitly requests TERM=dumb", () => {
        expect(terminalEnvironment({ WT_SESSION: "session" }, "win32", [["TERM", "dumb"]])).toEqual([]);
    });
    it("keeps case-distinct Linux container overrides separate on every host", () => {
        expect(terminalEnvironment({ TERM: "xterm-256color" }, "win32", [["term", "lowercase"]]))
            .toEqual([["TERM", "xterm-256color"]]);
    });
    it.each(["bad\nmode", "bad\rmode", "bad\0mode", "bad\x1bmode", "x".repeat(1025)])("omits malformed or oversized capability values", value => {
        expect(terminalEnvironment({ TERM: value, COLORFGBG: "15;0" }, "linux"))
            .toEqual([["COLORFGBG", "15;0"]]);
    });
    it("retains the capability identifier at the length bound", () => {
        expect(terminalEnvironment({ TERM: "x".repeat(1024) }, "linux"))
            .toEqual([["TERM", "x".repeat(1024)]]);
    });

});
