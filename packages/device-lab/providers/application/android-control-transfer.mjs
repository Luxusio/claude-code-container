import { androidActionPlan, androidOrientationPlan } from "../domain/android-control-transfer.mjs";
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
                const command = ports.upload(target, stage.stagedPath, remote.path, 300_000);
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
                const command = ports.download(target, remote.path, stage.stagedPath, 300_000);
                if (command.status !== 0) return { kind: "command-failure", command };
                const committed = ports.commitOutput(stage.handle);
                if (!committed.ok) return { kind: "text", message: committed.message };
                return { kind: "json", payload: { downloaded: { remotePath: remote.path, localPath: committed.path },
                    provider: "adb", stdout: command.stdout, stderr: command.stderr, status: command.status } };
            } finally {
                ports.disposeOutput(stage.handle);
            }
        }

        if (operation === "mobile_set_orientation" || operation === "mobile_rotate_left" || operation === "mobile_rotate_right") {
            const plan = androidOrientationPlan(operation, input);
            if (!plan.ok) return { kind: "text", message: plan.message };
            const first = ports.disableAutoRotation(target);
            if (first.status !== 0) return { kind: "command-failure", command: first };
            const second = ports.setRotation(target, plan.rotation);
            return second.status === 0
                ? { kind: "json", payload: { ...plan.payload, stdout: second.stdout, stderr: second.stderr, status: second.status } }
                : { kind: "command-failure", command: second };
        }

        const plan = androidActionPlan(operation, input, ports.variant);
        if (!plan) return undefined;
        if (!plan.ok) return { kind: "text", message: plan.message };
        const first = perform(target, plan.intent);
        if (first.status !== 0) return { kind: "command-failure", command: first };
        if (plan.doubleTap) {
            const second = perform(target, plan.intent);
            return second.status === 0
                ? { kind: "json", payload: plan.payload }
                : { kind: "command-failure", command: second };
        }
        return { kind: "json", payload: { ...plan.payload, stdout: first.stdout, stderr: first.stderr, status: first.status } };
    }
    /** @param {Target} target @param {import('../domain/android-control-transfer.mjs').Intent} intent */
    function perform(target, intent) {
        switch (intent.kind) {
            case "tap": return ports.tap(target, intent.point);
            case "swipe": return ports.swipe(target, intent.swipe);
            case "text": return ports.typeText(target, intent.text);
            case "key": return ports.key(target, intent.key);
        }
    }
    return { request };
}
