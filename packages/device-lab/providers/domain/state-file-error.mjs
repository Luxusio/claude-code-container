/** Public native state-file error identity. */
export class DeviceLabStateFileError extends Error {
    /** @param {string} code @param {{cause?: unknown}} [options] */
    constructor(code, options) {
        super(code, options);
        this.name = "DeviceLabStateFileError";
        this.code = code;
    }
}
