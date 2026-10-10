import type { IosSimulatorLifecycleInput, IosSimulatorLifecyclePorts } from "../../ports/lifecycle/ios-simulator-lifecycle.mjs";
export interface IosSimulatorLifecycle<Result> {
    create(input: IosSimulatorLifecycleInput): Promise<Result | undefined>;
    start(input: IosSimulatorLifecycleInput): Promise<Result | undefined>;
    stop(input: IosSimulatorLifecycleInput): Promise<Result | undefined>;
    delete(input: IosSimulatorLifecycleInput): Promise<Result | undefined>;
}
export function createIosSimulatorLifecycle<Result>(ports: IosSimulatorLifecyclePorts<Result>): IosSimulatorLifecycle<Result>;
