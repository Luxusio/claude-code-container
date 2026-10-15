import { createHyperVStopDeleteApplication } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-stop-delete.js";
import type { HyperVCommandExecution, HyperVStopDeleteOutcome, HyperVStopDeleteRequest, HyperVTerminalObservation, HyperVTerminalResult } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-stop-delete.js";
import type { HyperVStopDeletePorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-stop-delete.js";

type Connection = { readonly providerId: string };
type Receipt = { readonly nativeEvidence: string };
type Ports = HyperVStopDeletePorts<Connection, Receipt>;

function terminalCapabilities(ports: Ports, request: HyperVStopDeleteRequest, connection: Connection): void {
    const execution: HyperVCommandExecution<Receipt> = { mode: "exec", provider: "hyper-v", status: 0, receipt: { nativeEvidence: "opaque terminal receipt" } };
    const observation: HyperVTerminalObservation = { vmId: "owned-vm-id", vmName: "owned-vm", state: "Off", status: "", diskPath: "C:\\owned\\system.vhdx" };
    const captured: HyperVTerminalResult<Receipt> = { ok: true, observation, execution };
    const unavailable: HyperVTerminalResult<Receipt> = { ok: false, observation: null, execution };
    const stop: Promise<HyperVTerminalResult<Receipt>> = ports.executeStop("owner", request, {}, connection, 100000);
    const deleted: Promise<HyperVTerminalResult<Receipt>> = ports.executeDelete("owner", request, {}, connection, 100000);
    const application = createHyperVStopDeleteApplication(ports);
    const invoked: Promise<HyperVStopDeleteOutcome<Connection, Receipt>> = application.invoke("owner", request, 100000, 130000);
    // @ts-expect-error Stop consumes semantic success and captured facts, not a raw execution.
    createHyperVStopDeleteApplication({ ...ports, executeStop: async () => execution });
    // @ts-expect-error Delete consumes semantic success and captured facts, not a raw execution.
    createHyperVStopDeleteApplication({ ...ports, executeDelete: async () => execution });
    // @ts-expect-error Stop success must be explicit independently of native exit status.
    createHyperVStopDeleteApplication({ ...ports, executeStop: async () => ({ observation: null, execution }) });
    // @ts-expect-error Delete success must be explicit independently of native exit status.
    createHyperVStopDeleteApplication({ ...ports, executeDelete: async () => ({ observation: null, execution }) });
    // @ts-expect-error Stop must explicitly return null when its observation is unavailable.
    createHyperVStopDeleteApplication({ ...ports, executeStop: async () => ({ ok: true, execution }) });
    // @ts-expect-error Delete must explicitly return null when its observation is unavailable.
    createHyperVStopDeleteApplication({ ...ports, executeDelete: async () => ({ ok: true, execution }) });
    // @ts-expect-error Stop facts cannot replace native diagnostic and presentation evidence.
    createHyperVStopDeleteApplication({ ...ports, executeStop: async () => ({ ok: true, observation }) });
    // @ts-expect-error Delete facts cannot replace native diagnostic and presentation evidence.
    createHyperVStopDeleteApplication({ ...ports, executeDelete: async () => ({ ok: true, observation }) });
    void [captured, unavailable, stop, deleted, invoked];
}
void terminalCapabilities;
