import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
    buildDockerRunArgs,
    type DockerRunArgsOptions,
} from "../docker.js";

// Factory for default options — every test overrides only what it needs
function makeOpts(
    overrides: Partial<DockerRunArgsOptions> = {},
): DockerRunArgsOptions {
    return {
        containerName: "ccc-myproject-abc123",
        fullPath: "/home/user/myproject",
        projectMountPath: "/project/myproject-abc123",
        credentialMounts: [
            { hostPath: "/home/user/.ccc/claude", containerPath: "/home/ccc/.claude" },
            { hostPath: "/home/user/.claude/ide", containerPath: "/home/ccc/.claude/ide" },
        ],
        claudeJsonFile: "/home/user/.ccc/claude.json",
        miseVolumeName: "ccc-mise-cache",
        pidsLimit: "-1",
        imageName: "ccc",
        hostSshDir: null,
        sshAgentSocket: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Helper: extract all volume mount strings from args
// docker run ... -v <mount> ... → collects every <mount> after "-v"
// ---------------------------------------------------------------------------
function extractVolumeMounts(args: string[]): string[] {
    const mounts: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "-v" && i + 1 < args.length) {
            mounts.push(args[i + 1]);
        }
    }
    return mounts;
}

// ---------------------------------------------------------------------------
// Helper: extract all environment variables from args
// docker run ... -e <KEY=VALUE> ... → collects every value after "-e"
// ---------------------------------------------------------------------------
function extractEnvVars(args: string[]): Record<string, string> {
    const envs: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "-e" && i + 1 < args.length) {
            const eqIdx = args[i + 1].indexOf("=");
            if (eqIdx > 0) {
                envs[args[i + 1].slice(0, eqIdx)] = args[i + 1].slice(
                    eqIdx + 1,
                );
            }
        }
    }
    return envs;
}

// ---------------------------------------------------------------------------
// Helper: extract all container labels from args
// docker run ... --label <KEY=VALUE> ... → collects every value after "--label"
// ---------------------------------------------------------------------------
function extractLabels(args: string[]): Record<string, string> {
    const labels: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--label" && i + 1 < args.length) {
            const eqIdx = args[i + 1].indexOf("=");
            if (eqIdx > 0) {
                labels[args[i + 1].slice(0, eqIdx)] = args[i + 1].slice(eqIdx + 1);
            }
        }
    }
    return labels;
}

// ===========================================================================
// 1. SSH mount — core feature tests
// ===========================================================================
describe("buildDockerRunArgs — SSH mount", () => {
    it("includes SSH mount when hostSshDir is provided", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh" }),
        );
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain("/home/user/.ssh:/home/ccc/.ssh:ro");
    });

    it("omits SSH mount when hostSshDir is null", () => {
        const args = buildDockerRunArgs(makeOpts({ hostSshDir: null }));
        const mounts = extractVolumeMounts(args);
        const sshMount = mounts.find((m) => m.includes(".ssh"));
        expect(sshMount).toBeUndefined();
    });

    it("mounts SSH as read-only (:ro)", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh" }),
        );
        const mounts = extractVolumeMounts(args);
        const sshMount = mounts.find((m) => m.includes(".ssh"));
        expect(sshMount).toBeDefined();
        expect(sshMount!.endsWith(":ro")).toBe(true);
    });

    it("maps host SSH dir to /home/ccc/.ssh in container", () => {
        const hostPath = "/Users/dev/.ssh";
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: hostPath }),
        );
        const mounts = extractVolumeMounts(args);
        const sshMount = mounts.find((m) => m.includes(".ssh"));
        expect(sshMount).toBe(`${hostPath}:/home/ccc/.ssh:ro`);
    });

    it("SSH mount appears before image name (last arg)", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh" }),
        );
        const sshIdx = args.indexOf("/home/user/.ssh:/home/ccc/.ssh:ro");
        const imageIdx = args.lastIndexOf("ccc");
        // -v flag is one before the mount string
        expect(sshIdx).toBeGreaterThan(0);
        expect(sshIdx).toBeLessThan(imageIdx);
    });

    it("handles SSH paths with spaces", () => {
        const hostPath = "/Users/my user/.ssh";
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: hostPath }),
        );
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain(`${hostPath}:/home/ccc/.ssh:ro`);
    });
});

