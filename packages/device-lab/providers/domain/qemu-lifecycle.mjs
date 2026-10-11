/** @typedef {{[key:string]:unknown,name?:unknown,labId?:unknown,force?:unknown,dryRun?:unknown,startIfStopped?:unknown,baseImageId?:unknown,sourceImage?:unknown,memoryMb?:unknown,cpus?:unknown,timeoutMs?:unknown}} QemuLifecycleArguments */
/** @typedef {{[key:string]:unknown,id?:string,state?:string,ok?:boolean,error?:unknown,status?:unknown}} QemuAgentStatus */
/** @typedef {{host:string,port:number,user:string,keyPath?:string|null,readinessCommand?:string,keyConfigured?:boolean,readinessCommandConfigured?:boolean}} QemuSsh */
/** @typedef {{[key:string]:unknown,name?:string,protocol?:string,healthCommand?:string,provisionCommand?:string|null,autoProvision?:boolean,lastProvision?:QemuAgentStatus|null,lastStatus?:QemuAgentStatus|null,provisionHistory?:QemuAgentStatus[]}} QemuAgent */
/** @typedef {{[key:string]:unknown,ssh?:QemuSsh|null,agent?:QemuAgent|null}} QemuGuest */
/** @typedef {{[key:string]:unknown,runtimeId?:string,pid?:unknown,processIdentity?:unknown,command?:unknown,args?:unknown,startedAt?:unknown}} QemuRuntime */
/** @typedef {{[key:string]:unknown,id:string,name:string,ownerId:string,provider?:string,runtimeState:string,createdAt?:unknown,updatedAt?:unknown,resources:{memoryMb:unknown,cpus:unknown},image:{[key:string]:unknown,baseImageId?:string|null,sourceImage?:string|null,diskImage:string,format?:string,disk?:{[key:string]:unknown,path?:string}},paths:{labDir:string,workspaceDir:string,snapshotsDir:string,artifactsDir:string,exportsDir:string},runtime?:QemuRuntime|null,guest?:QemuGuest,readiness?:{[key:string]:unknown,latest?:unknown}}} QemuLab */
/** @typedef {{[key:string]:unknown,ok?:unknown,status?:unknown,stdout?:unknown,stderr?:unknown,args?:unknown,pid?:unknown,processIdentity?:unknown}} QemuExecution */
/** @typedef {{[key:string]:unknown,ok:boolean,lab?:QemuLab,materialized?:boolean}} QemuMaterializedResult */
const DEFAULT_SSH_CONNECT_TIMEOUT_SEC = 5;
const MAX_GUEST_AGENT_HEALTH_COMMAND_LENGTH = 512;
const MAX_GUEST_AGENT_PROVISION_COMMAND_LENGTH = 4096;
/** @param {string} value @param {string} label @param {RegExp} pattern @param {number} maxLength @returns {{ok:true,value:string}|{ok:false,error:string}} */
export function safeSshText(value, label, pattern, maxLength) {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f]/.test(value) || !pattern.test(value)) {
        return { ok: false, error: `invalid-${label}` };
    }
    return { ok: true, value };
}

/** @param {QemuLifecycleArguments} [args] */
export function guestSshInput(args = {}) {
    const nested = /** @type {Record<string, unknown>} */ (args.guestSsh && typeof args.guestSsh === "object" ? args.guestSsh : {});
    return {
        host: args.guestSshHost ?? nested.host,
        port: args.guestSshPort ?? nested.port,
        user: args.guestSshUser ?? nested.user,
        keyPath: args.guestSshKeyPath ?? nested.keyPath,
        readinessCommand: args.guestReadinessCommand ?? nested.readinessCommand,
    };
}

/** @param {QemuLifecycleArguments} [args] */
export function guestAgentInput(args = {}) {
    const nested = /** @type {Record<string, unknown>} */ (args.guestAgent && typeof args.guestAgent === "object" ? args.guestAgent : {});
    return {
        name: args.guestAgentName ?? nested.name,
        healthCommand: args.guestAgentHealthCommand ?? nested.healthCommand,
        provisionCommand: args.guestAgentProvisionCommand ?? nested.provisionCommand,
        autoProvision: args.guestAgentAutoProvision ?? nested.autoProvision,
    };
}

