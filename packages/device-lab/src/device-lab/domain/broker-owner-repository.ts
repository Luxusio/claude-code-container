export function ownerObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}
export function ownerRecord(value: unknown): value is Record<string, unknown> {
    return ownerObject(value) && !Array.isArray(value);
}
export function assertUniqueOwnerDeviceIds(devices: unknown[]): void {
    const ids = new Set<string>();
    for (const device of devices) {
        const id = ownerObject(device) ? device.id : null;
        if (typeof id !== "string" || !id) continue;
        if (ids.has(id)) throw new Error(`owner-device-id-conflict:${id}`);
        ids.add(id);
    }
}
export function ownerIdentityConflict(devices: unknown[], device: Record<string, unknown>, uniqueFields: Array<string | string[]>) {
    for (const selector of uniqueFields) {
        const fields = Array.isArray(selector) ? selector : [selector];
        const values = fields.map(field => device[field]);
        if (values.some(value => value === null || value === undefined || value === "")) continue;
        const existing = devices.find((candidate): candidate is Record<string, unknown> => ownerObject(candidate) && fields.every((field, index) => candidate[field] === values[index]));
        if (existing) {
            const field = fields.join("+");
            const value = fields.length === 1 ? values[0] : Object.fromEntries(fields.map((key, index) => [key, values[index]]));
            return { ok: false as const, error: field === "id" ? "owner-device-id-conflict" : "owner-device-identity-conflict", field, value, existing };
        }
    }
    return null;
}
