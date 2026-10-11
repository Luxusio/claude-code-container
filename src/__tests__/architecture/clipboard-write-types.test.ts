import { describe, expect, it } from "vitest";
import { createClipboardTextWriter } from "../../application/clipboard/text-write.js";
import { createClipboardSnapshotState } from "../../application/clipboard/snapshot.js";
import type { ClipboardTextWritePorts, ClipboardTextWriteResult, PreparedClipboardTextWrite } from "../../ports/clipboard/text-write.js";
import type { writeClipboardText as publicWrite } from "../../clipboard-server.js";

type Bytes = { readonly length: number; readonly opaque: "bytes" };
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type PublicShape = Assert<Equal<typeof publicWrite, (text: string, plat: import("../../domain/clipboard/snapshot.js").ClipboardPlatform) => Promise<void>>>;
const publicShape: PublicShape = true; void publicShape;
function compileContracts(ports: ClipboardTextWritePorts<Bytes>) {
    const state = createClipboardSnapshotState<Bytes>();
    const write = createClipboardTextWriter(ports, state);
    const result: Promise<void> = write("text", "darwin");
    const preparation: PreparedClipboardTextWrite = ports.prepareWriter({ length: 4, opaque: "bytes" }, "windows");
    if (preparation.kind === "ready") {
        const completion: Promise<ClipboardTextWriteResult> = preparation.write(5000);
        void completion;
    }
    void result;
    // @ts-expect-error Shared state must be supplied.
    createClipboardTextWriter(ports);
    // @ts-expect-error Text remains a required string.
    write(3, "windows");
    // @ts-expect-error Platform remains required.
    write("text");
    // @ts-expect-error Supported platform union is closed.
    write("text", "freebsd");
    // @ts-expect-error Preparation is synchronous and distinct from execution.
    createClipboardTextWriter({ ...ports, prepareWriter: async () => ({ kind: "unavailable" } as const) }, state);
    // @ts-expect-error Native process results are not completion facts.
    const nativeResult: ClipboardTextWriteResult = { status: 0 };
    // @ts-expect-error A ready preparation must provide bounded execution.
    const incomplete: PreparedClipboardTextWrite = { kind: "ready" };
    // @ts-expect-error Execution must return an asynchronous completion fact.
    const synchronous: PreparedClipboardTextWrite = { kind: "ready", write: () => ({ kind: "written" }) };
    // @ts-expect-error Opaque byte carriers cannot be replaced with unrelated values.
    ports.prepareWriter({ opaque: "writer" }, "darwin");
    void [nativeResult, incomplete, synchronous];
}
void compileContracts;
describe("Clipboard write type contract", () => {
    it("accepts a non-native byte carrier and finite completion", async () => {
        const ports: ClipboardTextWritePorts<Bytes> = {
            encodeText: text => ({ length: text.length, opaque: "bytes" }),
            decodeText: () => "text",
            prepareWriter: () => ({ kind: "ready", write: async () => ({ kind: "written" }) }),
        };
        await expect(createClipboardTextWriter(ports, createClipboardSnapshotState<Bytes>())("text", "darwin")).resolves.toBeUndefined();
    });
});
