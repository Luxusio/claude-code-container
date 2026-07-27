import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installDefaultImplicitBroker, repoRoot, TIMEOUT } from "./device-lab-mcp-fixture.js";

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
if [ -f "$HOME/fake-android-start-conflict-state-path" ]; then
  state_path="$(/bin/cat "$HOME/fake-android-start-conflict-state-path")"
  /bin/cp "$HOME/fake-android-start-conflict-state.json" "$state_path" || exit 92
  /bin/rm -f "$HOME/fake-android-start-conflict-state-path"
fi
emulator_port=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-port" ] && [ "$#" -gt 1 ]; then
    emulator_port="$2"
    break
  fi
  shift
done
if [ -n "$emulator_port" ]; then
  : > "$HOME/fake-adb-active-emulator-$emulator_port"
fi
exec /bin/sleep 20
`);
        writeScript("adb", `
echo "adb $*" >> "$FAKE_ANDROID_LOG"
serial=""
if [ "$1" = "-s" ]; then
  serial="$2"
  shift
  shift
fi
if [ "$1" = "devices" ] && [ "$2" = "-l" ]; then
  if [ -f "$HOME/fake-adb-devices-fail" ]; then
    echo "adb server unavailable" >&2
    exit 12
  fi
  echo "List of devices attached"
  echo "R5CREAL123 device usb:1-1 product:oriole model:Pixel_6 device:oriole transport_id:7"
  echo "192.168.1.50:5555 device product:oriole model:Pixel_6 device:oriole transport_id:9"
  echo "192.168.1.60:5555 device product:oriole model:Pixel_6 device:oriole transport_id:10"
  echo "R5LEASED999 device usb:1-4 product:oriole model:Pixel_6 device:oriole transport_id:8"
  echo "UNAUTHORIZED unauthorized usb:1-2 model:Pixel_5"
  echo "OFFLINE offline usb:1-3 model:Pixel_4"
  echo "emulator-5554 device product:sdk_gphone"
  for marker in "$HOME"/fake-adb-active-emulator-*; do
    [ -e "$marker" ] || continue
    active_port="\${marker##*-}"
    [ "$active_port" = "5554" ] || echo "emulator-$active_port device product:sdk_gphone"
  done
  if [ -f "$HOME/fake-adb-extra-emulator" ]; then
    extra_port="$(/bin/cat "$HOME/fake-adb-extra-emulator")"
    echo "emulator-$extra_port device product:sdk_gphone"
  fi
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
  if [ -z "$serial" ] || [ ! -f "$HOME/fake-adb-active-$serial" ]; then
    echo "device not found" >&2
    exit 1
  fi
  echo "device"
  exit 0
fi
if [ "$1" = "emu" ] && [ "$2" = "avd" ] && [ "$3" = "name" ]; then
  if [ -f "$HOME/fake-adb-avd-name-$serial" ]; then
    /bin/cat "$HOME/fake-adb-avd-name-$serial"
  else
    echo "host_pixel"
  fi
  echo "OK"
  exit 0
fi
if [ "$1" = "emu" ] && [ "$2" = "kill" ]; then
  /bin/rm -f "$HOME/fake-adb-active-$serial"
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "sys.boot_completed" ]; then
  attempts=0
  while [ -f "$HOME/fake-android-start-conflict-state-path" ] && [ "$attempts" -lt 200 ]; do
    /bin/sleep 0.01
    attempts=$((attempts + 1))
  done
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
if [ "$1" = "exec-out" ] && [ "$2" = "screencap" ] && [ "$3" = "-p" ]; then
  printf '\\211PNG\\015\\012\\032\\012FAKEPNG'
  if [ -f "$HOME/fake-screencap-large" ]; then
    /bin/dd if=/dev/zero bs=1048576 count=2 2>/dev/null
  fi
  if [ -f "$HOME/fake-screencap-exit-1" ]; then
    exit 1
  fi
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
if [ "$1" = "shell" ] && [ "$2" = "pkill" ] && [ -f "$HOME/fake-android-real-state-conflict-path" ]; then
  state_path="$(/bin/cat "$HOME/fake-android-real-state-conflict-path")"
  /bin/cp "$HOME/fake-android-real-state-conflict.json" "$state_path" || exit 93
  /bin/rm -f "$HOME/fake-android-real-state-conflict-path"
fi
if [ "$1" = "pull" ]; then
  case "$2" in
    *fail-pull*) exit 8 ;;
    *fail-once-pull*)
      if [ ! -f "$HOME/fake-adb-pull-retried" ]; then
        : > "$HOME/fake-adb-pull-retried"
        exit 8
      fi
      /bin/printf 'downloaded' > "$3"
      exit 0
      ;;
    *) /bin/printf 'downloaded' > "$3"; exit 0 ;;
  esac
fi
if [ "$1" = "push" ]; then
  case "$3" in
    *fail-push*) exit 8 ;;
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
if [ "$1" = "create" ] && [ "$2" = "avd" ] && [ "$3" = "--name" ] && [ -n "$4" ]; then
  /bin/mkdir -p "$HOME/.android/avd/$4.avd"
  printf 'path=%s\\n' "$HOME/.android/avd/$4.avd" > "$HOME/.android/avd/$4.ini"
  if [ -f "$HOME/fake-android-avdmanager-create-fail" ]; then
    echo "injected partial AVD creation failure" >&2
    exit 17
  fi
fi
if [ "$1" = "create" ] && [ -f "$HOME/fake-android-create-conflict-state-path" ]; then
  state_path="$(/bin/cat "$HOME/fake-android-create-conflict-state-path")"
  /bin/cp "$HOME/fake-android-create-conflict-state.json" "$state_path" || exit 91
  /bin/rm -f "$HOME/fake-android-create-conflict-state-path"
fi
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
        installDefaultImplicitBroker(client, false);
    if (!client) throw new Error("fake Android MCP client was not created");
    return { client, homeDir, binDir, logPath };
}

export async function cleanupFakeAndroidMcpContext(context: FakeAndroidMcpContext | undefined) {
    if (!context) return;
    await context.client.close();
    rmSync(context.homeDir, { recursive: true, force: true });
    rmSync(context.binDir, { recursive: true, force: true });
}
