// Checked by the normal strict architecture compiler; never invoked.
import { createLabRunnerDiagnostics } from "../../application/lab-runner-diagnostics.js";
import type { LabRunnerConfigObservation, LabRunnerConfigurationSnapshot, ContainerVmContractSnapshot } from "../../domain/lab-runner-diagnostics.js";
import type { buildContainerVmRunConfig, buildLabRunnerRunConfig } from "../../docker.js";
import type { LabRunnerSnapshot, labRunnerSnapshot, formatLabRunnerStatus, formatLabRunnerSmoke, labsCli } from "../../lab-runner-admin.js";

function contracts(ports: Parameters<typeof createLabRunnerDiagnostics>[0], native: typeof buildContainerVmRunConfig, lab: typeof buildLabRunnerRunConfig, snapshot: typeof labRunnerSnapshot, status: typeof formatLabRunnerStatus, smoke: typeof formatLabRunnerSmoke, cli: typeof labsCli) {
    const nativePort: typeof ports.containerVmConfig = native;
    const labPort: typeof ports.labRunnerVmConfig = lab;
    const observed: LabRunnerConfigObservation = nativePort("container");
    const app = createLabRunnerDiagnostics(ports);
    const a: LabRunnerSnapshot = snapshot(), b: string = status(undefined), c: string = smoke(), d: number = cli([]);
    const e: ContainerVmContractSnapshot = app.snapshot("cwd").defaultContainer;
    const configuration: LabRunnerConfigurationSnapshot = app.snapshot("cwd");
    const startCommand: string = a.startCommands.shell;

    // @ts-expect-error Application cwd is an explicit observation.
    app.snapshot();
    // @ts-expect-error Snapshot is synchronous.
    const promise: Promise<LabRunnerConfigurationSnapshot> = app.snapshot("cwd"); void promise;
    // @ts-expect-error Terminal publication belongs to the public facade.
    ports.publishOutput("text");
    // @ts-expect-error Usage publication belongs to the public facade.
    ports.publishUsage("text");
    // @ts-expect-error CLI dispatch is outside the snapshot application.
    app.cli([], "cwd");
    // @ts-expect-error Terminal rendering is outside the snapshot application.
    app.formatStatus("cwd");
    // @ts-expect-error Command-line instructions are added by the public facade.
    configuration.startCommands;
    // @ts-expect-error Native observations cannot return false in production types.
    createLabRunnerDiagnostics({ ...ports, labRunnerVmConfig: () => false });
    // @ts-expect-error Native group id is a number.
    createLabRunnerDiagnostics({ ...ports, containerVmConfig: () => ({ ...observed, kvmGroupId: "0" }) });
    // @ts-expect-error Path observations cannot be Promise values.
    createLabRunnerDiagnostics({ ...ports, resolveProjectPath: async () => "cwd" });

    void [labPort, observed, a, b, c, d, e, configuration, startCommand, nativePort, app, promise];
}
void contracts;
