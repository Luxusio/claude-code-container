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
    const directories = new Set([sourceRoot, installDirectory]);
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
        parentPath: value => paths.dirname(value),
        exists: value => directories.has(value) || files.has(value), isSymlink: () => false,
        removeFile: value => { mutations.push(`remove-file:${value}`); files.delete(value); },
        removeDirectory: value => {
            mutations.push(`remove-directory:${value}`);
            for (const file of files.keys()) if (file === value || file.startsWith(value + paths.sep)) files.delete(file);
            directories.delete(value);
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
    return { ports, files, events, mutations, paths, sourceRoot, installDirectory,
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

    it("reports an interrupted Unix copy without publishing a new wrapper or undoing completed effects", () => {
        const f = nativeLeaves(), target = f.paths.join(f.installDirectory, "ccc-dist"), copy = f.ports.copy;
        f.ports.copy = (source, destination, recursive) => {
            if (source === "/source/Dockerfile") throw new Error("Dockerfile copy failed");
            return copy(source, destination, recursive);
        };
        expect(() => createInstallerApplication(f.ports).install({ skipImage: true })).toThrow("Dockerfile copy failed");
        expect(f.files.get(f.paths.join(f.installDirectory, "ccc"))).toBe("previous CLI");
        expect(f.files.has(f.paths.join(target, "previous"))).toBe(false);
        expect(f.files.get(f.paths.join(target, "dist"))).toBe("copied payload");
        expect(f.events).not.toContainEqual({ kind: "cli-installed" });
        expect(f.mutations.some(mutation => mutation.startsWith("unix-launcher:"))).toBe(false);
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
