import type { GuestProbe } from '../../domain/lifecycle/hyper-v-create-start.js';
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

function ipv4(address:string):boolean { const parts=address.split('.'); return parts.length===4 && parts.every(part=>/^(0|[1-9][0-9]{0,2})$/.test(part)&&Number(part)<=255); }
export function parseWindowsReadinessProbe(value:string):GuestProbe|null {
 let item:unknown; try {item=JSON.parse(value);} catch{return null;}
 if(!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).sort().join('|')!==['addresses','computerName','firstLogonCompleted','provisioningSecretsPresent'].join('|'))return null;
 if(!('computerName' in item)||typeof item.computerName!=='string'||item.computerName.length<1||item.computerName.length>255
 ||!('firstLogonCompleted' in item)||typeof item.firstLogonCompleted!=='string'||item.firstLogonCompleted.length>4096
 ||!('provisioningSecretsPresent' in item)||typeof item.provisioningSecretsPresent!=='boolean'
 ||!('addresses' in item)||!Array.isArray(item.addresses)||item.addresses.length>64)return null;
 const addresses:string[]=[];
 for(const address of item.addresses){if(typeof address!=='string'||!ipv4(address))return null;addresses.push(address);}
 return {computerName:item.computerName, firstLogonCompleted:item.firstLogonCompleted,provisioningSecretsPresent:item.provisioningSecretsPresent,addresses};
}

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
  probe:async(identity,budget)=>{timeout=budget;const output=await clients().guest.invoke({...identity,action:'job',command:PROBE_SOURCE},budget);if(output.action!=='job')return {kind:'unexpected'}; const probe=parseWindowsReadinessProbe(output.output); return probe?{kind:'valid',probe}:{kind:'invalid'};},
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
