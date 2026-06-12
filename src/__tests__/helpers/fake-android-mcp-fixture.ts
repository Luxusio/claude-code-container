import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoRoot, TIMEOUT } from "./device-lab-mcp-fixture.js";

export { TIMEOUT };

export interface FakeAndroidMcpContext {
    client: Client;
    homeDir: string;
    binDir: string;
    logPath: string;
}

export async function createFakeAndroidMcpContext(): Promise<FakeAndroidMcpContext> {
    let client: Client | undefined;
    let homeDir = "";
    let binDir = "";
    let logPath = "";
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-android-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-android-bin-"));
        logPath = join(homeDir, "fake-android.log");

        const writeScript = (name: string, body: string) => {
            const path = join(binDir, name);
            writeFileSync(path, `#!/bin/sh\n${body}\n`);
            chmodSync(path, 0o755);
        };

        writeScript("emulator", `
echo "emulator $*" >> "$FAKE_ANDROID_LOG"
if [ "$1" = "-list-avds" ]; then
  echo "host_pixel"
  echo "ccc-external-other"
  exit 0
fi
exit 0
`);
        writeScript("adb", `
echo "adb $*" >> "$FAKE_ANDROID_LOG"
if [ "$1" = "-s" ]; then
  shift
  shift
fi
if [ "$1" = "devices" ] && [ "$2" = "-l" ]; then
  echo "List of devices attached"
  echo "R5CREAL123 device usb:1-1 product:oriole model:Pixel_6 device:oriole transport_id:7"
  echo "192.168.1.50:5555 device product:oriole model:Pixel_6 device:oriole transport_id:9"
  echo "192.168.1.60:5555 device product:oriole model:Pixel_6 device:oriole transport_id:10"
  echo "R5LEASED999 device usb:1-4 product:oriole model:Pixel_6 device:oriole transport_id:8"
  echo "UNAUTHORIZED unauthorized usb:1-2 model:Pixel_5"
  echo "OFFLINE offline usb:1-3 model:Pixel_4"
  echo "emulator-5554 device product:sdk_gphone"
  exit 0
fi
if [ "$1" = "connect" ]; then
  case "$2" in
    192.168.1.50:5555) echo "connected to $2"; exit 0 ;;
    *) echo "failed to connect to $2" >&2; exit 1 ;;
  esac
fi
if [ "$1" = "tcpip" ]; then
  case "$2" in
    5555) echo "restarting in TCP mode port: $2"; exit 0 ;;
    *) echo "failed to restart tcpip on $2" >&2; exit 1 ;;
  esac
fi
if [ "$1" = "pair" ]; then
  if [ "$2" = "192.168.1.70:37099" ] && [ "$3" = "123456" ]; then
    echo "Successfully paired to $2"
    exit 0
  fi
  echo "Failed to pair to $2" >&2
  exit 1
fi
if [ "$1" = "get-state" ]; then
  echo "device"
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "sys.boot_completed" ]; then
  echo "1"
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "uiautomator" ] && [ "$3" = "dump" ]; then
  echo "UI hierchary dumped to: $4"
  exit 0
fi
if [ "$1" = "exec-out" ] && [ "$2" = "cat" ]; then
  printf '%s\\n' '<hierarchy><node text="Hello" resource-id="com.example:id/title"/></hierarchy>'
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "cat" ]; then
  printf '%s\\n' '<hierarchy><node text="Hello" resource-id="com.example:id/title"/></hierarchy>'
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "screenrecord" ]; then
  case "$5" in
    *fail-immediate*) exit 9 ;;
    *natural-exit*) exec /bin/sleep 0.3 ;;
    *) exec /bin/sleep 20 ;;
  esac
fi
if [ "$1" = "pull" ]; then
  case "$2" in
    *fail-pull*) exit 8 ;;
    *) exit 0 ;;
  esac
fi
if [ "$1" = "shell" ]; then
  echo "ok"
  exit 0
fi
exit 0
`);
        writeScript("avdmanager", `
echo "avdmanager $*" >> "$FAKE_ANDROID_LOG"
exit 0
`);

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_ANDROID_LOG: logPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-android-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    if (!client) throw new Error("fake Android MCP client was not created");
    return { client, homeDir, binDir, logPath };
}

export async function cleanupFakeAndroidMcpContext(context: FakeAndroidMcpContext | undefined) {
    if (!context) return;
    await context.client.close();
    rmSync(context.homeDir, { recursive: true, force: true });
    rmSync(context.binDir, { recursive: true, force: true });
}
