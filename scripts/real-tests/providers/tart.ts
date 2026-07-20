import { spawnSync } from "child_process";

export function runTartCommand(command, args, timeoutMs = 10000, env = process.env) {
    return spawnSync(command, args, { encoding: "utf-8", env, timeout: timeoutMs, windowsHide: true });
}

export function parseTartListImages(text) {
    const payload = String(text || "").trim();
    if (!payload) return [];
    const normalize = (item) => {
        if (!item || typeof item !== "object") return null;
        const name = item.name || item.Name || item.vm || item.VM || item.image || item.Image;
        if (!name || typeof name !== "string") return null;
        const state = item.state || item.State || item.status || item.Status || "";
        const source = item.source || item.Source || "";
        return { name, state: String(state || ""), source: String(source || "") };
    };
    try {
        const parsed = JSON.parse(payload);
        const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.vms) ? parsed.vms : Array.isArray(parsed.images) ? parsed.images : [parsed];
        return items.map(normalize).filter(Boolean);
    } catch { /* fall through */ }
    const jsonLines = payload.split(/\r?\n/).map((line) => { try { return normalize(JSON.parse(line)); } catch { return null; } }).filter(Boolean);
    if (jsonLines.length) return jsonLines;
    const lines = payload.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const columns = (lines[0] || "").split(/\s+/).map((column) => column.toLowerCase());
    const nameIndex = columns.indexOf("name");
    const stateIndex = columns.findIndex((column) => column === "state" || column === "status");
    const sourceIndex = columns.indexOf("source");
    const hasHeader = nameIndex >= 0;
    return lines.slice(hasHeader ? 1 : 0).map((line) => {
        if (!hasHeader && /^(usage:|options:|commands:|flags:|\S+\s+--help\b)/i.test(line)) return null;
        const values = line.split(/\s+/);
        if (!hasHeader && values.length < 2) return null;
        const name = hasHeader ? values[nameIndex] : values[0];
        return name ? { name, state: hasHeader && stateIndex >= 0 ? values[stateIndex] || "" : values[1] || "", source: hasHeader && sourceIndex >= 0 ? values[sourceIndex] || "" : "" } : null;
    }).filter(Boolean);
}

export function selectAutoTartSourceImage(images) {
    const usable = images.filter((image) => image?.name
        && (!image.source || /^local$/i.test(image.source))
        && !/ccc-real|level\d+-e2e|e2e/i.test(image.name)
        && (!/^ccc[-_]/i.test(image.name) || /(?:base|template|image)$/i.test(image.name))
        && !/running|starting/i.test(image.state || ""));
    const preferred = usable.filter((image) => /(?:^|[-_])(?:macos|osx)(?:[-_].*)?(?:base|template|image)$|^ccc[-_].*(?:base|template|image)$/i.test(image.name));
    const candidates = preferred.length ? preferred : usable;
    if (candidates.length === 1) return { source: candidates[0].name, candidates: [candidates[0].name], auto: true };
    return { source: "", candidates: candidates.map((image) => image.name), auto: true, reason: candidates.length === 0
        ? "no usable local Tart images found"
        : `multiple local Tart images found: ${candidates.map((image) => image.name).join(", ")}` };
}

export function selectAutoTartSourceImageFromListResults(results) {
    let sawSuccessfulList = false;
    for (const result of results) {
        if (result?.status !== 0) continue;
        sawSuccessfulList = true;
        const images = parseTartListImages(result.stdout);
        if (!images.length) continue;
        return { ...selectAutoTartSourceImage(images), command: result.command };
    }
    return { source: "", candidates: [], auto: true, reason: sawSuccessfulList ? "no usable local Tart images found" : "unable to list local Tart images" };
}

export function discoverTartSourceImage(tart, options: any = {}) {
    const run = options.run || runTartCommand;
    const attempts = [["list", "--source=local", "--format=json"], ["list", "--source", "local", "--format", "json"], ["list", "--format", "json"], ["list", "--json"], ["list"]];
    return selectAutoTartSourceImageFromListResults(attempts.map((args) => {
        const result = run(tart, args, 10000);
        return { command: [tart, ...args].join(" "), status: result?.status ?? null, stdout: result?.stdout || "" };
    }));
}

export function inspectTartInstance(tart, instance, options: any = {}) {
    const run = options.run || runTartCommand;
    const attempts = [["list", "--format", "json"], ["list", "--json"], ["list"]];
    const diagnostics = [];
    for (const args of attempts) {
        const result = run(tart, args, 10000);
        diagnostics.push(`${args.join(" ")}:status=${result?.status ?? "unknown"}`);
        if (result?.status !== 0) continue;
        const images = parseTartListImages(result.stdout);
        if (!images.length) continue;
        return { found: images.some((image) => image.name === instance), image: images.find((image) => image.name === instance) || null, command: [tart, ...args].join(" ") };
    }
    throw new Error(`unable to inspect Tart instance ${instance} (${diagnostics.join(", ")})`);
}
