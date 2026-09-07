import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { incomingMessageBody } from "../device-lab-broker.js";

const asResponse = (source: PassThrough) => source as unknown as IncomingMessage;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function withUncaughtCapture<T>(run: () => Promise<T>): Promise<{ result: T; uncaught: Error[] }> {
    const uncaught: Error[] = [];
    const capture = (error: Error) => { uncaught.push(error); };
    process.on("uncaughtException", capture);
    try {
        return { result: await run(), uncaught };
    } finally {
        process.off("uncaughtException", capture);
    }
}

describe("host-broker response stream adapter", () => {
    // ba61005 drove the stream from 'data' listeners, where a chunk arriving after cancel
    // reached enqueue on a closed controller and threw where nothing could catch it. The
    // invariant that makes that impossible is structural: no listeners at all.
    it("registers no 'data' listener on the broker response", async () => {
        const source = new PassThrough();
        source.write(Buffer.alloc(64, 0x61));
        const reader = incomingMessageBody(asResponse(source)).getReader();
        await reader.read();

        expect(source.listenerCount("data")).toBe(0);
        expect(source.readableFlowing).not.toBe(true);
        await reader.cancel().catch(() => undefined);
    });

    // The in-flight pull does resolve after cancel and its enqueue does throw. The catch is
    // what keeps that TypeError from killing the process, so assert the survival, not the
    // absence of the throw.
    it("survives a chunk that resolves after the stream is cancelled", async () => {
        const { uncaught } = await withUncaughtCapture(async () => {
            const source = new PassThrough();
            for (let i = 0; i < 4; i += 1) source.write(Buffer.alloc(64 * 1024, 0x61));
            const reader = incomingMessageBody(asResponse(source)).getReader();
            await reader.read();
            await tick();
            await Promise.race([reader.cancel(), new Promise((resolve) => setTimeout(resolve, 1000))]);
            source.write(Buffer.alloc(64 * 1024, 0x62));
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(uncaught).toEqual([]);
    });

    // The streaming cap exists to bail out at the boundary. A broker that stops sending the
    // moment the counter crosses it must not hold the cancel open.
    it("cancels promptly when the broker stops sending at the cap boundary", async () => {
        const source = new PassThrough();
        source.write(Buffer.alloc(4096, 0x61));
        const reader = incomingMessageBody(asResponse(source)).getReader();
        await reader.read();
        await tick();

        const verdict = await Promise.race([
            reader.cancel().then(() => "settled" as const),
            new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1000)),
        ]);

        expect(verdict).toBe("settled");
        expect(source.destroyed).toBe(true);
    });

    // Abort and reset classification both depend on the error reaching the caller.
    it("surfaces a mid-body error to the reader", async () => {
        const source = new PassThrough();
        source.write(Buffer.alloc(64, 0x61));
        const reader = incomingMessageBody(asResponse(source)).getReader();
        await reader.read();
        const failure = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        source.destroy(failure);

        await expect(reader.read()).rejects.toThrow("socket hang up");
    });
});
