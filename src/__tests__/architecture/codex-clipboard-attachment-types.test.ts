import { describe, expect, it } from "vitest";
import { createCodexClipboardImageAttachment } from "../../application/tool-session/codex-clipboard-image.js";
import type { CodexClipboardImageAttachmentPorts } from "../../ports/tool-session/codex-clipboard-image.js";
import { buildCodexClipboardImageRelativePath, injectCodexClipboardImageArgs,
    maybeAttachCodexClipboardImage, readClipboardImagePng, type ClipboardImageAttachmentResult } from "../../codex-clipboard-image.js";

function contracts(ports: CodexClipboardImageAttachmentPorts<{ image: true }>, mutable: string[], readonlyArgs: readonly string[]) {
    const app = createCodexClipboardImageAttachment(ports);
    const pending: Promise<ClipboardImageAttachmentResult> = app.maybeAttachCodexClipboardImage("project", mutable, { enabled: false });
    const facade: Promise<ClipboardImageAttachmentResult> = maybeAttachCodexClipboardImage("project", mutable, {
        enabled: true, clipboardUrl: "url", clipboardToken: "token", timestamp: 1, readImage: async () => Buffer.alloc(0),
    });
    const native: Promise<Buffer | null> = readClipboardImagePng("url", "token");
    const relative: string = buildCodexClipboardImageRelativePath(1);
    const injected: string[] = injectCodexClipboardImageArgs(mutable, relative);
    injected.push("mutable");
    // @ts-expect-error Explicit required ports cannot be omitted.
    createCodexClipboardImageAttachment();
    // @ts-expect-error Native reader selection is required.
    createCodexClipboardImageAttachment({ now: ports.now, relativePath: ports.relativePath,
        imagePath: ports.imagePath, ensureDirectory: ports.ensureDirectory, writeImage: ports.writeImage });
    // @ts-expect-error Filesystem publication must be callable.
    createCodexClipboardImageAttachment({ ...ports, writeImage: false });
    // @ts-expect-error Relative path joining is synchronous.
    createCodexClipboardImageAttachment({ ...ports, relativePath: async () => "path" });
    // @ts-expect-error The opaque image type is preserved.
    app.maybeAttachCodexClipboardImage("project", mutable, { enabled: true, readImage: async () => "bytes" });
    // @ts-expect-error Public arguments retain the mutable array contract.
    maybeAttachCodexClipboardImage("project", readonlyArgs, { enabled: false });
    // @ts-expect-error Public injection retains the mutable array contract.
    injectCodexClipboardImageArgs(readonlyArgs, relative);
    // @ts-expect-error Attachment retains its async result.
    const sync: ClipboardImageAttachmentResult = maybeAttachCodexClipboardImage("project", mutable, { enabled: false });
    // @ts-expect-error Native reader remains Buffer-specific.
    maybeAttachCodexClipboardImage("project", mutable, { enabled: true, readImage: async () => new Uint8Array() });
    // @ts-expect-error Timestamp remains required and numeric.
    buildCodexClipboardImageRelativePath("1");
    void [pending, facade, native, injected, sync];
}
void contracts;

describe("clipboard attachment public compile contracts", () => {
    it("keeps public function names, arities and async constructor", () => {
        expect([buildCodexClipboardImageRelativePath.name, buildCodexClipboardImageRelativePath.length]).toEqual(["buildCodexClipboardImageRelativePath", 1]);
        expect([maybeAttachCodexClipboardImage.name, maybeAttachCodexClipboardImage.length, maybeAttachCodexClipboardImage.constructor.name])
            .toEqual(["maybeAttachCodexClipboardImage", 3, "AsyncFunction"]);
    });
});
