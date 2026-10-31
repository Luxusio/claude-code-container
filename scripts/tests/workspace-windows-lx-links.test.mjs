import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isWindowsLxWorkspaceLink, removeWindowsLxWorkspaceLink } from "../windows-lx-workspace-link.mjs";
import { buildWorkspacePackages } from "../workspace-build.mjs";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const lstat = fs.lstatSync;
const symlink = fs.symlinkSync;

test("both mcp-builder recipes supply the workspace script's local module graph", () => {
    const repository = fileURLToPath(new URL("../../", import.meta.url));
    for (const recipe of ["Dockerfile", "Containerfile"]) {
        const text = fs.readFileSync(join(repository, recipe), "utf8");
        const builder = text.split(/FROM node:22-slim AS mcp-builder\r?\n/)[1].split(/\r?\nFROM /)[0];
        const copies = new Map();
        for (const line of builder.split(/\r?\n/)) {
            if (!line.startsWith("COPY ")) continue;
            const parts = line.slice(5).trim().split(/\s+/);
            const destination = parts.pop();
            for (const source of parts) {
                const target = destination.endsWith("/") ? destination + source.split("/").at(-1) : destination;
                copies.set(target.replace(/^\.\//, ""), source);
            }
        }
        function inspect(target, visited = new Set()) {
            if (visited.has(target)) return;
            visited.add(target);
            assert.ok(copies.has(target), `${recipe}: builder omits ${target}`);
            const code = fs.readFileSync(join(repository, copies.get(target)), "utf8");
            for (const match of code.matchAll(/\bfrom\s+["'](\.\/[^"']+)["']/g)) {
                inspect(target.slice(0, target.lastIndexOf("/") + 1) + match[1].slice(2), visited);
            }
        }
        inspect("scripts/workspace-build.mjs");
    }
});

function patched(t) {
    const calls = [];
    t.after(() => {
        Object.defineProperty(process, "platform", originalPlatform);
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
    let dispatch = () => { throw new Error("unplanned native command"); };
    t.mock.method(cp, "spawnSync", (command, args, options) => {
        calls.push({ command, args, options });
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.equal(options.timeout, 15_000);
        assert.equal(options.maxBuffer, 64 * 1024);
        return dispatch(command, args, options);
    });
    syncBuiltinESMExports();
    return { calls, use(fn) { dispatch = fn; } };
}

test("localized exact LX tag only, bounded argv and no shell interpolation", t => {
    const native = patched(t);
    const path = "C:\\workspace with spaces\\it's $(ignored); test\\node_modules\\@ccc\\hyper-v";
    for (const stdout of ["리파스 태그 값: 0xa000001d\r\n", "Reparse Tag Value : 0xA000001D\n"]) {
        native.use(() => ({ status: 0, stdout }));
        assert.equal(isWindowsLxWorkspaceLink(path), true);
        assert.deepEqual(native.calls.at(-1).args, ["reparsepoint", "query", path]);
        assert.match(native.calls.at(-1).command, /\\System32\\fsutil\.exe$/i);
    }
    for (const result of [
        { status: 0, stdout: "Tag: 0xa0000003\nData: 0xa000001d" },
        { status: 0, stdout: "Tag: 0xa000001d extra" },
        { status: 0, stdout: "garbage" }, { status: 1, stdout: "Tag: 0xa000001d" },
        { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
    ]) {
        native.use(() => result);
        assert.equal(isWindowsLxWorkspaceLink(path), false);
    }
});

test("changed tags and failed deletion never remove directory contents", t => {
    const native = patched(t);
    const root = fs.mkdtempSync(join(tmpdir(), "ccc-lx-refusal-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(join(root, "sentinel"), "preserve");
    native.use(() => ({ status: 0, stdout: "Tag: 0xa0000003" }));
    assert.throws(() => removeWindowsLxWorkspaceLink(root), /workspace-linux-link-changed/);
    assert.equal(native.calls.length, 1);
    native.use((_, args) => args[1] === "query"
        ? { status: 0, stdout: "Tag: 0xa000001d" } : { status: 5 });
    assert.throws(() => removeWindowsLxWorkspaceLink(root), /workspace-linux-link-repair-failed/);
    native.use((_, args) => args[1] === "query"
        ? { status: 0, stdout: "Tag: 0xa000001d" }
        : { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) });
    assert.throws(() => removeWindowsLxWorkspaceLink(root), /workspace-linux-link-repair-failed: ETIMEDOUT/);
    native.use((_, args) => args[1] === "query"
        ? { status: 0, stdout: "Tag: 0xa000001d" } : { status: 0 });
    assert.throws(() => removeWindowsLxWorkspaceLink(root), error => ["ENOTEMPTY", "EEXIST"].includes(error.code));
    assert.equal(fs.readFileSync(join(root, "sentinel"), "utf8"), "preserve");
});

function workspace(t, { otherPhysical = false, tag = "0xa000001d", platform = "win32", code = "EACCES" } = {}) {
    const root = fs.mkdtempSync(join(tmpdir(), "ccc-lx-build-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scope = join(root, "node_modules", "@ccc");
    fs.mkdirSync(scope, { recursive: true });
    for (const name of ["hyper-v", "device-lab"]) {
        const pkg = join(root, "packages", name);
        fs.mkdirSync(join(pkg, "dist"), { recursive: true });
        fs.writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: `@ccc/${name}` }));
        fs.writeFileSync(join(pkg, "dist", "sentinel"), "prior output");
    }
    const source = join(root, "packages", "hyper-v");
    fs.writeFileSync(join(source, "target-sentinel"), "target survives");
    const link = join(scope, "hyper-v");
    symlink(source, link, originalPlatform.value === "win32" ? "junction" : "dir");
    if (otherPhysical) fs.mkdirSync(join(scope, "device-lab"));
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    const failure = Object.assign(new Error("original access failure"), { code });
    let unreadable = true;
    const events = [];
    t.mock.method(fs, "lstatSync", (path, ...args) => {
        if (path === link && unreadable) throw failure;
        return lstat(path, ...args);
    });
    t.mock.method(fs, "symlinkSync", (target, path, type) => {
        events.push(["link", path, type]);
        return symlink(target, path, originalPlatform.value === "win32" ? "junction" : "dir");
    });
    t.mock.method(cp, "spawnSync", (command, args, options) => {
        if (/[/\\]WindowsPowerShell[/\\]v1\.0[/\\]powershell\.exe$/i.test(command)) {
            // Build admission also observes its own process through the shared-lock
            // SDK on native Windows. Keep that observation separate from LX repair.
            assert.deepEqual(args.slice(0, -1), ["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command"]);
            assert.equal(args.at(-1), "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $P = Get-CimInstance Win32_Process -Filter 'ProcessId = " + process.pid
                + "' -ErrorAction SilentlyContinue; $H = Get-Process -Id " + process.pid
                + " -ErrorAction SilentlyContinue; if ($P -and $H) { [pscustomobject]@{ startToken = $H.StartTime.ToUniversalTime().ToString('o'); commandLine = [string]$P.CommandLine } | ConvertTo-Json -Compress }");
            assert.equal(options.windowsHide, true);
            assert.equal(options.killSignal, "SIGKILL");
            assert.ok(options.timeout > 0 && options.timeout <= 5_000);
            return { status: 0, stdout: JSON.stringify({ startToken: "2026-10-31T00:00:00.0000000Z", commandLine: "node workspace LX fixture" }) };
        }
        if (/fsutil\.exe$/i.test(command)) {
            assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
            assert.equal(options.timeout, 15_000);
            assert.deepEqual(args, ["reparsepoint", args[1], link]);
            events.push([args[1], link]);
            if (args[1] === "query") return { status: 0, stdout: `리파스 태그 값: ${tag}\r\n` };
            // Model only NTFS metadata removal using owned fixture entries.
            fs.unlinkSync(link); fs.mkdirSync(link); unreadable = false;
            return { status: 0 };
        }
        assert.equal(command, process.execPath);
        events.push(["compiler"]);
        return { status: 0 }; // Real compiler/import proof stays in workspace-build.test.ts.
    });
    syncBuiltinESMExports();
    return { root, source, link, failure, events };
}

test("Windows LX entries become junctions before compilation; targets survive", t => {
    patched(t);
    const w = workspace(t);
    buildWorkspacePackages(w.root);
    assert.equal(fs.realpathSync(w.link), fs.realpathSync(w.source));
    assert.deepEqual(w.events.slice(0, 4), [["query", w.link], ["query", w.link], ["delete", w.link], ["link", w.link, "junction"]]);
    assert.equal(w.events.filter(e => e[0] === "compiler").length, 2);
    assert.equal(fs.existsSync(w.source), true);
    assert.equal(fs.readFileSync(join(w.source, "target-sentinel"), "utf8"), "target survives");
});

test("both dependencies are validated before LX metadata or prior outputs change", t => {
    patched(t);
    const w = workspace(t, { otherPhysical: true });
    assert.throws(() => buildWorkspacePackages(w.root), /workspace-dependency-not-linked/);
    assert.deepEqual(w.events, [["query", w.link]]);
    assert.equal(fs.readFileSync(join(w.source, "dist", "sentinel"), "utf8"), "prior output");
});

for (const options of [{ tag: "0xa0000003" }, { platform: "linux" }, { code: "EIO" }]) {
    test(`preserves original error for ${JSON.stringify(options)}`, t => {
        patched(t);
        const w = workspace(t, options);
        assert.throws(() => buildWorkspacePackages(w.root), error => error === w.failure);
        assert.equal(w.events.some(e => ["delete", "link", "compiler"].includes(e[0])), false);
        assert.equal(fs.readFileSync(join(w.source, "dist", "sentinel"), "utf8"), "prior output");
    });
}
