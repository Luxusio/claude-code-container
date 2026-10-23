import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { RuntimeBindGuard } from "../ports/runtime-bind-authority.js";
import { createNativeContainerExecPorts } from "../composition/container-exec.js";
import { getProjectId } from "../utils.js";
import { basename, dirname, join } from "node:path";
import * as runtime from "../container-runtime.js";
import { captureBindMountSourceIdentity, proveStoppedContainerProjectBindSource } from "../adapters/container-mount-observations.js";
import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "./helpers/native-runtime-fixture.js";

const native = vi.hoisted(() => ({ spawnSync: vi.fn(), begin: vi.fn(), settle: vi.fn() }));
vi.mock("child_process", async () => ({ ...await vi.importActual("child_process"), spawnSync: native.spawnSync }));
vi.mock("../adapters/runtime-bind-authority.js", async original => ({
    ...await original<typeof import("../adapters/runtime-bind-authority.js")>(),
    beginRuntimeBindCreation: native.begin, settleRuntimeBindCreation: native.settle,
}));

const exactId = "a".repeat(64);
let root: string;
let project: string;
let destinations: string[];
let calls: string[][];
type CopyFault = "failure" | "timeout" | "signaled" | "missing" | "wrong nonce" | "oversized" | "symlink" | "changed host";

