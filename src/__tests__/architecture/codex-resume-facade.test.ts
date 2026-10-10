import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coreBoundaryViolations } from "./core-boundary.js";

describe("Codex resume dependency boundaries", () => {
    const candidate = readFileSync(fileURLToPath(new URL("../../codex-resume-recovery.ts", import.meta.url)), "utf8");
    const cases = [
        [], ["codex"], ["claude", "resume"], ["codex", "resume"], ["codex", "resume", "id"],
        ["codex", "-c", 'model="private"', "resume", "--last", "--all", "--include-non-interactive"],
        ["codex", "--enable=x", "--disable", "x", "resume", "--model=m", "--search"],
        ["codex", "resume", "id", "prompt"], ["codex", "resume", "--remote=wss://invalid"],
        ["codex", "resume", "--image", "image"], ["codex", "--profile", "p", "resume"],
        ["codex", "resume", "--"], ["codex", "resume", "-c"], ["codex", "resume", "--unknown"],
    ];

    it("keeps every actual inward module inside the existing dependency boundary", () => {
        for (const path of ["domain/tool-session/codex-resume", "ports/tool-session/codex-resume-recovery", "application/tool-session/codex-resume-recovery"]) {
            const file = fileURLToPath(new URL("../../" + path + ".ts", import.meta.url));
            expect(coreBoundaryViolations(readFileSync(file, "utf8"), file, { root: fileURLToPath(new URL("../../", import.meta.url)), language: "ts" })).toEqual([]);
        }
    });
    it("rejects native defaults and application-to-facade dependencies", () => {
        const file = fileURLToPath(new URL("../../application/tool-session/codex-resume-recovery.ts", import.meta.url));
        const boundary = { root: fileURLToPath(new URL("../../", import.meta.url)), language: "ts" as const };
        for (const mutation of ['import {spawn} from "node:child_process";', 'process.env.CODEX_HOME;', 'Date.now();', 'import "../../codex-resume-process.js";', 'import("node:fs");']) {
            expect(coreBoundaryViolations(mutation, file, boundary).length).toBeGreaterThan(0);
        }
    });
});
