import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForIosApp } from "../../device-lab-mcp/src/backends/ios-simulator.mjs";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("iOS Simulator app observation", () => {
    it("falls back to launchctl when the simulator guest has no pgrep", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-ios-wait-app-"));
        roots.push(root);
        const xcrun = join(root, "xcrun");
        writeFileSync(xcrun, `#!/bin/sh
case " $* " in
  *" pgrep "*) echo "No such file or directory" >&2; exit 2 ;;
  *" launchctl print user/501 "*) echo "UIKitApplication:com.apple.mobilesafari[1234]"; exit 0 ;;
esac
exit 1
`);
        chmodSync(xcrun, 0o755);

        await expect(waitForIosApp(xcrun, "SIM-UDID", "com.apple.mobilesafari", 100, 10)).resolves.toEqual(expect.objectContaining({
            running: true,
            observedBy: "launchctl-user/501",
            status: 0,
        }));
    });
});
