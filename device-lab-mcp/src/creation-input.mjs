// Public creation describes either real provisioning or explicit resource reuse.
// Private provider flags remain available to internal definition-only callers.
const COMMON_FIELDS = ["backend", "name", "deviceId", "detail"];
const VM_BACKENDS = new Set(["windows-vm", "linux-vm", "macos-vm"]);
export const CREATE_TOOL_BACKENDS = Object.freeze({
    create_android_emulator: "android-emulator", create_ios_simulator: "ios-simulator",
    create_windows_vm: "windows-vm", create_windows_sandbox: "windows-sandbox",
    create_linux_vm: "linux-vm", create_macos_vm: "macos-vm",
});
export function createToolName(backend) {
    return Object.entries(CREATE_TOOL_BACKENDS).find(([, value]) => value === backend)?.[0];
}
const BACKEND_FIELDS = {
    "android-emulator": ["avdName", "systemImage", "deviceProfile", "port", "headless"],
    "ios-simulator": ["simulatorName", "deviceType", "runtime", "udid"],
    "windows-sandbox": ["networking", "clipboard", "vgpu", "memoryMb", "minimized"],
    "windows-vm": ["image", "sourceImage", "profile", "switchName", "secureBootTemplate", "memoryMb", "cpus", "nestedVirtualization", "force", "dryRun"],
    "macos-vm": ["provider", "image", "sourceDeviceId", "force", "memoryMb", "cpus", "headless", "ssh"],
    "linux-vm": ["provider", "image", "sourceImage", "profile", "switchName", "secureBootTemplate", "baseImageId", "memoryMb", "cpus", "ssh", "agent", "force", "dryRun"],
};
const PROVIDERS = {
    "macos-vm": ["auto", "tart"],
    "linux-vm": ["auto", "hyper-v", "container-qemu"],
};
const PROFILES = { "windows-vm": ["windows-11", "windows-server"], "linux-vm": ["ubuntu-lts", "linux"] };
const ALL_FIELDS = new Set([...COMMON_FIELDS, ...Object.values(BACKEND_FIELDS).flat()]);
const BOOLEAN_FIELDS = new Set(["detail", "headless", "minimized", "networking", "clipboard", "vgpu", "force", "dryRun", "nestedVirtualization"]);
const NUMBER_FIELDS = new Set(["port", "memoryMb", "cpus"]);
const TRANSPORT_FIELDS = new Set(["broker", "viaBroker", "implicitBroker", "hostCandidates", "host", "brokerPort", "autolaunch", "timeoutMs", "rpcTimeoutMs", "launchTimeoutMs", "launchHost", "probe"]);
const present = value => typeof value === "string" && value.trim().length > 0;

const SSH_FIELDS = {
    "linux-vm": { host: "guestSshHost", port: "guestSshPort", user: "guestSshUser", keyPath: "guestSshKeyPath", readinessCommand: "guestReadinessCommand" },
    "macos-vm": { host: "sshHost", port: "sshPort", user: "sshUser", keyPath: "sshKeyPath", password: "sshPassword" },
};
const AGENT_FIELDS = { healthCommand: "guestAgentHealthCommand", provisionCommand: "guestAgentProvisionCommand", autoProvision: "guestAgentAutoProvision" };
const AGENT_SCHEMA = {
    description: "Optional container QEMU guest automation over ssh; requires ssh configuration.",
    type: "object", additionalProperties: false,
    properties: {
        healthCommand: { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f]+$" },
        provisionCommand: { type: "string", minLength: 1, maxLength: 4096, pattern: "^[^\\u0000-\\u001f]+$" },
        autoProvision: { type: "boolean" },
    },
    required: ["healthCommand"],
};

export function sshInputSchema(backend) {
    const properties = {
        host: { type: "string", minLength: 1, maxLength: 255 },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        user: { type: "string", minLength: 1, maxLength: 64 },
        keyPath: { type: "string", minLength: 1, maxLength: 4096 },
    };
    if (backend === "linux-vm") {
        properties.host.pattern = "^[A-Za-z0-9._:-]+$";
        properties.user.pattern = "^[A-Za-z0-9._-]+$";
        properties.readinessCommand = { type: "string", minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f]+$" };
    } else properties.password = { type: "string" };
    return {
        type: "object", additionalProperties: false, properties, required: backend === "linux-vm" ? ["host", "user"] : [],
        description: backend === "linux-vm" ? "Optional SSH access to a container QEMU guest." : "Optional custom SSH credentials; supported images supply defaults.",
    };
}

