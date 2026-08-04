import { chmodSync, writeFileSync } from "fs";
import { createServer } from "http";
import { AddressInfo } from "net";
import { join } from "path";

const FAKE_BROKER_CAPABILITIES = [
    "windows-sandbox-window-minimize-v4",
    "constant-time-existing-owner-auth-v1",
    "atomic-owner-secret-provisioning-v1",
    "owner-mutation-serialization-v1",
    "atomic-owner-device-state-v1",
    "cross-process-owner-state-serialization-v1",
    "owner-device-identity-fencing-v1",
    "rpc-fault-containment-v1",
    "cross-owner-physical-lease-serialization-v1",
    "physical-lease-operation-fencing-v1",
    "physical-lifecycle-lease-fencing-v1",
    "physical-attach-detach-operation-serialization-v1",
    "physical-detach-runtime-cleanup-v1",
    "physical-runtime-cleanup-lease-fencing-v1",
    "physical-lease-state-write-rollback-v1",
    "runtime-cleanup-failure-preservation-v1",
    "appium-runtime-generation-fencing-v1",
    "windows-sandbox-singleton-fencing-v1",
    "cross-process-device-operation-serialization-v1",
    "cross-process-device-runtime-serialization-v1",
    "direct-recording-generation-fencing-v1",
    "direct-appium-generation-fencing-v1",
    "finite-device-operation-serialization-v1",
    "direct-runtime-process-identity-v1",
    "host-recording-process-identity-v1",
    "runtime-process-observation-v1",
    "host-appium-process-identity-v1",
    "broker-owned-owner-secret-provisioning-v1",
    "host-broker-port-process-identity-v1", "host-broker-process-start-token-v1", "owner-generation-hmac-auth-v1",
    "direct-appium-process-identity-v1",
    "owner-device-state-validation-v1",
    "shared-device-ownership-state-validation-v1",
    "android-emulator-port-allocation-fencing-v1",
    "bounded-error-responses-v1",
    "physical-lease-directory-fencing-v1",
    "owner-auth-directory-fencing-v1",
    "appium-runtime-installation-fencing-v1", "bounded-no-redirect-appium-http-transport-v1", "windows-provider-launcher-path-fencing-v1", "canonical-owner-device-ids-v1", "ios-simulator-owner-identity-fencing-v1", "ios-simulator-provider-create-v1", "physical-appium-lease-fencing-v1", "physical-device-tool-lease-fencing-v1", "physical-lifecycle-use-lease-refresh-v1", "appium-live-runtime-metadata-fencing-v1", "direct-android-lifecycle-generation-fencing-v1", "direct-ios-lifecycle-generation-fencing-v1", "direct-windows-lifecycle-generation-fencing-v1", "direct-macos-lifecycle-generation-fencing-v1", "direct-macos-snapshot-clone-generation-fencing-v1", "physical-direct-state-transition-fencing-v1", "multi-project-owner-resolve-v1", "stopped-android-status-observation-v1", "stopped-android-boot-metadata-v1", "guest-helper-recording-proxy-v1", "physical-unattached-wireless-routing-v1", "android-recording-signal-fallback-v1", "hyper-v-vm-managed-auto-images-v20", "hyper-v-setup-network-v8", "hyper-v-guest-readiness-diagnostics-v1", "hyper-v-azure-ovf-seed-v1", "hyper-v-azure-ovf-seed-v2", "hyper-v-azure-bootstrap-dhcp-v1", "hyper-v-azure-local-ovf-v1", "hyper-v-bootstrap-nic-cleanup-v1", "hyper-v-bootstrap-ssh-finalize-v2", "hyper-v-windows-specialize-seed-v1", "hyper-v-windows-specialize-account-v1", "hyper-v-windows-boot-contract-v1", "hyper-v-boot-disk-generation-v1", "hyper-v-linux-create-response-v1", "hyper-v-image-acquisition-stage-cache-v1", "hyper-v-powershell-stage-propagation-v1", "hyper-v-provider-image-finalization-v2", "hyper-v-network-failure-diagnostics-v6",
];

export async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

export function pidAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export async function waitForHealthUnavailable(port: number, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (!response.ok) return true;
        } catch {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
}

