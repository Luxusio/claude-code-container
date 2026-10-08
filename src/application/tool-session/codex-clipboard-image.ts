import {
    CODEX_CLIPBOARD_IMAGE_DIRECTORIES,
    codexClipboardImageFilename,
    injectCodexClipboardImageArgs,
    type ClipboardImageAttachmentResult,
    type CodexClipboardImageAttachmentOptions,
} from "../../domain/tool-session/codex-clipboard-image.js";
import type { CodexClipboardImageAttachmentPorts } from "../../ports/tool-session/codex-clipboard-image.js";

export function createCodexClipboardImageAttachment<Image>(ports: CodexClipboardImageAttachmentPorts<Image>) {
    function buildCodexClipboardImageRelativePath(timestamp: number): string {
        return ports.relativePath(CODEX_CLIPBOARD_IMAGE_DIRECTORIES[0], CODEX_CLIPBOARD_IMAGE_DIRECTORIES[1],
            () => codexClipboardImageFilename(timestamp));
    }

    async function maybeAttachCodexClipboardImage(
        projectPath: string,
        args: string[],
        options: CodexClipboardImageAttachmentOptions<Image>,
    ): Promise<ClipboardImageAttachmentResult> {
        if (!options.enabled || !options.clipboardUrl || !options.clipboardToken) {
            return { args: [...args] };
        }

        const relativeImagePath = buildCodexClipboardImageRelativePath(options.timestamp ?? ports.now());
        const imageArgs = injectCodexClipboardImageArgs(args, relativeImagePath);
        if (imageArgs.length === args.length && imageArgs.every((arg, index) => arg === args[index])) {
            return { args: [...args] };
        }
        const readImage = options.readImage ?? ports.defaultReader();
        const image = await readImage(options.clipboardUrl, options.clipboardToken);
        if (!image) {
            return { args: [...args] };
        }

        const hostImagePath = ports.imagePath(projectPath, relativeImagePath);
        ports.ensureDirectory(projectPath, CODEX_CLIPBOARD_IMAGE_DIRECTORIES[0], CODEX_CLIPBOARD_IMAGE_DIRECTORIES[1]);
        ports.writeImage(hostImagePath, image);

        return {
            args: imageArgs,
            relativeImagePath,
        };
    }

    return { buildCodexClipboardImageRelativePath, maybeAttachCodexClipboardImage };
}
