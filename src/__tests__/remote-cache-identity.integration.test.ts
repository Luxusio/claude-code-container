import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { remoteContainerStartScript } from "../remote.js";
import { MISE_VOLUME_NAME } from "../utils.js";
import { IDENTITY_CONTRACT_VERSION } from "../container-identity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function execute(overrides: NodeJS.ProcessEnv = {}) {
    const root = mkdtempSync(join(tmpdir(), "ccc-remote-cache-"));
    roots.push(root);
    const log = join(root, "calls");
    writeFileSync(log, "");
    writeFileSync(join(root, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  'inspect --format') if [ -n "$EXISTING" ]; then printf '%s\\n' "$EXISTING"; else exit 1; fi;;
  'start '*) exit 0;;
  'image inspect') [ "$FAIL_IMAGE" != 1 ] || exit 1; printf '%s\\n' "$IMAGE_ID";;
  'run --rm') [ "$FAIL_PROBE" != 1 ] || exit 1; printf '%s\\n' "$REMOTE_IDS";;
  'run -d') printf '%s\\n' abcdef0123456789;;
  *) exit 90;;
esac
`, { mode: 0o700 });
    const result = spawnSync("/bin/sh", ["-ec", remoteContainerStartScript("/project/example", "work")], {
        encoding: "utf-8", env: { ...process.env, HOME: root, PATH: `${root}:${process.env.PATH}`, CALL_LOG: log,
            IMAGE_ID: `sha256:${"a".repeat(64)}`, REMOTE_IDS: "2123-2456", ...overrides },
    });
    return { ...result, calls: readFileSync(log, "utf-8").trim().split("\n"), root };
}

describe.runIf(process.platform !== "win32")("remote image identity cache", () => {
    it("uses the pinned remote image's identity and preserves remote profile paths", () => {
        const result = execute();
        expect(result.status, result.stderr).toBe(0);
        const creation = result.calls.find(line => line.startsWith("run -d"))!;
        expect(creation).toContain(`${MISE_VOLUME_NAME}-v${IDENTITY_CONTRACT_VERSION}-remote-2123-2456:/home/ccc/.local/share/mise`);
        expect(creation).toContain(`${result.root}/.ccc/profiles/work/claude:/home/ccc/.claude`);
        expect(creation).toContain(`sha256:${"a".repeat(64)} sleep infinity`);
        expect(result.calls.find(line => line.startsWith("run --rm"))).toContain(`--network none --entrypoint /bin/sh sha256:${"a".repeat(64)}`);
    });
    it("keeps an existing container without probing or changing its mounted cache", () => {
        const result = execute({ EXISTING: "abcdef0123456789", FAIL_IMAGE: "1" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.calls).toHaveLength(2);
        expect(result.calls[1]).toBe("start abcdef0123456789");
    });
    it.each([
        { FAIL_IMAGE: "1" }, { FAIL_PROBE: "1" }, { IMAGE_ID: "ccc:latest" },
        { REMOTE_IDS: "" }, { REMOTE_IDS: "---" }, { REMOTE_IDS: "1-2-3" },
        { REMOTE_IDS: "1-2\n3-4" }, { REMOTE_IDS: "1-2;touch /tmp/invalid" },
    ])("refuses to create a container when identity cannot be proven: %j", overrides => {
        const result = execute(overrides);
        expect(result.status).not.toBe(0);
        expect(result.calls.some(line => line.startsWith("run -d"))).toBe(false);
    });
});
