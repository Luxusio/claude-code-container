import {describe, expect, it, vi} from "vitest";
import {createSessionOwnershipPublication} from "../../application/session-ownership-publication.js";
import {currentSessionClaimAuthority, type SessionClaimObservation} from "../../domain/session-claim-observation.js";
import {NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeInvocation, type NativeRuntimeSelectors} from "../../ports/container-runtime-invocation.js";
import type {BeginSessionClaimObservation, SessionClaimObservationSnapshot} from "../../ports/session-claim-observation.js";
import type {SessionClaimObservationBinding} from "../../domain/session-claim-observation.js";
import type {SessionOwnershipPublicationEffects, SessionOwnershipPublicationPorts, SessionOwnershipReceipt} from "../../ports/session-ownership.js";

const container = "a".repeat(64), differentContainer = "b".repeat(64);
const noFailure = Symbol("operation returned");
function failureFrom(operation: () => unknown): unknown {
    try { operation(); return noFailure; } catch (error) { return error; }
}

/** State transitions only; native receipt, filesystem and guardian qualification have their own owners. */
function fixture(name = "first") {
    const binding: SessionClaimObservationBinding = {
        lockFile: `/claims/${name}.lock`, projectPath: `/projects/${name}`, prefix: name, profile: "default", toolName: "codex",
    };
    const receipt: SessionOwnershipReceipt = {
        path: binding.lockFile, bytes: "captured-claim", device: "1", inode: "2", birthtime: "3", ownerPid: 41,
    };
    const runtime: NativeRuntimeInvocation = {
        version: 1, runtime: "docker", executable: "/captured/docker",
        transport: {kind: "docker", host: `unix:///${name}.sock`, configDirectory: "/captured/config",
            tls: {enabled: false, verify: false, caFile: null, certFile: null, keyFile: null}},
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])) as NativeRuntimeSelectors,
    };
    const replacementFailure = new Error("captured observation replaced");
    let saved: SessionClaimObservationSnapshot | null = null;
    let nextInode = 10;
    const store = {
        begin: vi.fn((options: BeginSessionClaimObservation): SessionClaimObservationSnapshot => {
            const runtimeReceipt = {path: `${receipt.path}.runtime`, bytes: "captured-runtime", device: "1", inode: "4", birthtime: "5"};
            saved = {
                receipt: options.receipt, runtimeInvocation: options.runtimeInvocation, runtimeReceipt,
                observationReceipt: {path: `${receipt.path}.observation`, bytes: "initial", device: "1", inode: "6", birthtime: "7"},
                observation: {
                    version: 1, claim: {...options.receipt, digest: "c".repeat(64)},
                    binding: options.binding, runtime: {...runtimeReceipt, digest: "d".repeat(64)}, guardian: options.guardian,
                    registration: "pending", generation: options.generation, pending: null, lastAcknowledged: null, ownStarted: null,
                    recovery: {status: "active", diagnostic: null},
                },
            };
            return saved;
        }),
        assertCurrent: vi.fn((snapshot: SessionClaimObservationSnapshot): void => {
            if (snapshot !== saved) throw replacementFailure;
        }),
        update: vi.fn((snapshot: SessionClaimObservationSnapshot, observation: SessionClaimObservation): SessionClaimObservationSnapshot => {
            store.assertCurrent(snapshot);
            saved = {...snapshot, observation,
                observationReceipt: {...snapshot.observationReceipt, inode: String(nextInode++), bytes: JSON.stringify(observation)}};
            return saved;
        }),
    };
    const effects: SessionOwnershipPublicationEffects = {
        store,
        guardianStartToken: vi.fn(() => "captured-guardian-start"),
        withLifecycleLock: vi.fn(async <T>(operation: () => T | Promise<T>): Promise<T> => operation()),
    };
    const app = createSessionOwnershipPublication(binding, receipt, runtime, effects);
    const current = (): SessionClaimObservationSnapshot => {
        if (!saved) throw new Error("fixture has no registered observation");
        return saved;
    };
    return {app, binding, receipt, runtime, effects, store, current, replacementFailure,
        replace() { saved = {...current(), observationReceipt: {...current().observationReceipt, inode: "replacement"}}; return saved; }};
}

