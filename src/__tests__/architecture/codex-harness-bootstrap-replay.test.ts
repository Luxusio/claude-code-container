import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { spawnSync } from "node:child_process";
import { CODEX_HARNESS_BOOTSTRAP } from "../../codex-harness.js";
import { CODEX_HARNESS_DOMAIN_SOURCE } from "../../domain/codex-harness-bootstrap.js";
import { CODEX_HARNESS_APPLICATION_SOURCE } from "../../application/codex-harness-bootstrap.js";
import { CODEX_HARNESS_NATIVE_SOURCE } from "../../adapters/codex-harness-bootstrap.js";

// Immutable pre-cutover executable, dfd441622b9117b3b8139bb2b29eb57a56848a19.
// Inline witness keeps normal tests independent of ignored Task artifacts.
const ORIGINAL = "\nimport hashlib, json, os, re, shlex, shutil, signal, subprocess, sys, tempfile, time, tomllib\nfrom pathlib import Path\n\nREVISION = \"90a7afe02a9377d9e20cedd62e2c0d88e426d814\"\nSOURCE = \"https://github.com/Luxusio/harness.git\"\nhome = Path.home() / \".codex\"\nconfig = home / \"config.toml\"\ndeadline = time.monotonic() + 120\n\ndef run(args, cwd):\n    remaining = deadline - time.monotonic()\n    if remaining <= 0:\n        raise RuntimeError(\"installation exceeded 120 seconds\")\n    child = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,\n                             text=True, start_new_session=True)\n    try:\n        out, err = child.communicate(timeout=remaining)\n    except subprocess.TimeoutExpired:\n        os.killpg(child.pid, signal.SIGKILL)\n        child.communicate()\n        raise RuntimeError(\"installation exceeded 120 seconds; stopped installer and children\")\n    if child.returncode:\n        detail = (out + \"\\n\" + err)[-2000:].strip()\n        raise RuntimeError(f\"{args[0]} failed: {detail}\")\n    return out.strip()\n\ndef probe():\n    data = tomllib.loads(config.read_text()) if config.exists() else {}\n    plugins = data.get(\"plugins\", {})\n    plugin = plugins.get(\"harness@harness\")\n    mcp = data.get(\"mcp_servers\", {}).get(\"harness\")\n    market = data.get(\"marketplaces\", {}).get(\"harness\")\n    features = data.get(\"features\", {})\n    if (features.get(\"plugin_hooks\") is False\n        or isinstance(plugin, dict) and plugin.get(\"enabled\") is False\n        or isinstance(mcp, dict) and mcp.get(\"enabled\") is False):\n        return \"disabled\"\n    if plugin is None and mcp is None and market is None and not any(\n        name.startswith(\"harness@\") for name in plugins\n    ):\n        if (home / \"harness\").exists() or (home / \"plugins/cache/harness\").exists():\n            raise RuntimeError(\"existing Harness payload has no registration; preserved\")\n        return \"absent\"\n    # Any existing declaration belongs to the user. Diagnose, never force a merge.\n    if not all(isinstance(value, dict) for value in (plugin, mcp, market)):\n        raise RuntimeError(\"existing Harness registration is incomplete or custom; preserved\")\n    if plugin.get(\"enabled\") is not True or features.get(\"plugin_hooks\") is not True:\n        raise RuntimeError(\"existing Harness plugin/hooks are not enabled; preserved\")\n    source = Path(market.get(\"source\", \"\"))\n    root = source / \"plugins\" / \"harness\"\n    manifest = json.loads((root / \".codex-plugin\" / \"plugin.json\").read_text())\n    version = str(manifest.get(\"version\", \"local\"))\n    if not re.fullmatch(r\"[A-Za-z0-9][A-Za-z0-9._+-]{0,127}\", version):\n        raise RuntimeError(\"invalid Harness plugin version; preserved\")\n    cache = home / \"plugins\" / \"cache\" / \"harness\" / \"harness\" / version\n    required = [source / \".agents/plugins/marketplace.json\", root / \"mcp/harness_server.py\",\n                cache / \".codex-plugin/plugin.json\", cache / \"skills/run/SKILL.md\",\n                cache / \"mcp/harness_server.py\", cache / \"hooks.json\"]\n    args = mcp.get(\"args\", [])\n    command = mcp.get(\"command\", \"\")\n    if not command or not shutil.which(command) or not args or not Path(args[0]).is_file():\n        raise RuntimeError(\"existing Harness MCP command or payload is unavailable; preserved\")\n    if any(not path.is_file() for path in required):\n        raise RuntimeError(\"existing Harness plugin payload is incomplete; preserved\")\n    hooks = json.loads((cache / \"hooks.json\").read_text()).get(\"hooks\", {})\n    trust = data.get(\"hooks\", {}).get(\"state\", {})\n    if not hooks or not any(key.startswith(\"harness@harness:\") for key in trust):\n        raise RuntimeError(\"existing Harness hooks or trust registration is incomplete; preserved\")\n    # Match the pinned official installer's normalized command-hook identity.\n    events = {\"SessionStart\": \"session_start\", \"PreToolUse\": \"pre_tool_use\",\n              \"UserPromptSubmit\": \"user_prompt_submit\", \"PostToolUse\": \"post_tool_use\"}\n    checked = 0\n    for event, groups in hooks.items():\n        for group_index, group in enumerate(groups):\n            for hook_index, hook in enumerate(group.get(\"hooks\", [])):\n                if hook.get(\"type\") == \"command\":\n                    command = shlex.split(hook.get(\"command\", \"\"))\n                    if command and command[0] == \"PYTHONDONTWRITEBYTECODE=1\":\n                        command = command[1:]\n                    if len(command) < 2 or not shutil.which(command[0]) or not Path(command[1]).is_file():\n                        raise RuntimeError(\"existing Harness hook command or payload is unavailable; preserved\")\n                    if event not in events:\n                        raise RuntimeError(\"existing Harness hook event is custom; preserved\")\n                    identity = {\"event_name\": events[event], \"hooks\": [{\n                        \"async\": False, \"command\": hook[\"command\"],\n                        \"timeout\": max(1, int(hook.get(\"timeout\") or 600)), \"type\": \"command\"}]}\n                    if group.get(\"matcher\"):\n                        identity[\"matcher\"] = group[\"matcher\"]\n                    if hook.get(\"statusMessage\"):\n                        identity[\"hooks\"][0][\"statusMessage\"] = hook[\"statusMessage\"]\n                    digest = \"sha256:\" + hashlib.sha256(json.dumps(\n                        identity, sort_keys=True, separators=(\",\", \":\")).encode()).hexdigest()\n                    key = f\"harness@harness:hooks.json:{events[event]}:{group_index}:{hook_index}\"\n                    state = trust.get(key, {})\n                    if state.get(\"trusted_hash\") != digest or state.get(\"enabled\") is False:\n                        raise RuntimeError(\"existing Harness hook trust is missing, stale, or disabled; preserved\")\n                    checked += 1\n    if not checked:\n        raise RuntimeError(\"existing Harness command hooks are missing; preserved\")\n    return \"ready\"\n\ntry:\n    state = probe()\n    if state == \"absent\":\n        print(\"[ccc] Installing Harness for Codex...\", flush=True)\n        with tempfile.TemporaryDirectory(prefix=\"ccc-codex-harness-\") as temp:\n            run([\"git\", \"init\", \"--quiet\", temp], temp)\n            run([\"git\", \"-c\", \"credential.helper=\", \"fetch\", \"--quiet\", \"--depth=1\", SOURCE, REVISION], temp)\n            actual = run([\"git\", \"rev-parse\", \"FETCH_HEAD\"], temp)\n            if actual != REVISION:\n                raise RuntimeError(\"downloaded Harness revision does not match pinned revision\")\n            run([\"git\", \"checkout\", \"--quiet\", \"--detach\", \"FETCH_HEAD\"], temp)\n            run([sys.executable, str(Path(temp) / \"install.py\"), \"--codex-only\"], Path.home())\n        if probe() != \"ready\":\n            raise RuntimeError(\"installer did not produce an enabled Harness registration\")\nexcept Exception as error:\n    print(str(error), file=sys.stderr)\n    sys.exit(1)\n";
const PIN = "90a7afe02a9377d9e20cedd62e2c0d88e426d814";
const allocated: string[] = [];
let emittedBootstrap: string;
beforeAll(() => {
    const emittedRoot = fileURLToPath(new URL("../../../dist/", import.meta.url));
    const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
    const graph = ["codex-harness", "domain/codex-harness", "ports/codex-harness", "application/codex-harness", "adapters/codex-harness", "domain/codex-harness-bootstrap", "ports/codex-harness-bootstrap", "application/codex-harness-bootstrap", "adapters/codex-harness-bootstrap"];
    const allowed = new Set(graph.map(path => join(emittedRoot, path + ".js")));
    for (const path of graph) {
        const actual = join(emittedRoot, path + ".js");
        expect(existsSync(actual), "mandatory genuine current emitted module: " + path).toBe(true);
        const expected = ts.transpileModule(readFileSync(join(sourceRoot, path + ".ts"), "utf8"), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText;
        expect(readFileSync(actual, "utf8").trim(), "current source/emitted provenance: " + path).toBe(expected.trim());
    }
    const denied: string[] = [];
    const refuse = (reason: string): never => { denied.push(reason); throw new Error("emitted import denied " + reason); };
    const forbidden = () => refuse("native effect during emitted graph loading");
    const native = new Map<string, object>([
        [join(emittedRoot, "docker.js"), {prepareCodexConfigForContainer: forbidden, restoreCodexConfigHostOwnership: forbidden}],
        [join(emittedRoot, "codex-config-lock.js"), {withCodexConfigLock: forbidden}],
        [join(emittedRoot, "container-runtime.js"), {runtimeCli: forbidden}],
    ]);
    const cache = new Map<string, Record<string, unknown>>();
    const load = (path: string): Record<string, unknown> => {
        if (!allowed.has(path)) return refuse("module " + path);
        if (cache.has(path)) return cache.get(path)!;
        const exports: Record<string, unknown> = {}; cache.set(path, exports);
        const requireFixture = (specifier: string) => {
            if (specifier === "child_process" || specifier === "node:child_process") return {spawnSync: forbidden};
            if (!specifier.startsWith(".")) return refuse("dependency " + specifier);
            const dependency = resolve(dirname(path), specifier);
            return native.get(dependency) ?? load(dependency);
        };
        const compiled = ts.transpileModule(readFileSync(path, "utf8"), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
        runInNewContext(compiled, {exports, require: requireFixture, console: {error: forbidden, warn: forbidden}}, {filename: path, timeout: 1000});
        return exports;
    };
    try {
        const emitted = load(join(emittedRoot, "codex-harness.js"));
        expect(typeof emitted.CODEX_HARNESS_BOOTSTRAP).toBe("string");
        expect(emitted.CODEX_HARNESS_BOOTSTRAP).toBe(CODEX_HARNESS_BOOTSTRAP);
        emittedBootstrap = emitted.CODEX_HARNESS_BOOTSTRAP as string;
    } finally { expect(denied).toEqual([]); }
});
afterEach(() => { for (const root of allocated.splice(0)) rmSync(root, {recursive: true, force: true}); });
type Hook = {type: string; command?: string; timeout?: unknown; statusMessage?: unknown};
type Group = {hooks: Hook[]; matcher?: unknown};
type Case = {name: string; config?: string; replaceConfig?: [string, string]; version?: unknown; manifest?: string; rawHooks?: string; hooks?: Record<string, Group[]>; trust?: string; missing?: number; missingHook?: boolean; marker?: string; stage?: string; revision?: string; post?: string; deadline?: boolean; killFault?: boolean; drainFault?: boolean; cleanupFault?: boolean; descendantProbe?: boolean; journalProbe?: string; expected?: string};

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

function fixture(test: Case) {
    const allocatedAt = Date.now() / 1000;
    const root = mkdtempSync(join(tmpdir(), "ccc-codex-bootstrap-replay-")); allocated.push(root);
    const home = join(root, "home"); mkdirSync(home); mkdirSync(join(home, "bin")); mkdirSync(join(home, "tmp"));
    const source = join(home, ".codex/harness"), plugin = join(source, "plugins/harness");
    const version = test.version === undefined ? "2.3.0" : test.version;
    const cache = join(home, ".codex/plugins/cache/harness/harness", typeof version === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version) ? version : "2.3.0");
    const command = `/usr/bin/python3 ${join(cache, "scripts/session-start.py")}`;
    const hooks = test.hooks ?? {SessionStart: [{hooks: [{type: "command", command}]}]};
    // Replace a stable fixture token, never candidate-derived trust data.
    const hookText = JSON.stringify(hooks).replaceAll("@COMMAND@", command);
    const normalized = JSON.parse(hookText) as Record<string, Group[]>;
    const eventNames: Record<string, string> = {SessionStart: "session_start", PreToolUse: "pre_tool_use", UserPromptSubmit: "user_prompt_submit", PostToolUse: "post_tool_use"};
    let trust = "";
    for (const [event, groups] of Object.entries(normalized)) for (const [gi, group] of groups.entries()) for (const [hi, hook] of group.hooks.entries()) {
        if (hook.type !== "command" || !(event in eventNames)) continue;
        const timeout = Number(hook.timeout || 600);
        const identity: Record<string, unknown> = {event_name: eventNames[event], hooks: [{async: false, command: hook.command, timeout: Math.max(1, Math.trunc(timeout)), type: "command", ...(hook.statusMessage ? {statusMessage: hook.statusMessage} : {})}]};
        if (group.matcher) identity.matcher = group.matcher;
        const digest = "sha256:" + createHash("sha256").update(canonical(identity)).digest("hex");
        trust += `[hooks.state."harness@harness:hooks.json:${eventNames[event]}:${gi}:${hi}"]\ntrusted_hash = ${JSON.stringify(test.trust === "stale" ? "sha256:stale" : digest)}\n${test.trust === "disabled" ? "enabled = false\n" : test.trust === "zero" ? "enabled = 0\n" : ""}`;
    }
    if (test.trust === "missing") trust = "";
    if (!trust) trust = '[hooks.state."harness@harness:unrelated"]\ntrusted_hash = "none"\n';
    let config = test.config ?? `model = "preserve"\n[plugins."harness@harness"]\nenabled = true\n[features]\nplugin_hooks = true\n[marketplaces.harness]\nsource = ${JSON.stringify(source)}\n[mcp_servers.harness]\ncommand = "/usr/bin/python3"\nargs = [${JSON.stringify(join(plugin, "mcp/harness_server.py"))}]\n${trust}`;
    if (test.replaceConfig) config = config.replace(...test.replaceConfig);
    const required = [join(source, ".agents/plugins/marketplace.json"), join(plugin, "mcp/harness_server.py"), join(cache, ".codex-plugin/plugin.json"), join(cache, "skills/run/SKILL.md"), join(cache, "mcp/harness_server.py"), join(cache, "hooks.json")];
    const files: Record<string, string> = {[join(home, ".codex/config.toml")]: config, [join(plugin, ".codex-plugin/plugin.json")]: test.manifest ?? JSON.stringify({version}), [join(cache, "scripts/session-start.py")]: "# hook\n"};
    for (const path of required) files[path] = path.endsWith("hooks.json") ? (test.rawHooks ?? JSON.stringify({hooks: normalized})) : "{}";
    const write = (path: string, content: string) => { mkdirSync(join(path, ".."), {recursive: true}); writeFileSync(path, content); };
    if (!test.stage && !test.revision && !test.post && !test.deadline && !test.cleanupFault && test.name !== "absent") {
        for (const [path, content] of Object.entries(files)) write(path, content);
        if (test.missing !== undefined) rmSync(required[test.missing]);
        if (test.missingHook) rmSync(join(cache, "scripts/session-start.py"));
        if (test.config === "" && !test.marker) rmSync(join(home, ".codex/harness"), {recursive: true, force: true});
    }
    if (test.marker) mkdirSync(join(home, ".codex", test.marker), {recursive: true});
    const installed = {...files};
    if (test.post === "disabled") installed[join(home, ".codex/config.toml")] = '[features]\nplugin_hooks = false\n';
    if (test.post === "malformed") installed[join(home, ".codex/config.toml")] = "bad = [";
    const installerBody = test.deadline
        ? 'import os,time,pathlib\npid=os.fork()\nif pid == 0:\n pathlib.Path(os.environ["HOME"],"child-pid").write_text(str(os.getpid()))\n time.sleep(30)\nelse:\n pathlib.Path(os.environ["HOME"],"parent-pid").write_text(str(os.getpid()))\n time.sleep(30)\n'
        : `import json,pathlib,sys\nassert sys.argv[1:] == ["--codex-only"]\nassert pathlib.Path.cwd() == pathlib.Path.home()\n${test.stage === "installer" ? 'raise RuntimeError("installer stage")\n' : ""}${test.post === "absent" ? "" : `files=json.loads(${JSON.stringify(JSON.stringify(installed))})\nfor name,contents in files.items():\n p=pathlib.Path(name)\n p.parent.mkdir(parents=True,exist_ok=True)\n p.write_text(contents)\n`}`;
    const journalProbe = test.journalProbe ? `import os,pathlib\nshadow = pathlib.Path.home()/'journal-shadow'\nshadow.write_text('forged history')\nreceipt = pathlib.Path(sitecustomize.authority['receipts'])/(str(os.getpid())+'.jsonl')\ntry:\n os.system('forbidden-journal-probe')\nexcept Exception:\n pass\ntry:\n ${test.journalProbe}\nexcept Exception:\n pass\n` : "";
    const installer = "import sitecustomize\nassert sitecustomize.ready, 'descendant fence missing'\n" + (test.descendantProbe ? "import subprocess\ntry:\n subprocess.Popen(['/usr/bin/true'])\nexcept Exception:\n pass\n" : "") + journalProbe + installerBody;
    writeFileSync(join(home, "installer.py"), installer, {mode: 0o400});
    const git = `#!/usr/bin/python3\nimport sitecustomize\nassert sitecustomize.ready, 'descendant fence missing'\nimport json,os,pathlib,shutil,sys\nh=pathlib.Path.home()\nargs=sys.argv[1:]\nwith (h/"git-calls").open("a") as f:f.write(json.dumps(args)+"\\n")\nkind="fetch" if "fetch" in args else args[0]\nif kind == ${JSON.stringify(test.stage ?? "none")}:\n print("fixture stage failed",file=sys.stderr)\n sys.exit(2)\nif kind == "rev-parse":print(${JSON.stringify(test.revision ?? PIN)})\nif kind == "checkout":shutil.copy(h/"installer.py",pathlib.Path.cwd()/"install.py")\n`;
    writeFileSync(join(home, "bin/git"), git, {mode: 0o500});
    const fenceDirectory = join(root, "interpreter-fence"); mkdirSync(fenceDirectory);
    const receipts = join(root, "descendant-receipts"); mkdirSync(receipts);
    writeFileSync(join(fenceDirectory, "sitecustomize.py"), DESCENDANT_FENCE, {mode: 0o400});
    const authority = (path: string) => { const canonical = realpathSync(path); const stat = statSync(canonical); return {path: canonical, dev: stat.dev, ino: stat.ino, digest: createHash("sha256").update(readFileSync(canonical)).digest("hex")}; };
    const anchorPaths = new Set([root, home, join(home, "bin"), join(home, "tmp"), fenceDirectory, receipts]);
    for (let path = dirname(root); ; path = dirname(path)) { anchorPaths.add(path); if (dirname(path) === path) break; }
    const anchors = [...anchorPaths].map(path => { const stat = statSync(path); return {path: realpathSync(path), dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777}; });
    const manifest = {git: authority(join(home, "bin/git")), installer: authority(join(home, "installer.py")), site: authority(join(fenceDirectory, "sitecustomize.py")), interpreter: authority("/usr/bin/python3"), installerDigest: createHash("sha256").update(installer).digest("hex"), forkAllowed: !!test.deadline, root, home, receipts, fenceDirectory, anchors, born: allocatedAt - 1};
    const environment = {HOME: home, PATH: join(home, "bin"), TMPDIR: join(home, "tmp"), FIXTURE_ROOT: root, FIXTURE_AUTHORITY: JSON.stringify(manifest), PYTHONPATH: fenceDirectory, PYTHONDONTWRITEBYTECODE: "1", ...(test.killFault ? {KILL_FAULT: "1"} : {}), ...(test.drainFault ? {DRAIN_FAULT: "1"} : {}), ...(test.cleanupFault ? {CLEANUP_FAULT: "1"} : {})};
    return {root, home, config, files, environment};
}

// Shared data-only path/identity rules; recording is narrowly bound to an owned writer FD.
// Both interpreters reject mutation of the journal directory, descendants and anchors.
const JOURNAL_GUARD = String.raw`
import stat
anchor_paths = {entry['path'] for entry in authority['anchors']}
protected_paths = {authority[key]['path'] for key in ('git','installer','site')}
def authenticate_anchors():
    for witness in authority['anchors']:
        observed = os.lstat(witness['path'])
        if not stat.S_ISDIR(observed.st_mode) or stat.S_ISLNK(observed.st_mode) or os.path.realpath(witness['path']) != witness['path'] or (observed.st_dev,observed.st_ino,observed.st_uid,stat.S_IMODE(observed.st_mode)) != (witness['dev'],witness['ino'],witness['uid'],witness['mode']):
            raise RuntimeError('sealed journal anchor changed')
def mutation_path(path,dir_fd=-1):
    if isinstance(path,int): raise RuntimeError('unadmitted descriptor mutation')
    text = os.fsdecode(path)
    if dir_fd not in (-1,None):
        observed = os.fstat(dir_fd)
        base = os.readlink('/proc/self/fd/'+str(dir_fd))
        if not stat.S_ISDIR(observed.st_mode) or base.endswith(' (deleted)') or not (base == authority['root'] or base.startswith(authority['root']+os.sep)):
            raise RuntimeError('unowned directory descriptor')
        bound = os.lstat(base)
        if (bound.st_dev,bound.st_ino,bound.st_uid) != (observed.st_dev,observed.st_ino,observed.st_uid): raise RuntimeError('rebound directory descriptor')
        text = os.path.join(base,text)
    elif not os.path.isabs(text):
        raise RuntimeError('unadmitted relative mutation')
    lexical = os.path.normpath(os.path.abspath(text))
    canonical = os.path.realpath(text)
    return lexical,canonical
def journal_protected(path,dir_fd=-1):
    lexical,canonical = mutation_path(path,dir_fd)
    return any(value in anchor_paths or value in protected_paths or value == authority['receipts'] or value.startswith(authority['receipts']+os.sep) for value in (lexical,canonical))
def mutation_operands(event,args):
    if event in ('os.rename','os.link'):
        return [(args[0],args[2]),(args[1],args[3])]
    if event == 'os.symlink': return [(args[0],-1),(args[1],args[2])]
    if event in ('os.remove','os.rmdir'): return [(args[0],args[1])]
    if event in ('os.mkdir','os.chmod'): return [(args[0],args[2])]
    if event == 'os.utime': return [(args[0],args[3])]
    return [(args[0],-1)]
def guarded_mutation(event,args):
    authenticate_anchors()
    for path,dir_fd in mutation_operands(event,args):
        lexical,canonical = mutation_path(path,dir_fd)
        if journal_protected(path,dir_fd) or not (canonical == authority['root'] or canonical.startswith(authority['root']+os.sep)):
            raise RuntimeError('protected or escaped mutation operand')
`;

// Loaded by EVERY fixture interpreter before its script body, including fork children.
// Executable bytes/inodes and this fence itself are authenticated by the parent first.
const DESCENDANT_FENCE = String.raw`
import sys, os, json, pathlib, hashlib, atexit
authority = json.loads(os.environ['FIXTURE_AUTHORITY'])
` + JOURNAL_GUARD + String.raw`
ready = sys.argv[0] == '-'
if sys.argv[0] != '-':
    root = authority['root']
    role = 'git' if os.path.realpath(sys.argv[0]) == authority['git']['path'] else 'installer'
    path = os.path.realpath(sys.argv[0])
    expected = authority['git']['digest'] if role == 'git' else authority['installerDigest']
    if hashlib.sha256(open(path,'rb').read()).hexdigest() != expected:
        raise RuntimeError('descendant executable authentication failed')
    recording_path = None
    writer_pid = None
    writer_fd = None
    writer_identity = None
    sequence = 0
    chain = '0'*64
    def record(value):
        global recording_path,writer_pid,writer_fd,writer_identity,sequence,chain
        authenticate_anchors()
        pid = os.getpid()
        path = os.path.join(authority['receipts'],str(pid)+'.jsonl')
        if writer_pid != pid:
            if writer_fd is not None: os.close(writer_fd)
            recording_path = path
            try: writer_fd = os.open(path,os.O_WRONLY|os.O_APPEND|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
            finally: recording_path = None
            observed = os.fstat(writer_fd)
            writer_identity = (observed.st_dev,observed.st_ino,observed.st_uid,stat.S_IMODE(observed.st_mode))
            writer_pid = pid
            sequence = 0
            chain = '0'*64
        observed = os.fstat(writer_fd)
        bound = os.lstat(path)
        if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1 or observed.st_uid != os.getuid() or writer_identity != (observed.st_dev,observed.st_ino,observed.st_uid,stat.S_IMODE(observed.st_mode)) or writer_identity != (bound.st_dev,bound.st_ino,bound.st_uid,stat.S_IMODE(bound.st_mode)):
            raise RuntimeError('sealed journal writer changed')
        if sequence == 0:
            value = {**value,'journal':{'dev':observed.st_dev,'ino':observed.st_ino,'uid':observed.st_uid,'mode':stat.S_IMODE(observed.st_mode),'nlink':1}}
        payload = {'sequence':sequence,'previous':chain,'event':value}
        canonical = json.dumps(payload,sort_keys=True,separators=(',',':'))
        chain = hashlib.sha256(canonical.encode()).hexdigest()
        encoded = (json.dumps({**payload,'digest':chain},sort_keys=True,separators=(',',':'))+'\n').encode()
        if observed.st_size + len(encoded) > 131072: raise RuntimeError('journal byte bound exceeded')
        view = memoryview(encoded)
        while view:
            written = os.write(writer_fd,view)
            if written <= 0: raise RuntimeError('journal append failed')
            view = view[written:]
        sequence += 1
    def identity():
        with open('/proc/self/stat') as stream: fields = stream.read().rsplit(') ',1)[1].split()
        return {'pid':os.getpid(),'parent':os.getppid(),'start':fields[19],'group':int(fields[2]),'session':int(fields[3]),'role':role}
    record({'identity':identity()})
    def refuse(event,args):
        record({'denied':[event,str(args)]})
        raise RuntimeError('descendant denied '+event)
    def private(path):
        absolute = os.path.realpath(path)
        return absolute == root or absolute.startswith(root + os.sep)
    protected = {authority[key]['path'] for key in ('git','installer','site')}
    def audit(event,args):
        if event.startswith('socket.') or event in ('subprocess.Popen','os.system','os.exec','os.posix_spawn','os.kill','os.killpg'):
            refuse(event,args)
        if event == 'os.fork' and not (role == 'installer' and authority['forkAllowed']): refuse(event,args)
        if event == 'open' and not isinstance(args[0],int):
            path,mode,flags = args
            absolute = os.path.realpath(path)
            writing = flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)
            own_receipt = os.path.join(authority['receipts'],str(os.getpid())+'.jsonl')
            if recording_path == own_receipt and absolute == own_receipt and flags & os.O_EXCL and flags & os.O_NOFOLLOW: return
            if writing:
                try:
                    forbidden = not private(path) or journal_protected(path)
                except RuntimeError: forbidden = True
                if forbidden: refuse(event,args)
            if not writing and not (private(path) or absolute.startswith(('/usr/lib/','/usr/local/lib/')) or absolute == '/proc/'+str(os.getpid())+'/stat'): refuse(event,args)
        if event in ('os.mkdir','os.remove','os.rmdir','os.rename','os.chmod','os.link','os.symlink','os.truncate','os.utime'):
            try: guarded_mutation(event,args)
            except RuntimeError: refuse(event,args)
    sys.addaudithook(audit)
    for method in ('exists','is_file','read_text'):
        selected = getattr(pathlib.Path,method)
        def checked(self,*args,_selected=selected,_method=method,**kwargs):
            if not private(self): refuse('Path.'+_method,str(self))
            return _selected(self,*args,**kwargs)
        setattr(pathlib.Path,method,checked)
    if authority['forkAllowed']:
        os.register_at_fork(after_in_child=lambda: record({'identity':identity()}))
    atexit.register(lambda: record({'finished':True}))
    ready = True
`;

// Runs before executing/importing the target. Native Popen/kill/drain bodies remain real.
// Imports may read the system standard library; target file reads/writes stay private.
const FENCE = String.raw`
import sys, os, json, pathlib, subprocess, tempfile, signal, atexit, time, hashlib, ast
authority = json.loads(os.environ['FIXTURE_AUTHORITY'])
` + JOURNAL_GUARD + String.raw`
root = pathlib.Path(authority['root'])
denied = []
children = []
groups = {}
workspaces = {}
installers = {}
calls = []
actions = []
sealed_environment = dict(os.environ)
journal_history = {}
def refuse(event, args):
    denied.append([event, str(args)])
    raise RuntimeError('fixture denied ' + event)
def private(path):
    p = pathlib.Path(os.path.realpath(path))
    return p == root or root in p.parents
def proc(pid):
    try:
        with open('/proc/'+str(pid)+'/stat') as stream: fields = stream.read().rsplit(') ',1)[1].split()
        return {'pid':int(pid),'state':fields[0],'group':int(fields[2]),'session':int(fields[3]),'start':fields[19]}
    except FileNotFoundError: return None
def descendant_receipts():
    authenticate_anchors()
    members = []
    faults = []
    names = sorted(os.listdir(authority['receipts']))
    if len(names) > 64 or not set(journal_history).issubset(names): raise RuntimeError('journal disappeared or count bound exceeded')
    for name in names:
        if not name.endswith('.jsonl') or not name[:-6].isdigit(): raise RuntimeError('unallocated journal entry')
        path = os.path.join(authority['receipts'],name)
        descriptor = os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            observed = os.fstat(descriptor)
            if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1 or observed.st_uid != os.getuid() or stat.S_IMODE(observed.st_mode) != 0o600 or observed.st_size > 131072: raise RuntimeError('journal file authority failed')
            raw = bytearray()
            while len(raw) <= 131072:
                part = os.read(descriptor,min(8192,131073-len(raw)))
                if not part: break
                raw.extend(part)
            bound = os.lstat(path)
            final = os.fstat(descriptor)
            identity = (observed.st_dev,observed.st_ino,observed.st_uid,observed.st_nlink,stat.S_IMODE(observed.st_mode))
            if identity != (bound.st_dev,bound.st_ino,bound.st_uid,bound.st_nlink,stat.S_IMODE(bound.st_mode)) or identity != (final.st_dev,final.st_ino,final.st_uid,final.st_nlink,stat.S_IMODE(final.st_mode)) or len(raw) != final.st_size or not raw or raw[-1:] != b'\n': raise RuntimeError('journal binding/history incomplete')
        finally: os.close(descriptor)
        previous = journal_history.get(name)
        if previous and (previous['identity'] != identity or not bytes(raw).startswith(previous['bytes'])): raise RuntimeError('journal history was rewritten')
        decoded = []
        chain = '0'*64
        for index,line in enumerate(bytes(raw).splitlines()):
            packet = json.loads(line)
            digest = packet.pop('digest')
            if packet.get('sequence') != index or packet.get('previous') != chain or digest != hashlib.sha256(json.dumps(packet,sort_keys=True,separators=(',',':')).encode()).hexdigest(): raise RuntimeError('journal chain authentication failed')
            chain = digest
            decoded.append(packet['event'])
        first = decoded[0]
        member = first['identity']
        declared = first['journal']
        if (declared['dev'],declared['ino'],declared['uid'],declared['nlink'],declared['mode']) != identity or str(member['pid'])+'.jsonl' != name or member['group'] not in groups or member['session'] != member['group']: raise RuntimeError('journal identity authentication failed')
        leader = groups[member['group']]
        child = next(process for process in children if process.pid == member['group'])
        expected_role = 'git' if child.args[0] == 'git' else 'installer'
        if member['role'] != expected_role or member['pid'] == leader['pid'] and member['start'] != leader['start'] or member['pid'] != leader['pid'] and (not authority['forkAllowed'] or member['role'] != 'installer' or member['parent'] != leader['pid']): raise RuntimeError('journal process lineage failed')
        finished = False
        for event in decoded[1:]:
            if finished or set(event) not in ({'denied'},{'finished'}): raise RuntimeError('unallocated journal record')
            if 'finished' in event:
                if event['finished'] is not True: raise RuntimeError('invalid journal finish')
                finished = True
            if 'denied' in event: faults.append(event['denied'])
        journal_history[name] = {'identity':identity,'bytes':bytes(raw),'member':member,'events':decoded,'chain':chain}
        members.append(member)
    return members, faults
def group_members(group):
    result = []
    for name in os.listdir('/proc'):
        if name.isdigit():
            observed = proc(name)
            if observed and observed['group'] == group: result.append(observed)
    return result
def verified_live_group(group):
    owned = groups.get(group)
    if owned is None: return False, 'unknown group'
    members, unused = descendant_receipts()
    expected = {member['pid']:member for member in members if member['group'] == group}
    # Parent-captured leader birth provides authority even before child bootstrap records it.
    expected[owned['pid']] = owned
    actual = group_members(group)
    for member in actual:
        witness = expected.get(member['pid'])
        if witness is None or member['start'] != witness['start'] or member['session'] != group:
            return False, 'unknown or reused group member'
    if not any(member['state'] not in ('Z','X') for member in actual):
        owned['retired'] = True
        return False, 'retired'
    if owned.get('retired'): return False, 'retired generation cannot be revived'
    return True, 'verified live generation'
def authenticate(key):
    witness = authority[key]
    observed = os.stat(witness['path'])
    if (observed.st_dev,observed.st_ino) != (witness['dev'],witness['ino']): refuse('executable inode',key)
    with open(witness['path'],'rb') as stream: digest = hashlib.sha256(stream.read()).hexdigest()
    if digest != witness['digest']: refuse('executable bytes',key)
def workspace(path):
    absolute = os.path.realpath(path)
    witness = workspaces.get(absolute)
    if witness is None: refuse('unallocated installation workspace',path)
    observed = os.stat(absolute)
    if (observed.st_dev,observed.st_ino) != witness: refuse('workspace inode',path)
    return absolute
protected = {authority[key]['path'] for key in ('git','installer','site')}
def audit(event,args):
    if event.startswith('socket.') or event in ('os.system','os.posix_spawn','os.exec','os.fork','os.kill'):
        refuse(event,args)
    if event == 'open' and not isinstance(args[0],int):
        path,mode,flags = args
        absolute = os.path.realpath(path)
        writing = flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)
        if writing:
            try:
                authenticate_anchors()
                forbidden = not private(path) or journal_protected(path) or os.path.basename(absolute) == 'install.py'
            except RuntimeError: forbidden = True
            if forbidden: refuse(event,args)
        allowed_read = private(path) or absolute.startswith(('/usr/lib/','/usr/local/lib/')) or absolute == authority['interpreter']['path'] or absolute.startswith('/proc/') and absolute.endswith('/stat')
        if not writing and not allowed_read: refuse(event,args)
    if event in ('os.mkdir','os.remove','os.rmdir','os.chmod','os.rename','os.link','os.symlink','os.truncate','os.utime'):
        try: guarded_mutation(event,args)
        except RuntimeError: refuse(event,args)
        if event in ('os.rename','os.link','os.symlink') and os.path.basename(os.path.realpath(args[1])) == 'install.py': refuse(event,args)
    if event == 'subprocess.Popen':
        executable,argsv,cwd,env = args
        if env is not None or dict(os.environ) != sealed_environment: refuse('changed interpreter environment',args)
        authenticate('interpreter')
        authenticate('site')
        if argsv[0] == 'git':
            if executable != 'git': refuse('git selected executable',args)
            authenticate('git')
            valid = False
            if argsv[1:3] == ['init','--quiet'] and len(argsv) == 4:
                absolute = os.path.realpath(argsv[3])
                if not absolute.startswith(os.path.join(authority['home'],'tmp','ccc-codex-harness-')) or os.path.realpath(cwd) != absolute: refuse('git init workspace',args)
                observed = os.stat(absolute)
                workspaces[absolute] = (observed.st_dev,observed.st_ino)
                valid = True
            else:
                workspace(cwd)
                valid = argsv[1:] in (['-c','credential.helper=','fetch','--quiet','--depth=1','https://github.com/Luxusio/harness.git','90a7afe02a9377d9e20cedd62e2c0d88e426d814'], ['rev-parse','FETCH_HEAD'], ['checkout','--quiet','--detach','FETCH_HEAD'])
        else:
            if executable != sys.executable: refuse('installer selected executable',args)
            valid = argsv[0] == sys.executable and len(argsv) == 3 and argsv[2] == '--codex-only' and os.path.realpath(cwd) == authority['home']
            if valid:
                authenticate('installer')
                parent = workspace(os.path.dirname(argsv[1]))
                if os.path.realpath(argsv[1]) != os.path.join(parent,'install.py'): refuse('installer exact allocated path',args)
                with open(argsv[1],'rb') as stream: digest = hashlib.sha256(stream.read()).hexdigest()
                if digest != authority['installerDigest']: refuse('installer exact bytes',args)
                observed = os.stat(argsv[1])
                if installers.get(os.path.realpath(argsv[1])) != (observed.st_dev,observed.st_ino): refuse('installer allocated inode',args)
                actions.append(['installer-auth',True,digest == authority['installerDigest']])
        if not valid: refuse(event,args)
        calls.append([argsv,str(cwd)])
    if event == 'os.killpg':
        verified,reason = verified_live_group(args[0])
        if args[1] != signal.SIGKILL or not verified: refuse('unverified group signal: '+reason,args)
sys.addaudithook(audit)
for method in ('exists','is_file','read_text'):
    selected = getattr(pathlib.Path,method)
    def checked(self,*args,_method=method,_selected=selected,**kwargs):
        if not private(self): refuse('Path.'+_method,str(self))
        return _selected(self,*args,**kwargs)
    setattr(pathlib.Path,method,checked)
real_popen = subprocess.Popen
class OwnedPopen(real_popen):
    def __init__(self,*args,**kwargs):
        if kwargs.get('start_new_session') is not True: refuse('unowned process session',args)
        self.fixture_cwd = os.fspath(kwargs['cwd'])
        super().__init__(*args,**kwargs)
        observed = proc(self.pid)
        if observed is None or observed['group'] != self.pid or observed['session'] != self.pid: refuse('process birth identity',self.pid)
        groups[self.pid] = observed
        children.append(self)
    def communicate(self,*args,**kwargs):
        actions.append(['communicate',children.index(self),'bounded' if 'timeout' in kwargs else 'drain'])
        if os.environ.get('DRAIN_FAULT') and not kwargs: raise RuntimeError('drain fault')
        result = super().communicate(*args,**kwargs)
        if self.returncode == 0 and self.args[:2] == ['git','checkout']:
            path = os.path.join(self.fixture_cwd,'install.py')
            observed = os.stat(path)
            with open(path,'rb') as stream: digest = hashlib.sha256(stream.read()).hexdigest()
            if digest != authority['installerDigest']: refuse('checkout executable bytes',path)
            installers[os.path.realpath(path)] = (observed.st_dev,observed.st_ino)
        verified_live_group(self.pid) # Retire completed generations; never signal historical PIDs.
        return result
subprocess.Popen = OwnedPopen
real_killpg = os.killpg
def killpg(pid,sig):
    actions.append(['killpg',next(i for i,p in enumerate(children) if p.pid == pid),sig])
    if os.environ.get('KILL_FAULT'): raise RuntimeError('kill fault')
    real_killpg(pid,sig)
os.killpg = killpg
real_cleanup = tempfile.TemporaryDirectory.cleanup
def cleanup(self):
    real_cleanup(self)
    if os.environ.get('CLEANUP_FAULT'): raise RuntimeError('cleanup fault')
tempfile.TemporaryDirectory.cleanup = cleanup
def snapshot_owned_tree():
    authenticate_anchors()
    descendant_receipts() # Authenticate complete append history before accounting volatile IDs.
    entries = {}
    inode_paths = {}
    byte_count = 0
    now = time.time()
    def visit(path):
        nonlocal byte_count
        if len(entries) >= 2048: raise RuntimeError('owned tree node bound exceeded')
        observed = os.lstat(path)
        relative = os.path.relpath(path,authority['root'])
        if not private(path) and not stat.S_ISLNK(observed.st_mode): raise RuntimeError('owned tree canonical escape')
        kind = 'directory' if stat.S_ISDIR(observed.st_mode) else 'file' if stat.S_ISREG(observed.st_mode) else 'symlink' if stat.S_ISLNK(observed.st_mode) else 'other'
        value = {'type':kind,'device':'root-device' if observed.st_dev == os.lstat(authority['root']).st_dev else observed.st_dev,'mode':stat.S_IMODE(observed.st_mode),'uid':observed.st_uid,'gid':observed.st_gid,'nlink':observed.st_nlink,'size':observed.st_size if kind != 'directory' else 'directory','times_bounded':all(authority['born'] <= item <= now+1 for item in (observed.st_atime,observed.st_mtime,observed.st_ctime))}
        if kind == 'symlink':
            value['target'] = os.readlink(path)
        elif kind == 'file':
            if observed.st_size > 1048576: raise RuntimeError('owned file byte bound exceeded')
            descriptor = os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
            try:
                held = os.fstat(descriptor)
                if (held.st_dev,held.st_ino,held.st_uid,held.st_nlink) != (observed.st_dev,observed.st_ino,observed.st_uid,observed.st_nlink): raise RuntimeError('owned file binding changed')
                raw = bytearray()
                while len(raw) <= 1048576:
                    part = os.read(descriptor,min(8192,1048577-len(raw)))
                    if not part: break
                    raw.extend(part)
                final = os.fstat(descriptor)
                rebound = os.lstat(path)
                if len(raw) != final.st_size or (rebound.st_dev,rebound.st_ino,rebound.st_nlink,rebound.st_uid) != (held.st_dev,held.st_ino,held.st_nlink,held.st_uid): raise RuntimeError('owned file observation incomplete')
            finally: os.close(descriptor)
            byte_count += len(raw)
            if byte_count > 8388608: raise RuntimeError('owned tree total byte bound exceeded')
            inode = (observed.st_dev,observed.st_ino)
            value['link_group'] = inode_paths.setdefault(inode,relative)
            journal_name = os.path.basename(path)
            if os.path.dirname(path) == authority['receipts']:
                receipt = journal_history.get(journal_name)
                if receipt is None or bytes(raw) != receipt['bytes']: raise RuntimeError('unaccounted or changed journal in owned tree')
                member = receipt['member']
                group_index = next(index for index,process in enumerate(children) if process.pid == member['group'])
                lineage = 'leader' if member['pid'] == member['group'] else 'fork-child'
                relative = 'descendant-receipts/group-'+str(group_index)+'-'+member['role']+'-'+lineage+'.jsonl'
                value['link_group'] = relative
                value['size'] = 'authenticated bounded append history'
                value['accounted_journal'] = {'role':member['role'],'group_index':group_index,'lineage':lineage,'events':receipt['events'][1:],'records':len(receipt['events'])}
            elif relative in ('home/parent-pid','home/child-pid'):
                if not authority['forkAllowed'] or not bytes(raw).isdigit() or observed.st_nlink != 1 or len(raw) > 32: raise RuntimeError('unallocated PID marker')
                witness = next((entry['member'] for entry in journal_history.values() if entry['member']['pid'] == int(bytes(raw)) and entry['member']['role'] == 'installer'),None)
                if witness is None or (relative == 'home/parent-pid') != (witness['pid'] == witness['group']): raise RuntimeError('PID marker lineage mismatch')
                value['size'] = 'authenticated decimal PID bytes'
                value['accounted_pid'] = {'role':witness['role'],'leader':witness['pid'] == witness['group']}
            else: value['bytes_hex'] = bytes(raw).hex()
        entries[relative] = value
        if kind == 'directory':
            names = sorted(os.listdir(path))
            for name in names: visit(os.path.join(path,name))
            if sorted(os.listdir(path)) != names: raise RuntimeError('owned directory membership changed during observation')
        final = os.lstat(path)
        if (final.st_dev,final.st_ino,final.st_uid,final.st_nlink,stat.S_IMODE(final.st_mode)) != (observed.st_dev,observed.st_ino,observed.st_uid,observed.st_nlink,stat.S_IMODE(observed.st_mode)): raise RuntimeError('owned tree binding changed during observation')
    visit(authority['root'])
    return entries
def finish():
    members,faults = descendant_receipts()
    for index,child in enumerate(children):
        if not any(member['pid'] == child.pid and member['group'] == child.pid and member['session'] == child.pid for member in members):
            faults.append(['missing authenticated descendant fence receipt',index])
    # Observe signal completion without sending anything. A missing native kill remains live.
    if not os.environ.get('KILL_FAULT'):
        observation_deadline = time.monotonic() + 1
        while time.monotonic() < observation_deadline:
            live = [proc(member['pid']) for member in members]
            if not any(item and item['state'] not in ('Z','X') for item in live): break
            time.sleep(0.01)
    subject = []
    for member in members:
        observed = proc(member['pid'])
        if observed is None: state = 'stopped'
        elif observed['start'] != member['start'] or observed['group'] != member['group'] or observed['session'] != member['session']: state = 'unknown'
        else: state = 'stopped' if observed['state'] in ('Z','X') else 'live'
        group_index = next((i for i,p in enumerate(children) if p.pid == member['group']),None)
        subject.append({'role':member['role'],'group_index':group_index,'state':state})
    subject.sort(key=lambda item:(item['group_index'],item['role'],item['state']))
    tree_error = None
    try: surviving_tree = snapshot_owned_tree()
    except Exception as error:
        surviving_tree = None
        tree_error = str(error)
    # Snapshot above is the SUBJECT outcome. Emergency cleanup below grants no subject credit.
    emergency = []
    for child in children:
        verified,reason = verified_live_group(child.pid)
        if verified:
            real_killpg(child.pid,signal.SIGKILL)
            emergency.append([children.index(child),'verified-live-signalled'])
        elif reason != 'retired':
            emergency.append([children.index(child),'unknown-no-signal'])
        try: real_popen.communicate(child,timeout=2)
        except subprocess.TimeoutExpired: emergency.append([children.index(child),'drain-timeout'])
    print('__FIXTURE__'+json.dumps({'denied':denied,'descendant_denied':faults,'calls':calls,'actions':actions,'subject':subject,'emergency':emergency,'surviving_tree':surviving_tree,'tree_error':tree_error}),file=sys.stderr)
atexit.register(finish)
def execute_subject(source,bound_installer):
    tree = ast.parse(source)
    if bound_installer:
        native_run = [node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name == 'run']
        if len(native_run) != 1: raise RuntimeError('native run AST authentication failed')
        frozen_run = ast.dump(native_run[0],include_attributes=False)
        expected = ast.parse('run([sys.executable, str(Path(temp) / "install.py"), "--codex-only"], Path.home())').body[0]
        candidate = ast.parse('ports.run_command([ports.installer_interpreter(), ports.installer_path(temp), "--codex-only"], ports.installer_home())').body[0]
        matches = []
        for context in ast.walk(tree):
            if isinstance(context,ast.With):
                for index,statement in enumerate(context.body):
                    if ast.dump(statement,include_attributes=False) in (ast.dump(expected,include_attributes=False),ast.dump(candidate,include_attributes=False)):
                        matches.append((context,index,statement))
        if len(matches) != 1: raise RuntimeError('installer AST/context authentication failed')
        context,index,statement = matches[0]
        if len(context.items) != 1 or not isinstance(context.items[0].optional_vars,ast.Name) or context.items[0].optional_vars.id != 'temp': raise RuntimeError('installer workspace binding authentication failed')
        context_expression = ast.unparse(context.items[0].context_expr)
        if context_expression not in ("tempfile.TemporaryDirectory(prefix='ccc-codex-harness-')","ports.installation_workspace()"): raise RuntimeError('installer temporary context authentication failed')
        # AST inserts the full assignment immediately before the authenticated statement.
        # No indentation heuristic, native run edit, or context lifetime change is involved.
        context.body.insert(index,ast.parse("globals()['deadline'] = time.monotonic() + 0.5").body[0])
        ast.fix_missing_locations(tree)
        if ast.dump(native_run[0],include_attributes=False) != frozen_run: raise RuntimeError('native run changed during fixture bounding')
    exec(compile(tree,'<owned-bootstrap-subject>','exec'),globals())
`;

function execute(script: string, test: Case, expectedDenials: {parent: number; descendant: number} = {parent: 0, descendant: 0}) {
    const f = fixture(test);
    const result = spawnSync("/usr/bin/python3", ["-"], {input: FENCE + "\nexecute_subject(" + JSON.stringify(script) + "," + (test.deadline ? "True" : "False") + ")\n", encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, env: f.environment});
    expect(result.error).toBeUndefined();
    const lines = result.stderr.trimEnd().split("\n");
    const receipt = lines.pop()!;
    expect(receipt).toMatch(/^__FIXTURE__/);
    const effects = JSON.parse(receipt.slice("__FIXTURE__".length)) as {denied: unknown[]; descendant_denied: unknown[]; calls: [string[], string][]; actions: unknown[][]; subject: {role: string; group_index: number; state: string}[]; emergency: unknown[][]; surviving_tree: Record<string, Record<string, unknown>>; tree_error: string | null};
    expect(effects.denied, `${test.name}: counted denied effects`).toHaveLength(expectedDenials.parent);
    expect(effects.descendant_denied, `${test.name}: every descendant's counted denied effects`).toHaveLength(expectedDenials.descendant);
    if (test.deadline) {
        const members = effects.subject.filter(member => member.role === "installer");
        expect(members).toHaveLength(2);
        expect(members.every(member => member.state === (test.killFault ? "live" : "stopped")), "subject outcomes recorded BEFORE emergency cleanup").toBe(true);
        expect(effects.emergency).toEqual(test.killFault ? [[4, "verified-live-signalled"]] : []);
    }
    const temporaryRoots = effects.calls.filter(([args]) => args[0] === "git" && args[1] === "init").map(([args]) => args[3]);
    const normalize = (value: string) => {
        let text = value;
        for (const [index, path] of temporaryRoots.entries()) text = text.replaceAll(path, `<TEMP-${index}>`);
        return text.replaceAll(f.home, "<HOME>").replaceAll(f.root, "<ROOT>");
    };
    expect(effects.tree_error, "complete owned surviving tree captured BEFORE emergency teardown").toBeNull();
    expect(effects.surviving_tree).not.toBeNull();
    const snapshot: Record<string, Record<string, unknown>> = {};
    for (const [path, value] of Object.entries(effects.surviving_tree)) {
        expect(["file", "directory", "symlink"]).toContain(value.type);
        expect(value.times_bounded, `owned metadata time bounds: ${path}`).toBe(true);
        const {bytes_hex: hexadecimal, ...metadata} = value;
        const checked = JSON.parse(normalize(JSON.stringify(metadata))) as Record<string, unknown>;
        if (typeof hexadecimal === "string") {
            const raw = Buffer.from(hexadecimal, "hex");
            expect(raw.length).toBe(value.size);
            const text = raw.toString("utf8");
            if (Buffer.from(text, "utf8").equals(raw)) checked.bytes_text = normalize(text);
            else checked.bytes_hex = hexadecimal;
        }
        snapshot[path] = checked;
    }
    const calls = effects.calls.map(([args, cwd]) => [args.map(normalize), normalize(cwd)]);
    const git = existsSync(join(f.home, "git-calls")) ? normalize(readFileSync(join(f.home, "git-calls"), "utf8")) : "";
    expect(readdirSync(join(f.home, "tmp"))).toEqual([]);
    return {status: result.status, stdout: normalize(result.stdout), stderr: normalize(lines.join("\n")), snapshot, calls, git, actions: effects.actions, subject: effects.subject, emergency: effects.emergency};
}

const cases: Case[] = [
    {name: "ready"}, {name: "absent"},
    ...["harness", "plugins/cache/harness"].map(marker => ({name: `orphan-${marker}`, marker, config: "model = 'preserve'\n", expected: "no registration"})),
    ...['[features]\nplugin_hooks = false\n', '[plugins."harness@harness"]\nenabled = false\n', '[mcp_servers.harness]\nenabled = false\n'].map((config, i) => ({name: `disabled-${i}`, config})),
    ...['plugins = []', 'features = []', 'mcp_servers = []', 'marketplaces = []', '[plugins]\n"harness@harness" = 1', '[plugins."harness@custom"]\nenabled = true', 'bad = ['].map((config, i) => ({name: `malformed-${i}`, config})),
    ...[0, 1, "true"].map(value => ({name: `literal-plugin-${value}`, config: `[plugins."harness@harness"]\nenabled = ${JSON.stringify(value)}\n[features]\nplugin_hooks = true\n[marketplaces.harness]\nsource = "unused"\n[mcp_servers.harness]\ncommand = "unused"\n`, expected: "not enabled"})),
    ...["0", "1", '"true"'].map(value => ({name: `literal-features-${value}`, replaceConfig: ["plugin_hooks = true", `plugin_hooks = ${value}`] as [string, string], expected: "not enabled"})),
    ...["false", "0", "1", '"true"'].map(value => ({name: `literal-mcp-${value}`, replaceConfig: ['command = "/usr/bin/python3"', `enabled = ${value}\ncommand = "/usr/bin/python3"`] as [string, string]})),
    ...['""', '"missing-fixture-command"', "0", "[]"].map(value => ({name: `mcp-command-${value}`, replaceConfig: ['command = "/usr/bin/python3"', `command = ${value}`] as [string, string]})),
    ...['[]', '[0]', '""', '1'].map(value => ({name: `mcp-args-${value}`, replaceConfig: ['args = [', `args = ${value}\n# ignored = [`] as [string, string]})),
    ...['[]', 'null', '{', '{"version":[]}', '{}'].map(manifest => ({name: `manifest-${manifest}`, manifest})),
    ...["a", "a".repeat(128), "a".repeat(129), "../escape", "", "+a", 12, null].map(version => ({name: `version-${String(version).slice(0, 20)}-${String(version).length}`, version})),
    ...Array.from({length: 6}, (_, missing) => ({name: `required-${missing}`, missing, expected: "payload"})),
    ...Object.keys({SessionStart: 0, PreToolUse: 0, UserPromptSubmit: 0, PostToolUse: 0}).map(event => ({name: `event-${event}`, hooks: {[event]: [{hooks: [{type: "prompt"}]}, {matcher: "tool", hooks: [{type: "prompt"}, {type: "command", command: "@COMMAND@", statusMessage: "working", timeout: 3}]}]}})),
    ...[0, -4, 1, 600, "2", "invalid"].map(timeout => ({name: `timeout-${timeout}`, hooks: {SessionStart: [{hooks: [{type: "command", command: "@COMMAND@", timeout}]}]}})),
    ...["PYTHONDONTWRITEBYTECODE=1 ", "UNKNOWN=1 ", ""].map(prefix => ({name: `prefix-${prefix}`, hooks: {SessionStart: [{hooks: [{type: "command", command: prefix + "@COMMAND@"}]}]}})),
    {name: "custom-event", hooks: {Custom: [{hooks: [{type: "command", command: "@COMMAND@"}]}]}, expected: "event is custom"},
    {name: "noncommand", hooks: {SessionStart: [{hooks: [{type: "prompt"}]}]}, expected: "command hooks are missing"},
    {name: "empty-hooks", hooks: {}, expected: "hooks or trust"},
    {name: "missing-hook-payload", missingHook: true, expected: "hook command or payload"},
    ...['[]', 'null', '{', '{"hooks":[]}', '{"hooks":{"SessionStart":null}}', '{"hooks":{"SessionStart":[1]}}', '{"hooks":{"SessionStart":[{"hooks":[1]}]}}'].map(rawHooks => ({name: `hooks-shape-${rawHooks}`, rawHooks})),
    ...['', '"', 'PYTHONDONTWRITEBYTECODE=1', '/usr/bin/python3'].map(command => ({name: `hook-tokens-${command}`, hooks: {SessionStart: [{hooks: [{type: "command", command}]}]}})),
    ...["stale", "disabled", "missing", "zero"].map(trust => ({name: `trust-${trust}`, trust})),
    ...["init", "fetch", "rev-parse", "checkout", "installer"].map(stage => ({name: `install-${stage}`, stage})),
    {name: "pin-mismatch", revision: "wrong", expected: "pinned revision"},
    ...["disabled", "malformed", "absent"].map(post => ({name: `post-${post}`, post})),
    {name: "cleanup", cleanupFault: true, expected: "cleanup fault"},
    {name: "group-deadline", deadline: true, expected: "stopped installer and children"},
    {name: "kill-masks", deadline: true, killFault: true, expected: "kill fault"},
    {name: "drain-masks", deadline: true, drainFault: true, expected: "drain fault"},
];

describe("whole executed Python bootstrap original/candidate replay", () => {
    it.each([
        "os.rename(str(shadow),str(receipt))",
        "os.link(str(shadow),str(receipt))",
        "os.symlink(str(shadow),str(receipt))",
        "os.rename(str(shadow),sitecustomize.authority['receipts'])",
        "os.rename(str(shadow),sitecustomize.authority['root'])",
        "os.link(str(receipt),str(pathlib.Path.home()/'journal-copy'))",
        "os.ftruncate(sitecustomize.writer_fd,0)",
        "os.rename(sitecustomize.authority['receipts'],str(pathlib.Path.home()/'rebound-receipts'))",
        "os.rename(sitecustomize.authority['root'],str(pathlib.Path.home()/'rebound-root'))",
        "os.rename('journal-shadow',receipt.name,src_dir_fd=os.open(str(pathlib.Path.home()),os.O_RDONLY|os.O_DIRECTORY),dst_dir_fd=os.open(sitecustomize.authority['receipts'],os.O_RDONLY|os.O_DIRECTORY))",
    ])("preserves the descendant's earlier caught denial against source/destination/anchor/dirfd attacks: %s", journalProbe => {
        for (const script of [ORIGINAL, CODEX_HARNESS_BOOTSTRAP, emittedBootstrap]) {
            const result = execute(script, {name: "sealed-descendant-history", stage: "no-failing-stage", journalProbe}, {parent: 0, descendant: 2});
            expect(result.status).toBe(0); expect(result.calls).toHaveLength(5);
        }
    });
    it.each([
        "os.rename(str(shadow),str(receipt))",
        "os.link(str(shadow),str(receipt))",
        "os.symlink(str(shadow),str(receipt))",
        "os.rename(str(shadow),authority['receipts'])",
        "os.rename(str(shadow),authority['root'])",
        "os.rename(authority['receipts'],str(Path.home()/'rebound-receipts'))",
        "os.rename(authority['root'],str(Path.home()/'rebound-root'))",
        "os.rename('journal-shadow',receipt.name,src_dir_fd=os.open(str(Path.home()),os.O_RDONLY|os.O_DIRECTORY),dst_dir_fd=os.open(authority['receipts'],os.O_RDONLY|os.O_DIRECTORY))",
    ])("preserves a completed child denial when the parent catches a rebinding attempt: %s", attempt => {
        const suffix = "\nshadow = Path.home()/'journal-shadow'\nshadow.write_text('forged identity')\n_members,_faults = descendant_receipts()\nreceipt = Path(authority['receipts'])/(str(next(member['pid'] for member in _members if member['role']=='installer'))+'.jsonl')\ntry:\n " + attempt + "\nexcept Exception:\n pass\n";
        const result = execute(ORIGINAL + suffix, {name: "sealed-parent-history", stage: "no-failing-stage", descendantProbe: true}, {parent: 1, descendant: 1});
        expect(result.status).toBe(0); expect(result.calls).toHaveLength(5);
    });
    it.each([
        "(Path.home()/'unallocated-extra').write_bytes(b'extra\\x00bytes')",
        "(Path.home()/'remaining-directory').mkdir()",
        "os.symlink(str(Path.home()/'.codex/config.toml'),str(Path.home()/'unexpected-symlink'))",
        "os.link(str(Path.home()/'.codex/config.toml'),str(Path.home()/'unexpected-hardlink'))",
    ])("makes every additional HOME node/type/link visible in the complete differential: %s", effect => {
        const original = execute(ORIGINAL, {name: "ready"});
        const changed = execute(ORIGINAL + "\n" + effect + "\n", {name: "ready"});
        expect(changed.snapshot).not.toEqual(original.snapshot);
        expect(Object.keys(changed.snapshot).length).toBeGreaterThan(Object.keys(original.snapshot).length);
    });
    it("aggregates a caught denial from an authenticated installer interpreter before fixture effects", () => {
        const test = {name: "descendant-caught-denial", stage: "no-failing-stage", descendantProbe: true};
        for (const script of [ORIGINAL, CODEX_HARNESS_BOOTSTRAP, emittedBootstrap]) {
            const result = execute(script, test, {parent: 0, descendant: 1});
            expect(result.status).toBe(0); expect(result.calls).toHaveLength(5);
        }
    });
    it("counts refusal of candidate-created private installer bytes before execution", () => {
        const script = ORIGINAL.replace('            run([sys.executable,', '            (Path(temp) / "install.py").write_text("import os; os.system(\\\"forbidden\\\")")\n            run([sys.executable,');
        expect(script).not.toBe(ORIGINAL);
        const result = execute(script, {name: "private-installer-tamper", stage: "no-failing-stage"}, {parent: 1, descendant: 0});
        expect(result.status).toBe(1); expect(result.calls).toHaveLength(4);
        expect(result.stderr).toContain("fixture denied open");
    });
    it.each([
        "open('/tmp/ccc-forbidden-global-write','w')",
        "pathlib.Path('/etc/ccc-forbidden-global-observation').is_file()",
        "os.system('forbidden-fixture-command')",
        "subprocess.Popen(['/usr/bin/true'],cwd=os.environ['HOME'],start_new_session=True)",
        "__import__('socket').socket()",
    ])("counts refusal before throwing even when the subject catches it: %s", attempt => {
        const f = fixture({name: "ready"});
        const program = FENCE + "\ntry:\n " + attempt + "\nexcept Exception:\n pass\n";
        const result = spawnSync("/usr/bin/python3", ["-"], {input: program, encoding: "utf8", timeout: 5000, env: f.environment});
        expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
        const receipt = result.stderr.trimEnd().split("\n").pop()!;
        expect(receipt).toMatch(/^__FIXTURE__/);
        const observed = JSON.parse(receipt.slice("__FIXTURE__".length)) as {denied: unknown[]; calls: unknown[]};
        expect(observed.denied).toHaveLength(1); expect(observed.calls).toEqual([]);
    });
    it.each(cases)("preserves state, command order, diagnostics and zero denied effects: $name", test => {
        const original = execute(ORIGINAL, test);
        const current = execute(CODEX_HARNESS_BOOTSTRAP, test);
        const emitted = execute(emittedBootstrap, test);
        expect(current).toEqual(original);
        expect(emitted).toEqual(original);
        if (test.expected) expect(current.stderr).toContain(test.expected);
        if (test.name === "ready" || test.name.startsWith("disabled")) { expect(current.status).toBe(0); expect(current.calls).toEqual([]); }
        if (test.name === "absent") { expect(current.status).toBe(0); expect(current.calls).toHaveLength(5); expect(current.git).toContain(PIN); }
        if (test.name === "pin-mismatch") expect(current.calls).toHaveLength(3);
        if (test.deadline) {
            const installerActions = current.actions.filter(action => action[1] === 4);
            expect(installerActions).toEqual(test.killFault ? [["communicate", 4, "bounded"], ["killpg", 4, 9]] : [["communicate", 4, "bounded"], ["killpg", 4, 9], ["communicate", 4, "drain"]]);
        }
    }, 20000);
    it("retains the real native run body and inward executed policy boundaries", () => {
        const body = (source: string) => source.slice(source.indexOf("def run(args, cwd):"), source.indexOf("\n\n", source.indexOf("    return out.strip()")));
        expect(body(CODEX_HARNESS_NATIVE_SOURCE)).toBe(body(ORIGINAL));
        expect(CODEX_HARNESS_NATIVE_SOURCE).toContain("deadline = time.monotonic() + 120");
        expect(CODEX_HARNESS_APPLICATION_SOURCE).toContain('if state == "absent"');
        expect(CODEX_HARNESS_APPLICATION_SOURCE).toContain("actual != REVISION");
        expect(CODEX_HARNESS_DOMAIN_SOURCE).not.toMatch(/\b(?:Path|Popen|TemporaryDirectory|killpg|read_text|is_file)\b/);
        expect(CODEX_HARNESS_NATIVE_SOURCE).not.toContain("def probe(");
    });
});