// ===========================================================================
// 1b. SSH GIT_SSH_COMMAND — environment variable for SSH key resolution
// ===========================================================================
describe("buildDockerRunArgs — GIT_SSH_COMMAND", () => {
    it("sets GIT_SSH_COMMAND when SSH dir is provided", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh" }),
        );
        const envs = extractEnvVars(args);
        expect(envs.GIT_SSH_COMMAND).toBeDefined();
    });

    it("does not set GIT_SSH_COMMAND when SSH dir is null", () => {
        const args = buildDockerRunArgs(makeOpts({ hostSshDir: null }));
        const envs = extractEnvVars(args);
        expect(envs.GIT_SSH_COMMAND).toBeUndefined();
    });

    it("uses StrictHostKeyChecking=accept-new", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh" }),
        );
        const envs = extractEnvVars(args);
        expect(envs.GIT_SSH_COMMAND).toContain(
            "StrictHostKeyChecking=accept-new",
        );
    });

    it("uses /tmp/.ssh-copy/known_hosts as UserKnownHostsFile", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh" }),
        );
        const envs = extractEnvVars(args);
        expect(envs.GIT_SSH_COMMAND).toContain(
            "UserKnownHostsFile=/tmp/.ssh-copy/known_hosts",
        );
    });

    it("references /tmp/.ssh-copy identity files for UID mismatch fix", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh" }),
        );
        const envs = extractEnvVars(args);
        expect(envs.GIT_SSH_COMMAND).toContain(
            "IdentityFile=/tmp/.ssh-copy/id_rsa",
        );
        expect(envs.GIT_SSH_COMMAND).toContain(
            "IdentityFile=/tmp/.ssh-copy/id_ed25519",
        );
    });

    it("GIT_SSH_COMMAND env appears before image name", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh" }),
        );
        const envIdx = args.findIndex(
            (a) => a.startsWith("GIT_SSH_COMMAND="),
        );
        const imageIdx = args.lastIndexOf("ccc");
        expect(envIdx).toBeGreaterThan(0);
        expect(envIdx).toBeLessThan(imageIdx);
    });
});

