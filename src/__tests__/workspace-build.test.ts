import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembleWorkspaceRuntime, buildWorkspacePackages } from "../../scripts/workspace-build.mjs";

const roots: string[] = [];
const repository = fileURLToPath(new URL("../../", import.meta.url));
const linkType = process.platform === "win32" ? "junction" : "dir";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "ccc workspace build "));
    roots.push(root);
    const modules = join(root, "node_modules");
    mkdirSync(modules);
    symlinkSync(realpathSync(join(repository, "node_modules", "typescript")), join(modules, "typescript"), linkType);
    for (const name of ["hyper-v", "device-lab"]) {
        const pkg = join(root, "packages", name);
        mkdirSync(join(pkg, "src"), { recursive: true });
        writeFileSync(join(pkg, "package.json"), JSON.stringify({
            name: `@ccc/${name}`, type: "module",
            exports: { "./*.js": { types: "./dist/*.d.ts", import: "./dist/*.js" } },
        }));
        writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({
            compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
                rootDir: "src", outDir: "dist", declaration: true, strict: true, skipLibCheck: true },
            include: ["src/**/*.ts"],
        }));
    }
    for (const [file, value] of [["index", 1], ["lifecycle/index", 2], ["low-level/index", 3]] as const) {
        const source = join(root, "packages", "hyper-v", "src", `${file}.ts`);
        mkdirSync(dirname(source), { recursive: true });
        writeFileSync(source, `export const value = ${value};\n`);
    }
    writeFileSync(join(root, "packages", "device-lab", "src", "index.ts"), [
        'import {value as a} from "@ccc/hyper-v/index.js";',
        'import {value as b} from "@ccc/hyper-v/lifecycle/index.js";',
        'import {value as c} from "@ccc/hyper-v/low-level/index.js";',
        'export const total = a + b + c;',
    ].join("\n"));
    return root;
}

function scope(root: string) { return join(root, "node_modules", "@ccc"); }
function source(root: string, name = "hyper-v") { return join(root, "packages", name); }
function link(root: string, name = "hyper-v") { return join(scope(root), name); }
function expectConsumer(root: string) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
        'import {total} from "@ccc/device-lab/index.js"; if(total!==6)throw Error("wrong workspace");'],
    { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
}

function assemblyFixture() {
    const root = fixture();
    for (const name of ["hyper-v", "device-lab"]) {
        mkdirSync(join(source(root, name), "powershell"));
        writeFileSync(join(source(root, name), "powershell", "operation.ps1"), "# retained asset\n");
    }
    mkdirSync(join(source(root, "device-lab"), "providers"));
    writeFileSync(join(source(root, "device-lab"), "providers", "fixture.mjs"), "export const provider = true;\n");
    mkdirSync(join(source(root, "device-lab"), "appium-runtime"));
    writeFileSync(join(source(root, "device-lab"), "appium-runtime", "package.json"), "{}");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "consumer.mjs"),
        'import {total} from "@ccc/device-lab/index.js"; if(total!==6)throw Error("incomplete assembly");\n');
    return root;
}

