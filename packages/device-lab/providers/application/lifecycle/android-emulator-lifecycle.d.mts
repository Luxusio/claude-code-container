import type { AndroidEmulatorLifecycleInput, AndroidEmulatorLifecyclePorts, AndroidEmulatorProcessHandle, AndroidEmulatorLifecycleOutcome } from '../../ports/lifecycle/android-emulator-lifecycle.mjs';
export interface AndroidEmulatorLifecycle {
    create(input: AndroidEmulatorLifecycleInput): Promise<AndroidEmulatorLifecycleOutcome | undefined>;
    start(input: AndroidEmulatorLifecycleInput): Promise<AndroidEmulatorLifecycleOutcome | undefined>;
    stop(input: AndroidEmulatorLifecycleInput): Promise<AndroidEmulatorLifecycleOutcome | undefined>;
    delete(input: AndroidEmulatorLifecycleInput): Promise<AndroidEmulatorLifecycleOutcome | undefined>;
}
export function createAndroidEmulatorLifecycle<Child extends AndroidEmulatorProcessHandle = AndroidEmulatorProcessHandle>(ports: AndroidEmulatorLifecyclePorts<Child>): AndroidEmulatorLifecycle;
