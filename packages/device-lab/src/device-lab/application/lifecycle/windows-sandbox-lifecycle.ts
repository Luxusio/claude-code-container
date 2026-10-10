import { brokerWindowsSandboxField as field, brokerWindowsSandboxCommandSucceeded as succeeded, brokerWindowsSandboxRuntimeChoice } from '../../domain/lifecycle/windows-sandbox-lifecycle.js';
import type { BrokerWindowsSandboxRequest, BrokerWindowsSandboxCommand, BrokerWindowsSandboxResult, BrokerWindowsSandboxPlannedCommand, BrokerWindowsSandboxInput, BrokerWindowsSandboxResponse } from '../../domain/lifecycle/windows-sandbox-lifecycle.js';
import type { BrokerWindowsSandboxLifecyclePorts } from '../../ports/lifecycle/windows-sandbox-lifecycle.js';
export function planBrokerWindowsSandboxCommand(ownerId: string, parsed: BrokerWindowsSandboxRequest, device: unknown, ports: Pick<BrokerWindowsSandboxLifecyclePorts, 'executable' | 'stopRuntimeId' | 'readConfig' | 'newRuntimeId'>): BrokerWindowsSandboxPlannedCommand {
    if (parsed.command === 'device_status')
        return { mode: 'noop', provider: 'wsb', reason: 'Windows Sandbox status/delete is represented by owner state in this broker layer' };
    const executable = ports.executable('wsb');
    const status = String((device as {
        status?: unknown;
    })?.status || '').toLowerCase();
    if (parsed.command === 'device_stop' || (parsed.command === 'device_delete' && ['running', 'booted', 'started', 'starting'].includes(status))) {
        const sandboxId = ports.stopRuntimeId(ownerId, device);
        if (!sandboxId)
            return { error: 'missing-provider-metadata', missing: ['sandboxId GUID'] };
        return { mode: 'exec', provider: 'wsb', executable: executable || undefined, args: ['stop', '--id', sandboxId], sandboxId };
    }
    if (parsed.command === 'device_delete')
        return { mode: 'noop', provider: 'wsb', reason: 'Stopped Windows Sandbox delete is represented by owner state in this broker layer' };
    const config = ports.readConfig(ownerId, parsed.deviceId, field(device, 'configPath') || field(device, 'wsbConfigPath'));
    if (!config.ok)
        return { error: config.error, missing: config.missing };
    const existing = field(device, 'sandboxId');
    const sandboxId = existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing) ? existing : ports.newRuntimeId();
    const minimized = typeof parsed.minimized === 'boolean' ? parsed.minimized : (device as {
        minimized?: unknown;
    })?.minimized !== false;
    return { mode: 'exec', provider: 'wsb', executable: executable || undefined, args: ['start', '--id', sandboxId, '--config', config.config], sandboxId, waitForExit: false, ...(minimized ? { windowStyle: 'minimized' as const } : {}) };
}
type RuntimeObservation = {
    ok: true;
    sandboxIds: string[];
} | {
    ok: false;
    error: BrokerWindowsSandboxResult;
};
function runtimeSnapshot(command: BrokerWindowsSandboxCommand, ports: BrokerWindowsSandboxLifecyclePorts): RuntimeObservation {
    if (ports.platform !== 'win32')
        return { ok: true, sandboxIds: [] };
    if (!command.executable || !command.sandboxId)
        return { ok: false, error: { mode: 'exec', provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: 'windows-sandbox-start-missing-registration-metadata' } };
    const result = ports.execute({ mode: 'exec', provider: 'wsb', executable: command.executable, args: ['list', '--raw'] }, { timeoutMs: 10000, outputLimit: ports.outputLimit });
    return succeeded(result) ? { ok: true, sandboxIds: ports.runtimeIds(result.stdout || '') } : { ok: false, error: { ...result, error: result.error || 'windows-sandbox-runtime-snapshot-failed' } };
}
function registerRuntime(command: BrokerWindowsSandboxCommand, baseline: string[], ports: BrokerWindowsSandboxLifecyclePorts): {
    ok: true;
    sandboxId: string;
} | {
    ok: false;
    error: BrokerWindowsSandboxResult;
} {
    if (ports.platform !== 'win32')
        return { ok: true, sandboxId: command.sandboxId || '' };
    if (!command.executable || !command.sandboxId)
        return { ok: false, error: { mode: 'exec', provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: 'windows-sandbox-start-missing-registration-metadata' } };
    const deadline = ports.now() + 60000;
    let last: BrokerWindowsSandboxResult | null = null;
    while (ports.now() <= deadline) {
        last = ports.execute({ mode: 'exec', provider: 'wsb', executable: command.executable, args: ['list', '--raw'] }, { timeoutMs: Math.min(10000, Math.max(1000, deadline - ports.now())), outputLimit: ports.outputLimit });
        if (succeeded(last)) {
            const choice = brokerWindowsSandboxRuntimeChoice(ports.runtimeIds(last.stdout || ''), baseline, command.sandboxId);
            if (choice.kind === 'requested' || choice.kind === 'single')
                return { ok: true, sandboxId: choice.id };
            if (choice.kind === 'ambiguous' || choice.kind === 'preexisting')
                return { ok: false, error: { ...last, error: choice.error } };
        }
        ports.sleep(500);
    }
    return { ok: false, error: { mode: 'exec', provider: 'wsb', executable: command.executable, args: ['list', '--raw'], status: last?.status ?? null, signal: last?.signal, stdout: last?.stdout, stderr: last?.stderr, timedOut: last?.timedOut, error: `No new Windows Sandbox runtime for ${command.sandboxId} appeared in wsb list within 60000ms` } };
}
export function createBrokerWindowsSandboxLifecycle(ports: BrokerWindowsSandboxLifecyclePorts) {
    async function existing(input: BrokerWindowsSandboxInput): Promise<BrokerWindowsSandboxResponse> {
        const { ownerId, parsed, plan } = input;
        let expected = input.expectedDevice;
        let command = plan?.providerCommand;
        if (parsed.command === 'device_start') {
            const recorded = field(plan?.device, 'configPath') || field(plan?.device, 'wsbConfigPath');
            if (recorded && ports.isCanonicalConfig(ownerId, parsed.deviceId, recorded)) {
                try {
                    ports.writeConfig(ownerId, parsed.deviceId, plan?.device as Record<string, unknown>);
                    command = planBrokerWindowsSandboxCommand(ownerId, parsed, plan?.device, ports);
                }
                catch (error) {
                    return { status: 500, payload: { ok: false, error: 'windows-sandbox-config-refresh-failed', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, detail: error instanceof Error ? error.message : String(error) } };
                }
            }
        }
        if (!command || 'error' in command)
            return { status: 400, payload: { ok: false, error: command?.error || 'missing-provider-command', missing: command?.missing || [], plan: plan ? { ...plan, device: ports.redactDevice(plan.device) } : null } };
        let effective = command;
        if (parsed.command === 'device_start') {
            const lock = ports.claimSingleton(ownerId, plan?.device, command.sandboxId);
            if (!lock.ok)
                return { status: 409, payload: { ok: false, error: 'windows-sandbox-host-busy', detail: lock.error, lock: lock.lock, plan: plan || null } };
        }
        const auxiliary = parsed.command === 'device_stop' || parsed.command === 'device_delete' ? ports.cleanupAuxiliary(ownerId, parsed, expected) : null;
        if (auxiliary?.committed)
            expected = structuredClone(auxiliary.device);
        if (auxiliary?.result.ok === false)
            return { status: 502, payload: { ok: false, error: 'auxiliary-runtime-cleanup-failed', result: { ...(plan || {}), device: ports.redactDevice(auxiliary.device), auxiliaryCleanup: auxiliary.result, invoked: false, dryRun: false, execution: { mode: 'preflight', providerExecution: 'blocked', mutatesHost: auxiliary.result.changed === true || auxiliary.result.appium.cleared === true || auxiliary.result.recording.cleared === true || auxiliary.result.minimizeWatchdog.cleared === true } } } };
        const helper = parsed.command === 'device_start' ? ports.helperPaths(ownerId, parsed.deviceId) : null;
        if (helper) {
            ports.removeMarker(helper.minimizeWatchdogCancelPath);
            ports.removeMarker(helper.minimizeWatchdogResultPath);
        }
        const baseline = helper && ports.platform === 'win32' ? runtimeSnapshot(command, ports) : null;
        if (baseline && !baseline.ok) {
            ports.releaseSingleton(ownerId, plan?.device, command.sandboxId);
            return { status: 502, payload: { ok: false, error: 'windows-sandbox-runtime-snapshot-failed', detail: ports.failureDetail(baseline.error), result: { ...(plan || {}), invoked: false, dryRun: false, execution: { mode: 'preflight', providerExecution: 'blocked', mutatesHost: false, command: baseline.error } } } };
        }
        const startedAfter = helper ? ports.timestampBefore(2000) : null;
        const windowSnapshot = helper && command.windowStyle === 'minimized' && ports.platform === 'win32' ? ports.execute(ports.windowSnapshotCommand(), { timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit }) : null;
        const handles = windowSnapshot && succeeded(windowSnapshot) ? ports.windowHandles(windowSnapshot.stdout || '') : null;
        const execution = ports.execute(effective, { timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit });
        const providerSucceeded = succeeded(execution);
        let success = providerSucceeded;
        const mutatedHost = providerSucceeded || auxiliary?.result.changed === true
            || auxiliary?.result.appium.cleared === true || auxiliary?.result.recording.cleared === true
            || auxiliary?.result.minimizeWatchdog.cleared === true;
        let registration: BrokerWindowsSandboxResult | null = null, watchdog: BrokerWindowsSandboxResult | null = null, confirmation: BrokerWindowsSandboxResult | null = null;
        let watchdogCleanup: ReturnType<BrokerWindowsSandboxLifecyclePorts['cancelWatchdog']> | null = null;
        if (success && parsed.command === 'device_start') {
            const runtime = registerRuntime(command, baseline?.ok ? baseline.sandboxIds : [], ports);
            if (runtime.ok) {
                if (runtime.sandboxId && runtime.sandboxId !== command.sandboxId) {
                    ports.updateSingletonRuntimeId(ownerId, plan?.device, command.sandboxId, runtime.sandboxId);
                    effective = { ...command, sandboxId: runtime.sandboxId, requestedSandboxId: command.sandboxId };
                }
                if (command.windowStyle === 'minimized' && ports.platform === 'win32' && helper && startedAfter && handles !== null) {
                    watchdog = ports.execute(ports.watchdogCommand(startedAfter, helper, handles), { timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit });
                    if (!succeeded(watchdog))
                        confirmation = watchdog;
                }
                else if (command.windowStyle === 'minimized' && ports.platform === 'win32' && helper)
                    confirmation = { mode: 'exec', provider: 'windows-sandbox-window', status: null, error: 'windows-sandbox-window-baseline-unavailable' };
                if (command.windowStyle === 'minimized' && ports.platform === 'win32' && helper && watchdog && succeeded(watchdog))
                    confirmation = ports.waitForMinimizeConfirmation(helper.minimizeWatchdogResultPath);
            }
            else {
                registration = runtime.error;
                success = false;
            }
        }
        if (!success && watchdog?.pid)
            watchdogCleanup = ports.cancelWatchdog(ownerId, parsed.deviceId);
        // Registration failure does not prove a launched runtime is gone. Retain the singleton.
        if (parsed.command === 'device_start' && !success && !registration)
            ports.releaseSingleton(ownerId, plan?.device, effective.sandboxId);
        if (success && (parsed.command === 'device_stop' || parsed.command === 'device_delete')) {
            const observed = ports.inspectExpectedRecord(ownerId, parsed.stateKey, parsed.deviceId, expected);
            if (!observed.matched)
                return { status: 409, payload: { ok: false, error: 'owner-device-state-conflict', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, found: observed.found, result: { ...(plan || {}), providerCommand: effective, device: ports.redactDevice(observed.device), ...(auxiliary ? { auxiliaryCleanup: auxiliary.result } : {}), invoked: true, dryRun: false, execution: { mode: execution.mode, providerExecution: 'executed', mutatesHost: true, command: execution } } } };
            ports.releaseSingleton(ownerId, plan?.device, effective.sandboxId);
        }
        const artifactCleanup = success && parsed.command === 'device_delete' ? ports.cleanArtifacts(ownerId, parsed.deviceId) : null;
        if (artifactCleanup?.ok === false)
            return { status: 502, payload: { ok: false, error: 'windows-sandbox-device-artifact-cleanup-failed', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, result: { ...(plan || {}), device: ports.redactDevice(auxiliary?.device || plan?.device), windowsDeviceArtifactCleanup: artifactCleanup, invoked: true, dryRun: false, execution: { mode: execution.mode, providerExecution: 'executed', mutatesHost: true, command: execution } } } };
        const publication = success ? ports.publish(ownerId, parsed.stateKey, parsed.deviceId, expected, { kind: parsed.command === 'device_start' ? 'start' : parsed.command === 'device_stop' ? 'stop' : 'delete', minimized: parsed.minimized, command: effective, watchdog, confirmation, ...(watchdog && helper ? { watchdogCancelPath: helper.minimizeWatchdogCancelPath } : {}) }) : undefined;
        return { status: publication && !publication.matched ? 409 : success ? 200 : 502, payload: { ok: success && (!publication || publication.matched),
                ...(publication && !publication.matched ? { error: 'owner-device-state-conflict', ownerId, backend: parsed.backend, deviceId: parsed.deviceId, found: publication.found } : {}),
                ...(success || (publication && !publication.matched) ? {} : { error: watchdog && (registration === watchdog || registration?.provider === 'windows-sandbox-window') ? 'windows-sandbox-minimize-watchdog-failed' : 'provider-command-failed', detail: ports.failureDetail(execution) }),
                result: { ...(plan || {}), providerCommand: effective, device: ports.redactDevice(success ? publication?.device : plan?.device), ...(watchdog ? { minimizeWatchdog: watchdog } : {}), ...(confirmation ? { minimizeConfirmation: confirmation } : {}), ...(watchdogCleanup ? { minimizeWatchdogCleanup: watchdogCleanup } : {}), ...(auxiliary ? { auxiliaryCleanup: auxiliary.result } : {}), ...(artifactCleanup ? { windowsDeviceArtifactCleanup: artifactCleanup } : {}), invoked: true, dryRun: false, execution: { mode: execution.mode, providerExecution: 'executed', mutatesHost: mutatedHost, command: registration ? { ...execution, registration, macosBoot: null, androidBoot: null } : execution } } } };
    }
    return { start: existing, stop: existing, delete: existing };
}
