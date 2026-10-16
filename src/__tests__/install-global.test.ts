import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Execute the actual installer in an owned copy. Only its Unix destination is
// redirected; no fixture can touch the machine's global CLI or User PATH.
function fixture(packaged = false) {
    const sandbox = mkdtempSync(join(tmpdir(), "ccc-install-"));
    fixtures.push(sandbox);
    const root = packaged ? join(sandbox, "node_modules", "ccc") : sandbox;
    mkdirSync(root, { recursive: true });
    const installDir = join(root, "owned-bin");
    const commands = join(root, "commands");
    mkdirSync(installDir);
    mkdirSync(commands);
    for (const dir of ["scripts", "scripts/install", "scripts/localhost-proxy", "dist", "src", "packages/device-lab/providers/state", "device-lab-mcp"]) mkdirSync(join(root, dir), { recursive: true });
    const source = readFileSync(resolve("scripts/install.js"), "utf8");
    expect(source).toContain('return "/usr/local/bin";');
    writeFileSync(join(root, "scripts/install.js"), source.replace('return "/usr/local/bin";', `return ${JSON.stringify(installDir)};`));
    for (const name of ["application.mjs", "domain.mjs", "ports.d.mts"]) {
        writeFileSync(join(root, "scripts/install", name), readFileSync(resolve("scripts/install", name)));
    }
    writeFileSync(join(root, "packages/device-lab/providers/state/windows-system-powershell.mjs"), 'export const canonicalWindowsPowerShellPath = () => null; export const hiddenWindowsPowerShellArgs = args => args;');
    for (const file of ["Dockerfile", "Containerfile", "package-lock.json", "tsconfig.json"]) writeFileSync(join(root, file), "{}");
    writeFileSync(join(root, "Dockerfile.distribution"), readFileSync(resolve("Dockerfile.distribution"), "utf8"));
    writeFileSync(join(root, "scripts/build-distribution-image.mjs"), readFileSync(resolve("scripts/build-distribution-image.mjs"), "utf8"));
    writeFileSync(join(root, "scripts/ccc-entrypoint.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(root, "scripts/localhost-proxy/go.mod"), "module fixture\ngo 1.22\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", version: "1.0.0", imports: { "#fixture": "./dist/index.js" }, scripts: { "source-only": "must not ship" } }));
    mkdirSync(join(root, "scripts/clipboard-shims"));
    for (const name of ["xclip", "xsel", "wl-paste", "wl-copy", "pbpaste"]) writeFileSync(join(root, "scripts/clipboard-shims", name), "fixture");
    writeFileSync(join(root, "dist/index.js"), 'console.log("fixture CLI");');
    const log = join(root, "calls");
    const trustedNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    for (const name of ["npm", "docker", "podman"]) {
        const script = `#!/bin/sh\nprintf '%s\\n' '${name} '"$*" >> "$FIXTURE_LOG"\n` + (name === "npm" ? 'exit "${FIXTURE_NPM_STATUS:-0}"\n' : `case "$1" in\n--version) exit "\${FIXTURE_PROBE_STATUS:-0}";;\ninspect) if [ "$FIXTURE_RUNTIME_DISAPPEAR" = 1 ]; then ${trustedNode} -e 'require("node:fs").unlinkSync(process.argv[1])' "$0"; fi; exit 1;;\nbuild) if [ "$FIXTURE_RUNTIME_SIGNAL" = 1 ]; then kill -TERM $$; fi; exit "\${FIXTURE_IMAGE_STATUS:-0}";;\nesac\n`);
        writeFileSync(join(commands, name), script);
        chmodSync(join(commands, name), 0o755);
    }
    const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [join(root, "scripts/install.js"), ...args], {
        encoding: "utf8", timeout: 10000,
        env: { ...process.env, CCC_RUNTIME: "", FIXTURE_LOG: log, ...env, PATH: commands },
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
        for (const file of ["Dockerfile.distribution", "scripts/build-distribution-image.mjs", "scripts/ccc-entrypoint.sh", "scripts/localhost-proxy/go.mod"]) {
            expect(readFileSync(join(f.installDir, "ccc-dist", file))).toEqual(readFileSync(join(f.root, file)));
        }
        const installedManifest = JSON.parse(readFileSync(join(f.installDir, "ccc-dist/package.json"), "utf8"));
        expect(installedManifest).toEqual({ type: "module", version: "1.0.0", imports: { "#fixture": "./dist/index.js" } });
        expect(readFileSync(join(f.installDir, "ccc-dist/package.json"), "utf8")).toBe(JSON.stringify(installedManifest, null, 2));
        expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe(`#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(join(f.installDir, "ccc-dist/dist/index.js")).href)});\n`);
        expect(statSync(join(f.installDir, "ccc")).mode & 0o777).toBe(0o755);
    });

    it.each([{ FIXTURE_IMAGE_STATUS: "7", reason: "exited with code 7" }, { FIXTURE_RUNTIME_SIGNAL: "1", reason: "terminated by SIGTERM" }, { FIXTURE_RUNTIME_DISAPPEAR: "1", reason: "ENOENT" }])("installs the CLI and reports image failure accurately: $reason", ({ reason, ...env }) => {
        const f = fixture();
        const result = f.run([], env);
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
        mkdirSync(join(f.installDir, "ccc-dist"));
        writeFileSync(join(f.installDir, "ccc-dist", "previous"), "existing payload");
        const result = f.run(["--skip-image"], { FIXTURE_NPM_STATUS: "3" });
        expect(result.status).not.toBe(0);
        expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe("existing CLI");
        expect(readFileSync(join(f.installDir, "ccc-dist", "previous"), "utf8")).toBe("existing payload");
        expect(existsSync(join(f.installDir, "ccc-dist", "dist"))).toBe(false);
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

    it("skips packaged postinstall and reports source build failure without installing", () => {
        const packaged = fixture(true);
        const artifactResult = packaged.run(["--postinstall"], { FIXTURE_NPM_STATUS: "3" });
        expect(artifactResult.status).toBe(0);
        expect(packaged.calls()).toBe("");
        expect(existsSync(join(packaged.installDir, "ccc"))).toBe(false);
        const source = fixture();
        const previousArtifact = readFileSync(join(source.root, "dist/index.js"));
        const sourceResult = source.run(["--postinstall"], { FIXTURE_NPM_STATUS: "3" });
        expect(sourceResult.status).toBe(1);
        expect(sourceResult.stderr).toContain("Command failed: npm run build");
        expect(sourceResult.stderr).not.toContain("Build skipped:");
        expect(sourceResult.stdout).not.toContain("CLI installed.");
        expect(sourceResult.stdout).not.toContain("Container image ready.");
        expect(sourceResult.stdout).not.toContain("Done!");
        expect(source.calls()).toBe("npm run build\n");
        expect(readFileSync(join(source.root, "dist/index.js"))).toEqual(previousArtifact);
        expect(existsSync(join(source.installDir, "ccc"))).toBe(false);
        expect(existsSync(join(source.installDir, "ccc-dist"))).toBe(false);
    });
});

// Simulate only the installer's credential decision. When requested, execute its
// actual Node bootstrap as the current test account, without switching accounts.
function sudoSourceBuildFixture(options: {
    platform?: "darwin" | "win32";
    uid?: number;
    sudoUid?: string;
    sudoGid?: string;
    executeBootstrap?: boolean;
    npmStatus?: number;
    operation?: "postinstall" | "install" | "import";
}) {
    const f = fixture();
    const capture = join(f.root, "source-build-calls.jsonl"), observation = join(f.root, "npm-environment.json");
    const loader = join(f.root, "source-build-loader.mjs"), platform = join(f.root, "source-build-platform.mjs");
    writeFileSync(join(f.installDir, "ccc"), "previous CLI");
    mkdirSync(join(f.installDir, "ccc-dist"));
    writeFileSync(join(f.installDir, "ccc-dist", "previous"), "previous payload");
    writeFileSync(join(f.root, "commands", "npm"), `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(process.env.FIXTURE_OBSERVATION,JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),uid:process.getuid(),gid:process.getgid(),home:process.env.HOME,overrides:Object.keys(process.env).filter(key=>/^npm_config_(cache|userconfig)$/i.test(key)),unrelated:process.env.npm_config_registry}));process.exit(Number(process.env.FIXTURE_NPM_STATUS||0));\n`);
    const childModule = `import {appendFileSync} from 'node:fs';
        import {execFileSync as actualExecFileSync} from 'node:child_process';
        function record(command,args,options){appendFileSync(process.env.FIXTURE_CAPTURE,JSON.stringify({command,args,options})+'\\n');}
        export function execSync(command,options){record(command,[],options);}
        export function execFileSync(command,args,options){
            record(command,args,options);
            if(process.env.FIXTURE_EXECUTE_BOOTSTRAP==='1'){
                const {uid,gid,...ordinaryOptions}=options;
                return actualExecFileSync(command,args,ordinaryOptions);
            }
        }
        export function spawnSync(){throw Error('source-build fixture must not dispatch a runtime');}
    `;
    writeFileSync(loader, `export function resolve(specifier,context,next){if(specifier==='child_process'&&context.parentURL?.endsWith('/scripts/install.js'))return {url:${JSON.stringify("data:text/javascript;base64," + Buffer.from(childModule).toString("base64"))},shortCircuit:true};return next(specifier,context);}`);
    writeFileSync(platform, `Object.defineProperty(process,'platform',{value:${JSON.stringify(options.platform || "darwin")}});Object.defineProperty(process,'getuid',{value:()=>${options.uid ?? 0}});`);
    const env = { ...process.env };
    delete env.SUDO_UID;
    delete env.SUDO_GID;
    if (options.sudoUid !== undefined) env.SUDO_UID = options.sudoUid;
    if (options.sudoGid !== undefined) env.SUDO_GID = options.sudoGid;
    Object.assign(env, {
        PATH: join(f.root, "commands"), HOME: join(f.root, "inherited-root-home"), CCC_RUNTIME: "",
        FIXTURE_CAPTURE: capture, FIXTURE_OBSERVATION: observation,
        FIXTURE_EXECUTE_BOOTSTRAP: options.executeBootstrap ? "1" : "0",
        FIXTURE_NPM_STATUS: String(options.npmStatus || 0),
        npm_config_cache: "/root/lower-cache", NPM_CONFIG_CACHE: "/root/upper-cache", Npm_Config_Cache: "/root/mixed-cache",
        npm_config_userconfig: "/root/lower-npmrc", NPM_CONFIG_USERCONFIG: "/root/upper-npmrc", NpM_cOnFiG_uSeRcOnFiG: "/root/mixed-npmrc",
        npm_config_registry: "https://registry.invalid/unchanged",
    });
    const invocation = options.operation === "import"
        ? ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(join(f.root, "scripts/install.js")).href)})`]
        : [join(f.root, "scripts/install.js"), options.operation === "install" ? "--skip-image" : "--postinstall"];
    const result = spawnSync(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "--import", pathToFileURL(platform).href, ...invocation], {
        encoding: "utf8", timeout: 10000, env,
    });
    const calls = existsSync(capture) ? readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    const observed = existsSync(observation) ? JSON.parse(readFileSync(observation, "utf8")) : null;
    return { ...f, result, calls, observed };
}

describe.skipIf(process.platform === "win32")("sudo source build ownership", () => {
    it.each([
        { sudoUid: "501", sudoGid: "20" },
        { sudoUid: "1", sudoGid: "0" },
        { sudoUid: "2147483647", sudoGid: "2147483647" },
    ])("dispatches the validated invoking identity as numeric child credentials: $sudoUid/$sudoGid", identity => {
        const f = sudoSourceBuildFixture(identity);
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]).toEqual({
            command: process.execPath,
            args: ["-e", expect.any(String)],
            options: { cwd: f.root, stdio: "inherit", uid: Number(identity.sudoUid), gid: Number(identity.sudoGid) },
        });
        expect(f.calls[0].args[1]).not.toBe("");
    });

    it.each([
        { sudoUid: "501" }, { sudoGid: "20" },
        ...["", " ", " 501", "501 ", "+501", "-1", "5.1", "1e3", "0x1f5", "0501", "0", "2147483648", "4294967294", "4294967295", "999999999999999999999"].map(sudoUid => ({ sudoUid, sudoGid: "20" })),
        ...["", " ", " 20", "20 ", "+20", "-1", "2.1", "2e1", "0x14", "020", "2147483648", "4294967294", "4294967295", "999999999999999999999"].map(sudoGid => ({ sudoUid: "501", sudoGid })),
    ])("refuses invalid or incomplete sudo identity before child or publication effects: $sudoUid/$sudoGid", identity => {
        const f = sudoSourceBuildFixture({ ...identity, operation: "install" });
        expect(f.result.status, f.result.stderr).not.toBe(0);
        expect(f.calls).toEqual([]);
        expect(f.observed).toBeNull();
        expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe("previous CLI");
        expect(readFileSync(join(f.installDir, "ccc-dist", "previous"), "utf8")).toBe("previous payload");
    });

    it.each([
        { uid: 501, sudoUid: "malformed", sudoGid: "-1" },
        { platform: "win32" as const, sudoUid: "malformed", sudoGid: "-1" },
        {},
    ])("keeps normal-user, Windows and non-sudo root builds unchanged: %j", options => {
        const f = sudoSourceBuildFixture(options);
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.calls).toEqual([{ command: "npm run build", args: [], options: { cwd: f.root, stdio: "inherit" } }]);
    });

    it("bootstraps actual npm with the OS account HOME and removes every inherited cache/userconfig spelling", () => {
        const f = sudoSourceBuildFixture({ sudoUid: "501", sudoGid: "20", executeBootstrap: true });
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].options).toMatchObject({ uid: 501, gid: 20 });
        expect(f.observed).toEqual({
            argv: ["run", "build"], cwd: f.root,
            uid: process.getuid!(), gid: process.getgid!(),
            home: userInfo().homedir, overrides: [], unrelated: "https://registry.invalid/unchanged",
        });
    });

    it("propagates a genuine npm child failure before replacing an existing installation", () => {
        const f = sudoSourceBuildFixture({ sudoUid: "501", sudoGid: "20", executeBootstrap: true, npmStatus: 7, operation: "install" });
        expect(f.result.status).not.toBe(0);
        expect(f.calls).toHaveLength(1);
        expect(f.observed?.argv).toEqual(["run", "build"]);
        expect(f.result.stderr).toContain("Command failed");
        expect(f.result.stdout).not.toContain("CLI installed.");
        expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe("previous CLI");
        expect(readFileSync(join(f.installDir, "ccc-dist", "previous"), "utf8")).toBe("previous payload");
    });

    it("does not validate sudo identity or launch a build when the native installer is only imported", () => {
        const f = sudoSourceBuildFixture({ sudoUid: "bad", sudoGid: "", operation: "import" });
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.calls).toEqual([]);
        expect(f.observed).toBeNull();
        expect(f.result.stdout).toBe("");
        expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe("previous CLI");
    });
});

// Load the actual native installer with owned destinations and child-process
// leaves. This runs on either host without touching global installation or PATH.
function nativeWindowsInstallerFixture(pathFailure: "read" | "write" | null = null, imageMode: string | null = null) {
    const f = fixture(), capture = join(f.root, "native-installer-calls.jsonl");
    const powershell = join(f.root, "trusted-powershell.exe");
    writeFileSync(join(f.root, "packages/device-lab/providers/state/windows-system-powershell.mjs"), `export const canonicalWindowsPowerShellPath = () => ${JSON.stringify(powershell)}; export const hiddenWindowsPowerShellArgs = args => args;`);
    const childModule = `import {appendFileSync} from 'node:fs';
        function record(command,args,options){
            const {env,...captured}=options;
            if(env)captured.env={__CCC_NEW_PATH:env.__CCC_NEW_PATH};
            appendFileSync(process.env.FIXTURE_CAPTURE,JSON.stringify({command,args,options:captured})+'\\n');
        }
        export function execSync(command,options){record(command,[],options);}
        export function execFileSync(command,args,options){
            record(command,args,options);
            const reading = args.at(-1).includes('GetEnvironmentVariable') && !args.at(-1).includes('SetEnvironmentVariable');
            if(process.env.FIXTURE_PATH_FAILURE === (reading ? 'read' : 'write'))throw Error(reading ? 'User PATH read denied' : 'User PATH write denied');
            return reading ? 'C:\\\\Tools\\r\\n' : '';
        }
        export function spawnSync(command,args,options){
            record(command,args,options);
            if(!process.env.FIXTURE_IMAGE_MODE)throw Error('skip-image must not dispatch a runtime');
            if(args[0]==='inspect')return {status:1,stdout:''};
            if(args[0]!=='build')throw Error('explicit runtime must not be probed');
            const mode=process.env.FIXTURE_IMAGE_MODE;
            if(mode==='throw')throw Error('native build throw');
            if(mode==='error')return {error:Error('native runtime error'),status:0,signal:'SIGTERM'};
            if(mode==='timeout')return {error:Error('native runtime timeout'),status:null,signal:'SIGTERM'};
            if(mode==='signal')return {status:null,signal:'SIGTERM'};
            if(mode==='null')return {status:null};
            if(mode==='nonzero')return {status:7};
            return {status:0};
        }
    `;
    const loader = join(f.root, "native-installer-loader.mjs"), platform = join(f.root, "native-installer-platform.mjs");
    writeFileSync(platform, 'Object.defineProperty(process,"platform",{value:"win32"});');
    writeFileSync(loader, `export function resolve(specifier,context,next){if(specifier==='child_process'&&context.parentURL?.endsWith('/scripts/install.js'))return {url:${JSON.stringify("data:text/javascript;base64," + Buffer.from(childModule).toString("base64"))},shortCircuit:true};return next(specifier,context);}`);
    const localAppData = join(f.root, "private-local-app-data"), installDirectory = join(localAppData, "Programs", "ccc");
    const result = spawnSync(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "--import", pathToFileURL(platform).href, join(f.root, "scripts/install.js"), ...(imageMode ? [] : ["--skip-image"])], {
        encoding: "utf8", timeout: 10000,
        env: { ...process.env, LOCALAPPDATA: localAppData, CCC_RUNTIME: imageMode ? "docker" : "", GITHUB_TOKEN: "", FIXTURE_CAPTURE: capture, FIXTURE_PATH_FAILURE: pathFailure || "", FIXTURE_IMAGE_MODE: imageMode || "" },
    });
    const calls = existsSync(capture) ? readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    return { ...f, result, calls, powershell, installDirectory };
}

describe("native Windows installer materialization and presentation", () => {
    it("writes exact Windows launcher bytes and persists only the owned User PATH value", () => {
        const f = nativeWindowsInstallerFixture();
        expect(f.result.status, f.result.stderr).toBe(0);
        const launcher = join(f.installDirectory, "ccc.cmd");
        expect(readFileSync(launcher, "utf8")).toBe(`@echo off\r\nnode "${join(f.root, "dist", "index.js")}" %*\r\n`);
        expect(f.calls[0]).toEqual({ command: "npm run build", args: [], options: { cwd: f.root, stdio: "inherit" } });
        expect(f.calls).toHaveLength(3);
        expect(f.calls[1]).toEqual({
            command: f.powershell,
            args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", '[Environment]::GetEnvironmentVariable("Path","User")'],
            options: { encoding: "utf8", windowsHide: true },
        });
        expect(f.calls[2].command).toBe(f.powershell);
        expect(f.calls[2].args).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", '[Environment]::SetEnvironmentVariable("Path", $env:__CCC_NEW_PATH, "User")']);
        expect(f.calls[2].options).toMatchObject({ encoding: "utf8", windowsHide: true, env: { __CCC_NEW_PATH: `C:\\Tools;${f.installDirectory}` } });
        expect(f.result.stdout).toContain(`Installed: ${launcher}`);
        expect(f.result.stdout).toContain("Added to User PATH. Open a new terminal to pick it up.");
        expect(f.result.stdout).toContain("CLI installed.");
        expect(f.result.stdout).toContain("Container image build skipped (--skip-image).");
    });

    it.each(["read", "write"] as const)("keeps a usable launcher and the native PowerShell remedy after a %s failure", failure => {
        const f = nativeWindowsInstallerFixture(failure);
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(readFileSync(join(f.installDirectory, "ccc.cmd"), "utf8")).toBe(`@echo off\r\nnode "${join(f.root, "dist", "index.js")}" %*\r\n`);
        expect(f.calls).toHaveLength(failure === "read" ? 2 : 3);
        expect(f.result.stdout).toContain(`PATH update skipped (${failure === "read" ? "READ_ERROR" : "WRITE_ERROR"}): User PATH ${failure} denied`);
        expect(f.result.stdout).toContain("Add it manually in PowerShell:");
        expect(f.result.stdout).toContain(`[Environment]::SetEnvironmentVariable("Path", ([Environment]::GetEnvironmentVariable("Path","User") + ";${f.installDirectory}"), "User")`);
        expect(f.result.stdout).toContain("CLI installed.");
        expect(f.result.stdout).not.toContain("Container image ready.");
    });

    it.each([
        ["error", "native runtime error"], ["timeout", "native runtime timeout"],
        ["signal", "docker build terminated by SIGTERM"], ["null", "docker build ended without an exit code"],
        ["nonzero", "docker build exited with code 7"], ["throw", "native build throw"],
    ])("classifies the actual %s image leaf as failed while publishing a usable CLI", (mode, reason) => {
        const f = nativeWindowsInstallerFixture(null, mode);
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(existsSync(join(f.installDirectory, "ccc.cmd"))).toBe(true);
        expect(f.result.stderr).toContain(`Failed to build image with docker: ${reason}`);
        expect(f.result.stdout).toContain("Container image build failed; CLI installation succeeded.");
        expect(f.result.stdout).not.toContain("Container image ready.");
        expect(f.result.stdout).not.toContain("Container image built.");
        const build = f.calls.find(call => call.command === "docker" && call.args[0] === "build");
        expect(build.args).toEqual(["build", "-t", "ccc", "--label", expect.stringMatching(/^content\.hash=[a-f0-9]{12}$/), "."]);
        expect(build.options).toEqual({ cwd: f.root, stdio: "inherit", timeout: 1200000 });
    });

    it("reports a settled zero-exit native image as ready after materializing the CLI", () => {
        const f = nativeWindowsInstallerFixture(null, "success");
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(readFileSync(join(f.installDirectory, "ccc.cmd"), "utf8")).toBe(`@echo off\r\nnode "${join(f.root, "dist", "index.js")}" %*\r\n`);
        expect(f.result.stderr).not.toContain("Failed to build image");
        expect(f.result.stdout).toContain("Container image built.");
        expect(f.result.stdout).toContain("Container image ready.");
        expect(f.result.stdout).not.toContain("CLI installation succeeded.");
    });
});


function distributionCommandFixture() {
    const f = fixture();
    const payload = join(f.root, "payload space ' $ & 雪");
    const caller = join(f.root, "unrelated-cwd");
    mkdirSync(join(payload, "scripts"), { recursive: true }); mkdirSync(caller);
    const script = join(payload, "scripts/build-distribution-image.mjs");
    writeFileSync(script, readFileSync(resolve("scripts/build-distribution-image.mjs"), "utf8"));
    writeFileSync(join(payload, "Dockerfile.distribution"), readFileSync(resolve("Dockerfile.distribution"), "utf8"));
    const capture = join(f.root, "runtime-capture.json");
    const module = `import {writeFileSync} from 'node:fs'; export function spawnSync(runtime,args,options){
        writeFileSync(process.env.FIXTURE_CAPTURE,JSON.stringify({runtime,args,options}));
        const mode=process.env.FIXTURE_BUILD_MODE;
        if(mode==='throw')throw Error('native throw');
        if(mode==='error')return {error:Object.assign(Error('missing runtime'),{code:'ENOENT'}),status:null};
        if(mode==='timeout')return {error:Object.assign(Error('timed out'),{code:'ETIMEDOUT'}),signal:'SIGTERM',status:null};
        if(mode==='signal')return {signal:'SIGTERM',status:null};
        if(mode==='null')return {status:null};
        if(mode==='nonzero')return {status:7};
        if(mode==='large')return {error:Error('x'.repeat(10000)),status:null};
        return {status:0};
    }`;
    const loader = join(f.root, "runtime-loader.mjs");
    writeFileSync(loader, `export function resolve(specifier,context,next){if(specifier==='node:child_process'&&context.parentURL?.endsWith('/scripts/build-distribution-image.mjs'))return {url:${JSON.stringify("data:text/javascript;base64," + Buffer.from(module).toString("base64"))},shortCircuit:true};return next(specifier,context);}`);
    const run = (args: string[], mode = "success", imported = false) => {
        rmSync(capture, { force: true });
        const invocation = imported ? ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(script).href)})`] : [script, ...args];
        const result = spawnSync(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, ...invocation], { encoding: "utf8", timeout: 5000, cwd: caller, env: { ...process.env, FIXTURE_CAPTURE: capture, FIXTURE_BUILD_MODE: mode } });
        return { ...result, capture: existsSync(capture) ? JSON.parse(readFileSync(capture, "utf8")) : null };
    };
    return { run, payload };
}

