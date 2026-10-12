import { Buffer } from 'node:buffer';
import { type DesktopGuestIntent, type DesktopExecution, type DesktopDirectAction, type DesktopDirectResult, type DesktopDirectObservation, type DesktopWindowFailure } from '../../domain/hyper-v-desktop-transfer.js';
import {linuxWindowListCommand, windowsWindowListCommand, parseGuestWindowList, parseGuestFocusWindow, linuxFocusWindowCommand, windowsFocusWindowCommand} from './window-list.js';
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
function windowObservation(observation: DesktopExecution, backend: string, intent: DesktopGuestIntent | undefined, stdout: string): void {
 if(intent?.kind!=='window-list'&&intent?.kind!=='focus')return;
 try {
  if(intent.kind==='window-list')observation.windows=parseGuestWindowList(backend,stdout);
  else observation.focused=parseGuestFocusWindow(stdout).ok;
 } catch(error) {
  const known: readonly DesktopWindowFailure[]=['window-focus-invalid-result','window-list-invalid-result','window-focus-denied','window-not-found','focus-window-session-changed','window-list-session-changed','window-list-query-failed'];
  const code=error instanceof Error?error.message:'';
  observation.windowFailure=known.includes(code as DesktopWindowFailure)?code as DesktopWindowFailure:intent.kind==='focus'?'window-focus-invalid-result':'window-list-invalid-result';
 }
}
export function observeDesktopExecution(execution:Omit<DesktopExecution,'ok'>,action:'exec'|'upload'|'download',intent?:DesktopGuestIntent):DesktopExecution {
 const observation:DesktopExecution={...execution,ok:execution.status===0&&!execution.error,action};
 if(!observation.ok)return observation;
 if(action==='download'){
 const encoded=String(execution.stdout||'').trim();
 if(encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))observation.artifactInvalid=true;
 else observation.artifact=Buffer.from(encoded,'base64');
 observation.stdout='';
 } else windowObservation(observation,'linux-vm',intent,execution.stdout||'');
 return observation;
}
export function observeDesktopDirect(result:DesktopDirectResult,action:DesktopDirectAction,intent?:DesktopGuestIntent):DesktopDirectObservation {
 if(result.action!==action.action)return {ok:false,error:'hyper-v-guest-invalid-result'};
 if(result.action==='exec'){
 const observation:DesktopDirectObservation={ok:true,guestFailed:result.status!==0,action:'exec',result:{status:result.status,stdout:result.stdout,stderr:result.stderr}};
 if(result.status===0)windowObservation(observation,'windows-vm',intent,result.stdout);
 return observation;
 }
 if(result.action==='upload'||result.action==='download')return {ok:true,action:action.action,result:{localPath:result.localPath,remotePath:result.remotePath,bytes:result.bytes}};
 return {ok:false,error:'hyper-v-guest-invalid-result'};
}
