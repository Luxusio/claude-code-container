import { describe, expect, it } from "vitest";
import { createHyperVDesktopTransferApplication } from "../../packages/device-lab/src/device-lab/application/hyper-v-desktop-transfer.js";
import type { HyperVDesktopTransferPorts } from "../../packages/device-lab/src/device-lab/ports/hyper-v-desktop-transfer.js";
import {
    currentHyperVConsoleFrame,
    forgetHyperVConsoleFrame,
    hyperVConsoleFrameKey,
    hyperVConsoleKeyTokens,
    hyperVConsolePixel,
    hyperVConsoleText,
    rememberHyperVConsoleFrame,
    withHyperVConsoleLock,
} from "@ccc/device-lab/device-lab/broker/hyper-v/console.js";

// Compile-only consumed production contract; native operations are not invoked.
export function requiredDesktopTransferCapabilities(ports: HyperVDesktopTransferPorts<unknown, unknown, Uint8Array>): void {
    const application = createHyperVDesktopTransferApplication(ports);
    const { direct, ...missingDirect } = ports;
    // @ts-expect-error bounded Windows Direct execution is required
    createHyperVDesktopTransferApplication(missingDirect);
    const { allocateStage, ...missingStage } = ports;
    // @ts-expect-error transfers require owned stage allocation
    createHyperVDesktopTransferApplication(missingStage);
    // @ts-expect-error allocated stage disposal must settle synchronously
    createHyperVDesktopTransferApplication({ ...ports, disposeStage: async () => undefined });
    // @ts-expect-error destination publication must finish before a success result
    createHyperVDesktopTransferApplication({ ...ports, writeDestination: async () => undefined });
    void application; void direct; void allocateStage;
}

describe("Hyper-V console input contract", () => {
    it("requires a screenshot from the current incarnation for pixel input", () => {
        const key = hyperVConsoleFrameKey("owner", "windows-vm", "vm");
        expect(currentHyperVConsoleFrame(key, "old")).toBeNull();
        rememberHyperVConsoleFrame(key, {
            incarnationId: "current", width: 640, height: 480,
            nativeWidth: 1024, nativeHeight: 768, capturedAt: new Date().toISOString(),
        });
        expect(currentHyperVConsoleFrame(key, "old")).toBeNull();
        expect(currentHyperVConsoleFrame(key, "current")?.nativeWidth).toBe(1024);
        forgetHyperVConsoleFrame(key);
        expect(currentHyperVConsoleFrame(key, "current")).toBeNull();
    });

    it("expires screenshot coordinates before they can target a changed display", () => {
        const key = hyperVConsoleFrameKey("owner", "linux-vm", "vm");
        rememberHyperVConsoleFrame(key, {
            incarnationId: "current", width: 640, height: 480,
            nativeWidth: 1024, nativeHeight: 768,
            capturedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
        });
        expect(currentHyperVConsoleFrame(key, "current")).toBeNull();
    });

    it("accepts only pixels within the returned image", () => {
        expect(hyperVConsolePixel(0, 640)).toBe(0);
        expect(hyperVConsolePixel(639, 640)).toBe(639);
        expect(hyperVConsolePixel(640, 640)).toBeNull();
        expect(hyperVConsolePixel(-1, 640)).toBeNull();
        expect(hyperVConsolePixel(1.5, 640)).toBeNull();
    });

    it("parses one key or modifiers and one final key", () => {
        expect(hyperVConsoleKeyTokens("Ctrl+A")).toEqual(["CTRL", "A"]);
        expect(hyperVConsoleKeyTokens("Alt+Tab")).toEqual(["ALT", "TAB"]);
        expect(hyperVConsoleKeyTokens("Escape")).toEqual(["ESC"]);
        expect(hyperVConsoleKeyTokens("Ctrl+Ctrl+A")).toBeNull();
        expect(hyperVConsoleKeyTokens("A+B")).toBeNull();
        expect(hyperVConsoleKeyTokens("Ctrl+Unknown")).toBeNull();
    });

    it("bounds typed text", () => {
        expect(hyperVConsoleText("한글 hello")).toBe("한글 hello");
        expect(hyperVConsoleText("")).toBeNull();
        expect(hyperVConsoleText("x".repeat(2049))).toBeNull();
        expect(hyperVConsoleText("a\0b")).toBeNull();
    });

    it("orders input for one VM even when an earlier operation fails", async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const first = withHyperVConsoleLock("vm", async () => {
            order.push("first-start");
            await gate;
            order.push("first-end");
            throw new Error("expected");
        });
        const second = withHyperVConsoleLock("vm", async () => { order.push("second"); });
        await Promise.resolve();
        expect(order).toEqual(["first-start"]);
        release();
        await expect(first).rejects.toThrow("expected");
        await second;
        expect(order).toEqual(["first-start", "first-end", "second"]);
    });
});
