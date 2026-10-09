export type DeviceAdminBackend = {
    stateKey: string;
    name: string;
    tools: readonly string[];
};

export type DeviceAdminToolSnapshot = {
    tools: Record<string, string | null>;
    missing: string[];
    available: boolean;
};

export function classifyDeviceAdminTools(backend: DeviceAdminBackend, tools: Record<string, string | null>): DeviceAdminToolSnapshot {
    if (backend.name === "macos-vm") {
        const providerAvailable = backend.tools.some((tool) => Boolean(tools[tool]));
        return { tools, missing: providerAvailable ? [] : [...backend.tools], available: providerAvailable };
    }
    const missing = backend.tools.filter((tool) => !tools[tool]);
    return { tools, missing, available: missing.length === 0 };
}

export type DeviceAdminInventoryCommand = "status" | "list" | "all-projects" | "invalid-list" | null;

export function admitDeviceAdminInventoryCommand(args: string[], subcommand = args[0] || "status"): DeviceAdminInventoryCommand {
    if (subcommand === "status") return "status";
    if (subcommand !== "list") return null;
    if (args.length === 1) return "list";
    if (args.length === 2 && args[1] === "--all-projects") return "all-projects";
    return "invalid-list";
}

export function deviceAdminLabel(device: unknown): string {
    if (!device || typeof device !== "object") return "(unknown)";
    const d = device as Record<string, unknown>;
    return [
        d.id,
        d.name ? `name=${d.name}` : null,
        d.status ? `status=${d.status}` : null,
        d.platform ? `platform=${d.platform}` : null,
    ].filter(Boolean).join("  ");
}

