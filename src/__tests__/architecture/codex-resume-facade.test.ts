import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coreBoundaryViolations } from "./core-boundary.js";

describe("Codex resume dependency boundaries", () => {



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
