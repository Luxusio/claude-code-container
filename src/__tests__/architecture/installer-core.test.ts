import { describe, expect, it } from "vitest";
import { posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { createInstallerApplication } from "../../../scripts/install/application.mjs";
import { unixWrapperContent } from "../../../scripts/install.js";
import type { InstallerPorts } from "../../../scripts/install/ports.mjs";

function nativeLeaves(platform: "unix" | "windows" = "unix") {
    const paths = platform === "windows" ? win32 : posix;
    const sourceRoot = platform === "windows" ? "C:\\source" : "/source";
    const installDirectory = platform === "windows" ? "C:\\CCC" : "/owned-bin";
    const files = new Map<string, string>(platform === "unix" ? [
        [paths.join(installDirectory, "ccc"), "previous CLI"],
        [paths.join(installDirectory, "ccc-dist", "previous"), "previous payload"],
    ] : []);
    const directories = new Set([sourceRoot, installDirectory]);
    const output: string[] = [];
    let userPath = "C:\\Tools";
    const ports: InstallerPorts = {
        platform: () => platform, sourceRoot: () => sourceRoot,
        sourceEntry: () => paths.join(sourceRoot, "dist", "index.js"), installDirectory: () => installDirectory,
        runtimeOverride: () => undefined, githubTokenConfigured: () => false,
        sourceBuild: () => undefined, contentHash: () => "current-content",
        runtimeAvailable: () => false, imageLabel: () => null,
        buildContainer: () => ({ status: 0 }),
        resolvePath: value => paths.resolve(value), joinPath: (...parts) => paths.join(...parts),
        parentPath: value => paths.dirname(value), fileUrl: value => pathToFileURL(value).href,
        exists: value => directories.has(value) || files.has(value), isSymlink: () => false,
        removeFile: value => { files.delete(value); },
        removeDirectory: value => {
            for (const file of files.keys()) if (file === value || file.startsWith(value + paths.sep)) files.delete(file);
            directories.delete(value);
        },
        ensureDirectory: value => { directories.add(value); },
        copy: (_source, destination) => { files.set(destination, "copied payload"); },
        readPackage: () => ({ version: "1.0.0", imports: { "#fixture": "./dist/index.js" } }),
        writeText: (value, content) => { files.set(value, content); }, setMode: () => undefined,
        readUserPath: () => userPath, writeUserPath: value => { userPath = value; },
        log: message => { output.push(message); }, warn: (message, detail) => { output.push(`${message} ${detail}`); },
        error: (message, detail) => { output.push(`${message}${detail === undefined ? "" : " " + detail}`); },
        terminate: code => { throw new Error(`terminated ${code}`); },
    };
    return { ports, files, output, paths, sourceRoot, installDirectory,
        userPath: () => userPath, setUserPath: (value: string) => { userPath = value; } };
}

describe("installer application decisions", () => {
    it("keeps the real native facade's Unix wrapper connected to the selected payload URL", () => {
        const target = resolve("owned payload ' space");
        expect(unixWrapperContent(target)).toContain(JSON.stringify(pathToFileURL(resolve(target, "dist/index.js")).href));
    });

    it("preserves an existing normalized User PATH entry without rewriting it", () => {
        const f = nativeLeaves("windows");
        f.setUserPath(" C:\\Tools ; c:\\ccc\\ ;D:\\Apps");
        f.ports.writeUserPath = () => { throw new Error("existing User PATH must not be rewritten"); };
        createInstallerApplication(f.ports).install({ skipImage: true });
        expect(f.userPath()).toBe(" C:\\Tools ; c:\\ccc\\ ;D:\\Apps");
        expect(f.output).toContain("Already on User PATH.");
        expect(f.files.get("C:\\CCC\\ccc.cmd")).toBe('@echo off\r\nnode "C:\\source\\dist\\index.js" %*\r\n');
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
        if (reason === "READ_ERROR") f.ports.readUserPath = () => { throw new Error("User PATH read denied"); };
        if (reason === "WRITE_ERROR") f.ports.writeUserPath = () => { throw new Error("User PATH write denied"); };
        if (reason === "PATH_TOO_LONG") f.setUserPath("x".repeat(32767 - 1 - f.installDirectory.length));
        const original = f.userPath();
        createInstallerApplication(f.ports).install({ skipImage: true });
        expect(f.files.has("C:\\CCC\\ccc.cmd")).toBe(true);
        expect(f.userPath()).toBe(original);
        expect(f.output.some(line => line.startsWith(`PATH update skipped (${reason}):`))).toBe(true);
        if (reason === "READ_ERROR") expect(f.output).toContain("PATH update skipped (READ_ERROR): User PATH read denied");
        if (reason === "WRITE_ERROR") expect(f.output).toContain("PATH update skipped (WRITE_ERROR): User PATH write denied");
        if (reason === "PATH_TOO_LONG") expect(f.output).toContain("PATH update skipped (PATH_TOO_LONG): 32767 >= 32767");
        expect(f.output).toContain("Add it manually in PowerShell:");
        expect(f.output).toContain("\nCLI installed. Run 'ccc --help' to verify.");
    });

    it("accepts the matching legacy image label without rebuilding", () => {
        const f = nativeLeaves();
        f.ports.runtimeOverride = () => "docker";
        f.ports.runtimeAvailable = () => { throw new Error("explicit runtime must not be probed"); };
        f.ports.imageLabel = (_runtime, label) => label === "dockerfile.hash" ? "current-content" : null;
        f.ports.buildContainer = () => { throw new Error("matching cached image must not rebuild"); };
        expect(createInstallerApplication(f.ports).buildImage()).toEqual({ status: "ready" });
        expect(f.output).toContain("Container image up to date (hash: current-content)");
    });

    it("falls back from an invalid override and passes only the secret-presence decision to the build", () => {
        const f = nativeLeaves();
        f.ports.runtimeOverride = () => "invalid-runtime";
        f.ports.runtimeAvailable = runtime => runtime === "docker";
        f.ports.githubTokenConfigured = () => true;
        let build: { runtime: string; hash: string; includeSecret: boolean } | undefined;
        f.ports.buildContainer = (runtime, hash, includeSecret) => { build = { runtime, hash, includeSecret }; return { status: 0 }; };
        expect(createInstallerApplication(f.ports).buildImage()).toEqual({ status: "ready" });
        expect(build).toEqual({ runtime: "docker", hash: "current-content", includeSecret: true });
    });

    it("refuses root and source-equal payload targets before removing previous files", () => {
        const f = nativeLeaves(), app = createInstallerApplication(f.ports), previous = new Map(f.files);
        expect(() => app.materializeUnixInstallPayload(f.sourceRoot, "/")).toThrow("Refusing unsafe global install payload target");
        expect(() => app.materializeUnixInstallPayload(f.sourceRoot, f.sourceRoot)).toThrow("Refusing unsafe global install payload target");
        expect(f.files).toEqual(previous);
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
        expect(f.output).not.toContain("\nCLI installed. Run 'ccc --help' to verify.");
    });

    it("returns the existing Unix permission remedy through exit status one", () => {
        const f = nativeLeaves();
        f.ports.copy = () => { throw Object.assign(new Error("copy denied"), { code: "EACCES" }); };
        expect(() => createInstallerApplication(f.ports).install({ skipImage: true })).toThrow("terminated 1");
        expect(f.output).toContain("Permission denied. Run with sudo:");
        expect(f.output).toContain("  sudo npm run install:global");
        expect(f.files.get("/owned-bin/ccc")).toBe("previous CLI");
    });
});
