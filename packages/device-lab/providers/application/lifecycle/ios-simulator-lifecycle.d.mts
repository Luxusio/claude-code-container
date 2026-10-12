import type { IosSimulatorLifecycleInput, IosSimulatorLifecyclePorts, IosSimulatorLifecycleOutcome } from "../../ports/lifecycle/ios-simulator-lifecycle.mjs";
export interface IosSimulatorLifecycle {
    create(input: IosSimulatorLifecycleInput): Promise<IosSimulatorLifecycleOutcome | undefined>;
    start(input: IosSimulatorLifecycleInput): Promise<IosSimulatorLifecycleOutcome | undefined>;
    stop(input: IosSimulatorLifecycleInput): Promise<IosSimulatorLifecycleOutcome | undefined>;
    delete(input: IosSimulatorLifecycleInput): Promise<IosSimulatorLifecycleOutcome | undefined>;
}
export function createIosSimulatorLifecycle(ports: IosSimulatorLifecyclePorts): IosSimulatorLifecycle;
