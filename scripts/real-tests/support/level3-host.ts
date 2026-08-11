import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

export const HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES = [
    "hyper-v-vm-managed-auto-images-v20",
    "hyper-v-setup-network-v10",
    "hyper-v-guest-readiness-diagnostics-v6",
    "hyper-v-windows-boot-contract-v1",
    "hyper-v-linux-create-response-v1",
    "hyper-v-image-acquisition-stage-cache-v1",
    "hyper-v-powershell-stage-propagation-v1",
    "hyper-v-provider-image-finalization-v30",
    "hyper-v-network-failure-diagnostics-v9",
];
export const HYPER_V_LEVEL3_PROVIDER_CONTRACT = "hyper-v-provider-image-finalization-v30";
export const HYPER_V_LEVEL3_NETWORK_OWNERSHIP_CONTRACT = "hyper-v-setup-network-v10";
export const HYPER_V_LEVEL3_NETWORK_DIAGNOSTICS_CONTRACT = "hyper-v-network-failure-diagnostics-v9";
export const HYPER_V_LEVEL3_GUEST_DIAGNOSTICS_CONTRACT = "hyper-v-guest-readiness-diagnostics-v6";
const HOST_BROKER_STATUS_MAX_BYTES = 256 * 1024;
const HOST_BROKER_STATUS_TIMEOUT_MS = 5000;
const HOST_BROKER_REPAIR_TIMEOUT_MS = 180000;

export function buildLevel3Artifacts(repoRoot, options: any = {}) {
    const spawn = options.spawn || spawnSync;
    const readFile = options.readFile || readFileSync;
    const writeFile = options.writeFile || writeFileSync;
    const env = options.env || process.env;
    const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const compiled = spawn(process.execPath, [tsc], { cwd: repoRoot, env, encoding: "utf-8", windowsHide: true });
    if (compiled.status !== 0) {
        process.stderr.write(compiled.stderr || compiled.stdout || "CCC host broker build failed\n");
        return compiled.status ?? 1;
    }
    const builtHyperVProvider = join(repoRoot, "dist", "host-control", "hyper-v", "contracts.js");
    const providerArtifact = readFile(builtHyperVProvider, "utf-8");
    if (!providerArtifact.includes(HYPER_V_LEVEL3_PROVIDER_CONTRACT)) {
        process.stderr.write(`Hyper-V provider build attestation failed; missing ${HYPER_V_LEVEL3_PROVIDER_CONTRACT} in ${builtHyperVProvider}\n`);
        return 1;
    }
    const realTestsTypecheck = spawn(process.execPath, [tsc, "-p", join(repoRoot, "tsconfig.real-tests.json")], { cwd: repoRoot, env, encoding: "utf-8", windowsHide: true });
    if (realTestsTypecheck.status !== 0) {
        process.stderr.write(realTestsTypecheck.stderr || realTestsTypecheck.stdout || "Level 3 real-test typecheck failed\n");
        return realTestsTypecheck.status ?? 1;
    }
    const packageVersion = JSON.parse(readFile(join(repoRoot, "package.json"), "utf-8")).version;
    const builtUtils = join(repoRoot, "dist", "utils.js");
    writeFile(builtUtils, readFile(builtUtils, "utf-8").replace("__CLI_VERSION__", packageVersion));
    const esbuild = join(repoRoot, "node_modules", "esbuild-wasm", "bin", "esbuild");
    const bundled = spawn(process.execPath, [esbuild, "device-lab-mcp/server.mjs", "--bundle", "--platform=node", "--format=esm", "--outfile=dist/device-lab-mcp/server.mjs", "--banner:js=// device-lab-mcp-version: 1"], {
        cwd: repoRoot, env, encoding: "utf-8", windowsHide: true,
    });
    if (bundled.status === 0) return 0;
    process.stderr.write(bundled.stderr || bundled.stdout || "device-lab MCP build failed\n");
    return bundled.status ?? 1;
}

