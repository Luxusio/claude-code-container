import type {VmCreationPorts} from '../../ports/lifecycle/hyper-v-create-start.js';
import {executeHyperVVmCreation} from '../../application/lifecycle/hyper-v-create-start.js';
import { win32 } from "path";

import {
    planHyperVVirtualMachineCreation,
    type HyperVCreateEffect,
    type HyperVCreateVirtualMachineRequest,
} from "@ccc/hyper-v/lifecycle/index.js";
import {
    parseHyperVMacAddress,
    parseHyperVVirtualSwitchName,
    type HyperVWindowsClient,
    type HyperVWindowsNetworkClient,
} from "@ccc/hyper-v/low-level/index.js";
import { assertHyperVOperationDeadline } from "./deadline.js";

type CreateVmClient = Pick<HyperVWindowsClient,
    "getVM" | "getVMHardDiskDrives" | "newVM" | "setVM" | "setVMMemory"
    | "setVMProcessor" | "getVMFirmware" | "getVMBios" | "setVMFirmware" | "setVMBios"
    | "addVMNetworkAdapter" | "renameVMNetworkAdapter" | "setVMNetworkAdapter">;

type CreateNetworkClient = Pick<HyperVWindowsNetworkClient,
    "getVMSwitches" | "getAllVMNetworkAdapters" | "getVMNetworkAdapters">;

export type DeviceLabHyperVVmCreationOptions = {
    readonly request: HyperVCreateVirtualMachineRequest;
    readonly client: CreateVmClient;
    readonly networkClient: CreateNetworkClient;
    readonly effects: HyperVCreateEffect[];
    readonly deadlineAt: number;
    readonly onNewVmAttempt?: () => void;
};

export type DeviceLabHyperVVmCreationResult = {
    readonly vmId: string;
    readonly vmName: string;
    readonly state: string;
    readonly generation: 1 | 2;
    readonly diskPath: string;
    readonly switchName: string | null;
};

export function deviceLabVmCreationPorts(options:{client:CreateVmClient;networkClient:CreateNetworkClient}):VmCreationPorts {
 const {client,networkClient}=options;
 return {
  plan:planHyperVVirtualMachineCreation,
  assertDeadline:deadline=>{assertHyperVOperationDeadline(deadline);return undefined;},
  sameWindowsPath:(left,right)=>left!==null&&win32.normalize(left).toLowerCase()===win32.normalize(right).toLowerCase(),
  switchName:parseHyperVVirtualSwitchName,macAddress:parseHyperVMacAddress,
  getVM:selector=>client.getVM(selector),getVMHardDiskDrives:selector=>client.getVMHardDiskDrives(selector),
  getVMSwitches:selector=>networkClient.getVMSwitches(selector),getAllVMNetworkAdapters:()=>networkClient.getAllVMNetworkAdapters(),getVMNetworkAdapters:request=>networkClient.getVMNetworkAdapters(request),
  newVM:request=>client.newVM(request),renameVMNetworkAdapter:request=>client.renameVMNetworkAdapter(request),setVMNetworkAdapter:request=>client.setVMNetworkAdapter(request),addVMNetworkAdapter:request=>client.addVMNetworkAdapter(request),
  setVMProcessor:request=>client.setVMProcessor(request),setVMMemory:request=>client.setVMMemory(request),setVM:request=>client.setVM(request),setVMBios:request=>client.setVMBios(request),setVMFirmware:request=>client.setVMFirmware(request),
  getVMFirmware:selector=>client.getVMFirmware(selector),getVMBios:selector=>client.getVMBios(selector),
 };
}
export async function executeDeviceLabHyperVVmCreation(options:DeviceLabHyperVVmCreationOptions):Promise<DeviceLabHyperVVmCreationResult>{return executeHyperVVmCreation(options.request,deviceLabVmCreationPorts(options),options.effects,options.deadlineAt,()=>{options.onNewVmAttempt?.();return undefined;});}
