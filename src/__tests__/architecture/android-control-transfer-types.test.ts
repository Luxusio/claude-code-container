import { createAndroidControlTransfer } from "../../../packages/device-lab/providers/application/android-control-transfer.mjs";
import type { AndroidControlArguments, AndroidControlOutcome, AndroidControlTransferPorts } from "../../../packages/device-lab/providers/ports/android-control-transfer.d.mts";

type Target = { serial: string };
type InputStage = { input: string };
type OutputStage = { output: string };
type Ports = AndroidControlTransferPorts<Target, InputStage, OutputStage>;

// Compile-only consumers of the actual JS factory's required JSDoc contract.
function requiredCapabilities(ports: Ports): void {
    const application = createAndroidControlTransfer(ports);
    const result: AndroidControlOutcome | undefined = application.request("device_download", { deviceId: "owned", remotePath: "/sdcard/file", localPath: "/local/file" });
    const orientation: AndroidControlArguments = { deviceId: "owned", orientation: "reverse-portrait" };
    const oriented: AndroidControlOutcome | undefined = application.request("mobile_set_orientation", orientation);
    const left: AndroidControlOutcome | undefined = application.request("mobile_rotate_left", { deviceId: "owned" });
    const right: AndroidControlOutcome | undefined = application.request("mobile_rotate_right", { deviceId: "owned" });
    const { tap: tap, ...withoutTap } = ports;
    // @ts-expect-error Target-bound native command execution is required.
    createAndroidControlTransfer(withoutTap);
    // @ts-expect-error Native tap observations settle synchronously.
    createAndroidControlTransfer({ ...ports, tap: async () => ({ status: 0 }) });
    const { commitOutput: commit, ...withoutCommit } = ports;
    // @ts-expect-error Successful downloads require owned atomic publication authority.
    createAndroidControlTransfer(withoutCommit);
    // @ts-expect-error Input staging must return its allocated stage synchronously.
    createAndroidControlTransfer({ ...ports, stageInput: async () => ({ ok: false, message: "refused" }) });
    // @ts-expect-error Output staging must return its allocated stage synchronously.
    createAndroidControlTransfer({ ...ports, stageOutput: async () => ({ ok: false, message: "refused" }) });
    // @ts-expect-error Atomic commit must settle before the synchronous request returns.
    createAndroidControlTransfer({ ...ports, commitOutput: async () => ({ ok: true, path: "/local/file" }) });
    // @ts-expect-error Disposal cannot leave an asynchronous stage lifetime behind.
    createAndroidControlTransfer({ ...ports, disposeOutput: async () => undefined });
    void [result, oriented, left, right, tap, commit];
}
void requiredCapabilities;
