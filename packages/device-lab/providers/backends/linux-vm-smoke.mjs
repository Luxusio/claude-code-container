import { spawn } from "child_process";
import { waitForProcessIdentity, terminateOwnedRuntimeProcess } from "../state/process-identity.mjs";
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

/** @param {string} command @param {string[]} args @param {import('../state/process-identity.mjs').RuntimeProcessRecord|null} runtime */
function defaultCommandRunner(command, args, runtime) {
    if (basename(command) === "qemu-img" && args[0] === "create") {
        writeFileSync(args[args.length - 1], "fake-overlay");
        return { ok: true, command, args };
    }
    return runtime
        ? { ok: true, command, args, pid: runtime.pid, processIdentity: runtime.processIdentity }
        : { ok: false, error: "fake-provider-runtime-unavailable" };
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
    /** @type {import('child_process').ChildProcess|null} */
    let child = null;
    /** @type {Promise<unknown>|null} */
    let closed = null;
    /** @type {import('../state/process-identity.mjs').RuntimeProcessRecord|null} */
    let runtime = null;
    /** @type {Error|null} */
    let childError = null;
    /** @type {{ok:boolean;steps:Array<{name:string,status:string,error?:string,result?:unknown}>;error?:string}|undefined} */
    let report;
    const baseOptions = {
        env,
        stateRoot,
        qemuPath: "/usr/bin/qemu-system-x86_64",
        qemuImgPath: "/usr/bin/qemu-img",
        kvmAvailable: true,
        commandRunner: options.commandRunner || ((command, args) => defaultCommandRunner(command, args, runtime)),
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
        const created = step("lab-create", () => assertOk("lab-create", createLab({
            name: "Smoke VM",
            baseImageId: "smoke-base",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2222,
            guestSshUser: "ccc",
            guestSshKeyPath: sshKeyPath,
        }, baseOptions)));
        const labId = created.lab.id;
        step("disk-materialize", () => assertOk("disk-materialize", materializeDisk({ labId }, baseOptions)));
        if (!options.commandRunner) {
            const ownedChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
            child = ownedChild;
            closed = new Promise((resolve) => { ownedChild.once("close", resolve);ownedChild.once("error", (error) => { childError = error; }); });
            const identity = await waitForProcessIdentity(ownedChild.pid, 2000);
            if (identity && identity.pid === ownedChild.pid && !childError) runtime = { runtimeId: "owned-smoke-child", pid: identity.pid, processIdentity: identity };
        }
        step("lab-start", () => {
            if (childError) throw childError;
            return assertOk("lab-start", startLab({ labId }, baseOptions));
        });
        step("readiness-probe", () => assertOk("readiness-probe", probeReadiness({ labId }, baseOptions)));
        step("guest-push", () => assertOk("guest-push", guestPush({
            labId,
            sourcePath: workspace,
            guestPath: "/workspace/smoke",
        }, baseOptions)));
        step("guest-pull", () => assertOk("guest-pull", guestPull({
            labId,
            guestPath: "/artifacts/smoke",
            destinationPath: "smoke-pull",
        }, baseOptions)));
        step("guest-exec", () => assertOk("guest-exec", guestExec({
            labId,
            command: "true",
        }, baseOptions)));
        step("lab-stop", () => assertOk("lab-stop", stopLab({
            labId,
            force: true,
        }, baseOptions)));
        step("snapshot-create", () => assertOk("snapshot-create", snapshotLab("create", {
            labId,
            snapshotName: "smoke",
        }, baseOptions)));
        step("lab-delete", () => assertOk("lab-delete", deleteLab({ labId }, baseOptions)));

        report = { ok: true, steps };
    } catch (error) {
        report = { ok: false, steps, error: error?.message || String(error) };
    } finally {
        let joined = !child;
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        let timer;
        try {
            if (child) {
                let terminationError;
                try {
                    if (child.exitCode === null && child.signalCode === null) {
                        if (runtime) {
                            const stopped = await terminateOwnedRuntimeProcess(runtime, "Fake-provider smoke", { timeoutMs: 1000 });
                            if (!stopped.exited) terminationError = new Error(stopped.error || "fake-provider child exit unconfirmed");
                        } else {
                            // Birth acquisition failed: close only the child handle created here.
                            child.kill("SIGKILL");
                        }
                    }
                } catch (error) { terminationError = error; }
                await Promise.race([closed, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("fake-provider child join timed out")), 2000); })]);
                joined = true;
                if (terminationError) throw terminationError;
            }
        } catch (error) {
            report = { ...report, ok: false, error: report?.error || error?.message || String(error) };
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (options.cleanup !== false && joined) {
            rmSync(stateRoot, { recursive: true, force: true });
            rmSync(workspace, { recursive: true, force: true });
        }
    }
    return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const report = await runLabMcpSmoke();
    console.log(formatLabMcpSmokeReport(report));
    process.exit(report.ok ? 0 : 1);
}
