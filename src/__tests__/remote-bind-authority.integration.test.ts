import {
    chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
    renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    remoteContainerStartScript, remoteRuntimeBindAuthorityShell, remoteLifecycleShell,
} from "../adapters/remote-shell.js";
import {
    prepareRuntimeBindHome, readRuntimeBindAuthority, withRuntimeBindGuard,
} from "../adapters/runtime-bind-authority.js";
import {
    remoteRefreshSessionShell, remoteSessionReservationShell, remoteStopShell, shellEscapeArg,
} from "../remote.js";
import { getContainerName } from "../docker.js";
import { hashPath } from "../utils.js";

const roots: string[] = [];
type OwnedChild = { child: ChildProcess; closed: boolean; completed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };
const children: OwnedChild[] = [];
const containerId = "a".repeat(64);

afterEach(async () => {
    for (const owned of children.splice(0)) {
        if (!owned.closed && owned.child.exitCode === null && owned.child.signalCode === null && owned.child.pid) {
            // Every group here was created detached by this fixture; never target another process.
            try { process.kill(-owned.child.pid, "SIGKILL"); } catch { /* already exited */ }
        }
        await owned.completed;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ccc-remote-bind-authority-")));
    roots.push(home);
    chmodSync(home, 0o700);
    const root = join(home, ".ccc");
    const lock = join(root, "codex-state.lock");
    const marker = join(root, "runtime-bind-authority", "receiving-host-incomplete");
    const effect = join(home, "effect");
    const bin = join(home, "bin");
    mkdirSync(bin, { mode: 0o700 });
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const run = (command: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync("/bin/sh", ["-c", command], {
        env: { ...env, ...overrides }, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
    });
    const prepare = () => {
        const prepared = prepareRuntimeBindHome(root);
        withRuntimeBindGuard(prepared, guard => expect(readRuntimeBindAuthority(guard).coverage).toBe("complete"));
        return prepared;
    };
    const start = (command: string, overrides: NodeJS.ProcessEnv = {}) => {
        const child = spawn("/bin/sh", ["-c", command], { env: { ...env, ...overrides }, detached: true, stdio: "ignore" });
        const owned: OwnedChild = {
            child, closed: false,
            completed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code, signal) => { owned.closed = true; resolve({ code, signal }); });
            }),
        };
        children.push(owned);
        return owned;
    };
    return { home, root, lock, marker, effect, bin, env, run, prepare, start };
}

async function waitForFile(file: string, content?: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!existsSync(file) || (content !== undefined && !readFileSync(file, "utf8").includes(content))) {
        if (Date.now() >= deadline) throw new Error(`fixture did not publish ${file}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

function waitBody(home: string): string {
    return `printf ready > ${shellEscapeArg(join(home, "ready"))}; while [ ! -e ${shellEscapeArg(join(home, "continue"))} ]; do sleep 0.01; done`;
}

function installDocker(f: ReturnType<typeof fixture>, name: string, existing = true, failureStatus = 0): string {
    const log = join(f.home, "native-calls");
    writeFileSync(log, "", { mode: 0o600 });
    writeFileSync(join(f.bin, "docker"), [
        "#!/bin/sh",
        // The executable is inert, but every native call must see the real receiving-host claim and marker.
        `[ -f "$HOME/.ccc/codex-state.lock" ] && [ -f "$HOME/.ccc/runtime-bind-authority/receiving-host-incomplete" ] || exit 88`,
        `printf '%s\\n' "$*" >> ${shellEscapeArg(log)}`,
        `case "$1 $2" in`,
        ` 'inspect --format') if [ "$3" = '{{.Name}}' ]; then printf '%s\\n' ${shellEscapeArg(`/${name}`)}; elif [ ${existing ? "1" : "0"} -eq 1 ]; then printf '%s\\n' ${containerId}; else exit 1; fi ;;`,
        ` 'image inspect') printf '%s\\n' 'sha256:${"b".repeat(64)}' ;;`,
        ` 'run --rm') printf '%s\\n' '1000-1000' ;;`,
        ` 'run -d') printf '%s\\n' ${containerId}; exit ${failureStatus} ;;`,
        ` 'start '*|'stop '*) exit ${failureStatus} ;;`,
        ` *) exit 99 ;;`,
        `esac`,
    ].join("\n"), { mode: 0o700 });
    return log;
}

function installProcessProbe(f: ReturnType<typeof fixture>, mode: "admission" | "root-change" | "child-change" | "fork-late") {
    const program = join(f.bin, "native-process-probe.cjs"); const executable = join(f.bin, "native-process-probe");
    writeFileSync(program, [
        'const fs = require("node:fs"); const { spawnSync } = require("node:child_process");',
        'for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(signal, () => {});',
        `const home = ${JSON.stringify(f.home)}; const mode = ${JSON.stringify(mode)};`,
        'const args = process.argv.slice(2); const result = spawnSync("/bin/ps", args, { encoding: "utf8" }); let output = result.stdout;',
        'if (mode === "fork-late" && args.includes("-A") && !fs.existsSync(home + "/fork-after-snapshot")) {',
        ' fs.writeFileSync(home + "/fork-after-snapshot", "go");',
        ' const gate = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(home + "/native-child-ready")) Atomics.wait(gate, 0, 0, 5);',
        '}',
        'const match = /^\\s*(\\d+)\\s+\\d+\\s+(\\S+)\\s+(?:\\S+\\s+){5}(.*)$/m.exec(output);',
        'if (args.includes("-p") && match) {',
        ' const pid = match[1]; const rootFile = home + "/probe-root";',
        ' if (match[2].startsWith("T") && !fs.existsSync(rootFile)) fs.writeFileSync(rootFile, pid);',
        ' const root = fs.existsSync(rootFile) ? fs.readFileSync(rootFile, "utf8") : "";',
        ' if (mode === "admission" && pid === root && !fs.existsSync(home + "/probe-ready")) {',
        '  fs.writeFileSync(home + "/probe-ready", "ready");',
        '  const gate = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(home + "/probe-continue")) Atomics.wait(gate, 0, 0, 5);',
        ' }',
        ' if (fs.existsSync(home + "/change-proof")) {',
        `  const native = match[3].startsWith(${JSON.stringify(process.execPath + " ")}) && match[3].includes(home + "/retained-native.cjs");`,
        '  const countFile = home + "/probe-count-" + pid; const count = native && fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) + 1 : 1;',
        '  if (native) fs.writeFileSync(countFile, String(count));',
        '  if ((mode === "root-change" && pid === root) || (mode === "child-change" && native && count > 1)) {',
        '   output = output.replace(/^(\\s*(?:\\S+\\s+){7})\\d{4}/m, (_, prefix) => prefix + "1970");',
        '   if (pid === root) fs.writeFileSync(home + "/changed-root-proof", "changed");',
        '  }',
        ' }',
        '}',
        'process.stdout.write(output, () => process.stderr.write(result.stderr, () => process.exit(result.status ?? 1)));',
    ].join("\n"));
    writeFileSync(executable, `#!/bin/sh\nexec ${shellEscapeArg(process.execPath)} ${shellEscapeArg(program)} "$@"\n`, { mode: 0o700 });
    return (shell: string) => shell.replaceAll("/bin/ps", shellEscapeArg(executable));
}

