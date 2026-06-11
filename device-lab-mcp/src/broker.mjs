import { homedir } from "os";
import { join } from "path";
import { ownerId } from "./context.mjs";

const HOST_CANDIDATES = [
    "host.docker.internal",
    "host.containers.internal",
    "gateway.docker.internal",
    "172.17.0.1",
    "10.0.2.2",
];

export function brokerStateRoot() {
    return join(homedir(), ".ccc/devices");
}

export function brokerStatus() {
    const owner = ownerId();
    const root = brokerStateRoot();
    return {
        ownerId: owner,
        mode: "direct-provider",
        lazy: true,
        available: false,
        startupPolicy: "no daemon is started by status, inventory, or backend discovery calls",
        transport: {
            preferred: "http",
            hostCandidates: HOST_CANDIDATES,
            defaultPort: 17373,
            zeroConfig: true,
            environmentRequired: false,
        },
        state: {
            root,
            ownerRoot: join(root, "owners", owner),
            locksRoot: join(root, "broker", "locks"),
            logsRoot: join(root, "broker", "logs"),
        },
        implemented: [
            "owner-scoped direct provider adapters",
            "owner-scoped state layout",
            "physical device lease files",
            "explicit all-owner admin cleanup commands",
            "broker contract inspection",
        ],
        deferred: [
            "host broker daemon launcher",
            "broker HTTP transport",
            "broker-managed backend command execution",
            "broker authentication token handshake",
            "broker health probe",
        ],
        note: "Device backends currently run in direct-provider mode. The broker contract is exposed so agents can detect the current host-control mode before requesting lifecycle work.",
    };
}