describe("explicit distribution image recovery command", () => {
    it.each(["docker", "podman"])("uses actual payload URL and separate %s argv without caller cwd", runtime => {
        const f = distributionCommandFixture(); const result = f.run(["--runtime", runtime]);
        expect(result.status, result.stderr).toBe(0);
        expect(result.capture).toEqual({ runtime, args: ["build", "-t", "ccc", "-f", join(f.payload, "Dockerfile.distribution"), f.payload], options: { cwd: f.payload, stdio: "inherit", shell: false, timeout: 1200000 } });
        expect(result.stdout).toContain("CCC distribution image built (tag: ccc).");
    });
    it.each([[], ["--runtime"], ["--runtime", "other"], ["--runtime", "docker", "--label", "extra"]].map(args => ({ args })))("rejects invalid required runtime arguments before effects: $args", ({ args }) => {
        const result = distributionCommandFixture().run(args); expect(result.status).toBe(1); expect(result.capture).toBeNull(); expect(result.stderr).toContain("Usage:");
    });
    it.each([
        ["error", "missing runtime"], ["timeout", "timed out after 20 minutes"], ["signal", "terminated by SIGTERM"], ["null", "ended without an exit code"], ["throw", "native throw"],
    ])("reports %s as failure without success", (mode, reason) => {
        const result = distributionCommandFixture().run(["--runtime", "docker"], mode); expect(result.status).toBe(1); expect(result.stderr).toContain(reason); expect(result.stdout).not.toContain("image built");
    });
    it("propagates exact positive runtime status and bounds wrapper diagnostics", () => {
        const f = distributionCommandFixture(); const failed = f.run(["--runtime", "podman"], "nonzero"); expect(failed.status).toBe(7); expect(failed.stderr).toContain("exited with code 7");
        const large = f.run(["--runtime", "docker"], "large"); const diagnostic = large.stderr.split("\n").find(line => line.startsWith("CCC distribution image build failed:")); expect(diagnostic?.length).toBeLessThan(2100); expect(large.status).toBe(1);
    });
    it("never builds on actual module import", () => {
        const result = distributionCommandFixture().run([], "success", true); expect(result.status, result.stderr).toBe(0); expect(result.capture).toBeNull(); expect(result.stdout).toBe("");
    });
});
