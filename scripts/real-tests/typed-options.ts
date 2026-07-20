export interface IosSimulatorE2EOptions {
    level?: number;
    bootTimeoutMs?: number;
    [key: string]: unknown;
}

export interface IosRealDeviceE2EOptions {
    level?: number;
    [key: string]: unknown;
}

export interface MacosVmE2EOptions {
    level?: number;
    bootTimeoutMs?: number;
    helperTimeoutMs?: number;
    snapshot?: boolean;
    imageTools?: boolean;
    [key: string]: unknown;
}

export function iosSimulatorE2EOptions(options: Record<string, unknown>): IosSimulatorE2EOptions {
    return options;
}

export function iosRealDeviceE2EOptions(options: Record<string, unknown>): IosRealDeviceE2EOptions {
    return options;
}

export function macosVmE2EOptions(options: Record<string, unknown>): MacosVmE2EOptions {
    return options;
}
