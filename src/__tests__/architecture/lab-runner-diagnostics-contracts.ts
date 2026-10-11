// Checked by the normal strict architecture compiler; never invoked.
import { createLabRunnerDiagnostics } from "../../application/lab-runner-diagnostics.js";
import type { LabRunnerConfigObservation, LabRunnerSnapshot, ContainerVmContractSnapshot } from "../../domain/lab-runner-diagnostics.js";
import type { buildContainerVmRunConfig, buildLabRunnerRunConfig } from "../../docker.js";
import type { labRunnerSnapshot, formatLabRunnerStatus, formatLabRunnerSmoke, labsCli } from "../../lab-runner-admin.js";

function contracts(ports: Parameters<typeof createLabRunnerDiagnostics>[0], native: typeof buildContainerVmRunConfig, lab: typeof buildLabRunnerRunConfig, snapshot: typeof labRunnerSnapshot, status: typeof formatLabRunnerStatus, smoke: typeof formatLabRunnerSmoke, cli: typeof labsCli) {
    const nativePort: typeof ports.containerVmConfig = native;
    const labPort: typeof ports.labRunnerVmConfig = lab;
    const observed: LabRunnerConfigObservation = nativePort("container");
    const app = createLabRunnerDiagnostics(ports);
    const a: LabRunnerSnapshot = snapshot(), b: string = status(undefined), c: string = smoke(), d: number = cli([]);
    const e: ContainerVmContractSnapshot = app.snapshot("cwd").defaultContainer;
    const published: undefined = ports.publishOutput("text");

    // @ts-expect-error Application cwd is an explicit observation.
    app.snapshot();
    // @ts-expect-error Snapshot is synchronous.
    const promise: Promise<LabRunnerSnapshot> = app.snapshot("cwd"); void promise;
    // @ts-expect-error Publishers cannot be asynchronous.
    createLabRunnerDiagnostics({ ...ports, publishOutput: async () => undefined });
    // @ts-expect-error Usage cannot return void.
    createLabRunnerDiagnostics({ ...ports, publishUsage: (): void => {} });
    // @ts-expect-error Native observations cannot return false in production types.
    createLabRunnerDiagnostics({ ...ports, labRunnerVmConfig: () => false });
    // @ts-expect-error Native group id is a number.
    createLabRunnerDiagnostics({ ...ports, containerVmConfig: () => ({ ...observed, kvmGroupId: "0" }) });
    // @ts-expect-error Path observations cannot be Promise values.
    createLabRunnerDiagnostics({ ...ports, resolveProjectPath: async () => "cwd" });

    void [labPort, observed, a, b, c, d, e, published, nativePort, app, promise];
}
void contracts;
