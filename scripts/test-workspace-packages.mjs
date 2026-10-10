import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assembleWorkspaceRuntime } from "./workspace-build.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputLimit = 4 * 1024 * 1024;

function isolatedEnvironment(home) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        !name.startsWith("CCC_") && !name.startsWith("VITEST") && !["NODE_PATH", "NODE_OPTIONS"].includes(name)));
    return { ...env, HOME: home, USERPROFILE: home, CCC_DEVICE_BROKER_AUTO_START: "0" };
}

function command(executable, args, cwd, env) {
    const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 120000,
        maxBuffer: outputLimit, windowsHide: true, shell: false });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, String(result.stderr || result.stdout).slice(-2000));
    return result.stdout;
}

function requireFile(file) {
    assert(lstatSync(file).isFile(), `Missing packaged file: ${file}`);
}

/** Check current manifest targets and assets, without historical source or hash catalogs. */
export function validatePackageLayout(packageRoot) {
    packageRoot = resolve(packageRoot);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.type, "module");
    assert.equal(typeof manifest.version, "string");
    for (const file of ["dist/index.js", "dist/device-lab-mcp/server.mjs", "scripts/install.js",
        "scripts/build-distribution-image.mjs", "Dockerfile", "Dockerfile.distribution", "Containerfile"]) {
        requireFile(join(packageRoot, file));
    }
    const binTargets = bin => typeof bin === "string" ? [bin] : Object.values(bin || {});
    for (const target of binTargets(manifest.bin)) requireFile(join(packageRoot, target));
    for (const name of ["device-lab", "hyper-v"]) {
        const directory = join(packageRoot, "dist/packages", name);
        const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        assert.equal(pkg.name, `@ccc/${name}`);
        assert.equal(pkg.version, manifest.version);
        assert(pkg.exports && Object.keys(pkg.exports).length > 0, `Missing ${name} public exports`);
        const files = readdirSync(directory, { recursive: true }).filter(file => lstatSync(join(directory, file)).isFile());
        const targets = value => typeof value === "string" ? [value] : Object.values(value || {}).flatMap(targets);
        for (const target of targets(pkg.exports)) {
            assert(target.startsWith("./"), `Invalid package export: ${target}`);
            const absolute = resolve(directory, target);
            assert(absolute.startsWith(directory + sep), `Export outside package: ${target}`);
            if (target.includes("*")) {
                const pattern = new RegExp("^" + target.slice(2).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*") + "$");
                assert(files.some(file => pattern.test(file.split(sep).join("/"))), `Missing wildcard export: ${target}`);
            } else requireFile(absolute);
        }
        for (const target of binTargets(pkg.bin)) requireFile(join(directory, target));
        assert(readdirSync(join(directory, "powershell")).length > 0, `Missing ${name} native assets`);
    }
    const appium = join(packageRoot, "dist/packages/device-lab/appium-runtime");
    for (const file of ["package.json", "package-lock.json", "server.mjs"]) requireFile(join(appium, file));
    assert(readdirSync(join(packageRoot, "dist/packages/device-lab/providers")).length > 0);
    assert(!existsSync(join(packageRoot, "dist/x11-mcp")), "Obsolete X11 bundle packaged");
    // Validate the shipped Docker context, without building an image or installing runtimes.
    const recipe = readFileSync(join(packageRoot, "Dockerfile.distribution"), "utf8");
    for (const line of recipe.split("\n")) {
        if (!line.startsWith("COPY ") || line.includes("--from=")) continue;
        const words = line.split(/\s+/).slice(1).filter(word => !word.startsWith("--"));
        for (const source of words.slice(0, -1)) assert(existsSync(join(packageRoot, source)), `Missing Docker COPY input: ${source}`);
    }
    return manifest;
}

