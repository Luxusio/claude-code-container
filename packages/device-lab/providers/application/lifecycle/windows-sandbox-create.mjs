/**
 * The synchronous direct transaction retains partial helper effects on failure.
 * Native workspace generation, repository authority and response formatting
 * remain in composition; this module owns their ordering.
 * @template {object} Helper
 * @param {import('../../ports/lifecycle/windows-sandbox-create.mjs').WindowsSandboxCreatePorts<Helper>} ports
 */
export function createWindowsSandboxCreate(ports) {
    for (const name of /** @type {const} */ (["deriveDeviceId", "readDefinitions", "readOwnerId", "ensureHelperWorkspace", "wallTimestamp", "claimDefinition"])) {
        if (!ports || typeof ports[name] !== "function") throw new TypeError(`Windows Sandbox create requires ${name}`);
    }
    /** @param {import('../../domain/lifecycle/windows-sandbox-create.mjs').WindowsSandboxCreateInput} input
     * @returns {import('../../domain/lifecycle/windows-sandbox-create.mjs').WindowsSandboxCreateOutcome<import('../../domain/lifecycle/windows-sandbox-create.mjs').WindowsSandboxCreatedDefinition<Helper>>}
     */
    function create(input) {
        const { backend, name: deviceName, deviceId, networking = false, clipboard = false, vgpu = false, memoryMb = 4096, minimized = true } = input;
        if (backend !== "windows-sandbox") return { kind: "skipped" };
        const id = deviceId || ports.deriveDeviceId(deviceName);
        const devices = ports.readDefinitions();
        if (devices.some(device => device.id === id)) return { kind: "duplicate", id };
        /** @type {import('../../domain/lifecycle/windows-sandbox-create.mjs').WindowsSandboxCreatedDefinition<Helper>} */
        const device = {
            id, name: deviceName, backend, kind: "desktop", platform: "windows",
            ownerId: ports.readOwnerId(),
            networking: Boolean(networking), clipboard: Boolean(clipboard), vgpu: Boolean(vgpu),
            memoryMb, minimized: minimized !== false,
            helper: ports.ensureHelperWorkspace({ id }),
            recording: null, status: "stopped", creatable: true,
            createdAt: ports.wallTimestamp(), updatedAt: ports.wallTimestamp(),
        };
        const claim = ports.claimDefinition(device);
        if (!claim.ok) return { kind: "claim-conflict", field: claim.field, value: claim.value };
        return { kind: "created", device };
    }
    return { create };
}
