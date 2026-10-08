import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexClipboardImageAttachment } from "../../application/tool-session/codex-clipboard-image.js";
import { injectCodexClipboardImageArgs } from "../../domain/tool-session/codex-clipboard-image.js";
import type { CodexClipboardImageAttachmentPorts } from "../../ports/tool-session/codex-clipboard-image.js";
import { coreBoundaryViolations } from "./core-boundary.js";

const directories = [".omx", "clipboard-images"];
const relativeImage = ".omx/clipboard-images/clipboard-42.png";
function fixture(image: object | null = {}) {
    const events: unknown[] = [];
    const ports: CodexClipboardImageAttachmentPorts<object> = {
        now() { events.push("clock"); return 42; },
        relativePath(first, second, filename) { const name = filename(); events.push(["relative", first, second, name]); return `${first}/${second}/${name}`; },
        imagePath(projectPath, relative) { events.push(["host", projectPath, relative]); return `${projectPath}/${relative}`; },
        defaultReader() { events.push("reader"); return async (url, token) => { events.push(["read", url, token]); return image; }; },
        ensureDirectory(projectPath, first, second) { events.push(["mkdir", projectPath, first, second]); },
        writeImage(path, bytes) { events.push(["write", path, bytes]); },
    };
    return { ports, events, app: createCodexClipboardImageAttachment(ports), image };
}
const enabled = { enabled: true, clipboardUrl: "synthetic-url", clipboardToken: "synthetic-token" };

describe("complete clipboard attachment application", () => {
    it("does not observe ports during construction or disabled admission", async () => {
        const f = fixture();
        const observed = new Proxy(f.ports, { get() { throw new Error("unused capability lookup"); } });
        const app = createCodexClipboardImageAttachment(observed);
        const args = ["codex"];
        const result = await app.maybeAttachCodexClipboardImage("synthetic-project", args, { enabled: false });
        expect(result.args).toEqual(args);
        expect(result.args).not.toBe(args);
        expect(f.events).toEqual([]);
    });
    it.each([["codex", "--image", "existing"], ["codex", "doctor"], []])("does not read or materialize excluded argv %j", async (...args) => {
        const f = fixture();
        const result = await f.app.maybeAttachCodexClipboardImage("project", args, enabled);
        expect(result.args).toEqual(args);
        expect(result.args).not.toBe(args);
        expect(f.events).toEqual(["clock", ["relative", ...directories, "clipboard-42.png"]]);
    });
    it("carries opaque image identity through path planning, mkdir and publication", async () => {
        const image = Object.freeze({ synthetic: "image" });
        const f = fixture(image);
        const result = await f.app.maybeAttachCodexClipboardImage("project", ["codex", "inspect this"], enabled);
        expect(result).toEqual({ args: ["codex", "--image", relativeImage, "inspect this"], relativeImagePath: relativeImage });
        expect(f.events).toEqual(["clock", ["relative", ...directories, "clipboard-42.png"], "reader",
            ["read", enabled.clipboardUrl, enabled.clipboardToken], ["host", "project", relativeImage],
            ["mkdir", "project", ...directories], ["write", `project/${relativeImage}`, image]]);
        expect((f.events.at(-1) as unknown[])[2]).toBe(image);
    });
    it.each([null, {}])("preserves mutation during pending custom read (image=%j)", async image => {
        const f = fixture();
        const args = ["codex", "old prompt"];
        let finish!: (image: object | null) => void;
        const pending = f.app.maybeAttachCodexClipboardImage("project", args, { ...enabled, timestamp: 42,
            readImage(url, token) {
                expect(this).toBeUndefined();
                expect([url, token]).toEqual([enabled.clipboardUrl, enabled.clipboardToken]);
                return new Promise(resolve => { finish = resolve; });
            },
        });
        args[1] = "new prompt";
        finish(image);
        const result = await pending;
        expect(result.args).toEqual(image ? ["codex", "--image", relativeImage, "old prompt"] : args);
        expect(result.args).not.toBe(args);
        expect(f.events).not.toContain("clock");
        expect(f.events).not.toContain("reader");
    });
    it.each(["relativePath", "defaultReader", "imagePath", "ensureDirectory", "writeImage"] as const)("propagates raw failure at %s without later stages", async stage => {
        const f = fixture();
        const failure = { stage };
        Object.assign(f.ports, { [stage]: () => { f.events.push(`fail:${stage}`); throw failure; } });
        await expect(f.app.maybeAttachCodexClipboardImage("project", ["codex"], enabled)).rejects.toBe(failure);
        expect(f.events.at(-1)).toBe(`fail:${stage}`);
    });
    it("keeps pure empty-argv identity and mutable fresh injected arguments", () => {
        const empty: string[] = [];
        expect(injectCodexClipboardImageArgs(empty, "image")).toBe(empty);
        const args = ["codex"];
        const injected = injectCodexClipboardImageArgs(args, "image");
        injected.push("more");
        expect(args).toEqual(["codex"]);
    });
});

describe("actual clipboard inward dependency boundary", () => {
    const root = resolve("src");
    const boundary = { root, language: "ts" as const };
    for (const layer of ["domain", "ports", "application"] as const) {
        const file = resolve(root, layer, "tool-session/codex-clipboard-image.ts");
        it(`checks actual ${layer} source and intentional forbidden edges`, () => {
            const source = readFileSync(file, "utf8");
            expect(coreBoundaryViolations(source, file, boundary)).toEqual([]);
            for (const mutation of ["import { readFileSync } from 'node:fs';", "Date.now();", "Buffer.alloc(1);",
                "process.cwd();", "import('../../codex-clipboard-image.js');",
                "import { readClipboardImagePng } from '../../codex-clipboard-image.js';"]) {
                expect(coreBoundaryViolations(`${source}\n${mutation}`, file, boundary), mutation).not.toEqual([]);
            }
        });
    }
});
