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
        detectWorktreeBranch: () => null, assertWorktreeBranch: vi.fn(),
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
