export class DeviceLabStateFileError extends Error {
    readonly code: string;

    constructor(code: string, options?: { cause?: unknown }) {
        super(code, options);
        this.name = "DeviceLabStateFileError";
        this.code = code;
    }
}