function withScopeSignalDiagnostics(shell: string): string {
    const captureHeader = "_ccc_scope_capture() {";
    const resumeHeader = "_ccc_scope_resume() {";
    const captureStart = shell.indexOf(captureHeader);
    const captureEnd = shell.indexOf(resumeHeader, captureStart);
    if (captureStart < 0 || captureEnd < 0) throw new Error("missing scope diagnostic capture boundary");
    let capture = shell.slice(captureStart, captureEnd);
    for (const [call, phase] of [
        ['        _ccc_scope_match "$_ccc_scope_root_record" signal || return $?', "root-before-term"],
        ['    _ccc_scope_match "$_ccc_scope_cancel_root" signal || _ccc_scope_resume_status=$?', "root-after-term-before-cont"],
        ['        _ccc_scope_match "$_ccc_scope_cancel_root" signal || return $?', "root-after-child-observe"],
    ]) {
        if (!capture.includes(call)) throw new Error(`missing scope diagnostic capture call: ${phase}`);
        capture = capture.replace(call, call.replace("_ccc_scope_match", `_ccc_fixture_capture_match ${phase}`));
    }
    shell = shell.slice(0, captureStart) + [
        "_ccc_fixture_capture_match() {",
        "    _ccc_fixture_match_phase=$1; shift",
        "    _ccc_fixture_capture_match_status=0",
        '    _ccc_scope_match "$@" || _ccc_fixture_capture_match_status=$?',
        "    _ccc_fixture_match_phase=none",
        '    return "$_ccc_fixture_capture_match_status"',
        "}",
        capture,
    ].join("\n") + shell.slice(captureEnd);
    for (const [name, next] of [
        ["observe", "decode"], ["match", "capture"], ["capture", "resume"],
        ["resume", "native"], ["native", "child_exit"],
    ]) {
        const header = `_ccc_scope_${name}() {`;
        const boundary = `_ccc_scope_${next}() {`;
        if (!shell.includes(header) || !shell.includes(boundary)) throw new Error(`missing scope diagnostic boundary: ${name}`);
        const status = `_ccc_fixture_${name}_status`;
        const lines = [
            `${header}`,
            ...(name === "match" ? ["    _ccc_fixture_observe_status=0"] : []),
            `    ${status}=0`,
            `    _ccc_fixture_scope_${name} "$@" || ${status}=$?`,
            `    if [ "$${status}" != 0 ]; then`,
            '        case "${_ccc_scope_callback:-}" in (_ccc_on_signal) _ccc_fixture_scope=lifecycle ;; (_ccc_bind_signal) _ccc_fixture_scope=bind ;; (_ccc_scope_child_exit) _ccc_fixture_scope=worker ;; (*) _ccc_fixture_scope=unknown ;; esac',
            '        case "${_ccc_fixture_match_phase:-}" in (root-before-term|root-after-term-before-cont|root-after-child-observe) _ccc_fixture_phase=$_ccc_fixture_match_phase ;; (*) _ccc_fixture_phase=none ;; esac',
        ];
        if (name === "match") lines.push(
            '        if [ "$_ccc_fixture_observe_status" = 1 ]; then _ccc_fixture_match_category=absent',
            '        elif [ "$_ccc_fixture_observe_status" != 0 ]; then _ccc_fixture_match_category=observe',
            '        elif [ "${_ccc_observed_birth:-}" != "${_ccc_expected_birth:-}" ]; then _ccc_fixture_match_category=birth',
            '        elif [ "${_ccc_observed_command:-}" != "${_ccc_expected_command:-}" ]; then _ccc_fixture_match_category=command',
            '        elif [ "${_ccc_observed_parent:-}" != "${_ccc_expected_parent:-}" ]; then _ccc_fixture_match_category=ancestry',
            '        else _ccc_fixture_match_category=unclassified; fi',
            '        _ccc_fixture_expected_command=${_ccc_expected_command:-}; _ccc_fixture_expected_length=${#_ccc_fixture_expected_command}',
            '        _ccc_fixture_expected_token=false; _ccc_fixture_observed_token=unknown',
            '        if [ -n "${_ccc_scope_token:-}" ]; then case "$_ccc_fixture_expected_command" in (*"$_ccc_scope_token"*) _ccc_fixture_expected_token=true ;; esac; fi',
            '        _ccc_fixture_same_birth=unknown; _ccc_fixture_same_parent=unknown; _ccc_fixture_observed_length=unknown; _ccc_fixture_relation=unknown; _ccc_fixture_state=unknown',
            '        if [ "$_ccc_fixture_observe_status" = 0 ]; then',
            '            _ccc_fixture_same_birth=false; [ "${_ccc_observed_birth:-}" != "${_ccc_expected_birth:-}" ] || _ccc_fixture_same_birth=true',
            '            _ccc_fixture_same_parent=false; [ "${_ccc_observed_parent:-}" != "${_ccc_expected_parent:-}" ] || _ccc_fixture_same_parent=true',
            '            _ccc_fixture_observed_command=${_ccc_observed_command:-}; _ccc_fixture_observed_length=${#_ccc_fixture_observed_command}',
            '            _ccc_fixture_observed_token=false',
            '            if [ -n "${_ccc_scope_token:-}" ]; then case "$_ccc_fixture_observed_command" in (*"$_ccc_scope_token"*) _ccc_fixture_observed_token=true ;; esac; fi',
            '            case "$_ccc_fixture_observed_command" in ("$_ccc_fixture_expected_command") _ccc_fixture_relation=equal ;; ("$_ccc_fixture_expected_command"*) _ccc_fixture_relation=observed-extends-expected ;; (*) case "$_ccc_fixture_expected_command" in ("$_ccc_fixture_observed_command"*) _ccc_fixture_relation=expected-extends-observed ;; (*) _ccc_fixture_relation=different ;; esac ;; esac',
            '            case "${_ccc_observed_state:-}" in (T*) _ccc_fixture_state=stopped ;; (R*) _ccc_fixture_state=running ;; (S*|I*) _ccc_fixture_state=sleeping ;; (D*|U*) _ccc_fixture_state=uninterruptible ;; (Z*) _ccc_fixture_state=zombie ;; (X*) _ccc_fixture_state=dead ;; esac',
            '        fi',
            '        command printf "CCC scope fixture: match status=%s category=%s scope=%s phase=%s same_birth=%s same_parent=%s observed_token=%s expected_token=%s observed_length=%s expected_length=%s command_relation=%s state=%s\\n" "$_ccc_fixture_match_status" "$_ccc_fixture_match_category" "$_ccc_fixture_scope" "$_ccc_fixture_phase" "$_ccc_fixture_same_birth" "$_ccc_fixture_same_parent" "$_ccc_fixture_observed_token" "$_ccc_fixture_expected_token" "$_ccc_fixture_observed_length" "$_ccc_fixture_expected_length" "$_ccc_fixture_relation" "$_ccc_fixture_state" >&2 || true',
        );
        else lines.push(`        command printf "CCC scope fixture: ${name} status=%s scope=%s phase=%s\\n" "$${status}" "$_ccc_fixture_scope" "$_ccc_fixture_phase" >&2 || true`);
        lines.push("    fi", `    return "$${status}"`, "}");
        shell = shell.replace(header, `_ccc_fixture_scope_${name}() {`)
            .replace(boundary, `${lines.join("\n")}\n${boundary}`);
    }
    return shell;
}