/** Exercise the bundled MCP transport; timeout override supports small fake-server tests. */
export async function mcpSmoke(packageRoot, { timeoutMs = 30000 } = {}) {
    packageRoot = resolve(packageRoot);
    assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
    const home = mkdtempSync(join(tmpdir(), "ccc-mcp-smoke-"));
    const child = spawn(process.execPath, [join(packageRoot, "dist/device-lab-mcp/server.mjs")], {
        cwd: home, env: isolatedEnvironment(home), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
    });
    const pending = new Map();
    let sequence = 0, bytes = 0, buffer = "", stderr = "", failure, closed = false, stopping = false;
    const fail = error => {
        failure ||= error;
        for (const entry of pending.values()) entry.reject(failure);
        pending.clear();
    };
    const close = new Promise(resolveClose => child.once("close", (code, signal) => {
        closed = true;
        if (!stopping) fail(new Error(`Packaged MCP closed (${code ?? signal}): ${stderr.slice(-2000)}`));
        resolveClose({ code, signal });
    }));
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.stderr.on("data", data => {
        bytes += data.length;
        if (bytes > outputLimit) return fail(new Error("Packaged MCP output exceeded limit"));
        stderr += data.toString();
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", data => {
        bytes += Buffer.byteLength(data);
        if (bytes > outputLimit) return fail(new Error("Packaged MCP output exceeded limit"));
        buffer += data;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            let response;
            try { response = JSON.parse(line); } catch { fail(new Error("Packaged MCP emitted invalid JSON")); return; }
            if (!response || typeof response !== "object" || Array.isArray(response) || response.jsonrpc !== "2.0") {
                fail(new Error("Packaged MCP emitted invalid response envelope")); return;
            }
            if (typeof response.method === "string" && !Object.hasOwn(response, "id")
                && !Object.hasOwn(response, "result") && !Object.hasOwn(response, "error")) continue;
            if (!["number", "string"].includes(typeof response.id)
                || Object.hasOwn(response, "result") === Object.hasOwn(response, "error")
                || Object.hasOwn(response, "error") && (!response.error || typeof response.error !== "object"
                    || Array.isArray(response.error) || !Number.isInteger(response.error.code) || typeof response.error.message !== "string")) {
                fail(new Error("Packaged MCP emitted invalid response envelope")); return;
            }
            const entry = pending.get(response.id);
            if (entry) {
                pending.delete(response.id);
                if (response.error) entry.reject(new Error(`Packaged MCP RPC failed: ${response.error.code}`));
                else entry.resolve(response.result);
            }
        }
    });
    const request = (method, params = {}) => {
        if (failure) return Promise.reject(failure);
        const id = ++sequence;
        return new Promise((resolveRequest, reject) => {
            pending.set(id, { resolve: resolveRequest, reject });
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => { if (error) fail(error); });
        });
    };
    const timer = setTimeout(() => fail(new Error("Packaged MCP smoke timed out")), timeoutMs);
    let result, primary;
    try {
        const initialized = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
            clientInfo: { name: "ccc-package-smoke", version: "1" } });
        assert.equal(initialized.serverInfo.name, "device-lab-mcp");
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const listed = await request("tools/list");
        assert(Array.isArray(listed.tools) && listed.tools.some(tool => tool.name === "screenshot"));
        assert(listed.tools.some(tool => tool.name === "create_windows_vm"));
        await request("ping");
        if (failure) throw failure;
        result = { initialized, listed };
    } catch (error) { primary = error; }
    finally {
        clearTimeout(timer);
        stopping = true;
        child.stdin.end();
        const waitForClose = async milliseconds => {
            let deadline;
            try {
                return await Promise.race([close, new Promise((_, reject) => {
                    deadline = setTimeout(() => reject(new Error("Packaged MCP child did not close")), milliseconds);
                })]);
            } finally { clearTimeout(deadline); }
        };
        if (!primary) {
            try {
                const exit = await waitForClose(1000);
                assert.equal(exit.code, 0, `Packaged MCP exit code: ${exit.code}`);
                assert.equal(exit.signal, null, `Packaged MCP exit signal: ${exit.signal}`);
                assert.equal(buffer.trim(), "", "Packaged MCP emitted unterminated JSON");
                primary ||= failure;
            } catch (error) { primary = error; }
        }
        if (primary && !closed) {
            let killTimer;
            try {
                child.kill("SIGTERM");
                killTimer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 1000);
                await waitForClose(5000);
            } catch (error) { primary ||= error; }
            finally { clearTimeout(killTimer); }
        }
        if (!primary) {
            try { rmSync(home, { recursive: true, force: true }); }
            catch (error) { primary = error; }
        }
        if (primary) console.error(`Retained MCP smoke directory: ${home}`);
    }
    if (primary) throw primary;
    assert(result, "Packaged MCP smoke completed without a result");
    return result;
}

