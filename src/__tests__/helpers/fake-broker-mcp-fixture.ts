import { chmodSync, writeFileSync } from "fs";
import { createServer } from "http";
import { AddressInfo } from "net";
import { join } from "path";

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

export function installFakeCccBroker(pathDir: string, logPath: string) {
    const fakeCcc = join(pathDir, "ccc");
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
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function expectedOwnerToken(ownerId) {
  const file = path.join(os.homedir(), ".ccc/devices/broker/auth", ownerId + ".json");
  const secret = JSON.parse(fs.readFileSync(file, "utf8")).secret;
  return crypto.createHash("sha256").update("ccc-device-broker:owner:" + ownerId + ":secret:" + secret).digest("hex");
}
const server = http.createServer((req, res) => {
  if (req.url === "/health") return send(res, 200, { ok: true, name: "ccc-device-broker", mode: "host-broker-daemon" });
  if (req.url === "/status") return send(res, 200, { ok: true, broker: { name: "ccc-device-broker", host, port } });
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
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`);
    chmodSync(fakeCcc, 0o755);
    return fakeCcc;
}

export function installIgnoringCccBroker(pathDir: string, logPath: string) {
    const fakeCcc = join(pathDir, "ccc");
    writeFileSync(fakeCcc, `#!${process.execPath}
const http = require("http");
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const host = args[args.indexOf("--host") + 1] || "127.0.0.1";
const port = Number(args[args.indexOf("--port") + 1] || 17373);
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/health") return res.end(JSON.stringify({ ok: true, name: "ccc-device-broker" }));
  res.end(JSON.stringify({ ok: true, result: {} }));
});
server.listen(port, host);
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
`);
    chmodSync(fakeCcc, 0o755);
    return fakeCcc;
}
