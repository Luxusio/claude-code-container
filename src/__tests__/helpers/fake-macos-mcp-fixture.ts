import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";

export interface FakeMacosMcpContext {
    homeDir: string;
    binDir: string;
    logPath: string;
    oldHome: string | undefined;
    oldPath: string | undefined;
    platformSpy: ReturnType<typeof vi.spyOn>;
}

function writeExecutable(path: string, content: string) {
    writeFileSync(path, content);
    chmodSync(path, 0o755);
}

export function createFakeMacosMcpContext(): FakeMacosMcpContext {
    const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-bin-"));
    const logPath = join(homeDir, "fake-tart.log");

    writeExecutable(join(binDir, "tart"), `#!/bin/sh
echo "tart $*" >> "$FAKE_TART_LOG"
if [ -n "$FAKE_TART_REPLACE_ON" ] && [ "$1" = "$FAKE_TART_REPLACE_ON" ] && [ -n "$FAKE_TART_REPLACEMENT_STATE" ] && [ -n "$FAKE_TART_TARGET_STATE" ]; then
  /bin/cp "$FAKE_TART_REPLACEMENT_STATE" "$FAKE_TART_TARGET_STATE.replacement"
  /bin/mv "$FAKE_TART_TARGET_STATE.replacement" "$FAKE_TART_TARGET_STATE"
fi
if [ "$1" = "clone" ]; then
  case "$2" in
    *fail-restore*) exit 8 ;;
    *restore-*fail-activate*) exit 7 ;;
  esac
  case "$3" in
    *fail-snapshot*) exit 9 ;;
  esac
fi
if [ "$1" = "delete" ]; then
  case "$2" in
    *macos-partial-delete) echo "primary delete failed" >&2; exit 6 ;;
    *fail-delete*) echo "delete failed" >&2; exit 6 ;;
  esac
fi
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  echo "Usage: tart run [--with-softnet] [--no-graphics] VM"
  exit 0
fi
if [ "$1" = "run" ]; then
  if [ "$FAKE_TART_RUN_EXIT_IMMEDIATELY" = "1" ]; then exit 0; fi
  /bin/sleep 1
  exit 0
fi
if [ "$1" = "ip" ]; then
  case "$*" in
    *macos-arp-fallback*)
      case "$*" in
        *"--resolver=arp"*) echo "192.0.2.45"; exit 0 ;;
        *) echo "no IP address found" >&2; exit 1 ;;
      esac
      ;;
  esac
  echo "192.0.2.44"
  exit 0
fi
exit 0
`);

    writeExecutable(join(binDir, "vz"), `#!/bin/sh
echo "vz $*" >> "$FAKE_TART_LOG"
exit 0
`);

    writeExecutable(join(binDir, "ssh"), `#!/bin/sh
echo "ssh $*" >> "$FAKE_TART_LOG"
case "$*" in
  *screencapture*"-v"*) exec /bin/sleep 20 ;;
  *screencapture*"-x"*) exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' click '22' '33' 'right'"*) echo '{"ok":true,"clicked":{"x":22,"y":33,"button":"right"},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' double_click '44' '55' 'left'"*) echo '{"ok":true,"doubleClicked":{"x":44,"y":55,"button":"left"},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' key '0' 'command,shift'"*) echo '{"ok":true,"key":{"keyCode":0,"modifiers":"command,shift"},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' type"*) echo '{"ok":true,"typed":{"text":"hello '\\''mac'\\'' {literal}"},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' scroll 'left' '4'"*) echo '{"ok":true,"scrolled":{"direction":"left","amount":4},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' cursor_position"*) echo '{"ok":true,"cursor":{"x":101,"y":202},"provider":"macos-helper"}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' window_list"*) echo '{"ok":true,"provider":"macos-system-events","windows":[{"processName":"TextEdit","processId":501,"title":"Notes","role":"AXWindow","position":[10,20],"size":[300,200]}]}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' accessibility_snapshot '8' '1000'"*) echo '{"ok":true,"provider":"macos-system-events","accessibility":{"provider":"macos-system-events","maxDepth":8,"maxNodes":1000,"nodeCount":3,"root":{"name":"macOS Desktop","role":"AXApplicationGroup","children":[{"name":"TextEdit","role":"AXApplication","processId":501,"children":[{"name":"Notes","role":"AXWindow","children":[]}]}]}}}'; exit 0 ;;
  *"ccc-macos-fake-tart-guest-helper.sh' accessibility_snapshot '0' '1'"*) echo '{"ok":true,"provider":"macos-system-events","accessibility":{"provider":"macos-system-events","maxDepth":0,"maxNodes":1,"nodeCount":1,"root":{"name":"macOS Desktop","role":"AXApplicationGroup","children":[]}}}'; exit 0 ;;
  *pkill*) exit 0 ;;
  *rm\\ -f*) exit 0 ;;
  *fail-command*) echo "ssh failure stdout"; echo "ssh failure stderr" >&2; exit 7 ;;
  *) echo "ssh output"; exit 0 ;;
esac
`);

    writeExecutable(join(binDir, "scp"), `#!/bin/sh
echo "scp $*" >> "$FAKE_TART_LOG"
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  *fail-helper*) echo "scp helper failure" >&2; exit 5 ;;
  *:*) exit 0 ;;
  *)
    case "$*" in
      *fail-once-recording-copy*)
        if [ ! -f "$HOME/fake-macos-recording-copy-retried" ]; then
          : > "$HOME/fake-macos-recording-copy-retried"
          echo "scp recording failure" >&2
          exit 5
        fi
        ;;
    esac
    printf 'fakepng' > "$last"
    exit 0
    ;;
esac
`);

    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    process.env.HOME = homeDir;
    process.env.PATH = binDir;
    process.env.FAKE_TART_LOG = logPath;
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    return { homeDir, binDir, logPath, oldHome, oldPath, platformSpy };
}

export function cleanupFakeMacosMcpContext(context: FakeMacosMcpContext | undefined) {
    if (!context) return;
    context.platformSpy.mockRestore();
    if (context.oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = context.oldHome;
    if (context.oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = context.oldPath;
    delete process.env.FAKE_TART_LOG;
    delete process.env.FAKE_TART_REPLACE_ON;
    delete process.env.FAKE_TART_REPLACEMENT_STATE;
    delete process.env.FAKE_TART_TARGET_STATE;
    delete process.env.FAKE_TART_RUN_EXIT_IMMEDIATELY;
    rmSync(context.homeDir, { recursive: true, force: true });
    rmSync(context.binDir, { recursive: true, force: true });
}
