import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Execute the actual installer in an owned copy. Only its Unix destination is
// redirected; no fixture can touch the machine's global CLI or User PATH.
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "ccc-install-"));
    fixtures.push(root);
    const installDir = join(root, "owned-bin");
    const commands = join(root, "commands");
    mkdirSync(installDir);
    mkdirSync(commands);
    for (const dir of ["scripts", "dist", "src", "packages/device-lab/providers/state", "device-lab-mcp"]) mkdirSync(join(root, dir), { recursive: true });
    const source = readFileSync(resolve("scripts/install.js"), "utf8");
    expect(source).toContain('return "/usr/local/bin";');
    writeFileSync(join(root, "scripts/install.js"), source.replace('return "/usr/local/bin";', `return ${JSON.stringify(installDir)};`));
    writeFileSync(join(root, "packages/device-lab/providers/state/windows-system-powershell.mjs"), 'export const canonicalWindowsPowerShellPath = () => null; export const hiddenWindowsPowerShellArgs = args => args;');
    for (const file of ["Dockerfile", "Containerfile", "package-lock.json", "tsconfig.json"]) writeFileSync(join(root, file), "{}");
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.0.0" }));
    mkdirSync(join(root, "scripts/clipboard-shims"));
    for (const name of ["xclip", "xsel", "wl-paste", "wl-copy", "pbpaste"]) writeFileSync(join(root, "scripts/clipboard-shims", name), "fixture");
    writeFileSync(join(root, "dist/index.js"), 'console.log("fixture CLI");');
    const log = join(root, "calls");
    for (const name of ["npm", "docker", "podman"]) {
        const script = `#!/bin/sh\nprintf '%s\\n' '${name} '"$*" >> "$FIXTURE_LOG"\n` + (name === "npm" ? 'exit "${FIXTURE_NPM_STATUS:-0}"\n' : 'case "$1" in\n--version) exit "${FIXTURE_PROBE_STATUS:-0}";;\ninspect) if [ "$FIXTURE_RUNTIME_DISAPPEAR" = 1 ]; then rm -- "$0"; fi; exit 1;;\nbuild) if [ "$FIXTURE_RUNTIME_SIGNAL" = 1 ]; then kill -TERM $$; fi; exit "${FIXTURE_IMAGE_STATUS:-0}";;\nesac\n');
        writeFileSync(join(commands, name), script);
        chmodSync(join(commands, name), 0o755);
    }
    const run = (args: string[] = [], env: Record<string, string> = {}) => spawnSync(process.execPath, [join(root, "scripts/install.js"), ...args], {
        encoding: "utf8", timeout: 10000,
        env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, CCC_RUNTIME: "", FIXTURE_LOG: log, ...env },
    });
    const calls = () => existsSync(log) ? readFileSync(log, "utf8") : "";
    return { root, installDir, run, calls };
}

// These process fixtures use POSIX executable shims and exercise Unix payloads.
describe.skipIf(process.platform === "win32")("source global installer", () => {
    it("builds and installs a runnable private CLI with zero runtime calls using --skip-image", () => {
        const f = fixture();
        const result = f.run(["--skip-image"], { CCC_RUNTIME: "docker" });
        expect(result.status).toBe(0);
        expect(f.calls()).toBe("npm run build\n");
        expect(result.stdout).toContain("CLI installed.");
        expect(result.stdout).toContain("skipped (--skip-image)");
        const cli = spawnSync(process.execPath, [join(f.installDir, "ccc")], { encoding: "utf8" });
        expect(cli.status).toBe(0);
        expect(cli.stdout).toContain("fixture CLI");
        expect(existsSync(join(f.installDir, "ccc-dist/dist/index.js"))).toBe(true);
    });

    it.each([{ FIXTURE_IMAGE_STATUS: "7", reason: "exited with code 7" }, { FIXTURE_RUNTIME_SIGNAL: "1", reason: "terminated by SIGTERM" }, { FIXTURE_RUNTIME_DISAPPEAR: "1", reason: "ENOENT" }])("installs the CLI and reports image failure accurately: $reason", ({ reason, ...env }) => {
        const f = fixture();
        const result = f.run([], env as Record<string, string>);
        expect(result.status).toBe(0);
        expect(existsSync(join(f.installDir, "ccc"))).toBe(true);
        expect(result.stderr).toContain(reason);
        expect(result.stdout).toContain("Container image build failed; CLI installation succeeded.");
        expect(result.stdout).not.toContain("Container image ready.");
        expect(result.stdout).not.toContain("Done!");
    });

    it("installs the CLI and reports runtime absence as a skipped image", () => {
        const f = fixture();
        const result = f.run([], { FIXTURE_PROBE_STATUS: "1" });
        expect(result.status).toBe(0);
        expect(existsSync(join(f.installDir, "ccc"))).toBe(true);
        expect(f.calls()).toBe("npm run build\npodman --version\ndocker --version\n");
        expect(result.stdout).toContain("Container image build skipped (no runtime detected).");
        expect(result.stdout).not.toContain("Container image ready.");
    });

    it("preserves an existing installation when source build fails", () => {
        const f = fixture();
        writeFileSync(join(f.installDir, "ccc"), "existing CLI");
        const result = f.run(["--skip-image"], { FIXTURE_NPM_STATUS: "3" });
        expect(result.status).not.toBe(0);
        expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe("existing CLI");
        expect(f.calls()).toBe("npm run build\n");
    });

    it("builds the image normally before reporting readiness", () => {
        const f = fixture();
        const result = f.run();
        expect(result.status).toBe(0);
        expect(f.calls()).toContain("podman --version");
        expect(f.calls()).toContain("podman inspect ccc");
        expect(f.calls()).toContain("podman build -t ccc --label content.hash=");
        expect(result.stdout).toContain("Container image ready.");
    });

    it("keeps postinstall build-only and uninstall runtime-free", () => {
        const f = fixture();
        expect(f.run(["--postinstall"]).status).toBe(0);
        expect(f.calls()).toBe("npm run build\n");
        expect(existsSync(join(f.installDir, "ccc"))).toBe(false);
        expect(f.run(["--skip-image"]).status).toBe(0);
        const before = f.calls();
        expect(f.run(["--uninstall"]).status).toBe(0);
        expect(f.calls()).toBe(before);
        expect(existsSync(join(f.installDir, "ccc"))).toBe(false);
        expect(existsSync(join(f.installDir, "ccc-dist"))).toBe(false);
    });

    it("does not install or build on module import", () => {
        const f = fixture();
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(join(f.root, "scripts/install.js"))})`], { encoding: "utf8" });
        expect(result.status).toBe(0);
        expect(f.calls()).toBe("");
        expect(existsSync(join(f.installDir, "ccc"))).toBe(false);
    });
});
