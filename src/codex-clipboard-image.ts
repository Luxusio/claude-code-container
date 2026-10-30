import { mkdirSync, writeFileSync } from "fs";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "http";
import { join, posix } from "path";
import { createCodexClipboardImageAttachment } from "./application/tool-session/codex-clipboard-image.js";
import type { ClipboardImageAttachmentResult } from "./domain/tool-session/codex-clipboard-image.js";

export { CODEX_CLIPBOARD_IMAGE_PROMPT, injectCodexClipboardImageArgs } from "./domain/tool-session/codex-clipboard-image.js";
export type { ClipboardImageAttachmentResult } from "./domain/tool-session/codex-clipboard-image.js";

export async function readClipboardImagePng(
    clipboardUrl: string,
    clipboardToken: string,
): Promise<Buffer | null> {
    return new Promise((resolve) => {
        let settled = false;
        let req: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = (image: Buffer | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            response?.destroy();
            req?.destroy();
            resolve(image);
        };
        req = httpRequest(
            `${clipboardUrl}/clipboard/image/png`,
            {
                headers: { Authorization: `Bearer ${clipboardToken}` },
            },
            (res) => {
                response = res;
                res.on("error", () => finish(null));
                res.on("aborted", () => finish(null));
                res.on("close", () => finish(null));
                if (settled) { res.destroy(); return; }
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                res.on("end", () => {
                    if (res.statusCode !== 200 || !res.complete) {
                        finish(null);
                        return;
                    }
                    const body = Buffer.concat(chunks);
                    finish(body.length > 0 ? body : null);
                });
            },
        );
        req.on("error", () => finish(null));
        req.on("close", () => { if (!response) finish(null); });
        // This optional prelaunch attachment must not hold up interactive
        // startup indefinitely, including when a response stalls after headers.
        deadline = setTimeout(() => finish(null), 5000);
        req.end();
    });
}

const attachment = createCodexClipboardImageAttachment<Buffer>({
    now: () => Date.now(),
    relativePath: (first, second, filename) => posix.join(first, second, filename()),
    imagePath: (projectPath, relativeImagePath) => join(projectPath, relativeImagePath),
    defaultReader: () => readClipboardImagePng,
    ensureDirectory: (projectPath, first, second) => mkdirSync(join(projectPath, first, second), { recursive: true }),
    writeImage: (hostImagePath, image) => writeFileSync(hostImagePath, image),
});

export const buildCodexClipboardImageRelativePath: (timestamp: number) => string = attachment.buildCodexClipboardImageRelativePath;
export const maybeAttachCodexClipboardImage: (
    projectPath: string,
    args: string[],
    options: {
        enabled: boolean;
        clipboardUrl?: string;
        clipboardToken?: string;
        timestamp?: number;
        readImage?: (clipboardUrl: string, clipboardToken: string) => Promise<Buffer | null>;
    },
) => Promise<ClipboardImageAttachmentResult> = attachment.maybeAttachCodexClipboardImage;
