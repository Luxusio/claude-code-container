import type { HyperVWindowsOperation } from "./contracts.js";

export type HyperVWindowsErrorCategory = "validation" | "transport" | "protocol" | "native";

type HyperVWindowsErrorOptions = {
    readonly category: HyperVWindowsErrorCategory;
    readonly operation: HyperVWindowsOperation;
    readonly code: string;
    readonly nativeStatus?: number;
};

export class HyperVWindowsError extends Error {
    readonly category: HyperVWindowsErrorCategory;
    readonly operation: HyperVWindowsOperation;
    readonly code: string;
    readonly nativeStatus?: number;

    constructor(options: HyperVWindowsErrorOptions) {
        super(`hyper-v-windows-${options.category}:${options.operation}:${options.code}`);
        this.name = "HyperVWindowsError";
        this.category = options.category;
        this.operation = options.operation;
        this.code = options.code;
        if (options.nativeStatus !== undefined) this.nativeStatus = options.nativeStatus;
    }
}