/** @param {QemuLifecycleArguments} [args] @returns {{ok:true,agent:QemuAgent|null}|{ok:false,error:string}} */
export function validateGuestAgent(args = {}) {
    const input = guestAgentInput(args);
    const values = Object.values(input).filter((value) => value !== undefined && value !== null && value !== "");
    if (values.length === 0) return { ok: true, agent: null };
    const name = input.name === undefined || input.name === null || input.name === "" ? "ccc-guest-agent" : String(input.name);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return { ok: false, error: "invalid-guest-agent-name" };
    if (input.healthCommand === undefined || input.healthCommand === null || input.healthCommand === "") {
        return { ok: false, error: "guest-agent-requires-health-command" };
    }
    const healthCommand = String(input.healthCommand);
    if (healthCommand.length > MAX_GUEST_AGENT_HEALTH_COMMAND_LENGTH || /[\u0000-\u001f]/.test(healthCommand)) {
        return { ok: false, error: "invalid-guest-agent-health-command" };
    }
    let provisionCommand = null;
    if (input.provisionCommand !== undefined && input.provisionCommand !== null && input.provisionCommand !== "") {
        provisionCommand = String(input.provisionCommand);
        if (provisionCommand.length > MAX_GUEST_AGENT_PROVISION_COMMAND_LENGTH || /[\u0000-\u001f]/.test(provisionCommand)) {
            return { ok: false, error: "invalid-guest-agent-provision-command" };
        }
    }
    return {
        ok: true,
        agent: {
            name,
            protocol: "bounded-ssh-health-command",
            healthCommand,
            provisionCommand,
            autoProvision: input.autoProvision === undefined ? Boolean(provisionCommand) : input.autoProvision === true,
        },
    };
}

/** @param {QemuSsh} ssh */
export function sshBaseArgs(ssh) {
    const args = [
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `ConnectTimeout=${DEFAULT_SSH_CONNECT_TIMEOUT_SEC}`,
        "-p", String(ssh.port || 22),
    ];
    if (ssh.keyPath) args.push("-i", ssh.keyPath);
    return args;
}

/** @param {QemuSsh} ssh */
export function sshDestination(ssh) {
    return `${ssh.user}@${ssh.host}`;
}

/** @param {QemuRuntime|null|undefined} runtime */
export function publicRuntime(runtime) {
    if (!runtime || typeof runtime !== "object") return null;
    return {
        pid: runtime.pid || null,
        command: runtime.command || null,
        startedAt: runtime.startedAt || null,
    };
}

/** @param {QemuGuest|undefined} guest */
export function publicGuest(guest) {
    if (!guest || typeof guest !== "object" || (!guest.ssh && !guest.agent)) return undefined;
    const ssh = guest.ssh && typeof guest.ssh === "object"
        ? {
            host: guest.ssh.host,
            port: guest.ssh.port,
            user: guest.ssh.user,
            keyConfigured: Boolean(guest.ssh.keyPath),
            readinessCommandConfigured: Boolean(guest.ssh.readinessCommand),
        }
        : null;
    const agent = guest.agent && typeof guest.agent === "object"
        ? {
            name: guest.agent.name,
            protocol: guest.agent.protocol,
            healthCommandConfigured: Boolean(guest.agent.healthCommand),
            provisionCommandConfigured: Boolean(guest.agent.provisionCommand),
            autoProvision: guest.agent.autoProvision === true,
            lastStatus: guest.agent.lastStatus || null,
            lastProvision: guest.agent.lastProvision || null,
        }
        : null;
    const result = /** @type {QemuGuest} */ ({ ...guest });
    if (ssh) result.ssh = ssh;
    else delete result.ssh;
    if (agent) result.agent = agent;
    else delete result.agent;
    return result;
}

/** @param {QemuLab} lab */
export function publicLab(lab) {
    const readiness = lab.runtimeState === "running"
        ? lab.readiness
        : lab.readiness ? { ...lab.readiness, latest: null } : lab.readiness;
    const result = {
        ...lab,
        readiness,
        runtime: publicRuntime(lab.runtime),
    };
    const guest = publicGuest(lab.guest);
    if (guest !== undefined) result.guest = guest;
    else delete result.guest;
    return result;
}

