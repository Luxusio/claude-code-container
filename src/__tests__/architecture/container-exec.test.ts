import {describe, expect, it, vi} from "vitest";
import {createContainerExec, containerExecReplacementBlockReason} from "../../application/container-exec.js";
import type {ContainerExecPorts} from "../../ports/container-exec.js";
import type {RuntimeBindGuard} from "../../ports/runtime-bind-authority.js";
import {createDefaultToolCatalog} from "../../domain/tool-registry.js";
import {createContainerExistingLifecycle} from "../../application/container-existing-lifecycle.js";
import {createNativeContainerExecPorts} from "../../composition/container-exec.js";
import {assertBindMountSourceIdentity, captureBindMountSourceIdentity} from "../../adapters/container-mount-observations.js";
import {inspectSessionContainerOwnership} from "../../docker.js";
import * as nativeRuntime from "../../container-runtime.js";
import {getProjectId} from "../../utils.js";
import {chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {normalizeNativeRuntimeCall, preloadNativeRuntimeFixture} from "../helpers/native-runtime-fixture.js";

const stoppedNative = vi.hoisted(() => ({spawnSync: vi.fn()}));
vi.mock("child_process", async () => ({...await vi.importActual("child_process"), spawnSync: stoppedNative.spawnSync}));
const originalNativePlatform = process.platform;

function fixture(options: {running?: boolean; replace?: boolean} = {}) {
    const catalog = createDefaultToolCatalog(), events: string[] = [];
    const handle: symbol = Symbol("owned preparation");
    // This application owner supplies an opaque port value; native qualification
    // and actual codex-state.lock contention belong to the integration owner.
    const stateGuard = Object.freeze({root: "/owned"}) as RuntimeBindGuard;
    const forwarded: Array<[string, string]> = [["DUPLICATE", "first"], ["DUPLICATE", "last"]];
    const entries: Array<[string, string]> = [["container", "docker"], ...forwarded, ["MISE_TRUSTED_CONFIG_PATHS", "/project/repo-id"], ["TZ", "Host/Zone"]];
    let first = true;
    const ports: ContainerExecPorts<typeof handle> = {
        ensureRuntime: vi.fn(), resolveProject: () => "/project/repo", ensureDirectories: vi.fn(), ensureProjectTools: async () => {},
        projectId: () => "repo-id", debugEnabled: () => false, terminalReady: () => false, runtime: () => "docker",
        tool: name => catalog.find(tool => tool.name === name), defaultTool: () => catalog[0],
        isWorktreeWorkspace: () => false, assertWorkspace: vi.fn(),
        async familyLock<T>(_id: string, operation: () => Promise<T> | T): Promise<T> { return operation(); },
        acquireOwnership: async () => ({lockFile: "/owned/session.lock", existingId: options.running ? "final-id" : null}),
        inspectSessionContainer: () => ({known: true, containerId: options.running ? "final-id" : null}),
        verifyStoppedSessionContainerForReplacement: vi.fn(() => false),
        ensureClipboard: async () => null, validateClipboard: async selection => selection,
        clipboardPortFile: () => "/owned/clipboard.port", clipboardConnection: () => ({}),
        worktreeMounts: () => [], containerName: () => "ccc-repo",
        containerStatus: () => ({exists: true, running: Boolean(options.running), containerId: options.running ? "final-id" : "setup-id", imageId: "image-id"}),
        sessionClaims: () => ["session.lock"], lockName: () => "session.lock", prepareDeviceBroker: async () => {},
        async lifecycleLock<T>(_prefix: string, operation: () => Promise<T> | T): Promise<T> { return operation(); },
        async setupLock<T>(_prefix: string, operation: () => Promise<T> | T): Promise<T> { return operation(); },
        async stateLock<T>(operation: (guard: RuntimeBindGuard) => Promise<T> | T): Promise<T> { return operation(stateGuard); },
        prepareContainer: () => ({start: (...args) => ports.startContainer(...args), initialize: vi.fn()}),
        startContainer: (_path, _ensure, _mounts, _port, _profile, _recreate, _replacement, onReady, _expected, onStarted, _guard, onBeforeMutation) => {
            const id = options.replace && first ? "setup-id" : "final-id"; first = false;
            if (!options.running) { onBeforeMutation?.(); onStarted(id); } onReady(id, {startedByInvocation: !options.running}); return "ccc-repo";
        },
        beginSessionStartupInHeldLifecycleLock: vi.fn(), recordSessionOwnStartInHeldLifecycleLock: vi.fn(),
        publishSessionReadyInHeldLifecycleLock: vi.fn(), setCleanupEnabled: vi.fn(),
        confirmOwnership: vi.fn(async () => { events.push("confirm"); }),
        configLock<T>(operation: () => T): T { return operation(); },
        restoreConfig: vi.fn(() => { events.push("restore"); }), ensureUv: vi.fn(), buildMcpConfig: vi.fn(async () => []), setupProxy: vi.fn(),
        containerRunning: id => id !== "setup-id", installTools: vi.fn(), ensureClaude: vi.fn(), prepareCodexConfig: vi.fn(), assertCodexState: vi.fn(), ensureCodexHarness: vi.fn(),
        syncClipboard: vi.fn(), ensureSocketAccess: vi.fn(), isRestartRequired: () => false,
        attachClipboardImage: vi.fn(async (_path, args) => { events.push("attach"); return {args}; }),
        installProjectTools: vi.fn(), startClipboardBridge: vi.fn(() => { events.push("bridge"); }),
        observeCommandEnvironment: vi.fn(() => ({forwarded, skippedKeys: [], containerMarker: ["container", "docker"] as const, hostLangPresent: true, hostTimezone: "Host/Zone", observedTimezone: "Observed/Zone"})),
        prepareCommand: vi.fn<ContainerExecPorts<symbol>["prepareCommand"]>(() => { events.push("prepare"); return handle; }),
        prepareCodexCommand: vi.fn<ContainerExecPorts<symbol>["prepareCodexCommand"]>(() => ({ok: true})),
        launchCommand: vi.fn(async () => { events.push("launch"); return 0; }),
        disposeCommand: vi.fn(() => { events.push("dispose"); }),
        reportConversationFiles: vi.fn(), setupFailure: cause => new Error("Container setup failed", {cause}),
        setupToolFailure: cause => new Error("Failed to install tools", {cause}),
        handoffFailure: () => new Error("Container handoff failed"), invalidRuntimeFailure: () => new Error("Invalid runtime"),
        cleanupSession: vi.fn(() => { events.push("cleanup"); }), report: vi.fn(),
    };
    return {ports, entries, handle, events, stateGuard, exec: createContainerExec(ports).exec};
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return {promise, resolve, reject};
}

async function settled<T>(promise: Promise<T>) {
    try { return {ok: true as const, value: await promise}; }
    catch (error) { return {ok: false as const, error}; }
}

describe("acquired session lifetime", () => {
    it.each([
        "runtime", "resolve", "directories", "project-tools", "project-id", "tool-selection",
        "workspace-detection", "family-before-acquire", "workspace-admission", "acquire", "family-acquire",
    ] as const)("does not clean unrelated ownership when %s fails before successful acquisition", async checkpoint => {
        const f = fixture(), failure = new Error(`pre-acquisition ${checkpoint}`);
        f.ports.acquireOwnership = vi.fn(async () => ({lockFile: "/owned/session.lock", existingId: null}));
        const fail = () => { throw failure; };
        switch (checkpoint) {
            case "runtime": f.ports.ensureRuntime = fail; break;
            case "resolve": f.ports.resolveProject = fail; break;
            case "directories": f.ports.ensureDirectories = fail; break;
            case "project-tools": f.ports.ensureProjectTools = async () => { throw failure; }; break;
            case "project-id": f.ports.projectId = fail; break;
            case "tool-selection": f.ports.tool = fail; break;
            case "workspace-detection": f.ports.isWorktreeWorkspace = fail; break;
            case "family-before-acquire": f.ports.familyLock = async () => { throw failure; }; break;
            case "workspace-admission": f.ports.assertWorkspace = fail; break;
            case "acquire": case "family-acquire": f.ports.acquireOwnership = vi.fn(async () => { throw failure; }); break;
        }
        const worktreeWorkspace = ["family-before-acquire", "workspace-admission", "family-acquire"].includes(checkpoint);
        await expect(f.exec("/repo", ["codex"], {worktreeWorkspace})).rejects.toBe(failure);
        expect(f.ports.acquireOwnership).toHaveBeenCalledTimes(checkpoint === "acquire" || checkpoint === "family-acquire" ? 1 : 0);
        expect(f.ports.cleanupSession).not.toHaveBeenCalled();
        expect(f.ports.restoreConfig).not.toHaveBeenCalled();
        expect(f.ports.disposeCommand).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
    });

    it.each([false, true])("retains cleanup responsibility after family release rejects (cleanup failure=%s)", async cleanupFails => {
        const f = fixture(), primary = new Error("family release failed"), cleanup = new Error("cleanup failed");
        let held = false;
        f.ports.familyLock = async (_id, operation) => {
            held = true;
            try { await operation(); }
            finally { held = false; f.events.push("family-release"); }
            throw primary;
        };
        vi.mocked(f.ports.cleanupSession).mockImplementation(() => {
            expect(held).toBe(false); f.events.push("cleanup"); if (cleanupFails) throw cleanup;
        });
        const result = await settled(f.exec("/repo", ["codex"], {worktreeWorkspace: true}));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("family release failure was swallowed");
        if (cleanupFails) {
            expect(result.error).toBeInstanceOf(AggregateError);
            expect(result.error).toMatchObject({errors: [primary, cleanup], cause: primary});
        } else expect(result.error).toBe(primary);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.events).toEqual(["family-release", "cleanup"]);
        expect(f.ports.restoreConfig).not.toHaveBeenCalled();
        expect(f.ports.disposeCommand).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
    });

    const startupFaults: Array<{
        name: string; wrapped: boolean; restores: number;
        install(f: ReturnType<typeof fixture>, failure: Error): void;
    }> = [
        {name: "synchronous clipboard startup", wrapped: false, restores: 0, install: (f, failure) => { f.ports.ensureClipboard = () => { throw failure; }; }},
        {name: "clipboard final selection validation", wrapped: true, restores: 0, install: (f, failure) => { f.ports.validateClipboard = async () => { throw failure; }; }},
        {name: "mount discovery", wrapped: false, restores: 0, install: (f, failure) => { f.ports.worktreeMounts = () => { throw failure; }; }},
        {name: "container name", wrapped: false, restores: 0, install: (f, failure) => { f.ports.containerName = () => { throw failure; }; }},
        {name: "container inspection", wrapped: false, restores: 0, install: (f, failure) => { f.ports.containerStatus = () => { throw failure; }; }},
        {name: "synchronous broker startup", wrapped: false, restores: 0, install: (f, failure) => { f.ports.prepareDeviceBroker = () => { throw failure; }; }},
        {name: "synchronous setup guard", wrapped: false, restores: 0, install: (f, failure) => { f.ports.setupLock = () => { throw failure; }; }},
        {name: "asynchronous setup guard", wrapped: true, restores: 0, install: (f, failure) => { f.ports.setupLock = async () => { throw failure; }; }},
        {name: "container preparation", wrapped: true, restores: 0, install: (f, failure) => { f.ports.prepareContainer = () => { throw failure; }; }},
        {name: "state admission", wrapped: true, restores: 0, install: (f, failure) => { f.ports.stateLock = async () => { throw failure; }; }},
        {name: "lifecycle admission", wrapped: true, restores: 0, install: (f, failure) => { f.ports.lifecycleLock = async () => { throw failure; }; }},
        {name: "startup initialization", wrapped: true, restores: 0, install: (f, failure) => { f.ports.prepareContainer = () => ({start: f.ports.startContainer, initialize: () => { throw failure; }}); }},
        {name: "asynchronous MCP setup", wrapped: true, restores: 1, install: (f, failure) => { vi.mocked(f.ports.buildMcpConfig).mockRejectedValue(failure); }},
        {name: "project tool setup", wrapped: true, restores: 1, install: (f, failure) => { vi.mocked(f.ports.installProjectTools).mockImplementation(() => { throw failure; }); }},
        {name: "Codex configuration", wrapped: true, restores: 1, install: (f, failure) => { vi.mocked(f.ports.prepareCodexConfig).mockImplementation(() => { throw failure; }); }},
        {name: "clipboard synchronization", wrapped: true, restores: 1, install: (f, failure) => { vi.mocked(f.ports.syncClipboard).mockImplementation(() => { throw failure; }); }},
        {name: "clipboard connection", wrapped: false, restores: 1, install: (f, failure) => { f.ports.clipboardConnection = () => { throw failure; }; }},
        {name: "synchronous clipboard attachment", wrapped: false, restores: 1, install: (f, failure) => { vi.mocked(f.ports.attachClipboardImage).mockImplementation(() => { throw failure; }); }},
        {name: "asynchronous clipboard attachment", wrapped: false, restores: 1, install: (f, failure) => { vi.mocked(f.ports.attachClipboardImage).mockRejectedValue(failure); }},
        {name: "clipboard bridge", wrapped: false, restores: 1, install: (f, failure) => { vi.mocked(f.ports.startClipboardBridge).mockImplementation(() => { throw failure; }); }},
        {name: "environment observation", wrapped: false, restores: 1, install: (f, failure) => { vi.mocked(f.ports.observeCommandEnvironment).mockImplementation(() => { throw failure; }); }},
        {name: "environment report", wrapped: false, restores: 1, install: (f, failure) => {
            vi.mocked(f.ports.observeCommandEnvironment).mockReturnValue({forwarded: [], skippedKeys: ["TOO_LARGE"], containerMarker: ["container", "docker"], hostLangPresent: true});
            vi.mocked(f.ports.report).mockImplementation(report => { if (report.kind === "environment-skipped") throw failure; });
        }},
    ];
    it.each(startupFaults)("cleans once after $name failure using only its original restoration context", async fault => {
        const f = fixture(), failure = new Error(fault.name);
        fault.install(f, failure);
        const result = await settled(f.exec("/repo", ["codex"], {}, "work"));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("startup failure was swallowed");
        if (fault.wrapped) expect(result.error).toMatchObject({message: "Container setup failed", cause: failure});
        else expect(result.error).toBe(failure);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.ports.restoreConfig).toHaveBeenCalledTimes(fault.restores);
        for (const call of vi.mocked(f.ports.restoreConfig).mock.calls) expect(call).toEqual(["final-id", "work"]);
        expect(f.ports.disposeCommand).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.events.at(-1)).toBe("cleanup");
    });

    it.each(["resolve", "reject"] as const)("does not clean a held acquisition before it can %s", async completion => {
        const f = fixture(), gate = deferred<{lockFile: string; existingId: null}>(), entered = deferred<void>();
        const failure = new Error("ownership refused");
        f.ports.acquireOwnership = async () => { entered.resolve(); return gate.promise; };
        const result = settled(f.exec("/repo", ["codex"]));
        await entered.promise;
        expect(f.ports.cleanupSession).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        if (completion === "resolve") gate.resolve({lockFile: "/owned/session.lock", existingId: null});
        else gate.reject(failure);
        const outcome = await result;
        if (completion === "resolve") expect(outcome).toEqual({ok: true, value: 0});
        else expect(outcome).toEqual({ok: false, error: failure});
        expect(f.ports.cleanupSession).toHaveBeenCalledTimes(completion === "resolve" ? 1 : 0);
    });

    it.each(["setup", "startup-ack", "failure-ack", "command-ack", "command"] as const)("waits for held %s success and rejection before finalization", async checkpoint => {
        for (const rejects of [false, true]) {
            const f = fixture(), gate = deferred<void>(), entered = deferred<void>();
            const primary = new Error("initialization failed"), failure = new Error(`${checkpoint} rejected`);
            const wait = async () => { entered.resolve(); await gate.promise; };
            if (checkpoint === "setup") vi.mocked(f.ports.buildMcpConfig).mockImplementation(async () => { await wait(); return []; });
            else if (checkpoint === "command") vi.mocked(f.ports.launchCommand).mockImplementation(async () => { await wait(); return 29; });
            else {
                let acknowledgements = 0;
                if (checkpoint === "failure-ack") {
                    f.ports.prepareContainer = () => ({start: f.ports.startContainer, initialize: () => { throw primary; }});
                    vi.mocked(f.ports.report).mockImplementation(report => { if (report.kind === "ownership-unconfirmed") throw new Error("report failed"); });
                }
                vi.mocked(f.ports.confirmOwnership).mockImplementation(async () => {
                    acknowledgements++;
                    if ((checkpoint === "startup-ack" && acknowledgements === 1)
                        || (checkpoint === "failure-ack" && acknowledgements === 2)
                        || (checkpoint === "command-ack" && vi.mocked(f.ports.prepareCommand).mock.calls.length > 0)) await wait();
                });
            }
            const result = settled(f.exec("/repo", ["codex"]));
            await entered.promise;
            expect(f.ports.cleanupSession).not.toHaveBeenCalled();
            expect(f.ports.disposeCommand).not.toHaveBeenCalled();
            if (checkpoint !== "command") expect(f.ports.launchCommand).not.toHaveBeenCalled();
            if (rejects) gate.reject(failure); else gate.resolve();
            const outcome = await result;
            if (checkpoint === "failure-ack") {
                expect(outcome).toMatchObject({ok: false, error: {message: "Container setup failed", cause: primary}});
                if (rejects) expect(f.ports.report).toHaveBeenCalledWith({kind: "ownership-unconfirmed"});
            } else if (rejects) {
                if (checkpoint === "setup" || checkpoint === "startup-ack") expect(outcome).toMatchObject({ok: false, error: {cause: failure}});
                else expect(outcome).toEqual({ok: false, error: failure});
            } else expect(outcome).toEqual({ok: true, value: checkpoint === "command" ? 29 : 0});
            expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
            expect(f.ports.disposeCommand).toHaveBeenCalledTimes(checkpoint === "command" || checkpoint === "command-ack" || (!rejects && checkpoint !== "failure-ack") ? 1 : 0);
        }
    });

    it.each([false, true])("never replaces a stopped legacy candidate before live-ready (own start=%s)", async started => {
        const f = fixture(), remove = vi.fn(), failure = new Error("live verification unavailable");
        f.ports.acquireOwnership = async () => ({lockFile: "/owned/session.lock", existingId: "setup-id", requiresLiveVerification: true});
        f.ports.startContainer = (...args) => {
            expect(args[6](remove)).toBe(false);
            if (started) { args[11]?.(); args[9]("setup-id"); }
            expect(args[6](remove)).toBe(false);
            throw failure;
        };
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(remove).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).toHaveBeenCalledTimes(started ? 1 : 0);
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
    });

    it.each(["verified", "unverified", "peer", "changed-id"] as const)("requalifies a provisional stopped upgrade under both guards and retains normal replacement checks: %s", outcome => {
        const f = fixture(), oldId = "a".repeat(64), nextId = "b".repeat(64), replacement = vi.fn();
        let stateHeld = false, lifecycleHeld = false;
        f.ports.acquireOwnership = async () => ({lockFile: "/owned/session.lock", existingId: oldId, requiresLiveVerification: true});
        f.ports.containerStatus = () => ({exists: true, running: false, containerId: oldId, imageId: "old-image"});
        f.ports.stateLock = async operation => { stateHeld = true; try { return await operation(f.stateGuard); } finally { stateHeld = false; } };
        f.ports.lifecycleLock = async (_prefix, operation) => { lifecycleHeld = true; try { return await operation(); } finally { lifecycleHeld = false; } };
        f.ports.verifyStoppedSessionContainerForReplacement = vi.fn((path, profile, expectedId, guard) => {
            expect(stateHeld).toBe(true); expect(lifecycleHeld).toBe(true);
            expect([path, profile, expectedId, guard]).toEqual(["/project/repo", undefined, oldId, f.stateGuard]);
            if (outcome === "peer") f.ports.sessionClaims = () => ["session.lock", "other.lock"];
            if (outcome === "changed-id") f.ports.containerStatus = () => ({exists: true, running: false, containerId: nextId, imageId: "other-image"});
            return outcome !== "unverified";
        });
        f.ports.startContainer = (...args) => {
            const allowed = args[6](replacement);
            expect(allowed).toBe(outcome === "verified");
            throw new Error("controlled preflight ends here");
        };
        return expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: {message: "controlled preflight ends here"}}).then(() => {
            expect(f.ports.verifyStoppedSessionContainerForReplacement).toHaveBeenCalledOnce();
            expect(replacement).toHaveBeenCalledTimes(outcome === "verified" ? 1 : 0);
            expect(f.ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
            expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        });
    });

    it.each(["missing", "stale"])("replaces a stopped incompatible container through the real session guard after %s fingerprint bind proof", async fingerprint => {
        const root = mkdtempSync(join(tmpdir(), "ccc-stopped-replacement-"));
        const oldId = "a".repeat(64), nextId = "b".repeat(64);
        const files = new Map([[".git", "gitdir: /persistent/git/worktrees/task\n"], ["untracked.txt", "local work\n"], ["scratch.txt", "AI scratch\n"]]);
        for (const [name, content] of files) writeFileSync(join(root, name), content);
        const sourceIdentity = captureBindMountSourceIdentity(root);
        const projectId = getProjectId(root), commands: string[][] = [];
        let removed = false;
        nativeRuntime._resetRuntimeCacheForTest();
        preloadNativeRuntimeFixture(nativeRuntime);
        stoppedNative.spawnSync.mockReset().mockImplementation((...call: unknown[]) => {
            const [, args] = normalizeNativeRuntimeCall(call) as [string, string[]];
            commands.push(args);
            if (args[0] === "ps") return {status: 0, stdout: removed ? "" : `${oldId}\n`};
            if (args[0] === "inspect") return {status: 0, stdout: JSON.stringify({
                Id: oldId, State: {Running: false}, Config: {Labels: {
                    "ccc.managed": "true", "ccc.project.path": root,
                    ...(fingerprint === "stale" ? {"ccc.project.mount-identity": "f".repeat(64)} : {}),
                }}, Mounts: [{Source: root, Destination: `/project/${projectId}`, Type: "bind", RW: true}],
            })};
            if (args[0] === "cp") {
                expect(args[1]).toMatch(new RegExp(`^${oldId}:/project/${projectId}/\\.ccc-mount-identity-[a-f0-9]{32}$`));
                writeFileSync(args[2], readFileSync(join(root, basename(args[1]))));
                return {status: 0, stdout: ""};
            }
            if (args[0] === "rm") { expect(args).toEqual(["rm", oldId]); removed = true; return {status: 0, stdout: oldId}; }
            throw new Error(`Unexpected native effect: ${JSON.stringify(args)}`);
        });
        const f = fixture();
        f.ports.resolveProject = () => root;
        f.ports.projectId = () => projectId;
        f.ports.containerStatus = () => ({exists: !removed, running: false, containerId: removed ? null : oldId, imageId: "old-image"});
        f.ports.inspectSessionContainer = inspectSessionContainerOwnership;
        f.ports.acquireOwnership = async (request, inspect) => {
            const ownership = inspect(request);
            if (!ownership.known || !ownership.containerId) throw new Error("native project ownership was not established");
            return {lockFile: "/owned/session.lock", existingId: ownership.containerId,
                ...(ownership.requiresLiveVerification ? {requiresLiveVerification: true} : {})};
        };
        const noEffect = () => undefined;
        const lifecycle = createContainerExistingLifecycle({
            listContainer: () => ({known: true, containerId: removed ? null : oldId}),
            identity: () => removed ? null : ({containerId: oldId, running: false}),
            managedIdentity: () => { throw new Error("running authority must not be used for stopped replacement"); },
            assertProjectSources: () => { assertBindMountSourceIdentity(root, sourceIdentity); },
            assertDeviceSources: noEffect, assertFilesystemSources: noEffect,
            inspectContract: (_id, reason) => { reason("container UID/GID does not match the host identity"); return false; },
            verifyBeforeSetup: noEffect,
            safeToDefer: (_id, reason) => { reason("container is not confirmed running for safe defer"); return false; },
            isRunning: () => false, canExec: () => false, canExecAfterBriefRetry: () => false,
            deviceSourcesMatch: () => true, syncMcp: noEffect, fixSsh: noEffect, syncGit: noEffect,
            start: () => { throw new Error("old image must never start"); }, stop: () => { throw new Error("stopped target needs no stop"); },
            remove: id => { nativeRuntime.runtimeSpawnSync(["rm", id], {encoding: "utf8", timeout: 30000}); },
            reportContractMismatch: noEffect, reportContractMatch: noEffect, reportRestart: noEffect,
            reportRecreation: noEffect, reportDeferred: noEffect,
            throwUnsafeDefer: reason => { throw new Error(reason); }, finish: noEffect,
        });
        f.ports.startContainer = (...args) => {
            expect(lifecycle.run({containerName: "ccc-repo", managedProjectPath: root, replacementGuard: args[6]})).toEqual({kind: "continue-to-create"});
            args[11]?.(); args[9](nextId); args[7](nextId, {startedByInvocation: true}); return "ccc-repo";
        };
        f.ports.containerRunning = () => true;
        try {
            await expect(f.exec(root, ["codex"])).resolves.toBe(0);
            expect(commands.filter(args => args[0] === "cp")).toHaveLength(1);
            expect(commands.filter(args => args[0] === "rm")).toEqual([["rm", oldId]]);
            expect(commands.some(args => ["start", "stop", "exec", "volume"].includes(args[0]))).toBe(false);
            for (const [name, content] of files) expect(readFileSync(join(root, name), "utf8")).toBe(content);
            expect(readdirSync(root).sort()).toEqual([...files.keys()].sort());
            expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenCalledWith(nextId, {startedByInvocation: true});
            expect(f.ports.launchCommand).toHaveBeenCalledOnce();
        } finally {
            nativeRuntime._resetRuntimeCacheForTest();
            rmSync(root, {recursive: true, force: true});
        }
    });

    it("uses normal guarded replacement only after a legacy candidate reaches verified live-ready", async () => {
        const f = fixture(), replace = vi.fn();
        f.ports.acquireOwnership = async () => ({lockFile: "/owned/session.lock", existingId: "setup-id", requiresLiveVerification: true});
        f.ports.startContainer = (...args) => {
            expect(args[6](replace)).toBe(false);
            args[11]?.(); args[9]("setup-id");
            expect(args[6](replace)).toBe(false);
            args[7]("setup-id", {startedByInvocation: true});
            expect(args[6](replace)).toBe(true);
            return "ccc-repo";
        };
        f.ports.containerRunning = () => true;
        await expect(f.exec("/repo", ["codex"])).resolves.toBe(0);
        expect(replace).toHaveBeenCalledOnce();
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });

    it("reused startup failure never grants permission to stop the joined container", async () => {
        const f = fixture({running: true}), failure = new Error("join initialization failed");
        f.ports.prepareContainer = () => ({start: f.ports.startContainer, initialize: () => { throw failure; }});
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenLastCalledWith("final-id", {startedByInvocation: false});
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
    });

    it.each([false, true])("pins a later readiness retry to the last positive target (own start=%s)", async ownStart => {
        const f = fixture(), id = "a".repeat(64), refusal = new Error("retry target disappeared");
        let attempts = 0, disappeared = false;
        f.ports.containerStatus = () => ({exists: false, running: false, containerId: null, imageId: null});
        f.ports.startContainer = (...args) => {
            if (++attempts === 1) {
                expect(args[8]).toBeUndefined();
                if (ownStart) { args[11]?.(); args[9](id); }
                args[7](id, {startedByInvocation: ownStart});
                return "ccc-repo";
            }
            expect(args[8]).toBe(id);
            throw refusal;
        };
        vi.mocked(f.ports.buildMcpConfig).mockImplementation(async () => { await Promise.resolve(); disappeared = true; return []; });
        f.ports.containerRunning = () => !disappeared;
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: refusal});
        expect(attempts).toBe(2);
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).toHaveBeenCalledTimes(ownStart ? 1 : 0);
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).toHaveBeenCalledTimes(ownStart ? 1 : 0);
        if (ownStart) expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).toHaveBeenLastCalledWith(id);
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenCalledExactlyOnceWith(id, {startedByInvocation: ownStart});
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });

    it.each([false, true])("settles captured-start acknowledgement before cleanup after a synchronous start failure (ACK rejects=%s)", async rejects => {
        const f = fixture(), gate = deferred<void>(), entered = deferred<void>();
        const primary = new Error("start helper failed after creating container"), acknowledgement = new Error("ACK failed");
        f.ports.startContainer = (...args) => { args[11]?.(); args[9]("partial-start-id"); throw primary; };
        vi.mocked(f.ports.confirmOwnership).mockImplementation(async () => { entered.resolve(); await gate.promise; });
        vi.mocked(f.ports.report).mockImplementation(report => { if (report.kind === "ownership-unconfirmed") throw new Error("report failed"); });
        const result = settled(f.exec("/repo", ["codex"]));
        await entered.promise;
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).toHaveBeenLastCalledWith("partial-start-id");
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
        expect(f.ports.cleanupSession).not.toHaveBeenCalled();
        if (rejects) gate.reject(acknowledgement); else gate.resolve();
        expect(await result).toMatchObject({ok: false, error: {message: "Container setup failed", cause: primary}});
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.ports.restoreConfig).not.toHaveBeenCalled();
        expect(f.ports.disposeCommand).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        if (rejects) expect(f.ports.report).toHaveBeenCalledWith({kind: "ownership-unconfirmed"});
    });

    it.each([undefined, "primitive failure", 17, {reason: "opaque failure"}])("preserves sole thrown value %j in startup and command including undefined", async failure => {
        for (const checkpoint of ["startup", "command"]) {
            const f = fixture();
            if (checkpoint === "startup") vi.mocked(f.ports.observeCommandEnvironment).mockImplementation(() => { throw failure; });
            else vi.mocked(f.ports.launchCommand).mockRejectedValue(failure);
            expect(await settled(f.exec("/repo", ["codex"]))).toEqual({ok: false, error: failure});
            expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        }
    });

    it.each([
        {label: "undefined primary", primary: undefined, cleanup: new Error("cleanup failed")},
        {label: "undefined cleanup", primary: "startup failed", cleanup: undefined},
        {label: "both undefined", primary: undefined, cleanup: undefined},
        {label: "opaque primary", primary: {reason: "startup failed"}, cleanup: "cleanup failed"},
    ])("preserves ordered startup and cleanup failures for $label despite throwing diagnostics", async ({primary, cleanup}) => {
        const f = fixture();
        vi.mocked(f.ports.observeCommandEnvironment).mockImplementation(() => { throw primary; });
        vi.mocked(f.ports.cleanupSession).mockImplementation(() => { throw cleanup; });
        vi.mocked(f.ports.report).mockImplementation(report => { if (report.kind === "cleanup-failed") throw new Error("report failed"); });
        const result = await settled(f.exec("/repo", ["codex"]));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("startup and cleanup failures were swallowed");
        expect(result.error).toBeInstanceOf(AggregateError);
        const aggregate = result.error as AggregateError;
        expect(aggregate.errors).toEqual([primary, cleanup]);
        expect(aggregate.cause).toBe(primary);
        expect(Object.hasOwn(aggregate, "cause")).toBe(true);
        expect(f.ports.report).toHaveBeenCalledWith({kind: "cleanup-failed", cause: cleanup});
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.ports.disposeCommand).not.toHaveBeenCalled();
    });

    it.each(["startup", "command"] as const)("keeps a caller AggregateError as one %s primary", async checkpoint => {
        const f = fixture(), primary = new AggregateError([new Error("inner one"), undefined], "caller aggregate");
        const cleanup = new Error("cleanup failed");
        if (checkpoint === "startup") vi.mocked(f.ports.observeCommandEnvironment).mockImplementation(() => { throw primary; });
        else vi.mocked(f.ports.launchCommand).mockRejectedValue(primary);
        vi.mocked(f.ports.cleanupSession).mockImplementation(() => { throw cleanup; });
        const result = await settled(f.exec("/repo", ["codex"]));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("caller aggregate was swallowed");
        expect(result.error).toBeInstanceOf(AggregateError);
        expect((result.error as AggregateError).errors).toEqual([primary, cleanup]);
        expect((result.error as AggregateError).errors[0]).toBe(primary);
        expect((result.error as AggregateError).cause).toBe(primary);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });

    it("keeps undefined command, disposal and cleanup failures flat and ordered", async () => {
        const f = fixture(), disposal = {reason: "disposal failed"};
        vi.mocked(f.ports.launchCommand).mockRejectedValue(undefined);
        vi.mocked(f.ports.disposeCommand).mockImplementation(() => { f.events.push("dispose"); throw disposal; });
        vi.mocked(f.ports.cleanupSession).mockImplementation(() => { f.events.push("cleanup"); throw undefined; });
        const result = await settled(f.exec("/repo", ["codex"]));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("command failures were swallowed");
        expect(result.error).toBeInstanceOf(AggregateError);
        expect((result.error as AggregateError).errors).toEqual([undefined, disposal, undefined]);
        expect((result.error as AggregateError).cause).toBeUndefined();
        expect(Object.hasOwn(result.error as AggregateError, "cause")).toBe(true);
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });

    it("distinguishes cleanup throwing undefined from successful cleanup", async () => {
        const f = fixture();
        vi.mocked(f.ports.launchCommand).mockResolvedValue(41);
        vi.mocked(f.ports.cleanupSession).mockImplementation(() => { throw undefined; });
        expect(await settled(f.exec("/repo", ["codex"]))).toEqual({ok: false, error: undefined});
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });

    it.each([false, true])("retains setupFailure's exact wrapper for undefined setup failure (cleanup failure=%s)", async cleanupFails => {
        const f = fixture(), wrapper = new Error("wrapped undefined", {cause: undefined}), cleanup = new Error("cleanup failed");
        f.ports.prepareContainer = () => ({start: f.ports.startContainer, initialize: () => { throw undefined; }});
        f.ports.setupFailure = vi.fn(() => wrapper);
        if (cleanupFails) vi.mocked(f.ports.cleanupSession).mockImplementation(() => { throw cleanup; });
        const result = await settled(f.exec("/repo", ["codex"]));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("undefined setup failure was swallowed");
        if (cleanupFails) expect(result.error).toMatchObject({errors: [wrapper, cleanup], cause: wrapper});
        else expect(result.error).toBe(wrapper);
        expect(f.ports.setupFailure).toHaveBeenCalledExactlyOnceWith(undefined);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });

    it("retains a refused command's status and finalizes without granting reused-container stop permission", async () => {
        const f = fixture({running: true});
        vi.mocked(f.ports.prepareCodexCommand).mockReturnValue({ok: false, status: 7, reason: "engine-unavailable"});
        await expect(f.exec("/repo", ["codex"])).resolves.toBe(7);
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.disposeCommand).toHaveBeenCalledExactlyOnceWith(f.handle);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });

    it.each(["status", "command-failure", "cleanup-failure", "debug-failure"] as const)("keeps conversation reporting after cleanup for %s", async outcome => {
        const f = fixture(), failure = new Error(outcome);
        f.ports.debugEnabled = () => true;
        vi.mocked(f.ports.launchCommand).mockResolvedValue(43);
        if (outcome === "command-failure") vi.mocked(f.ports.launchCommand).mockRejectedValue(failure);
        if (outcome === "cleanup-failure") vi.mocked(f.ports.cleanupSession).mockImplementation(() => { f.events.push("cleanup"); throw failure; });
        vi.mocked(f.ports.reportConversationFiles).mockImplementation(() => {
            expect(f.ports.cleanupSession).toHaveBeenCalledOnce(); f.events.push("conversation-report");
            if (outcome === "debug-failure") throw failure;
        });
        const result = await settled(f.exec("/repo", ["codex"]));
        expect(result).toEqual(outcome === "status" ? {ok: true, value: 43} : {ok: false, error: failure});
        const reports = outcome === "status" || outcome === "debug-failure" ? 1 : 0;
        expect(f.ports.reportConversationFiles).toHaveBeenCalledTimes(reports);
        expect(f.events.slice(-3 - reports)).toEqual(["restore", "dispose", "cleanup", ...(reports ? ["conversation-report"] : [])]);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });

    it("keeps rejected clipboard and broker startup nonfatal", async () => {
        const f = fixture(), clipboard = new Error("clipboard unavailable"), broker = new Error("broker unavailable");
        f.ports.ensureClipboard = vi.fn(async () => { throw clipboard; });
        f.ports.prepareDeviceBroker = vi.fn(async () => { throw broker; });
        f.ports.clipboardConnection = vi.fn(() => ({}));
        vi.mocked(f.ports.launchCommand).mockResolvedValue(47);
        await expect(f.exec("/repo", ["codex"])).resolves.toBe(47);
        expect(f.ports.clipboardConnection).toHaveBeenCalledWith(null);
        expect(f.ports.report).toHaveBeenCalledWith({kind: "broker-failed", cause: broker});
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });
});

