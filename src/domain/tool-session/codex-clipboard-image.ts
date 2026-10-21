import { isCodexSubcommand, isCodexValueOption } from "../tool-registry.js";

export const CODEX_CLIPBOARD_IMAGE_PROMPT = "Please inspect the attached clipboard image.";

export interface ClipboardImageAttachmentResult {
    args: string[];
    relativeImagePath?: string;
}

function hasInlineValueOption(arg: string, option: string): boolean {
    return arg.startsWith(`${option}=`);
}

export const CODEX_CLIPBOARD_IMAGE_DIRECTORIES = [".omx", "clipboard-images"] as const;

export function codexClipboardImageFilename(timestamp: number): string {
    return `clipboard-${timestamp}.png`;
}

export function injectCodexClipboardImageArgs(args: string[], imagePath: string): string[] {
    if (args.length === 0) {
        return args;
    }

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-i" || arg === "--image" || hasInlineValueOption(arg, "--image")) {
            return [...args];
        }
    }

    let positionalIndex: number | null = null;
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") {
            positionalIndex = i + 1 < args.length ? i + 1 : null;
            break;
        }
        if (isCodexValueOption(arg)) {
            i += 1;
            continue;
        }
        if (arg.includes("=") && isCodexValueOption(arg.split("=", 1)[0])) {
            continue;
        }
        if (arg.startsWith("-")) {
            continue;
        }
        positionalIndex = i;
        break;
    }

    if (positionalIndex !== null && isCodexSubcommand(args[positionalIndex])) {
        return [...args];
    }

    if (positionalIndex === null) {
        return [...args, "--image", imagePath, CODEX_CLIPBOARD_IMAGE_PROMPT];
    }

    return [
        ...args.slice(0, positionalIndex),
        "--image",
        imagePath,
        ...args.slice(positionalIndex),
    ];
}

export type CodexClipboardImageReader<Image> = (clipboardUrl: string, clipboardToken: string) => Promise<Image | null>;

export interface CodexClipboardImageAttachmentOptions<Image> {
    enabled: boolean;
    clipboardUrl?: string;
    clipboardToken?: string;
    timestamp?: number;
    readImage?: CodexClipboardImageReader<Image>;
}
