import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CODEX_CLIPBOARD_IMAGE_PROMPT,
    buildCodexClipboardImageRelativePath,
    injectCodexClipboardImageArgs,
    maybeAttachCodexClipboardImage,
    readClipboardImagePng,
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

    it.each([
        ["codex", "migrate-rollouts", "--apply", "--thread", "session-id", "--json"],
        ["codex", "doctor", "--summary"],
        ["codex", "-c", 'model="example"', "doctor", "--json"],
    ])("does not attach clipboard images to recovery commands: %j", (...args) => {
        expect(injectCodexClipboardImageArgs(args, "new.png")).toEqual(args);
    });
});

describe("maybeAttachCodexClipboardImage", () => {
    it("regression: plugin after a model value avoids all clipboard effects", async () => {
        const projectPath = mkdtempSync(join(tmpdir(), "ccc-codex-clipboard-"));
        tempDirs.push(projectPath);
        const args = ["codex", "--model", "selected-model", "plugin", "list"];
        const original = [...args];
        const entries = readdirSync(projectPath);
        const readImage = vi.fn(async () => Buffer.from("unused clipboard image"));
        const result = await maybeAttachCodexClipboardImage(projectPath, args, {
            enabled: true, clipboardUrl: "http://127.0.0.1:4321", clipboardToken: "token",
            timestamp: 123, readImage,
        });
        expect(readImage).not.toHaveBeenCalled();
        expect(result).toEqual({ args: original });
        expect(args).toEqual(original);
        expect(readdirSync(projectPath)).toEqual(entries);
        expect(existsSync(join(projectPath, ".omx"))).toBe(false);
    });

    it.each(["e", "a", "remote-control", "update", "exec-server"])("regression: %s after a model value avoids all clipboard effects", async subcommand => {
        const projectPath = mkdtempSync(join(tmpdir(), "ccc-codex-clipboard-"));
        tempDirs.push(projectPath);
        const args = ["codex", "--model", "plugin", subcommand, "request"];
        const original = [...args], entries = readdirSync(projectPath);
        const readImage = vi.fn(async () => Buffer.from("unused clipboard image"));
        const result = await maybeAttachCodexClipboardImage(projectPath, args, {
            enabled: true, clipboardUrl: "http://127.0.0.1:4321", clipboardToken: "token",
            timestamp: 123, readImage,
        });
        expect(readImage).not.toHaveBeenCalled();
        expect(result).toEqual({ args: original });
        expect(result.args).not.toBe(args);
        expect(args).toEqual(original);
        expect(readdirSync(projectPath)).toEqual(entries);
        expect(existsSync(join(projectPath, ".omx"))).toBe(false);
    });

    it.each(["inspect this image", undefined])("regression: local-provider keeps its value adjacent when attaching with prompt %s", async prompt => {
        const projectPath = mkdtempSync(join(tmpdir(), "ccc-codex-clipboard-"));
        tempDirs.push(projectPath);
        const args = ["codex", "--model", "plugin", "--local-provider", "ollama", ...(prompt ? [prompt] : [])];
        const original = [...args], image = Buffer.from("private synthetic png");
        const readImage = vi.fn(async () => image);
        const result = await maybeAttachCodexClipboardImage(projectPath, args, {
            enabled: true, clipboardUrl: "http://127.0.0.1:4321", clipboardToken: "token",
            timestamp: 123, readImage,
        });
        const relativeImagePath = ".omx/clipboard-images/clipboard-123.png";
        expect(result).toEqual({ args: ["codex", "--model", "plugin", "--local-provider", "ollama", "--image", relativeImagePath,
            prompt ?? CODEX_CLIPBOARD_IMAGE_PROMPT], relativeImagePath });
        expect(readImage).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:4321", "token");
        expect(readFileSync(join(projectPath, relativeImagePath))).toEqual(image);
        expect(args).toEqual(original);
        expect(result.args).not.toBe(args);
    });

    it.each([["-i", "existing.png"], ["--image", "existing.png"], ["--image=existing.png"]])("keeps explicit image exclusion with a local-provider value: %j", async (...imageArgs) => {
        const projectPath = mkdtempSync(join(tmpdir(), "ccc-codex-clipboard-"));
        tempDirs.push(projectPath);
        const args = ["codex", "--local-provider", "ollama", ...imageArgs, "inspect this image"];
        const original = [...args], readImage = vi.fn(async () => Buffer.from("unused clipboard image"));
        const result = await maybeAttachCodexClipboardImage(projectPath, args, {
            enabled: true, clipboardUrl: "http://127.0.0.1:4321", clipboardToken: "token", readImage,
        });
        expect(result).toEqual({ args: original });
        expect(readImage).not.toHaveBeenCalled();
        expect(args).toEqual(original);
        expect(readdirSync(projectPath)).toEqual([]);
    });

    it.each([
        ["codex", "migrate-rollouts", "--apply", "--thread", "session-id", "--json"],
        ["codex", "doctor", "--summary"],
        ["codex", "resume", "session-id"],
        ["codex", "--image", "existing.png", "prompt"],
    ])("does not read or save unused clipboard contents: %j", async (...args) => {
        const projectPath = mkdtempSync(join(tmpdir(), "ccc-codex-clipboard-"));
        tempDirs.push(projectPath);
        let reads = 0;
        const result = await maybeAttachCodexClipboardImage(projectPath, args, {
            enabled: true,
            clipboardUrl: "http://127.0.0.1:4321",
            clipboardToken: "token",
            readImage: async () => { reads += 1; throw new Error("unused clipboard must not be read"); },
        });
        expect(result).toEqual({ args });
        expect(reads).toBe(0);
        expect(existsSync(join(projectPath, ".omx"))).toBe(false);
    });

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


describe("readClipboardImagePng", () => {
    it.each([
        { name: "returns exact nonempty 200 bytes", status: 200, body: Buffer.from([137, 80, 78, 71, 0, 255]), disconnect: false },
        { name: "returns null for empty 200", status: 200, body: Buffer.alloc(0), disconnect: false },
        { name: "returns null for non-200 with a body", status: 503, body: Buffer.from("unavailable"), disconnect: false },
        { name: "returns null when the owned connection closes before headers", status: 200, body: Buffer.alloc(0), disconnect: true },
    ])("$name", async ({ status, body, disconnect }) => {
        const requests: { path: string | undefined; authorization: string | undefined }[] = [];
        const sockets = new Set<Socket>();
        const closedSockets: Promise<void>[] = [];
        const server = createServer((request, response) => {
            requests.push({ path: request.url, authorization: request.headers.authorization });
            if (disconnect) request.socket.destroy();
            else { response.writeHead(status); response.end(body); }
        });
        server.on("connection", socket => {
            sockets.add(socket);
            closedSockets.push(new Promise(resolve => socket.once("close", () => {
                sockets.delete(socket);
                resolve();
            })));
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Expected an owned TCP listener");
            const result = await readClipboardImagePng(`http://127.0.0.1:${address.port}`, "fixture-token");
            expect(result).toEqual(status === 200 && body.length > 0 && !disconnect ? body : null);
            expect(requests).toEqual([{ path: "/clipboard/image/png", authorization: "Bearer fixture-token" }]);
        } finally {
            for (const socket of sockets) socket.destroy();
            if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            await Promise.all(closedSockets);
        }
    });
});
