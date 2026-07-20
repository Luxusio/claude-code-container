import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    macosVmE2ECapability,
    parseTartListImages,
    runMacosVmE2E,
    selectAutoTartSourceImage,
    selectAutoTartSourceImageFromListResults,
    sshConfig,
    sourceImage,
} from "../../scripts/real-tests/macos-vm-e2e.ts";

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const cap = macosVmE2ECapability(level);
const destructiveMacosE2EWillRun = level >= 3 && cap.available;
const title = cap.available
    ? `creates, boots, observes, stops, and deletes a real macOS VM through device-lab MCP Tart backend (${cap.source})`
    : `skips macOS VM Tart E2E (${cap.reason})`;

describe("macOS VM Tart E2E source image auto-selection", () => {
    it("parses Tart list output variants and selects a single safe base image", () => {
        expect(parseTartListImages(JSON.stringify([
            { name: "ccc-real-old-e2e", state: "stopped" },
            { name: "sonoma-base", state: "stopped", source: "local" },
        ]))).toEqual([
            { name: "ccc-real-old-e2e", state: "stopped", source: "" },
            { name: "sonoma-base", state: "stopped", source: "local" },
        ]);
        expect(parseTartListImages('{"name":"ventura-template","state":"stopped"}\n')).toEqual([
            { name: "ventura-template", state: "stopped", source: "" },
        ]);
        expect(parseTartListImages("NAME STATE\nmacos-base stopped\n")).toEqual([
            { name: "macos-base", state: "stopped", source: "" },
        ]);
        expect(parseTartListImages("Source Name State\nlocal local-base stopped\nregistry remote-base stopped\n")).toEqual([
            { name: "local-base", state: "stopped", source: "local" },
            { name: "remote-base", state: "stopped", source: "registry" },
        ]);

        expect(selectAutoTartSourceImage([
            { name: "ccc-level2-e2e-stale", state: "stopped" },
            { name: "registry-base", state: "stopped", source: "registry" },
            { name: "macos-base", state: "stopped" },
        ])).toEqual(expect.objectContaining({
            source: "macos-base",
            auto: true,
        }));
    });

    it("does not auto-select when multiple local Tart image candidates are ambiguous", () => {
        expect(selectAutoTartSourceImage([
            { name: "macos-base-a", state: "stopped" },
            { name: "work-vm", state: "stopped" },
        ])).toEqual(expect.objectContaining({
            source: "",
            reason: expect.stringContaining("multiple local Tart images"),
            candidates: ["macos-base-a", "work-vm"],
        }));
    });

    it("prefers a stopped CCC macOS base without selecting unrelated user VMs or registry entries", () => {
        expect(selectAutoTartSourceImage([
            { name: "ccc-macos-base", state: "stopped", source: "local" },
            { name: "ccc-525bceb2afd55cdb-user-device", state: "stopped", source: "local" },
            { name: "work-vm", state: "stopped", source: "local" },
            { name: "ghcr.io/cirruslabs/macos-sonoma-base:latest", state: "stopped", source: "OCI" },
        ])).toEqual({
            source: "ccc-macos-base",
            candidates: ["ccc-macos-base"],
            auto: true,
        });
    });

    it("falls through to later Tart list variants when an earlier successful command has no parseable images", () => {
        expect(selectAutoTartSourceImageFromListResults([
            { command: "tart list --source=local --format=json", status: 0, stdout: "Usage: tart list [options]\nOptions:\n  --help\n" },
            { command: "tart list", status: 0, stdout: "Name Source State\nlocal-base local stopped\n" },
        ])).toEqual(expect.objectContaining({
            source: "local-base",
            command: "tart list",
        }));
    });

    it("auto-selects a single local Tart image by default when no source env is configured", () => {
        const previousSource = process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE;
        const previousCompatSource = process.env.CCC_REAL_TART_SOURCE_IMAGE;
        const dir = mkdtempSync(join(tmpdir(), "ccc-fake-tart-"));
        const tart = join(dir, "tart");
        try {
            delete process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE;
            delete process.env.CCC_REAL_TART_SOURCE_IMAGE;
            writeFileSync(tart, "#!/bin/sh\nprintf 'Name Source State\\nlocal-base local stopped\\n'\n");
            chmodSync(tart, 0o700);

            expect(sourceImage(tart)).toEqual(expect.objectContaining({
                source: "local-base",
                auto: true,
            }));

            process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE = "  ";
            expect(sourceImage(tart)).toEqual(expect.objectContaining({
                source: "local-base",
                auto: true,
            }));

            process.env.CCC_REAL_TART_SOURCE_IMAGE = "compat-base";
            expect(sourceImage(tart)).toEqual({
                source: "compat-base",
                auto: false,
                candidates: [],
            });
        } finally {
            if (previousSource === undefined) delete process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE;
            else process.env.CCC_REAL_MACOS_VM_SOURCE_IMAGE = previousSource;
            if (previousCompatSource === undefined) delete process.env.CCC_REAL_TART_SOURCE_IMAGE;
            else process.env.CCC_REAL_TART_SOURCE_IMAGE = previousCompatSource;
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("uses the project name as the default SSH user and generates an owner-scoped key", () => {
        const previousHome = process.env.HOME;
        const previousPath = process.env.PATH;
        const previousUser = process.env.CCC_REAL_MACOS_VM_SSH_USER;
        const previousKey = process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH;
        const previousCompatKey = process.env.CCC_REAL_TART_SSH_KEY_PATH;
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-macos-e2e-home-"));
        const binDir = mkdtempSync(join(tmpdir(), "ccc-macos-e2e-bin-"));
        const sshKeygen = join(binDir, "ssh-keygen");
        try {
            writeFileSync(sshKeygen, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ]; then shift; key="$1"; fi
  shift
done
printf 'private-key' > "$key"
printf 'public-key' > "$key.pub"
exit 0
`);
            chmodSync(sshKeygen, 0o700);
            process.env.HOME = homeDir;
            process.env.PATH = binDir;
            delete process.env.CCC_REAL_MACOS_VM_SSH_USER;
            delete process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH;
            delete process.env.CCC_REAL_TART_SSH_KEY_PATH;

            const ssh = sshConfig();

            expect(ssh).toEqual(expect.objectContaining({
                available: true,
                sshUser: "claudecodecontainer",
                generatedSshKey: true,
            }));
            expect(ssh.sshKeyPath).toContain(join(".ccc", "devices", "real-tests", "macos-vm-ssh", "id_ed25519"));
            expect(readFileSync(ssh.sshKeyPath, "utf-8")).toBe("private-key");
            expect(readFileSync(`${ssh.sshKeyPath}.pub`, "utf-8")).toBe("public-key");
        } finally {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            if (previousUser === undefined) delete process.env.CCC_REAL_MACOS_VM_SSH_USER;
            else process.env.CCC_REAL_MACOS_VM_SSH_USER = previousUser;
            if (previousKey === undefined) delete process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH;
            else process.env.CCC_REAL_MACOS_VM_SSH_KEY_PATH = previousKey;
            if (previousCompatKey === undefined) delete process.env.CCC_REAL_TART_SSH_KEY_PATH;
            else process.env.CCC_REAL_TART_SSH_KEY_PATH = previousCompatKey;
            rmSync(homeDir, { recursive: true, force: true });
            rmSync(binDir, { recursive: true, force: true });
        }
    });
});

describe.runIf(level >= 2)("level 2 real macOS VM Tart E2E", () => {
    it.skipIf(!cap.available || destructiveMacosE2EWillRun)(
        destructiveMacosE2EWillRun
            ? `skips duplicate macOS VM Tart E2E because level 3 snapshot E2E covers lifecycle (${cap.source})`
            : title,
        async () => {
            const result = await runMacosVmE2E({ level });
            console.info(`[macOS VM E2E] ${result.detail}`);
            expect(result).toEqual(expect.objectContaining({
                status: "PASS",
                provider: "tart",
                source: cap.source,
                deviceId: expect.stringContaining("macos-level"),
                providerInstance: expect.stringContaining("macos-level"),
                boot: expect.objectContaining({
                    ready: expect.any(Boolean),
                }),
                guest: expect.objectContaining({
                    exercised: expect.any(Boolean),
                }),
                timings: expect.objectContaining({
                    createMs: expect.any(Number),
                    startMs: expect.any(Number),
                    stopMs: expect.any(Number),
                    deleteMs: expect.any(Number),
                }),
            }));
        },
        1200000,
    );
});
