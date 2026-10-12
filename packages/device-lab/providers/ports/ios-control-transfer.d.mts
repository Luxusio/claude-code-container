export type IosControlArgs = Parameters<typeof import("../domain/ios-control-transfer.mjs").iosControlRequest>[1];
export interface IosControlDevice {
    id: string;
    simulatorName?: string;
}
export interface IosControlSession {
    serverUrl: string;
    sessionId: string;
}
export type IosSessionResolution = {
    unknown: true;
    error?: never;
    serverUrl?: never;
    sessionId?: never;
} | {
    error: string;
    unknown?: never;
    serverUrl?: never;
    sessionId?: never;
} | (IosControlSession & {
    unknown?: never;
    error?: never;
});
export interface IosCommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
export interface IosTransferStage {
    path: string;
    stagedPath: string;
    cleanup(): void;
}
export type IosStageResult = ({
    ok: true;
} & IosTransferStage) | {
    ok: false;
    message: string;
};
export type IosTransferResult = {
    ok: true;
    path: string;
} | {
    ok: false;
    message: string;
};
export interface IosControlPorts {
    findDevice(id: string | undefined): IosControlDevice | null | undefined;
    resolveSession(id: string | undefined): Promise<IosSessionResolution>;
    performControl(session: IosControlSession, command: import("../domain/ios-control-transfer.mjs").IosControlCommand): Promise<IosControlObservation>;
}
export interface IosPhysicalControlPorts extends IosControlPorts {
    kind: "physical";
}
export interface IosSimulatorControlPorts extends IosControlPorts {
    kind: "simulator";
    ownedSimulatorName(name: string | undefined): boolean;
    discovery(): {
        available: boolean;
        xcrun: string | null;
        missing: string[];
    };
    verifyTarget(xcrun: string | null, device: IosControlDevice): {
        target: string;
        error?: never;
    } | {
        error: string;
        target?: never;
    };
    resolveContainer(xcrun: string | null, target: string, bundleId: string, type: string): {kind:"resolved"; containerRoot:string} | {kind:"failed"; receipt:IosCommandResult};
    pathFacts(root: string, requestedPath: string): {
        path: string;
        relativePath: string;
        absolute: boolean;
    };
    guardWrite(root: string, path: string): {
        error?: string;
    };
    guardRead(root: string, path: string): {
        error?: string;
    };
    exists(path: string): boolean;
    stageInput(path: string): IosStageResult;
    stageOutput(path: string): IosStageResult;
    copyInput(stage: IosTransferStage, path: string): IosTransferResult;
    populateOutput(path: string, stage: IosTransferStage): IosTransferResult;
    commitOutput(stage: IosTransferStage): IosTransferResult;
    disposeStage(stage: IosTransferStage): undefined;
}
export type IosControlTransferPorts = IosPhysicalControlPorts | IosSimulatorControlPorts;

export type IosControlObservation = {kind:"succeeded"} | {kind:"failed"; message:string};
export type IosControlOutcome = {kind:"json"; payload:object} | {kind:"text"; message:string} | {kind:"command-failure"; receipt:unknown};
