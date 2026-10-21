import { androidActionPlan, androidOrientationPlan } from "../domain/android-control-transfer.mjs";
/** @typedef {import('../ports/android-control-transfer.mjs').AndroidControlOperation} Operation */
/** @typedef {import('../ports/android-control-transfer.mjs').AndroidControlArguments} Arguments */
/** @typedef {import('../ports/android-control-transfer.mjs').AndroidControlOutcome} Outcome */
/** @typedef {import('../ports/android-control-transfer.mjs').AndroidControlResult} Result */

/** @param {Result|{kind:'thrown',error:unknown}} primary
 * @param {()=>undefined} dispose
 * @returns {Outcome} */
function finalizeStage(primary, dispose) {
    try { dispose(); }
    catch (error) { return { kind: "cleanup-failure", primary, error }; }
    if (primary.kind === "thrown") throw primary.error;
    return primary;
}

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
            const handle = stage.handle;
            /** @type {Result|{kind:'thrown',error:unknown}} */
            let primary;
            try {
                const command = ports.upload(target, stage.stagedPath, remote.path, 300_000);
                primary = command.ok
                    ? { kind: 'completed', completion: {kind:'uploaded',localPath:stage.path,remotePath:remote.path}, evidence:command.evidence }
                    : { kind: "command-failure", evidence:command.evidence };
            } catch (error) { primary = { kind: "thrown", error }; }
            return finalizeStage(primary, () => ports.disposeInput(handle));
        }
        if (operation === "device_download") {
            const remote = ports.guestPath(input.remotePath, "download-remote-path");
            if (!remote.ok) return { kind: "text", message: remote.message };
            const stage = ports.stageOutput(input.localPath);
            if (!stage.ok) return { kind: "text", message: stage.message };
            const handle = stage.handle;
            /** @type {Result|{kind:'thrown',error:unknown}} */
            let primary;
            try {
                const command = ports.download(target, remote.path, stage.stagedPath, 300_000);
                if (!command.ok) primary = { kind: "command-failure", evidence:command.evidence };
                else {
                    const committed = ports.commitOutput(handle);
                    primary = committed.ok
                        ? { kind: 'completed', completion: {kind:'downloaded',remotePath:remote.path,localPath:committed.path}, evidence:command.evidence }
                        : { kind: "text", message: committed.message };
                }
            } catch (error) { primary = { kind: "thrown", error }; }
            return finalizeStage(primary, () => ports.disposeOutput(handle));
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