function expectAssembledConsumer(root: string) {
    // The packaged CLI must work without falling back to checkout workspace links.
    rmSync(scope(root), { recursive: true, force: true });
    const result = spawnSync(process.execPath, [join(root, "dist", "consumer.mjs")], {
        cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
}

function assemblyProcess(root: string, label: string, journal: string, hold = false) {
    const release = join(root, `${label}.release`);
    // Instrument the real fs entry points without replacing copying, rewriting or
    // lock admission. A held copy and a witnessed EEXIST make contention certain.
    const program = String.raw`
        const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
        const [moduleUrl, root, label, journal, release, hold] = process.argv.slice(1);
        const guard = path.join(fs.realpathSync(root), ".ccc-workspace-build.guard");
        const dist = path.join(root, "dist") + path.sep;
        const open = fs.openSync;
        fs.openSync = function(file, ...args) {
            try { return open.call(this, file, ...args); }
            catch (error) {
                if (file === guard && error.code === "EEXIST") process.send("waiting");
                throw error;
            }
        };
        let held = false;
        for (const method of ["rmSync", "mkdirSync", "cpSync", "writeFileSync"]) {
            const original = fs[method];
            fs[method] = function(...args) {
                const destination = method === "cpSync" ? args[1] : args[0];
                if (typeof destination === "string" && destination.startsWith(dist)) {
                    assert.equal(JSON.parse(fs.readFileSync(guard, "utf8")).pid, process.pid,
                        "assembly mutation must hold this process's project guard");
                    fs.appendFileSync(journal, label + "\n");
                    if (hold === "true" && method === "cpSync" && !held) {
                        held = true;
                        process.send("held");
                        const deadline = Date.now() + 20000;
                        while (!fs.existsSync(release)) {
                            if (Date.now() >= deadline) throw Error("copy barrier was not released");
                            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                        }
                    }
                }
                return original.apply(this, args);
            };
        }
        require("node:module").syncBuiltinESMExports();
        import(moduleUrl).then(({assembleWorkspaceRuntime}) => {
            assert.equal(assembleWorkspaceRuntime(root), undefined, "assembly remains synchronous");
        }).catch(error => { console.error(error); process.exitCode = 1; })
          .finally(() => process.disconnect());
    `;
    const child = spawn(process.execPath, ["-e", program,
        pathToFileURL(join(repository, "scripts", "workspace-build.mjs")).href, root, label, journal, release, String(hold)], {
        cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let output = "";
    child.stdout?.on("data", chunk => { output += chunk; });
    child.stderr?.on("data", chunk => { output += chunk; });
    const seen = new Set<string>();
    child.on("message", message => { seen.add(String(message)); });
    const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`assembler ${label}: code=${code}, signal=${signal}\n${output}`));
        });
    });
    void done.catch(() => {});
    return {
        done,
        async waitFor(message: string) {
            if (seen.has(message)) return;
            let onMessage: (value: unknown) => void;
            let timer: ReturnType<typeof setTimeout>;
            const observed = new Promise<void>((resolve, reject) => {
                onMessage = value => { if (value === message) resolve(); };
                child.on("message", onMessage);
                timer = setTimeout(() => reject(new Error(`assembler ${label} did not reach ${message}\n${output}`)), 20_000);
            });
            try { await Promise.race([observed, done.then(() => { throw new Error(`assembler ${label} exited before ${message}`); })]); }
            finally { clearTimeout(timer!); child.off("message", onMessage!); }
        },
        async close() {
            writeFileSync(release, "release");
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await done.catch(() => {});
        },
        release() { writeFileSync(release, "release"); },
    };
}

