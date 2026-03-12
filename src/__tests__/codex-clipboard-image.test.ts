import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    CODEX_CLIPBOARD_IMAGE_PROMPT,
    buildCodexClipboardImageRelativePath,
    injectCodexClipboardImageArgs,
    maybeAttachCodexClipboardImage,
} from "../codex-clipboard-image.js";

const tempDirs: string[] = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
});

describe("buildCodexClipboardImageRelativePath", () => {
    it("builds a stable project-relative png path", () => {
        expect(buildCodexClipboardImageRelativePath(123)).toBe(join(".omx", "clipboard-images", "clipboard-123.png"));
    });
});

describe("injectCodexClipboardImageArgs", () => {
    it("appends image flag and default prompt when no prompt exists", () => {
        const args = ["codex", "--ask-for-approval", "never"];
        expect(injectCodexClipboardImageArgs(args, ".omx/clipboard-images/clip.png")).toEqual([
            "codex",
            "--ask-for-approval",
            "never",
            "--image",
            ".omx/clipboard-images/clip.png",
            CODEX_CLIPBOARD_IMAGE_PROMPT,
        ]);
    });

    it("inserts image flag before an existing prompt", () => {
        const args = ["codex", "--model", "gpt-5", "describe this image"];
        expect(injectCodexClipboardImageArgs(args, ".omx/clipboard-images/clip.png")).toEqual([
            "codex",
            "--model",
            "gpt-5",
            "--image",
            ".omx/clipboard-images/clip.png",
            "describe this image",
        ]);
    });

    it("does not inject when codex already has an image", () => {
        const args = ["codex", "--image", "existing.png", "prompt"];
        expect(injectCodexClipboardImageArgs(args, "new.png")).toEqual(args);
    });

    it("does not inject for codex subcommands", () => {
        const args = ["codex", "exec", "prompt"];
        expect(injectCodexClipboardImageArgs(args, "new.png")).toEqual(args);
    });
});

describe("maybeAttachCodexClipboardImage", () => {
    it("writes the clipboard image into the project and injects codex args", async () => {
        const projectPath = mkdtempSync(join(tmpdir(), "ccc-codex-clipboard-"));
        tempDirs.push(projectPath);

        const result = await maybeAttachCodexClipboardImage(projectPath, ["codex"], {
            enabled: true,
            clipboardUrl: "http://127.0.0.1:4321",
            clipboardToken: "token",
            timestamp: 123,
            readImage: async () => Buffer.from("png-bytes"),
        });

        expect(result.relativeImagePath).toBe(join(".omx", "clipboard-images", "clipboard-123.png"));
        expect(result.args).toEqual([
            "codex",
            "--image",
            join(".omx", "clipboard-images", "clipboard-123.png"),
            CODEX_CLIPBOARD_IMAGE_PROMPT,
        ]);

        const writtenPath = join(projectPath, ".omx", "clipboard-images", "clipboard-123.png");
        expect(existsSync(writtenPath)).toBe(true);
        expect(readFileSync(writtenPath, "utf-8")).toBe("png-bytes");
    });

    it("leaves args unchanged when clipboard image is unavailable", async () => {
        const projectPath = mkdtempSync(join(tmpdir(), "ccc-codex-clipboard-"));
        tempDirs.push(projectPath);

        const result = await maybeAttachCodexClipboardImage(projectPath, ["codex", "prompt"], {
            enabled: true,
            clipboardUrl: "http://127.0.0.1:4321",
            clipboardToken: "token",
            readImage: async () => null,
        });

        expect(result).toEqual({ args: ["codex", "prompt"] });
    });

    it("leaves args unchanged when feature is disabled", async () => {
        const projectPath = mkdtempSync(join(tmpdir(), "ccc-codex-clipboard-"));
        tempDirs.push(projectPath);

        const result = await maybeAttachCodexClipboardImage(projectPath, ["codex", "prompt"], {
            enabled: false,
            clipboardUrl: "http://127.0.0.1:4321",
            clipboardToken: "token",
            readImage: async () => Buffer.from("png-bytes"),
        });

        expect(result).toEqual({ args: ["codex", "prompt"] });
    });
});