export function installFakeCccBroker(pathDir: string, logPath: string, options: { cleanupOk?: boolean; cleanupMode?: "ok" | "fail" | "hang" } = {}) {
    const fakeCcc = join(pathDir, "ccc");
    const cleanupMode = options.cleanupMode || (options.cleanupOk === false ? "fail" : "ok");
    const cleanupOk = cleanupMode === "ok";
    writeFileSync(fakeCcc, `#!${process.execPath}
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const host = args[args.indexOf("--host") + 1] || "127.0.0.1";
const port = Number(args[args.indexOf("--port") + 1] || 17373);
const startedAt = new Date().toISOString();
function processStartToken() {
  try {
    const stat = fs.readFileSync("/proc/" + process.pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\\s+/) : [];
    return fields[19] ? "linux:" + fields[19] : null;
  } catch {
    return null;
  }
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function projectId(projectPath) {
  if (typeof projectPath === "string" && projectPath.startsWith("/project/")) {
    const normalized = path.posix.normalize(projectPath);
    const parts = normalized.split("/");
    if (normalized === projectPath && parts.length === 3 && /^[a-z0-9-]{0,200}-[a-f0-9]{12}$/.test(parts[2])) return parts[2];
  }
  const resolved = path.resolve(projectPath || "/project");
  const name = path.basename(resolved).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return name + "-" + hash;
}
function ownerIdForRequestBody(body) {
  const id = projectId(body.projectMountPath || process.cwd());
  const basis = (body.profile ? "ccc-" + id + "--p--" + body.profile : "ccc-" + id) + ":/project/" + id;
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
function provisionOwnerSecret(ownerId) {
  const file = path.join(os.homedir(), ".ccc/devices/broker/auth", ownerId + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ ownerId, secret: crypto.randomBytes(32).toString("hex"), version: 1 }));
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return file;
}
function expectedOwnerToken(ownerId) {
  const file = path.join(os.homedir(), ".ccc/devices/broker/auth", ownerId + ".json");
  if (!fs.existsSync(file)) return null;
  const secret = JSON.parse(fs.readFileSync(file, "utf8")).secret;
  return crypto.createHash("sha256").update("ccc-device-broker:owner:" + ownerId + ":secret:" + secret).digest("hex");
}
const server = http.createServer((req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" });
  if (req.url === "/status") return send(res, 200, { ok: true, broker: { name: "ccc-device-broker", mode: "host-broker-daemon", host, port, process: { pid: process.pid, startToken: processStartToken() }, startedAt, implemented: ${JSON.stringify(FAKE_BROKER_CAPABILITIES)} } });
  if (req.url === "/v1/owner/resolve" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const ownerId = ownerIdForRequestBody(raw ? JSON.parse(raw) : {});
      provisionOwnerSecret(ownerId);
      send(res, 200, { ok: true, result: { ownerId } });
    });
    return;
  }
  const match = /^\\/v1\\/owners\\/([^/]+)\\/rpc$/.exec(req.url || "");
  if (!match || req.method !== "POST") return send(res, 404, { ok: false, error: "not-found" });
  if (req.headers["x-ccc-device-token"] !== expectedOwnerToken(match[1])) return send(res, 401, { ok: false, error: "invalid-owner-token" });
  fs.appendFileSync(${JSON.stringify(logPath)}, "auth-ok " + match[1] + "\\n");
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    if (body.method === "broker.echo") return send(res, 200, { ok: true, result: { echo: body.params || {}, ownerId: match[1] } });
    if (body.method === "broker.status") return send(res, 200, { ok: true, result: { ownerId: match[1], fake: true } });
    if (body.method === "broker.cleanup.owner") {
      fs.appendFileSync(${JSON.stringify(logPath)}, "cleanup-owner " + match[1] + " " + JSON.stringify(body.params || {}) + "\\n");
      if (${JSON.stringify(cleanupMode)} === "hang") return;
      return send(res, 200, { ok: ${JSON.stringify(cleanupOk)}, result: { ownerId: match[1], cleaned: true, fake: true, failed: ${cleanupOk ? 0 : 1} } });
    }
    if (body.method === "broker.lease.list") return send(res, 200, { ok: true, result: { ownerId: match[1], backend: body.params.backend, leases: [] } });
    if (body.method === "broker.physical.attach") return send(res, 200, { ok: true, result: { ownerId: match[1], device: { id: body.params.deviceId, backend: body.params.backend, serial: body.params.serial || null, udid: body.params.udid || null, connection: body.params.connection || "usb" } } });
    if (body.method === "broker.physical.detach") return send(res, 200, { ok: true, result: { ownerId: match[1], detached: body.params.deviceId, physicalDevicePoweredOff: false } });
    if (body.method === "broker.physical.list") return send(res, 200, { ok: true, result: { ownerId: match[1], backend: body.params.backend, devices: [], leases: [] } });
    if (body.method === "broker.command.plan") return send(res, 200, { ok: true, result: { ownerId: match[1], backend: body.params.backend, command: body.params.command, deviceId: body.params.deviceId, device: { id: body.params.deviceId, status: "stopped" }, execution: { mode: "planned", providerExecution: "fake", mutatesHost: false } } });
    if (body.method === "broker.command.invoke") return send(res, 200, { ok: true, result: { ownerId: match[1], backend: body.params.backend, command: body.params.command, deviceId: body.params.deviceId, dryRun: body.params.dryRun === true, invoked: body.params.dryRun !== true, device: { id: body.params.deviceId, status: body.params.command === "device_start" ? "running" : "stopped" }, execution: { mode: body.params.dryRun === true ? "dry-run" : "exec", providerExecution: "fake", mutatesHost: body.params.dryRun !== true && body.params.command !== "device_status" } } });
    return send(res, 418, { ok: false, error: "fake-broker-error", method: body.method });
  });
});
server.listen(port, host);
function shutdown() {
  if (${JSON.stringify(cleanupMode)} === "hang") process.exit(0);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`);
    chmodSync(fakeCcc, 0o755);
    return fakeCcc;
}

