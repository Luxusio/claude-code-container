import type { CodexClipboardImageReader } from "../../domain/tool-session/codex-clipboard-image.js";

export interface CodexClipboardImageAttachmentPorts<Image> {
    now(): number;
    relativePath(first: string, second: string, filename: () => string): string;
    imagePath(projectPath: string, relativeImagePath: string): string;
    defaultReader(): CodexClipboardImageReader<Image>;
    ensureDirectory(projectPath: string, first: string, second: string): void;
    writeImage(hostImagePath: string, image: Image): void;
}
