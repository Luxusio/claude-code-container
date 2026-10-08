import { mkdirSync, writeFileSync } from "fs";
import { request as httpRequest } from "http";
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
        const req = httpRequest(
            `${clipboardUrl}/clipboard/image/png`,
            {
                headers: { Authorization: `Bearer ${clipboardToken}` },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                res.on("end", () => {
                    if (res.statusCode !== 200) {
                        resolve(null);
                        return;
                    }
                    const body = Buffer.concat(chunks);
                    resolve(body.length > 0 ? body : null);
                });
            },
        );
        req.on("error", () => resolve(null));
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
