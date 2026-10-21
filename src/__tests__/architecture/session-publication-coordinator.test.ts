import {describe, expect, it} from "vitest";
import {createSessionPublicationCoordinator} from "../../application/session-publication-coordinator.js";
import type {SessionOwnershipHandle} from "../../ports/session-ownership.js";

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

type Update = {owner: SessionOwnershipHandle; containerId: string | null; enabled: boolean};

/** Policy effects only: native guards, receipts and guardian IPC retain their existing test owners. */
function fixture() {
    const events: string[] = [], cleanup: boolean[] = [], targets: (string | null)[] = [];
    const prepared: Update[] = [], dispatched: Update[] = [];
    const control: {
        owner: SessionOwnershipHandle | null;
        prepare(update: Update): (() => Promise<boolean>) | undefined;
    } = {owner: null, prepare: () => async () => true};
    const names = new Map<SessionOwnershipHandle, string>();
    function prepare(update: Update): (() => Promise<boolean>) | undefined {
        prepared.push(update);
        events.push(`prepare:${names.get(update.owner)}:${update.containerId}:${update.enabled}`);
        const dispatch = control.prepare(update);
        if (!dispatch) return undefined;
        return () => { dispatched.push(update); return dispatch(); };
    }
    function makeOwner(name: string): SessionOwnershipHandle {
        const owner: SessionOwnershipHandle = {
            async updateContainer() { throw new Error("unexpected unguarded transport"); },
            async updateContainerInHeldLifecycleLock() { throw new Error("unexpected immediate transport"); },
            prepareContainerUpdateInHeldLifecycleLock(containerId, enabled = false) {
                const dispatch = prepare({owner, containerId, enabled});
                if (!dispatch) throw new Error("fixture held preparation has no dispatch");
                return dispatch;
            },
            beginStartupInHeldLifecycleLock() { events.push(`startup:${name}`); },
            recordOwnStartInHeldLifecycleLock(id) { events.push(`own-start:${name}:${id}`); },
            async release() { throw new Error("coordinator must not release ownership"); },
            assertOwnership() { events.push(`assert:${name}`); },
        };
        names.set(owner, name);
        return owner;
    }
    const owner = makeOwner("first");
    control.owner = owner;
    const app = createSessionPublicationCoordinator({
        currentOwnership: () => control.owner,
        prepareStandaloneUpdate: (active, containerId, enabled) => prepare({owner: active, containerId, enabled}),
        setCleanupEnabled(enabled) { cleanup.push(enabled); events.push(`cleanup:${enabled}`); },
        setContainerId(id) { targets.push(id); events.push(`container:${id}`); },
    });
    function holdNext() {
        const started = deferred<void>(), acknowledgement = deferred<boolean>();
        control.prepare = () => () => { started.resolve(); return acknowledgement.promise; };
        return {started: started.promise, acknowledgement};
    }
    return {app, owner, control, events, cleanup, targets, prepared, dispatched, makeOwner, holdNext};
}

