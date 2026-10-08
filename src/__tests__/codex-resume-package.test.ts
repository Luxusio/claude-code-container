import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function isolatedPackage(bundle: boolean) {
    const root = mkdtempSync(join(tmpdir(), "ccc-resume-package-"));
    roots.push(root);
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "dist", "domain", "tool-session"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    copyFileSync(new URL("../../dist/codex-resume-recovery.js", import.meta.url), join(root, "dist/codex-resume-recovery.js"));
    copyFileSync(new URL("../../dist/domain/tool-session/codex-resume.js", import.meta.url), join(root, "dist/domain/tool-session/codex-resume.js"));
    if (bundle) copyFileSync(new URL("../../dist/codex-resume-runtime.cjs", import.meta.url), join(root, "dist/codex-resume-runtime.cjs"));
    return root;
}

function invokeHost(root: string, args: string[], execute = false) {
    return spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { pathToFileURL } from 'node:url';
        import { spawnSync } from 'node:child_process';
        const { buildCodexResumeRecoveryCommand } = await import(pathToFileURL(process.argv[1]));
        const command = buildCodexResumeRecoveryCommand(JSON.parse(process.argv[2]));
        if (process.argv[3] === 'execute') {
            command[4] = JSON.stringify({command:[process.execPath,'-e','process.exit(23)'], retry:[process.execPath], config:[]});
            const result = spawnSync(process.execPath, command.slice(1), {stdio:'inherit'});
            process.exit(result.status ?? 1);
        }
        process.stdout.write(JSON.stringify(command));
    `, join(root, "dist/codex-resume-recovery.js"), JSON.stringify(args), execute ? "execute" : "inspect"], {
        cwd: root, encoding: "utf8", timeout: 15000,
    });
}

describe("packaged typed Codex resume runtime", () => {
    it("executes the generated runtime from a relocated dist-only package", () => {
        const root = isolatedPackage(true);
        expect(existsSync(join(root, "src"))).toBe(false);
        const result = invokeHost(root, ["codex", "resume"], true);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(23);
    });

    it("reports an absent runtime and preserves the original eligible command", () => {
        const command = ["codex", "--no-daemon", "resume", "--last"];
        const result = invokeHost(isolatedPackage(false), command);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(command);
        expect(result.stderr).toContain("rebuild or reinstall CCC");
    });

    it.each([["codex", "doctor"], ["codex", "resume", "id", "prompt"], ["codex", "resume", "--unknown"]])(
        "does not require an artifact for excluded commands: %j", (...command) => {
            const result = invokeHost(isolatedPackage(false), command);
            expect(result.status).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual(command);
            expect(result.stderr).toBe("");
        },
    );

    it.each([undefined, "secret-invalid-json", "null", "[]", "{}", '{"command":[1],"retry":[],"config":[]}'])(
        "rejects malformed transport input without echoing it: %s", input => {
            const runtime = readFileSync(new URL("../../dist/codex-resume-runtime.cjs", import.meta.url), "utf8");
            const result = spawnSync(process.execPath, ["-e", runtime, "--", ...(input === undefined ? [] : [input])], { encoding: "utf8", timeout: 5000 });
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("Invalid Codex resume recovery invocation");
            expect(result.stderr).not.toContain("secret-invalid-json");
        },
    );

    it("validates the entire payload before dispatching its command", () => {
        const root = isolatedPackage(true);
        const marker = join(root, "unexpected-dispatch");
        const runtime = readFileSync(join(root, "dist/codex-resume-runtime.cjs"), "utf8");
        const input = JSON.stringify({ command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`], retry: ["codex"], config: "invalid" });
        const result = spawnSync(process.execPath, ["-e", runtime, "--", input], { encoding: "utf8", timeout: 5000 });
        expect(result.status).toBe(1);
        expect(existsSync(marker)).toBe(false);
    });
});
