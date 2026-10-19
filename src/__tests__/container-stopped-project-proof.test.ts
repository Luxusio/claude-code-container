import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as runtime from "../container-runtime.js";
import { captureBindMountSourceIdentity, proveStoppedContainerProjectBindSource } from "../adapters/container-mount-observations.js";
import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "./helpers/native-runtime-fixture.js";

const native = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("child_process", async () => ({ ...await vi.importActual("child_process"), spawnSync: native.spawnSync }));

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
    native.spawnSync.mockReset();
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