describe("container exec semantic workflow", () => {
    it("drops a paused requester's retired selection before bind, environment and image attachment", async () => {
        const f = fixture(), stale = {port: 4321, token: "retired-token", portFile: "/owned/bridge-a.port"};
        f.ports.ensureClipboard = async () => stale;
        f.ports.clipboardPortFile = () => {throw new Error("must not reread an unrelated port path");};
        f.ports.validateClipboard = vi.fn(async (selected, guard) => {
            expect(selected).toBe(stale); expect(guard).toBe(f.stateGuard); return null;
        });
        f.ports.clipboardConnection = vi.fn(selected => {
            expect(selected).toBeNull(); return {};
        });
        const start = f.ports.startContainer; f.ports.startContainer = vi.fn(start);
        await f.exec("/repo", ["codex"]);
        expect(f.ports.validateClipboard).toHaveBeenCalledOnce();
        expect(vi.mocked(f.ports.startContainer).mock.calls[0][3]).toBeUndefined();
        expect(f.ports.clipboardConnection).toHaveBeenCalledWith(null);
        expect(f.ports.attachClipboardImage).toHaveBeenCalledWith("/project/repo", ["codex"], {enabled: true, clipboardUrl: undefined, clipboardToken: undefined});
        const intent = vi.mocked(f.ports.prepareCommand).mock.calls[0][0];
        expect(intent.environment.some(([key]) => key === "CCC_CLIPBOARD_URL" || key === "CCC_CLIPBOARD_TOKEN")).toBe(false);
    });
    it("uses the one final guarded selection for the bind, connection, image and environment", async () => {
        const f = fixture(), selected = Object.freeze({port: 4321, token: "current-token", portFile: "/owned/bridge-a.port"});
        let validated = false;
        f.ports.ensureClipboard = async () => selected;
        f.ports.clipboardPortFile = () => {throw new Error("must not mix a later port-file lookup into the selection");};
        f.ports.validateClipboard = vi.fn(async (candidate, guard) => {
            expect(candidate).toBe(selected); expect(guard).toBe(f.stateGuard); validated = true; return selected;
        });
        f.ports.clipboardConnection = vi.fn(candidate => {
            expect(validated).toBe(true); expect(candidate).toBe(selected); return {url: `http://127.0.0.1:${candidate!.port}`, token: candidate!.token};
        });
        const start = f.ports.startContainer;
        f.ports.startContainer = vi.fn<ContainerExecPorts<symbol>["startContainer"]>((...args) => {
            expect(validated).toBe(true); expect(args[3]).toBe(selected.portFile); expect(args[10]).toBe(f.stateGuard); return start(...args);
        });
        await f.exec("/repo", ["codex"]);
        const connection = {url: "http://127.0.0.1:4321", token: "current-token"};
        expect(f.ports.startClipboardBridge).toHaveBeenCalledWith("final-id", connection);
        expect(f.ports.attachClipboardImage).toHaveBeenCalledWith("/project/repo", ["codex"], {enabled: true, clipboardUrl: connection.url, clipboardToken: connection.token});
        expect(vi.mocked(f.ports.prepareCommand).mock.calls[0][0].environment).toEqual(expect.arrayContaining([
            ["CCC_CLIPBOARD_URL", connection.url], ["CCC_CLIPBOARD_TOKEN", connection.token],
        ]));
    });
    it.each(["codex", "claude"])("reuses the immutable legacy mount while %s uses the guarded current generation", async tool => {
        const f = fixture({running: true});
        const selected = Object.freeze({port: 4322, token: "current-generation-token",
            portFile: "/owned/generations/a1b2c3d4e5f6/clipboard.port", generation: "a1b2c3d4e5f6"});
        const legacyMount = "/owned/legacy/clipboard.port";
        const connection = {url: "http://host.docker.internal:4322", hostUrl: "http://127.0.0.1:4322",
            token: selected.token, generation: selected.generation};
        f.ports.ensureClipboard = vi.fn(async () => selected);
        f.ports.clipboardPortFile = vi.fn(() => legacyMount);
        let validated = false, bridgeReady = false;
        f.ports.validateClipboard = vi.fn(async (candidate, guard) => {
            expect(candidate).toBe(selected); expect(guard).toBe(f.stateGuard);
            validated = true; return selected;
        });
        f.ports.clipboardConnection = vi.fn(candidate => {
            expect(validated).toBe(true); expect(candidate).toBe(selected); return connection;
        });
        const start = f.ports.startContainer;
        f.ports.startContainer = vi.fn<ContainerExecPorts<symbol>["startContainer"]>((...args) => {
            expect(validated).toBe(true);
            expect(args[3]).toBe(legacyMount);
            expect(args[8]).toBe("final-id");
            expect(args[10]).toBe(f.stateGuard);
            return start(...args);
        });
        vi.mocked(f.ports.startClipboardBridge).mockImplementation((target, candidate) => {
            expect(target).toBe("final-id"); expect(candidate).toEqual(connection);
            bridgeReady = true; f.events.push("bridge-ready");
        });
        vi.mocked(f.ports.prepareCommand).mockImplementation(() => {
            expect(bridgeReady).toBe(true); f.events.push("prepare"); return f.handle;
        });
        await expect(f.exec("/repo", [tool])).resolves.toBe(0);
        expect(f.ports.clipboardPortFile).toHaveBeenCalledOnce();
        expect(f.ports.validateClipboard).toHaveBeenCalledOnce();
        expect(f.ports.startContainer).toHaveBeenCalledOnce();
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        if (tool === "codex") {
            expect(f.ports.attachClipboardImage).toHaveBeenCalledExactlyOnceWith("/project/repo", [tool],
                {enabled: true, clipboardUrl: connection.hostUrl, clipboardToken: connection.token});
            expect(f.events.indexOf("attach")).toBeLessThan(f.events.indexOf("bridge-ready"));
        } else expect(f.ports.attachClipboardImage).not.toHaveBeenCalled();
        const environment = vi.mocked(f.ports.prepareCommand).mock.calls[0][0].environment;
        expect(environment).toEqual(expect.arrayContaining([
            ["CCC_CLIPBOARD_URL", connection.url], ["CCC_CLIPBOARD_TOKEN", connection.token],
            ["CCC_CLIPBOARD_GENERATION", selected.generation], ["BROWSER", "/usr/local/bin/ccc-open-url"],
        ]));
        expect(environment.filter(([key]) => key === "CCC_CLIPBOARD_GENERATION")).toHaveLength(1);
        expect(f.events.indexOf("bridge-ready")).toBeLessThan(f.events.indexOf("prepare"));
        expect(f.events.indexOf("bridge-ready")).toBeLessThan(f.events.indexOf("launch"));
    });
    it.each(["codex", "claude"])("does not launch %s after finite first clipboard sync is refused", async tool => {
        const f = fixture({running: true}), failure = new Error("clipboard bridge initial sync was not confirmed");
        f.ports.clipboardConnection = () => ({url: "http://host.docker.internal:4322", token: "current-token",
            hostUrl: "http://127.0.0.1:4322", generation: "a1b2c3d4e5f6"});
        vi.mocked(f.ports.startClipboardBridge).mockImplementation(() => {
            f.events.push("first-sync-refused"); throw failure;
        });
        await expect(f.exec("/repo", [tool])).rejects.toBe(failure);
        if (tool === "codex") expect(f.ports.attachClipboardImage).toHaveBeenCalledOnce();
        else expect(f.ports.attachClipboardImage).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.disposeCommand).not.toHaveBeenCalled();
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.events.slice(-2)).toEqual(["first-sync-refused", "cleanup"]);
    });
    it("publishes startup intent, positive own start and ready while the one lifecycle guard is held", async () => {
        const f = fixture(), publications: string[] = [];
        let held = false;
        f.ports.lifecycleLock = async (_prefix, operation) => {
            expect(held).toBe(false);
            held = true;
            try { return await operation(); } finally { held = false; publications.push("released"); }
        };
        f.ports.beginSessionStartupInHeldLifecycleLock = vi.fn(() => { expect(held).toBe(true); publications.push("intent"); });
        f.ports.recordSessionOwnStartInHeldLifecycleLock = vi.fn(id => { expect(held).toBe(true); expect(id).toBe("final-id"); publications.push("own-start"); });
        f.ports.publishSessionReadyInHeldLifecycleLock = vi.fn((id, handoff) => {
            expect(held).toBe(true); expect(id).toBe("final-id"); expect(handoff).toEqual({startedByInvocation: true}); publications.push("ready");
        });
        f.ports.startContainer = (...args) => {
            expect(publications).toEqual([]);
            args[11]?.();
            expect(publications).toEqual(["intent"]);
            args[9]("final-id");
            args[11]?.(); // Repeated native boundaries must not reset own-start evidence.
            expect(publications).toEqual(["intent", "own-start"]);
            // A late reuse observation must not discard this invocation's
            // positively recorded native start of the same exact target.
            args[7]("final-id", {startedByInvocation: false});
            return "ccc-repo";
        };
        vi.mocked(f.ports.confirmOwnership).mockImplementation(async () => { expect(held).toBe(false); publications.push("ack"); });
        const initialize = vi.fn(() => { expect(held).toBe(false); expect(publications.slice(0, 5)).toEqual(["intent", "own-start", "ready", "released", "ack"]); });
        f.ports.prepareContainer = () => ({start: f.ports.startContainer, initialize});
        await expect(f.exec("/repo", ["codex"])).resolves.toBe(0);
        expect(initialize).toHaveBeenCalledOnce();
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).toHaveBeenCalledOnce();
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenCalledOnce();
    });

    it.each(["intent", "own-start", "ready"] as const)("a failed durable %s publication cannot continue into initialization or command execution", async checkpoint => {
        const f = fixture(), failure = new Error("durable publication rejected: " + checkpoint);
        const initialize = vi.fn();
        f.ports.prepareContainer = () => ({start: f.ports.startContainer, initialize});
        if (checkpoint === "intent") f.ports.beginSessionStartupInHeldLifecycleLock = vi.fn(() => { throw failure; });
        else if (checkpoint === "own-start") f.ports.recordSessionOwnStartInHeldLifecycleLock = vi.fn(() => { throw failure; });
        else f.ports.publishSessionReadyInHeldLifecycleLock = vi.fn(() => { throw failure; });
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(initialize).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        if (checkpoint === "intent") expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        if (checkpoint !== "ready") expect(f.ports.publishSessionReadyInHeldLifecycleLock).not.toHaveBeenCalled();
    });

    it("a reused ready target publishes no own-start compensation before a failing helper", async () => {
        const f = fixture({running: true}), failure = new Error("joined initialization failed");
        f.ports.prepareContainer = () => ({start: f.ports.startContainer, initialize: () => { throw failure; }});
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenCalledExactlyOnceWith("final-id", {startedByInvocation: false});
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });

    it("prepares once before mutation locks and initializes after release and ownership acknowledgement", async () => {
        const f = fixture();
        let stateHeld = false, lifecycleHeld = false, setupHeld = false;
        f.ports.setupLock = async (_prefix, operation) => { setupHeld = true; try { return await operation(); } finally { setupHeld = false; } };
        f.ports.stateLock = async operation => { expect(setupHeld).toBe(true); stateHeld = true; try { return await operation(f.stateGuard); } finally { stateHeld = false; } };
        f.ports.lifecycleLock = async (_prefix, operation) => { expect(stateHeld).toBe(true); lifecycleHeld = true; try { return await operation(); } finally { lifecycleHeld = false; } };
        const initialize = vi.fn((id: string) => {
            expect(id).toBe("final-id"); expect(setupHeld).toBe(true);
            expect(stateHeld).toBe(false); expect(lifecycleHeld).toBe(false);
            expect(f.ports.confirmOwnership).toHaveBeenCalled();
        });
        const prepare = vi.fn(() => {
            expect(setupHeld).toBe(true); expect(stateHeld).toBe(false); expect(lifecycleHeld).toBe(false);
            return {start: f.ports.startContainer, initialize};
        });
        f.ports.prepareContainer = prepare;
        await f.exec("/repo", ["codex"]);
        expect(prepare).toHaveBeenCalledOnce(); expect(initialize).toHaveBeenCalledExactlyOnceWith("final-id");
    });
    it("hands the same held state guard to startup without acquiring a second global guard", async () => {
        const f = fixture();
        let held = false;
        const originalStart = f.ports.startContainer;
        const start = vi.fn<ContainerExecPorts<symbol>["startContainer"]>((...args) => {
            expect(held).toBe(true);
            expect(args[10]).toBe(f.stateGuard);
            return originalStart(...args);
        });
        const stateAdmission = vi.fn();
        f.ports.stateLock = async <T>(operation: (guard: RuntimeBindGuard) => T | Promise<T>): Promise<T> => {
            stateAdmission();
            expect(held).toBe(false);
            held = true;
            try { return await operation(f.stateGuard); }
            finally { held = false; }
        };
        f.ports.prepareContainer = () => ({start, initialize: id => {
            expect(held).toBe(false);
            expect(id).toBe("final-id");
        }});
        await expect(f.exec("/repo", ["codex"])).resolves.toBe(0);
        expect(stateAdmission).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenCalledExactlyOnceWith("final-id", {startedByInvocation: true});
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });
    it("preparation failure performs no mutation admission or command launch", async () => {
        const f = fixture(), failure = new Error("image preparation unavailable");
        f.ports.prepareContainer = () => { throw failure; };
        let stateCalls = 0, lifecycleCalls = 0;
        f.ports.stateLock = async <T>(operation: (guard: RuntimeBindGuard) => T | Promise<T>): Promise<T> => {
            stateCalls++; return operation(f.stateGuard);
        };
        f.ports.lifecycleLock = async <T>(_prefix: string, operation: () => T | Promise<T>): Promise<T> => {
            lifecycleCalls++; return operation();
        };
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(stateCalls).toBe(0); expect(lifecycleCalls).toBe(0);
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).not.toHaveBeenCalled(); expect(f.ports.launchCommand).not.toHaveBeenCalled();
    });
    it("helper failure retains acknowledged exact startup identity for cleanup", async () => {
        const f = fixture(), failure = new Error("SSH initialization failed");
        f.ports.prepareContainer = () => ({start: f.ports.startContainer, initialize: () => {
            expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenLastCalledWith("final-id", {startedByInvocation: true});
            expect(f.ports.confirmOwnership).toHaveBeenCalled(); throw failure;
        }});
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).toHaveBeenLastCalledWith("final-id");
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true); expect(f.ports.launchCommand).not.toHaveBeenCalled();
    });
    it.each([false, true])("preserves ordered command, disposal and cleanup failures with commandFailure=%s", async commandFails => {
        const f = fixture(), primary = new Error("command failed"), disposal = new Error("disposal failed"), cleanup = new Error("cleanup failed");
        if (commandFails) vi.mocked(f.ports.launchCommand).mockRejectedValue(primary);
        vi.mocked(f.ports.disposeCommand).mockImplementation(() => { f.events.push("dispose"); throw disposal; });
        vi.mocked(f.ports.cleanupSession).mockImplementation(() => { f.events.push("cleanup"); throw cleanup; });
        vi.mocked(f.ports.report).mockImplementation(report => { if (report.kind === "cleanup-failed") throw new Error("diagnostic failed"); });
        const errors = commandFails ? [primary, disposal, cleanup] : [disposal, cleanup];
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: errors[0], errors});
        expect(f.ports.report).toHaveBeenCalledWith(expect.objectContaining({kind: "cleanup-failed", cause: cleanup}));
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });
    it.each(["initial", "readiness", "tool-retry"] as const)("awaits the %s lifecycle guard before proceeding with its pinned identity", async checkpoint => {
        const f = fixture();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        let acquisitions = 0;
        const blockedAcquisition = checkpoint === "initial" ? 1 : 2;
        f.ports.lifecycleLock = async <T>(_prefix: string, operation: () => T | Promise<T>): Promise<T> => {
            if (++acquisitions === blockedAcquisition) { entered(); await gate; }
            return operation();
        };
        let starts = 0;
        f.ports.startContainer = (_path, _ensure, _mounts, _port, _profile, _recreate, _replacement, onReady, _expected, onStarted, _guard, onBeforeMutation) => {
            const id = ++starts === 1 ? "initial-id" : "replacement-id";
            onBeforeMutation?.(); onStarted(id); onReady(id, {startedByInvocation: true}); return "ccc-repo";
        };
        let originalRunning = checkpoint !== "readiness";
        f.ports.containerRunning = id => id === "replacement-id" || originalRunning;
        if (checkpoint === "tool-retry") vi.mocked(f.ports.installTools).mockImplementation(id => {
            if (id === "initial-id") { originalRunning = false; throw new Error("container stopped during install"); }
        });
        const pending = f.exec("/repo", ["codex"]);
        await waiting;
        expect(f.ports.prepareCodexConfig).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.installTools).toHaveBeenCalledTimes(checkpoint === "tool-retry" ? 1 : 0);
        if (checkpoint === "initial") {
            expect(f.ports.buildMcpConfig).not.toHaveBeenCalled();
            expect(f.ports.restoreConfig).not.toHaveBeenCalled();
            expect(f.ports.confirmOwnership).not.toHaveBeenCalled();
        }
        release();
        expect(await pending).toBe(0);
        const finalId = checkpoint === "initial" ? "initial-id" : "replacement-id";
        expect(f.ports.installTools).toHaveBeenLastCalledWith(finalId, expect.objectContaining({name: "codex"}));
        expect(f.ports.prepareCodexConfig).toHaveBeenCalledWith(finalId, undefined);
        expect(f.ports.prepareCommand).toHaveBeenCalledWith(expect.objectContaining({target: finalId}));
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).toHaveBeenCalledOnce();
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenLastCalledWith(finalId, {startedByInvocation: true});
    });
    it.each(["initial", "readiness", "tool-retry"] as const)("propagates a rejected %s guard without proceeding", async checkpoint => {
        const f = fixture();
        const failure = new Error("lifecycle acquisition refused");
        let reject!: (cause: unknown) => void;
        const gate = new Promise<void>((_resolve, rejectGate) => { reject = rejectGate; });
        let entered!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        let acquisitions = 0;
        f.ports.lifecycleLock = async <T>(_prefix: string, operation: () => T | Promise<T>): Promise<T> => {
            if (++acquisitions === (checkpoint === "initial" ? 1 : 2)) { entered(); await gate; }
            return operation();
        };
        let running = checkpoint !== "readiness";
        f.ports.containerRunning = () => running;
        if (checkpoint === "tool-retry") vi.mocked(f.ports.installTools).mockImplementation(() => { running = false; throw new Error("install lost container"); });
        const pending = f.exec("/repo", ["codex"]);
        const outcome = expect(pending).rejects.toMatchObject({message: "Container setup failed", cause: failure});
        await waiting;
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        reject(failure);
        await outcome;
        expect(f.ports.prepareCodexConfig).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.installTools).toHaveBeenCalledTimes(checkpoint === "tool-retry" ? 1 : 0);
        if (checkpoint === "initial") expect(f.ports.buildMcpConfig).not.toHaveBeenCalled();
    });
    it("retains the final tool failure cause after exactly two unavailable-container attempts", async () => {
        const f = fixture();
        const failure = new Error("replacement install failed");
        let probes = 0;
        // The general setup checkpoint succeeds; both tool attempts subsequently lose liveness.
        f.ports.containerRunning = () => ++probes === 1;
        vi.mocked(f.ports.installTools).mockImplementation(() => { throw failure; });
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({
            message: "Container setup failed", cause: {message: "Failed to install tools", cause: failure},
        });
        expect(f.ports.installTools).toHaveBeenCalledTimes(2);
        expect(f.ports.prepareCodexConfig).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
    });
    it("pins setup, preparation and launch to the final replacement identity", async () => {
        const f = fixture({replace: true});
        expect(await f.exec("/repo", ["codex", "resume", "--last"])).toBe(0);
        expect(f.ports.installTools).toHaveBeenCalledWith("final-id", expect.objectContaining({name: "codex"}));
        expect(f.ports.prepareCodexConfig).toHaveBeenCalledWith("final-id", undefined);
        expect(f.ports.syncClipboard).toHaveBeenCalledWith("final-id");
        expect(f.ports.ensureSocketAccess).toHaveBeenCalledWith("final-id");
        expect(f.ports.prepareCommand).toHaveBeenCalledWith({runtime: "docker", target: "final-id", workdir: "/project/repo-id", environment: f.entries, command: {kind: "command", arguments: ["codex", "resume", "--last"]}});
        expect(f.ports.prepareCodexCommand).toHaveBeenCalledWith(f.handle);
        expect(f.ports.launchCommand).toHaveBeenCalledWith(f.handle, {interactive: true, terminal: false, codexRecovery: false});
        expect(f.ports.disposeCommand).toHaveBeenCalledExactlyOnceWith(f.handle);
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });
    it("reused containers rebuild MCP and perform light setup while skipping heavy installers", async () => {
        const f = fixture({running: true}); await f.exec("/repo", ["codex"]);
        expect(f.ports.ensureUv).not.toHaveBeenCalled(); expect(f.ports.setupProxy).not.toHaveBeenCalled(); expect(f.ports.installProjectTools).not.toHaveBeenCalled();
        expect(f.ports.buildMcpConfig).toHaveBeenCalledWith(undefined, expect.any(Function));
        expect(f.ports.syncClipboard).toHaveBeenCalledWith("final-id"); expect(f.ports.ensureSocketAccess).toHaveBeenCalledWith("final-id");
    });
    it("confirms command authority and restores config under the resolved profile lock before disposal", async () => {
        const f = fixture({running: true});
        let locked = false;
        let commandAcknowledgements = 0;
        vi.mocked(f.ports.confirmOwnership).mockImplementation(async () => {
            if (vi.mocked(f.ports.prepareCommand).mock.calls.length > 0) commandAcknowledgements++;
        });
        f.ports.configLock = <T>(operation: () => T, profile?: string): T => {
            expect(profile).toBe("work"); expect(locked).toBe(false); locked = true;
            try { return operation(); } finally { locked = false; }
        };
        vi.mocked(f.ports.restoreConfig).mockImplementation((target, profile) => {
            expect(locked).toBe(true); expect([target, profile]).toEqual(["final-id", "work"]);
            f.events.push("restore");
        });
        vi.mocked(f.ports.launchCommand).mockImplementation(async () => {
            expect(commandAcknowledgements).toBe(2);
            expect(f.ports.setCleanupEnabled).toHaveBeenLastCalledWith(true);
            expect(locked).toBe(false); f.events.push("launch"); return 37;
        });
        expect(await f.exec("/repo", ["codex", "resume", "fixture-session"], {}, "work")).toBe(37);
        expect(f.ports.disposeCommand).toHaveBeenCalledExactlyOnceWith(f.handle);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.events.slice(-4)).toEqual(["launch", "restore", "dispose", "cleanup"]);
        expect(locked).toBe(false);
    });
    it("keeps preparation refusal status without granting cleanup permission or launching", async () => {
        const f = fixture({running: true});
        let commandAcknowledgements = 0;
        vi.mocked(f.ports.confirmOwnership).mockImplementation(async () => {
            if (vi.mocked(f.ports.prepareCommand).mock.calls.length > 0) commandAcknowledgements++;
        });
        vi.mocked(f.ports.prepareCodexCommand).mockReturnValue({ok: false, status: 7, reason: "engine-unavailable"});
        vi.mocked(f.ports.restoreConfig).mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("restore denied"); });
        const cleanupFailure = new Error("cleanup denied");
        vi.mocked(f.ports.cleanupSession).mockImplementation(() => { throw cleanupFailure; });
        await expect(f.exec("/repo", ["codex"])).rejects.toBe(cleanupFailure);
        expect(commandAcknowledgements).toBe(1);
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.disposeCommand).toHaveBeenCalledExactlyOnceWith(f.handle);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });
    it.each([1, 2])("preserves ownership acknowledgement %s rejection and cleans its command without launching", async rejectedAcknowledgement => {
        const f = fixture({running: true}), original = { refusal: "ownership acknowledgement lost" };
        let confirmations = 0;
        vi.mocked(f.ports.confirmOwnership).mockImplementation(async () => {
            if (vi.mocked(f.ports.prepareCommand).mock.calls.length === 0) return;
            if (++confirmations === rejectedAcknowledgement) throw original;
        });
        vi.mocked(f.ports.restoreConfig).mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("restore denied"); });
        const cleanupFailure = new Error("cleanup denied");
        vi.mocked(f.ports.cleanupSession).mockImplementation(() => { throw cleanupFailure; });
        vi.mocked(f.ports.report).mockImplementation(report => {
            if (report.kind === "restore-failed" || report.kind === "cleanup-failed") throw new Error("diagnostic denied");
        });
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: original, errors: [original, cleanupFailure]});
        expect(confirmations).toBe(rejectedAcknowledgement);
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        if (rejectedAcknowledgement === 1) expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
        else expect(f.ports.setCleanupEnabled).toHaveBeenLastCalledWith(true);
        expect(f.ports.disposeCommand).toHaveBeenCalledExactlyOnceWith(f.handle);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });
    it("attaches clipboard before preparation and forwards ordered environment intent unchanged", async () => {
        const f = fixture(), overrides = {LANG: "session-lang", TZ: "Session/Zone"}, connection = {url: "http://clipboard", token: "token"};
        f.ports.clipboardConnection = () => connection;
        vi.mocked(f.ports.observeCommandEnvironment).mockReturnValue({forwarded: [["DUPLICATE", "first"], ["DUPLICATE", "last"]], skippedKeys: ["LARGE_A", "LARGE_B"], containerMarker: ["container", "docker"], hostLangPresent: true, hostTimezone: "Host/Zone", observedTimezone: "Observed/Zone"});
        vi.mocked(f.ports.attachClipboardImage).mockResolvedValue({args: ["codex", "--image", "/tmp/image with spaces.png"]});
        await f.exec("/repo", ["codex"], {env: overrides});
        expect(f.ports.observeCommandEnvironment).toHaveBeenCalledOnce();
        expect(f.ports.startClipboardBridge).toHaveBeenCalledWith("final-id", connection);
        expect(vi.mocked(f.ports.prepareCommand).mock.calls[0][0]).toMatchObject({environment: [...f.entries, ["CCC_CLIPBOARD_URL", "http://clipboard"], ["CCC_CLIPBOARD_TOKEN", "token"], ["LANG", "session-lang"], ["TZ", "Session/Zone"]], command: {kind: "command", arguments: ["codex", "--image", "/tmp/image with spaces.png"]}});
        expect(f.events.indexOf("attach")).toBeLessThan(f.events.indexOf("prepare")); expect(f.events.indexOf("bridge")).toBeLessThan(f.events.indexOf("prepare"));
        expect(f.ports.report).toHaveBeenCalledWith({kind: "environment-skipped", keys: ["LARGE_A", "LARGE_B"]});
    });
    it("preserves original Claude argument intent and requests its Node environment", async () => {
        const f = fixture(), args = ["literal with spaces", "$(never executed)"];
        await f.exec("/repo", ["claude", ...args]);
        expect(vi.mocked(f.ports.prepareCommand).mock.calls[0][0].environment).toEqual([...f.entries, ["MISE_NODE_VERSION", "22"], ["BASH_ENV", "/home/ccc/.bashrc_hooks"], ["CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS", "1"]]);
        expect(vi.mocked(f.ports.prepareCommand).mock.calls[0][0].command).toEqual({kind: "claude", arguments: args});
        expect(f.ports.prepareCodexCommand).not.toHaveBeenCalled();
    });
    it("defaults Claude permission launch environment after host forwarding and keeps explicit session override last", async () => {
        const key = "CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS", f = fixture();
        vi.mocked(f.ports.observeCommandEnvironment).mockReturnValue({forwarded: [[key, "0"]], skippedKeys: [], containerMarker: ["container", "docker"], hostLangPresent: true, hostTimezone: "Host/Zone"});
        await f.exec("/repo", ["claude"], {env: {[key]: "0"}});
        const environment = vi.mocked(f.ports.prepareCommand).mock.calls[0][0].environment;
        expect(environment.filter(([name]) => name === key)).toEqual([[key, "0"], [key, "1"], [key, "0"]]);
        expect(environment.at(-1)).toEqual([key, "0"]);
        expect(Object.fromEntries(environment)[key]).toBe("0");
    });
    it.each(["codex", "opencode", "printf"])("does not add Claude permission launch environment to %s", async command => {
        const f = fixture();
        await f.exec("/repo", [command]);
        const environment = vi.mocked(f.ports.prepareCommand).mock.calls[0][0].environment;
        expect(environment.some(([name]) => name === "CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS")).toBe(false);
    });
    it.each(["codex", "claude"])("defaults %s browser to the selected host helper and preserves an explicit session override last", async tool => {
        const f = fixture(), connection = {url: "http://host.docker.internal:4322", token: "current-token", generation: "a1b2c3d4e5f6"};
        f.ports.clipboardConnection = () => connection;
        vi.mocked(f.ports.observeCommandEnvironment).mockReturnValue({forwarded: [["BROWSER", "/host/browser"]], skippedKeys: [],
            containerMarker: ["container", "docker"], hostLangPresent: true, hostTimezone: "Host/Zone"});
        await f.exec("/repo", [tool], {env: {BROWSER: "/session/custom-browser"}});
        const environment = vi.mocked(f.ports.prepareCommand).mock.calls[0][0].environment;
        expect(environment).toEqual([
            ["container", "docker"], ["BROWSER", "/host/browser"], ["MISE_TRUSTED_CONFIG_PATHS", "/project/repo-id"], ["TZ", "Host/Zone"],
            ["CCC_CLIPBOARD_URL", connection.url], ["CCC_CLIPBOARD_TOKEN", connection.token], ["CCC_CLIPBOARD_GENERATION", connection.generation],
            ...(tool === "claude" ? [["MISE_NODE_VERSION", "22"], ["BASH_ENV", "/home/ccc/.bashrc_hooks"],
                ["CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS", "1"]] : []),
            ["BROWSER", "/usr/local/bin/ccc-open-url"], ["BROWSER", "/session/custom-browser"],
        ]);
        expect(Object.fromEntries(environment).BROWSER).toBe("/session/custom-browser");
    });
    it.each(["opencode", "printf"])("does not add the CCC browser helper default to generic tool %s", async tool => {
        const f = fixture();
        f.ports.clipboardConnection = () => ({url: "http://host.docker.internal:4322", token: "current-token", generation: "a1b2c3d4e5f6"});
        await f.exec("/repo", [tool]);
        const environment = vi.mocked(f.ports.prepareCommand).mock.calls[0][0].environment;
        expect(environment.some(([name]) => name === "BROWSER")).toBe(false);
    });
    it.each([
        {hostTimezone: "Host/Zone", observedTimezone: "Observed/Zone", expected: "Host/Zone"},
        {hostTimezone: undefined, observedTimezone: "Observed/Zone", expected: "Observed/Zone"},
        {hostTimezone: undefined, observedTimezone: undefined, expected: "UTC"},
    ])("owns locale fallback and timezone priority $expected", async ({hostTimezone, observedTimezone, expected}) => {
        const f = fixture();
        vi.mocked(f.ports.observeCommandEnvironment).mockReturnValue({forwarded: [], skippedKeys: [], containerMarker: ["container", "docker"], hostLangPresent: false, hostTimezone, observedTimezone});
        await f.exec("/repo", ["printf"], {interactive: false});
        expect(vi.mocked(f.ports.prepareCommand).mock.calls[0][0].environment).toEqual([["container", "docker"], ["MISE_TRUSTED_CONFIG_PATHS", "/project/repo-id"], ["LANG", "en_US.UTF-8"], ["TZ", expected]]);
    });
    it("command artifact creation failure still restores and cleans acknowledged startup", async () => {
        const f = fixture(), failure = new Error("prepare denied");
        vi.mocked(f.ports.prepareCommand).mockImplementation(() => { throw failure; });
        await expect(f.exec("/repo", ["codex"])).rejects.toBe(failure);
        expect(f.ports.restoreConfig).toHaveBeenCalledTimes(2);
        expect(f.ports.disposeCommand).not.toHaveBeenCalled(); expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });
    it.each(["status", "failure"] as const)("throwing restore/cleanup diagnostics preserve failures for command %s", async outcome => {
        const f = fixture(), failure = new Error("primary command failure");
        const cleanupFailure = new Error("cleanup denied");
        vi.mocked(f.ports.restoreConfig).mockImplementationOnce(() => {}).mockImplementation(() => { f.events.push("restore"); throw new Error("restore denied"); });
        vi.mocked(f.ports.cleanupSession).mockImplementation(() => { f.events.push("cleanup"); throw cleanupFailure; });
        vi.mocked(f.ports.report).mockImplementation(report => { if (report.kind === "restore-failed" || report.kind === "cleanup-failed") throw new Error("diagnostic denied"); });
        if (outcome === "failure") vi.mocked(f.ports.launchCommand).mockRejectedValue(failure); else vi.mocked(f.ports.launchCommand).mockResolvedValue(23);
        const pending = f.exec("/repo", ["codex"]);
        if (outcome === "failure") await expect(pending).rejects.toMatchObject({cause: failure, errors: [failure, cleanupFailure]}); else await expect(pending).rejects.toBe(cleanupFailure);
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });
    it("disposal failure still cleans the session and retains existing propagation", async () => {
        const f = fixture(), failure = new Error("dispose denied");
        vi.mocked(f.ports.disposeCommand).mockImplementation(() => { f.events.push("dispose"); throw failure; });
        await expect(f.exec("/repo", ["codex"])).rejects.toBe(failure);
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });
    it.each([true, false])("throwing Codex preparation report still restores/disposes/cleans for success=%s", async ok => {
        const f = fixture(), failure = new Error("presentation denied");
        if (ok) vi.mocked(f.ports.prepareCodexCommand).mockReturnValue({ok: true, reason: "installation-incomplete-fallback"});
        else vi.mocked(f.ports.prepareCodexCommand).mockReturnValue({ok: false, reason: "engine-unavailable", status: 9});
        vi.mocked(f.ports.report).mockImplementation(report => { if (report.kind === "codex-preparation") throw failure; });
        await expect(f.exec("/repo", ["codex"])).rejects.toBe(failure);
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.events.slice(-3)).toEqual(["restore", "dispose", "cleanup"]);
    });
    it("restart-required setup exceptions retain their identity", async () => {
        const f = fixture(), failure = new Error("restart required");
        vi.mocked(f.ports.installTools).mockImplementation(() => { throw failure; }); f.ports.isRestartRequired = error => error === failure;
        await expect(f.exec("/repo", ["codex"])).rejects.toBe(failure);
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });
});

