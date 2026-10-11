import { runDeviceFlow } from '../../../packages/device-lab/providers/application/device-flow.mjs';
import type { DeviceFlowPorts } from '../../../packages/device-lab/providers/ports/device-flow.mjs';
import type { FlowObservation } from '../../../packages/device-lab/providers/domain/device-flow.mjs';
export function consumedFlowContract(ports: DeviceFlowPorts<{ artifact: string }>, observation: FlowObservation<{ artifact: string }>) {
    const { dispatchTool: missingDispatch, ...incomplete } = ports; void missingDispatch;
    // @ts-expect-error Real dispatch is required.
    const missing: DeviceFlowPorts<{ artifact: string }> = incomplete;
    const asynchronousAdmission: DeviceFlowPorts<{ artifact: string }> = { ...ports,
        // @ts-expect-error Admission is a synchronous fact.
        flowOperationAllowed: async () => true,
    };
    const semantic = runDeviceFlow({ steps: [{ tool: 'screenshot' }] }, { toolName: 'run_flow', toolAllowed: () => true }, ports);
    return { missing, asynchronousAdmission, semantic, observation };
}
