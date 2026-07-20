import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { basename, resolve } from "path";
import { fileURLToPath } from "url";
import { TOOLS as DEVICE_LAB_MCP_TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { androidBackend } from "../../device-lab-mcp/src/backends/android.mjs";
import { windowsBackend } from "../../device-lab-mcp/src/backends/windows-sandbox.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const assertJsonPath = resolve(scriptPath, "../assert-json.ts");
const requiredToolSources = ["source", "dist"];
const requiredProviderSources = ["dist"];

export const PROVIDER_RESULT_SPECS = [
    { id: "android-emulator", files: ["level2-android-emulator-e2e.ts", "level3-real-destructive.ts"], tools: androidBackend().capabilities },
    { id: "android-device", files: ["level2-android-device-e2e.ts"], tools: ["device_attach", "device_status", "mobile_tap", "mobile_screenshot", "device_detach"] },
    { id: "ios-simulator", files: ["level2-ios-e2e.ts"], tools: ["device_create", "device_start", "mobile_tap", "mobile_screenshot", "device_delete"] },
    { id: "ios-device", files: ["level2-ios-e2e.ts"], tools: ["device_attach", "device_status", "mobile_tap", "mobile_screenshot", "device_detach"] },
    { id: "windows-sandbox", files: ["level2-windows-sandbox.ts"], tools: windowsBackend().capabilities },
    { id: "macos-vm", files: ["level3-real-destructive.ts"], tools: ["device_base_image_create", "device_base_image_clone", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete"] },
    { id: "android-wireless", backend: "android-device", filesBySource: { source: ["level1-real-provider-readiness.ts"], dist: ["level1-dist-real-provider-readiness.ts"] }, tools: ["device_wireless"] },
    { id: "ios-wireless", backend: "ios-device", filesBySource: { source: ["level1-real-provider-readiness.ts"], dist: ["level1-dist-real-provider-readiness.ts"] }, tools: ["device_wireless"] },
];

function canonicalToolSurface() {
    return DEVICE_LAB_MCP_TOOLS.map((tool) => tool.name);
}

function callFile(call) {
    return basename(String(call?.file || "").replace(/\\/g, "/"));
}

function filesForSource(spec, source) {
    return spec.filesBySource?.[source] || spec.files || [];
}

function matchingProviderCalls(shards, spec, source) {
    const files = new Set(filesForSource(spec, source));
    const backend = spec.backend || spec.id;
    return shards.flatMap((shard) => {
        const sessions = new Map((shard.mcpSessions || []).map((session) => [session?.id, session?.serverSource]));
        return (shard.toolCoverage?.calls || []).filter((call) => (
            sessions.get(call?.mcpSessionId) === source
            && call?.outcome === "ok"
            && files.has(callFile(call))
            && Array.isArray(call?.facets)
            && call.facets.includes(`${call.tool}:backend=${backend}`)
        ));
    });
}

export function assertResultMatrix(shards, options: any = {}) {
    const advertisedTools = options.advertisedTools || canonicalToolSurface();
    const providerSpecs = options.providerSpecs || PROVIDER_RESULT_SPECS;
    const failures = [];
    const shardSummaries = shards.map((shard, index) => {
        const platform = shard?.host?.platform || "";
        if (!platform) failures.push(`shardHostMissing=${index}`);
        if (Number(shard?.fail || 0) > 0) failures.push(`shardFail=${index}:${shard.fail}`);
        if (Number(shard?.strictCoverageFailures || 0) > 0) failures.push(`shardCoverageFailure=${index}:${shard.strictCoverageFailures}`);
        if (Number(shard?.strictOutcomeFailures || 0) > 0) failures.push(`shardOutcomeFailure=${index}:${shard.strictOutcomeFailures}`);
        const shardSurface = Array.isArray(shard?.toolCoverage?.advertisedTools) ? shard.toolCoverage.advertisedTools.map(String).sort() : [];
        if (JSON.stringify(shardSurface) !== JSON.stringify([...advertisedTools].sort())) failures.push(`shardToolSurfaceMismatch=${index}`);
        return {
            index,
            platform: platform || null,
            arch: shard?.host?.arch || null,
            node: shard?.host?.node || null,
            pass: Number(shard?.pass || 0),
            skip: Number(shard?.skip || 0),
            fail: Number(shard?.fail || 0),
        };
    });

    const publicDirectOkBySource = {};
    const missingPublicDirectOkBySource = {};
    for (const source of requiredToolSources) {
        const directOk = new Set(shards.flatMap((shard) => {
            const sessions = new Map((shard.mcpSessions || []).map((session) => [session?.id, session?.serverSource]));
            return (shard.toolCoverage?.calls || [])
                .filter((call) => sessions.get(call?.mcpSessionId) === source && call?.outcome === "ok")
                .map((call) => String(call?.tool || ""));
        }).filter((tool) => advertisedTools.includes(tool)));
        publicDirectOkBySource[source] = [...directOk].sort();
        missingPublicDirectOkBySource[source] = advertisedTools.filter((tool) => !directOk.has(tool)).sort();
        if (missingPublicDirectOkBySource[source].length > 0) failures.push(`missingPublicDirectOk:${source}=${missingPublicDirectOkBySource[source].length}`);
    }

    const providerEvidence = {};
    for (const spec of providerSpecs) {
        providerEvidence[spec.id] = {};
        for (const source of requiredProviderSources) {
            const calls = matchingProviderCalls(shards, spec, source);
            const calledTools = new Set(calls.map((call) => call.tool));
            const missingTools = spec.tools.filter((tool) => !calledTools.has(tool));
            providerEvidence[spec.id][source] = {
                files: filesForSource(spec, source),
                calledTools: [...calledTools].sort(),
                missingTools,
            };
            if (missingTools.length > 0) failures.push(`missingProviderEvidence:${spec.id}:${source}=${missingTools.length}`);
        }
    }

    const linuxVmRecords = shards.flatMap((shard) => shard.records || []).filter((record) => (
        basename(String(record?.file || "").replace(/\\/g, "/")) === "level2-real-linux-vm.ts"
        && record?.status === "PASS"
    ));
    if (options.requireLinuxVm !== false && linuxVmRecords.length === 0) failures.push("missingLinuxVmBootEvidence");

    return {
        ok: failures.length === 0,
        failures,
        shards: shardSummaries,
        publicDirectOkBySource,
        missingPublicDirectOkBySource,
        providerEvidence,
        linuxVmBootEvidence: linuxVmRecords.map((record) => ({ test: record.test, step: record.step || null })),
    };
}

function validateShardFile(file) {
    const result = spawnSync(process.execPath, [assertJsonPath, file, "--platform-result"], { encoding: "utf-8", env: process.env, windowsHide: true });
    let output = null;
    try { output = JSON.parse(result.stdout || "null"); } catch { /* surfaced below */ }
    return { ok: result.status === 0, status: result.status, output, stderr: result.stderr || "" };
}

if (resolve(process.argv[1] || "") === resolve(scriptPath)) {
    const files = process.argv.slice(2);
    if (files.length === 0) {
        console.error("Usage: node scripts/real-tests/assert-matrix.ts <level3-result.json> [...level3-result.json]");
        process.exit(1);
    }
    const shards = [];
    const shardValidationFailures = [];
    for (const file of files) {
        let shard;
        try {
            shard = JSON.parse(readFileSync(file, "utf-8"));
        } catch (error) {
            shardValidationFailures.push({ file, status: null, failures: ["invalid-json"], stderr: error?.message || String(error) });
            continue;
        }
        const validation = validateShardFile(file);
        if (!validation.ok) shardValidationFailures.push({ file, status: validation.status, failures: validation.output?.failures || [], stderr: validation.stderr.trim() });
        shards.push(shard);
    }
    const output: ReturnType<typeof assertResultMatrix> & { shardValidationFailures?: any[] } = assertResultMatrix(shards);
    output.shardValidationFailures = shardValidationFailures;
    if (shardValidationFailures.length > 0) {
        output.ok = false;
        output.failures.unshift(`invalidShards=${shardValidationFailures.length}`);
    }
    console.log(JSON.stringify(output, null, 2));
    process.exit(output.ok ? 0 : 1);
}
