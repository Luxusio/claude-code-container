export const CODEX_CLIPBOARD_IMAGE_PROMPT = "Please inspect the attached clipboard image.";
const CODEX_CLIPBOARD_SUBCOMMANDS = new Set([
    "exec",
    "review",
    "login",
    "logout",
    "mcp",
    "mcp-server",
    "app-server",
    "completion",
    "sandbox",
    "debug",
    "doctor",
    "migrate-rollouts",
    "apply",
    "resume",
    "fork",
    "cloud",
    "features",
    "help",
]);

const OPTIONS_WITH_VALUES = new Set([
    "-c",
    "--config",
    "--enable",
    "--disable",
    "-i",
    "--image",
    "-m",
    "--model",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-a",
    "--ask-for-approval",
    "-C",
    "--cd",
    "--add-dir",
]);

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
        if (OPTIONS_WITH_VALUES.has(arg)) {
            i += 1;
            continue;
        }
        if (
            hasInlineValueOption(arg, "--config")
            || hasInlineValueOption(arg, "--image")
            || hasInlineValueOption(arg, "--model")
            || hasInlineValueOption(arg, "--profile")
            || hasInlineValueOption(arg, "--sandbox")
            || hasInlineValueOption(arg, "--ask-for-approval")
            || hasInlineValueOption(arg, "--cd")
            || hasInlineValueOption(arg, "--add-dir")
        ) {
            continue;
        }
        if (arg.startsWith("-")) {
            continue;
        }
        positionalIndex = i;
        break;
    }

    if (positionalIndex !== null && CODEX_CLIPBOARD_SUBCOMMANDS.has(args[positionalIndex])) {
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