describe("workspace execution admission", () => {
    it.each([
        {mode: "explicit normal", command: ["codex"], worktreeWorkspace: true, sourcePath: "/source/repo"},
        {mode: "explicit resume", command: ["codex", "resume", "session-id"], worktreeWorkspace: true, sourcePath: "/source/repo"},
        {mode: "direct normal", command: ["codex"], worktreeWorkspace: undefined, sourcePath: undefined},
        {mode: "direct resume", command: ["codex", "resume", "session-id"], worktreeWorkspace: undefined, sourcePath: undefined},
        {mode: "direct false hint", command: ["codex"], worktreeWorkspace: false, sourcePath: undefined},
    ])("admits $mode under the family lock and keeps common Git mounts mandatory", async ({command, worktreeWorkspace, sourcePath}) => {
        const f = fixture(), admission: string[] = [];
        const mounts: ReturnType<typeof f.ports.worktreeMounts> = ["root", "child"].map(name => ({
            hostPath: `/source/${name}/.git`, containerPath: `/source/${name}/.git`,
            identity: {realpath: `/source/${name}/.git`, dev: "1", ino: name}, presence: "core" as const,
        }));
        let familyHeld = false;
        f.ports.isWorktreeWorkspace = vi.fn(() => true);
        f.ports.familyLock = async (_id, operation) => {
            expect(_id).toBe("repo-id"); familyHeld = true; admission.push("family");
            try { return await operation(); }
            finally { familyHeld = false; admission.push("release"); }
        };
        f.ports.assertWorkspace = vi.fn((path, source) => {
            expect(familyHeld).toBe(true); expect([path, source]).toEqual(["/project/repo", sourcePath]);
            admission.push("ready");
        });
        f.ports.acquireOwnership = vi.fn(async () => {
            expect(familyHeld).toBe(true); admission.push("acquire");
            return {lockFile: "/owned/session.lock", existingId: null};
        });
        f.ports.worktreeMounts = vi.fn((path, required, mountPath) => {
            expect(familyHeld).toBe(false); expect([path, required, mountPath]).toEqual(["/project/repo", true, "/project/repo-id"]);
            admission.push("mounts"); return mounts;
        });
        const start = f.ports.startContainer;
        f.ports.startContainer = vi.fn((...args: Parameters<typeof start>) => {
            expect(args[2]).toEqual(mounts); return start(...args);
        });
        expect(await f.exec("/repo", command, {worktreeWorkspace, expectedWorktreeSourcePath: sourcePath})).toBe(0);
        expect(admission).toEqual(["family", "ready", "acquire", "release", "mounts"]);
        expect(f.ports.assertWorkspace).toHaveBeenCalledOnce();
        expect(f.ports.acquireOwnership).toHaveBeenCalledOnce();
        expect(f.ports.startContainer).toHaveBeenCalled();
        expect(f.ports.launchCommand).toHaveBeenCalledOnce();
        if (worktreeWorkspace !== true) expect(f.ports.isWorktreeWorkspace).toHaveBeenCalledExactlyOnceWith("/project/repo");
    });
    it("a false hint still surfaces malformed workspace metadata before claiming or starting a container", async () => {
        const f = fixture(), failure = new Error("workspace metadata is malformed");
        f.ports.isWorktreeWorkspace = vi.fn(() => { throw failure; });
        f.ports.acquireOwnership = vi.fn();
        f.ports.familyLock = vi.fn();
        f.ports.worktreeMounts = vi.fn();
        f.ports.prepareContainer = vi.fn();
        await expect(f.exec("/repo", ["codex", "resume", "session-id"], {worktreeWorkspace: false})).rejects.toBe(failure);
        expect(f.ports.isWorktreeWorkspace).toHaveBeenCalledExactlyOnceWith("/project/repo");
        expect(f.ports.familyLock).not.toHaveBeenCalled();
        expect(f.ports.assertWorkspace).not.toHaveBeenCalled();
        expect(f.ports.acquireOwnership).not.toHaveBeenCalled();
        expect(f.ports.worktreeMounts).not.toHaveBeenCalled();
        expect(f.ports.prepareContainer).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
    });
    it.each([true, false, undefined])("revalidates workspace ownership under the family lock before claiming (hint=%s)", async worktreeWorkspace => {
        const f = fixture(), failure = new Error("workspace replaced while waiting for family lock");
        let familyHeld = false;
        f.ports.isWorktreeWorkspace = () => true;
        f.ports.familyLock = async (_id, operation) => {
            familyHeld = true;
            try { return await operation(); } finally { familyHeld = false; }
        };
        f.ports.assertWorkspace = vi.fn(() => { expect(familyHeld).toBe(true); throw failure; });
        f.ports.acquireOwnership = vi.fn();
        f.ports.worktreeMounts = vi.fn();
        f.ports.prepareContainer = vi.fn();
        await expect(f.exec("/repo", ["codex"], {worktreeWorkspace, expectedWorktreeSourcePath: "/source/repo"})).rejects.toBe(failure);
        expect(f.ports.assertWorkspace).toHaveBeenCalledExactlyOnceWith("/project/repo", "/source/repo");
        expect(familyHeld).toBe(false);
        expect(f.ports.acquireOwnership).not.toHaveBeenCalled();
        expect(f.ports.worktreeMounts).not.toHaveBeenCalled();
        expect(f.ports.prepareContainer).not.toHaveBeenCalled();
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
    });
    it("waits for the family lock before readiness and session ownership", async () => {
        const f = fixture();
        let entered!: () => void, release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        f.ports.familyLock = async (_id, operation) => { entered(); await gate; return operation(); };
        f.ports.acquireOwnership = vi.fn(async () => ({lockFile: "/owned/session.lock", existingId: null}));
        const pending = f.exec("/repo", ["codex"], {worktreeWorkspace: true});
        await waiting;
        expect(f.ports.assertWorkspace).not.toHaveBeenCalled();
        expect(f.ports.acquireOwnership).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled();
        release();
        expect(await pending).toBe(0);
        expect(f.ports.assertWorkspace).toHaveBeenCalledExactlyOnceWith("/project/repo", undefined);
        expect(f.ports.acquireOwnership).toHaveBeenCalledOnce();
    });
});

