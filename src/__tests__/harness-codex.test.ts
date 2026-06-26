import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");

describe("Codex harness integration", () => {
    it("provides root Codex instructions that route repo mutations through the harness skill", () => {
        const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf-8");

        expect(agents).toContain("Codex instructions for this repository");
        expect(agents).toContain("use the `$harness` skill before editing source, tests, docs, or config");
        expect(agents).toContain("plan -> implement -> verify -> close");
        expect(agents).toContain("Codex Harness Routing");
    });

    it("provides a workspace harness skill for Codex", () => {
        const skillPath = join(repoRoot, ".agents", "skills", "harness", "SKILL.md");
        expect(existsSync(skillPath)).toBe(true);

        const skill = readFileSync(skillPath, "utf-8");
        expect(skill).toContain("name: harness");
        expect(skill).toContain("Use this skill to apply the repository harness from Codex");
        expect(skill).toContain("CONTRACTS.md");
        expect(skill).toContain("doc/harness/manifest.yaml");
    });
});
