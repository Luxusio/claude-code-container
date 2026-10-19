import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Execute the actual installer in an owned copy. Only its Unix destination is
// redirected; no fixture can touch the machine's global CLI or User PATH.
function fixture(packaged = false, directoryName?: string) {
    const sandbox = mkdtempSync(join(tmpdir(), "ccc-install-"));
    fixtures.push(sandbox);
    const root = packaged ? join(sandbox, "node_modules", "ccc") : directoryName ? join(sandbox, directoryName) : sandbox;
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
    const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}, nodeArgs: string[] = []) => spawnSync(process.execPath, [...nodeArgs, join(root, "scripts/install.js"), ...args], {
        encoding: "utf8", timeout: 10000,
        env: { ...process.env, CCC_RUNTIME: "", FIXTURE_LOG: log, ...env, PATH: commands },
    });
    const calls = () => existsSync(log) ? readFileSync(log, "utf8") : "";
    return { root, installDir, run, calls };
}

type PublicationFault = "copy" | "package" | "launcher-write" | "launcher-chmod" | "backup-payload" | "publish-payload" | "publish-launcher" | "restore-payload" | "hold-copy";

// Patch only synchronous filesystem calls whose destination is this fixture's
// private install directory. The production installer still owns every step.
function publicationPreload(f: ReturnType<typeof fixture>) {
    const preload = join(f.root, "publication-fault.mjs"), capture = join(f.root, "publication-calls.jsonl");
    const ready = join(f.root, "publication-ready"), release = join(f.root, "publication-release");
    writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {basename,resolve,sep} from 'node:path';
        const owned=${JSON.stringify(f.installDir)},payload=resolve(owned,'ccc-dist'),launcher=resolve(owned,'ccc');
        const capture=${JSON.stringify(capture)},ready=${JSON.stringify(ready)},release=${JSON.stringify(release)};
        const native={cp:fs.cpSync,write:fs.writeFileSync,chmod:fs.chmodSync,rename:fs.renameSync,rm:fs.rmSync,mkdtemp:fs.mkdtempSync};
        const mode=process.env.FIXTURE_PUBLICATION_FAULT;let backup,preparedLauncher,held=false;
        const inside=path=>typeof path==='string'&&(resolve(path)===owned||resolve(path).startsWith(owned+sep));
        function record(event){fs.appendFileSync(capture,JSON.stringify(event)+'\\n');}
        function fail(point){record({kind:'fault',point});throw Error('fixture '+point+' denied');}
        fs.mkdtempSync=(prefix,...args)=>{if(inside(prefix))record({kind:'stage',path:String(prefix)});return native.mkdtemp(prefix,...args);};
        fs.cpSync=(source,target,...args)=>{
            if(inside(target)&&basename(String(source))==='Dockerfile'){
                if(mode==='copy')fail('copy');
                if(mode==='hold-copy'&&!held){held=true;native.write(ready,'ready');const deadline=Date.now()+8000;
                    while(!fs.existsSync(release)){if(Date.now()>deadline)throw Error('fixture publication release timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
            }return native.cp(source,target,...args);
        };
        fs.writeFileSync=(path,data,...args)=>{
            if(inside(path)&&basename(String(path))==='package.json'&&mode==='package')fail('package');
            if(inside(path)&&String(data).startsWith('#!/bin/sh\\nexec ')){
                preparedLauncher=resolve(path);if(mode==='launcher-write')fail('launcher-write');
            }
            return native.write(path,data,...args);
        };
        fs.chmodSync=(path,...args)=>{if(resolve(path)===preparedLauncher&&mode==='launcher-chmod')fail('launcher-chmod');return native.chmod(path,...args);};
        fs.renameSync=(source,target)=>{
            if(inside(source)||inside(target)){
                record({kind:'rename',source:String(source),target:String(target)});
                if(resolve(source)===payload&&!backup){backup=String(target);if(mode==='backup-payload')fail('backup-payload');}
                if(resolve(target)===payload){
                    if(mode==='publish-payload'&&String(source)!==backup)fail('publish-payload');
                    if(mode==='restore-payload'&&String(source)===backup)fail('restore-payload');
                }
                if(resolve(target)===launcher&&(mode==='publish-launcher'||mode==='restore-payload'))fail('publish-launcher');
            }return native.rename(source,target);
        };
        fs.rmSync=(path,...args)=>{if(inside(path))record({kind:'remove',path:String(path)});return native.rm(path,...args);};
        syncBuiltinESMExports();
    `);
    const records = () => existsSync(capture) ? readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string; point?: string; source?: string; target?: string; path?: string }) : [];
    return { preload, capture, ready, release, records };
}

function previousRunnableInstall(kind: "file" | "symlink" = "file") {
    const f = fixture();
    writeFileSync(join(f.root, "dist/index.js"), 'process.stdout.write("previous runnable CLI\\n");');
    const installed = f.run(["--skip-image"]);
    expect(installed.status, installed.stderr).toBe(0);
    const launcher = join(f.installDir, "ccc"), payload = join(f.installDir, "ccc-dist");
    const legacy = join(f.root, "legacy-launcher");
    if (kind === "symlink") {
        renameSync(launcher, legacy);
        symlinkSync("../legacy-launcher", launcher);
    }
    const oldLauncher = privateEntry(launcher), oldPayload = privateEntry(payload);
    const oldEntry = privateEntry(join(payload, "dist/index.js"));
    const oldLegacy = kind === "symlink" ? privateEntry(legacy) : undefined;
    writeFileSync(join(f.root, "dist/index.js"), 'process.stdout.write("replacement runnable CLI\\n");');
    const expectOld = () => {
        expect(privateEntry(launcher)).toEqual(oldLauncher);
        expect(privateEntry(payload)).toEqual(oldPayload);
        expect(privateEntry(join(payload, "dist/index.js"))).toEqual(oldEntry);
        if (oldLegacy) expect(privateEntry(legacy)).toEqual(oldLegacy);
        const cli = spawnSync(launcher, [], { encoding: "utf8", env: { ...process.env, PATH: "" } });
        expect(cli.status, cli.stderr).toBe(0);
        expect(cli.stdout).toBe("previous runnable CLI\n");
    };
    return { ...f, launcher, payload, oldLauncher, oldPayload, oldEntry, expectOld };
}

describe.skipIf(process.platform === "win32")("failure-preserving native Unix publication", () => {
    it("creates the missing destination parent on a first private install", () => {
        const f = fixture();
        rmSync(f.installDir, { recursive: true });
        const installed = f.run(["--skip-image"]);
        expect(installed.status, installed.stderr).toBe(0);
        const cli = spawnSync(join(f.installDir, "ccc"), [], { encoding: "utf8", env: { ...process.env, PATH: "" } });
        expect(cli.status, cli.stderr).toBe(0);
        expect(cli.stdout).toContain("fixture CLI");
        expect(readdirSync(f.installDir).sort()).toEqual(["ccc", "ccc-dist"]);
    });

    it.each((["copy", "package", "launcher-write", "launcher-chmod", "backup-payload", "publish-payload", "publish-launcher"] as const)
        .flatMap(point => (["file", "symlink"] as const).map(kind => ({ point, kind }))))("keeps the previous $kind launcher and executable payload after $point fails", ({ point, kind }) => {
        const f = previousRunnableInstall(kind), fault = publicationPreload(f);
        const result = f.run(["--skip-image"], { FIXTURE_PUBLICATION_FAULT: point satisfies PublicationFault }, ["--import", pathToFileURL(fault.preload).href]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`fixture ${point} denied`);
        expect(fault.records()).toContainEqual({ kind: "fault", point });
        expect(result.stdout).not.toContain("CLI installed.");
        expect(result.stdout).not.toContain("Installed:");
        f.expectOld();
        expect(fault.records()).not.toContainEqual({ kind: "remove", path: f.payload });
        expect(readdirSync(f.installDir).sort()).toEqual(["ccc", "ccc-dist"]);
    });

    it("publishes a complete replacement with the stable payload path and executable launcher", () => {
        const f = previousRunnableInstall("symlink");
        const result = f.run(["--skip-image"]);
        expect(result.status, result.stderr).toBe(0);
        expect(lstatSync(f.launcher).isFile()).toBe(true);
        expect(statSync(f.launcher).mode & 0o777).toBe(0o755);
        const cli = spawnSync(f.launcher, [], { encoding: "utf8", env: { ...process.env, PATH: "" } });
        expect(cli.status, cli.stderr).toBe(0);
        expect(cli.stdout).toBe("replacement runnable CLI\n");
        expect(readFileSync(f.launcher, "utf8")).toContain(join(f.payload, "dist/index.js"));
        expect(readdirSync(f.installDir).sort()).toEqual(["ccc", "ccc-dist"]);
    });

    it("retains the exact old backup and reports its path when restoration fails", () => {
        const f = previousRunnableInstall(), fault = publicationPreload(f);
        const result = f.run(["--skip-image"], { FIXTURE_PUBLICATION_FAULT: "restore-payload" satisfies PublicationFault }, ["--import", pathToFileURL(fault.preload).href]);
        expect(result.status).not.toBe(0);
        const records = fault.records();
        const backup = records.find(event => event.kind === "rename" && event.source === f.payload)?.target;
        expect(backup).toBeTruthy();
        expect(privateEntry(backup!)).toEqual(f.oldPayload);
        expect(privateEntry(join(backup!, "dist/index.js"))).toEqual(f.oldEntry);
        expect(result.stderr).toContain(backup!);
        expect(result.stderr).toContain("fixture publish-launcher denied");
        expect(result.stderr).toContain("fixture restore-payload denied");
        expect(result.stdout).not.toContain("CLI installed.");
        expect(records.some(event => event.kind === "remove" && (event.path === backup || event.path === dirname(backup!)))).toBe(false);
        expect(records).not.toContainEqual({ kind: "remove", path: f.payload });
    });

    it.each(["--skip-image", "--uninstall"])("refuses %s while a cooperating installer holds the destination guard", async operation => {
        const f = previousRunnableInstall(), fault = publicationPreload(f);
        const child = spawn(process.execPath, ["--import", pathToFileURL(fault.preload).href, join(f.root, "scripts/install.js"), "--skip-image"], {
            env: { ...process.env, PATH: join(f.root, "commands"), CCC_RUNTIME: "", FIXTURE_LOG: join(f.root, "calls"), FIXTURE_PUBLICATION_FAULT: "hold-copy" satisfies PublicationFault },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += String(chunk); });
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        const exited = new Promise<number | null>((resolveExit, reject) => {
            child.once("error", reject); child.once("close", code => { resolveExit(code); });
        });
        try {
            const deadline = Date.now() + 5000;
            while (!existsSync(fault.ready)) {
                if (child.exitCode !== null || Date.now() > deadline) throw new Error(`installer did not hold publication: ${stderr}`);
                await new Promise(resolveWait => { setTimeout(resolveWait, 10); });
            }
            const started = Date.now(), rejected = f.run([operation]);
            expect(rejected.status).not.toBe(0);
            expect(Date.now() - started).toBeLessThan(3000);
            expect(rejected.stderr).toContain(`${f.payload}.install-lock`);
            expect(rejected.stdout).not.toContain("CLI installed.");
            expect(rejected.stdout).not.toContain("Removed:");
            f.expectOld();
            expect(existsSync(`${f.payload}.install-lock`)).toBe(true);
        } finally {
            writeFileSync(fault.release, "release");
            expect(await exited, stderr).toBe(0);
        }
        expect(stdout).toContain("CLI installed.");
        expect(existsSync(`${f.payload}.install-lock`)).toBe(false);
        expect(readdirSync(f.installDir).sort()).toEqual(["ccc", "ccc-dist"]);
    });

    it("refuses an existing guard without reclaiming or changing it", () => {
        const f = previousRunnableInstall(), guard = `${f.payload}.install-lock`;
        mkdirSync(guard); writeFileSync(join(guard, "operator-sentinel"), "preserve this guard");
        const before = privateEntry(guard);
        for (const args of [["--skip-image"], ["--uninstall"]]) {
            const result = f.run(args);
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain(guard);
            f.expectOld();
            expect(privateEntry(guard)).toEqual(before);
            expect(readFileSync(join(guard, "operator-sentinel"), "utf8")).toBe("preserve this guard");
        }
    });

    it.each(["file", "symlink", "dangling-symlink"] as const)("refuses an unsafe %s payload without touching its target or launcher", kind => {
        const f = fixture(), payload = join(f.installDir, "ccc-dist"), external = join(f.root, "external-payload");
        writeFileSync(join(f.installDir, "ccc"), "previous launcher bytes");
        mkdirSync(external); writeFileSync(join(external, "sentinel"), "external bytes");
        if (kind === "file") writeFileSync(payload, "foreign payload file");
        else symlinkSync(kind === "symlink" ? external : join(f.root, "missing-target"), payload);
        const before = privateEntry(payload), launcher = privateEntry(join(f.installDir, "ccc"));
        for (const args of [["--skip-image"], ["--uninstall"]]) {
            const result = f.run(args);
            expect(result.status).not.toBe(0);
            expect(result.stdout).not.toContain("CLI installed.");
            expect(privateEntry(payload)).toEqual(before);
            expect(privateEntry(join(f.installDir, "ccc"))).toEqual(launcher);
            expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("external bytes");
        }
    });

    it("refuses a directory at the launcher path before replacing the old payload", () => {
        const f = previousRunnableInstall();
        rmSync(f.launcher); mkdirSync(f.launcher);
        writeFileSync(join(f.launcher, "sentinel"), "preserve launcher directory");
        const before = privateEntry(f.launcher);
        for (const args of [["--skip-image"], ["--uninstall"]]) {
            const result = f.run(args);
            expect(result.status).not.toBe(0);
            expect(privateEntry(f.launcher)).toEqual(before);
            expect(readFileSync(join(f.launcher, "sentinel"), "utf8")).toBe("preserve launcher directory");
            expect(privateEntry(f.payload)).toEqual(f.oldPayload);
            expect(privateEntry(join(f.payload, "dist/index.js"))).toEqual(f.oldEntry);
        }
    });

    it("refuses unsafe public materialization paths before changing source bytes", () => {
        const f = fixture(), script = pathToFileURL(join(f.root, "scripts/install.js")).href;
        const boundary = join(f.root, "refuse-foreign-writes.mjs");
        writeFileSync(boundary, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {resolve,sep} from 'node:path';
            const root=${JSON.stringify(f.root)};const check=path=>{const target=resolve(String(path));if(target!==root&&!target.startsWith(root+sep))throw Error('fixture refused foreign filesystem mutation');};
            for(const name of ['mkdirSync','mkdtempSync','rmdirSync','rmSync','unlinkSync','writeFileSync','chmodSync']){
                const native=fs[name];fs[name]=(path,...args)=>{check(path);return native(path,...args);};
            }
            const copy=fs.cpSync;fs.cpSync=(source,target,...args)=>{check(target);return copy(source,target,...args);};
            const rename=fs.renameSync;fs.renameSync=(source,target)=>{check(source);check(target);return rename(source,target);};syncBuiltinESMExports();
        `);
        const sourceBefore = privateEntry(join(f.root, "dist/index.js"));
        const alias = join(f.root, "source-alias"); symlinkSync(f.root, alias);
        const targets = ["/", f.root, dirname(f.root), join(f.root, "dist/nested"), join(f.root, "scripts/nested"), join(alias, "dist")];
        for (const target of targets) {
            const result = spawnSync(process.execPath, ["--import", pathToFileURL(boundary).href, "--input-type=module", "-e", `const m=await import(${JSON.stringify(script)});m.materializeUnixInstallPayload(${JSON.stringify(f.root)},${JSON.stringify(target)});`], { encoding: "utf8", timeout: 5000 });
            expect(result.status, target).not.toBe(0);
            expect(result.stderr).toContain("Refusing unsafe global install payload target");
            expect(privateEntry(join(f.root, "dist/index.js"))).toEqual(sourceBefore);
            expect(f.calls()).toBe("");
        }
        expect(readdirSync(f.installDir)).toEqual([]);
    });

    it.each(["dist", "Dockerfile", "package.json"] as const)("refuses materialization when source %s resolves inside the destination", input => {
        const f = fixture(false, "source"), owned = join(dirname(f.root), "owned"), payload = join(owned, "ccc-dist");
        const generated = join(payload, "generated"), sourceLink = join(f.root, input);
        mkdirSync(payload, { recursive: true });
        if (input === "dist") {
            mkdirSync(generated);
            writeFileSync(join(generated, "index.js"), "linked source bytes must survive\n");
            chmodSync(generated, 0o750); chmodSync(join(generated, "index.js"), 0o640);
        } else {
            writeFileSync(generated, readFileSync(sourceLink));
            chmodSync(generated, 0o640);
        }
        writeFileSync(join(payload, "destination-marker"), "previous destination bytes\n");
        chmodSync(join(payload, "destination-marker"), 0o600);
        rmSync(sourceLink, { recursive: true }); symlinkSync(generated, sourceLink);
        const preserved = [sourceLink, generated, ...(input === "dist" ? [join(generated, "index.js")] : []), payload, join(payload, "destination-marker")];
        const before = preserved.map(path => privateEntry(path));
        const observation = publicationPreload({ ...f, installDir: owned });
        const script = pathToFileURL(join(f.root, "scripts/install.js")).href;
        const result = spawnSync(process.execPath, ["--import", pathToFileURL(observation.preload).href, "--input-type=module", "-e", `const m=await import(${JSON.stringify(script)});m.materializeUnixInstallPayload(${JSON.stringify(f.root)},${JSON.stringify(payload)});`], {
            encoding: "utf8", timeout: 5000,
            env: { ...process.env, PATH: join(f.root, "commands"), FIXTURE_PUBLICATION_FAULT: "" },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Refusing unsafe global install payload target");
        expect(observation.records()).toEqual([]);
        expect(preserved.map(path => privateEntry(path))).toEqual(before);
        expect(readdirSync(owned)).toEqual(["ccc-dist"]);
        expect(readdirSync(payload).sort()).toEqual(["destination-marker", "generated"]);
        expect(f.calls()).toBe("");
    });
});

// These process fixtures use POSIX executable shims and exercise Unix payloads.
describe.skipIf(process.platform === "win32")("source global installer", () => {
    it("builds and installs a runnable private CLI with zero runtime calls using --skip-image", () => {
        const f = fixture();
        const result = f.run(["--skip-image"], { CCC_RUNTIME: "docker" });
        expect(result.status).toBe(0);
        expect(f.calls()).toBe("npm run build\n");
        expect(result.stdout).toContain("CLI installed.");
        expect(result.stdout).toContain("skipped (--skip-image)");
        const cli = spawnSync(join(f.installDir, "ccc"), [], { encoding: "utf8", env: { ...process.env, PATH: "" } });
        expect(cli.status).toBe(0);
        expect(cli.stdout).toContain("fixture CLI");
        expect(existsSync(join(f.installDir, "ccc-dist/dist/index.js"))).toBe(true);
        for (const file of ["Dockerfile.distribution", "scripts/build-distribution-image.mjs", "scripts/ccc-entrypoint.sh", "scripts/localhost-proxy/go.mod"]) {
            expect(readFileSync(join(f.installDir, "ccc-dist", file))).toEqual(readFileSync(join(f.root, file)));
        }
        const installedManifest = JSON.parse(readFileSync(join(f.installDir, "ccc-dist/package.json"), "utf8"));
        expect(installedManifest).toEqual({ type: "module", version: "1.0.0", imports: { "#fixture": "./dist/index.js" } });
        expect(readFileSync(join(f.installDir, "ccc-dist/package.json"), "utf8")).toBe(JSON.stringify(installedManifest, null, 2));
        expect(statSync(join(f.installDir, "ccc")).mode & 0o777).toBe(0o755);
    });

    it("pins the installer Node and preserves literal arguments, streams and exit status with quoted paths", () => {
        const f = fixture(false, "payload ' $HOME $(touch injected-dollar) `touch injected-backtick`");
        const pinnedNode = join(f.root, "node ' $HOME $(touch injected-node-dollar) `touch injected-node-backtick`");
        symlinkSync(process.execPath, pinnedNode);
        const preload = join(f.root, "installer-node.mjs");
        writeFileSync(preload, `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(pinnedNode)} });`);
        writeFileSync(join(f.root, "dist/index.js"), 'import { readFileSync } from "node:fs";process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:readFileSync(0,"utf8")}));process.stderr.write("fixture stderr\\n");process.exit(37);');
        const installed = f.run(["--skip-image"], {}, ["--import", pathToFileURL(preload).href]);
        expect(installed.status, installed.stderr).toBe(0);
        const trap = join(f.root, "path-node-called");
        const fakeNode = join(f.root, "commands/node");
        writeFileSync(fakeNode, '#!/bin/sh\nprintf called > "$FIXTURE_NODE_TRAP"\nexit 97\n');
        chmodSync(fakeNode, 0o755);
        const args = ["", "two words", "'quoted'", "$HOME", "$(touch injected-arg-dollar)", "`touch injected-arg-backtick`", "한글🙂", "--flag=value", "line\nbreak"];
        const input = "stdin: 한글🙂\nsecond line\n";
        const cli = spawnSync(join(f.installDir, "ccc"), args, {
            cwd: f.root, encoding: "utf8", input,
            env: { ...process.env, PATH: join(f.root, "commands"), FIXTURE_NODE_TRAP: trap },
        });
        expect(cli.error).toBeUndefined();
        expect(cli.status, cli.stderr).toBe(37);
        expect(cli.signal).toBeNull();
        expect(JSON.parse(cli.stdout)).toEqual({ argv: args, stdin: input });
        expect(cli.stderr).toBe("fixture stderr\n");
        expect(existsSync(trap)).toBe(false);
        for (const marker of ["injected-dollar", "injected-backtick", "injected-node-dollar", "injected-node-backtick", "injected-arg-dollar", "injected-arg-backtick"]) {
            expect(existsSync(join(f.root, marker)), marker).toBe(false);
        }
    });

    it("keeps the launcher's PID and lets signals reach the running CLI", async () => {
        const f = fixture();
        writeFileSync(join(f.root, "dist/index.js"), 'process.stdout.write(JSON.stringify({pid:process.pid})+"\\n");setInterval(()=>{},1000);');
        const installed = f.run(["--skip-image"]);
        expect(installed.status, installed.stderr).toBe(0);
        const child = spawn(join(f.installDir, "ccc"), [], { env: { ...process.env, PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => { resolveExit({ code, signal }); });
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const ready = new Promise<number>((resolveReady, reject) => {
                child.stdout.on("data", chunk => {
                    stdout += String(chunk);
                    if (stdout.includes("\n")) {
                        try { resolveReady((JSON.parse(stdout.trim()) as { pid: number }).pid); } catch (cause) { reject(cause); }
                    }
                });
                child.once("error", reject);
                child.once("close", () => { reject(new Error(`CLI exited before ready: ${stderr}`)); });
            });
            const deadline = new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => { reject(new Error("installed CLI did not become ready or stop")); }, 5000);
            });
            expect(await Promise.race([ready, deadline])).toBe(child.pid);
            expect(child.kill("SIGTERM")).toBe(true);
            expect(await Promise.race([exited, deadline])).toEqual({ code: null, signal: "SIGTERM" });
            expect(stderr).toBe("");
        } finally {
            if (timeout) clearTimeout(timeout);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await exited;
        }
    });

    it("fails without falling back to PATH when the installed Node executable is removed", () => {
        const f = fixture();
        const pinnedNode = join(f.root, "selected-node");
        symlinkSync(process.execPath, pinnedNode);
        const preload = join(f.root, "installer-node.mjs");
        writeFileSync(preload, `Object.defineProperty(process, "execPath", { value: ${JSON.stringify(pinnedNode)} });`);
        const installed = f.run(["--skip-image"], {}, ["--import", pathToFileURL(preload).href]);
        expect(installed.status, installed.stderr).toBe(0);
        rmSync(pinnedNode);
        const trap = join(f.root, "path-node-called");
        writeFileSync(join(f.root, "commands/node"), '#!/bin/sh\nprintf called > "$FIXTURE_NODE_TRAP"\nexit 97\n');
        chmodSync(join(f.root, "commands/node"), 0o755);
        const cli = spawnSync(join(f.installDir, "ccc"), [], {
            encoding: "utf8", env: { ...process.env, PATH: join(f.root, "commands"), FIXTURE_NODE_TRAP: trap },
        });
        expect(cli.error).toBeUndefined();
        expect(cli.status).toBe(127);
        expect(cli.stderr).toContain(pinnedNode);
        expect(cli.stdout).toBe("");
        expect(existsSync(trap)).toBe(false);
        expect(existsSync(join(f.installDir, "ccc-dist/dist/index.js"))).toBe(true);
    });

    it.each(["16.20.2", "20.18.9"].flatMap(version => ["--skip-image", "--postinstall"].map(operation => ({ version, operation }))))("refuses Node $version before build or publication for $operation", ({ version, operation }) => {
        const f = fixture();
        writeFileSync(join(f.installDir, "ccc"), "previous CLI");
        mkdirSync(join(f.installDir, "ccc-dist"));
        writeFileSync(join(f.installDir, "ccc-dist/previous"), "previous payload");
        const previousSource = readFileSync(join(f.root, "dist/index.js"));
        const preload = join(f.root, "node-version.mjs");
        writeFileSync(preload, `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`);
        const result = f.run([operation], {}, ["--import", pathToFileURL(preload).href]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(version);
        expect(result.stderr).toContain("20.19.0");
        expect(result.stdout).not.toContain("Building...");
        expect(f.calls()).toBe("");
        expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe("previous CLI");
        expect(readFileSync(join(f.installDir, "ccc-dist/previous"), "utf8")).toBe("previous payload");
        expect(readFileSync(join(f.root, "dist/index.js"))).toEqual(previousSource);
        expect(existsSync(join(f.installDir, "ccc-dist/dist"))).toBe(false);
    });

    it("accepts the declared Node 20.19.0 installer boundary", () => {
        const f = fixture();
        const preload = join(f.root, "node-version.mjs");
        writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "20.19.0" });');
        const result = f.run(["--skip-image"], {}, ["--import", pathToFileURL(preload).href]);
        expect(result.status, result.stderr).toBe(0);
        expect(f.calls()).toBe("npm run build\n");
        const cli = spawnSync(join(f.installDir, "ccc"), [], { encoding: "utf8", env: { ...process.env, PATH: "" } });
        expect(cli.status, cli.stderr).toBe(0);
        expect(cli.stdout).toContain("fixture CLI");
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

// Simulate native credential/ownership leaves. When requested, execute the actual
// Node bootstrap as the current test account, without switching accounts.
function sudoSourceBuildFixture(options: {
    platform?: "darwin" | "win32";
    uid?: number;
    sudoUid?: string;
    sudoGid?: string;
    executeBootstrap?: boolean;
    npmStatus?: number;
    operation?: "postinstall" | "install" | "import";
    ownership?: Record<string, number>;
    setup?: (root: string) => void;
    failRepairAt?: string;
    failRepairAfter?: number;
    replaceAfterRepair?: { paths: string[]; kind: "symlink" | "file" };
}) {
    const f = fixture();
    const capture = join(f.root, "source-build-calls.jsonl"), observation = join(f.root, "npm-environment.json");
    const ownership = join(f.root, "source-build-ownership.json"), recovery = join(f.root, "source-build-recovery.jsonl");
    const loader = join(f.root, "source-build-loader.mjs"), platform = join(f.root, "source-build-platform.mjs");
    writeFileSync(join(f.installDir, "ccc"), "previous CLI");
    mkdirSync(join(f.installDir, "ccc-dist"));
    writeFileSync(join(f.installDir, "ccc-dist", "previous"), "previous payload");
    options.setup?.(f.root);
    writeFileSync(ownership, JSON.stringify(Object.fromEntries(Object.entries(options.ownership || {}).map(([path, uid]) => [resolve(f.root, path), { uid, gid: uid === 0 ? 0 : 20 }]))));
    writeFileSync(join(f.root, "commands", "npm"), `#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(process.env.FIXTURE_OBSERVATION,JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),uid:process.getuid(),gid:process.getgid(),home:process.env.HOME,overrides:Object.keys(process.env).filter(key=>/^npm_config_(cache|userconfig)$/i.test(key)),unrelated:process.env.npm_config_registry}));process.exit(Number(process.env.FIXTURE_NPM_STATUS||0));\n`);
    const childModule = `import {appendFileSync} from 'node:fs';
        import {execFileSync as actualExecFileSync} from 'node:child_process';
        function record(command,args,options){appendFileSync(process.env.FIXTURE_CAPTURE,JSON.stringify({command,args,options})+'\\n');appendFileSync(process.env.FIXTURE_RECOVERY,JSON.stringify({kind:'build'})+'\\n');}
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
    // Real private files, modes, links and inode metadata pass through unchanged.
    // Only ownership and lchown are simulated; this does not certify macOS sudo.
    const filesystemModule = `export {existsSync,mkdirSync,mkdtempSync,realpathSync,rmdirSync,renameSync,unlinkSync,writeFileSync,chmodSync,cpSync,rmSync,readFileSync,readdirSync} from 'node:fs';
        import * as fs from 'node:fs';
        import {resolve} from 'node:path';
        const statePath=process.env.FIXTURE_OWNERSHIP;
        function owners(){return JSON.parse(fs.readFileSync(statePath,'utf8'));}
        export function lstatSync(path,...options){
            const stat=fs.lstatSync(path,...options);
            return Object.assign(stat,owners()[resolve(path)]||{uid:501,gid:20});
        }
        let repairCount=0;
        export function lchownSync(path,uid,gid){
            const target=resolve(path);
            fs.appendFileSync(process.env.FIXTURE_RECOVERY,JSON.stringify({kind:'repair',path:target,uid,gid})+'\\n');
            if(target===process.env.FIXTURE_FAIL_REPAIR||++repairCount===Number(process.env.FIXTURE_FAIL_REPAIR_AFTER))throw Object.assign(Error('fixture ownership denied'),{code:'EPERM'});
            const state=owners();state[target]={uid,gid};fs.writeFileSync(statePath,JSON.stringify(state));
            if(repairCount===1&&process.env.FIXTURE_REPLACE_AFTER_REPAIR){
                const replacement=JSON.parse(process.env.FIXTURE_REPLACE_AFTER_REPAIR);
                const changed=replacement.paths.find(path=>path!==target);
                fs.renameSync(changed,changed+'.original');
                if(replacement.kind==='symlink')fs.symlinkSync(process.env.FIXTURE_REPLACEMENT_TARGET,changed);
                else fs.writeFileSync(changed,'replacement inode');
            }
        }
    `;
    writeFileSync(loader, `export function resolve(specifier,context,next){if(context.parentURL?.endsWith('/scripts/install.js')){if(specifier==='child_process')return {url:${JSON.stringify("data:text/javascript;base64," + Buffer.from(childModule).toString("base64"))},shortCircuit:true};if(specifier==='fs')return {url:${JSON.stringify("data:text/javascript;base64," + Buffer.from(filesystemModule).toString("base64"))},shortCircuit:true};}return next(specifier,context);}`);
    writeFileSync(platform, `Object.defineProperty(process,'platform',{value:${JSON.stringify(options.platform || "darwin")}});Object.defineProperty(process,'getuid',{value:()=>${options.uid ?? 0}});`);
    const env = { ...process.env };
    delete env.SUDO_UID;
    delete env.SUDO_GID;
    if (options.sudoUid !== undefined) env.SUDO_UID = options.sudoUid;
    if (options.sudoGid !== undefined) env.SUDO_GID = options.sudoGid;
    Object.assign(env, {
        PATH: join(f.root, "commands"), HOME: join(f.root, "inherited-root-home"), CCC_RUNTIME: "",
        FIXTURE_CAPTURE: capture, FIXTURE_OBSERVATION: observation,
        FIXTURE_OWNERSHIP: ownership, FIXTURE_RECOVERY: recovery,
        FIXTURE_FAIL_REPAIR: options.failRepairAt ? resolve(f.root, options.failRepairAt) : "",
        FIXTURE_FAIL_REPAIR_AFTER: String(options.failRepairAfter || ""),
        FIXTURE_REPLACE_AFTER_REPAIR: options.replaceAfterRepair ? JSON.stringify({ ...options.replaceAfterRepair, paths: options.replaceAfterRepair.paths.map(path => join(f.root, path)) }) : "",
        FIXTURE_REPLACEMENT_TARGET: join(f.root, "replacement-target"),
        FIXTURE_EXECUTE_BOOTSTRAP: options.executeBootstrap ? "1" : "0",
        FIXTURE_NPM_STATUS: String(options.npmStatus || 0),
        npm_config_cache: "/root/lower-cache", NPM_CONFIG_CACHE: "/root/upper-cache", Npm_Config_Cache: "/root/mixed-cache",
        npm_config_userconfig: "/root/lower-npmrc", NPM_CONFIG_USERCONFIG: "/root/upper-npmrc", NpM_cOnFiG_uSeRcOnFiG: "/root/mixed-npmrc",
        npm_config_registry: "https://registry.invalid/unchanged",
    });
    const invocation = options.operation === "import"
        ? ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(join(f.root, "scripts/install.js")).href)})`]
        : [join(f.root, "scripts/install.js"), options.operation === "install" ? "--skip-image" : "--postinstall"];
    const runRecovery = (failRepairAt = env.FIXTURE_FAIL_REPAIR, failRepairAfter = env.FIXTURE_FAIL_REPAIR_AFTER) => {
        for (const path of [capture, observation, recovery]) rmSync(path, { force: true });
        const result = spawnSync(process.execPath, ["--experimental-loader", pathToFileURL(loader).href, "--import", pathToFileURL(platform).href, ...invocation], {
            encoding: "utf8", timeout: 10000, env: { ...env, FIXTURE_FAIL_REPAIR: failRepairAt, FIXTURE_FAIL_REPAIR_AFTER: failRepairAfter },
        });
        const jsonLines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
        return {
            result, calls: jsonLines(capture), recovery: jsonLines(recovery),
            observed: existsSync(observation) ? JSON.parse(readFileSync(observation, "utf8")) : null,
            owners: JSON.parse(readFileSync(ownership, "utf8")),
        };
    };
    return { ...f, ...runRecovery(), runRecovery };
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
        const f = sudoSourceBuildFixture({ ...identity, operation: "install", ownership: { dist: 0 } });
        expect(f.result.status, f.result.stderr).not.toBe(0);
        expect(f.calls).toEqual([]);
        expect(f.observed).toBeNull();
        expect(f.recovery).toEqual([]);
        expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe("previous CLI");
        expect(readFileSync(join(f.installDir, "ccc-dist", "previous"), "utf8")).toBe("previous payload");
    });

    it.each([
        { uid: 501, sudoUid: "malformed", sudoGid: "-1" },
        { platform: "win32" as const, sudoUid: "malformed", sudoGid: "-1" },
        {},
    ])("keeps normal-user, Windows and non-sudo root builds unchanged: %j", options => {
        const f = sudoSourceBuildFixture({ ...options, ownership: { dist: 0 } });
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.calls).toEqual([{ command: "npm run build", args: [], options: { cwd: f.root, stdio: "inherit" } }]);
        expect(f.recovery).toEqual([{ kind: "build" }]);
        expect(f.owners[join(f.root, "dist")]).toEqual({ uid: 0, gid: 0 });
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
        const f = sudoSourceBuildFixture({ sudoUid: "bad", sudoGid: "", operation: "import", ownership: { dist: 0 } });
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.calls).toEqual([]);
        expect(f.observed).toBeNull();
        expect(f.recovery).toEqual([]);
        expect(f.result.stdout).toBe("");
        expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe("previous CLI");
    });
});