// ===========================================================================
// 1c. SSH Agent socket — forwarding tests
// ===========================================================================
describe("buildDockerRunArgs — SSH agent socket", () => {
    it("mounts agent socket when sshAgentSocket is provided", () => {
        const args = buildDockerRunArgs(
            makeOpts({ sshAgentSocket: "/tmp/ssh-XXXX/agent.1234" }),
        );
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain(
            "/tmp/ssh-XXXX/agent.1234:/tmp/ssh-agent.sock",
        );
    });

    it("omits agent socket when sshAgentSocket is null", () => {
        const args = buildDockerRunArgs(makeOpts({ sshAgentSocket: null }));
        const mounts = extractVolumeMounts(args);
        const agentMount = mounts.find((m) => m.includes("ssh-agent.sock"));
        expect(agentMount).toBeUndefined();
    });

    it("sets SSH_AUTH_SOCK env to /tmp/ssh-agent.sock", () => {
        const args = buildDockerRunArgs(
            makeOpts({ sshAgentSocket: "/tmp/ssh-XXXX/agent.1234" }),
        );
        const envs = extractEnvVars(args);
        expect(envs.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    });

    it("does not set SSH_AUTH_SOCK when no agent socket", () => {
        const args = buildDockerRunArgs(makeOpts({ sshAgentSocket: null }));
        const envs = extractEnvVars(args);
        expect(envs.SSH_AUTH_SOCK).toBeUndefined();
    });

    it("works with macOS Docker Desktop socket path", () => {
        const args = buildDockerRunArgs(
            makeOpts({
                sshAgentSocket: "/run/host-services/ssh-auth.sock",
            }),
        );
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain(
            "/run/host-services/ssh-auth.sock:/tmp/ssh-agent.sock",
        );
        const envs = extractEnvVars(args);
        expect(envs.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
    });

    it("can coexist with SSH key mount", () => {
        const args = buildDockerRunArgs(
            makeOpts({
                hostSshDir: "/home/user/.ssh",
                sshAgentSocket: "/tmp/ssh-XXXX/agent.1234",
            }),
        );
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain("/home/user/.ssh:/home/ccc/.ssh:ro");
        expect(mounts).toContain(
            "/tmp/ssh-XXXX/agent.1234:/tmp/ssh-agent.sock",
        );
        const envs = extractEnvVars(args);
        expect(envs.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
        expect(envs.GIT_SSH_COMMAND).toBeDefined();
    });

    it("agent socket mount appears before image name", () => {
        const args = buildDockerRunArgs(
            makeOpts({ sshAgentSocket: "/tmp/ssh-XXXX/agent.1234" }),
        );
        const mountIdx = args.indexOf(
            "/tmp/ssh-XXXX/agent.1234:/tmp/ssh-agent.sock",
        );
        const imageIdx = args.lastIndexOf("ccc");
        expect(mountIdx).toBeGreaterThan(0);
        expect(mountIdx).toBeLessThan(imageIdx);
    });
});

// ===========================================================================
// 2. Structural integrity — args format
// ===========================================================================
describe("buildDockerRunArgs — structure", () => {
    it("starts with 'run' and '-d'", () => {
        const args = buildDockerRunArgs(makeOpts());
        expect(args[0]).toBe("run");
        expect(args[1]).toBe("-d");
    });

    it("image name is always the last argument", () => {
        // Without SSH
        const args1 = buildDockerRunArgs(makeOpts());
        expect(args1[args1.length - 1]).toBe("ccc");

        // With SSH
        const args2 = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh" }),
        );
        expect(args2[args2.length - 1]).toBe("ccc");
    });

    it("contains --name with container name", () => {
        const args = buildDockerRunArgs(
            makeOpts({ containerName: "ccc-test-123456789012" }),
        );
        const nameIdx = args.indexOf("--name");
        expect(nameIdx).not.toBe(-1);
        expect(args[nameIdx + 1]).toBe("ccc-test-123456789012");
    });

    it("contains --network host", () => {
        const args = buildDockerRunArgs(makeOpts());
        const netIdx = args.indexOf("--network");
        expect(netIdx).not.toBe(-1);
        expect(args[netIdx + 1]).toBe("host");
    });

    it("contains --security-opt seccomp=unconfined", () => {
        const args = buildDockerRunArgs(makeOpts());
        const secIdx = args.indexOf("--security-opt");
        expect(secIdx).not.toBe(-1);
        expect(args[secIdx + 1]).toBe("seccomp=unconfined");
    });

    it("sets working directory with -w", () => {
        const mountPath = "/project/test-abc123";
        const args = buildDockerRunArgs(
            makeOpts({ projectMountPath: mountPath }),
        );
        const wIdx = args.indexOf("-w");
        expect(wIdx).not.toBe(-1);
        expect(args[wIdx + 1]).toBe(mountPath);
    });

    it("sets --pids-limit", () => {
        const args = buildDockerRunArgs(makeOpts({ pidsLimit: "4096" }));
        const pidIdx = args.indexOf("--pids-limit");
        expect(pidIdx).not.toBe(-1);
        expect(args[pidIdx + 1]).toBe("4096");
    });
});

// ===========================================================================
// 3. Volume mounts — completeness
// ===========================================================================
describe("buildDockerRunArgs — volume mounts", () => {
    it("mounts project directory", () => {
        const args = buildDockerRunArgs(makeOpts());
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain(
            "/home/user/myproject:/project/myproject-abc123",
        );
    });

    it("mounts claude directory", () => {
        const args = buildDockerRunArgs(makeOpts());
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain(
            "/home/user/.ccc/claude:/home/ccc/.claude",
        );
    });

    it("mounts claude.json file", () => {
        const args = buildDockerRunArgs(makeOpts());
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain(
            "/home/user/.ccc/claude.json:/home/ccc/.claude.json",
        );
    });

    it("mounts IDE lock files directory", () => {
        const args = buildDockerRunArgs(makeOpts());
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain(
            "/home/user/.claude/ide:/home/ccc/.claude/ide",
        );
    });

    it("mounts mise cache as named volume", () => {
        const args = buildDockerRunArgs(makeOpts());
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain(
            "ccc-mise-cache:/home/ccc/.local/share/mise",
        );
    });

    it("mounts docker socket", () => {
        const args = buildDockerRunArgs(makeOpts());
        const mounts = extractVolumeMounts(args);
        expect(mounts).toContain(
            "/var/run/docker.sock:/var/run/docker.sock",
        );
    });

    it("has exactly 6 volume mounts without SSH", () => {
        const args = buildDockerRunArgs(makeOpts({ hostSshDir: null, sshAgentSocket: null }));
        const mounts = extractVolumeMounts(args);
        expect(mounts).toHaveLength(6);
    });

    it("has exactly 7 volume mounts with SSH keys only", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh", sshAgentSocket: null }),
        );
        const mounts = extractVolumeMounts(args);
        expect(mounts).toHaveLength(7);
    });

    it("has exactly 7 volume mounts with agent socket only", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: null, sshAgentSocket: "/tmp/agent.sock" }),
        );
        const mounts = extractVolumeMounts(args);
        expect(mounts).toHaveLength(7);
    });

    it("has exactly 8 volume mounts with both SSH keys and agent socket", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh", sshAgentSocket: "/tmp/agent.sock" }),
        );
        const mounts = extractVolumeMounts(args);
        expect(mounts).toHaveLength(8);
    });
});

