import { describe, expect, it } from "vitest";
import { WORKTREE_SEPARATOR, formatWorkspaceSiblingBasename, iterateWorkspaceSourceBasenames } from "../../domain/workspace-naming.js";

describe("canonical workspace naming", () => {
    it.each([
        ["repo", "feature/a/b", "repo--feature-a-b"],
        [" Repo ", " A\\B / C ", " Repo -- A\\B - C "],
        ["a--b", "", "a--b--"],
        ["", "//", "----"],
        ["한글", "💡/작업", "한글--💡-작업"],
    ])("formats %j and %j without extra normalization", (source, branch, expected) => {
        expect(WORKTREE_SEPARATOR).toBe("--");
        expect(formatWorkspaceSiblingBasename(source, branch)).toBe(expected);
    });

    it("calls replace before source coercion and preserves replacement failure identity", () => {
        const events: string[] = [];
        const source = { toString() { events.push("source"); return "repo"; } } as unknown as string;
        const branch = { replace(pattern: RegExp, replacement: string) {
            events.push("replace"); expect(pattern.source).toBe("\\/"); expect(pattern.flags).toBe("g");
            expect(replacement).toBe("-"); return "branch";
        } } as unknown as string;
        expect(formatWorkspaceSiblingBasename(source, branch)).toBe("repo--branch");
        expect(events).toEqual(["replace", "source"]);
        for (const failure of [new Error("replace"), { stage: "replace" }]) {
            events.length = 0;
            const broken = { replace() { throw failure; } } as unknown as string;
            let observed: unknown;
            try { formatWorkspaceSiblingBasename(source, broken); } catch (error) { observed = error; }
            expect(observed).toBe(failure); expect(events).toEqual([]);
        }
    });

    it.each([
        ["", []], ["repo", []], ["--a--b", []], ["a--", ["a"]],
        ["a---b", ["a"]], ["a----b", ["a", "a--"]],
        ["a--b--c", ["a", "a--b"]], [" a -- b ", [" a "]],
    ] as const)("walks non-overlapping literal separators in %j", (name, expected) => {
        expect([...iterateWorkspaceSourceBasenames(name)]).toEqual(expected);
    });

    it("defers all string effects and later searches until the consumer resumes", () => {
        const events: unknown[][] = [];
        const input = {
            indexOf(separator: string, from?: number) { events.push(["index", separator, from]); return from === undefined ? 1 : from === 3 ? 4 : -1; },
            slice(start: number, end: number) { events.push(["slice", start, end]); return end === 1 ? "a" : "a--b"; },
        } as unknown as string;
        const iterator = iterateWorkspaceSourceBasenames(input);
        expect(events).toEqual([]);
        expect(iterator.next()).toEqual({ value: "a", done: false });
        expect(events).toEqual([["index", "--", undefined], ["slice", 0, 1]]);
        events.push(["native", "first"]);
        expect(iterator.next()).toEqual({ value: "a--b", done: false });
        expect(events).toEqual([["index", "--", undefined], ["slice", 0, 1], ["native", "first"], ["index", "--", 3], ["slice", 0, 4]]);
        expect(iterator.return()).toEqual({ value: undefined, done: true });
        expect(events).toHaveLength(5);
    });

    it.each(["initial-search", "slice", "later-search"])("preserves Error and non-Error identity at %s", stage => {
        for (const failure of [new Error(stage), { stage }]) {
            const events: string[] = [];
            const input = {
                indexOf(_separator: string, from?: number) {
                    events.push(from === undefined ? "initial-search" : "later-search");
                    if (stage === events.at(-1)) throw failure;
                    return 1;
                },
                slice() { events.push("slice"); if (stage === "slice") throw failure; return "a"; },
            } as unknown as string;
            const iterator = iterateWorkspaceSourceBasenames(input);
            let observed: unknown;
            try { iterator.next(); if (stage === "later-search") { events.push("native"); iterator.next(); } } catch (error) { observed = error; }
            expect(observed).toBe(failure);
            expect(events).toEqual(stage === "initial-search" ? [stage] : stage === "slice" ? ["initial-search", "slice"] : ["initial-search", "slice", "native", "later-search"]);
            expect(iterator.next()).toEqual({ value: undefined, done: true });
        }
    });
});
