import { describe, expectTypeOf, it } from "vitest";
import { createAndroidControlTransfer } from "../../../packages/device-lab/providers/application/android-control-transfer.mjs";
import type { AndroidControlArguments, AndroidControlOperation, AndroidControlOutcome, AndroidControlTransferPorts } from "../../../packages/device-lab/providers/ports/android-control-transfer.d.mts";

type Target = { serial: string };
type InputStage = { input: string };
type OutputStage = { output: string };
type Ports = AndroidControlTransferPorts<Target, InputStage, OutputStage>;
type Application = ReturnType<typeof createAndroidControlTransfer<Target, InputStage, OutputStage>>;

// Compile-only consumers of the actual JS factory's required JSDoc contract.
function requiredCapabilities(ports: Ports): void {
    const application = createAndroidControlTransfer(ports);
    const result: AndroidControlOutcome | undefined = application.request("device_download", { deviceId: "owned", remotePath: "/sdcard/file", localPath: "/local/file" });
    const { execute: execute, ...withoutExecution } = ports;
    // @ts-expect-error Target-bound native command execution is required.
    createAndroidControlTransfer(withoutExecution);
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
    void [result, execute, commit];
}
void requiredCapabilities;

describe("Android control and transfer consumed types", () => {
    it("exposes a synchronous finite request and outcome contract", () => {
        expectTypeOf<Parameters<Application["request"]>>().toEqualTypeOf<[AndroidControlOperation, AndroidControlArguments]>();
        expectTypeOf<ReturnType<Application["request"]>>().toEqualTypeOf<AndroidControlOutcome | undefined>();
    });
});
