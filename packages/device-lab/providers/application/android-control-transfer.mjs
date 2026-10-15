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
                return command.ok
                    ? { kind: 'completed', completion: {kind:'uploaded',localPath:stage.path,remotePath:remote.path}, evidence:command.evidence }
                    : { kind: "command-failure", evidence:command.evidence };
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
                if (!command.ok) return { kind: "command-failure", evidence:command.evidence };
                const committed = ports.commitOutput(stage.handle);
                if (!committed.ok) return { kind: "text", message: committed.message };
                return { kind: 'completed', completion: {kind:'downloaded',remotePath:remote.path,localPath:committed.path}, evidence:command.evidence };
            } finally {
                ports.disposeOutput(stage.handle);
            }
        }

        if (operation === "mobile_set_orientation" || operation === "mobile_rotate_left" || operation === "mobile_rotate_right") {
            const plan = androidOrientationPlan(operation, input);
            if (!plan.ok) return { kind: "text", message: plan.message };
            const first = ports.disableAutoRotation(target);
            if (!first.ok) return { kind: "command-failure", evidence:first.evidence };
            const second = ports.setOrientation(target, plan.orientation);
            return second.ok
                ? { kind: 'completed', completion: {kind:'oriented',orientation:plan.orientation}, evidence:second.evidence }
                : { kind: "command-failure", evidence:second.evidence };
        }

        const plan = androidActionPlan(operation, input);
        if (!plan) return undefined;
        if (!plan.ok) return { kind: "text", message: plan.message };
        const first = perform(target, plan.intent);
        if (!first.ok) return { kind: "command-failure", evidence:first.evidence };
        if (plan.doubleTap) {
            const second = perform(target, plan.intent);
            return second.ok
                ? { kind: 'completed', completion:plan.completion, evidence:second.evidence }
                : { kind: "command-failure", evidence:second.evidence };
        }
        return { kind: 'completed', completion:plan.completion, evidence:first.evidence };
    }
    /** @param {Target} target @param {import('../domain/android-control-transfer.mjs').Intent} intent */
    function perform(target, intent) {
        switch (intent.kind) {
            case "tap": return ports.tap(target, intent.point);
            case "swipe": return ports.swipe(target, intent.swipe);
            case "text": return ports.typeText(target, intent.text);
            case "key": return ports.key(target, intent.key);
            case "navigation": return ports.navigate(target, intent.navigation);
        }
    }
    return { request };
}