describe("session publication coordinator", () => {
    it("prepares a revoke synchronously and rejects an older positive ACK as authorization", async () => {
        const f = fixture(), first = f.holdNext();
        f.app.setCleanupEnabled(true);
        expect(f.prepared).toEqual([{owner: f.owner, containerId: null, enabled: true}]);
        expect(f.dispatched).toEqual([]);
        await first.started;
        f.app.setCleanupEnabled(false);
        expect(f.cleanup).toEqual([false]);
        expect(f.prepared.map(update => update.enabled)).toEqual([true, false]);
        first.acknowledgement.resolve(true);
        await f.app.confirm();
        expect(f.dispatched.map(update => update.enabled)).toEqual([true, false]);
        expect(f.cleanup).toEqual([false, false]);
    });

    it("retains same-target permission but revokes before publishing a changed target", async () => {
        const f = fixture();
        f.app.recordOwnStartInHeldLifecycleLock(f.owner, "one");
        await f.app.confirm();
        f.events.length = 0;
        f.cleanup.length = 0;
        f.app.setContainerId("one");
        expect(f.cleanup).toEqual([]);
        expect(f.prepared.at(-1)).toEqual({owner: f.owner, containerId: "one", enabled: true});
        f.events.length = 0;
        f.app.setContainerId("two");
        expect(f.events).toEqual(["cleanup:false", "container:two", "prepare:first:two:false"]);
        await f.app.confirm();
        expect(f.dispatched.at(-1)).toEqual({owner: f.owner, containerId: "two", enabled: false});
        expect(f.cleanup.every(enabled => !enabled)).toBe(true);
    });

    it("does not dispatch a prepared update after ownership changes", async () => {
        const f = fixture();
        f.app.setCleanupEnabled(true);
        f.control.owner = f.makeOwner("replacement");
        await f.app.confirm();
        expect(f.prepared).toHaveLength(1);
        expect(f.dispatched).toEqual([]);
        expect(f.cleanup).toEqual([]);
        expect(f.events.at(-1)).toBe("assert:replacement");
    });

    it("does not dispatch an older capture generation even when ownership is unchanged", async () => {
        const f = fixture();
        f.app.setCleanupEnabled(true);
        f.app.beginCapture(false);
        await f.app.confirm();
        expect(f.prepared).toHaveLength(1);
        expect(f.dispatched).toEqual([]);
        expect(f.cleanup).toEqual([false]);
    });

    it("does not grant permission from an ACK belonging to a replaced owner", async () => {
        const f = fixture(), pending = f.holdNext();
        f.app.setCleanupEnabled(true);
        await pending.started;
        f.control.owner = f.makeOwner("replacement");
        pending.acknowledgement.resolve(true);
        await f.app.confirm();
        expect(f.cleanup).toEqual([]);
        expect(f.events.at(-1)).toBe("assert:replacement");
    });

    it("continues later publication after rejection while retaining the exact opaque failure", async () => {
        const f = fixture(), first = f.holdNext();
        const failure = Object.freeze({transport: "opaque rejection"});
        f.app.setCleanupEnabled(true);
        await first.started;
        f.control.prepare = () => async () => true;
        f.app.setCleanupEnabled(false);
        const confirmation = f.app.confirm();
        first.acknowledgement.reject(failure);
        await expect(confirmation).rejects.toBe(failure);
        expect(f.dispatched.map(update => update.enabled)).toEqual([true, false]);
        expect(f.cleanup).toEqual([false, false]);
    });

    it("keeps failure order and cause without flattening an earlier aggregate", async () => {
        const f = fixture(), first = f.holdNext();
        const primary = new Error("first transport"), secondary = new Error("second transport"), third = new Error("third transport");
        f.app.setCleanupEnabled(true);
        await first.started;
        const second = f.holdNext();
        f.app.setCleanupEnabled(false);
        const confirmation = f.app.confirm().catch((error: unknown) => error);
        first.acknowledgement.reject(primary);
        await second.started;
        second.acknowledgement.reject(secondary);
        const combined = await confirmation;
        expect(combined).toBeInstanceOf(AggregateError);
        expect((combined as AggregateError).errors).toEqual([primary, secondary]);
        expect((combined as AggregateError).cause).toBe(primary);

        const last = f.holdNext();
        f.app.setCleanupEnabled(false);
        const lastConfirmation = f.app.confirm().catch((error: unknown) => error);
        await last.started;
        last.acknowledgement.reject(third);
        const final = await lastConfirmation;
        expect(final).toBeInstanceOf(AggregateError);
        expect((final as AggregateError).errors).toEqual([combined, third]);
        expect((final as AggregateError).cause).toBe(combined);
        expect(f.dispatched).toHaveLength(3);
    });

    it("retains publication failure across capture reset but discards it on retirement", async () => {
        const f = fixture(), failure = new Error("prior publication failed");
        f.control.prepare = () => async () => { throw failure; };
        f.app.setCleanupEnabled(true);
        await expect(f.app.confirm()).rejects.toBe(failure);
        f.app.beginCapture(false);
        await expect(f.app.confirm()).rejects.toBe(failure);
        f.app.retire();
        await expect(f.app.confirm()).resolves.toBeUndefined();
        expect(f.dispatched).toHaveLength(1);
    });

    it("records durable own-start and local compensation before preparation can fail", () => {
        const f = fixture(), failure = new Error("guardian closed before preparation");
        f.control.prepare = () => { throw failure; };
        expect(() => f.app.recordOwnStartInHeldLifecycleLock(f.owner, "one")).toThrow(failure);
        expect(f.events).toEqual([
            "own-start:first:one", "container:one", "cleanup:true", "prepare:first:one:true",
        ]);
        expect(f.dispatched).toEqual([]);
    });

    it("stages startup before synchronously revoking cleanup", () => {
        const f = fixture();
        f.app.beginStartupInHeldLifecycleLock(f.owner);
        expect(f.events).toEqual(["startup:first", "cleanup:false"]);
        expect(f.prepared).toEqual([]);
    });

    it("admits a ready-only positive request only after its valid ACK", async () => {
        const f = fixture();
        f.app.beginCapture(false);
        const pending = f.holdNext();
        f.app.publishReadyInHeldLifecycleLock(f.owner, "one", {startedByInvocation: true});
        expect(f.targets).toEqual(["one"]);
        expect(f.cleanup).toEqual([false]);
        await pending.started;
        expect(f.cleanup).toEqual([false]);
        pending.acknowledgement.resolve(true);
        await f.app.confirm();
        expect(f.cleanup).toEqual([false, true]);
    });

    it("captures acquisition ACK without publishing and confirms only the chain present at call", async () => {
        const f = fixture();
        f.app.captureAcknowledgedContainer("one");
        expect(f.targets).toEqual(["one"]);
        expect(f.prepared).toEqual([]);
        const first = f.holdNext();
        f.app.setCleanupEnabled(true);
        await first.started;
        const confirmation = f.app.confirm();
        const later = f.holdNext();
        f.app.setCleanupEnabled(false);
        first.acknowledgement.resolve(true);
        await confirmation;
        expect(f.events).toContain("assert:first");
        await later.started;
        later.acknowledgement.resolve(true);
        await f.app.confirm();
        expect(f.dispatched).toHaveLength(2);
    });
});
