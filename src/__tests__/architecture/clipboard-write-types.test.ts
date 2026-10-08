import { describe, expect, it } from "vitest";
import { createClipboardTextWriter } from "../../application/clipboard/text-write.js";
import { createClipboardSnapshotState } from "../../application/clipboard/snapshot.js";
import type { ClipboardTextWritePorts } from "../../ports/clipboard/text-write.js";
import type { writeClipboardText as publicWrite } from "../../clipboard-server.js";

type Bytes = { readonly length: number; readonly opaque: "bytes" };
type Prepared = { readonly opaque: "prepared" }; type Writer = { readonly opaque: "writer" }; type Timer = { readonly opaque: "timer" };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type PublicShape = Assert<Equal<typeof publicWrite, (text: string, plat: import("../../domain/clipboard/snapshot.js").ClipboardPlatform) => Promise<void>>>;
const publicShape: PublicShape = true; void publicShape;
function compileContracts(ports: ClipboardTextWritePorts<Bytes, Prepared, Writer, Timer>) {
    const state = createClipboardSnapshotState<Bytes>(); const write = createClipboardTextWriter(ports, state);
    const result: Promise<void> = write("text", "darwin"); const clear: undefined = ports.cancelReadTimer({ opaque: "timer" });
    void [result, clear];
    // @ts-expect-error Shared state must be supplied.
    createClipboardTextWriter(ports);
    // @ts-expect-error Text remains a required string.
    write(3, "windows");
    // @ts-expect-error Platform remains required.
    write("text");
    // @ts-expect-error Supported platform union is closed.
    write("text", "freebsd");
    // @ts-expect-error Launching the opaque writer is synchronous.
    createClipboardTextWriter({ ...ports, launchWriter: async () => ({ opaque: "writer" } as const) }, state);
    // @ts-expect-error Timer cancellation cannot return void.
    createClipboardTextWriter({ ...ports, cancelReadTimer: (): void => {} }, state);
    // @ts-expect-error Timer cancellation cannot return a Promise.
    createClipboardTextWriter({ ...ports, cancelReadTimer: async () => undefined }, state);
    // @ts-expect-error Writer registration cannot be asynchronous.
    createClipboardTextWriter({ ...ports, onWriterError: async () => undefined }, state);
    // @ts-expect-error Input registration cannot be asynchronous.
    createClipboardTextWriter({ ...ports, onInputError: async () => undefined }, state);
    // @ts-expect-error Writer termination cannot be asynchronous.
    createClipboardTextWriter({ ...ports, killWriter: async () => undefined }, state);
    // @ts-expect-error End input is an ignored synchronous effect, never an adoption boundary.
    createClipboardTextWriter({ ...ports, endInput: async () => undefined }, state);
    // @ts-expect-error Opaque timers do not accept native numeric IDs.
    ports.cancelReadTimer(3);
    // @ts-expect-error Writer and preparation receipts cannot be interchanged.
    ports.endInput({ opaque: "prepared" }, { opaque: "writer" });
    // @ts-expect-error Write returns the original named async Promise rather than void.
    const synchronous: void = write("text", "linux-x11"); void synchronous;
}
void compileContracts;
describe("Clipboard write type contract", () => {
    it("keeps the factory callable without importing a native executor", () => { expect(createClipboardTextWriter.name).toBe("createClipboardTextWriter"); });
});