// ===========================================================================
// 4. Idempotency & determinism
// ===========================================================================
describe("buildDockerRunArgs — determinism", () => {
    it("produces identical output for identical input", () => {
        const opts = makeOpts({ hostSshDir: "/home/user/.ssh" });
        const a = buildDockerRunArgs(opts);
        const b = buildDockerRunArgs(opts);
        expect(a).toEqual(b);
    });

    it("does not mutate the options object", () => {
        const opts = makeOpts({ hostSshDir: "/home/user/.ssh" });
        const frozen = JSON.parse(JSON.stringify(opts));
        buildDockerRunArgs(opts);
        expect(opts).toEqual(frozen);
    });
});

// ===========================================================================
// 5. Edge cases
// ===========================================================================
describe("buildDockerRunArgs — edge cases", () => {
    it("handles empty string hostSshDir as truthy (still mounts)", () => {
        // Empty string is falsy in JS, so it should NOT mount
        const args = buildDockerRunArgs(makeOpts({ hostSshDir: "" as any }));
        const mounts = extractVolumeMounts(args);
        const sshMount = mounts.find((m) => m.includes(".ssh"));
        expect(sshMount).toBeUndefined();
    });

    it("handles paths with trailing slash", () => {
        const args = buildDockerRunArgs(
            makeOpts({ hostSshDir: "/home/user/.ssh/" }),
        );
        const mounts = extractVolumeMounts(args);
        const sshMount = mounts.find((m) => m.includes(".ssh"));
        expect(sshMount).toBe("/home/user/.ssh/:/home/ccc/.ssh:ro");
    });

    it("uses custom image name", () => {
        const args = buildDockerRunArgs(
            makeOpts({ imageName: "ccc:custom" }),
        );
        expect(args[args.length - 1]).toBe("ccc:custom");
    });

    it("respects different pids-limit values", () => {
        const unlimited = buildDockerRunArgs(makeOpts({ pidsLimit: "-1" }));
        const limited = buildDockerRunArgs(makeOpts({ pidsLimit: "100" }));

        const getLimit = (args: string[]) =>
            args[args.indexOf("--pids-limit") + 1];

        expect(getLimit(unlimited)).toBe("-1");
        expect(getLimit(limited)).toBe("100");
    });

    it("includes extra mounts when provided", () => {
        const args = buildDockerRunArgs(
            makeOpts({
                extraMounts: [
                    { hostPath: "/host/.git", containerPath: "/host/.git" },
                    { hostPath: "/host/.git", containerPath: "/project/source/.git" },
                ],
            }),
        );
        const mounts = extractVolumeMounts(args);

        expect(mounts).toContain("/host/.git:/host/.git");
        expect(mounts).toContain("/host/.git:/project/source/.git");
    });

    it("does not include extra mounts when not provided", () => {
        const withMounts = buildDockerRunArgs(
            makeOpts({
                extraMounts: [
                    { hostPath: "/host/.git", containerPath: "/host/.git" },
                ],
            }),
        );
        const withoutMounts = buildDockerRunArgs(makeOpts());

        expect(extractVolumeMounts(withMounts).length).toBe(
            extractVolumeMounts(withoutMounts).length + 1,
        );
    });
});

