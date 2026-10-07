import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { HostCredentialRefreshPorts } from "../../ports/credentials/host-refresh.js";
import { gitSigningKeyRewriteShell, sshCredentialCopyShell } from "./ssh-material.js";

export function createNativeHostCredentialRefreshPorts(selectRuntime: () => string): HostCredentialRefreshPorts {
    let hostSshDir: string;
    let hostGitConfig: string;
    let gitCli: string;
    let hostSshRoot: string;
    const stagedPath = "/tmp/ccc-host-gitconfig";

    return {
        refreshSsh(target) {
            hostSshDir = join(homedir(), ".ssh");
            const cli = selectRuntime();
            const copied = spawnSync(
                cli,
                [
                    "exec",
                    target,
                    "sh",
                    "-c",
                    sshCredentialCopyShell(true),
                    "ccc-ssh-copy",
                    "/home/ccc/.ssh",
                    "/tmp/.ssh-copy",
                ],
                { stdio: "ignore" },
            );
            return { get status() { return copied.status; } };
        },
        hostSshSourceExists() {
            return existsSync(hostSshDir);
        },
        hostGitConfigExists() {
            hostGitConfig = join(homedir(), ".gitconfig");
            return existsSync(hostGitConfig);
        },
        stageHostGitConfig(target) {
            gitCli = selectRuntime();
            hostSshRoot = join(homedir(), ".ssh").replace(/\\/g, "/").replace(/\/+$/, "");
            const copied = spawnSync(gitCli, ["cp", hostGitConfig, `${target}:${stagedPath}`], { stdio: "ignore" });
            return { get status() { return copied.status; } };
        },
        installHostGitConfig(target) {
            const installed = spawnSync(
                gitCli,
                [
                    "exec",
                    "--user",
                    "root",
                    target,
                    "sh",
                    "-c",
                    `set -e; cp ${stagedPath} /home/ccc/.gitconfig; `
                    + "git config --file /home/ccc/.gitconfig --add safe.directory '*'; "
                    + gitSigningKeyRewriteShell()
                    + "; "
                    + `chown ccc:ccc /home/ccc/.gitconfig; rm -f ${stagedPath}`,
                    "ccc-signing-key-rewrite",
                    "/home/ccc/.gitconfig",
                    hostSshRoot,
                    "/tmp/.ssh-copy",
                ],
                { stdio: "ignore" },
            );
            return { get status() { return installed.status; } };
        },
        reportSshRefreshFailure() {
            console.error("[ccc] WARNING: failed to refresh copied SSH credentials inside container");
        },
        reportGitCopyFailure() {
            console.error("[ccc] WARNING: failed to copy host .gitconfig into container");
        },
        reportGitInstallFailure() {
            console.error("[ccc] WARNING: failed to install host .gitconfig inside container");
        },
    };
}
