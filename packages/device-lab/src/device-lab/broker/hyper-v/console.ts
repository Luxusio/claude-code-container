export type HyperVConsoleFrame = {
    readonly incarnationId: string;
    readonly width: number;
    readonly height: number;
    readonly nativeWidth: number;
    readonly nativeHeight: number;
    readonly capturedAt: string;
};

const frames = new Map<string, HyperVConsoleFrame>();
const operations = new Map<string, Promise<void>>();
const FRAME_MAX_AGE_MS = 2 * 60 * 1000;
export function hyperVConsoleFrameKey(ownerId: string, backend: string, deviceId: string): string {
    return `${ownerId}:${backend}:${deviceId}`;
}

export function rememberHyperVConsoleFrame(key: string, frame: HyperVConsoleFrame): void {
    frames.set(key, frame);
}

export function currentHyperVConsoleFrame(key: string, incarnationId: string): HyperVConsoleFrame | null {
    const frame = frames.get(key);
    if (!frame || frame.incarnationId !== incarnationId) return null;
    const capturedAt = Date.parse(frame.capturedAt);
    if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > FRAME_MAX_AGE_MS || capturedAt > Date.now()) {
        frames.delete(key);
        return null;
    }
    return frame;
}

export function forgetHyperVConsoleFrame(key: string): void {
    frames.delete(key);
}

export async function withHyperVConsoleLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = operations.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    operations.set(key, current);
    await previous;
    try {
        return await operation();
    } finally {
        if (operations.get(key) === current) operations.delete(key);
        release();
    }
}


export { hyperVConsolePixel, hyperVConsoleKeyTokens, hyperVConsoleText } from "../../domain/hyper-v-desktop-transfer.js";