function nestedInputError(value, schema, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${label} must be an object`;
    for (const key of schema.required) if (!Object.hasOwn(value, key)) return `${label} requires ${key}`;
    for (const [key, entry] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties, key)) return `${label} does not support ${key}`;
        const field = schema.properties[key];
        if (field.type === "boolean") {
            if (typeof entry !== "boolean") return `${label}.${key} must be a boolean`;
        } else if (field.type === "integer") {
            if (!Number.isInteger(entry) || entry < field.minimum || entry > field.maximum) return `${label}.${key} must be an integer from ${field.minimum} to ${field.maximum}`;
        } else if (typeof entry !== "string" || entry.includes("\0")
            || (field.minLength && entry.trim().length < field.minLength)
            || (field.maxLength && entry.length > field.maxLength)
            || (field.pattern && !new RegExp(field.pattern).test(entry))) return `${label}.${key} is invalid`;
    }
    return null;
}

export function sshInputError(value, backend) {
    return nestedInputError(value, sshInputSchema(backend), "ssh");
}

export function normalizeSshArgs(args, backend) {
    const { ssh, ...normalized } = args;
    if (ssh) for (const [key, field] of Object.entries(SSH_FIELDS[backend])) {
        if (Object.hasOwn(ssh, key)) normalized[field] = ssh[key];
    }
    return normalized;
}

export function createInputError(args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "create arguments must be an object";
    if (Object.hasOwn(args, "createAvd") || Object.hasOwn(args, "createSimulator")) return "create provisions resources automatically; omit createAvd/createSimulator (use avdName or udid only to reuse an existing resource)";
    if (!Object.hasOwn(BACKEND_FIELDS, args.backend)) return "create requires a supported backend";
    if (!present(args.name)) return "create requires a nonempty name";
    if (VM_BACKENDS.has(args.backend) && Object.hasOwn(args, "deviceId")) return "VM creation generates deviceId; omit deviceId";
    if (args.deviceId !== undefined && (typeof args.deviceId !== "string" || !/^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/.test(args.deviceId))) return "device-id-invalid";
    const allowed = new Set([...COMMON_FIELDS, ...BACKEND_FIELDS[args.backend]]);
    for (const [key, value] of Object.entries(args)) {
        if (!ALL_FIELDS.has(key)) {
            if (TRANSPORT_FIELDS.has(key)) continue;
            return `create does not support ${key}`;
        }
        if (!allowed.has(key)) return `create ${args.backend} does not support ${key}`;
        if (key === "ssh" || key === "agent") {
            const error = key === "ssh" ? sshInputError(value, args.backend) : nestedInputError(value, AGENT_SCHEMA, "agent");
            if (error) return error;
        } else if (BOOLEAN_FIELDS.has(key)) {
            if (typeof value !== "boolean") return `create ${key} must be a boolean`;
        } else if (NUMBER_FIELDS.has(key)) {
            if (!Number.isInteger(value)) return `create ${key} must be an integer`;
        } else if (typeof value !== "string" || value.includes("\0")) return `create ${key} must be a string without NUL`;
    }
    if (args.deviceId !== undefined && !present(args.deviceId)) return "create deviceId must be nonempty";
    if (args.provider !== undefined && !PROVIDERS[args.backend]?.includes(args.provider)) return `create ${args.backend} does not support provider ${args.provider}`;
    if (args.profile !== undefined && !PROFILES[args.backend]?.includes(args.profile)) return `create ${args.backend} does not support profile ${args.profile}`;
    if (args.memoryMb !== undefined && (args.memoryMb < 1024 || args.memoryMb > 131072)) return "create memoryMb must be from 1024 to 131072";
    if (args.cpus !== undefined && (args.cpus < 1 || args.cpus > 64)) return "create cpus must be from 1 to 64";
    if (args.port !== undefined && (args.port < 5554 || args.port > 5682 || args.port % 2 !== 0)) return "create Android port must be even and from 5554 to 5682";
    if (args.backend === "linux-vm" && args.provider === "container-qemu") {
        if (present(args.baseImageId) === present(args.sourceImage)) return "create container-qemu requires exactly one of baseImageId or sourceImage";
        if (args.dryRun === true) return "create container-qemu does not support dryRun:true";
    }
    if (args.agent !== undefined && args.ssh === undefined) return "create agent requires ssh";
    if (args.backend === "linux-vm" && args.provider === "hyper-v" && (args.ssh !== undefined || args.agent !== undefined)) return "create Linux ssh and agent configure container-qemu, not hyper-v";
    if (args.backend === "macos-vm") {
        if (Object.hasOwn(args, "sourceDeviceId")) {
            if (typeof args.sourceDeviceId !== "string" || !/^(?!\.\.?$)[A-Za-z0-9._-]{1,128}$/.test(args.sourceDeviceId)) return "create_macos_vm sourceDeviceId is invalid";
            const conflict = ["image", "provider", "memoryMb", "cpus", "headless"].find(key => Object.hasOwn(args, key));
            if (conflict) return `create_macos_vm sourceDeviceId cannot be combined with ${conflict}`;
        } else {
            if (!present(args.image)) return "create_macos_vm requires image or sourceDeviceId";
            if (Object.hasOwn(args, "force")) return "create_macos_vm force requires sourceDeviceId";
        }
    }
    if (args.backend === "android-emulator") {
        if (args.avdName !== undefined && !present(args.avdName)) return "create avdName must identify an existing AVD; omit it to provision a new AVD";
        if (!present(args.avdName) && !present(args.systemImage)) return "create Android requires systemImage for a new AVD, or avdName to reuse an existing AVD; no SDK image is downloaded automatically";
        if (args.systemImage !== undefined && !/^system-images;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+$/.test(args.systemImage)) return "create systemImage must be an Android system-images package identifier";
        if (args.deviceProfile !== undefined && !present(args.systemImage)) return "create deviceProfile requires systemImage to provision a new AVD; omit deviceProfile when reusing an AVD";
    }
    if (args.backend === "ios-simulator") {
        if (args.udid !== undefined && !present(args.udid)) return "create udid must identify an existing simulator; omit it to provision a new simulator";
        if (present(args.udid) && (args.deviceType !== undefined || args.runtime !== undefined)) return "create udid reuses a simulator; omit deviceType and runtime, or omit udid to provision a new simulator";
        if (!present(args.udid) && (!present(args.deviceType) || !present(args.runtime))) return "create iOS Simulator requires deviceType and runtime, or udid to reuse an existing simulator; use devices with view:available and backend:ios-simulator for installed choices";
    }
    return null;
}

export function normalizeCreateArgs(args) {
    const { agent, ...normalized } = normalizeSshArgs(args, args.backend);
    if (agent) for (const [key, field] of Object.entries(AGENT_FIELDS)) {
        if (Object.hasOwn(agent, key)) normalized[field] = agent[key];
    }
    return {
        ...normalized,
        ...(args.backend === "macos-vm" && present(args.image) ? { sourceImage: args.image } : {}),
        ...(args.backend === "windows-vm" ? { provider: "hyper-v" } : {}),
        ...(args.backend === "android-emulator" ? { createAvd: present(args.systemImage) } : {}),
        ...(args.backend === "ios-simulator" ? { createSimulator: !present(args.udid) } : {}),
    };
}

export function createInputSchema(existingSchema, backend) {
    const properties = structuredClone(existingSchema.properties);
    if (backend === "linux-vm" || backend === "macos-vm") properties.ssh = sshInputSchema(backend);
    if (backend === "macos-vm") {
        properties.sourceDeviceId = { ...properties.deviceId, description: "Owned source VM to clone instead of image. Inherits provider, CPU and memory; omit headless. Stop it first, or use force:true to stop it before cloning." };
        properties.force = { type: "boolean", description: "Only with sourceDeviceId: stop a running source before cloning. The source may remain stopped if cloning fails." };
    }
    if (backend === "linux-vm") properties.agent = structuredClone(AGENT_SCHEMA);
    properties.name.minLength = 1;
    if (VM_BACKENDS.has(backend)) properties.name.description = "Display name; creation returns a fresh deviceId for subsequent operations.";
    properties.avdName.description = "With systemImage: optional new owner-prefixed AVD name. Without systemImage: reuse this existing AVD.";
    properties.udid.description = "Reuse an existing owner-scoped simulator. simulatorName must match its actual name (defaults to the owner/name-derived name). Omit udid to provision from deviceType and runtime.";
    properties.systemImage.description = "Installed Android system-images package identifier. Supplying it provisions a new AVD; omit only to reuse avdName. No automatic SDK download.";
    for (const key of ["avdName", "udid", "systemImage", "deviceType", "runtime"]) properties[key].minLength = 1;
    const common = Object.fromEntries(COMMON_FIELDS.filter(key => properties[key] && !(key === "deviceId" && VM_BACKENDS.has(backend))).map(key => [key, properties[key]]));
    const fields = BACKEND_FIELDS[backend];
    if (!fields) throw new Error("Unknown creation backend");
    const branchProperties = Object.fromEntries(fields.map(key => [key, properties[key]]));
    if (backend === "android-emulator") branchProperties.port = { type: "integer", minimum: 5554, maximum: 5682, multipleOf: 2, description: "Even Android emulator console port from 5554 to 5682; omit for automatic allocation." };
    if (branchProperties.provider) branchProperties.provider = { ...branchProperties.provider, enum: PROVIDERS[backend] };
    if (branchProperties.profile) branchProperties.profile = { ...branchProperties.profile, enum: PROFILES[backend] };
    if (branchProperties.image) branchProperties.image.description = backend === "macos-vm"
        ? "Required Tart base image to clone into an owned VM; supplies image-specific SSH defaults."
        : "Hyper-V image identifier or path.";
    if (branchProperties.sourceImage) branchProperties.sourceImage.description = backend === "linux-vm"
        ? "Hyper-V base image path, or container QEMU disk path instead of baseImageId."
        : "Hyper-V base image path.";
    delete common.backend;
    return {
        type: "object",
        properties: { ...common, ...branchProperties },
        required: ["name"],
        additionalProperties: false,
        ...(backend === "linux-vm" ? { allOf: [
            { if: { properties: { provider: { const: "container-qemu" } }, required: ["provider"] }, then: { oneOf: [{ required: ["baseImageId"] }, { required: ["sourceImage"] }], properties: { dryRun: { const: false } } } },
            { if: { properties: { provider: { const: "hyper-v" } }, required: ["provider"] }, then: { not: { anyOf: [{ required: ["ssh"] }, { required: ["agent"] }] } } },
            { if: { required: ["agent"] }, then: { required: ["ssh"] } },
            { if: { properties: { dryRun: { const: true } }, required: ["dryRun"] }, then: { required: ["provider"], properties: { provider: { const: "hyper-v" } } } },
        ] } : {}),
        ...(backend === "macos-vm" ? { oneOf: [
            { required: ["sourceDeviceId"], not: { anyOf: ["image", "provider", "memoryMb", "cpus", "headless"].map(key => ({ required: [key] })) } },
            { required: ["image"], properties: { image: { minLength: 1, pattern: "\\S" } }, not: { anyOf: [{ required: ["sourceDeviceId"] }, { required: ["force"] }] } },
        ] } : {}),
        ...(backend === "android-emulator" ? { oneOf: [{ required: ["avdName"], not: { anyOf: [{ required: ["systemImage"] }, { required: ["deviceProfile"] }] } }, { required: ["systemImage"] }] } : {}),
        ...(backend === "ios-simulator" ? { oneOf: [{ required: ["udid"], not: { anyOf: [{ required: ["deviceType"] }, { required: ["runtime"] }] } }, { required: ["deviceType", "runtime"], not: { required: ["udid"] } }] } : {}),
    };
}
