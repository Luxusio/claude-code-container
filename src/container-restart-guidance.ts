import type { RuntimeName } from "./container-runtime.js";
import { DEFAULT_PROFILE_NAME } from "./domain/profile-request.js";

/** Expected refusal: the running container cannot be joined or safely replaced. */
export class ContainerRestartRequiredError extends Error {
    constructor(
        readonly reason: string,
        readonly workspacePath: string,
        readonly runtime: RuntimeName,
        readonly profile?: string,
    ) {
        super(`Running container contract failed safety validation (${reason}); preserving the existing running container without joining it.`);
        this.name = "ContainerRestartRequiredError";
    }
}

/** Keep unexpected failures and explicitly requested debug stacks intact. */
export function formatContainerStartupError(error: unknown, debug = false, platform = process.platform): unknown {
    if (debug || !(error instanceof ContainerRestartRequiredError)) return error;
    const quote = (value: string) => `'${value.replace(
        platform === "win32" ? /['\u2018-\u201B]/g : /'/g,
        platform === "win32" ? "$&$&" : "'\\''",
    )}'`;
    const profile = quote(error.profile || DEFAULT_PROFILE_NAME);
    const workspace = quote(error.workspacePath);
    const command = platform === "win32"
        ? "& { $cccHadProfile = Test-Path Env:CCC_PROFILE; $cccPreviousProfile = $env:CCC_PROFILE; "
            + `Push-Location -LiteralPath ${workspace} -ErrorAction Stop; `
            + `try { $env:CCC_PROFILE = ${profile}; ccc --runtime ${error.runtime} stop } `
            + "finally { if ($cccHadProfile) { $env:CCC_PROFILE = $cccPreviousProfile } "
            + "else { Remove-Item Env:CCC_PROFILE -ErrorAction SilentlyContinue }; Pop-Location } }"
        : `(cd ${workspace} && CCC_PROFILE=${profile} ccc --runtime ${error.runtime} stop)`;
    let fence = "```";
    while (command.includes(fence)) fence += "`";
    return `[ccc] Container restart required: ${error.reason}.\n`
        + `Close the other CCC sessions for this workspace, then run in ${platform === "win32" ? "PowerShell" : "a POSIX shell"}:\n`
        + `${fence}\n${command}\n${fence}\n`
        + "Then retry your original command.";
}