describe("replacement ownership observations", () => {
    it.each([
        {claims: [], id: "expected", exists: true, result: {reason: "ownership-unverified"}},
        {claims: ["session.lock", "session.lock"], id: "expected", exists: true, result: {reason: "ownership-unverified"}},
        {claims: ["session.lock", "other.lock"], id: "expected", exists: true, result: {reason: "other-claims", claims: ["other.lock"]}},
        {claims: ["session.lock"], id: null, exists: false, result: {reason: "identity-absent"}},
        {claims: ["session.lock"], id: "changed", exists: true, result: {reason: "identity-changed"}},
        {claims: ["session.lock"], id: "expected", exists: true, result: null},
    ])("returns bounded ownership facts for $result", ({claims, id, exists, result}) => {
        expect(containerExecReplacementBlockReason("name", "prefix", "/owned/session.lock", "expected", {claims: () => claims, lockName: () => "session.lock", status: () => ({exists, containerId: id, running: true, imageId: "image"})})).toEqual(result);
    });
});

describe("native clipboard session handoff", () => {
    function nativePorts(assetDirectory = fileURLToPath(new URL("../../../dist", import.meta.url))) {
        preloadNativeRuntimeFixture(nativeRuntime);
        return createNativeContainerExecPorts({ensureDirectories: vi.fn(), ensureProjectTools: async () => {},
            assetDirectory, trustedCliPath: "/fixture/ccc.js"});
    }
    const connection = {url: "http://host.docker.internal:4322", hostUrl: "http://127.0.0.1:4322",
        token: "current-generation-token", generation: "a1b2c3d4e5f6"};
    const executablePaths = ["xclip", "xsel", "wl-paste", "wl-copy", "pbpaste", "ccc-open-url", "ccc-x11-bridge"].map(name => `/usr/local/bin/${name}`);
    function isAssetChecker(args: string[]) {
        return args[3] === "/usr/bin/sha256sum" || (args[3] === "/bin/sh" && args[6] === "ccc-clipboard-assets");
    }
    function expectAssetChecker(args: string[]) {
        expect(args.slice(0, 5)).toEqual(["exec", "-i", "exact-container-id", "/bin/sh", "-c"]);
        expect(args[5]).toContain("-f");
        expect(args[5]).toContain("-x");
        expect(args[5]).toContain("exec /usr/bin/sha256sum --check --status");
        expect(args[5]).not.toContain(connection.token);
        expect(args[5]).not.toContain(connection.url);
        expect(args.slice(6)).toEqual(["ccc-clipboard-assets", ...executablePaths]);
    }

    it.skipIf(originalNativePlatform === "win32" || !existsSync("/usr/bin/sha256sum")).each([
        {state: "xclip mode0644", nonExecutable: "xclip", staleAsset: undefined},
        {state: "browser helper mode0644", nonExecutable: "ccc-open-url", staleAsset: undefined},
        {state: "browser helper retained bytes", nonExecutable: undefined, staleAsset: "ccc-open-url"},
        {state: "policy mode0644", nonExecutable: undefined, staleAsset: undefined},
    ])("checks actual executable permissions and installed bytes with $state", async ({nonExecutable, staleAsset}) => {
        const actual = await vi.importActual<typeof import("child_process")>("child_process");
        const directory = mkdtempSync(join(tmpdir(), "ccc-installed-clipboard-mode-"));
        const mappedPaths = new Map<string, string>();
        let checkedInstalledFiles = false, attemptedBridgeLaunch = false;
        try {
            for (const name of ["xclip", "xsel", "wl-paste", "wl-copy", "pbpaste", "ccc-open-url", "ccc-x11-bridge", "clipboard-x11-sync.sh"]) {
                const source = name === "clipboard-x11-sync.sh" ? `lib/${name}` : name === "ccc-x11-bridge" ? name : `clipboard-shims/${name}`;
                const installedPath = name === "clipboard-x11-sync.sh" ? `/usr/local/lib/ccc/${name}` : `/usr/local/bin/${name}`;
                const path = join(directory, name);
                const bytes = readFileSync(new URL(`../../../scripts/${source}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
                writeFileSync(path, name === staleAsset ? "#!/bin/sh\n# retained browser helper\nexit 0\n" : bytes);
                chmodSync(path, name === "clipboard-x11-sync.sh" || name === nonExecutable ? 0o644 : 0o755);
                mappedPaths.set(installedPath, path);
            }
            const ports = nativePorts();
            stoppedNative.spawnSync.mockReset().mockImplementation((...call: unknown[]) => {
                const [, rawArgs, rawOptions] = normalizeNativeRuntimeCall(call);
                const args = rawArgs as string[];
                if (!isAssetChecker(args)) {
                    attemptedBridgeLaunch = true;
                    return {status: 0, signal: null, stdout: "", stderr: ""};
                }
                expectAssetChecker(args);
                const options = rawOptions as import("child_process").SpawnSyncOptions & {input: string | Buffer};
                const seenPaths: string[] = [];
                const manifest = Buffer.from(options.input).toString().trim().split("\n").map(line => {
                    const match = /^([a-f0-9]{64}) [ *](\/usr\/local\/\S+)$/.exec(line);
                    expect(match, `invalid SHA manifest line ${line}`).not.toBeNull();
                    const path = mappedPaths.get(match![2]);
                    expect(path, `unexpected installed path ${match![2]}`).toBeDefined();
                    seenPaths.push(match![2]);
                    return `${match![1]}  ${path}\n`;
                }).join("");
                expect(new Set(seenPaths)).toEqual(new Set(mappedPaths.keys()));
                const argv = args.slice(4).map(arg => mappedPaths.get(arg) ?? arg);
                checkedInstalledFiles = true;
                return actual.spawnSync(args[3], argv, {...options, input: manifest});
            });

            if (nonExecutable === undefined && staleAsset === undefined) {
                expect(() => ports.startClipboardBridge("exact-container-id", connection)).not.toThrow();
                expect(attemptedBridgeLaunch).toBe(true);
                expect(stoppedNative.spawnSync).toHaveBeenCalledTimes(3);
            } else {
                expect(() => ports.startClipboardBridge("exact-container-id", connection)).toThrow(/Clipboard client assets/);
                expect(attemptedBridgeLaunch).toBe(false);
                expect(stoppedNative.spawnSync).toHaveBeenCalledOnce();
            }
            expect(checkedInstalledFiles).toBe(true);
        } finally { rmSync(directory, {recursive: true, force: true}); }
    });

    it.each(["xclip", "xsel", "wl-paste", "wl-copy", "pbpaste", "ccc-open-url", "ccc-x11-bridge", "clipboard-x11-sync.sh"])(
        "refuses retained legacy %s bytes even when the old bridge would pretend readiness succeeds", retained => {
            const ports = nativePorts();
            const installed = new Map<string, Buffer>();
            const shipped = new Map<string, string>();
            for (const name of ["xclip", "xsel", "wl-paste", "wl-copy", "pbpaste", "ccc-open-url", "ccc-x11-bridge", "clipboard-x11-sync.sh"]) {
                const source = name === "clipboard-x11-sync.sh" ? `lib/${name}` : name === "ccc-x11-bridge" ? name : `clipboard-shims/${name}`;
                const path = name === "clipboard-x11-sync.sh" ? `/usr/local/lib/ccc/${name}` : `/usr/local/bin/${name}`;
                const bytes = Buffer.from(readFileSync(new URL(`../../../scripts/${source}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
                installed.set(path, name === retained ? Buffer.from("#!/bin/sh\n# retained legacy client\nexit 0\n") : bytes);
                shipped.set(path, createHash("sha256").update(bytes).digest("hex"));
            }
            let checkedInstalledBytes = false, attemptedBridgeLaunch = false;
            stoppedNative.spawnSync.mockReset().mockImplementation((...call: unknown[]) => {
                const [, rawArgs, options] = normalizeNativeRuntimeCall(call);
                const args = rawArgs as string[];
                if (isAssetChecker(args)) {
                    expectAssetChecker(args);
                    expect(options).toMatchObject({timeout: 15000});
                    const manifest = Buffer.from((options as {input: string | Buffer}).input).toString();
                    const entries = manifest.trim().split("\n").map(line => {
                        const match = /^([a-f0-9]{64}) [ *](\/usr\/local\/\S+)$/.exec(line);
                        expect(match, `invalid SHA manifest line ${line}`).not.toBeNull();
                        return [match![2], match![1]] as const;
                    });
                    expect(new Map(entries)).toEqual(shipped);
                    checkedInstalledBytes = true;
                    const matches = entries.every(([path, expected]) => createHash("sha256").update(installed.get(path)!).digest("hex") === expected);
                    return {status: matches ? 0 : 1, signal: null, stdout: "", stderr: ""};
                }
                attemptedBridgeLaunch = true;
                return {status: 0, signal: null, stdout: "", stderr: ""};
            });

            expect(() => ports.startClipboardBridge("exact-container-id", connection)).toThrow(/Clipboard/);
            expect(checkedInstalledBytes).toBe(true);
            expect(attemptedBridgeLaunch).toBe(false);
            expect(stoppedNative.spawnSync).toHaveBeenCalledOnce();
        });

    it.each(["darwin", "win32"] as const)("keeps the %s host attachment URL distinct from the container endpoint", platform => {
        const original = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
        try {
            stoppedNative.spawnSync.mockReset();
            const ports = nativePorts();
            expect(ports.clipboardConnection({port: 4322, token: connection.token,
                portFile: "/fixture/generation/clipboard.port", generation: connection.generation})).toEqual(connection);
            expect(stoppedNative.spawnSync).not.toHaveBeenCalled();
        } finally { original.mockRestore(); }
    });

    it("waits for a finite first sync using the same selected endpoint and credentials as its detached bridge", () => {
        const ports = nativePorts();
        stoppedNative.spawnSync.mockReset().mockReturnValue({status: 0, signal: null, stdout: "", stderr: ""});
        ports.startClipboardBridge("exact-container-id", connection);
        const calls = stoppedNative.spawnSync.mock.calls.map(call => normalizeNativeRuntimeCall(call));
        const environment = ["-e", `CCC_CLIPBOARD_URL=${connection.url}`, "-e", `CCC_CLIPBOARD_TOKEN=${connection.token}`,
            "-e", `CCC_CLIPBOARD_GENERATION=${connection.generation}`];
        expect(calls).toHaveLength(3);
        expectAssetChecker(calls[0][1] as string[]);
        expect(calls[0][2]).toMatchObject({input: expect.any(String), stdio: ["pipe", "ignore", "ignore"], timeout: 15000});
        expect(String((calls[0][2] as {input: string}).input)).not.toContain(connection.token);
        expect(calls[1][1]).toEqual(["exec", "-d", ...environment, "exact-container-id", "/usr/local/bin/ccc-x11-bridge"]);
        expect(calls[2][1]).toEqual(["exec", ...environment, "exact-container-id", "/usr/local/bin/ccc-x11-bridge", "--wait-ready"]);
        for (const [, , options] of calls.slice(1)) {
            expect(options).toMatchObject({stdio: "ignore", timeout: expect.any(Number)});
            expect((options as {timeout: number}).timeout).toBeGreaterThan(0);
            expect((options as {timeout: number}).timeout).toBeLessThanOrEqual(20000);
        }
    });

    it.each(["detached-launch", "first-sync", "first-sync-timeout"] as const)("refuses the native session handoff after %s failure", stage => {
        const ports = nativePorts();
        const success = {status: 0, signal: null, stdout: "", stderr: ""};
        const failure = stage === "first-sync-timeout"
            ? {status: null, signal: "SIGTERM", error: new Error("fixture readiness timeout"), stdout: "", stderr: ""}
            : {status: 1, signal: null, stdout: "", stderr: ""};
        stoppedNative.spawnSync.mockReset().mockReturnValueOnce(success)
            .mockReturnValueOnce(stage === "detached-launch" ? failure : success)
            .mockReturnValueOnce(failure);
        expect(() => ports.startClipboardBridge("exact-container-id", connection)).toThrow(/Clipboard synchronization/);
        const calls = stoppedNative.spawnSync.mock.calls.map(call => normalizeNativeRuntimeCall(call));
        expect(calls).toHaveLength(stage === "detached-launch" ? 2 : 3);
        for (const [, args] of calls) {
            expect(args).toContain("exact-container-id");
            expect((args as string[])[0]).toBe("exec");
        }
    });

    it.each(["unavailable", "timeout"] as const)("does not launch the bridge when installed asset verification is %s", failure => {
        const ports = nativePorts();
        stoppedNative.spawnSync.mockReset().mockReturnValue(failure === "unavailable"
            ? {status: 127, signal: null, stdout: "", stderr: "fixture: sha256sum unavailable"}
            : {status: null, signal: "SIGTERM", error: new Error("fixture verifier timeout"), stdout: "", stderr: ""});
        expect(() => ports.startClipboardBridge("exact-container-id", connection)).toThrow(/Clipboard client assets/);
        const calls = stoppedNative.spawnSync.mock.calls.map(call => normalizeNativeRuntimeCall(call));
        expect(calls).toHaveLength(1);
        expectAssetChecker(calls[0][1] as string[]);
        expect(calls[0][2]).toMatchObject({timeout: 15000, input: expect.any(String)});
    });

    it("refuses marked sessions before native execution when local shipped assets are missing", () => {
        const ports = nativePorts("/fixture/ccc-missing-delivery-assets/dist");
        stoppedNative.spawnSync.mockReset();
        expect(() => ports.startClipboardBridge("exact-container-id", connection)).toThrow(/Clipboard client assets are unavailable/);
        expect(stoppedNative.spawnSync).not.toHaveBeenCalled();
    });

    it("keeps absent clipboard connections a no-op even when a generation is present", () => {
        const ports = nativePorts("/fixture/ccc-missing-delivery-assets/dist");
        stoppedNative.spawnSync.mockReset();
        expect(() => ports.startClipboardBridge("exact-container-id", {token: connection.token, generation: connection.generation})).not.toThrow();
        expect(stoppedNative.spawnSync).not.toHaveBeenCalled();
    });

    it("preserves unmarked legacy startup without requiring current local assets or an installed hash checker", () => {
        const ports = nativePorts("/fixture/ccc-missing-delivery-assets/dist");
        stoppedNative.spawnSync.mockReset().mockReturnValue({status: 0, signal: null, stdout: "", stderr: ""});
        ports.startClipboardBridge("exact-container-id", {url: connection.url, token: connection.token});
        const calls = stoppedNative.spawnSync.mock.calls.map(call => normalizeNativeRuntimeCall(call));
        expect(calls).toHaveLength(2);
        expect(calls[0][1]).toEqual(["exec", "-d", "-e", `CCC_CLIPBOARD_URL=${connection.url}`,
            "-e", `CCC_CLIPBOARD_TOKEN=${connection.token}`, "exact-container-id", "/usr/local/bin/ccc-x11-bridge"]);
        expect(calls[1][1]).toEqual(["exec", "-e", `CCC_CLIPBOARD_URL=${connection.url}`,
            "-e", `CCC_CLIPBOARD_TOKEN=${connection.token}`, "exact-container-id", "/usr/local/bin/ccc-x11-bridge", "--wait-ready"]);
    });
});


describe("retained predecessor existing-only execution", () => {
    const id = "a".repeat(64);
    function restricted(options: {stopped?: boolean; provisional?: boolean} = {}) {
        const f = fixture({running: true});
        f.ports.acquireOwnership = async () => ({lockFile: "/owned/session.lock", existingId: id, existingOnly: true, recoveryWarning: "Old startup requests remain pending.",
            ...(options.provisional ? {requiresLiveVerification: true as const} : {})});
        f.ports.containerStatus = () => ({exists: true, running: !options.stopped, containerId: id, imageId: "current-image"});
        f.ports.prepareContainer = vi.fn(() => ({start: (...args: Parameters<ContainerExecPorts<symbol>["startContainer"]>) => f.ports.startContainer(...args), initialize: vi.fn()}));
        f.ports.startContainer = (...args) => { expect(args[8]).toBe(id); args[7](id, {startedByInvocation: false}); return "ccc-repo"; };
        f.ports.containerRunning = () => true;
        return f;
    }
    async function refused(f: ReturnType<typeof restricted>) {
        const result = await settled(f.exec("/repo", ["codex"]));
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("restricted lifecycle effect was allowed");
        const error = result.error as Error & {cause?: Error};
        expect((error.cause ?? error).message).toMatch(/Existing-only session/);
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    }
    it("runs ordinary guarded setup and commands without promoting cleanup or own-start authority", async () => {
        const f = restricted();
        vi.mocked(f.ports.launchCommand).mockImplementation(async () => {
            expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
            expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenCalledExactlyOnceWith(id, {startedByInvocation: false});
            return 23;
        });
        await expect(f.exec("/repo", ["codex"])).resolves.toBe(23);
        expect(f.ports.prepareCodexConfig).toHaveBeenCalledWith(id, undefined);
        expect(f.ports.prepareContainer).toHaveBeenCalledExactlyOnceWith({existingContainerId: id});
        expect(f.ports.ensureSocketAccess).toHaveBeenCalledWith(id);
        expect(f.ports.prepareCommand).toHaveBeenCalledWith(expect.objectContaining({target: id}));
        expect(f.ports.report).toHaveBeenCalledWith({kind: "recovery-retained", message: "Old startup requests remain pending."});
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true); expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });
    it.each([false, true])("prepares the exact stopped target and defers setup until unowned live readiness (provisional=%s)", async provisional => {
        const f = restricted({stopped: true, provisional}); let ready = false;
        const initialize = vi.fn(() => { expect(ready).toBe(true); });
        f.ports.prepareContainer = vi.fn(policy => {
            expect(policy).toEqual({existingContainerId: id});
            return {start: (...args: Parameters<ContainerExecPorts<symbol>["startContainer"]>) => {
                expect(args[8]).toBe(id); expect(args[6](vi.fn())).toBe(false);
                expect(f.ports.ensureSocketAccess).not.toHaveBeenCalled();
                ready = true; args[7](id, {startedByInvocation: false}); return "ccc-repo";
            }, initialize};
        });
        await expect(f.exec("/repo", ["codex"])).resolves.toBe(0);
        expect(initialize).toHaveBeenCalledOnce(); expect(f.ports.prepareCommand).toHaveBeenCalledWith(expect.objectContaining({target: id}));
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenCalledExactlyOnceWith(id, {startedByInvocation: false});
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true); expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });
    it.each(["absent", "state-unknown", "changed", "invalid-acquired"] as const)("refuses %s admission before any startup call", async fault => {
        const f = restricted(), start = vi.fn(f.ports.startContainer); f.ports.startContainer = start;
        if (fault === "invalid-acquired") f.ports.acquireOwnership = async () => ({lockFile: "/owned/session.lock", existingId: "short", existingOnly: true});
        else f.ports.containerStatus = () => ({exists: fault !== "absent", running: fault === "state-unknown" ? undefined as unknown as boolean : true,
            containerId: fault === "changed" ? "b".repeat(64) : id, imageId: "image"});
        await refused(f); expect(start).not.toHaveBeenCalled();
    });
    it.each(["start-timeout", "live-proof"] as const)("a stopped-target %s failure dispatches no setup, generic intent or guessed cleanup", async stage => {
        const f = restricted({stopped: true, provisional: true}), failure = new Error(stage);
        const initialize = vi.fn();
        f.ports.prepareContainer = vi.fn(policy => {
            expect(policy).toEqual({existingContainerId: id});
            return {start: (...args: Parameters<ContainerExecPorts<symbol>["startContainer"]>) => { expect(args[8]).toBe(id); throw failure; }, initialize};
        });
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(initialize).not.toHaveBeenCalled(); expect(f.ports.ensureSocketAccess).not.toHaveBeenCalled();
        expect(f.ports.prepareCommand).not.toHaveBeenCalled(); expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.beginSessionStartupInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.recordSessionOwnStartInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true); expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
    });
    it("denies replacement before proof or peer inspection, preserving the running target", async () => {
        const f = restricted(), replacement = vi.fn();
        f.ports.startContainer = (...args) => { expect(args[6](replacement)).toBe(false); args[7](id, {startedByInvocation: false}); return "ccc-repo"; };
        await expect(f.exec("/repo", ["codex"])).resolves.toBe(0);
        expect(replacement).not.toHaveBeenCalled(); expect(f.ports.verifyStoppedSessionContainerForReplacement).not.toHaveBeenCalled();
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
    });
    it.each(["before-mutation", "own-start", "owned-ready", "different-ready"] as const)("rejects an unexpected %s callback before publishing authority or dispatching mutation", async callback => {
        const f = restricted(); let dispatched = 0;
        f.ports.startContainer = (...args) => {
            if (callback === "before-mutation") args[11]?.();
            else if (callback === "own-start") args[9](id);
            else args[7](callback === "different-ready" ? "b".repeat(64) : id, {startedByInvocation: callback === "owned-ready"});
            dispatched++; return "ccc-repo";
        };
        await refused(f); expect(dispatched).toBe(0); expect(f.ports.publishSessionReadyInHeldLifecycleLock).not.toHaveBeenCalled();
    });
    it("keeps the mutation barrier active on a later tool-readiness retry after a false ready handoff", async () => {
        const f = restricted(); let running = true, starts = 0, dispatched = 0;
        f.ports.containerRunning = () => running;
        vi.mocked(f.ports.installTools).mockImplementation(() => { running = false; throw new Error("target disappeared during setup"); });
        f.ports.startContainer = (...args) => {
            expect(args[8]).toBe(id);
            if (++starts === 1) { args[7](id, {startedByInvocation: false}); return "ccc-repo"; }
            args[11]?.(); dispatched++; throw new Error("mutation should have been refused");
        };
        await refused(f); expect(starts).toBe(2); expect(dispatched).toBe(0);
        expect(f.ports.prepareContainer).toHaveBeenCalledExactlyOnceWith({existingContainerId: id});
        expect(f.ports.publishSessionReadyInHeldLifecycleLock).toHaveBeenCalledExactlyOnceWith(id, {startedByInvocation: false});
    });
});
