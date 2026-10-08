import { describe, expect, it } from "vitest";
import { createClipboardSnapshotReader, createClipboardSnapshotState, invalidateClipboardCache } from "../../application/clipboard/snapshot.js";
import type { ClipboardSnapshot, ClipboardSnapshotState } from "../../domain/clipboard/snapshot.js";
import type { ClipboardSnapshotPorts } from "../../ports/clipboard/snapshot.js";

type Bytes = { readonly length: number; readonly opaque: unique symbol };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type State = Assert<Equal<ReturnType<typeof createClipboardSnapshotState<Bytes>>, ClipboardSnapshotState<Bytes>>>;
type NoByteMethods = Assert<Equal<keyof import("../../domain/clipboard/snapshot.js").ClipboardBytes, "length">>;
const contracts: [State, NoByteMethods] = [true, true]; void contracts;
function compileContracts(ports: ClipboardSnapshotPorts<Bytes>, bytes: Bytes) {
    const state = createClipboardSnapshotState<Bytes>(); const read = createClipboardSnapshotReader(ports, state);
    const promise: Promise<ClipboardSnapshot<Bytes>> = read("linux-wayland", true);
    const effect: undefined = invalidateClipboardCache(state);
    const opaque: Bytes | null = state.cache?.imagePng ?? bytes;
    void [promise, effect, opaque];
    // @ts-expect-error State is explicit and shared by the composition root.
    createClipboardSnapshotReader(ports);
    // @ts-expect-error Native marker reads are asynchronous.
    createClipboardSnapshotReader({ ...ports, readChangeMarker: () => "marker" }, state);
    // @ts-expect-error A complete native snapshot workflow cannot replace target facts.
    createClipboardSnapshotReader({ ...ports, readTargets: async () => [] }, state);
    // @ts-expect-error File-copy effects retain synchronous byte results.
    createClipboardSnapshotReader({ ...ports, copyImageFile: async () => bytes }, state);
    // @ts-expect-error Concrete bytes stay opaque and cannot silently become strings.
    createClipboardSnapshotReader({ ...ports, readText: () => "text" }, state);
    // @ts-expect-error Native read failures must supply the concrete error factory.
    createClipboardSnapshotReader({ ...ports, createReadError: undefined }, state);
    // @ts-expect-error Snapshot platform is a closed public union.
    read("freebsd");
    // @ts-expect-error No force flag string normalization occurs.
    read("darwin", "true");
    // @ts-expect-error Cached-read API remains asynchronous.
    const synchronous: ClipboardSnapshot<Bytes> = read("windows");
    // @ts-expect-error Cache invalidation must finish synchronously.
    const asynchronous: Promise<undefined> = invalidateClipboardCache(state);
    void [synchronous, asynchronous];
}
void compileContracts;
describe("Clipboard snapshot type contract", () => {
    it("creates one explicit empty state and invalidates it synchronously", () => {
        const state = createClipboardSnapshotState<Bytes>(); expect(state.cache).toBeNull(); expect(state.generation).toBe(0);
        expect(invalidateClipboardCache(state)).toBeUndefined(); expect(state.generation).toBe(1);
    });
});
