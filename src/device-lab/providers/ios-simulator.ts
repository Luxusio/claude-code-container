export type IosSimulatorCreateInput = {
    simulatorName: string;
    ownerPrefix: string;
    deviceType?: unknown;
    runtime?: unknown;
    executable: string;
};

export function iosSimulatorCreateCommand(input: IosSimulatorCreateInput) {
    const deviceType = typeof input.deviceType === "string" && input.deviceType ? input.deviceType : null;
    const runtime = typeof input.runtime === "string" && input.runtime ? input.runtime : null;
    if (!deviceType || !runtime) {
        return { error: "missing-provider-metadata", missing: [!deviceType ? "deviceType" : "", !runtime ? "runtime" : ""].filter(Boolean) };
    }
    if (!input.simulatorName.startsWith(input.ownerPrefix)) {
        return { error: "ios-simulator-not-owner-scoped", missing: ["owner-prefixed simulatorName"] };
    }
    return { mode: "exec" as const, provider: "simctl", executable: input.executable, args: ["simctl", "create", input.simulatorName, deviceType, runtime] };
}

export function iosSimulatorCreatedUdid(stdout: unknown): string | null {
    const udid = String(stdout || "").trim();
    return udid && !/\s/.test(udid) ? udid : null;
}

export function iosSimulatorDeleteCommand(executable: string, udid: string) {
    return { mode: "exec" as const, provider: "simctl", executable, args: ["simctl", "delete", udid] };
}