describe("portable runtime workspace build", () => {
    it("creates missing scope/links and resolves every reported subpath with real TypeScript and Node", () => {
        const root = fixture();
        expect(buildWorkspacePackages(root)).toBeUndefined();
        expect(realpathSync(link(root))).toBe(realpathSync(source(root)));
        expect(realpathSync(link(root, "device-lab"))).toBe(realpathSync(source(root, "device-lab")));
        expectConsumer(root);
        const stat = lstatSync(link(root));
        buildWorkspacePackages(root);
        expect(lstatSync(link(root)).ino).toBe(stat.ino);
        expect(lstatSync(link(root)).mtimeMs).toBe(stat.mtimeMs);
        expectConsumer(root);
    });

    it("repairs dangling links pointing to an old checkout without bypassing NodeNext compilation", () => {
        const root = fixture();
        mkdirSync(scope(root));
        symlinkSync(join(root, "old Windows checkout", "packages", "hyper-v"), link(root), linkType);
        buildWorkspacePackages(root);
        expectConsumer(root);
        if (process.platform !== "win32") expect(readlinkSync(link(root))).toBe(relative(scope(root), source(root)));
    });

    it("retargets a foreign link without deleting its target", () => {
        const root = fixture();
        const outside = join(root, "external workspace");
        mkdirSync(outside);
        writeFileSync(join(outside, "sentinel"), "preserve outside bytes");
        mkdirSync(scope(root));
        symlinkSync(outside, link(root), linkType);
        buildWorkspacePackages(root);
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("preserve outside bytes");
        expectConsumer(root);
    });

    it("repairs a link whose old target traverses a regular file", () => {
        const root = fixture();
        const outside = join(root, "old checkout file");
        writeFileSync(outside, "preserve old target bytes");
        mkdirSync(scope(root));
        symlinkSync(join(outside, "packages", "hyper-v"), link(root), linkType);
        buildWorkspacePackages(root);
        expect(readFileSync(outside, "utf8")).toBe("preserve old target bytes");
        expectConsumer(root);
    });

    it.each(["relative", "absolute"])("leaves a correct %s link untouched", form => {
        const root = fixture();
        mkdirSync(scope(root));
        symlinkSync(form === "relative" && process.platform !== "win32"
            ? relative(scope(root), source(root)) : source(root), link(root), linkType);
        const original = { target: readlinkSync(link(root)), stat: lstatSync(link(root)) };
        buildWorkspacePackages(root);
        expect(readlinkSync(link(root))).toBe(original.target);
        expect(lstatSync(link(root)).ino).toBe(original.stat.ino);
        expect(lstatSync(link(root)).mtimeMs).toBe(original.stat.mtimeMs);
        expectConsumer(root);
    });

    it.each(["file", "directory"])("preserves an ambiguous physical %s and prior output", kind => {
        const root = fixture();
        mkdirSync(scope(root));
        if (kind === "directory") mkdirSync(link(root));
        const preserved = kind === "directory" ? join(link(root), "sentinel") : link(root);
        writeFileSync(preserved, "physical object bytes");
        mkdirSync(join(source(root), "dist"));
        writeFileSync(join(source(root), "dist", "sentinel"), "old output");
        expect(() => buildWorkspacePackages(root)).toThrow("workspace-dependency-not-linked");
        expect(readFileSync(preserved, "utf8")).toBe("physical object bytes");
        expect(readFileSync(join(source(root), "dist", "sentinel"), "utf8")).toBe("old output");
    });

    it("validates both entries before replacing the first broken link", () => {
        const root = fixture();
        mkdirSync(scope(root));
        symlinkSync(join(root, "old checkout"), link(root), linkType);
        const target = readlinkSync(link(root));
        mkdirSync(link(root, "device-lab"));
        expect(() => buildWorkspacePackages(root)).toThrow("workspace-dependency-not-linked");
        expect(readlinkSync(link(root))).toBe(target);
    });

    it.each(["scope", "node_modules"])("refuses a redirected %s without modifying its target", parent => {
        const root = fixture();
        const outside = join(root, "outside dependency parent");
        mkdirSync(outside);
        writeFileSync(join(outside, "sentinel"), "outside");
        const entry = parent === "scope" ? scope(root) : join(root, "node_modules");
        if (parent === "node_modules") rmSync(entry, { recursive: true });
        symlinkSync(outside, entry, linkType);
        expect(() => buildWorkspacePackages(root)).toThrow("workspace-dependency-parent-invalid");
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside");
        expect(readlinkSync(entry)).toBeTruthy();
    });

    it("rejects an invalid source manifest before any dependency or output mutation", () => {
        const root = fixture();
        writeFileSync(join(source(root, "device-lab"), "package.json"), '{"name":"foreign"}');
        mkdirSync(join(source(root), "dist"));
        const sentinel = join(source(root), "dist", "sentinel");
        writeFileSync(sentinel, "prior output");
        expect(() => buildWorkspacePackages(root)).toThrow("workspace-source-invalid");
        expect(readFileSync(sentinel, "utf8")).toBe("prior output");
        expect(() => lstatSync(scope(root))).toThrow();
    });

    it("bootstraps the copied build script with no compiled package output or workspace links", () => {
        const root = fixture();
        mkdirSync(join(root, "scripts"));
        for (const name of ["workspace-build.mjs", "windows-lx-workspace-link.mjs"]) {
            cpSync(join(repository, "scripts", name), join(root, "scripts", name));
        }
        // A copy is required: a symlink would resolve helper imports in this checkout
        // and hide an accidental dependency on its already compiled output.
        cpSync(join(repository, "packages", "device-lab", "providers"),
            join(source(root, "device-lab"), "providers"), { recursive: true });
        expect(existsSync(join(root, "dist"))).toBe(false);
        expect(existsSync(scope(root))).toBe(false);
        const result = spawnSync(process.execPath, [join(root, "scripts", "workspace-build.mjs"), "build"], {
            cwd: root, encoding: "utf8", timeout: 25_000, windowsHide: true,
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expectConsumer(root);
    });

    it("serializes competing real assemblies through import rewriting and releases the project guard", async () => {
        const root = assemblyFixture();
        buildWorkspacePackages(root);
        const aliasDirectory = mkdtempSync(join(tmpdir(), "ccc workspace alias "));
        roots.push(aliasDirectory);
        const alias = join(aliasDirectory, "checkout");
        symlinkSync(root, alias, linkType);
        const journal = join(root, "mutations.txt");
        const first = assemblyProcess(root, "first", journal, true);
        let second: ReturnType<typeof assemblyProcess> | undefined;
        try {
            await first.waitFor("held");
            second = assemblyProcess(alias, "second", journal);
            await second.waitFor("waiting");
            first.release();
            await Promise.all([first.done, second.done]);
            const turns = readFileSync(journal, "utf8").trim().split("\n")
                .filter((label, index, all) => index === 0 || label !== all[index - 1]);
            expect(turns).toEqual(["first", "second"]);
            expect(existsSync(join(root, ".ccc-workspace-build.guard"))).toBe(false);
            expectAssembledConsumer(root);
        } finally {
            await Promise.all([first.close(), second?.close()]);
        }
    });

    it("allows another project to assemble while a copy in the first project is held", async () => {
        const root = assemblyFixture();
        buildWorkspacePackages(root);
        const other = fixture();
        // Reuse real compiler output so this checks lock scope without compiling twice.
        cpSync(join(root, "packages"), join(other, "packages"), { recursive: true });
        cpSync(join(root, "dist"), join(other, "dist"), { recursive: true });
        const first = assemblyProcess(root, "first", join(root, "mutations.txt"), true);
        let second: ReturnType<typeof assemblyProcess> | undefined;
        try {
            await first.waitFor("held");
            second = assemblyProcess(other, "independent", join(other, "mutations.txt"));
            // The first copy remains blocked until the independent assembly exits.
            await second.done;
            expectAssembledConsumer(other);
            first.release();
            await first.done;
            expectAssembledConsumer(root);
        } finally {
            await Promise.all([first.close(), second?.close()]);
        }
    });

    it("releases a failed assembly's guard so a corrected synchronous retry can finish", () => {
        const root = assemblyFixture();
        buildWorkspacePackages(root);
        const artifact = join(source(root), "dist", "lifecycle", "index.js");
        const contents = readFileSync(artifact);
        rmSync(artifact);
        expect(() => assembleWorkspaceRuntime(root)).toThrow("workspace-export-artifact-missing: @ccc/hyper-v/lifecycle/index.js");
        expect(existsSync(join(root, ".ccc-workspace-build.guard"))).toBe(false);
        writeFileSync(artifact, contents);
        expect(assembleWorkspaceRuntime(root)).toBeUndefined();
        expectAssembledConsumer(root);
    });
});
