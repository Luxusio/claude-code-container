import type { HostCredentialRefreshPorts } from "../../ports/credentials/host-refresh.js";

export function createHostCredentialRefresh(ports: HostCredentialRefreshPorts) {
    for (const name of [
        "refreshSsh", "hostSshSourceExists", "hostGitConfigExists",
        "stageHostGitConfig", "installHostGitConfig", "reportSshRefreshFailure",
        "reportGitCopyFailure", "reportGitInstallFailure",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Host credential refresh requires a callable ${name} port.`);
        }
    }

    function refreshSsh(target: string): undefined {
        if (ports.refreshSsh(target).status !== 0 && ports.hostSshSourceExists()) {
            ports.reportSshRefreshFailure();
        }
    }

    function syncGit(target: string): undefined {
        if (!ports.hostGitConfigExists()) return;
        if (ports.stageHostGitConfig(target).status !== 0) {
            ports.reportGitCopyFailure();
            return;
        }
        if (ports.installHostGitConfig(target).status !== 0) {
            ports.reportGitInstallFailure();
        }
    }

    return { refreshSsh, syncGit };
}
