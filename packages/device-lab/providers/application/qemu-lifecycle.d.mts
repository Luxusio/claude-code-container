import type {QemuLifecycleArguments,QemuLifecyclePorts,QemuLifecycleResult,QemuScope,QemuSsh,QemuFailure} from "../ports/qemu-lifecycle.mjs";
export function createQemuLifecycleApplication(ports:QemuLifecyclePorts): {
    create(args?:QemuLifecycleArguments, admittedLabId?:string):QemuLifecycleResult;
    start(args?:QemuLifecycleArguments):QemuLifecycleResult;
    stop(args?:QemuLifecycleArguments):QemuLifecycleResult;
    delete(args?:QemuLifecycleArguments):QemuLifecycleResult;
    provisionGuestAgent(args?:QemuLifecycleArguments):QemuLifecycleResult;
    validateGuestSsh(scope:QemuScope,args?:QemuLifecycleArguments):{ok:true;ssh:QemuSsh|null}|QemuFailure;
};
