export function ownerContext():readonly {key:string;token:string}[];
export function runOwnerContext<T>(key:string,token:string,operation:()=>T):T;
