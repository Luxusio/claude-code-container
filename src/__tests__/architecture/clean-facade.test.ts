import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Controller authority: inline original witnesses and current clean modules only.
// Native dependencies are low-level seams; the complete actual workflow executes.
const root = fileURLToPath(new URL("../../../", import.meta.url));
// Immutable original witnesses embedded for fresh-checkout portability.
// Authenticated before implementation; never regenerate these from a candidate.
const oldSource = "// src/clean.ts - Clean stopped containers, images, and volumes\n\nimport { spawnSync } from \"child_process\";\nimport { ensureDockerRunning } from \"./docker.js\";\nimport { runtimeCli } from \"./container-runtime.js\";\nimport { prompt, DOCKER_REGISTRY_IMAGE } from \"./utils.js\";\nimport { getSessionLockClaimsForContainer, withContainerLifecycleLock } from \"./session.js\";\n\nexport interface CleanOptions {\n    volumes?: boolean;   // also remove volumes\n    all?: boolean;       // remove everything including running containers\n    dryRun?: boolean;    // show plan without executing\n    yes?: boolean;       // skip confirmation\n}\n\ninterface ContainerInfo {\n    id: string;\n    name: string;\n    status: string;\n}\n\ninterface ImageInfo {\n    repository: string;\n    id: string;\n    size: string;\n}\n\nfunction listContainers(): ContainerInfo[] {\n    const result = spawnSync(\n        runtimeCli(),\n        [\"ps\", \"-a\", \"--no-trunc\", \"--filter\", \"name=^ccc-\", \"--format\", \"{{.ID}}\\t{{.Names}}\\t{{.Status}}\"],\n        { encoding: \"utf-8\" },\n    );\n    const out = (result.stdout ?? \"\").trim();\n    if (!out) return [];\n    return out.split(\"\\n\").flatMap((line) => {\n        const [id, name, ...rest] = line.split(\"\\t\");\n        const normalizedId = (id ?? \"\").trim();\n        const normalizedName = (name ?? \"\").trim();\n        if (!/^[a-f0-9]{12,64}$/i.test(normalizedId) || !normalizedName.startsWith(\"ccc-\")) return [];\n        return [{ id: normalizedId, name: normalizedName, status: rest.join(\"\\t\").trim() }];\n    });\n}\n\nfunction listImages(): ImageInfo[] {\n    const seen = new Set<string>();\n    const images: ImageInfo[] = [];\n\n    for (const repo of [\"ccc\", DOCKER_REGISTRY_IMAGE]) {\n        const result = spawnSync(\n            runtimeCli(),\n            [\"images\", \"--format\", \"{{.Repository}}\\t{{.ID}}\\t{{.Size}}\", repo],\n            { encoding: \"utf-8\" },\n        );\n        const out = (result.stdout ?? \"\").trim();\n        if (!out) continue;\n        for (const line of out.split(\"\\n\")) {\n            const parts = line.split(\"\\t\");\n            const id = (parts[1] ?? \"\").trim();\n            if (id && !seen.has(id)) {\n                seen.add(id);\n                images.push({\n                    repository: (parts[0] ?? \"\").trim(),\n                    id,\n                    size: (parts[2] ?? \"\").trim(),\n                });\n            }\n        }\n    }\n    return images;\n}\n\nfunction listVolumes(): string[] {\n    const result = spawnSync(\n        runtimeCli(),\n        [\"volume\", \"ls\", \"--filter\", \"name=^ccc-\", \"--format\", \"{{.Name}}\"],\n        { encoding: \"utf-8\" },\n    );\n    const out = (result.stdout ?? \"\").trim();\n    if (!out) return [];\n    return out.split(\"\\n\").map((v) => v.trim()).filter(Boolean);\n}\n\nexport async function cleanContainers(options: CleanOptions): Promise<void> {\n    ensureDockerRunning();\n\n    const allContainers = listContainers();\n    const images = listImages();\n    const volumes = options.volumes || options.all ? listVolumes() : [];\n\n    // Determine which containers to remove\n    let containersToStop: ContainerInfo[] = [];\n    let containersToRemove: ContainerInfo[] = [];\n\n    if (options.all) {\n        // Remove everything including running containers\n        containersToStop = allContainers.filter((c) =>\n            c.status.toLowerCase().startsWith(\"up\"),\n        );\n        containersToRemove = allContainers;\n    } else {\n        // Default: only stopped containers\n        containersToRemove = allContainers.filter(\n            (c) => !c.status.toLowerCase().startsWith(\"up\"),\n        );\n    }\n\n    const hasWork =\n        containersToRemove.length > 0 ||\n        images.length > 0 ||\n        volumes.length > 0;\n\n    if (!hasWork) {\n        console.log(\"Nothing to clean.\");\n        return;\n    }\n\n    // Print plan\n    if (containersToStop.length > 0) {\n        console.log(\"\\nContainers to stop:\");\n        for (const c of containersToStop) {\n            console.log(`  ${c.name}  (${c.status})`);\n        }\n    }\n    if (containersToRemove.length > 0) {\n        console.log(\"\\nContainers to remove:\");\n        for (const c of containersToRemove) {\n            console.log(`  ${c.name}  (${c.status})`);\n        }\n    }\n    if (images.length > 0) {\n        console.log(\"\\nImages to remove:\");\n        for (const img of images) {\n            console.log(`  ${img.repository}  ${img.id}  (${img.size})`);\n        }\n    }\n    if (volumes.length > 0) {\n        console.log(\"\\nVolumes to remove:\");\n        for (const v of volumes) {\n            console.log(`  ${v}`);\n        }\n    }\n\n    if (options.dryRun) {\n        console.log(\"\\n(dry run - no changes made)\");\n        return;\n    }\n\n    // Confirm unless --yes\n    if (!options.yes) {\n        const answer = await prompt(\"\\nProceed? [y/N] \", true);\n        if (answer !== \"y\" && answer !== \"yes\") {\n            console.log(\"Aborted.\");\n            return;\n        }\n    }\n\n    let removed = 0;\n\n    const cli = runtimeCli();\n\n    const stopNames = new Set(containersToStop.map((container) => container.name));\n    for (const c of containersToRemove) {\n        const containerPrefix = c.name.startsWith(\"ccc-\") ? c.name.slice(\"ccc-\".length) : \"\";\n        if (!containerPrefix) throw new Error(`Refusing to clean unmanaged container name: ${c.name}`);\n        withContainerLifecycleLock(containerPrefix, () => {\n            const sessionClaims = getSessionLockClaimsForContainer(containerPrefix);\n            if (sessionClaims.length > 0) {\n                console.log(`Skipping ${c.name}: ${sessionClaims.length} CCC session ownership claim(s).`);\n                return;\n            }\n            if (stopNames.has(c.name)) {\n                console.log(`Stopping ${c.name}...`);\n                const stopped = spawnSync(cli, [\"stop\", c.id], { stdio: \"inherit\" });\n                if (stopped.error || stopped.status !== 0) {\n                    throw new Error(`Failed to stop container ${c.name}; cleanup aborted.`);\n                }\n            }\n            console.log(`Removing container ${c.name}...`);\n            const r = spawnSync(cli, [\"rm\", c.id], { stdio: \"inherit\" });\n            if (r.error || r.status !== 0) {\n                throw new Error(`Failed to remove container ${c.name}; cleanup aborted.`);\n            }\n            removed++;\n        });\n    }\n\n    // Remove images\n    for (const img of images) {\n        console.log(`Removing image ${img.repository} (${img.id})...`);\n        const r = spawnSync(cli, [\"rmi\", img.id], { stdio: \"inherit\" });\n        if (r.error || r.status !== 0) {\n            throw new Error(`Failed to remove image ${img.repository}; cleanup aborted.`);\n        }\n        removed++;\n    }\n\n    // Remove volumes\n    for (const v of volumes) {\n        console.log(`Removing volume ${v}...`);\n        const r = spawnSync(cli, [\"volume\", \"rm\", v], { stdio: \"inherit\" });\n        if (r.error || r.status !== 0) {\n            throw new Error(`Failed to remove volume ${v}; cleanup aborted.`);\n        }\n        removed++;\n    }\n\n    console.log(`\\nDone. Removed ${removed} item(s).`);\n    process.exit(0);\n}\n";
const oldEmitted = "// src/clean.ts - Clean stopped containers, images, and volumes\nimport { spawnSync } from \"child_process\";\nimport { ensureDockerRunning } from \"./docker.js\";\nimport { runtimeCli } from \"./container-runtime.js\";\nimport { prompt, DOCKER_REGISTRY_IMAGE } from \"./utils.js\";\nimport { getSessionLockClaimsForContainer, withContainerLifecycleLock } from \"./session.js\";\nfunction listContainers() {\n    const result = spawnSync(runtimeCli(), [\"ps\", \"-a\", \"--no-trunc\", \"--filter\", \"name=^ccc-\", \"--format\", \"{{.ID}}\\t{{.Names}}\\t{{.Status}}\"], { encoding: \"utf-8\" });\n    const out = (result.stdout ?? \"\").trim();\n    if (!out)\n        return [];\n    return out.split(\"\\n\").flatMap((line) => {\n        const [id, name, ...rest] = line.split(\"\\t\");\n        const normalizedId = (id ?? \"\").trim();\n        const normalizedName = (name ?? \"\").trim();\n        if (!/^[a-f0-9]{12,64}$/i.test(normalizedId) || !normalizedName.startsWith(\"ccc-\"))\n            return [];\n        return [{ id: normalizedId, name: normalizedName, status: rest.join(\"\\t\").trim() }];\n    });\n}\nfunction listImages() {\n    const seen = new Set();\n    const images = [];\n    for (const repo of [\"ccc\", DOCKER_REGISTRY_IMAGE]) {\n        const result = spawnSync(runtimeCli(), [\"images\", \"--format\", \"{{.Repository}}\\t{{.ID}}\\t{{.Size}}\", repo], { encoding: \"utf-8\" });\n        const out = (result.stdout ?? \"\").trim();\n        if (!out)\n            continue;\n        for (const line of out.split(\"\\n\")) {\n            const parts = line.split(\"\\t\");\n            const id = (parts[1] ?? \"\").trim();\n            if (id && !seen.has(id)) {\n                seen.add(id);\n                images.push({\n                    repository: (parts[0] ?? \"\").trim(),\n                    id,\n                    size: (parts[2] ?? \"\").trim(),\n                });\n            }\n        }\n    }\n    return images;\n}\nfunction listVolumes() {\n    const result = spawnSync(runtimeCli(), [\"volume\", \"ls\", \"--filter\", \"name=^ccc-\", \"--format\", \"{{.Name}}\"], { encoding: \"utf-8\" });\n    const out = (result.stdout ?? \"\").trim();\n    if (!out)\n        return [];\n    return out.split(\"\\n\").map((v) => v.trim()).filter(Boolean);\n}\nexport async function cleanContainers(options) {\n    ensureDockerRunning();\n    const allContainers = listContainers();\n    const images = listImages();\n    const volumes = options.volumes || options.all ? listVolumes() : [];\n    // Determine which containers to remove\n    let containersToStop = [];\n    let containersToRemove = [];\n    if (options.all) {\n        // Remove everything including running containers\n        containersToStop = allContainers.filter((c) => c.status.toLowerCase().startsWith(\"up\"));\n        containersToRemove = allContainers;\n    }\n    else {\n        // Default: only stopped containers\n        containersToRemove = allContainers.filter((c) => !c.status.toLowerCase().startsWith(\"up\"));\n    }\n    const hasWork = containersToRemove.length > 0 ||\n        images.length > 0 ||\n        volumes.length > 0;\n    if (!hasWork) {\n        console.log(\"Nothing to clean.\");\n        return;\n    }\n    // Print plan\n    if (containersToStop.length > 0) {\n        console.log(\"\\nContainers to stop:\");\n        for (const c of containersToStop) {\n            console.log(`  ${c.name}  (${c.status})`);\n        }\n    }\n    if (containersToRemove.length > 0) {\n        console.log(\"\\nContainers to remove:\");\n        for (const c of containersToRemove) {\n            console.log(`  ${c.name}  (${c.status})`);\n        }\n    }\n    if (images.length > 0) {\n        console.log(\"\\nImages to remove:\");\n        for (const img of images) {\n            console.log(`  ${img.repository}  ${img.id}  (${img.size})`);\n        }\n    }\n    if (volumes.length > 0) {\n        console.log(\"\\nVolumes to remove:\");\n        for (const v of volumes) {\n            console.log(`  ${v}`);\n        }\n    }\n    if (options.dryRun) {\n        console.log(\"\\n(dry run - no changes made)\");\n        return;\n    }\n    // Confirm unless --yes\n    if (!options.yes) {\n        const answer = await prompt(\"\\nProceed? [y/N] \", true);\n        if (answer !== \"y\" && answer !== \"yes\") {\n            console.log(\"Aborted.\");\n            return;\n        }\n    }\n    let removed = 0;\n    const cli = runtimeCli();\n    const stopNames = new Set(containersToStop.map((container) => container.name));\n    for (const c of containersToRemove) {\n        const containerPrefix = c.name.startsWith(\"ccc-\") ? c.name.slice(\"ccc-\".length) : \"\";\n        if (!containerPrefix)\n            throw new Error(`Refusing to clean unmanaged container name: ${c.name}`);\n        withContainerLifecycleLock(containerPrefix, () => {\n            const sessionClaims = getSessionLockClaimsForContainer(containerPrefix);\n            if (sessionClaims.length > 0) {\n                console.log(`Skipping ${c.name}: ${sessionClaims.length} CCC session ownership claim(s).`);\n                return;\n            }\n            if (stopNames.has(c.name)) {\n                console.log(`Stopping ${c.name}...`);\n                const stopped = spawnSync(cli, [\"stop\", c.id], { stdio: \"inherit\" });\n                if (stopped.error || stopped.status !== 0) {\n                    throw new Error(`Failed to stop container ${c.name}; cleanup aborted.`);\n                }\n            }\n            console.log(`Removing container ${c.name}...`);\n            const r = spawnSync(cli, [\"rm\", c.id], { stdio: \"inherit\" });\n            if (r.error || r.status !== 0) {\n                throw new Error(`Failed to remove container ${c.name}; cleanup aborted.`);\n            }\n            removed++;\n        });\n    }\n    // Remove images\n    for (const img of images) {\n        console.log(`Removing image ${img.repository} (${img.id})...`);\n        const r = spawnSync(cli, [\"rmi\", img.id], { stdio: \"inherit\" });\n        if (r.error || r.status !== 0) {\n            throw new Error(`Failed to remove image ${img.repository}; cleanup aborted.`);\n        }\n        removed++;\n    }\n    // Remove volumes\n    for (const v of volumes) {\n        console.log(`Removing volume ${v}...`);\n        const r = spawnSync(cli, [\"volume\", \"rm\", v], { stdio: \"inherit\" });\n        if (r.error || r.status !== 0) {\n            throw new Error(`Failed to remove volume ${v}; cleanup aborted.`);\n        }\n        removed++;\n    }\n    console.log(`\\nDone. Removed ${removed} item(s).`);\n    process.exit(0);\n}\n";
const originalWitnessHashes = { source: "376e491cee0d1dacc85a7cd4351e67451454dc4e0215bd334106ccf464f32950", emitted: "1f7f98631ae9c9cb675164488a1d936cad667e6634d477941628c146d73bc12f" };
const ids = ["111111111111", "222222222222", "333333333333"];
type Options = { volumes?: boolean; all?: boolean; dryRun?: boolean; yes?: boolean };
type Scenario = {
    options?: Options; containers?: string | null; images?: (string | null)[]; volumes?: string | null;
    answer?: unknown; claims?: string[]; failure?: string; inventoryFailure?: number;
    status?: unknown; returnedError?: unknown; faultAt?: string; registry?: string;
    lateRuntime?: boolean; duplicateClaimsLength?: boolean; mutateOptions?: boolean;
    recordGetters?: boolean; recordFault?: string;
};
type Trace = unknown[];
function fixture(source: string, mode: Scenario = {}, emittedRoot?: string) {
    const trace: Trace = []; const fault = { raw: "fault" }; let denied = 0, probes = 0, runtime = "inventory", currentSpawn = 0;
    const deny = (site: string): never => { denied++; throw new Error(`Denied native effect: ${site}`); };
    const deniedObject = (name: string) => new Proxy({}, { get: (_target, key) => deny(`${name}.${String(key)}`), set: () => deny(name) });
    const consoleObject: Record<string, unknown> = {};
    let logger = 0;
    Object.defineProperty(consoleObject, "log", { get() {
        trace.push("log:get"); if (mode.faultAt === "log:get") throw fault;
        const selected = logger++;
        return function(this: unknown, text: string) { trace.push(["log", text, this === consoleFence, selected]); if (mode.faultAt === "log:call") throw fault; };
    } });
    const consoleFence = new Proxy(consoleObject, { get: (target, key) => key === "log" ? Reflect.get(target, key) : deny(`console.${String(key)}`) });
    // The original console receiver is the exposed console, including accessor replacements.
    Object.defineProperty(consoleObject, "log", { configurable: false });
    const output: Record<string, unknown> = {};
    const children = new Map<string, Record<string, unknown>>();
    const inventoryRaw = (kind: string, stdout: string | null | undefined) => {
        const ordinal = ++probes;
        return {
            get error() { trace.push(["admission", ordinal, "error"]); if (mode.faultAt === `inventory:${ordinal}:error`) throw fault; return ordinal === mode.inventoryFailure ? mode.returnedError : undefined; },
            get status() { trace.push(["admission", ordinal, "status"]); if (mode.faultAt === `inventory:${ordinal}:status`) throw fault; return ordinal === mode.inventoryFailure ? mode.status : 0; },
            get stdout() {
                trace.push(["stdout", ordinal, kind]); if (mode.faultAt === `inventory:${ordinal}:stdout`) throw fault;
                // Raw native carrier adversary, not a copied parser: the actual
                // old/new flatMap callback constructs each actual record. The
                // allocated returned array only adds observable field access.
                if (kind === "containers" && mode.recordGetters) return { trim: () => ({ split: () => ({ flatMap: (callback: (line: string) => Record<string, unknown>[]) => String(stdout).split("\n").flatMap(callback).map(record => new Proxy(record, { get(target, field) {
                    trace.push(["record:get", field]);
                    if (field === mode.recordFault) throw fault;
                    if (field === "id") currentSpawn += 10;
                    if (field === "name") logger += 10;
                    return Reflect.get(target, field);
                } })) }) }) };
                return stdout;
            },
            get stderr() { return deny("unconsumed stderr"); },
        };
    };
    const native: Record<string, Record<string, unknown>> = {
        "child_process": {},
        "./docker.js": { ensureDockerRunning: () => { trace.push("ready"); if (mode.faultAt === "ready") throw fault; } },
        "./container-runtime.js": { runtimeCli: () => { trace.push(["runtime", runtime]); if (mode.faultAt === "runtime") throw fault; currentSpawn++; return runtime; } },
        "./utils.js": { prompt: async (question: string, lowercase: boolean) => { trace.push(["prompt", question, lowercase]); if (mode.faultAt === "prompt") throw fault; if (mode.lateRuntime) runtime = "confirmed"; return mode.answer ?? "yes"; } },
        "./session.js": {
            withContainerLifecycleLock: (prefix: string, operation: () => unknown) => { trace.push(["lock:enter", prefix]); if (mode.faultAt === "lock") throw fault; const result = operation(); expect(result).toBeUndefined(); trace.push(["lock:leave", prefix]); },
            getSessionLockClaimsForContainer: (prefix: string) => { trace.push(["claims", prefix]); if (mode.faultAt === "claims") throw fault;
                const claims = mode.claims ?? [];
                return mode.duplicateClaimsLength ? new Proxy(claims, { get(target, key) { if (key === "length") trace.push("claims:length"); return Reflect.get(target, key); } }) : claims;
            },
        },
    };
    Object.defineProperty(native["./utils.js"], "DOCKER_REGISTRY_IMAGE", { get() { trace.push("registry:get"); if (mode.faultAt === "registry") throw fault; return mode.registry ?? "registry/ccc"; } });
    Object.defineProperty(native.child_process, "spawnSync", { get() {
        trace.push("spawn:get"); if (mode.faultAt === "spawn:get") throw fault; const selected = currentSpawn;
        return function(this: unknown, cli: string, args: string[], options: unknown) {
            trace.push(["spawn", cli, [...args], options, this === native.child_process, selected]);
            if (mode.faultAt === `spawn:${args[0]}`) throw fault;
            if (args[0] === "ps") return inventoryRaw("containers", mode.containers ?? `${ids[0]}\tccc-running\tUp 2 minutes\n${ids[1]}\tccc-stopped\tExited (0)`);
            if (args[0] === "images") return inventoryRaw("images", (mode.images ?? ["ccc\timage-a\t1MB", "registry/ccc\timage-a\t9MB\nregistry/ccc\timage-b\t2MB"])[probes - 1]);
            if (args[0] === "volume" && args[1] === "ls") return inventoryRaw("volumes", mode.volumes ?? "ccc-cache\nccc-cache");
            return { get error() { trace.push(["mutation:error", args]); if (mode.faultAt === "mutation:error") throw fault; return undefined; }, get status() { trace.push(["mutation:status", args]); if (mode.faultAt === "mutation:status") throw fault; return args.join(" ") === mode.failure ? 7 : 0; } };
        };
    } });
    const allowed = new Set(["application/clean.ts", "domain/clean.ts", "ports/clean.ts", "application/clean.js", "domain/clean.js", "ports/clean.js"]);
    const processFence = new Proxy({}, { get: (_target, key) => key === "exit" ? (code: number) => { if (code !== 0) return deny(`unapproved exit ${code}`); trace.push(["exit", code]); if (mode.faultAt === "exit") throw fault; } : deny(`process.${String(key)}`) });
    const globals = { console: consoleFence, process: processFence, Buffer: deniedObject("Buffer"), fetch: () => deny("fetch"), setTimeout: () => deny("setTimeout"), setInterval: () => deny("setInterval"), setImmediate: () => deny("setImmediate"), require: () => deny("global require") };
    function load(text: string, file: string, exports: Record<string, unknown>) {
        const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        const requireModule = (specifier: string): unknown => {
            const key = specifier.replace(/^node:/, "");
            if (native[key]) return native[key];
            const absolute = resolve(dirname(file), specifier);
            const relative = absolute.slice(resolve(emittedRoot ?? resolve(root, "src")).length + 1);
            const sourcePath = emittedRoot ? relative : relative.replace(/\.js$/, ".ts");
            if (!allowed.has(sourcePath)) return deny(`import ${specifier}`);
            if (!children.has(absolute)) {
                const child = {}; children.set(absolute, child);
                load(readFileSync(resolve(emittedRoot ?? resolve(root, "src"), sourcePath), "utf8"), absolute, child);
            }
            return children.get(absolute);
        };
        // Deny defaults are installed before evaluating any actual module body.
        runInNewContext(compiled, { ...globals, exports, require: requireModule }, { filename: file, timeout: 1000 });
    }
    try { load(source, resolve(emittedRoot ?? resolve(root, "src"), "clean.js"), output); }
    finally { expect(denied, "module initialization must have zero forbidden attempts").toBe(0); }
    const clean = output.cleanContainers as (options: Options) => Promise<void>;
    async function run(options = mode.options ?? { all: true, yes: true }) {
        let error: unknown;
        try {
            expect(clean.name).toBe("cleanContainers"); expect(clean.length).toBe(1);
            const pending = clean(options); trace.push("caller:returned");
            void Promise.resolve().then(() => { trace.push("caller:microtask-1"); }).then(() => { trace.push("caller:microtask-2"); });
            await pending; trace.push("caller:settled");
        } catch (caught) { error = caught; trace.push("caller:rejected"); }
        finally { expect(denied, "every successful or thrown subject case must have zero forbidden attempts").toBe(0); }
        return { trace, error, fault };
    }
    return { run, trace, fault, denied: () => denied, negativeControl: (script: string) => runInNewContext(script, globals, { timeout: 1000 }) };
}
function comparable(trace: Trace) {
    // ONLY the newly mandated inventory error/status observations differ intentionally.
    return trace.filter(event => !(Array.isArray(event) && event[0] === "admission"))
        .map(event => Array.isArray(event) && event[0] === "log" ? event.slice(0, 3) : event);
}
function mutationArgs(trace: Trace) {
    return trace.filter((event): event is unknown[] => Array.isArray(event) && event[0] === "spawn")
        .map(event => event[2] as string[]).filter(args => ["stop", "rm", "rmi"].includes(args[0]) || args[0] === "volume" && args[1] === "rm");
}
const candidateSource = () => readFileSync(resolve(root, "src/clean.ts"), "utf8");
const scenarios: [string, Scenario][] = [
    ["default", { options: { yes: true } }], ["all", {}], ["volumes", { options: { volumes: true, yes: true } }],
    ["dry-run", { options: { all: true, dryRun: true } }], ["decline", { options: {}, answer: "n" }],
    ["prompt-y", { options: { all: true }, answer: "y" }], ["late-runtime", { options: { all: true }, lateRuntime: true }],
    ["raw-claims", { claims: ["unknown.profile-old.lock"] }], ["stop-failure", { failure: `stop ${ids[0]}` }],
    ["remove-failure", { failure: `rm ${ids[1]}` }], ["image-failure", { failure: "rmi image-b" }],
    ["volume-failure", { failure: "volume rm ccc-cache" }], ["empty", { containers: "", images: ["", ""], volumes: "" }],
    ["malformed", { containers: "bad\tccc-bad\tUp\n111111111111\tforeign\tExited", images: ["", ""], volumes: "" }],
    ["same-repository", { registry: "ccc" }],
    ["record-getters", { recordGetters: true }], ["record-id-throw", { recordGetters: true, recordFault: "id" }],
    ["record-name-throw", { recordGetters: true, recordFault: "name" }], ["record-status-throw", { recordGetters: true, recordFault: "status" }],
    ["repeated-claim-length", { claims: ["raw.lock"], duplicateClaimsLength: true }],
    ...["ready", "prompt", "lock", "claims", "registry", "spawn:get", "spawn:rm", "mutation:error", "mutation:status", "log:get", "log:call", "exit"].map(site => [`fault-${site}`, { options: { all: true }, faultAt: site }] as [string, Scenario]),
];
describe("actual clean facade source and immutable original/emitted success parity", () => {
    it("authenticates embedded original source and complete emitted witnesses", () => {
        expect(createHash("sha256").update(oldSource).digest("hex")).toBe(originalWitnessHashes.source);
        expect(createHash("sha256").update(oldEmitted).digest("hex")).toBe(originalWitnessHashes.emitted);
    });
    it.each(scenarios)("preserves complete ordered observations/effects: %s", async (_name, scenario) => {
        const baseline = await fixture(oldSource, scenario).run();
        const emitted = await fixture(oldEmitted, scenario).run();
        const candidate = await fixture(candidateSource(), scenario).run();
        expect(comparable(emitted.trace)).toEqual(comparable(baseline.trace));
        expect(comparable(candidate.trace)).toEqual(comparable(baseline.trace));
        const message = (error: unknown) => error && typeof error === "object" && "message" in error ? error.message : error;
        expect(message(candidate.error)).toEqual(message(baseline.error));
        if (baseline.error === baseline.fault) expect(candidate.error).toBe(candidate.fault);
    });
    it("pins all exact inventory argv/options, first-ID dedupe, sequential deletion and duplicate volumes", async () => {
        const result = await fixture(candidateSource()).run();
        const spawn = result.trace.filter((event): event is unknown[] => Array.isArray(event) && event[0] === "spawn");
        expect(spawn.slice(0, 4).map(event => [event[1], event[2], event[3]])).toEqual([
            ["inventory", ["ps", "-a", "--no-trunc", "--filter", "name=^ccc-", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"], { encoding: "utf-8" }],
            ["inventory", ["images", "--format", "{{.Repository}}\t{{.ID}}\t{{.Size}}", "ccc"], { encoding: "utf-8" }],
            ["inventory", ["images", "--format", "{{.Repository}}\t{{.ID}}\t{{.Size}}", "registry/ccc"], { encoding: "utf-8" }],
            ["inventory", ["volume", "ls", "--filter", "name=^ccc-", "--format", "{{.Name}}"], { encoding: "utf-8" }],
        ]);
        expect(mutationArgs(result.trace)).toEqual([["stop", ids[0]], ["rm", ids[0]], ["rm", ids[1]], ["rmi", "image-a"], ["rmi", "image-b"], ["volume", "rm", "ccc-cache"], ["volume", "rm", "ccc-cache"]]);
        expect(spawn.slice(4).every(event => JSON.stringify(event[3]) === JSON.stringify({ stdio: "inherit" }))).toBe(true);
        expect(result.trace).toContainEqual(["log", "\nDone. Removed 6 item(s).", true, expect.any(Number)]);
    });
    it.each(["veto", "default-running", "failed-stop", "first-failure"])("uses exact-ID destructive denial oracle: %s", async mode => {
        const scenario: Scenario = mode === "veto" ? { claims: ["stale-malformed.lock"] } : mode === "default-running" ? { options: { yes: true } } : mode === "failed-stop" ? { failure: `stop ${ids[0]}` } : { failure: `rm ${ids[1]}` };
        const result = await fixture(candidateSource(), scenario).run(); const args = mutationArgs(result.trace);
        if (mode === "veto") expect(args.filter(arg => ["stop", "rm"].includes(arg[0]))).toEqual([]);
        if (mode === "default-running") { expect(args).not.toContainEqual(["stop", ids[0]]); expect(args).not.toContainEqual(["rm", ids[0]]); expect(args).toContainEqual(["rm", ids[1]]); }
        if (mode === "failed-stop") expect(args).toEqual([["stop", ids[0]]]);
        if (mode === "first-failure") expect(args).toEqual([["stop", ids[0]], ["rm", ids[0]], ["rm", ids[1]]]);
    });
    it.each(Array.from({ length: 16 }, (_, mask) => mask))("preserves all option combinations %i", async mask => {
        const options = { volumes: !!(mask & 1), all: !!(mask & 2), dryRun: !!(mask & 4), yes: !!(mask & 8) };
        const a = await fixture(oldSource, { options }).run(); const b = await fixture(candidateSource(), { options }).run();
        expect(comparable(b.trace)).toEqual(comparable(a.trace));
    });
    it("captures native mutation callee before argument getters and logger before row arguments", async () => {
        const result = await fixture(candidateSource(), { recordGetters: true }).run();
        const trace = result.trace;
        for (let i = 0; i < trace.length; i++) {
            if (Array.isArray(trace[i]) && (trace[i] as unknown[])[0] === "record:get" && (trace[i] as unknown[])[1] === "id") expect(trace[i - 1]).toBe("spawn:get");
        }
        const row = trace.findIndex(event => Array.isArray(event) && event[0] === "log" && String(event[1]).startsWith("  ccc-"));
        expect(trace[row - 3]).toBe("log:get"); expect(trace[row - 2]).toEqual(["record:get", "name"]); expect(trace[row - 1]).toEqual(["record:get", "status"]);
        expect(trace.filter(event => Array.isArray(event) && event[0] === "log").every(event => (event as unknown[])[2] === true)).toBe(true);
    });
    it("preserves changing options and their repeated original read sites", async () => {
        const captures = [];
        for (const source of [oldSource, candidateSource()]) {
            const f = fixture(source); let allReads = 0;
            const options = { get volumes() { f.trace.push("options:volumes"); return false; }, get all() { f.trace.push("options:all"); return ++allReads === 1; }, get dryRun() { f.trace.push("options:dryRun"); return false; }, get yes() { f.trace.push("options:yes"); return true; } };
            const result = await f.run(options); captures.push(comparable(result.trace));
        }
        expect(captures[1]).toEqual(captures[0]);
    });
});

describe("REQ-derived intentional fail-closed inventory admission (not original goldens)", () => {
    it.each(["require('node:fs').writeFileSync('/foreign','x')", "require('node:fs/promises').unlink('/foreign')", "require('child_process').spawn('docker')", "require('node:net').connect(1)", "process.kill(1)", "process.exit(9)", "fetch('https://example.invalid')", "setTimeout(() => {}, 1)"])("counts denied negative control even when caught: %s", script => {
        const f = fixture(candidateSource()); f.negativeControl(`try { ${script}; } catch (_) {}`);
        expect(f.denied()).toBe(1);
    });
    it.each([1, 2, 3, 4].flatMap(ordinal => [undefined, null, 1, -1, false, "0"].map(status => ({ ordinal, status }))))("denies failed inventory $ordinal / $status before stdout or downstream effects", async ({ ordinal, status }) => {
        const result = await fixture(candidateSource(), { inventoryFailure: ordinal, status }).run();
        const kind = ordinal === 1 ? "containers" : ordinal === 4 ? "volumes" : "images";
        expect(result.error).toHaveProperty("message", `Failed to list ${kind}; cleanup aborted.`);
        expect(result.trace.filter(event => Array.isArray(event) && event[0] === "stdout" && Number(event[1]) >= ordinal)).toEqual([]);
        expect(result.trace.filter(event => Array.isArray(event) && ["log", "prompt", "lock:enter", "claims", "exit"].includes(String(event[0])))).toEqual([]);
        expect(mutationArgs(result.trace)).toEqual([]);
        expect(result.trace.filter(event => Array.isArray(event) && event[0] === "spawn")).toHaveLength(ordinal);
    });
    it.each([1, 2, 3, 4])("truthy error short-circuits status and stdout for command %i", async ordinal => {
        const result = await fixture(candidateSource(), { inventoryFailure: ordinal, returnedError: { opaque: true }, status: 0 }).run();
        expect(result.trace).toContainEqual(["admission", ordinal, "error"]);
        expect(result.trace).not.toContainEqual(["admission", ordinal, "status"]);
        expect(mutationArgs(result.trace)).toEqual([]);
    });
    it.each([false, 0, "", null, undefined])("falsy returned inventory error %j admits status zero", async returnedError => {
        const result = await fixture(candidateSource(), { inventoryFailure: 2, returnedError, status: 0 }).run();
        expect(result.error).toBeUndefined(); expect(result.trace).toContainEqual(["admission", 2, "status"]); expect(mutationArgs(result.trace)).toContainEqual(["rm", ids[1]]);
    });
    it.each([{ all: true, dryRun: true }, { all: true, yes: true }, { volumes: true, yes: true }])("failure admission precedes dry-run/yes/all effects %j", async options => {
        const result = await fixture(candidateSource(), { options, inventoryFailure: 3, status: 1 }).run();
        expect(result.error).toHaveProperty("message", "Failed to list images; cleanup aborted.");
        expect(result.trace.filter(event => Array.isArray(event) && ["log", "prompt", "lock:enter", "claims", "exit"].includes(String(event[0])))).toEqual([]);
    });
    it.each([1, 2, 3, 4].flatMap(ordinal => ["error", "status", "stdout"].map(field => `inventory:${ordinal}:${field}`)))("propagates admission/raw getter identity: %s", async faultAt => {
        const result = await fixture(candidateSource(), { faultAt }).run();
        expect(result.error).toBe(result.fault); expect(mutationArgs(result.trace)).toEqual([]);
    });
    it("retains original unsafe failed-inventory control separately", async () => {
        const result = await fixture(oldSource, { inventoryFailure: 3, status: 7 }).run();
        expect(mutationArgs(result.trace)).toContainEqual(["rm", ids[1]]);
        expect(result.trace.some(event => Array.isArray(event) && event[0] === "exit")).toBe(true);
    });
});

// Root supplies a complete successful candidate build root; an absent gate stays visible.
const emittedRoot = process.env.CCC_CLEAN_COMPLETE_EMITTED_ROOT;
describe.skipIf(!emittedRoot)("actual complete candidate emitted facade gate", () => {
    it.each(scenarios)("matches original complete emitted workflow: %s", async (_name, scenario) => {
        const baseline = await fixture(oldEmitted, scenario).run();
        const candidate = await fixture(readFileSync(resolve(emittedRoot!, "clean.js"), "utf8"), scenario, emittedRoot).run();
        expect(comparable(candidate.trace)).toEqual(comparable(baseline.trace));
    });
});