const generatedOutputRoots = ["dist", "packages/hyper-v/dist", "packages/device-lab/dist"];
function privateEntry(path: string) {
    const entry = lstatSync(path);
    return {
        dev: entry.dev, ino: entry.ino, mode: entry.mode, nlink: entry.nlink,
        bytes: entry.isFile() ? readFileSync(path) : null,
        link: entry.isSymbolicLink() ? readlinkSync(path) : null,
    };
}
function privateSocket(path: string) {
    const made = spawnSync(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))", basename(path)], { cwd: dirname(path), encoding: "utf8", timeout: 5000 });
    expect(made.status, made.stderr).toBe(0);
    expect(lstatSync(path).isSocket()).toBe(true);
}
function expectPreviousInstall(f: ReturnType<typeof sudoSourceBuildFixture>) {
    expect(f.calls).toEqual([]);
    expect(f.observed).toBeNull();
    expect(f.result.stdout).not.toContain("CLI installed.");
    expect(readFileSync(join(f.installDir, "ccc"), "utf8")).toBe("previous CLI");
    expect(readFileSync(join(f.installDir, "ccc-dist", "previous"), "utf8")).toBe("previous payload");
}

describe.skipIf(process.platform === "win32")("bounded sudo generated-output recovery", () => {
    it("repairs root-owned files and directories in exactly the three generated trees before the unchanged child", () => {
        const repairPaths = generatedOutputRoots.flatMap(path => [path, `${path}/nested`, `${path}/nested/output.js`, `${path}/user-nested/root-owned.js`]);
        const userPaths = generatedOutputRoots.flatMap(path => [`${path}/user-owned.js`, `${path}/user-nested`]);
        const untouched = [".", "packages", "packages/hyper-v", "packages/device-lab", "source-sentinel"];
        const ownership = Object.fromEntries([...repairPaths, ...untouched].map(path => [path, 0]));
        for (const path of userPaths) ownership[path] = 602;
        const before: Record<string, ReturnType<typeof privateEntry>> = {};
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", ownership,
            setup(root) {
                for (const path of generatedOutputRoots) {
                    mkdirSync(join(root, path, "nested"), { recursive: true });
                    mkdirSync(join(root, path, "user-nested"));
                    writeFileSync(join(root, path, "nested/output.js"), `generated ${path}`);
                    writeFileSync(join(root, path, "user-nested/root-owned.js"), `legacy output inside a user directory ${path}`);
                    writeFileSync(join(root, path, "user-owned.js"), `user ${path}`);
                }
                writeFileSync(join(root, "source-sentinel"), "source remains owned by root");
                for (const path of repairPaths) chmodSync(join(root, path), path.endsWith(".js") ? 0o640 : 0o750);
                for (const path of [...repairPaths, ...userPaths, ...untouched]) before[path] = privateEntry(join(root, path));
            },
        });
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.recovery.filter(event => event.kind === "repair").sort((a, b) => a.path.localeCompare(b.path))).toEqual(
            repairPaths.map(path => ({ kind: "repair", path: join(f.root, path), uid: 501, gid: 20 })).sort((a, b) => a.path.localeCompare(b.path)),
        );
        expect(f.recovery.at(-1)).toEqual({ kind: "build" });
        expect(f.calls).toEqual([{
            command: process.execPath, args: ["-e", expect.any(String)],
            options: { cwd: f.root, stdio: "inherit", uid: 501, gid: 20 },
        }]);
        for (const path of repairPaths) expect(f.owners[join(f.root, path)]).toEqual({ uid: 501, gid: 20 });
        for (const path of userPaths) expect(f.owners[join(f.root, path)]).toEqual({ uid: 602, gid: 20 });
        for (const path of untouched) expect(f.owners[resolve(f.root, path)]).toEqual({ uid: 0, gid: 0 });
        for (const [path, snapshot] of Object.entries(before)) expect(privateEntry(join(f.root, path))).toEqual(snapshot);
    });

    it.each(["missing", "nonroot"])("leaves %s outputs and namespace unchanged without creating or repairing them", kind => {
        const ownership: Record<string, number> = {};
        const before: Record<string, ReturnType<typeof privateEntry>> = {};
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", ownership,
            setup(root) {
                if (kind === "missing") {
                    rmSync(join(root, "dist"), { recursive: true });
                    return;
                }
                for (const path of [...generatedOutputRoots, "node_modules/@ccc"]) {
                    mkdirSync(join(root, path), { recursive: true });
                    writeFileSync(join(root, path, "user-file"), "ordinary user output");
                    ownership[path] = 777;
                    ownership[`${path}/user-file`] = 778;
                    before[path] = privateEntry(join(root, path));
                    before[`${path}/user-file`] = privateEntry(join(root, path, "user-file"));
                }
            },
        });
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.recovery).toEqual([{ kind: "build" }]);
        for (const [path, snapshot] of Object.entries(before)) expect(privateEntry(join(f.root, path))).toEqual(snapshot);
        if (kind === "missing") for (const path of [...generatedOutputRoots, "node_modules/@ccc"]) expect(existsSync(join(f.root, path))).toBe(false);
        else for (const [path, uid] of Object.entries(ownership)) expect(f.owners[join(f.root, path)]).toEqual({ uid, gid: 20 });
    });

    it("recovers only the namespace directory and never its parent, dependency contents or workspace links", () => {
        const paths = ["node_modules", "node_modules/@ccc", "node_modules/@ccc/owned-file", "node_modules/@ccc/socket", "node_modules/dependency", "node_modules/dependency/index.js", "node_modules/@ccc/hyper-v"];
        const before: Record<string, ReturnType<typeof privateEntry>> = {};
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", ownership: Object.fromEntries(paths.map(path => [path, 0])),
            setup(root) {
                mkdirSync(join(root, "node_modules/@ccc"), { recursive: true });
                mkdirSync(join(root, "node_modules/dependency"));
                mkdirSync(join(root, "packages/hyper-v"), { recursive: true });
                writeFileSync(join(root, "node_modules/@ccc/owned-file"), "do not recurse");
                chmodSync(join(root, "node_modules/@ccc/owned-file"), 0o4750);
                privateSocket(join(root, "node_modules/@ccc/socket"));
                writeFileSync(join(root, "node_modules/dependency/index.js"), "dependency stays unchanged");
                symlinkSync(join(root, "packages/hyper-v"), join(root, "node_modules/@ccc/hyper-v"), "dir");
                for (const path of paths) before[path] = privateEntry(join(root, path));
            },
        });
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.recovery).toEqual([{ kind: "repair", path: join(f.root, "node_modules/@ccc"), uid: 501, gid: 20 }, { kind: "build" }]);
        for (const path of paths) {
            expect(privateEntry(join(f.root, path))).toEqual(before[path]);
            expect(f.owners[join(f.root, path)]).toEqual(path === "node_modules/@ccc" ? { uid: 501, gid: 20 } : { uid: 0, gid: 0 });
        }
    });

    it("leaves interior symlink entries and their external targets untouched", () => {
        const paths = ["dist/file-link", "dist/dir-link", "dist/dangling-link", "outside/file", "outside", "outside/child"];
        const before: Record<string, ReturnType<typeof privateEntry>> = {};
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", ownership: Object.fromEntries(["dist", ...paths].map(path => [path, 0])),
            setup(root) {
                mkdirSync(join(root, "outside"));
                writeFileSync(join(root, "outside/file"), "external file");
                writeFileSync(join(root, "outside/child"), "external child");
                symlinkSync(join(root, "outside/file"), join(root, "dist/file-link"));
                symlinkSync(join(root, "outside"), join(root, "dist/dir-link"), "dir");
                symlinkSync(join(root, "does-not-exist"), join(root, "dist/dangling-link"));
                for (const path of paths) before[path] = privateEntry(join(root, path));
            },
        });
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.recovery).toEqual([{ kind: "repair", path: join(f.root, "dist"), uid: 501, gid: 20 }, { kind: "build" }]);
        for (const path of paths) {
            expect(privateEntry(join(f.root, path))).toEqual(before[path]);
            expect(f.owners[join(f.root, path)]).toEqual({ uid: 0, gid: 0 });
        }
    });

    it.each(["dist", "packages", "packages/hyper-v", "packages/hyper-v/dist", "packages/device-lab", "packages/device-lab/dist", "node_modules", "node_modules/@ccc"])("refuses a symlinked fixed directory before all repairs: %s", path => {
        let linkBefore: ReturnType<typeof privateEntry>, targetBefore: ReturnType<typeof privateEntry>;
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", operation: "install", ownership: { dist: 0, [path]: 0 },
            setup(root) {
                const target = join(root, "outside-fixed-target");
                mkdirSync(join(root, path), { recursive: true });
                renameSync(join(root, path), target);
                symlinkSync(target, join(root, path), "dir");
                linkBefore = privateEntry(join(root, path)); targetBefore = privateEntry(target);
            },
        });
        expect(f.result.status).not.toBe(0);
        expectPreviousInstall(f);
        expect(f.recovery).toEqual([]);
        expect(privateEntry(join(f.root, path))).toEqual(linkBefore!);
        expect(privateEntry(join(f.root, "outside-fixed-target"))).toEqual(targetBefore!);
    });

    it.each([...generatedOutputRoots, "node_modules/@ccc"])("refuses a nondirectory output root before all repairs: %s", path => {
        let before: ReturnType<typeof privateEntry>;
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", operation: "install", ownership: { dist: 0, [path]: 0 },
            setup(root) {
                rmSync(join(root, path), { recursive: true, force: true });
                mkdirSync(dirname(join(root, path)), { recursive: true });
                writeFileSync(join(root, path), "must remain a file");
                before = privateEntry(join(root, path));
            },
        });
        expect(f.result.status).not.toBe(0);
        expectPreviousInstall(f);
        expect(f.recovery).toEqual([]);
        expect(privateEntry(join(f.root, path))).toEqual(before!);
    });

    it.each(["hardlink", "setuid-file", "setgid-directory", "socket"])("preflights a root-owned %s before changing any earlier candidate", kind => {
        const unsafe = "packages/device-lab/dist/unsafe";
        let before: ReturnType<typeof privateEntry>, externalBefore: ReturnType<typeof privateEntry> | undefined;
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", operation: "install", ownership: { dist: 0, "dist/first": 0, [unsafe]: 0 },
            setup(root) {
                writeFileSync(join(root, "dist/first"), "earlier recoverable file");
                mkdirSync(dirname(join(root, unsafe)), { recursive: true });
                if (kind === "hardlink") {
                    writeFileSync(join(root, "external-hardlink"), "same underlying inode");
                    linkSync(join(root, "external-hardlink"), join(root, unsafe));
                    externalBefore = privateEntry(join(root, "external-hardlink"));
                } else if (kind === "setgid-directory") {
                    mkdirSync(join(root, unsafe)); chmodSync(join(root, unsafe), 0o2750);
                } else if (kind === "socket") {
                    privateSocket(join(root, unsafe));
                } else {
                    writeFileSync(join(root, unsafe), "setuid output"); chmodSync(join(root, unsafe), 0o4750);
                }
                before = privateEntry(join(root, unsafe));
            },
        });
        expect(f.result.status).not.toBe(0);
        expectPreviousInstall(f);
        expect(f.recovery).toEqual([]);
        expect(f.owners[join(f.root, "dist")]).toEqual({ uid: 0, gid: 0 });
        expect(f.owners[join(f.root, "dist/first")]).toEqual({ uid: 0, gid: 0 });
        expect(privateEntry(join(f.root, unsafe))).toEqual(before!);
        if (externalBefore) expect(privateEntry(join(f.root, "external-hardlink"))).toEqual(externalBefore);
    });

    it("preserves nonroot hardlinks, special modes and special entries without attempting ownership changes", () => {
        const paths = ["dist/user-hardlink", "dist/user-setuid", "dist/user-socket", "external-hardlink"];
        const before: Record<string, ReturnType<typeof privateEntry>> = {};
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", ownership: Object.fromEntries(paths.map(path => [path, 777])),
            setup(root) {
                writeFileSync(join(root, "external-hardlink"), "nonroot shared inode");
                linkSync(join(root, "external-hardlink"), join(root, "dist/user-hardlink"));
                writeFileSync(join(root, "dist/user-setuid"), "preserve nonroot special mode");
                chmodSync(join(root, "dist/user-setuid"), 0o4750);
                privateSocket(join(root, "dist/user-socket"));
                for (const path of paths) before[path] = privateEntry(join(root, path));
            },
        });
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.recovery).toEqual([{ kind: "build" }]);
        for (const path of paths) {
            expect(f.owners[join(f.root, path)]).toEqual({ uid: 777, gid: 20 });
            expect(privateEntry(join(f.root, path))).toEqual(before[path]);
        }
    });

    it.each(["symlink", "file"] as const)("rechecks an observed output replaced by a %s before repairing it", kind => {
        let targetBefore: ReturnType<typeof privateEntry>;
        const paths = ["dist/first", "dist/second"];
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", operation: "install", ownership: Object.fromEntries(paths.map(path => [path, 0])),
            replaceAfterRepair: { paths, kind },
            setup(root) {
                for (const path of paths) writeFileSync(join(root, path), "original output");
                writeFileSync(join(root, "replacement-target"), "external target must stay intact");
                targetBefore = privateEntry(join(root, "replacement-target"));
            },
        });
        expect(f.result.status).not.toBe(0);
        expectPreviousInstall(f);
        expect(f.recovery).toHaveLength(1);
        const [completed] = f.recovery;
        expect(completed).toMatchObject({ kind: "repair", uid: 501, gid: 20 });
        const changed = paths.map(path => join(f.root, path)).find(path => path !== completed.path)!;
        expect(f.owners[changed]).toEqual({ uid: 0, gid: 0 });
        expect(privateEntry(join(f.root, "replacement-target"))).toEqual(targetBefore!);
        if (kind === "symlink") expect(readlinkSync(changed)).toBe(join(f.root, "replacement-target"));
        else expect(readFileSync(changed, "utf8")).toBe("replacement inode");
    });

    it("stops on a native repair error, preserves prior publication, and permits an explicit later retry", () => {
        const f = sudoSourceBuildFixture({ sudoUid: "501", sudoGid: "20", operation: "install", ownership: { dist: 0 }, failRepairAt: "dist" });
        expect(f.result.status).not.toBe(0);
        expectPreviousInstall(f);
        expect(f.result.stderr).toContain("fixture ownership denied");
        expect(f.recovery).toEqual([{ kind: "repair", path: join(f.root, "dist"), uid: 501, gid: 20 }]);
        expect(f.owners[join(f.root, "dist")]).toEqual({ uid: 0, gid: 0 });
        const retried = f.runRecovery("");
        expect(retried.result.status, retried.result.stderr).toBe(0);
        expect(retried.recovery).toEqual([{ kind: "repair", path: join(f.root, "dist"), uid: 501, gid: 20 }, { kind: "build" }]);
        expect(f.runRecovery("").recovery).toEqual([{ kind: "build" }]);
    });

    it("reports partial recovery without rollback, automatic replay or root build fallback", () => {
        const f = sudoSourceBuildFixture({
            sudoUid: "501", sudoGid: "20", operation: "install", ownership: { dist: 0, "dist/blocked": 0 }, failRepairAfter: 2,
            setup(root) { writeFileSync(join(root, "dist/blocked"), "cannot repair this file"); },
        });
        expect(f.result.status).not.toBe(0);
        expectPreviousInstall(f);
        expect(f.result.stderr).toContain("fixture ownership denied");
        expect(f.result.stderr).toMatch(/partial|already|completed|repaired/i);
        expect(f.recovery).toHaveLength(2);
        expect(f.recovery.map(event => event.path).sort()).toEqual([join(f.root, "dist"), join(f.root, "dist/blocked")].sort());
        for (const event of f.recovery) expect(event).toMatchObject({ kind: "repair", uid: 501, gid: 20 });
        const [completed, failed] = f.recovery;
        expect(f.owners[completed.path]).toEqual({ uid: 501, gid: 20 });
        expect(f.owners[failed.path]).toEqual({ uid: 0, gid: 0 });
        const retried = f.runRecovery("", "");
        expect(retried.result.status, retried.result.stderr).toBe(0);
        expect(retried.recovery).toEqual([failed, { kind: "build" }]);
        expect(f.runRecovery("", "").recovery).toEqual([{ kind: "build" }]);
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
