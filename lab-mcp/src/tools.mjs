const LAB_ID = { type: "string", maxLength: 128 };
const LAB_NAME = { type: "string", maxLength: 128 };
const PATH_VALUE = { type: "string", maxLength: 4096 };
const FILE_POLICY = {
    maxFiles: { type: "number", minimum: 1, maximum: 5000 },
    maxFileBytes: { type: "number", minimum: 1, maximum: 16777216 },
    maxTotalBytes: { type: "number", minimum: 1, maximum: 268435456 },
};
const IMAGE_FORMAT = { type: "string", enum: ["qcow2", "raw"] };
const GUEST_SSH = {
    guestSshHost: { type: "string", maxLength: 255 },
    guestSshPort: { type: "number", minimum: 1, maximum: 65535 },
    guestSshUser: { type: "string", maxLength: 64 },
    guestSshKeyPath: PATH_VALUE,
    guestReadinessCommand: { type: "string", maxLength: 512 },
};
const GUEST_AGENT = {
    guestAgentName: { type: "string", maxLength: 64 },
    guestAgentHealthCommand: { type: "string", maxLength: 512 },
    guestAgentProvisionCommand: { type: "string", maxLength: 4096 },
    guestAgentAutoProvision: { type: "boolean" },
};

export const TOOLS = [
    { name: "lab_status", description: "Inspect lab-mcp provider readiness and owner-scoped lab state", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "lab_list", description: "List owner-scoped named labs without starting VMs", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "lab_image_list", description: "List owner-scoped base images from the lab state catalog", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "lab_image_import", description: "Import or register an owner-scoped base image already present inside lab state", inputSchema: { type: "object", properties: { name: LAB_NAME, imageId: LAB_ID, sourcePath: PATH_VALUE, format: IMAGE_FORMAT, copy: { type: "boolean" }, force: { type: "boolean" } }, required: ["name", "sourcePath"] } },
    { name: "lab_create", description: "Create owner-scoped container-QEMU lab metadata in the lab-runner state root", inputSchema: { type: "object", properties: { name: LAB_NAME, labId: LAB_ID, sourceImage: { type: "string" }, baseImageId: LAB_ID, memoryMb: { type: "number", minimum: 128, maximum: 131072 }, cpus: { type: "number", minimum: 1, maximum: 128 }, force: { type: "boolean" }, ...GUEST_SSH, ...GUEST_AGENT }, required: ["name"] } },
    { name: "lab_disk_materialize", description: "Create or plan an owner-scoped writable qcow2 overlay disk for a stopped lab", inputSchema: { type: "object", properties: { labId: LAB_ID, dryRun: { type: "boolean" }, force: { type: "boolean" } }, required: ["labId"] } },
    { name: "lab_start", description: "Start or plan a named lab VM lazily through the container-QEMU provider", inputSchema: { type: "object", properties: { labId: LAB_ID, dryRun: { type: "boolean" } }, required: ["labId"] } },
    { name: "lab_reboot", description: "Reboot an owner-scoped lab through the existing stop/start provider gates", inputSchema: { type: "object", properties: { labId: LAB_ID, force: { type: "boolean" }, startIfStopped: { type: "boolean" } }, required: ["labId"] } },
    { name: "lab_stop", description: "Stop a running owner-scoped lab VM while preserving named lab state", inputSchema: { type: "object", properties: { labId: LAB_ID, force: { type: "boolean" } }, required: ["labId"] } },
    { name: "lab_delete", description: "Delete stopped owner-scoped lab metadata, overlays, snapshots, and artifacts", inputSchema: { type: "object", properties: { labId: LAB_ID, force: { type: "boolean" } }, required: ["labId"] } },
    { name: "lab_list_targets", description: "List owner-scoped lab targets and readiness metadata without starting VMs", inputSchema: { type: "object", properties: { labId: LAB_ID }, required: [] } },
    { name: "lab_probe_readiness", description: "Probe and record bounded readiness metadata for a running owner-scoped lab target", inputSchema: { type: "object", properties: { labId: LAB_ID, targetId: LAB_ID }, required: ["labId"] } },
    { name: "lab_open_session", description: "Record an owner-scoped observable session for a lab target without exposing host shell authority", inputSchema: { type: "object", properties: { labId: LAB_ID, sessionId: LAB_ID, targetId: LAB_ID, sessionType: { type: "string", enum: ["monitor", "metadata", "guest-ssh", "guest-agent"] } }, required: ["labId"] } },
    { name: "lab_snapshot_create", description: "Create an owner-scoped lab snapshot record and qemu-img snapshot when a disk is present", inputSchema: { type: "object", properties: { labId: LAB_ID, snapshotName: LAB_NAME }, required: ["labId", "snapshotName"] } },
    { name: "lab_snapshot_restore", description: "Restore an owner-scoped stopped lab to a named qemu-img snapshot when available", inputSchema: { type: "object", properties: { labId: LAB_ID, snapshotName: LAB_NAME }, required: ["labId", "snapshotName"] } },
    { name: "lab_snapshot_delete", description: "Delete an owner-scoped lab snapshot record and qemu-img snapshot when available", inputSchema: { type: "object", properties: { labId: LAB_ID, snapshotName: LAB_NAME }, required: ["labId", "snapshotName"] } },
    { name: "lab_sync_workspace", description: "Copy a bounded local workspace tree into owner-scoped lab state after file policy checks", inputSchema: { type: "object", properties: { labId: LAB_ID, sourcePath: PATH_VALUE, replace: { type: "boolean" }, ...FILE_POLICY }, required: ["labId"] } },
    { name: "lab_export_artifacts", description: "Copy bounded lab artifact/workspace output to an owner-scoped export directory after file policy checks", inputSchema: { type: "object", properties: { labId: LAB_ID, sourcePath: PATH_VALUE, destinationPath: PATH_VALUE, replace: { type: "boolean" }, ...FILE_POLICY }, required: ["labId"] } },
    { name: "lab_guest_push", description: "Plan or invoke a bounded provider guest transport to push staged workspace files into an allowed guest path", inputSchema: { type: "object", properties: { labId: LAB_ID, sourcePath: PATH_VALUE, guestPath: PATH_VALUE, dryRun: { type: "boolean" }, replace: { type: "boolean" }, ...FILE_POLICY }, required: ["labId", "guestPath"] } },
    { name: "lab_guest_pull", description: "Plan or invoke a bounded provider guest transport to pull allowed guest artifacts into lab artifact state", inputSchema: { type: "object", properties: { labId: LAB_ID, guestPath: PATH_VALUE, destinationPath: PATH_VALUE, dryRun: { type: "boolean" }, replace: { type: "boolean" }, ...FILE_POLICY }, required: ["labId", "guestPath"] } },
    { name: "lab_guest_exec", description: "Run a bounded command inside a running owner-scoped lab through configured guest SSH metadata", inputSchema: { type: "object", properties: { labId: LAB_ID, command: { type: "string", maxLength: 4096 }, timeoutMs: { type: "number", minimum: 1, maximum: 600000 } }, required: ["labId", "command"] } },
    { name: "lab_guest_agent_status", description: "Probe bounded persistent guest-agent health metadata through configured guest SSH", inputSchema: { type: "object", properties: { labId: LAB_ID, timeoutMs: { type: "number", minimum: 1, maximum: 600000 } }, required: ["labId"] } },
    { name: "lab_guest_agent_provision", description: "Run configured bounded guest-agent provisioning through guest SSH and persist sanitized status", inputSchema: { type: "object", properties: { labId: LAB_ID, timeoutMs: { type: "number", minimum: 1, maximum: 600000 } }, required: ["labId"] } },
];
