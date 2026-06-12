import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoRoot, TIMEOUT } from "./device-lab-mcp-fixture.js";

export { TIMEOUT };

export interface FakeIosMcpContext {
    client: Client;
    homeDir: string;
    binDir: string;
    logPath: string;
}

export async function createFakeIosMcpContext(): Promise<FakeIosMcpContext> {
    let client: Client | undefined;
    let homeDir = "";
    let binDir = "";
    let logPath = "";
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-bin-"));
        logPath = join(homeDir, "fake-ios.log");
        const containerRoot = join(homeDir, "ios-app-container");

        const xcrunPath = join(binDir, "xcrun");
        writeFileSync(xcrunPath, `#!/bin/sh
echo "xcrun $*" >> "$FAKE_IOS_LOG"
if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"host iPhone","udid":"HOST-UDID","state":"Shutdown"}]},"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-17-0","name":"iOS 17.0","isAvailable":true}],"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15","name":"iPhone 15"}]}'
  exit 0
fi
if [ "$1" = "xctrace" ] && [ "$2" = "list" ] && [ "$3" = "devices" ]; then
  echo "Devices:"
  echo "Build Mac (15.0) (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE)"
  echo "Real iPhone (17.5) (00008110-001C195E0E91801E)"
  echo "Network iPhone (17.5) (00008120-00AA00BB00CC00DD) (Network)"
  echo "Other iPhone (16.7) (00008101-00DEADBEEFCAFE00)"
  echo "Simulators:"
  echo "iPhone 15 Simulator (17.0) (SIM-UDID)"
  exit 0
fi
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "install" ] && [ "$4" = "app" ]; then
  exit 0
fi
if [ "$1" = "devicectl" ] && [ "$2" = "device" ] && [ "$3" = "process" ] && [ "$4" = "launch" ]; then
  echo "launched $8"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "create" ]; then
  echo "CREATED-IOS-UDID"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "boot" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  echo "Booted"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "shutdown" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "delete" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "erase" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "get_app_container" ]; then
  mkdir -p "$FAKE_IOS_CONTAINER_ROOT"
  echo "$FAKE_IOS_CONTAINER_ROOT"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "spawn" ]; then
  echo "ok"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$4" = "screenshot" ]; then
  printf 'fakepng' > "$5"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$4" = "recordVideo" ]; then
  case "$5" in
    *fail-immediate*) exit 9 ;;
    *natural-exit*) exec /bin/sleep 0.3 ;;
    *) exec /bin/sleep 20 ;;
  esac
fi
if [ "$1" = "simctl" ] && [ "$2" = "openurl" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "install" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "launch" ]; then
  echo "$4: 123"
  exit 0
fi
exit 0
`);
        chmodSync(xcrunPath, 0o755);
        const appiumPath = join(binDir, "appium");
        writeFileSync(appiumPath, `#!/bin/sh
echo "appium $*" >> "$FAKE_IOS_LOG"
PORT=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--port" ]; then
    shift
    PORT="$1"
  fi
  shift
done
exec "${process.execPath}" - "$PORT" "$FAKE_IOS_LOG" "${join(homeDir, "stale-ios-session")}" <<'NODE'
const http = require('http');
const fs = require('fs');
const port = Number(process.argv[2]);
const log = process.argv[3];
const stalePath = process.argv[4];
let sessionCounter = 0;
let sessionId = null;
function send(res, status, payload) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(payload));
}
const server = http.createServer((req, res) => {
  fs.appendFileSync(log, 'appium-http ' + req.method + ' ' + req.url + '\\n');
  if (req.method === 'GET' && req.url === '/status') return send(res, 200, {value: {ready: true}});
  if (req.method === 'POST' && req.url === '/session') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.appendFileSync(log, 'appium-session-body ' + body + '\\n');
      sessionCounter += 1;
      sessionId = 'IOS-SESSION-' + sessionCounter;
      send(res, 200, {value: {sessionId}});
    });
    return;
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId) {
    if (fs.existsSync(stalePath)) {
      fs.unlinkSync(stalePath);
      send(res, 404, {value: {error: 'stale'}});
      return;
    }
    return send(res, 200, {value: {sessionId}});
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId + '/source') {
    if (fs.existsSync(stalePath + '-source-fail')) {
      return send(res, 500, {value: {error: 'source failed'}});
    }
    return send(res, 200, {value: '<AppiumAUT><XCUIElementTypeApplication name="Test"/></AppiumAUT>'});
  }
  if (req.method === 'GET' && sessionId && req.url === '/session/' + sessionId + '/screenshot') {
    return send(res, 200, {value: Buffer.from('fake-real-ios-png').toString('base64')});
  }
  if (req.method === 'POST' && sessionId && (
    req.url === '/session/' + sessionId + '/actions' ||
    req.url === '/session/' + sessionId + '/keys' ||
    req.url === '/session/' + sessionId + '/execute/sync' ||
    req.url === '/session/' + sessionId + '/orientation'
  )) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      fs.appendFileSync(log, 'appium-command-body ' + req.url + ' ' + body + '\\n');
      if (body.includes('mobile: activeAppInfo')) {
        send(res, 200, {value: {bundleId: 'com.example.Real', name: 'Real'}});
        return;
      }
      send(res, 200, {value: null});
    });
    return;
  }
  send(res, 404, {value: {error: 'unknown route'}});
});
process.on('SIGINT', () => {
  fs.appendFileSync(log, 'appium-server-sigint ' + port + '\\n');
  server.close(() => process.exit(0));
});
server.listen(port, '127.0.0.1');
NODE
`);
        chmodSync(appiumPath, 0o755);

        const xcodebuildPath = join(binDir, "xcodebuild");
        writeFileSync(xcodebuildPath, `#!/bin/sh
echo "xcodebuild $*" >> "$FAKE_IOS_LOG"
if [ "$1" = "-version" ]; then
  echo "Xcode 15.0"
  exit 0
fi
exit 0
`);
        chmodSync(xcodebuildPath, 0o755);

        for (const name of ["appium-xcuitest-driver", "xcodebuild"]) {
            const toolPath = join(binDir, name);
            writeFileSync(toolPath, `#!/bin/sh
echo "${name} $*" >> "$FAKE_IOS_LOG"
exit 0
`);
            chmodSync(toolPath, 0o755);
        }

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_IOS_LOG: logPath,
                FAKE_IOS_CONTAINER_ROOT: containerRoot,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-ios-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    if (!client) throw new Error("fake iOS MCP client was not created");
    return { client, homeDir, binDir, logPath };
}

export async function cleanupFakeIosMcpContext(context: FakeIosMcpContext | undefined) {
    if (!context) return;
    await context.client.close();
    rmSync(context.homeDir, { recursive: true, force: true });
    rmSync(context.binDir, { recursive: true, force: true });
}