function copyMarker(fault?: CopyFault) {
    native.spawnSync.mockImplementation((...call: unknown[]) => {
        const [, argv, options] = normalizeNativeRuntimeCall(call) as [string, string[], { timeout?: number; killSignal?: string }];
        calls.push(argv);
        expect(argv).toHaveLength(3);
        expect(argv[0]).toBe("cp");
        expect(argv[1]).toMatch(new RegExp(`^${exactId}:/project/repo-id/\\.ccc-mount-identity-[a-f0-9]{32}$`));
        expect(options).toMatchObject({ timeout: 5000, killSignal: "SIGKILL" });
        const destination = argv[2];
        destinations.push(destination);
        expect(lstatSync(dirname(destination)).mode & 0o777).toBe(0o700);
        const marker = join(project, basename(argv[1]));
        const nonce = readFileSync(marker, "utf8");
        expect(nonce).toMatch(/^[a-f0-9]{64}$/);
        expect(lstatSync(marker).mode & 0o777).toBe(0o600);
        if (fault === "failure") return { status: 1, stdout: "", stderr: "copy unsupported" };
        if (fault === "timeout") return { status: null, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };
        if (fault === "signaled") return { status: null, signal: "SIGTERM" };
        if (fault === "missing") return { status: 0, stdout: "", stderr: "" };
        if (fault === "symlink") symlinkSync(marker, destination);
        else writeFileSync(destination, fault === "wrong nonce" ? "f".repeat(64) : fault === "oversized" ? nonce + nonce : nonce);
        if (fault === "changed host") {
            renameSync(project, `${project}.replaced`);
            const replacement = mkdtempSync(join(root, "replacement-"));
            renameSync(replacement, project);
        }
        return { status: 0, stdout: "", stderr: "" };
    });
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccc-stopped-project-proof-"));
    project = mkdtempSync(join(root, "project-"));
    destinations = [];
    calls = [];
    native.spawnSync.mockReset(); native.begin.mockReset(); native.settle.mockReset();
    runtime._resetRuntimeCacheForTest();
    preloadNativeRuntimeFixture(runtime);
});
afterEach(() => {
    for (const destination of destinations) expect(existsSync(dirname(destination))).toBe(false);
    expect(readdirSync(project).filter(name => name.startsWith(".ccc-mount-identity-"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
    runtime._resetRuntimeCacheForTest();
});

describe("stopped project bind proof", () => {
    it("reads a fresh nonce from the captured exact stopped target without starting or executing it", () => {
        copyMarker();
        expect(proveStoppedContainerProjectBindSource(exactId, project, "/project/repo-id", captureBindMountSourceIdentity(project))).toMatchObject({ kind: "verified" });
        expect(calls).toHaveLength(1);
        expect(calls[0]).not.toContain("-L");
    });

    it.each(["failure", "timeout", "signaled", "missing", "wrong nonce", "oversized", "symlink", "changed host"] as const)("never grants ownership after %s", fault => {
        copyMarker(fault);
        expect(proveStoppedContainerProjectBindSource(exactId, project, "/project/repo-id", captureBindMountSourceIdentity(project)).kind).not.toBe("verified");
        expect(calls).toHaveLength(1);
    });

    it.each([
        ["short-id", "/project/repo-id"], ["a".repeat(63), "/project/repo-id"],
        [exactId, "/home/ccc/.ssh"], [exactId, "/project/repo-id/../secret"],
        [exactId, "/project/repo-id/nested"], [exactId, "/project/"],
    ])("rejects invalid target %s at %s before a challenge or native call", (id, target) => {
        copyMarker();
        expect(proveStoppedContainerProjectBindSource(id, project, target, captureBindMountSourceIdentity(project)).kind).not.toBe("verified");
        expect(calls).toEqual([]);
        expect(readdirSync(project)).toEqual([]);
    });
});


describe("trusted current-image proof of inherited stopped mounts", () => {
    const imageId = `sha256:${"b".repeat(64)}`, helperId = "c".repeat(64);
    const guard = Object.freeze({ root: join(homedir(), ".ccc") }) as RuntimeBindGuard;
    const allowedDestinations = ["/project/repo-id", "/home/ccc", "/home/ccc/.codex", "/run/ccc/clipboard.port", "/run/ccc-device-broker-auth/owner.json", "/tmp/ssh-agent.sock", "/var/run/docker.sock"];
    function inheritedProof(mode: "match" | "wrong" | "timeout" | "timeout old cid" | "timeout invalid cid" | "signaled" | "failed" | "changed host" = "match", mountDestinations: readonly string[] = allowedDestinations) {
        const ticket = Object.freeze({}), order: string[] = [], helperDirectories: string[] = [];
        native.begin.mockImplementation(() => { order.push("begin"); return ticket; });
        native.settle.mockImplementation(() => { order.push("settle"); });
        native.spawnSync.mockImplementation((...call: unknown[]) => {
            const [, argv, options] = normalizeNativeRuntimeCall(call) as [string, string[], Record<string, unknown>];
            calls.push(argv); order.push(argv[0]);
            if (argv[0] === "cp") {
                destinations.push(argv[2]);
                return { status: 1, stdout: "", stderr: "copy is unavailable for this stopped target" };
            }
            if (argv[0] === "rm") {
                expect(argv).toEqual(["rm", "-f", helperId]);
                expect(options).toMatchObject({ timeout: 5000, killSignal: "SIGKILL", stdio: "ignore" });
                return { status: 0, stdout: "", stderr: "" };
            }
            expect(argv[0]).toBe("run");
            const cidPath = argv[argv.indexOf("--cidfile") + 1]; helperDirectories.push(dirname(cidPath));
            expect(lstatSync(dirname(cidPath)).mode & 0o777).toBe(0o700);
            const markerPath = argv.at(-1)!;
            expect(markerPath).toMatch(/^\/project\/repo-id\/\.ccc-mount-identity-[a-f0-9]{32}$/);
            expect(argv).toEqual([
                "run", "--rm", "--pull", "never", "--cidfile", cidPath, "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--user", "0:0", "--workdir", "/", "--env", "LD_PRELOAD=", "--env", "LD_LIBRARY_PATH=",
                "--volumes-from", `${exactId}:ro`, "--entrypoint", "/usr/bin/cat", imageId, "--", markerPath,
            ]);
            expect(options).toMatchObject({ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000, killSignal: "SIGKILL", maxBuffer: 4096 });
            expect(native.begin).toHaveBeenCalledExactlyOnceWith(guard, runtime.getRuntimeInvocation());
            writeFileSync(cidPath, mode === "timeout old cid" ? exactId : mode === "timeout invalid cid" ? "not-a-full-cid" : helperId, { mode: 0o600 });
            const nonce = readFileSync(join(project, basename(markerPath)), "utf8");
            if (mode === "changed host") {
                renameSync(project, `${project}.previous`); renameSync(mkdtempSync(join(root, "replacement-")), project);
            }
            if (mode.startsWith("timeout")) return { status: null, error: Object.assign(new Error("helper timed out"), { code: "ETIMEDOUT" }) };
            if (mode === "signaled") return { status: 0, signal: "SIGTERM", stdout: nonce };
            if (mode === "failed") return { status: 9, stdout: nonce };
            return { status: 0, stdout: mode === "wrong" ? "d".repeat(64) : nonce };
        });
        const result = proveStoppedContainerProjectBindSource(exactId, project, "/project/repo-id", captureBindMountSourceIdentity(project), { imageId, bindGuard: guard, mountDestinations });
        for (const directory of helperDirectories) expect(existsSync(directory)).toBe(false);
        return { result, order, ticket };
    }
    it("falls back from retryable cp to the trusted read-only inherited target and settles only its own helper", () => {
        const f = inheritedProof();
        expect(f.result.kind).toBe("verified"); expect(f.order).toEqual(["cp", "begin", "run", "settle"]);
        expect(native.settle).toHaveBeenCalledExactlyOnceWith(guard, f.ticket);
        expect(calls.some(args => args[0] === "start" || args[0] === "exec")).toBe(false);
    });
    it("settles a completed helper's creation ticket even when its nonce is wrong", () => {
        const f = inheritedProof("wrong");
        expect(f.result.kind).toBe("mismatch"); expect(native.settle).toHaveBeenCalledExactlyOnceWith(guard, f.ticket);
        expect(f.order).toEqual(["cp", "begin", "run", "settle"]);
    });
    it.each(["timeout", "signaled", "failed"] as const)("keeps creation uncertain after %s even when exact helper cleanup succeeds", mode => {
        const f = inheritedProof(mode);
        expect(f.result.kind).not.toBe("verified"); expect(f.order).toEqual(["cp", "begin", "run", "rm"]);
        expect(native.settle).not.toHaveBeenCalled();
    });
    it.each(["timeout old cid", "timeout invalid cid"] as const)("does not force-remove the old target or a malformed helper identity after %s", mode => {
        const f = inheritedProof(mode);
        expect(f.result.kind).not.toBe("verified"); expect(f.order).toEqual(["cp", "begin", "run"]);
        expect(native.settle).not.toHaveBeenCalled();
    });
    it("rejects host object replacement after a clean helper result", () => {
        const f = inheritedProof("changed host");
        expect(f.result.kind).not.toBe("verified"); expect(native.settle).toHaveBeenCalledExactlyOnceWith(guard, f.ticket);
    });
    it.each(["/", "/usr", "/usr/bin/cat", "/bin", "/lib64", "/etc/ld.so.preload", "/home", "/run", "/run/ccc-device-broker-auth/other.json", "/project/repo-id/../../usr", "/home/ccc//.codex", "/home/ccc/../other", "/project\\repo-id", "relative", ""])("refuses inherited executable/loader or malformed destination %j before helper creation", destination => {
        const f = inheritedProof("match", [...allowedDestinations, destination]);
        expect(f.result.kind).not.toBe("verified"); expect(f.order).toEqual(["cp"]);
        expect(native.begin).not.toHaveBeenCalled(); expect(native.settle).not.toHaveBeenCalled();
    });
});


describe("native stopped replacement qualification", () => {
    it.each(["verified", "wrong nonce", "unknown helper", "started meanwhile", "changed exact id", "changed host", "executable shadow"] as const)("qualifies the exact provisional target without starting its old image: %s", fault => {
        const projectMount = `/project/${getProjectId(project)}`;
        const imageId = `sha256:${"b".repeat(64)}`, helperId = "c".repeat(64), guard = Object.freeze({ root: join(homedir(), ".ccc") }) as RuntimeBindGuard;
        let helperCompleted = false;
        native.begin.mockReturnValue(Object.freeze({}));
        native.spawnSync.mockImplementation((...call: unknown[]) => {
            const [, argv] = normalizeNativeRuntimeCall(call) as [string, string[]]; calls.push(argv);
            if (argv[0] === "inspect" && argv.includes("{{.Id}}")) return { status: 0, stdout: imageId };
            if (argv[0] === "inspect") return { status: 0, stdout: JSON.stringify({
                Id: helperCompleted && fault === "changed exact id" ? "d".repeat(64) : exactId,
                State: { Running: helperCompleted && fault === "started meanwhile" },
                Config: { Labels: { "ccc.managed": "true", "ccc.project.path": project } },
                Mounts: [{ Type: "bind", Source: project, Destination: projectMount, RW: true },
                    { Type: "bind", Source: join(project, "unused-owner-auth"), Destination: "/run/ccc-device-broker-auth/owner.json", RW: false },
                    ...(fault === "executable shadow" ? [{ Type: "bind", Source: project, Destination: "/usr/bin/cat", RW: false }] : [])],
            }) };
            if (argv[0] === "cp") { destinations.push(argv[2]); return { status: 1, stderr: "stopped copy unsupported" }; }
            if (argv[0] === "rm") { expect(argv).toEqual(["rm", "-f", helperId]); return { status: 0 }; }
            expect(argv[0]).toBe("run"); expect(argv).toContain(`${exactId}:ro`); expect(argv).toContain(imageId);
            const marker = argv.at(-1)!;
            const nonce = readFileSync(join(project, basename(marker)), "utf8");
            writeFileSync(argv[argv.indexOf("--cidfile") + 1], helperId);
            helperCompleted = true;
            if (fault === "changed host") {
                renameSync(project, `${project}.previous`); renameSync(mkdtempSync(join(root, "replacement-")), project);
            }
            return fault === "unknown helper" ? { status: null, signal: "SIGTERM", stdout: "" }
                : { status: 0, stdout: fault === "wrong nonce" ? "e".repeat(64) : nonce };
        });
        const ports = createNativeContainerExecPorts({ ensureDirectories() {}, ensureProjectTools: async () => {}, assetDirectory: root, trustedCliPath: join(root, "unused-cli") });
        expect(ports.verifyStoppedSessionContainerForReplacement(project, undefined, exactId, guard)).toBe(fault === "verified");
        expect(calls.some(args => args[0] === "start" || args[0] === "exec" || args.includes("--force"))).toBe(false);
        if (fault === "executable shadow") {
            expect(calls.some(args => args[0] === "run")).toBe(false); expect(native.begin).not.toHaveBeenCalled();
        } else expect(calls.filter(args => args[0] === "run")).toHaveLength(1);
        if (fault === "unknown helper") expect(native.settle).not.toHaveBeenCalled();
    });
});
