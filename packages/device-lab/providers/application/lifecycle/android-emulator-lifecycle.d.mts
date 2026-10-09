import type { AndroidEmulatorLifecycleInput, AndroidEmulatorLifecyclePorts, AndroidEmulatorProcessHandle } from '../../ports/lifecycle/android-emulator-lifecycle.mjs';
export interface AndroidEmulatorLifecycle<Result> {
    create(input: AndroidEmulatorLifecycleInput): Promise<Result | undefined>;
    start(input: AndroidEmulatorLifecycleInput): Promise<Result | undefined>;
    stop(input: AndroidEmulatorLifecycleInput): Promise<Result | undefined>;
    delete(input: AndroidEmulatorLifecycleInput): Promise<Result | undefined>;
}
export function createAndroidEmulatorLifecycle<Result, Child extends AndroidEmulatorProcessHandle = AndroidEmulatorProcessHandle>(ports: AndroidEmulatorLifecyclePorts<Result, Child>): AndroidEmulatorLifecycle<Result>;
