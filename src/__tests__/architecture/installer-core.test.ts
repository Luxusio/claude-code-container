import { describe, expect, it } from "vitest";
import { posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createInstallerApplication } from "../../../scripts/install/application.mjs";
import { unixWrapperContent } from "../../../scripts/install.js";
import type { InstallerEvent, InstallerPorts } from "../../../scripts/install/ports.mjs";

function nativeLeaves(platform: "unix" | "windows" = "unix") {
    const paths = platform === "windows" ? win32 : posix;
    const sourceRoot = platform === "windows" ? "C:\\source" : "/source";
    const installDirectory = platform === "windows" ? "C:\\CCC" : "/owned-bin";
    const files = new Map<string, string>(platform === "unix" ? [
        [paths.join(installDirectory, "ccc"), "previous CLI"],
        [paths.join(installDirectory, "ccc-dist", "previous"), "previous payload"],
    ] : []);
    const directories = new Set([sourceRoot, installDirectory, ...(platform === "unix" ? [paths.join(installDirectory, "ccc-dist")] : [])]);
    const events: InstallerEvent[] = [];
    const mutations: string[] = [];
    let userPath = "C:\\Tools";
    const ports: InstallerPorts = {
        platform: () => platform, sourceRoot: () => sourceRoot,
        installDirectory: () => installDirectory,
        runtimeOverride: () => undefined, githubTokenConfigured: () => false,
        sourceBuild: () => undefined, contentHash: () => "current-content",
        runtimeAvailable: () => false, imageLabel: () => null,
        buildContainer: () => ({ status: "ready" }),
        resolvePath: value => paths.resolve(value), joinPath: (...parts) => paths.join(...parts),
        parentPath: value => paths.dirname(value), basePath: value => paths.basename(value),
        exists: value => directories.has(value) || files.has(value),
        pathKind: value => directories.has(value) ? "directory" : files.has(value) ? "file" : "missing",
        realPath: value => value,
        createExclusiveDirectory: value => {
            if (directories.has(value) || files.has(value)) throw Object.assign(new Error("directory exists"), { code: "EEXIST" });
            if (!directories.has(paths.dirname(value))) throw Object.assign(new Error("parent missing"), { code: "ENOENT" });
            mutations.push(`exclusive-directory:${value}`); directories.add(value);
        },
        createTemporaryDirectory: prefix => {
            const value = prefix + "owned-fixture";
            mutations.push(`temporary-directory:${value}`); directories.add(value); return value;
        },
        removeEmptyDirectory: value => { mutations.push(`remove-empty-directory:${value}`); directories.delete(value); },
        renamePath: (source, destination) => {
            mutations.push(`rename:${source}:${destination}`);
            if (!directories.has(source) && !files.has(source)) throw Object.assign(new Error(`missing rename source: ${source}`), { code: "ENOENT" });
            for (const [file, bytes] of [...files]) if (file === source || file.startsWith(source + paths.sep)) {
                files.delete(file); files.set(destination + file.slice(source.length), bytes);
            }
            for (const directory of [...directories]) if (directory === source || directory.startsWith(source + paths.sep)) {
                directories.delete(directory); directories.add(destination + directory.slice(source.length));
            }
        },
        removeFile: value => { mutations.push(`remove-file:${value}`); files.delete(value); },
        removeDirectory: value => {
            mutations.push(`remove-directory:${value}`);
            for (const file of files.keys()) if (file === value || file.startsWith(value + paths.sep)) files.delete(file);
            for (const directory of [...directories]) if (directory === value || directory.startsWith(value + paths.sep)) directories.delete(directory);
        },
        ensureDirectory: value => { mutations.push(`ensure-directory:${value}`); directories.add(value); },
        copy: (_source, destination) => { mutations.push(`copy:${destination}`); files.set(destination, "copied payload"); },
        writeUnixPackage: (_source, target) => { mutations.push(`package:${target}`); files.set(paths.join(target, "package.json"), "native package bytes"); },
        unixWrapperContent: () => "native Unix launcher bytes",
        writeUnixLauncher: (value, target) => { mutations.push(`unix-launcher:${target}`); files.set(value, "native Unix launcher bytes"); },
        writeWindowsLauncher: value => { mutations.push(`windows-launcher:${value}`); files.set(value, "native Windows launcher bytes"); },
        readUserPath: () => userPath, writeUserPath: value => { mutations.push("write-user-path"); userPath = value; },
        present: event => { events.push(event); },
        terminate: code => { throw new Error(`terminated ${code}`); },
    };
    return { ports, files, directories, events, mutations, paths, sourceRoot, installDirectory,
        userPath: () => userPath, setUserPath: (value: string) => { userPath = value; } };
}

