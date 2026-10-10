import { androidActionPlan } from "../domain/android-control-transfer.mjs";
/** @typedef {import('../ports/android-control-transfer.mjs').AndroidControlOperation} Operation */
/** @typedef {import('../ports/android-control-transfer.mjs').AndroidControlArguments} Arguments */
/** @typedef {import('../ports/android-control-transfer.mjs').AndroidControlOutcome} Outcome */

/** @template Target, InputStage, OutputStage
 * @param {import('../ports/android-control-transfer.mjs').AndroidControlTransferPorts<Target,InputStage,OutputStage>} ports */
export function createAndroidControlTransfer(ports) {
    /** @param {Operation} operation @param {Arguments} input @returns {Outcome | undefined} */
    function request(operation, input) {
        const observation = ports.target(input.deviceId);
        if (observation.kind === "unknown") return undefined;
        if (observation.kind === "refused") return { kind: "text", message: observation.message };
        const target = observation.target;

        if (operation === "device_upload") {
            const remote = ports.guestPath(input.remotePath, "upload-remote-path");
            if (!remote.ok) return { kind: "text", message: remote.message };
            const stage = ports.stageInput(input.localPath);
            if (!stage.ok) return { kind: "text", message: stage.message };
            try {
                const command = ports.transfer(target, ["push", stage.stagedPath, remote.path], 300_000);
                return command.status === 0
                    ? { kind: "json", payload: { uploaded: { localPath: stage.path, remotePath: remote.path },
                        provider: "adb", stdout: command.stdout, stderr: command.stderr, status: command.status } }
                    : { kind: "command-failure", command };
            } finally {
                ports.disposeInput(stage.handle);
            }
        }
        if (operation === "device_download") {
            const remote = ports.guestPath(input.remotePath, "download-remote-path");
            if (!remote.ok) return { kind: "text", message: remote.message };
            const stage = ports.stageOutput(input.localPath);
            if (!stage.ok) return { kind: "text", message: stage.message };
            try {
                const command = ports.transfer(target, ["pull", remote.path, stage.stagedPath], 300_000);
                if (command.status !== 0) return { kind: "command-failure", command };
                const committed = ports.commitOutput(stage.handle);
                if (!committed.ok) return { kind: "text", message: committed.message };
                return { kind: "json", payload: { downloaded: { remotePath: remote.path, localPath: committed.path },
                    provider: "adb", stdout: command.stdout, stderr: command.stderr, status: command.status } };
            } finally {
                ports.disposeOutput(stage.handle);
            }
        }

        const plan = androidActionPlan(operation, input, ports.variant);
        if (!plan) return undefined;
        if (!plan.ok) return { kind: "text", message: plan.message };
        const first = ports.execute(target, plan.args);
        if (first.status !== 0) return { kind: "command-failure", command: first };
        if (plan.doubleTap) {
            const second = ports.execute(target, plan.args);
            return second.status === 0
                ? { kind: "json", payload: plan.payload }
                : { kind: "command-failure", command: second };
        }
        return { kind: "json", payload: { ...plan.payload, stdout: first.stdout, stderr: first.stderr, status: first.status } };
    }
    return { request };
}