describe("session ownership publication", () => {
    it("registers the captured binding, receipt, runtime and observed guardian before readiness", () => {
        const f = fixture();
        f.app.registerGuardian(73);
        const registration = f.store.begin.mock.calls[0][0], initial = f.current();
        expect(registration.receipt).toBe(f.receipt);
        expect(registration.binding).toBe(f.binding);
        expect(registration.runtimeInvocation).toBe(f.runtime);
        expect(registration.guardian).toEqual({pid: 73, startToken: "captured-guardian-start"});
        expect(registration.generation).toBe("0");
        expect(initial.observation.registration).toBe("pending");
        expect(currentSessionClaimAuthority(initial.observation)).toBeNull();
        f.app.ready();
        expect(f.store.update.mock.calls[0][0]).toBe(initial);
        expect(initial.observation.registration).toBe("pending");
        expect(f.current().observation.registration).toBe("ready");
        expect(f.current().receipt).toBe(f.receipt);
        expect(f.current().runtimeInvocation).toBe(f.runtime);
        expect(f.current().runtimeReceipt).toBe(initial.runtimeReceipt);
    });

    it("retains unavailable guardian identity rather than inventing a start token", () => {
        const f = fixture();
        vi.mocked(f.effects.guardianStartToken).mockReturnValue(null);
        f.app.registerGuardian(73);
        expect(f.current().observation.guardian).toEqual({pid: 73, startToken: null});
    });

    it.each([undefined, 0, -1, 1.5])("refuses unavailable guardian PID %s without registration", pid => {
        const f = fixture();
        expect(() => f.app.registerGuardian(pid)).toThrow("Session guardian process identity is unavailable.");
        expect(f.store.begin).not.toHaveBeenCalled();
    });

    it("refuses every transition until guardian registration succeeds", () => {
        const f = fixture();
        for (const transition of [
            () => f.app.ready(), () => f.app.stageUpdate(1, container, true),
            () => f.app.acknowledgeUpdate({generation: "0", sequence: 1}),
            () => f.app.beginStartup(), () => f.app.recordOwnStart(container),
        ]) expect(transition).toThrow("Session guardian responsibility was not registered.");
        expect(f.store.update).not.toHaveBeenCalled();
    });

    it("grants current acknowledged responsibility only after ready, staging and matching ACK", () => {
        const f = fixture(); f.app.registerGuardian(73); f.app.ready();
        const publication = f.app.stageUpdate(7, container, true);
        expect(publication).toEqual({generation: "1", sequence: 7});
        expect(f.current().observation.pending).toEqual({kind: "update", generation: "1", sequence: 7, containerId: container, cleanupEnabled: true});
        expect(currentSessionClaimAuthority(f.current().observation)).toBeNull();
        expect(f.app.acknowledgeUpdate(publication)).toBe(true);
        const acknowledged = f.current();
        expect(acknowledged.observation.pending).toBeNull();
        expect(acknowledged.observation.lastAcknowledged).toEqual({generation: "1", sequence: 7, containerId: container, cleanupEnabled: true});
        expect(currentSessionClaimAuthority(acknowledged.observation)).toEqual({containerId: container, source: "ack"});
        expect(f.app.acknowledgeUpdate(publication)).toBe(false);
        expect(f.current()).toBe(acknowledged);
    });

    it("leaves the newer staged update intact when an older generation or wrong sequence ACK arrives", () => {
        const f = fixture(); f.app.registerGuardian(73); f.app.ready();
        const old = f.app.stageUpdate(7, container, true);
        const latest = f.app.stageUpdate(8, differentContainer, false), pending = f.current();
        for (const stale of [old, {...latest, sequence: 7}, {...latest, generation: "future"}]) {
            expect(f.app.acknowledgeUpdate(stale)).toBe(false);
            expect(f.current()).toBe(pending);
        }
        expect(f.app.acknowledgeUpdate(latest)).toBe(true);
        expect(f.current().observation.lastAcknowledged?.cleanupEnabled).toBe(false);
        expect(currentSessionClaimAuthority(f.current().observation)).toBeNull();
    });

    it("refuses an ACK for startup intent even if generation and sequence match", () => {
        const f = fixture(); f.app.registerGuardian(73);
        f.app.stageUpdate(9, container, true); f.app.beginStartup();
        const startup = f.current();
        expect(f.app.acknowledgeUpdate({generation: startup.observation.generation, sequence: 9})).toBe(false);
        expect(f.current()).toBe(startup);
        expect(currentSessionClaimAuthority(startup.observation)).toBeNull();
    });

    it.each(["intent", "own-start"] as const)("uses pending, acknowledged, then zero sequence precedence for %s", kind => {
        for (const [acknowledged, pending, expected] of [[null, null, 0], [7, null, 7], [7, 11, 11]] as const) {
            const f = fixture(); f.app.registerGuardian(73); f.app.ready();
            if (acknowledged !== null) f.app.acknowledgeUpdate(f.app.stageUpdate(acknowledged, container, true));
            if (pending !== null) f.app.stageUpdate(pending, differentContainer, false);
            if (kind === "intent") f.app.beginStartup(); else f.app.recordOwnStart(container);
            const state = f.current().observation;
            expect(state.pending).toEqual({kind: "startup", generation: state.generation, sequence: expected,
                containerId: kind === "intent" ? null : container, cleanupEnabled: kind === "own-start"});
            expect(state.ownStarted).toEqual(kind === "intent" ? null : {generation: state.generation, containerId: container});
            expect(currentSessionClaimAuthority(state)).toEqual(kind === "intent" ? null : {containerId: container, source: "own-start"});
        }
    });

    it.each([
        {target: container, cleanup: true, carried: true}, {target: container, cleanup: false, carried: false},
        {target: differentContainer, cleanup: true, carried: false}, {target: null, cleanup: true, carried: false},
    ])("carries own-start only for exact target $target with cleanup=$cleanup", ({target, cleanup, carried}) => {
        const f = fixture(); f.app.registerGuardian(73); f.app.recordOwnStart(container);
        const publication = f.app.stageUpdate(5, target, cleanup), state = f.current().observation;
        expect(state.ownStarted).toEqual(carried ? {generation: publication.generation, containerId: container} : null);
        expect(currentSessionClaimAuthority(state)).toEqual(carried ? {containerId: container, source: "own-start"} : null);
    });

    it("keeps the previous snapshot after a failed write and never reuses its allocated generation", () => {
        const f = fixture(); f.app.registerGuardian(73); f.app.ready();
        const before = f.current();
        f.store.update.mockImplementationOnce(() => { throw 0; });
        expect(failureFrom(() => f.app.stageUpdate(1, container, true))).toBe(0);
        expect(f.current()).toBe(before);
        expect(before.observation.pending).toBeNull();
        const retry = f.app.stageUpdate(2, differentContainer, false);
        expect(retry).toEqual({generation: "2", sequence: 2});
        expect(f.store.update.mock.lastCall?.[0]).toBe(before);
        expect(f.current().observation.pending?.containerId).toBe(differentContainer);
    });

    it.each([
        {stage: "guardian identity", failure: undefined}, {stage: "registration", failure: false},
        {stage: "current identity", failure: null}, {stage: "write", failure: "write refused"},
    ])("preserves raw $stage failure identity", ({stage, failure}) => {
        const f = fixture();
        if (stage === "guardian identity") vi.mocked(f.effects.guardianStartToken).mockImplementation(() => { throw failure; });
        else if (stage === "registration") f.store.begin.mockImplementation(() => { throw failure; });
        if (stage === "guardian identity" || stage === "registration") {
            expect(failureFrom(() => f.app.registerGuardian(73))).toBe(failure);
            expect(() => f.app.ready()).toThrow("Session guardian responsibility was not registered.");
            expect(f.store.update).not.toHaveBeenCalled();
        } else {
            f.app.registerGuardian(73);
            const before = f.current();
            if (stage === "current identity") f.store.assertCurrent.mockImplementation(() => { throw failure; });
            else f.store.update.mockImplementation(() => { throw failure; });
            expect(failureFrom(() => f.app.ready())).toBe(failure);
            expect(f.current()).toBe(before);
            expect(before.observation.registration).toBe("pending");
        }
    });

    it("refuses a replaced snapshot without publishing over its successor", () => {
        const f = fixture(); f.app.registerGuardian(73); f.app.ready();
        const publication = f.app.stageUpdate(1, container, true), successor = f.replace();
        expect(failureFrom(() => f.app.acknowledgeUpdate(publication))).toBe(f.replacementFailure);
        expect(failureFrom(() => f.app.recordOwnStart(container))).toBe(f.replacementFailure);
        expect(f.current()).toBe(successor);
        expect(successor.observation.pending?.generation).toBe(publication.generation);
    });

    it("uses no implicit guard and exposes the supplied standalone asynchronous guard", async () => {
        const f = fixture(), lockFailure = new Error("unexpected reentry");
        vi.mocked(f.effects.withLifecycleLock).mockImplementation(async () => { throw lockFailure; });
        f.app.registerGuardian(73); f.app.ready();
        f.app.acknowledgeUpdate(f.app.stageUpdate(1, container, true));
        f.app.beginStartup(); f.app.recordOwnStart(container);
        expect(f.effects.withLifecycleLock).not.toHaveBeenCalled();
        vi.mocked(f.effects.withLifecycleLock).mockImplementation(async operation => operation());
        const result = {completed: true};
        const operation = () => { f.app.stageUpdate(2, container, false); return result; };
        await expect(f.app.withLifecycleLock(operation)).resolves.toBe(result);
        expect(f.effects.withLifecycleLock).toHaveBeenCalledWith(operation);
        expect(f.current().observation.ownStarted).toBeNull();
    });

    it("keeps concurrently constructed publishers' state and authority independent", () => {
        const first = fixture("first"), second = fixture("second");
        first.app.registerGuardian(73); second.app.registerGuardian(74);
        first.app.ready(); second.app.ready();
        const one = first.app.stageUpdate(1, container, true), two = second.app.stageUpdate(1, differentContainer, true);
        const secondPending = second.current();
        first.app.acknowledgeUpdate(one); first.app.beginStartup();
        expect(second.current()).toBe(secondPending);
        expect(second.app.acknowledgeUpdate(two)).toBe(true);
        expect(second.current().receipt).toBe(second.receipt);
        expect(second.current().runtimeInvocation).toBe(second.runtime);
        expect(currentSessionClaimAuthority(second.current().observation)).toEqual({containerId: differentContainer, source: "ack"});
        expect(currentSessionClaimAuthority(first.current().observation)).toBeNull();
    });
});

function consumedContracts(binding: SessionClaimObservationBinding, receipt: SessionOwnershipReceipt,
    runtime: NativeRuntimeInvocation, effects: SessionOwnershipPublicationEffects) {
    const publication: SessionOwnershipPublicationPorts = createSessionOwnershipPublication(binding, receipt, runtime, effects);
    const {store, ...withoutStore} = effects;
    // @ts-expect-error Publication requires the captured observation store.
    createSessionOwnershipPublication(binding, receipt, runtime, withoutStore);
    // @ts-expect-error Guardian process observation is synchronous before registration.
    createSessionOwnershipPublication(binding, receipt, runtime, {...effects, guardianStartToken: async () => null});
    // @ts-expect-error Transition writes finish before acknowledgement can authorize cleanup.
    createSessionOwnershipPublication(binding, receipt, runtime, {...effects, store: {...store, update: async () => undefined}});
    void publication;
}
void consumedContracts;
