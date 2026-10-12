/** @typedef {{env:Record<string,string|undefined>,stateRoot:string,owner:string,ownerRoot:string}} QemuScope */
/** @typedef {{[key:string]:unknown,ok:false,error:string}} QemuFailure */
/** @typedef {import('../domain/qemu-lifecycle.mjs').QemuLab} QemuLab */
/** @typedef {import('../domain/qemu-lifecycle.mjs').QemuRuntime} QemuRuntime */
/** @typedef {import('../domain/qemu-lifecycle.mjs').QemuExecution} QemuExecution */
/** @typedef {import('../domain/qemu-lifecycle.mjs').QemuMaterializedResult} QemuMaterializedResult */
/** @import {QemuLifecyclePorts as QemuLifecyclePortsDeclaration} from './qemu-lifecycle.mjs' */
/** @typedef {QemuLifecyclePortsDeclaration} QemuLifecyclePorts */
export {};
