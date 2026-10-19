import {describe, expect, it, vi} from "vitest";
import {createContainerExec, containerExecReplacementBlockReason} from "../../application/container-exec.js";
import type {ContainerExecPorts} from "../../ports/container-exec.js";
import {createDefaultToolCatalog} from "../../domain/tool-registry.js";

function fixture(options: {running?: boolean; replace?: boolean} = {}) {
    const catalog = createDefaultToolCatalog(), events: string[] = [];
    const handle: symbol = Symbol("owned preparation");
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
        ensureClipboard: async () => null, clipboardPortFile: () => "/owned/clipboard.port", clipboardConnection: () => ({}),
        worktreeMounts: () => [], containerName: () => "ccc-repo",
        containerStatus: () => ({exists: true, running: Boolean(options.running), containerId: options.running ? "final-id" : "setup-id", imageId: "image-id"}),
        sessionClaims: () => ["session.lock"], lockName: () => "session.lock", prepareDeviceBroker: async () => {},
        async lifecycleLock<T>(_prefix: string, operation: () => Promise<T> | T): Promise<T> { return operation(); },
        async setupLock<T>(_prefix: string, operation: () => Promise<T> | T): Promise<T> { return operation(); },
        async stateLock<T>(operation: () => Promise<T> | T): Promise<T> { return operation(); },
        prepareContainer: () => ({start: (...args) => ports.startContainer(...args), initialize: vi.fn()}),
        startContainer: (_path, _ensure, _mounts, _port, _profile, _recreate, _replacement, onReady, _expected, onStarted) => {
            const id = options.replace && first ? "setup-id" : "final-id"; first = false;
            if (!options.running) onStarted(id); onReady(id, {startedByInvocation: !options.running}); return "ccc-repo";
        },
        setSessionContainer: vi.fn(), setCleanupEnabled: vi.fn(), confirmOwnership: vi.fn(async () => { events.push("confirm"); }),
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
    return {ports, entries, handle, events, exec: createContainerExec(ports).exec};
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
        {name: "clipboard port lookup", wrapped: false, restores: 0, install: (f, failure) => { f.ports.clipboardPortFile = () => { throw failure; }; }},
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
            if (started) args[9]("setup-id");
            expect(args[6](remove)).toBe(false);
            throw failure;
        };
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(remove).not.toHaveBeenCalled();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        if (started) expect(f.ports.setCleanupEnabled).toHaveBeenCalledWith(true);
        else expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
    });

    it("uses normal guarded replacement only after a legacy candidate reaches verified live-ready", async () => {
        const f = fixture(), replace = vi.fn();
        f.ports.acquireOwnership = async () => ({lockFile: "/owned/session.lock", existingId: "setup-id", requiresLiveVerification: true});
        f.ports.startContainer = (...args) => {
            expect(args[6](replace)).toBe(false);
            args[9]("setup-id");
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
        expect(f.ports.setSessionContainer).toHaveBeenLastCalledWith("final-id");
        expect(f.ports.setCleanupEnabled).toHaveBeenCalledWith(false);
        expect(f.ports.setCleanupEnabled).not.toHaveBeenCalledWith(true);
        expect(f.ports.cleanupSession).toHaveBeenCalledOnce();
        expect(f.ports.launchCommand).not.toHaveBeenCalled();
    });

    it.each([false, true])("settles captured-start acknowledgement before cleanup after a synchronous start failure (ACK rejects=%s)", async rejects => {
        const f = fixture(), gate = deferred<void>(), entered = deferred<void>();
        const primary = new Error("start helper failed after creating container"), acknowledgement = new Error("ACK failed");
        f.ports.startContainer = (...args) => { args[9]("partial-start-id"); throw primary; };
        vi.mocked(f.ports.confirmOwnership).mockImplementation(async () => { entered.resolve(); await gate.promise; });
        vi.mocked(f.ports.report).mockImplementation(report => { if (report.kind === "ownership-unconfirmed") throw new Error("report failed"); });
        const result = settled(f.exec("/repo", ["codex"]));
        await entered.promise;
        expect(f.ports.setSessionContainer).toHaveBeenLastCalledWith("partial-start-id");
        expect(f.ports.setCleanupEnabled).toHaveBeenLastCalledWith(true);
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
    it("prepares once before mutation locks and initializes after release and ownership acknowledgement", async () => {
        const f = fixture();
        let stateHeld = false, lifecycleHeld = false, setupHeld = false;
        f.ports.setupLock = async (_prefix, operation) => { setupHeld = true; try { return await operation(); } finally { setupHeld = false; } };
        f.ports.stateLock = async operation => { expect(setupHeld).toBe(true); stateHeld = true; try { return await operation(); } finally { stateHeld = false; } };
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
    it("preparation failure performs no mutation admission or command launch", async () => {
        const f = fixture(), failure = new Error("image preparation unavailable");
        f.ports.prepareContainer = () => { throw failure; };
        let stateCalls = 0, lifecycleCalls = 0;
        f.ports.stateLock = async <T>(operation: () => T | Promise<T>): Promise<T> => {
            stateCalls++; return operation();
        };
        f.ports.lifecycleLock = async <T>(_prefix: string, operation: () => T | Promise<T>): Promise<T> => {
            lifecycleCalls++; return operation();
        };
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(stateCalls).toBe(0); expect(lifecycleCalls).toBe(0);
        expect(f.ports.setSessionContainer).not.toHaveBeenCalled(); expect(f.ports.launchCommand).not.toHaveBeenCalled();
    });
    it("helper failure retains acknowledged exact startup identity for cleanup", async () => {
        const f = fixture(), failure = new Error("SSH initialization failed");
        f.ports.prepareContainer = () => ({start: f.ports.startContainer, initialize: () => {
            expect(f.ports.setSessionContainer).toHaveBeenLastCalledWith("final-id");
            expect(f.ports.confirmOwnership).toHaveBeenCalled(); throw failure;
        }});
        await expect(f.exec("/repo", ["codex"])).rejects.toMatchObject({cause: failure});
        expect(f.ports.setCleanupEnabled).toHaveBeenLastCalledWith(true); expect(f.ports.launchCommand).not.toHaveBeenCalled();
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
        f.ports.startContainer = (_path, _ensure, _mounts, _port, _profile, _recreate, _replacement, onReady, _expected, onStarted) => {
            const id = ++starts === 1 ? "initial-id" : "replacement-id";
            onStarted(id); onReady(id, {startedByInvocation: true}); return "ccc-repo";
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
        expect(f.ports.setSessionContainer).toHaveBeenLastCalledWith(finalId);
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
        expect(vi.mocked(f.ports.prepareCommand).mock.calls[0][0].environment).toEqual([...f.entries, ["MISE_NODE_VERSION", "22"], ["BASH_ENV", "/home/ccc/.bashrc_hooks"]]);
        expect(vi.mocked(f.ports.prepareCommand).mock.calls[0][0].command).toEqual({kind: "claude", arguments: args});
        expect(f.ports.prepareCodexCommand).not.toHaveBeenCalled();
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
        expect(f.ports.setSessionContainer).not.toHaveBeenCalled();
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