describe.runIf(process.platform !== "win32")("receiving-host global bind authority", () => {
    it.each([
        [1, 74, "_ccc_on_signal", "lifecycle", "root-before-term"],
        [2, 2, "_ccc_bind_signal", "bind", "root-after-term-before-cont"],
        [3, 1, "_ccc_scope_child_exit", "worker", "root-after-child-observe"],
    ] as const)("forwards scope diagnostic capture check %s without exposing identities", (failCall, status, callback, scope, phase) => {
        const f = fixture();
        const token = "private-token"; const expected = `/private/fixture 43210 ${token}`;
        const shell = [
            "set -eu",
            `_ccc_scope_callback=${callback}; _ccc_scope_token=${shellEscapeArg(token)}`,
            `_ccc_expected_command=${shellEscapeArg(expected)}; _ccc_observed_command=${shellEscapeArg(`${expected} extra`)}`,
            "_ccc_expected_birth=private-birth; _ccc_observed_birth=private-birth",
            "_ccc_expected_parent=43210; _ccc_observed_parent=54321; _ccc_observed_state=T+private-state",
            "_ccc_scope_root_record=private-record; _ccc_scope_cancel_root=private-record; _ccc_fixture_calls=0",
            "_ccc_scope_observe() { return 0; }",
            "_ccc_scope_decode() { :; }",
            "_ccc_scope_match() {",
            '    [ "$#" = 2 ] && [ "$1" = private-record ] && [ "$2" = signal ] || return 96',
            "    _ccc_fixture_calls=$((_ccc_fixture_calls + 1))",
            `    [ "$_ccc_fixture_calls" != ${failCall} ] || return ${status}`,
            "    return 0",
            "}",
            "_ccc_scope_capture() {",
            '        _ccc_scope_match "$_ccc_scope_root_record" signal || return $?',
            "    _ccc_scope_resume_status=0",
            '    _ccc_scope_match "$_ccc_scope_cancel_root" signal || _ccc_scope_resume_status=$?',
            '    [ "$_ccc_scope_resume_status" = 0 ] || return "$_ccc_scope_resume_status"',
            '        _ccc_scope_match "$_ccc_scope_cancel_root" signal || return $?',
            "}",
            "_ccc_scope_resume() { return 0; }",
            "_ccc_scope_native() { return 0; }",
            "_ccc_scope_child_exit() { return 0; }",
            "_ccc_fixture_result=0; _ccc_scope_capture || _ccc_fixture_result=$?",
            'printf "status=%s phase=%s\\n" "$_ccc_fixture_result" "${_ccc_fixture_match_phase:-none}"',
        ].join("\n");
        const baseline = f.run(shell); const diagnosed = f.run(withScopeSignalDiagnostics(shell));
        expect(baseline.status, baseline.stderr).toBe(0);
        expect(baseline.stdout).toBe(`status=${status} phase=none\n`);
        expect(diagnosed.status, diagnosed.stderr).toBe(baseline.status);
        expect(diagnosed.stdout).toBe(baseline.stdout);
        expect(diagnosed.stderr).toContain(`match status=${status} category=command scope=${scope} phase=${phase}`);
        expect(diagnosed.stderr).toContain(`same_birth=true same_parent=false observed_token=true expected_token=true observed_length=${expected.length + 6} expected_length=${expected.length} command_relation=observed-extends-expected state=stopped`);
        for (const privateValue of [expected, token, "private-record", "private-birth", "43210", "54321", "T+private-state", callback])
            expect(diagnosed.stderr).not.toContain(privateValue);
    });

    it("publishes a native shared claim and permanent marker only in the receiving home, including localhost", async () => {
        const client = fixture(); const receiver = fixture();
        const clientHome = client.prepare(); const receiverHome = receiver.prepare();
        const receiverHistory = readFileSync(join(receiver.root, "runtime-bind-authority", "history.json"));
        const clientHistory = readFileSync(join(client.root, "runtime-bind-authority", "history.json"));
        const held = receiver.start(remoteRuntimeBindAuthorityShell(waitBody(receiver.home)));
        await waitForFile(join(receiver.home, "ready"));

        const claim = JSON.parse(readFileSync(receiver.lock, "utf8")) as Record<string, unknown>;
        expect(claim).toEqual({ token: expect.stringMatching(/^[a-f0-9]{32}$/), pid: held.child.pid,
            host: hostname(), processIdentityStatus: "unavailable" });
        expect(statSync(receiver.lock).nlink).toBe(1);
        expect(statSync(receiver.lock).mode & 0o777).toBe(0o600);
        expect(statSync(receiver.marker).mode & 0o777).toBe(0o600);
        expect(statSync(join(receiver.root, "runtime-bind-authority")).mode & 0o777).toBe(0o700);
        writeFileSync(join(receiver.home, "continue"), "continue");
        expect((await held.completed).code).toBe(0);
        expect(existsSync(receiver.lock)).toBe(false);
        expect(existsSync(receiver.marker)).toBe(true);
        expect(existsSync(client.marker)).toBe(false);
        expect(readFileSync(join(receiver.root, "runtime-bind-authority", "history.json"))).toEqual(receiverHistory);
        expect(readFileSync(join(client.root, "runtime-bind-authority", "history.json"))).toEqual(clientHistory);
        withRuntimeBindGuard(receiverHome, guard => expect(readRuntimeBindAuthority(guard)).toMatchObject({
            coverage: "incomplete", pending: false, reason: "receiving-host-incomplete",
        }));
        withRuntimeBindGuard(clientHome, guard => expect(readRuntimeBindAuthority(guard).coverage).toBe("complete"));
    });

    it("a Node holder excludes remote credential creation and every native start effect", () => {
        const f = fixture(); const home = f.prepare(); const project = "/project/owned-remote-fixture";
        const log = installDocker(f, getContainerName(project));
        withRuntimeBindGuard(home, () => {
            const before = readFileSync(f.lock); const inode = lstatSync(f.lock).ino;
            const result = f.run(remoteContainerStartScript(project));
            expect(result.status, result.stderr).toBe(73);
            expect(readFileSync(f.lock)).toEqual(before);
            expect(lstatSync(f.lock).ino).toBe(inode);
            expect(existsSync(join(f.root, "profiles"))).toBe(false);
            expect(existsSync(f.marker)).toBe(false);
            expect(readFileSync(log, "utf8")).toBe("");
        });
    });

    it("a shell holder excludes the native Node guard without stale-owner reclamation", async () => {
        const f = fixture(); const home = f.prepare();
        const held = f.start(remoteRuntimeBindAuthorityShell(waitBody(f.home)));
        await waitForFile(join(f.home, "ready"));
        const before = readFileSync(f.lock); const inode = lstatSync(f.lock).ino;
        let entered = false;
        expect(() => withRuntimeBindGuard(home, () => { entered = true; }, { waitMs: 0 }))
            .toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
        expect(entered).toBe(false);
        expect(readFileSync(f.lock)).toEqual(before);
        expect(lstatSync(f.lock).ino).toBe(inode);
        writeFileSync(join(f.home, "continue"), "continue");
        expect((await held.completed).code).toBe(0);
        withRuntimeBindGuard(home, guard => expect(readRuntimeBindAuthority(guard).coverage).toBe("incomplete"));
    });

    it.each([false, true])("cleans only its exact staging candidate after losing native publication (candidate replaced: %s)", async replaced => {
        const f = fixture(); f.prepare();
        const located = spawnSync("/bin/sh", ["-c", "command -v link"], { env: f.env, encoding: "utf8" });
        expect(located.status, located.stderr).toBe(0);
        const nativeLink = located.stdout.trim();
        expect(nativeLink.startsWith("/")).toBe(true);
        writeFileSync(join(f.bin, "link"), [
            "#!/bin/sh",
            'case "${2##*/}" in',
            ' codex-state.lock) printf arrived > "$RACE_BASE/arrived-$RACE_ROLE";',
            '  while [ ! -e "$RACE_BASE/go-$RACE_ROLE" ]; do sleep 0.01; done ;;',
            "esac",
            `exec ${shellEscapeArg(nativeLink)} "$@"`,
        ].join("\n"), { mode: 0o700 });
        writeFileSync(join(f.bin, "native-publication-effect"),
            '#!/bin/sh\nprintf \'%s\\n\' "$RACE_ROLE" >> "$RACE_BASE/native-effects"\n', { mode: 0o700 });
        const body = 'native-publication-effect; printf ready > "$RACE_BASE/body-$RACE_ROLE"; '
            + 'while [ ! -e "$RACE_BASE/finish" ]; do sleep 0.01; done';
        const winner = f.start(remoteRuntimeBindAuthorityShell(body), { RACE_BASE: f.home, RACE_ROLE: "winner" });
        const loser = f.start(remoteRuntimeBindAuthorityShell(body), { RACE_BASE: f.home, RACE_ROLE: "loser" });
        await Promise.all([waitForFile(join(f.home, "arrived-winner")), waitForFile(join(f.home, "arrived-loser"))]);

        // Both scripts passed the initial absent-claim check and wrote complete candidates before either link runs.
        expect(existsSync(f.lock)).toBe(false);
        const staging = () => readdirSync(f.root).filter(name => /^\.codex-state\.[a-f0-9]{32}$/.test(name));
        expect(staging()).toHaveLength(2);
        const loserName = staging().find(name => {
            const record = JSON.parse(readFileSync(join(f.root, name), "utf8")) as { pid?: unknown };
            return record.pid === loser.child.pid;
        });
        expect(loserName).toBeDefined();
        if (!loserName) throw new Error("loser did not publish its actual PID in a staging claim");
        const loserCandidate = join(f.root, loserName);
        const candidateBytes = readFileSync(loserCandidate); const candidateInode = lstatSync(loserCandidate).ino;
        const displaced = `${loserCandidate}.displaced`;
        if (replaced) {
            renameSync(loserCandidate, displaced);
            writeFileSync(loserCandidate, candidateBytes, { mode: 0o600 });
            expect(lstatSync(loserCandidate).ino).not.toBe(candidateInode);
        }
        const successorInode = replaced ? lstatSync(loserCandidate).ino : null;

        writeFileSync(join(f.home, "go-winner"), "continue");
        await waitForFile(join(f.home, "body-winner"));
        const winnerClaim = readFileSync(f.lock); const winnerInode = lstatSync(f.lock).ino;
        expect((JSON.parse(winnerClaim.toString("utf8")) as { pid?: unknown }).pid).toBe(winner.child.pid);
        writeFileSync(join(f.home, "go-loser"), "continue");
        expect((await loser.completed).code).toBe(73);

        // A losing publisher cannot enter its native body, clear the winner, or leak its unchanged candidate.
        expect(readFileSync(join(f.home, "native-effects"), "utf8")).toBe("winner\n");
        expect(existsSync(join(f.home, "body-loser"))).toBe(false);
        expect(readFileSync(f.lock)).toEqual(winnerClaim);
        expect(lstatSync(f.lock).ino).toBe(winnerInode);
        expect(existsSync(f.marker)).toBe(true);
        if (replaced) {
            expect(staging()).toEqual([loserName]);
            expect(lstatSync(loserCandidate).ino).toBe(successorInode);
            expect(readFileSync(loserCandidate)).toEqual(candidateBytes);
            expect(lstatSync(displaced).ino).toBe(candidateInode);
            expect(readFileSync(displaced)).toEqual(candidateBytes);
        } else expect(staging()).toEqual([]);

        writeFileSync(join(f.home, "finish"), "continue");
        expect((await winner.completed).code).toBe(0);
        expect(existsSync(f.lock)).toBe(false);
        expect(staging()).toEqual(replaced ? [loserName] : []);
        if (replaced) {
            expect(lstatSync(loserCandidate).ino).toBe(successorInode);
            expect(readFileSync(loserCandidate)).toEqual(candidateBytes);
            expect(readFileSync(displaced)).toEqual(candidateBytes);
        }
    });

    it.each([true, false])("guards remote %s existing-container start or fresh creation and retains coverage after release", existing => {
        const f = fixture(); const home = f.prepare(); const project = "/project/owned-remote-fixture";
        const log = installDocker(f, getContainerName(project), existing);
        const result = f.run(remoteContainerStartScript(project));
        expect(result.status, result.stderr).toBe(0);
        const calls = readFileSync(log, "utf8");
        expect(calls).toContain(existing ? `start ${containerId}` : "run -d --name");
        expect(existsSync(join(f.root, "profiles", "default", "claude"))).toBe(true);
        expect(existsSync(f.lock)).toBe(false);
        withRuntimeBindGuard(home, guard => expect(readRuntimeBindAuthority(guard).coverage).toBe("incomplete"));
    });

    it.each([
        ["standalone", true], ["standalone", false], ["nested", true], ["nested", false],
    ] as const)("preserves Docker79 and releases %s claims for existing=%s", (kind, existing) => {
        const f = fixture(); f.prepare(); const project = "/project/docker-failure-79";
        const name = getContainerName(project);
        const log = installDocker(f, name, existing, 79);
        const start = remoteContainerStartScript(project, undefined, kind === "nested");
        const command = kind === "nested" ? remoteSessionReservationShell(name, "a".repeat(32), 60, start, true) : start;
        const result = f.run(command);
        expect(result.status, result.stderr).toBe(79);
        expect(readFileSync(log, "utf8")).toContain(existing ? `start ${containerId}` : "run -d --name");
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`))).toBe(false);
        expect(readdirSync(f.root).some(entry => entry.startsWith(".scope-"))).toBe(false);
    });

    it.each([
        ["standalone", "exit"], ["standalone", "exec"], ["standalone", "trap"],
        ["nested", "exit"], ["nested", "exec"], ["nested", "trap"],
    ] as const)("preserves raw79 and caller %s/%s semantics", (kind, form) => {
        const f = fixture(); f.prepare(); const name = "ccc-raw-status-79";
        const body = form === "exec" ? "exec /bin/sh -c 'exit 79'"
            : form === "trap" ? "trap 'printf caller-exit' EXIT; exit 79" : "exit 79";
        const global = remoteRuntimeBindAuthorityShell(body, kind === "nested");
        const result = f.run(kind === "nested" ? remoteLifecycleShell(name, global) : global);
        expect(result.status, result.stderr).toBe(79);
        expect(result.stdout).toBe(form === "trap" ? "caller-exit" : "");
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`))).toBe(false);
    });

    it.each(["standalone", "nested"] as const)("preserves %s protected stdin with the private refusal descriptor", kind => {
        const f = fixture(); f.prepare();
        const global = remoteRuntimeBindAuthorityShell('IFS= read -r value; printf "%s" "$value"', kind === "nested");
        const result = spawnSync("/bin/sh", ["-c", kind === "nested" ? remoteLifecycleShell("ccc-stdin", global) : global], {
            env: f.env, input: "original-input\n", encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("original-input");
        expect(existsSync(f.lock)).toBe(false);
    });

    it.each(["standalone", "nested"] as const)("uses %s BSD stdin metadata when descriptor paths expose synthetic identities", kind => {
        const f = fixture(); f.prepare(); const name = "ccc-bsd-stdin-stat";
        const lifecycle = join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`);
        const nativeStat = spawnSync("/bin/sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
        const gnuStat = spawnSync(nativeStat, ["-c", "%d:%i", "-"], { input: "", encoding: "utf8" }).status === 0;
        const stdinIdentity = `${shellEscapeArg(nativeStat)} ${gnuStat ? "-c %d:%i -" : "-f %d:%i"}`;
        writeFileSync(join(f.bin, "stat"), [
            "#!/bin/sh",
            '_ccc_fixture_follow=',
            'if [ "$1" = -L ]; then _ccc_fixture_follow=-L; shift; fi',
            // Require the production BSD fallback even on a GNU fixture host.
            'case "$1" in (-c) exit 1 ;; (-f) ;; (*) exit 96 ;; esac',
            '_ccc_fixture_format=$2; shift 2',
            'if [ "$#" = 0 ]; then',
            ` ${stdinIdentity} >> "$HOME/stdin-identities" || exit 96`,
            ' printf "%s\\n" "$_ccc_fixture_format" >> "$HOME/stdin-formats"',
            'else',
            ' case "$1" in (/dev/fd/*|/proc/self/fd/*)',
            '  printf "%s\\n" "$1" >> "$HOME/descriptor-path-stats"',
            '  printf "999999:999999\\n"; exit 0 ;; esac',
            'fi',
            ...(gnuStat ? [
                'case "$_ccc_fixture_format" in',
                ' (%d:%i) ;; (%Lp) _ccc_fixture_format=%a ;; (%z) _ccc_fixture_format=%s ;;',
                ' (%Lp:%l:%z) _ccc_fixture_format=%a:%h:%s ;;',
                ' (%d:%i:%Lp:%l:%z) _ccc_fixture_format=%d:%i:%a:%h:%s ;; (*) exit 96 ;; esac',
                `if [ "$#" = 0 ]; then exec ${shellEscapeArg(nativeStat)} -c "$_ccc_fixture_format" -; fi`,
                `exec ${shellEscapeArg(nativeStat)} ` + '${_ccc_fixture_follow:+"$_ccc_fixture_follow"} -c "$_ccc_fixture_format" "$@"',
            ] : [
                `exec ${shellEscapeArg(nativeStat)} ` + '${_ccc_fixture_follow:+"$_ccc_fixture_follow"} -f "$_ccc_fixture_format" "$@"',
            ]),
        ].join("\n"), { mode: 0o700 });
        const body = [
            'cat "$HOME/.ccc/codex-state.lock" > "$HOME/claim-snapshot"',
            ...(kind === "nested" ? [`cat ${shellEscapeArg(lifecycle)} > "$HOME/lifecycle-snapshot"`] : []),
            'IFS= read -r value; printf "%s" "$value"',
        ].join("; ");
        const global = remoteRuntimeBindAuthorityShell(body, kind === "nested");
        const result = spawnSync("/bin/sh", ["-c", kind === "nested" ? remoteLifecycleShell(name, global) : global], {
            env: f.env, input: "original-input\n", encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
        });

        const error = result.error as NodeJS.ErrnoException | undefined;
        expect(result.status, `error=${error?.code ?? "none"} signal=${result.signal ?? "none"} status=${result.status}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toBe("original-input");
        expect(JSON.parse(readFileSync(join(f.home, "claim-snapshot"), "utf8"))).toEqual({
            token: expect.stringMatching(/^[a-f0-9]{32}$/), pid: result.pid,
            host: hostname(), processIdentityStatus: "unavailable",
        });
        if (kind === "nested") expect(readFileSync(join(f.home, "lifecycle-snapshot"), "utf8"))
            .toMatch(new RegExp(`^${result.pid} [a-f0-9]{32}\\n$`));
        expect(readFileSync(f.marker, "utf8")).toBe("ccc-runtime-bind-authority:remote-incomplete:v1\n");
        expect(statSync(f.marker).mode & 0o777).toBe(0o600);
        const observed = readFileSync(join(f.home, "stdin-identities"), "utf8").trim().split("\n");
        for (const path of [f.root, join(f.root, "runtime-bind-authority"), ...(kind === "nested" ? [join(f.root, "remote-runtime")] : [])]) {
            const actual = statSync(path);
            expect(observed).toContain(`${actual.dev}:${actual.ino}`);
        }
        expect(readFileSync(join(f.home, "stdin-formats"), "utf8")).toContain("%d:%i:%Lp:%l:%z\n");
        expect(readFileSync(join(f.home, "stdin-formats"), "utf8")).toContain("%z\n");
        expect(existsSync(join(f.home, "descriptor-path-stats"))).toBe(false);
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(lifecycle)).toBe(false);
    });

    it.each([
        ["standalone", "write"], ["standalone", "observation"],
        ["nested", "write"], ["nested", "observation"],
    ] as const)("holds %s claims alive when refusal %s is unavailable", async (kind, fault) => {
        const f = fixture(); f.prepare(); const name = "ccc-refusal-channel-failure";
        const diagnostic = join(f.home, "refusal-diagnostic");
        // Fault only this worker's exact write or inherited observation; supervisors keep their admitted copy.
        const faultBody = fault === "write" ? [
            'printf() { if [ "$#" = 1 ] && [ "$1" = x ]; then',
            ' command printf attempted > "$HOME/refusal-write-attempted"; return 1',
            ' fi; command printf "$@"; }',
        ].join("\n") : "exec 9>&-";
        const body = `${faultBody}; _ccc_refuse; printf late > ${shellEscapeArg(f.effect)}`;
        const global = remoteRuntimeBindAuthorityShell(body, kind === "nested");
        const held = f.start(`exec 2>${shellEscapeArg(diagnostic)}; ${kind === "nested" ? remoteLifecycleShell(name, global) : global}`);
        await waitForFile(diagnostic);
        const deadline = Date.now() + 3000;
        while (!readFileSync(diagnostic, "utf8").includes("refusal evidence unavailable")) {
            if (Date.now() >= deadline) throw new Error(readFileSync(diagnostic, "utf8"));
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (fault === "write") expect(readFileSync(join(f.home, "refusal-write-attempted"), "utf8")).toBe("attempted");
        process.kill(held.child.pid!, "SIGTERM");
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(held.closed).toBe(false);
        expect(existsSync(f.lock)).toBe(true);
        expect(existsSync(f.effect)).toBe(false);
        if (kind === "nested") expect(existsSync(join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`))).toBe(true);
        expect(readdirSync(f.root).some(entry => entry.startsWith(".scope-"))).toBe(false);
    });

    it.each(["standalone", "nested"] as const)("preserves a %s refusal-channel successor before its first observation", kind => {
        const f = fixture(); f.prepare(); const name = "ccc-refusal-successor";
        const nativeStat = spawnSync("/bin/sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
        writeFileSync(join(f.bin, "stat"), [
            "#!/bin/sh",
            'case "$*" in "-c %d:%i -"|"-f %d:%i")',
            ' if [ ! -e "$HOME/channel-replaced" ]; then',
            `  channel_identity=$(${shellEscapeArg(nativeStat)} -c %d:%i - 2>/dev/null || ${shellEscapeArg(nativeStat)} -f %d:%i 2>/dev/null) || exit 96`,
            '  for channel in "$HOME/.ccc"/.scope-* "$HOME/.ccc/remote-runtime"/.scope-*; do',
            '   [ -f "$channel" ] || continue',
            `   [ "$(${shellEscapeArg(nativeStat)} -c %d:%i "$channel" 2>/dev/null || ${shellEscapeArg(nativeStat)} -f %d:%i "$channel" 2>/dev/null)" = "$channel_identity" ] || continue`,
            '   mv "$channel" "$channel.original"; : > "$channel"',
            '   printf "%s" "$channel" > "$HOME/channel-replaced"; break',
            '  done',
            ' fi ;; esac',
            `exec ${shellEscapeArg(nativeStat)} "$@"`,
        ].join("\n"), { mode: 0o700 });
        const global = remoteRuntimeBindAuthorityShell(`printf late > ${shellEscapeArg(f.effect)}`, kind === "nested");
        const result = f.run(kind === "nested" ? remoteLifecycleShell(name, global) : global);
        expect(result.status, result.stderr).toBe(74);
        expect(result.stderr).toContain("CCC remote descriptor admission failed: refusal-reopened-meta-match");
        expect(result.stderr).not.toContain(f.home);
        const successor = readFileSync(join(f.home, "channel-replaced"), "utf8");
        expect(statSync(successor).ino).not.toBe(statSync(`${successor}.original`).ino);
        expect(readFileSync(successor, "utf8")).toBe("");
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(f.effect)).toBe(false);
    });

    it.each(["live", "dead", "malformed"])("does not reclaim an existing %s claim or run a protected body", kind => {
        const f = fixture(); f.prepare();
        const bytes = kind === "malformed" ? "unfinished JSON" : JSON.stringify({ token: "f".repeat(32),
            pid: kind === "live" ? process.pid : 99999999, host: hostname(), processIdentityStatus: "unavailable" });
        writeFileSync(f.lock, bytes, { mode: 0o600 }); const inode = lstatSync(f.lock).ino;
        const result = f.run(remoteRuntimeBindAuthorityShell(`printf changed > ${shellEscapeArg(f.effect)}`));
        expect(result.status, result.stderr).toBe(73);
        expect(readFileSync(f.lock, "utf8")).toBe(bytes);
        expect(lstatSync(f.lock).ino).toBe(inode);
        expect(existsSync(f.effect)).toBe(false);
        expect(existsSync(f.marker)).toBe(false);
    });

    it.each([
        `${"a".repeat(16)}.stale`, `${"b".repeat(16)}.release`,
        "12345678-1234-4234-9234-1234567890ab.stale", "12345678-1234-4234-9234-1234567890ab.release",
        `${"c".repeat(32)}.malformed`, "12345678-1234-4234-9234-1234567890ab.malformed",
    ])("preserves protected archive %s and refuses effects", suffix => {
        const f = fixture(); f.prepare(); const archive = `${f.lock}.${suffix}`;
        writeFileSync(archive, "unresolved-owner", { mode: 0o600 }); const inode = lstatSync(archive).ino;
        const result = f.run(remoteRuntimeBindAuthorityShell(`printf changed > ${shellEscapeArg(f.effect)}`));
        expect(result.status, result.stderr).toBe(73);
        expect(readFileSync(archive, "utf8")).toBe("unresolved-owner");
        expect(lstatSync(archive).ino).toBe(inode);
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(f.effect)).toBe(false);
        expect(existsSync(f.marker)).toBe(false);
    });

    it("preserves a dangling protected archive instead of treating it as absent", () => {
        const f = fixture(); f.prepare(); const archive = `${f.lock}.${"d".repeat(16)}.stale`;
        symlinkSync(join(f.home, "missing-target"), archive);
        const result = f.run(remoteRuntimeBindAuthorityShell(`printf changed > ${shellEscapeArg(f.effect)}`));
        expect(result.status, result.stderr).toBe(73);
        expect(lstatSync(archive).isSymbolicLink()).toBe(true);
        expect(existsSync(f.effect)).toBe(false);
    });

    it("does not remove a same-byte new-inode successor or displaced protected claim", async () => {
        const f = fixture(); f.prepare();
        const held = f.start(remoteRuntimeBindAuthorityShell(waitBody(f.home)));
        await waitForFile(join(f.home, "ready"));
        const before = readFileSync(f.lock); const ownedInode = lstatSync(f.lock).ino;
        const archive = `${f.lock}.${"e".repeat(16)}.stale`;
        renameSync(f.lock, archive); writeFileSync(f.lock, before, { mode: 0o600 });
        const successorInode = lstatSync(f.lock).ino;
        expect(successorInode).not.toBe(ownedInode);
        writeFileSync(join(f.home, "continue"), "continue");
        expect((await held.completed).code).toBe(74);
        expect(lstatSync(f.lock).ino).toBe(successorInode);
        expect(readFileSync(f.lock)).toEqual(before);
        expect(lstatSync(archive).ino).toBe(ownedInode);
        expect(readFileSync(archive)).toEqual(before);
        expect(existsSync(f.marker)).toBe(true);
    });

    it("preserves a replaced root and the old pinned claim rather than cleaning either successor", async () => {
        const f = fixture(); f.prepare();
        const held = f.start(remoteRuntimeBindAuthorityShell(waitBody(f.home)));
        await waitForFile(join(f.home, "ready"));
        const displaced = `${f.root}.displaced`; renameSync(f.root, displaced); mkdirSync(f.root, { mode: 0o700 });
        const sentinel = join(f.root, "successor-data"); writeFileSync(sentinel, "preserve", { mode: 0o600 });
        writeFileSync(join(f.home, "continue"), "continue");
        expect((await held.completed).code).toBe(74);
        expect(readFileSync(sentinel, "utf8")).toBe("preserve");
        expect(existsSync(join(displaced, "codex-state.lock"))).toBe(true);
        expect(existsSync(join(displaced, "runtime-bind-authority", "receiving-host-incomplete"))).toBe(true);
        expect(existsSync(f.marker)).toBe(false);
    });

    it("keeps marker publication on the held authority directory when its path is replaced", async () => {
        const f = fixture(); f.prepare();
        const nativeLink = spawnSync("/bin/sh", ["-c", "command -v link"], { env: f.env, encoding: "utf8" }).stdout.trim();
        writeFileSync(join(f.bin, "link"), [
            "#!/bin/sh",
            'case "${2##*/}" in receiving-host-incomplete)',
            ' printf ready > "$HOME/ready"; while [ ! -e "$HOME/continue" ]; do sleep 0.01; done ;; esac',
            `exec ${shellEscapeArg(nativeLink)} "$@"`,
        ].join("\n"), { mode: 0o700 });
        const held = f.start(remoteRuntimeBindAuthorityShell(`printf changed > ${shellEscapeArg(f.effect)}`));
        await waitForFile(join(f.home, "ready"));
        const directory = join(f.root, "runtime-bind-authority"); const displaced = `${directory}.displaced`;
        renameSync(directory, displaced); mkdirSync(directory, { mode: 0o700 });
        writeFileSync(f.marker, "successor marker", { mode: 0o600 });
        const successor = lstatSync(f.marker).ino;
        writeFileSync(join(f.home, "continue"), "continue");

        expect((await held.completed).code).toBe(74);
        expect(readFileSync(f.marker, "utf8")).toBe("successor marker");
        expect(lstatSync(f.marker).ino).toBe(successor);
        expect(readFileSync(join(displaced, "receiving-host-incomplete"), "utf8")).toBe("ccc-runtime-bind-authority:remote-incomplete:v1\n");
        expect(existsSync(f.effect)).toBe(false);
        expect(existsSync(f.lock)).toBe(false);
    });

    it("rereads held records from the beginning when native descriptor reopening shares offsets", () => {
        const f = fixture(); f.prepare();
        const nativeDd = spawnSync("/bin/sh", ["-c", "command -v dd"], { env: f.env, encoding: "utf8" }).stdout.trim();
        writeFileSync(join(f.bin, "dd"), [
            `#!${process.execPath}`,
            'const fs = require("node:fs"); const { spawnSync } = require("node:child_process");',
            'const args = process.argv.slice(2); const input = args.find(arg => /^if=\\/.*\\/(4|5)$/.test(arg));',
            'if (input) { const fd = Number(input.slice(-1)); const value = Buffer.alloc(16385); const size = fs.readSync(fd, value, 0, value.length, null); process.stdout.write(value.subarray(0, size)); }',
            `else { const result = spawnSync(${JSON.stringify(nativeDd)}, args, { stdio: "inherit" }); process.exit(result.status ?? 1); }`,
        ].join("\n"), { mode: 0o700 });
        writeFileSync(join(f.bin, "tail"), [
            `#!${process.execPath}`,
            'const fs = require("node:fs"); const args = process.argv.slice(2);',
            'const fd = Number(args[2]?.slice(-1)); const size = Number(args[1]);',
            // Model Apple's regular-file RBYTES seek: equality forces position zero.
            'if (args[0] !== "-c" || ![4, 5].includes(fd) || size !== fs.fstatSync(fd).size || size > 16384) process.exit(96);',
            'const value = Buffer.alloc(size); const count = fs.readSync(fd, value, 0, size, 0);',
            'const drain = Buffer.alloc(16385); while (fs.readSync(fd, drain, 0, drain.length, null) > 0) {}',
            'process.stdout.write(value.subarray(0, count));',
        ].join("\n"), { mode: 0o700 });
        const result = f.run(remoteRuntimeBindAuthorityShell('_ccc_bind_assert && _ccc_bind_assert && printf verified'));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("verified");
        expect(existsSync(f.lock)).toBe(false);
    });

    it("keeps authority validation and release in their held cwd when the body changes directory", () => {
        const f = fixture(); f.prepare();
        const result = f.run(remoteRuntimeBindAuthorityShell('cd "$HOME"; printf verified'));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("verified");
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(f.marker)).toBe(true);
    });

    it.each(["failed", "short", "oversized"])("refuses a %s bounded marker read before native effects", kind => {
        const f = fixture(); f.prepare();
        const nativeTail = spawnSync("/bin/sh", ["-c", "command -v tail"], { env: f.env, encoding: "utf8" }).stdout.trim();
        const output = kind === "oversized" ? "x".repeat(5000) : "short";
        writeFileSync(join(f.bin, "tail"), [
            "#!/bin/sh",
            'case "$3" in */4)',
            ` printf '%s' ${shellEscapeArg(output)}; exit ${kind === "failed" ? 7 : 0} ;; esac`,
            `exec ${shellEscapeArg(nativeTail)} "$@"`,
        ].join("\n"), { mode: 0o700 });
        const result = f.run(remoteRuntimeBindAuthorityShell(`printf changed > ${shellEscapeArg(f.effect)}`));
        expect(result.status, result.stderr).toBe(74);
        expect(existsSync(f.effect)).toBe(false);
        expect(existsSync(f.lock)).toBe(false);
    });

    it("retains the incomplete barrier when its exact owned shell is killed before release", async () => {
        const f = fixture(); const home = f.prepare();
        const held = f.start(remoteRuntimeBindAuthorityShell(waitBody(f.home)));
        await waitForFile(join(f.home, "ready"));
        process.kill(-held.child.pid!, "SIGKILL");
        expect((await held.completed).signal).toBe("SIGKILL");
        expect(existsSync(f.marker)).toBe(true);
        withRuntimeBindGuard(home, guard => expect(readRuntimeBindAuthority(guard)).toMatchObject({
            coverage: "incomplete", reason: "receiving-host-incomplete",
        }), { waitMs: 1000 });
    });

    it.each(["root-symlink", "root-writable", "authority-writable", "marker-symlink", "marker-readable"])(
        "refuses %s without protected effects or modifying foreign data", kind => {
            const f = fixture(); const external = join(f.home, "external");
            mkdirSync(external, { mode: 0o700 }); const sentinel = join(external, "sentinel");
            writeFileSync(sentinel, "preserve", { mode: 0o600 });
            if (kind === "root-symlink") symlinkSync(external, f.root);
            else {
                f.prepare();
                if (kind === "root-writable") chmodSync(f.root, 0o770);
                if (kind === "authority-writable") chmodSync(join(f.root, "runtime-bind-authority"), 0o770);
                if (kind === "marker-symlink") symlinkSync(sentinel, f.marker);
                if (kind === "marker-readable") writeFileSync(f.marker, "keep", { mode: 0o644 });
            }
            const result = f.run(remoteRuntimeBindAuthorityShell(`printf changed > ${shellEscapeArg(f.effect)}`));
            expect(result.status, result.stderr).toBe(74);
            expect(existsSync(f.effect)).toBe(false);
            expect(readFileSync(sentinel, "utf8")).toBe("preserve");
            if (kind === "marker-readable") expect(readFileSync(f.marker, "utf8")).toBe("keep");
        },
    );

    it.each(["stat", "link", "dd", "tail"])("refuses a missing %s safe primitive before creating credentials or native effects", missing => {
        const f = fixture(); f.prepare(); const limited = join(f.home, "limited-bin"); mkdirSync(limited, { mode: 0o700 });
        for (const tool of ["stat", "mkdir", "link", "rm", "mv", "hostname", "dd", "tail"]) {
            if (tool === missing) continue;
            const located = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
            expect(located.status).toBe(0);
            symlinkSync(located.stdout.trim(), join(limited, tool));
        }
        const result = f.run(remoteContainerStartScript("/project/owned-remote-fixture"), { PATH: limited });
        expect(result.status, result.stderr).toBe(75);
        expect(existsSync(join(f.root, "profiles"))).toBe(false);
        expect(existsSync(f.marker)).toBe(false);
        expect(existsSync(f.lock)).toBe(false);
    });

    it("preserves the existing session's pinned native ID through a held global admission", () => {
        const f = fixture(); f.prepare(); const project = "/project/owned-remote-session";
        const name = getContainerName(project); const log = installDocker(f, name); const token = "7".repeat(32);
        const result = f.run(remoteSessionReservationShell(name, token, 60, remoteContainerStartScript(project, undefined, true), true));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(`ccc-container-id=${containerId}`);
        const session = join(f.root, "remote-runtime", `sessions-${hashPath(name)}`, token);
        expect(readFileSync(session, "utf8").trim().split(/\s+/)[1]).toBe(containerId);
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`))).toBe(false);
        expect(f.run(remoteRefreshSessionShell(name, token, 60, true, containerId)).status).toBe(0);
        // Refresh/stop do not publish a bind, so the inert existing fixture does not require a global claim there.
        writeFileSync(join(f.bin, "docker"), `#!/bin/sh\nif [ "$1" = inspect ]; then printf '%s\\n' ${shellEscapeArg(`/${name}`)}; else printf '%s\\n' "$*" >> ${shellEscapeArg(log)}; fi\n`, { mode: 0o700 });
        expect(f.run(remoteStopShell(name, token, containerId)).status).toBe(0);
        expect(readFileSync(log, "utf8")).toContain(`stop ${containerId}`);
        expect(existsSync(session)).toBe(false);
        expect(existsSync(f.marker)).toBe(true);
    });

    it("keeps the existing lifecycle signal trap while releasing only its own global claim", async () => {
        const f = fixture(); f.prepare(); const name = "ccc-owned-bind-signal";
        const held = f.start(remoteSessionReservationShell(name, "8".repeat(32), 60,
            remoteRuntimeBindAuthorityShell(waitBody(f.home), true)));
        await waitForFile(join(f.home, "ready"));
        process.kill(-held.child.pid!, "SIGTERM");
        const result = await held.completed;
        expect(result.code === 143 || result.signal === "SIGTERM").toBe(true);
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`))).toBe(false);
        expect(existsSync(f.marker)).toBe(true);
    });

    it.each(["standalone", "nested"])("joins a TERM-ignoring native child before %s claim release", async kind => {
        const f = fixture(); f.prepare(); const name = "ccc-delayed-native";
        const lifecycle = join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`);
        const native = join(f.home, "delayed-native.cjs");
        writeFileSync(native, [
            'const fs = require("node:fs"); process.on("SIGTERM", () => {});',
            `fs.writeFileSync(${JSON.stringify(join(f.home, "ready"))}, "ready");`,
            `setTimeout(() => { if (!fs.existsSync(${JSON.stringify(f.lock)})${kind === "nested" ? ` || !fs.existsSync(${JSON.stringify(lifecycle)})` : ""}) fs.writeFileSync(${JSON.stringify(join(f.home, "released-early"))}, "unsafe"); fs.writeFileSync(${JSON.stringify(join(f.home, "native-effect"))}, "finished"); }, 500);`,
        ].join("\n"));
        const body = `${shellEscapeArg(process.execPath)} ${shellEscapeArg(native)}; printf late > ${shellEscapeArg(f.effect)}`;
        const global = remoteRuntimeBindAuthorityShell(body, kind === "nested");
        const held = f.start(kind === "nested" ? remoteSessionReservationShell(name, "8".repeat(32), 60, global) : global);
        await waitForFile(join(f.home, "ready"));
        process.kill(-held.child.pid!, "SIGTERM");
        expect((await held.completed).code).toBe(143);
        expect(existsSync(join(f.home, "native-effect"))).toBe(true);
        expect(existsSync(join(f.home, "released-early"))).toBe(false);
        expect(existsSync(f.effect)).toBe(false);
        expect(existsSync(f.lock)).toBe(false);
    });

    it.each([
        ["standalone", "existing-child"], ["standalone", "fork-after-snapshot"],
        ["nested", "existing-child"], ["nested", "fork-after-snapshot"],
    ] as const)("joins %s native parent and its %s before releasing claims", async (kind, phase) => {
        const f = fixture(); f.prepare(); const name = "ccc-native-foreground-parent";
        const lifecycleLock = join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`);
        const claims = [f.lock, ...(kind === "nested" ? [lifecycleLock] : [])];
        const childProgram = [
            'const fs = require("node:fs");',
            `fs.writeFileSync(${JSON.stringify(join(f.home, "native-child-ready"))}, "ready");`,
            `setTimeout(() => fs.writeFileSync(${JSON.stringify(join(f.home, "native-child-done"))},`,
            ` ${JSON.stringify(claims)}.every(path => fs.existsSync(path)) ? "claims-held" : "claims-released"), 500);`,
        ].join("\n");
        const program = join(f.home, "native-parent.cjs");
        writeFileSync(program, [
            'const fs = require("node:fs"); const { spawn } = require("node:child_process");',
            `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(join(f.home, "native-parent-terminated"))}, "unsafe"); process.exit(143); });`,
            `const begin = () => { const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { stdio: "ignore" });`,
            ` child.on("exit", () => fs.writeFileSync(${JSON.stringify(join(f.home, "native-parent-done"))}, "done")); };`,
            phase === "fork-after-snapshot" ? [
                `fs.writeFileSync(${JSON.stringify(join(f.home, "native-parent-ready"))}, "ready");`,
                `const gate = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(f.home, "fork-after-snapshot"))})) { clearInterval(gate); begin(); } }, 5);`,
            ].join("\n") : "begin();",
        ].join("\n"));
        const native = `${shellEscapeArg(process.execPath)} ${shellEscapeArg(program)}; printf late > ${shellEscapeArg(f.effect)}`;
        const global = remoteRuntimeBindAuthorityShell(native, kind === "nested");
        let script = kind === "nested" ? remoteLifecycleShell(name, global) : global;
        if (phase === "fork-after-snapshot") script = installProcessProbe(f, "fork-late")(script);
        const held = f.start(script);
        await waitForFile(join(f.home, phase === "fork-after-snapshot" ? "native-parent-ready" : "native-child-ready"));
        process.kill(held.child.pid!, "SIGTERM");
        expect((await held.completed).code).toBe(143);
        expect(readFileSync(join(f.home, "native-child-done"), "utf8")).toBe("claims-held");
        expect(existsSync(join(f.home, "native-parent-done"))).toBe(true);
        expect(existsSync(join(f.home, "native-parent-terminated"))).toBe(false);
        expect(existsSync(f.effect)).toBe(false);
        expect(existsSync(f.lock)).toBe(false);
        if (kind === "nested") expect(existsSync(lifecycleLock)).toBe(false);
    });

    it.each([
        ["standalone", "SIGHUP", 129], ["standalone", "SIGINT", 130], ["standalone", "SIGTERM", 143],
        ["nested", "SIGHUP", 129], ["nested", "SIGINT", 130], ["nested", "SIGTERM", 143],
    ] as const)("cancels %s work when only its owner PID receives %s", async (kind, signal, status) => {
        const f = fixture(); f.prepare(); const name = "ccc-owner-only-signal";
        const global = remoteRuntimeBindAuthorityShell(`${waitBody(f.home)}; printf late > ${shellEscapeArg(f.effect)}`, kind === "nested");
        const signalLog = join(f.home, "signal-diagnostic");
        const command = withScopeSignalDiagnostics(kind === "nested" ? remoteSessionReservationShell(name, "9".repeat(32), 60, global) : global);
        const held = f.start(`exec 2> ${shellEscapeArg(signalLog)}; ${command}`);
        await waitForFile(join(f.home, "ready"));
        process.kill(held.child.pid!, signal);
        const completed = await held.completed;
        expect(completed.code, readFileSync(signalLog, "utf8")).toBe(status);
        writeFileSync(join(f.home, "continue"), "continue");
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(existsSync(f.effect)).toBe(false);
        expect(existsSync(f.lock), readFileSync(signalLog, "utf8")).toBe(false);
        expect(existsSync(join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`))).toBe(false);
    });

    it.each(["standalone", "nested"])("cancels %s before worker admission without entering its body", async kind => {
        const f = fixture(); f.prepare(); const name = "ccc-before-ready";
        const probe = installProcessProbe(f, "admission");
        const global = remoteRuntimeBindAuthorityShell(`printf late > ${shellEscapeArg(f.effect)}`, kind === "nested");
        const held = f.start(probe(kind === "nested" ? remoteSessionReservationShell(name, "a".repeat(32), 60, global) : global));
        await waitForFile(join(f.home, "probe-ready"));
        process.kill(held.child.pid!, "SIGTERM");
        writeFileSync(join(f.home, "probe-continue"), "continue");
        expect((await held.completed).code).toBe(143);
        expect(existsSync(f.effect)).toBe(false);
        expect(existsSync(f.lock)).toBe(false);
        expect(existsSync(join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`))).toBe(false);
    });

    it("retains its lifecycle claim and sends no cancellation to a changed root identity", async () => {
        const f = fixture(); const name = "ccc-changed-root"; const probe = installProcessProbe(f, "root-change");
        const held = f.start(probe(remoteLifecycleShell(name, `${waitBody(f.home)}; printf late > ${shellEscapeArg(f.effect)}`)));
        await waitForFile(join(f.home, "ready"));
        writeFileSync(join(f.home, "change-proof"), "change");
        process.kill(held.child.pid!, "SIGTERM");
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(held.child.exitCode).toBeNull();
        expect(existsSync(join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`))).toBe(true);
        expect(existsSync(f.effect)).toBe(false);
        // This group was created detached by this fixture; terminate it after proving refusal.
        process.kill(-held.child.pid!, "SIGKILL");
        expect((await held.completed).signal).toBe("SIGKILL");
    });

    it("sends no CONT after TERM changes the root identity and retains its exact lifecycle claim", async () => {
        const f = fixture(); const name = "ccc-root-changed-after-term";
        const probe = installProcessProbe(f, "root-change");
        const lifecycle = join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`);
        const signals = join(f.home, "root-signals"); const diagnostic = join(f.home, "signal-diagnostic");
        const native = join(f.home, "retained-native.cjs");
        writeFileSync(signals, "", { mode: 0o600 });
        writeFileSync(native, [
            'const fs = require("node:fs");',
            `fs.writeFileSync(${JSON.stringify(join(f.home, "ready"))}, "ready"); setInterval(() => {}, 1000);`,
        ].join("\n"));
        const captureSignals = [
            "kill() {",
            ' if [ "$#" = 2 ] && [ -f "$HOME/probe-root" ] && [ "$2" = "$(cat "$HOME/probe-root")" ]; then',
            '  case "$1" in',
            '   -TERM) command kill "$@" || return $?;',
            '    printf "TERM\\n" >> "$HOME/root-signals"; printf changed > "$HOME/change-proof"; return 0 ;;',
            // A possible stale resume is recorded without dispatching to a changed identity.
            '   -CONT) if [ -e "$HOME/change-proof" ]; then printf "CONT\\n" >> "$HOME/root-signals"; return 0; fi ;;',
            '  esac',
            ' fi',
            ' command kill "$@"',
            "}",
        ].join("\n");
        const body = `${shellEscapeArg(process.execPath)} ${shellEscapeArg(native)}; printf late > ${shellEscapeArg(f.effect)}`;
        const held = f.start(`${captureSignals}\nexec 2> ${shellEscapeArg(diagnostic)}; ${probe(remoteLifecycleShell(name, body))}`);
        await waitForFile(join(f.home, "ready"));
        const claim = readFileSync(lifecycle); const inode = lstatSync(lifecycle).ino;
        process.kill(held.child.pid!, "SIGTERM");
        await waitForFile(diagnostic, "cancellation ownership unavailable; retaining claims");

        expect(existsSync(join(f.home, "changed-root-proof"))).toBe(true);
        expect(readFileSync(signals, "utf8")).toBe("TERM\n");
        expect(readFileSync(lifecycle)).toEqual(claim);
        expect(lstatSync(lifecycle).ino).toBe(inode);
        expect(existsSync(f.effect)).toBe(false);
        // The inert child keeps the owned root available for exact post-TERM observation.
        expect(held.child.exitCode).toBeNull();
        process.kill(-held.child.pid!, "SIGKILL");
        expect((await held.completed).signal).toBe("SIGKILL");
    });

    it("completes cancellation without CONT when the owned native child exits after TERM before resume", async () => {
        const f = fixture(); const name = "ccc-native-absent-before-resume";
        const lifecycle = join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`);
        const signals = join(f.home, "native-signals"); const diagnostic = join(f.home, "signal-diagnostic");
        const native = join(f.home, "exiting-native.cjs");
        writeFileSync(signals, "", { mode: 0o600 });
        writeFileSync(native, [
            'const fs = require("node:fs");',
            `fs.writeFileSync(${JSON.stringify(join(f.home, "native-pid"))}, String(process.pid));`,
            `fs.writeFileSync(${JSON.stringify(join(f.home, "ready"))}, "ready"); setInterval(() => {}, 1000);`,
        ].join("\n"));
        const exitBeforeResume = [
            "kill() {",
            ' if [ "$#" = 2 ] && [ -f "$HOME/native-pid" ] && [ "$2" = "$(cat "$HOME/native-pid")" ]; then',
            '  case "$1" in',
            '   -TERM)',
            '    _ccc_fixture_pid=$2',
            '    _ccc_fixture_state=$(/bin/ps -p "$_ccc_fixture_pid" -o state= 2>/dev/null) || return 1',
            '    case "$_ccc_fixture_state" in (*T*) ;; (*) printf running > "$HOME/fixture-error"; return 1 ;; esac',
            '    command kill "$@" || return $?',
            '    printf "TERM\\n" >> "$HOME/native-signals"',
            // TERM remains queued while this exact admitted fixture child is stopped.
            '    command kill -KILL "$_ccc_fixture_pid" || return $?',
            '    _ccc_fixture_attempt=0',
            '    while [ "$_ccc_fixture_attempt" -lt 100 ]; do',
            '     if _ccc_fixture_state=$(LC_ALL=C /bin/ps -p "$_ccc_fixture_pid" -o state= 2>/dev/null); then',
            '      case "$_ccc_fixture_state" in (*Z*) printf zombie > "$HOME/native-absent"; return 0 ;; esac',
            '     else',
            '      _ccc_fixture_absence=$(LC_ALL=C command kill -0 "$_ccc_fixture_pid" 2>&1) || true',
            '      case "$_ccc_fixture_absence" in (*"No such process"*) printf absent > "$HOME/native-absent"; return 0 ;; esac',
            '     fi',
            '     _ccc_fixture_attempt=$((_ccc_fixture_attempt + 1)); sleep 0.01',
            '    done',
            '    printf unavailable > "$HOME/fixture-error"; return 1 ;;',
            // Record any production resume attempt without signaling an absent PID.
            '   -CONT) printf "CONT\\n" >> "$HOME/native-signals"; return 0 ;;',
            '  esac',
            ' fi',
            ' command kill "$@"',
            "}",
        ].join("\n");
        const body = `${shellEscapeArg(process.execPath)} ${shellEscapeArg(native)}; printf late > ${shellEscapeArg(f.effect)}`;
        const held = f.start(`${exitBeforeResume}\nexec 2> ${shellEscapeArg(diagnostic)}; ${remoteLifecycleShell(name, body)}`);
        await waitForFile(join(f.home, "ready"));
        expect(existsSync(lifecycle)).toBe(true);
        process.kill(held.child.pid!, "SIGTERM");
        await waitForFile(join(f.home, "native-absent"));
        const completed = await held.completed;

        expect(existsSync(join(f.home, "fixture-error"))).toBe(false);
        expect(completed.code, readFileSync(diagnostic, "utf8")).toBe(143);
        expect(readFileSync(signals, "utf8")).toBe("TERM\n");
        expect(existsSync(f.effect)).toBe(false);
        expect(existsSync(lifecycle)).toBe(false);
        expect(readFileSync(diagnostic, "utf8")).not.toContain("cancellation ownership unavailable");
    });

    it("does not signal a changed descendant identity and retains the lifecycle claim", async () => {
        const f = fixture(); const name = "ccc-changed-child"; const probe = installProcessProbe(f, "child-change");
        const native = join(f.home, "retained-native.cjs");
        writeFileSync(native, [
            'const fs = require("node:fs");',
            `process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(join(f.home, "native-signaled"))}, "unsafe"));`,
            `fs.writeFileSync(${JSON.stringify(join(f.home, "ready"))}, "ready"); setTimeout(() => {}, 1000);`,
        ].join("\n"));
        const held = f.start(probe(remoteLifecycleShell(name, `${shellEscapeArg(process.execPath)} ${shellEscapeArg(native)}; printf late > ${shellEscapeArg(f.effect)}`)));
        await waitForFile(join(f.home, "ready"));
        writeFileSync(join(f.home, "change-proof"), "change");
        process.kill(held.child.pid!, "SIGTERM");
        const result = await held.completed;
        expect([74, 79]).toContain(result.code);
        expect(existsSync(join(f.home, "native-signaled"))).toBe(false);
        expect(existsSync(join(f.root, "remote-runtime", `lifecycle-${hashPath(name)}.lock`))).toBe(true);
        expect(existsSync(f.effect)).toBe(false);
    });
});