export async function probeHostBrokerCapabilities(port: number, options: any = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || HOST_BROKER_STATUS_TIMEOUT_MS);
    try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/status`, {
            signal: controller.signal,
            redirect: "manual",
        });
        if (!response.ok || (response.status >= 300 && response.status < 400)) {
            return { ok: false, error: `http-${response.status}`, capabilities: [] };
        }
        const declaredLength = response.headers?.get?.("content-length");
        if (declaredLength && /^\d+$/.test(declaredLength)
            && Number(declaredLength) > HOST_BROKER_STATUS_MAX_BYTES) {
            return { ok: false, error: "response-too-large", capabilities: [] };
        }
        if (!response.body || typeof response.body.getReader !== "function") {
            return { ok: false, error: "missing-response-body", capabilities: [] };
        }
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                receivedBytes += value.byteLength;
                if (receivedBytes > HOST_BROKER_STATUS_MAX_BYTES) {
                    await reader.cancel().catch(() => undefined);
                    return { ok: false, error: "response-too-large", capabilities: [] };
                }
                chunks.push(Buffer.from(value));
            }
        } finally {
            reader.releaseLock();
        }
        const text = Buffer.concat(chunks, receivedBytes).toString("utf8");
        const parsed = JSON.parse(text);
        const implemented = parsed?.ok === true && parsed?.broker && Array.isArray(parsed.broker.implemented)
            ? parsed.broker.implemented.map(String)
            : [];
        const pid = Number(parsed?.broker?.process?.pid);
        const startedAt = typeof parsed?.broker?.startedAt === "string" ? parsed.broker.startedAt : "";
        return implemented.length > 0 && Number.isInteger(pid) && pid > 0 && startedAt
            ? { ok: true, capabilities: implemented, pid, startedAt }
            : { ok: false, error: "invalid-status-response", capabilities: [] };
    } catch (error: any) {
        return { ok: false, error: error?.name === "AbortError" ? "timeout" : "fetch-failed", capabilities: [] };
    } finally {
        clearTimeout(timer);
    }
}

export async function ensureHostBrokerReady(repoRoot, options: any = {}) {
    const spawn = options.spawn || spawnSync;
    const repairTimeoutMs = Number.isFinite(options.repairTimeoutMs)
        ? Math.max(1, Number(options.repairTimeoutMs))
        : HOST_BROKER_REPAIR_TIMEOUT_MS;
    const deadlineAt = Date.now() + repairTimeoutMs;
    const remainingMs = () => Math.max(1, deadlineAt - Date.now());
    const runStatus = () => spawn(
        process.execPath,
        [join(repoRoot, "dist", "index.js"), "devices", "broker", "status"],
        {
            cwd: repoRoot,
            env: options.env || process.env,
            encoding: "utf-8",
            timeout: remainingMs(),
            maxBuffer: HOST_BROKER_STATUS_MAX_BYTES,
            windowsHide: true,
        },
    );
    const result = runStatus();
    const stdout = String(result.stdout || "");
    const verifiedCapabilities = /^brokerVerifiedCapabilities:\s*(.*)$/m.exec(stdout)?.[1]
        ?.split(",")
        .map((capability) => capability.trim())
        .filter(Boolean) || [];
    const missingCapabilities = HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES
        .filter((capability) => !verifiedCapabilities.includes(capability));
    const verifiedPid = Number(/^brokerVerifiedPid:\s*(\d+)$/m.exec(stdout)?.[1] || "");
    const verifiedStartedAt = /^brokerVerifiedStartedAt:\s*(\S+)$/m.exec(stdout)?.[1] || "";
    if (result.status === 0 && missingCapabilities.length > 0) {
        process.stderr.write(`CCC host broker capability attestation failed; missing: ${missingCapabilities.join(", ")}\n`);
        return 1;
    }
    if (result.status === 0 && /brokerReady:\s*true/.test(stdout)) {
        const port = Number(/^port:\s*(\d+)$/m.exec(stdout)?.[1] || "");
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            process.stderr.write("CCC host broker capability attestation failed; status did not report a valid port\n");
            return 1;
        }
        const probe = options.probeHostBrokerCapabilitiesImpl || probeHostBrokerCapabilities;
        const observed = await probe(port, {
            ...options,
            timeoutMs: Math.min(
                remainingMs(),
                Number.isFinite(options.timeoutMs)
                    ? Math.max(1, Number(options.timeoutMs))
                    : HOST_BROKER_STATUS_TIMEOUT_MS,
            ),
        });
        const observedCapabilities = Array.isArray(observed?.capabilities)
            ? observed.capabilities.map(String)
            : [];
        const missingObservedCapabilities = HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES
            .filter((capability) => !observedCapabilities.includes(capability));
        if (observed?.ok !== true || missingObservedCapabilities.length > 0) {
            process.stderr.write([
                "CCC host broker remote capability attestation failed",
                `port=${port}`,
                `error=${String(observed?.error || "missing-required-capabilities")}`,
                `missing=${missingObservedCapabilities.join(", ") || "unknown"}`,
                `observed=${observedCapabilities.filter((capability) => capability.startsWith("hyper-v-")).join(", ") || "none"}`,
            ].join("; ") + "\n");
            return 1;
        }
        const confirmed = runStatus();
        const confirmedStdout = String(confirmed.stdout || "");
        const confirmedCapabilities = /^brokerVerifiedCapabilities:\s*(.*)$/m.exec(confirmedStdout)?.[1]
            ?.split(",")
            .map((capability) => capability.trim())
            .filter(Boolean) || [];
        const confirmedPid = Number(/^brokerVerifiedPid:\s*(\d+)$/m.exec(confirmedStdout)?.[1] || "");
        const confirmedStartedAt = /^brokerVerifiedStartedAt:\s*(\S+)$/m.exec(confirmedStdout)?.[1] || "";
        const missingConfirmedCapabilities = HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES
            .filter((capability) => !confirmedCapabilities.includes(capability));
        if (confirmed.status === 0
            && /brokerReady:\s*true/.test(confirmedStdout)
            && missingConfirmedCapabilities.length === 0
            && verifiedPid === observed.pid
            && confirmedPid === observed.pid
            && verifiedStartedAt === observed.startedAt
            && confirmedStartedAt === observed.startedAt) {
            process.stdout.write(`ATTEST Hyper-V broker pid=${observed.pid} startedAt=${observed.startedAt} providerContract=${HYPER_V_LEVEL3_PROVIDER_CONTRACT} networkOwnership=${HYPER_V_LEVEL3_NETWORK_OWNERSHIP_CONTRACT} networkDiagnostics=${HYPER_V_LEVEL3_NETWORK_DIAGNOSTICS_CONTRACT} guestDiagnostics=${HYPER_V_LEVEL3_GUEST_DIAGNOSTICS_CONTRACT}\n`);
            return 0;
        }
        process.stderr.write([
            "CCC host broker process identity changed during capability attestation",
            `port=${port}`,
            `initialPid=${Number.isInteger(verifiedPid) ? verifiedPid : "missing"}`,
            `observedPid=${Number.isInteger(observed.pid) ? observed.pid : "missing"}`,
            `confirmedPid=${Number.isInteger(confirmedPid) ? confirmedPid : "missing"}`,
        ].join("; ") + "\n");
        return 1;
    }
    const processError = result.error instanceof Error
        ? `${result.error.name}: ${result.error.message}`
        : result.error ? String(result.error) : "";
    const childOutput = String(result.stderr || result.stdout || "").trimEnd();
    const processDiagnostic = [
        "CCC host broker repair preflight failed",
        `status=${result.status ?? "missing"}`,
        `signal=${result.signal || "none"}`,
        `error=${processError || "no-output"}`,
        `timeoutMs=${repairTimeoutMs}`,
    ].join("; ");
    process.stderr.write(`${childOutput ? `${childOutput}\n` : ""}${processDiagnostic}\n`);
    return 1;
}