export function installIgnoringCccBroker(pathDir: string, logPath: string) {
    const fakeCcc = join(pathDir, "ccc");
    writeFileSync(fakeCcc, `#!${process.execPath}
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const host = args[args.indexOf("--host") + 1] || "127.0.0.1";
const port = Number(args[args.indexOf("--port") + 1] || 17373);
const startedAt = new Date().toISOString();
function processStartToken() {
  try {
    const stat = fs.readFileSync("/proc/" + process.pid + "/stat", "utf8");
    const close = stat.lastIndexOf(")");
    const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\\s+/) : [];
    return fields[19] ? "linux:" + fields[19] : null;
  } catch {
    return null;
  }
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function projectId(projectPath) {
  if (typeof projectPath === "string" && projectPath.startsWith("/project/")) {
    const normalized = path.posix.normalize(projectPath);
    const parts = normalized.split("/");
    if (normalized === projectPath && parts.length === 3 && /^[a-z0-9-]{0,200}-[a-f0-9]{12}$/.test(parts[2])) return parts[2];
  }
  const resolved = path.resolve(projectPath || "/project");
  const name = path.basename(resolved).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return name + "-" + hash;
}
function ownerIdForRequestBody(body) {
  const id = projectId(body.projectMountPath || process.cwd());
  const basis = (body.profile ? "ccc-" + id + "--p--" + body.profile : "ccc-" + id) + ":/project/" + id;
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
const server = http.createServer((req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true, name: "ccc-device-broker" });
  if (req.url === "/status") return send(res, 200, { ok: true, broker: { name: "ccc-device-broker", mode: "host-broker-daemon", host, port, process: { pid: process.pid, startToken: processStartToken() }, startedAt, implemented: ${JSON.stringify(FAKE_BROKER_CAPABILITIES)} } });
  if (req.url === "/v1/owner/resolve" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => send(res, 200, { ok: true, result: { ownerId: ownerIdForRequestBody(raw ? JSON.parse(raw) : {}) } }));
    return;
  }
  return send(res, 200, { ok: true, result: {} });
});
server.listen(port, host);
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
`);
    chmodSync(fakeCcc, 0o755);
    return fakeCcc;
}
