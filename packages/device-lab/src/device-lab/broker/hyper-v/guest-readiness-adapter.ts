import type {WindowsReadinessPorts} from "../../ports/lifecycle/hyper-v-create-start.js";
import {waitHyperVWindowsGuestReadiness} from '../../application/lifecycle/hyper-v-create-start.js';
import type {WindowsReadinessOutcome} from '../../domain/lifecycle/hyper-v-create-start.js';
export type DeviceLabHyperVGuestReadinessOutcome = WindowsReadinessOutcome;
import {
    createHyperVGuestDirectClient,
    HyperVWindowsError,
    type HyperVGuestDirectIdentity,
} from "@ccc/hyper-v/index.js";
import {
    createDeviceLabHyperVWindowsClient,
    createDeviceLabHyperVWindowsExecutor,
    type DeviceLabHyperVWindowsClientOptions,
} from "./lifecycle-adapter.js";

const PROBE_SOURCE = [
    "$Winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'",
    "[ordered]@{",
    "  computerName = [Environment]::MachineName",
    "  addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object IPAddress)",
    "  firstLogonCompleted = [string](Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\ccc' -Name 'FirstLogonCompleted' -ErrorAction SilentlyContinue).FirstLogonCompleted",
    "  provisioningSecretsPresent = [bool]((Test-Path -LiteralPath 'C:\\Windows\\Panther\\unattend.xml') -or (Test-Path -LiteralPath 'C:\\Windows\\Panther\\Unattend\\unattend.xml') -or ($null -ne (Get-ItemProperty -LiteralPath $Winlogon -Name 'DefaultPassword' -ErrorAction SilentlyContinue)))",
    "} | ConvertTo-Json -Compress -Depth 4",
].join("\n");

type Options = Omit<DeviceLabHyperVWindowsClientOptions, "session" | "record"> & {
    readonly identity: HyperVGuestDirectIdentity;
    readonly provisioningMediaPath: string;
    readonly expectedNetworkAddress: string;
    readonly timeoutMilliseconds: number;
    readonly noProgressTimeoutMilliseconds?: number;
    readonly removeProvisioningMedia: () => void | Promise<void>;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
};

export function deviceLabWindowsReadinessPorts(options:Pick<Options,"executable"|"timeoutMilliseconds"|"run"|"removeProvisioningMedia"|"now"|"sleep">):WindowsReadinessPorts {
 let timeout=options.timeoutMilliseconds;
 let native: {guest:ReturnType<typeof createHyperVGuestDirectClient>;host:ReturnType<typeof createDeviceLabHyperVWindowsClient>}|undefined;
 const clients=()=>{
  if(!native){const transport={executable:options.executable,timeoutMilliseconds:()=>timeout,run:options.run}; native={guest:createHyperVGuestDirectClient(createDeviceLabHyperVWindowsExecutor(transport)),host:createDeviceLabHyperVWindowsClient(transport)};}
  return native;
 };
 return {
  probe:async(identity,budget)=>{timeout=budget;const output=await clients().guest.invoke({...identity,action:'job',command:PROBE_SOURCE},budget);return output.action==='job'?{action:'job',output:output.output}:{action:'unexpected'};},
  detachMedia:async(identity,path,budget)=>{timeout=budget;await clients().host.removeVMDvdDrive({selector:identity.selector,expectedName:identity.expectedName,expectedNotes:identity.expectedNotes,path});return undefined;},
  machines:async(identity,budget)=>{timeout=budget;return clients().host.getVM(identity.selector);},
  media:async(identity,budget)=>{timeout=budget;return clients().host.getVMDvdDrives(identity.selector);},
  removeMedia:async()=>{await options.removeProvisioningMedia();return undefined;},
  errorInfo:error=>error instanceof HyperVWindowsError?{code:error.code,category:error.category}:null,
  now:options.now??Date.now,
  sleep:options.sleep??(milliseconds=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds))),
 };
}

export async function waitForDeviceLabHyperVGuestReadiness(options:Options):Promise<DeviceLabHyperVGuestReadinessOutcome>{return waitHyperVWindowsGuestReadiness(options,deviceLabWindowsReadinessPorts(options));}
