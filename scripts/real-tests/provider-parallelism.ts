import { basename } from "path";

const PROVIDER_RESOURCES = new Map<string, string[]>([
    ["level2-ios-e2e.ts", ["ios"]],
    ["level2-android-emulator-e2e.ts", ["android-emulator"]],
    ["level2-android-device-e2e.ts", ["android-device"]],
    ["level2-macos-vm-e2e.ts", ["macos-vm"]],
    ["level2-windows-sandbox.ts", ["windows-sandbox"]],
    ["level2-hyper-v-windows-vm.ts", ["hyper-v"]],
    ["level2-hyper-v-linux-vm.ts", ["hyper-v"]],
    ["level2-real-linux-vm.ts", ["linux-vm"]],
    ["level3-real-destructive.ts", ["android-emulator", "macos-vm"]],
]);

export function normalizeProviderConcurrency(value: unknown, fallback = 1) {
    const text = value === undefined || value === null || value === "" ? String(fallback) : String(value);
    const concurrency = Number(text);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
        throw new Error(`provider concurrency must be an integer from 1 to 8, received ${JSON.stringify(value)}`);
    }
    return concurrency;
}

export function providerResources(file: string) {
    return PROVIDER_RESOURCES.get(basename(file)) || null;
}

export function partitionProviderFiles(files: string[]) {
    const serial: string[] = [];
    const providers: Array<{ file: string; resources: string[] }> = [];
    for (const file of files) {
        const resources = providerResources(file);
        if (resources) providers.push({ file, resources });
        else serial.push(file);
    }
    return { serial, providers };
}

export async function runResourceAware<T>(
    items: Array<{ file: string; resources: string[] }>,
    concurrency: number,
    run: (file: string) => Promise<T>,
) {
    const limit = normalizeProviderConcurrency(concurrency);
    const pending = items.map((item, index) => ({ ...item, index }));
    const results = new Array<T>(items.length);
    const activeResources = new Set<string>();
    const active = new Set<Promise<void>>();
    let firstError: unknown = null;

    const startAvailable = () => {
        let started = false;
        for (let index = 0; index < pending.length && active.size < limit;) {
            const item = pending[index];
            if (item.resources.some((resource) => activeResources.has(resource))) {
                index += 1;
                continue;
            }
            pending.splice(index, 1);
            item.resources.forEach((resource) => activeResources.add(resource));
            let task: Promise<void>;
            task = run(item.file)
                .then((result) => {
                    results[item.index] = result;
                })
                .catch((error) => {
                    firstError ??= error;
                })
                .finally(() => {
                    item.resources.forEach((resource) => activeResources.delete(resource));
                    active.delete(task);
                });
            active.add(task);
            started = true;
        }
        return started;
    };

    while (pending.length > 0 || active.size > 0) {
        const started = startAvailable();
        if (active.size === 0) {
            if (!started && pending.length > 0) throw new Error("provider scheduler deadlock");
            continue;
        }
        if (active.size >= limit || !started || pending.length === 0) {
            await Promise.race(active);
        }
    }
    if (firstError) throw firstError;
    return results;
}