async function smoke(packageRoot, home) {
    const manifest = validatePackageLayout(packageRoot), env = isolatedEnvironment(home);
    assert.equal(command(process.execPath, [join(packageRoot, "dist/index.js"), "--version"], home, env).trim(), manifest.version);
    assert.match(command(process.execPath, [join(packageRoot, "dist/index.js"), "--help"], home, env), /ccc/i);
    const imports = ["device-lab/dist/index.js", "hyper-v/dist/index.js", "hyper-v/dist/low-level/index.js", "hyper-v/dist/lifecycle/index.js"]
        .map(file => pathToFileURL(join(packageRoot, "dist/packages", file)).href);
    const script = `import assert from 'node:assert/strict';
const [lab,hyper,low,lifecycle]=await Promise.all(${JSON.stringify(imports)}.map(url=>import(url)));
assert.equal(typeof lab.createDeviceBrokerServer,'function');assert.equal(typeof lab.deviceLabOwnerId,'function');
assert.equal(typeof hyper.createHyperVWindowsClient,'function');assert.equal(typeof low.createHyperVWindowsClient,'function');
assert.equal(typeof lifecycle.reconcileHyperVVirtualMachine,'function');`;
    command(process.execPath, ["--input-type=module", "-e", script], home, env);
    await mcpSmoke(packageRoot);
}

async function main() {
    assert.equal(process.argv.length, 2, "Usage: node scripts/test-workspace-packages.mjs (through npm; no flags)");
    const npmCli = process.env.npm_execpath;
    assert(npmCli, "Run this verification through npm so npm_execpath is available");
    const temporary = mkdtempSync(join(tmpdir(), "ccc-workspace-package-")), env = isolatedEnvironment(temporary);
    let complete = false;
    try {
        const fixture = join(temporary, "checkout"), manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        mkdirSync(fixture);
        for (const file of new Set(["package.json", "README.md", "LICENSE", "packages", ...manifest.files])) {
            const source = join(root, file);
            if (!existsSync(source)) continue;
            const destination = join(fixture, file);
            mkdirSync(dirname(destination), { recursive: true });
            cpSync(source, destination, { recursive: true,
                filter: candidate => !relative(source, candidate).split(sep).includes("node_modules") });
        }
        const obsolete = join(fixture, "dist/x11-mcp"), preserved = join(fixture, "dist/package-smoke-sentinel.txt");
        mkdirSync(obsolete, { recursive: true }); writeFileSync(join(obsolete, "server.mjs"), "obsolete\n");
        writeFileSync(preserved, "unrelated generated output\n");
        assembleWorkspaceRuntime(fixture);
        assert(!existsSync(obsolete)); assert.equal(readFileSync(preserved, "utf8"), "unrelated generated output\n");
        rmSync(preserved);
        const report = JSON.parse(command(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary], fixture, env));
        assert.equal(report.length, 1);
        const filename = report[0].filename;
        assert(typeof filename === "string" && /^[A-Za-z0-9._-]+\.tgz$/.test(filename));
        assert(report[0].files.every(file => !/^(?:dist\/)?x11-mcp(?:\/|$)/.test(file.path)));
        command(process.platform === "win32" ? "tar.exe" : "tar", ["-xzf", join(temporary, filename), "-C", temporary], temporary, env);
        const packed = join(temporary, "package");
        await smoke(packed, temporary);
        const installed = join(temporary, "unix-install");
        const installer = pathToFileURL(join(packed, "scripts/install.js")).href;
        command(process.execPath, ["--input-type=module", "-e", `const {materializeUnixInstallPayload}=await import(${JSON.stringify(installer)});materializeUnixInstallPayload(${JSON.stringify(packed)},${JSON.stringify(installed)});`], temporary, env);
        await smoke(installed, temporary);
        complete = true;
        console.log("PASS package distribution: npm archive and Unix payload layout, CLI, public exports/assets, and MCP transport");
    } finally {
        if (complete) {
            try { rmSync(temporary, { recursive: true, force: true }); }
            catch (error) { console.error(`Retained package smoke directory: ${temporary}`); throw error; }
        } else console.error(`Retained package smoke directory: ${temporary}`);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