/** @param {QemuMaterializedResult|null|undefined} result */
export function publicMaterializedResult(result) {
    if (!result || typeof result !== "object") return result;
    return result.lab ? { ...result, lab: publicLab(result.lab) } : result;
}

/** @param {unknown} args */
export function publicQemuArgs(args) {
    if (!Array.isArray(args)) return args;
    return args.map((arg, index) => {
        if (args[index - 1] === "-monitor") return "unix:<provider-internal-monitor>,server,nowait";
        if (typeof arg === "string" && arg.includes("qemu-monitor.sock")) return arg.replace(/unix:[^,]+qemu-monitor\.sock/, "unix:<provider-internal-monitor>");
        return arg;
    });
}

/** @param {QemuExecution|null|undefined} result */
export function publicExecution(result) {
    if (!result || typeof result !== "object") return result;
    return {
        ...result,
        args: publicQemuArgs(result.args),
    };
}

/** @param {unknown} value @param {QemuLab} lab @param {QemuSsh} ssh @param {(string|null|undefined)[]} [extraProviderPaths] */
export function redactProviderString(value, lab, ssh, extraProviderPaths = []) {
    if (typeof value !== "string") return value;
    let next = value;
    const providerPaths = (/** @type {string[]} */ ([
        ssh?.keyPath,
        lab?.paths?.labDir,
        lab?.paths?.workspaceDir,
        lab?.paths?.artifactsDir,
        lab?.paths?.snapshotsDir,
        lab?.paths?.exportsDir,
        ...extraProviderPaths,
    ].filter(Boolean))).sort((left, right) => right.length - left.length);
    for (const providerPath of providerPaths) {
        next = next.split(providerPath).join("<provider-internal>");
    }
    return next;
}

/** @param {QemuExecution|null|undefined} result @param {QemuLab} lab @param {QemuSsh} ssh @param {(string|null|undefined)[]} [extraProviderPaths] */
export function publicGuestExecResult(result, lab, ssh, extraProviderPaths = []) {
    if (!result || typeof result !== "object") return result;
    return {
        ok: result.ok === true,
        status: result.status ?? null,
        stdout: redactProviderString(result.stdout || "", lab, ssh, extraProviderPaths),
        stderr: redactProviderString(result.stderr || "", lab, ssh, extraProviderPaths),
    };
}

/** @param {unknown} result @returns {QemuAgentStatus} */
export function publicReadinessProbeResult(result) {
    if (!result || typeof result !== "object") return {};
    const stripKeys = new Set(["args", "argv", "command", "providerArgs", "socketPath"]);
    /** @param {unknown} value @returns {unknown} */
    const sanitize = (value) => {
        if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value)
                .filter(([key]) => !stripKeys.has(key))
                .map(([key, entry]) => [key, sanitize(entry)]));
        }
        if (typeof value === "string") {
            let next = value;
            if (next.includes("qemu-monitor.sock")) {
                next = next.replace(/unix:[^,\s]+qemu-monitor\.sock/g, "unix:<provider-internal-monitor>");
            }
            if (/\/[^\s"'<>]+/.test(next)) {
                next = next.replace(/\/[^\s"'<>]+/g, "<provider-internal>");
            }
            if (/^-/.test(next) || next.startsWith("file=/") || next.startsWith("/")) {
                return "<provider-internal>";
            }
            return next;
        }
        return value;
    };
    return /** @type {QemuAgentStatus} */ (sanitize(result));
}

/** @param {QemuLab} lab @returns {{ok:true}|{ok:false,error:string,labId:string}} */
export function requireRunningLab(lab) {
    if (lab.runtimeState !== "running") return { ok: false, error: "lab-not-running", labId: lab.id };
    return { ok: true };
}
/** @param {unknown} value */
export function qemuLifecycleSlug(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0,64) || ""; }
/** @param {unknown} value */
export function validQemuLabId(value) { return typeof value === "string" && value.length > 0 && value.length <= 128 && value !== "." && value !== ".." && /^[a-zA-Z0-9._-]+$/.test(value); }
