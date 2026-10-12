import { Buffer } from 'node:buffer';
import { type DesktopGuestIntent, type DesktopExecution, type DesktopDirectAction, type DesktopDirectResult, type DesktopDirectObservation } from '../../domain/hyper-v-desktop-transfer.js';
import {linuxWindowListCommand, windowsWindowListCommand, parseGuestWindowList, parseGuestFocusWindow, parseWindowsGuestWindowList, linuxFocusWindowCommand, windowsFocusWindowCommand} from './window-list.js';
import {hyperVLinuxGuiTypeGuestCommand, hyperVLinuxGuiScrollGuestCommand} from '../../../host-control/hyper-v/index.js';

export function desktopGuestCommand(backend:string,intent:DesktopGuestIntent):string {
 switch(intent.kind){
 case 'exec':return intent.command;
 case 'window-list':return backend==='linux-vm'?linuxWindowListCommand():windowsWindowListCommand();
 case 'focus':return backend==='linux-vm'?linuxFocusWindowCommand(intent.handle):windowsFocusWindowCommand(intent.handle);
 case 'type':return hyperVLinuxGuiTypeGuestCommand(intent.text);
 case 'scroll':return hyperVLinuxGuiScrollGuestCommand(intent.direction,intent.amount);
 }
}
export function desktopRemoteReadOutputLimit(maxBytes: number): number {
    return Math.ceil((maxBytes + 1) / 3) * 4 + 4096;
}
export function desktopRemoteReadCommand(remotePath:string,maxBytes:number):string {
 const encodedPath=Buffer.from(remotePath,'utf8').toString('base64');
 return `set -o pipefail; p=$(printf %s ${encodedPath} | base64 -d); head -c ${maxBytes+1} -- "$p" | base64 -w0`;
}
export function observeDesktopExecution(execution:Omit<DesktopExecution,'ok'>,action:'exec'|'upload'|'download',intent?:DesktopGuestIntent):DesktopExecution {
 const observation:DesktopExecution={...execution,ok:execution.status===0&&!execution.error,action};
 if(!observation.ok)return observation;
 if(action==='download'){
 const encoded=String(execution.stdout||'').trim();
 if(encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('hyper-v-linux-guest-download-invalid-base64');
 observation.artifact=Buffer.from(encoded,'base64'); observation.stdout='';
 } else if(intent?.kind==='window-list') observation.windows= parseGuestWindowList('linux-vm',execution.stdout||'');
 else if(intent?.kind==='focus')observation.focused=parseGuestFocusWindow(execution.stdout||'').ok;
 return observation;
}
export function observeDesktopDirect(result:DesktopDirectResult,action:DesktopDirectAction,intent?:DesktopGuestIntent):DesktopDirectObservation {
 if(result.action!==action.action)return {ok:false,error:'hyper-v-guest-invalid-result'};
 if(result.action==='exec'){
 const observation:DesktopDirectObservation={ok:true,guestFailed:result.status!==0,action:'exec',result:{status:result.status,stdout:result.stdout,stderr:result.stderr}};
 if(result.status===0&&intent?.kind==='window-list')observation.windows=parseWindowsGuestWindowList(result.stdout,Buffer.byteLength(result.stdout));
 if(result.status===0&&intent?.kind==='focus')observation.focused=parseGuestFocusWindow(result.stdout).ok;
 return observation;
 }
 if(result.action==='upload'||result.action==='download')return {ok:true,action:action.action,result:{localPath:result.localPath,remotePath:result.remotePath,bytes:result.bytes}};
 return {ok:false,error:'hyper-v-guest-invalid-result'};
}