// ===========================================================================
// 6. Clipboard port file mount
// ===========================================================================
describe("buildDockerRunArgs — clipboard port file", () => {
    let tmpDir: string;
    let portFile: string;

    // Create a real temp file (existsSync must return true for mount to appear)
    function setup(): void {
        tmpDir = join(tmpdir(), `ccc-test-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });
        portFile = join(tmpDir, "clipboard.port");
        writeFileSync(portFile, "12345:supersecrettoken");
    }

    function teardown(): void {
        try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }

    it("mounts clipboard port file when file exists", () => {
        setup();
        try {
            const args = buildDockerRunArgs(makeOpts({ clipboardPortFile: portFile }));
            const mounts = extractVolumeMounts(args);
            expect(mounts).toContain(`${portFile}:/run/ccc/clipboard.port:ro`);
        } finally { teardown(); }
    });

    it("mounts clipboard port file read-only", () => {
        setup();
        try {
            const args = buildDockerRunArgs(makeOpts({ clipboardPortFile: portFile }));
            const mounts = extractVolumeMounts(args);
            const clipMount = mounts.find((m) => m.includes("clipboard.port"));
            expect(clipMount).toBeDefined();
            expect(clipMount!.endsWith(":ro")).toBe(true);
        } finally { teardown(); }
    });

    it("mounts clipboard port file to /run/ccc/clipboard.port in container", () => {
        setup();
        try {
            const args = buildDockerRunArgs(makeOpts({ clipboardPortFile: portFile }));
            const mounts = extractVolumeMounts(args);
            const clipMount = mounts.find((m) => m.includes("clipboard.port"));
            // mount format: hostPath:/run/ccc/clipboard.port:ro
            const parts = clipMount!.split(":");
            expect(parts[1]).toBe("/run/ccc/clipboard.port");
        } finally { teardown(); }
    });

    it("omits clipboard mount when clipboardPortFile is undefined", () => {
        const args = buildDockerRunArgs(makeOpts({ clipboardPortFile: undefined }));
        const mounts = extractVolumeMounts(args);
        const clipMount = mounts.find((m) => m.includes("clipboard.port"));
        expect(clipMount).toBeUndefined();
    });

    it("omits clipboard mount when file does not exist on disk", () => {
        const nonExistent = join(tmpdir(), "ccc-no-such-file.port");
        const args = buildDockerRunArgs(makeOpts({ clipboardPortFile: nonExistent }));
        const mounts = extractVolumeMounts(args);
        const clipMount = mounts.find((m) => m.includes("clipboard.port"));
        expect(clipMount).toBeUndefined();
    });

    it("adds exactly 1 extra mount when clipboard port file exists", () => {
        setup();
        try {
            const without = buildDockerRunArgs(makeOpts());
            const with_ = buildDockerRunArgs(makeOpts({ clipboardPortFile: portFile }));
            expect(extractVolumeMounts(with_).length).toBe(
                extractVolumeMounts(without).length + 1,
            );
        } finally { teardown(); }
    });

    it("clipboard mount appears before image name", () => {
        setup();
        try {
            const args = buildDockerRunArgs(makeOpts({ clipboardPortFile: portFile }));
            const mountIdx = args.indexOf(`${portFile}:/run/ccc/clipboard.port:ro`);
            const imageIdx = args.lastIndexOf("ccc");
            expect(mountIdx).toBeGreaterThan(0);
            expect(mountIdx).toBeLessThan(imageIdx);
        } finally { teardown(); }
    });
});

// ===========================================================================
// 7. Container labels (Docker Compose grouping)
// ===========================================================================
describe("buildDockerRunArgs — container labels", () => {
    it("includes Docker Compose grouping labels", () => {
        const args = buildDockerRunArgs(makeOpts());
        const labels = extractLabels(args);
        expect(labels["com.docker.compose.project"]).toBe("ccc");
        expect(labels["com.docker.compose.service"]).toBe("ccc-myproject-abc123");
        expect(labels["com.docker.compose.oneoff"]).toBe("False");
        expect(labels["com.docker.compose.version"]).toBe("2");
        expect(labels["com.docker.compose.container-number"]).toBe("1");
    });

    it("includes ccc metadata labels", () => {
        const args = buildDockerRunArgs(makeOpts());
        const labels = extractLabels(args);
        expect(labels["ccc.managed"]).toBe("true");
        expect(labels["ccc.project.path"]).toBe("/home/user/myproject");
        expect(labels["ccc.cli.version"]).toBeDefined();
    });

    it("sets com.docker.compose.service to the container name", () => {
        const args = buildDockerRunArgs(makeOpts({ containerName: "ccc-other-xyz999" }));
        const labels = extractLabels(args);
        expect(labels["com.docker.compose.service"]).toBe("ccc-other-xyz999");
    });

    it("sets ccc.project.path to fullPath", () => {
        const args = buildDockerRunArgs(makeOpts({ fullPath: "/custom/path/project" }));
        const labels = extractLabels(args);
        expect(labels["ccc.project.path"]).toBe("/custom/path/project");
    });

    it("image name is still the last argument after labels", () => {
        const args = buildDockerRunArgs(makeOpts({ imageName: "ccc" }));
        expect(args[args.length - 1]).toBe("ccc");
    });
});