describe("installer application decisions", () => {
    it.each(["unix", "windows"] as const)("propagates the original source postinstall build failure on %s without installing", platform => {
        const f = nativeLeaves(platform);
        const previousFiles = new Map(f.files), previousPath = f.userPath();
        const failure = new Error("source build failed");
        let buildCalls = 0;
        f.ports.sourceBuild = () => { buildCalls++; throw failure; };
        f.ports.runtimeAvailable = () => { throw new Error("postinstall must not probe a runtime"); };
        f.ports.buildContainer = () => { throw new Error("postinstall must not build an image"); };
        let caught: unknown;
        try { createInstallerApplication(f.ports).postinstall(); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(buildCalls).toBe(1);
        expect(f.files).toEqual(previousFiles);
        expect(f.userPath()).toBe(previousPath);
        expect(f.mutations).toEqual([]);
        expect(f.events).toEqual([{ kind: "building" }]);
    });

    it.each(["unix", "windows"] as const)("skips the source build for packaged postinstall on %s", platform => {
        const f = nativeLeaves(platform);
        f.ports.sourceRoot = () => f.paths.join(f.sourceRoot, "node_modules", "ccc");
        f.ports.sourceBuild = () => { throw new Error("packaged postinstall must not build source"); };
        f.ports.runtimeAvailable = () => { throw new Error("packaged postinstall must not probe a runtime"); };
        const previousFiles = new Map(f.files), previousPath = f.userPath();
        createInstallerApplication(f.ports).postinstall();
        expect(f.files).toEqual(previousFiles);
        expect(f.userPath()).toBe(previousPath);
        expect(f.events).toEqual([]);
        expect(f.mutations).toEqual([]);
    });

    it.skipIf(process.platform === "win32")("executes the selected payload literally through the native Unix launcher", () => {
        const root = mkdtempSync(resolve(tmpdir(), "ccc-native-launcher-"));
        try {
            const target = resolve(root, "owned payload ' space #? $HOME `literal`");
            mkdirSync(resolve(target, "dist"), { recursive: true });
            writeFileSync(resolve(target, "package.json"), '{"type":"module"}');
            writeFileSync(resolve(target, "dist/index.js"), 'process.stdout.write(JSON.stringify({url:import.meta.url,argv:process.argv.slice(2)}));');
            const launcher = resolve(root, "ccc");
            writeFileSync(launcher, unixWrapperContent(target));
            chmodSync(launcher, 0o755);
            const args = ["", "two words", "' $HOME `literal` #?"];
            const result = spawnSync(launcher, args, { encoding: "utf8", env: { ...process.env, PATH: "" } });
            expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout)).toEqual({ url: pathToFileURL(resolve(target, "dist/index.js")).href, argv: args });
            expect(result.stderr).toBe("");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("preserves an existing normalized User PATH entry without rewriting it", () => {
        const f = nativeLeaves("windows");
        f.setUserPath(" C:\\Tools ; c:\\ccc\\ ;D:\\Apps");
        f.ports.writeUserPath = () => { throw new Error("existing User PATH must not be rewritten"); };
        createInstallerApplication(f.ports).install({ skipImage: true });
        expect(f.userPath()).toBe(" C:\\Tools ; c:\\ccc\\ ;D:\\Apps");
        expect(f.events).toContainEqual({ kind: "path-present" });
        expect(f.files.get("C:\\CCC\\ccc.cmd")).toBe("native Windows launcher bytes");
    });

    it("adds and removes only this install directory from User PATH", () => {
        const f = nativeLeaves("windows"), app = createInstallerApplication(f.ports);
        f.setUserPath(" C:\\Tools ; ;D:\\Apps\\;");
        app.install({ skipImage: true });
        expect(f.userPath()).toBe(" C:\\Tools ;D:\\Apps\\;C:\\CCC");
        f.setUserPath(" C:\\Tools ;c:\\ccc\\;D:\\Apps\\;C:\\CCC");
        app.uninstall();
        expect(f.userPath()).toBe(" C:\\Tools ;D:\\Apps\\");
        expect(f.files.has("C:\\CCC\\ccc.cmd")).toBe(false);
    });

    it.each(["READ_ERROR", "WRITE_ERROR", "PATH_TOO_LONG"])("keeps the Windows CLI usable when User PATH update reports %s", reason => {
        const f = nativeLeaves("windows");
        const failure = new Error(reason === "READ_ERROR" ? "User PATH read denied" : "User PATH write denied");
        if (reason === "READ_ERROR") f.ports.readUserPath = () => { throw failure; };
        if (reason === "WRITE_ERROR") f.ports.writeUserPath = () => { throw failure; };
        if (reason === "PATH_TOO_LONG") f.setUserPath("x".repeat(32767 - 1 - f.installDirectory.length));
        const original = f.userPath();
        createInstallerApplication(f.ports).install({ skipImage: true });
        expect(f.files.has("C:\\CCC\\ccc.cmd")).toBe(true);
        expect(f.userPath()).toBe(original);
        if (reason === "READ_ERROR" || reason === "WRITE_ERROR") {
            const event = f.events.find(event => event.kind === (reason === "READ_ERROR" ? "path-read-failed" : "path-write-failed"));
            expect(event).toEqual({ kind: reason === "READ_ERROR" ? "path-read-failed" : "path-write-failed", installDir: f.installDirectory, cause: failure });
            expect(event && "cause" in event ? event.cause : undefined).toBe(failure);
        }
        if (reason === "PATH_TOO_LONG") expect(f.events).toContainEqual({ kind: "path-too-long", installDir: f.installDirectory, length: 32767, limit: 32767 });
        expect(f.events).toContainEqual({ kind: "cli-installed" });
    });

    it("accepts the matching legacy image label without rebuilding", () => {
        const f = nativeLeaves();
        f.ports.runtimeOverride = () => "docker";
        f.ports.runtimeAvailable = () => { throw new Error("explicit runtime must not be probed"); };
        f.ports.imageLabel = (_runtime, label) => label === "dockerfile.hash" ? "current-content" : null;
        f.ports.buildContainer = () => { throw new Error("matching cached image must not rebuild"); };
        expect(createInstallerApplication(f.ports).buildImage()).toEqual({ status: "ready" });
        expect(f.events).toContainEqual({ kind: "image-current", hash: "current-content" });
    });

    it("falls back from an invalid override and passes only the secret-presence decision to the build", () => {
        const f = nativeLeaves();
        f.ports.runtimeOverride = () => "invalid-runtime";
        f.ports.runtimeAvailable = runtime => runtime === "docker";
        f.ports.githubTokenConfigured = () => true;
        let build: { runtime: string; hash: string; includeSecret: boolean } | undefined;
        f.ports.buildContainer = (runtime, hash, includeSecret) => { build = { runtime, hash, includeSecret }; return { status: "ready" }; };
        expect(createInstallerApplication(f.ports).buildImage()).toEqual({ status: "ready" });
        expect(build).toEqual({ runtime: "docker", hash: "current-content", includeSecret: true });
    });

    it("refuses root and source-equal payload targets before removing previous files", () => {
        const f = nativeLeaves(), app = createInstallerApplication(f.ports), previous = new Map(f.files);
        expect(() => app.materializeUnixInstallPayload(f.sourceRoot, "/")).toThrow("Refusing unsafe global install payload target");
        expect(() => app.materializeUnixInstallPayload(f.sourceRoot, f.sourceRoot)).toThrow("Refusing unsafe global install payload target");
        expect(f.files).toEqual(previous);
        expect(f.mutations).toEqual([]);
    });

    it("preserves the previous Unix payload and launcher when staged copy fails", () => {
        const f = nativeLeaves(), target = f.paths.join(f.installDirectory, "ccc-dist"), copy = f.ports.copy;
        f.ports.copy = (source, destination, recursive) => {
            if (source === "/source/Dockerfile") throw new Error("Dockerfile copy failed");
            return copy(source, destination, recursive);
        };
        expect(() => createInstallerApplication(f.ports).install({ skipImage: true })).toThrow("Dockerfile copy failed");
        expect(f.files.get(f.paths.join(f.installDirectory, "ccc"))).toBe("previous CLI");
        expect(f.files.get(f.paths.join(target, "previous"))).toBe("previous payload");
        expect(f.files.has(f.paths.join(target, "dist"))).toBe(false);
        expect([...f.files.keys()].some(path => path.includes("install-stage-"))).toBe(false);
        expect([...f.directories].some(path => path.endsWith(".install-lock"))).toBe(false);
        expect(f.events).not.toContainEqual({ kind: "cli-installed" });
        expect(f.mutations.some(mutation => mutation.startsWith("unix-launcher:"))).toBe(false);
    });

    it("prepares then publishes the first Unix installation and removes its private stage and guard", () => {
        const f = nativeLeaves();
        f.files.clear();
        f.directories.delete("/owned-bin/ccc-dist");
        createInstallerApplication(f.ports).install({ skipImage: true });
        expect(f.files.get("/owned-bin/ccc")).toBe("native Unix launcher bytes");
        expect(f.files.get("/owned-bin/ccc-dist/package.json")).toBe("native package bytes");
        const prepared = f.mutations.findIndex(value => value.startsWith("unix-launcher:"));
        const published = f.mutations.findIndex(value => value.startsWith("rename:"));
        expect(prepared).toBeGreaterThan(-1);
        expect(published).toBeGreaterThan(prepared);
        expect([...f.directories].some(path => /install-(?:stage-|lock)/.test(path))).toBe(false);
        expect(f.events).toContainEqual({ kind: "cli-installed" });
    });

    it("creates a missing Unix install parent before acquiring its guard", () => {
        const f = nativeLeaves();
        f.files.clear(); f.directories.delete("/owned-bin/ccc-dist"); f.directories.delete("/owned-bin");
        createInstallerApplication(f.ports).install({ skipImage: true });
        expect(f.files.get("/owned-bin/ccc")).toBe("native Unix launcher bytes");
        expect(f.directories.has("/owned-bin")).toBe(true);
        expect(f.mutations.indexOf("ensure-directory:/owned-bin")).toBeLessThan(f.mutations.indexOf("exclusive-directory:/owned-bin/ccc-dist.install-lock"));
    });

    it("leaves a missing Unix install parent absent when uninstalling", () => {
        const f = nativeLeaves();
        f.files.clear(); f.directories.delete("/owned-bin/ccc-dist"); f.directories.delete("/owned-bin");
        createInstallerApplication(f.ports).uninstall();
        expect(f.directories.has("/owned-bin")).toBe(false);
        expect(f.mutations).toEqual([]);
        expect(f.events).toContainEqual({ kind: "not-installed" });
    });

    it("refuses a canonical existing target alias into copied source output", () => {
        const f = nativeLeaves(), kind = f.ports.pathKind, canonical = f.ports.realPath, previous = new Map(f.files);
        f.ports.pathKind = path => path === "/source/DIST" ? "directory" : kind(path);
        f.ports.realPath = path => path === "/source/DIST" ? "/source/dist" : canonical(path);
        expect(() => createInstallerApplication(f.ports).materializeUnixInstallPayload(f.sourceRoot, "/source/DIST")).toThrow("Refusing unsafe global install payload target");
        expect(f.files).toEqual(previous);
        expect(f.mutations.some(value => /^(?:copy|rename|temporary-directory|remove-directory):/.test(value))).toBe(false);
    });

    it.each(["package", "launcher", "publication"] as const)("preserves the original cause and prior installation after %s failure", point => {
        const f = nativeLeaves(), previous = new Map(f.files), failure = new Error(`${point} failed`);
        if (point === "package") f.ports.writeUnixPackage = () => { throw failure; };
        if (point === "launcher") f.ports.writeUnixLauncher = () => { throw failure; };
        if (point === "publication") {
            const rename = f.ports.renamePath;
            f.ports.renamePath = (source, destination) => {
                if (destination === "/owned-bin/ccc") throw failure;
                return rename(source, destination);
            };
        }
        let caught: unknown;
        try { createInstallerApplication(f.ports).install({ skipImage: true }); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(f.files).toEqual(previous);
        expect(f.mutations).not.toContain("remove-directory:/owned-bin/ccc-dist");
        expect(f.events).not.toContainEqual({ kind: "cli-installed" });
    });

    it("removes only its staged first installation after launcher publication fails", () => {
        const f = nativeLeaves(), rename = f.ports.renamePath, failure = new Error("first launcher publication failed");
        f.files.clear(); f.directories.delete("/owned-bin/ccc-dist");
        f.ports.renamePath = (source, destination) => {
            if (destination === "/owned-bin/ccc") throw failure;
            return rename(source, destination);
        };
        expect(() => createInstallerApplication(f.ports).install({ skipImage: true })).toThrow(failure);
        expect(f.files.size).toBe(0);
        expect(f.directories).toEqual(new Set(["/source", "/owned-bin"]));
        expect(f.mutations).not.toContain("remove-directory:/owned-bin/ccc-dist");
        expect(f.events).not.toContainEqual({ kind: "cli-installed" });
    });

    it("retains both original errors and the old payload if restoration itself fails", () => {
        const f = nativeLeaves(), rename = f.ports.renamePath;
        const publication = new Error("publication failed"), restoration = new Error("restoration failed");
        let backup: string | undefined;
        f.ports.renamePath = (source, destination) => {
            if (source === "/owned-bin/ccc-dist" && !backup) backup = destination;
            if (destination === "/owned-bin/ccc") throw publication;
            if (source === backup && destination === "/owned-bin/ccc-dist") throw restoration;
            return rename(source, destination);
        };
        let caught: unknown;
        try { createInstallerApplication(f.ports).install({ skipImage: true }); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).errors).toContain(publication);
        expect((caught as AggregateError).errors).toContain(restoration);
        expect((caught as Error).message).toContain(backup!);
        expect(f.files.get(f.paths.join(backup!, "previous"))).toBe("previous payload");
        expect(f.mutations).not.toContain(`remove-directory:${f.paths.dirname(backup!)}`);
        expect(f.mutations).not.toContain("remove-directory:/owned-bin/ccc-dist");
        expect(f.events).not.toContainEqual({ kind: "cli-installed" });
    });

    it.each(["install", "uninstall", "materialize"] as const)("refuses %s under an existing cooperative guard without touching destination state", operation => {
        const f = nativeLeaves(), app = createInstallerApplication(f.ports), previous = new Map(f.files);
        const guard = "/owned-bin/ccc-dist.install-lock";
        f.directories.add(guard);
        expect(() => {
            if (operation === "install") app.install({ skipImage: true });
            else if (operation === "uninstall") app.uninstall();
            else app.materializeUnixInstallPayload(f.sourceRoot, "/owned-bin/ccc-dist");
        }).toThrow(guard);
        expect(f.files).toEqual(previous);
        expect(f.directories.has(guard)).toBe(true);
        expect(f.mutations).toEqual([]);
        expect(f.events).not.toContainEqual({ kind: "cli-installed" });
    });

    it("returns the existing Unix permission remedy through exit status one", () => {
        const f = nativeLeaves();
        f.ports.copy = () => { throw Object.assign(new Error("copy denied"), { code: "EACCES" }); };
        expect(() => createInstallerApplication(f.ports).install({ skipImage: true })).toThrow("terminated 1");
        expect(f.events).toContainEqual({ kind: "permission-denied", operation: "install" });
        expect(f.files.get("/owned-bin/ccc")).toBe("previous CLI");
    });

    it.each(["unix", "windows"] as const)("fails a source install before any destination mutation on %s", platform => {
        const f = nativeLeaves(platform), failure = Object.assign(new Error("source build failed"), { code: "fixture-source-failure" });
        const previous = new Map(f.files), previousPath = f.userPath();
        f.ports.sourceBuild = () => { throw failure; };
        f.ports.runtimeAvailable = () => { throw new Error("a failed source build must not reach runtime discovery"); };
        let caught: unknown;
        try { createInstallerApplication(f.ports).install(); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(f.files).toEqual(previous);
        expect(f.userPath()).toBe(previousPath);
        expect(f.mutations).toEqual([]);
        expect(f.events).toEqual([{ kind: "building" }]);
    });

    it.each(["docker", "podman"] as const)("retains the original failed %s image cause while allowing truthful CLI installation", runtime => {
        const f = nativeLeaves(), failure = Object.assign(new Error("native image failed"), { code: "ETIMEDOUT" });
        f.ports.runtimeOverride = () => runtime;
        f.ports.buildContainer = () => ({ status: "failed", cause: failure });
        const app = createInstallerApplication(f.ports);
        expect(app.buildImage()).toEqual({ status: "failed" });
        const firstFailure = f.events.find(event => event.kind === "image-build-failed");
        expect(firstFailure).toEqual({ kind: "image-build-failed", runtime, cause: failure });
        expect(firstFailure && "cause" in firstFailure ? firstFailure.cause : undefined).toBe(failure);
        expect(f.mutations).toEqual([]);
        expect(f.events).not.toContainEqual({ kind: "image-built" });
        f.events.length = 0;
        app.install();
        expect(f.files.get("/owned-bin/ccc")).toBe("native Unix launcher bytes");
        const installedFailure = f.events.find(event => event.kind === "image-build-failed");
        expect(installedFailure && "cause" in installedFailure ? installedFailure.cause : undefined).toBe(failure);
        expect(f.events.slice(-2)).toEqual([{ kind: "cli-installed" }, { kind: "image-partial-success" }]);
        expect(f.events).not.toContainEqual({ kind: "image-ready" });
    });

    it("publishes ready only from an immediate ready image observation", () => {
        const f = nativeLeaves();
        f.ports.runtimeOverride = () => "docker";
        createInstallerApplication(f.ports).install();
        expect(f.events).toContainEqual({ kind: "image-built" });
        expect(f.events.slice(-2)).toEqual([{ kind: "cli-installed" }, { kind: "image-ready" }]);
        expect(f.events).not.toContainEqual({ kind: "image-partial-success" });
    });
});
