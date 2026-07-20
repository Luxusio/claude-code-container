import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import {
    createLab,
    deleteLab,
    guestExec,
    guestPull,
    guestPush,
    importImage,
    labProviderStatus,
    materializeDisk,
    ownerId,
    probeReadiness,
    snapshotLab,
    startLab,
    stopLab,
} from "./linux-vm.mjs";

function defaultCommandRunner(command, args) {
    if (basename(command) === "qemu-img" && args[0] === "create") {
        writeFileSync(args[args.length - 1], "fake-overlay");
        return { ok: true, command, args };
    }
    return { ok: true, command, args, pid: 424242 };
}

function defaultGuestTransportRunner(transport) {
    if (transport.action === "pull") {
        mkdirSync(join(transport.destinationPath, "logs"), { recursive: true });
        writeFileSync(join(transport.destinationPath, "logs", "smoke.txt"), "ok");
    }
    return { ok: true, action: transport.action };
}

function defaultSshCommandRunner(command, args) {
    return { ok: true, status: 0, stdout: "ok", stderr: "", command, args };
}

function assertOk(name, result) {
    if (!result?.ok) {
        const error = new Error(`${name} failed`);
        error.result = result;
        throw error;
    }
    return result;
}

export function formatLabMcpSmokeReport(report) {
    const lines = [
        "=== Lab MCP Provider Smoke ===",
        "",
        "mode: fake-provider; no real VM, KVM, SSH, or host virtualization tools are started",
    ];
    for (const step of report.steps) {
        lines.push(`${step.name}: ${step.status}${step.error ? ` - ${step.error}` : ""}`);
    }
    lines.push(`result: ${report.ok ? "PASS" : "FAIL"}`);
    lines.push("");
    return lines.join("\n");
}

export async function runLabMcpSmoke(options = {}) {
    const stateRoot = mkdtempSync(join(tmpdir(), "ccc-lab-mcp-smoke-"));
    const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-mcp-smoke-workspace-"));
    const env = {
        CCC_PROFILE: "lab-mcp-smoke",
        CCC_LAB_RUNNER: "1",
        CCC_LAB_RUNNER_STATUS: "ready",
    };
    const baseOptions = {
        env,
        stateRoot,
        qemuPath: "/usr/bin/qemu-system-x86_64",
        qemuImgPath: "/usr/bin/qemu-img",
        kvmAvailable: true,
        commandRunner: options.commandRunner || defaultCommandRunner,
        guestTransportRunner: options.guestTransportRunner || defaultGuestTransportRunner,
        sshPath: "/usr/bin/ssh",
        scpPath: "/usr/bin/scp",
        sshCommandRunner: options.sshCommandRunner || defaultSshCommandRunner,
        processExists: options.processExists || (() => true),
        allowedWorkspaceRoots: [workspace],
    };
    const steps = [];
    const step = (name, fn) => {
        try {
            const result = fn();
            steps.push({ name, status: "PASS" });
            return result;
        } catch (error) {
            steps.push({
                name,
                status: "FAIL",
                error: error?.message || String(error),
                result: error?.result,
            });
            throw error;
        }
    };

    try {
        mkdirSync(join(stateRoot, "images"), { recursive: true });
        writeFileSync(join(stateRoot, "images", "base.qcow2"), "base");
        writeFileSync(join(workspace, "README.md"), "smoke");
        const ownerRoot = join(stateRoot, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const sshKeyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(sshKeyPath, "fake-key");

        step("provider-status", () => {
            const status = labProviderStatus(baseOptions);
            if (!status.available) throw Object.assign(new Error("provider unavailable"), { result: status });
            return status;
        });
        step("image-import", () => assertOk("image-import", importImage({
            name: "Smoke Base",
            imageId: "smoke-base",
            sourcePath: "images/base.qcow2",
            copy: false,
        }, baseOptions)));
        step("lab-create", () => assertOk("lab-create", createLab({
            name: "Smoke VM",
            labId: "smoke-vm",
            baseImageId: "smoke-base",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2222,
            guestSshUser: "ccc",
            guestSshKeyPath: sshKeyPath,
        }, baseOptions)));
        step("disk-materialize", () => assertOk("disk-materialize", materializeDisk({ labId: "smoke-vm" }, baseOptions)));
        step("lab-start", () => assertOk("lab-start", startLab({ labId: "smoke-vm" }, baseOptions)));
        step("readiness-probe", () => assertOk("readiness-probe", probeReadiness({ labId: "smoke-vm" }, baseOptions)));
        step("guest-push", () => assertOk("guest-push", guestPush({
            labId: "smoke-vm",
            sourcePath: workspace,
            guestPath: "/workspace/smoke",
        }, baseOptions)));
        step("guest-pull", () => assertOk("guest-pull", guestPull({
            labId: "smoke-vm",
            guestPath: "/artifacts/smoke",
            destinationPath: "smoke-pull",
        }, baseOptions)));
        step("guest-exec", () => assertOk("guest-exec", guestExec({
            labId: "smoke-vm",
            command: "true",
        }, baseOptions)));
        step("lab-stop", () => assertOk("lab-stop", stopLab({
            labId: "smoke-vm",
            force: true,
        }, { ...baseOptions, killProcess: () => {} })));
        step("snapshot-create", () => assertOk("snapshot-create", snapshotLab("create", {
            labId: "smoke-vm",
            snapshotName: "smoke",
        }, baseOptions)));
        step("lab-delete", () => assertOk("lab-delete", deleteLab({ labId: "smoke-vm" }, baseOptions)));

        return { ok: true, steps };
    } catch (error) {
        return { ok: false, steps, error: error?.message || String(error) };
    } finally {
        if (options.cleanup !== false) {
            rmSync(stateRoot, { recursive: true, force: true });
            rmSync(workspace, { recursive: true, force: true });
        }
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const report = await runLabMcpSmoke();
    console.log(formatLabMcpSmokeReport(report));
    process.exit(report.ok ? 0 : 1);
}
