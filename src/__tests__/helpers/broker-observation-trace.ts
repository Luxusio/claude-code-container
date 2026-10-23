import { closeSync, openSync, readSync } from "node:fs";
import { constants } from "node:os";

const LIMIT = 8192;
const UNAVAILABLE = "[broker observation trace unavailable]";
const TRUNCATED = "[broker observation trace truncated]";
const booleanFields = ["runtimeAvailable", "pidPresent", "pidMatches", "commandPresent", "entryMatches", "serveMatches", "portMatches", "startTokenPresent", "startTokenMatches", "startedAtPresent", "startedAtMatches", "threw"];

/** Observe existing fixture calls without adding a request or changing native results. */
export function brokerObservationTracePreloadSource(options: { port: number; runtimeFile: string; traceFile: string }): string {
    return String.raw`
(() => {
    const cp = require('node:child_process'), traceFs = require('node:fs');
    const constants = require('node:os').constants;
    const settings = ${JSON.stringify(options)}, limit = ${LIMIT};
    const parse = JSON.parse, stringify = JSON.stringify, spawnSync = cp.spawnSync;
    const marker = '\n{"truncated":true}\n';
    let selectedPid = null;
    const validPid = value => Number.isSafeInteger(value) && value > 0;
    const known = (table, value) => typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value) ? value : null;
    const text = value => typeof value === 'string' || Buffer.isBuffer(value) ? String(value) : '';
    const bytes = value => Buffer.isBuffer(value) ? value.length : typeof value === 'string' ? Buffer.byteLength(value) : 0;
    function runtime() {
        try {
            const value = parse(traceFs.readFileSync(settings.runtimeFile, 'utf8'));
            return value && Number(value.port) === settings.port && validPid(Number(value.pid)) ? value : null;
        } catch { return null; }
    }
    function record(value) {
        let fd;
        try {
            try { fd = traceFs.openSync(settings.traceFile, 'r+'); }
            catch (error) { if (error.code !== 'ENOENT') return; fd = traceFs.openSync(settings.traceFile, 'wx', 0o600); }
            const size = traceFs.fstatSync(fd).size;
            if (!Number.isSafeInteger(size) || size < 0 || size > limit) return;
            const line = Buffer.from(stringify(value) + '\n');
            const output = size + line.length <= limit ? line : Buffer.from(marker);
            const position = Math.min(size, limit - output.length);
            let offset = 0;
            while (offset < output.length) {
                const written = traceFs.writeSync(fd, output, offset, output.length - offset, position + offset);
                if (!(written > 0)) break;
                offset += written;
            }
        } catch { /* Private diagnostics cannot replace the observed result. */ }
        finally { if (fd !== undefined) { try { traceFs.closeSync(fd); } catch {} } }
    }
    cp.spawnSync = function(command, args) {
        let stage = null, saved = null, observedPid = null;
        try {
            if (command === '/usr/sbin/lsof' && Array.isArray(args) && args.length === 4
                && args[0] === '-nP' && args[1] === '-iTCP:' + settings.port && args[2] === '-sTCP:LISTEN' && args[3] === '-Fp') {
                stage = 'lsof'; saved = runtime(); selectedPid = null;
            } else if (command === '/bin/ps' && Array.isArray(args) && args.length === 4
                && args[0] === '-p' && typeof args[1] === 'string' && args[2] === '-o' && ['command=', 'lstart='].includes(args[3])) {
                saved = runtime(); observedPid = Number(args[1]);
                if (validPid(observedPid) && String(observedPid) === args[1]
                    && (observedPid === selectedPid || saved && observedPid === Number(saved.pid))) {
                    stage = args[3] === 'command=' ? 'ps-command' : 'ps-start';
                }
            }
        } catch { /* A failed trace admission leaves the native call untouched. */ }
        function observe(result, thrown) {
            if (!stage) return;
            try {
                const stdout = text(result?.stdout);
                if (stage === 'lsof' && result?.status === 0) {
                    const pid = Number(stdout.match(/^p(\d+)$/m)?.[1]);
                    selectedPid = validPid(pid) ? pid : null;
                }
                const pid = stage === 'lsof' ? selectedPid : observedPid;
                const value = {
                    stage, status: Number.isInteger(result?.status) && result.status >= 0 && result.status <= 255 ? result.status : null,
                    signal: known(constants.signals, result?.signal), errno: known(constants.errno, thrown?.code || result?.error?.code),
                    threw: thrown !== undefined, stdoutBytes: bytes(result?.stdout), stderrBytes: bytes(result?.stderr),
                    runtimeAvailable: Boolean(saved), pidMatches: Boolean(saved && pid === Number(saved.pid)),
                };
                if (stage === 'lsof') value.pidPresent = validPid(pid);
                if (stage === 'ps-start') {
                    value.startTokenPresent = stdout.trim().length > 0;
                    value.startTokenMatches = Boolean(saved && result?.status === 0 && 'ps:' + stdout.trim() === saved.processStartToken);
                }
                if (stage === 'ps-command') {
                    const tokens = Array.from(stdout.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g), match => match[1] ?? match[2] ?? match[3]);
                    const normalize = value => String(value || '').replace(/\\/g, '/').toLowerCase();
                    value.commandPresent = stdout.trim().length > 0;
                    value.entryMatches = Boolean(saved && Array.isArray(saved.args) && tokens.length > 1
                        && normalize(tokens[0]) === normalize(saved.command) && normalize(tokens[1]) === normalize(saved.args[0]));
                    value.serveMatches = /\bdevices\s+broker\s+serve\b/i.test(stdout);
                    value.portMatches = new RegExp('(?:^|\\s)--port(?:=|\\s+)' + settings.port + '(?:\\s|$)').test(stdout);
                }
                record(value);
            } catch { /* Native outputs are never copied into diagnostics. */ }
        }
        let result;
        try { result = spawnSync.apply(this, arguments); }
        catch (error) { observe(null, error); throw error; }
        observe(result);
        return result;
    };
    JSON.parse = function(value, reviver) {
        const parsed = parse.apply(this, arguments);
        if (typeof reviver !== 'function') {
            try {
                const broker = parsed?.broker;
                if (broker?.name === 'ccc-device-broker' && broker.mode === 'host-broker-daemon' && Number(broker.port) === settings.port) {
                    const saved = runtime(), pid = Number(broker.process?.pid);
                    record({ stage: 'status', runtimeAvailable: Boolean(saved), pidPresent: validPid(pid),
                        pidMatches: Boolean(saved && pid === Number(saved.pid)),
                        startTokenPresent: typeof broker.process?.startToken === 'string' && broker.process.startToken.length > 0,
                        startTokenMatches: Boolean(saved && typeof broker.process?.startToken === 'string' && broker.process.startToken === saved.processStartToken),
                        startedAtPresent: typeof broker.startedAt === 'string' && broker.startedAt.length > 0,
                        startedAtMatches: Boolean(saved && typeof broker.startedAt === 'string' && broker.startedAt === saved.startedAt) });
                }
            } catch { /* Parsing and its exact result remain authoritative. */ }
        }
        return parsed;
    };
    require('node:module').syncBuiltinESMExports();
})();
`;
}

/** Return only the approved receipt schema, even if the private file is damaged. */
export function readBrokerObservationTrace(traceFile: string): string {
    let fd: number | undefined;
    try {
        fd = openSync(traceFile, "r");
        const buffer = Buffer.alloc(LIMIT + 1);
        let length = 0;
        while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length, length);
            if (count === 0) break;
            length += count;
        }
        if (length > LIMIT) return TRUNCATED;
        const content = buffer.subarray(0, length).toString("utf8");
        if (content.includes('\n{"truncated":true}\n')) return TRUNCATED;
        const lines = content.trim().split("\n").filter(Boolean);
        if (!lines.length) return UNAVAILABLE;
        const receipts = lines.map(line => {
            const parsed = JSON.parse(line);
            if (!["lsof", "ps-command", "ps-start", "status"].includes(parsed?.stage)) throw new Error("unknown trace stage");
            const safe: Record<string, unknown> = { stage: parsed.stage };
            for (const field of booleanFields) if (typeof parsed[field] === "boolean") safe[field] = parsed[field];
            if (parsed.stage !== "status") {
                safe.status = Number.isInteger(parsed.status) && parsed.status >= 0 && parsed.status <= 255 ? parsed.status : null;
                safe.signal = typeof parsed.signal === "string" && Object.hasOwn(constants.signals, parsed.signal) ? parsed.signal : null;
                safe.errno = typeof parsed.errno === "string" && Object.hasOwn(constants.errno, parsed.errno) ? parsed.errno : null;
                for (const field of ["stdoutBytes", "stderrBytes"]) {
                    if (Number.isSafeInteger(parsed[field]) && parsed[field] >= 0) safe[field] = parsed[field];
                }
            }
            return JSON.stringify(safe);
        });
        const summary = receipts.join("\n");
        return Buffer.byteLength(summary) <= LIMIT ? summary : TRUNCATED;
    } catch { return UNAVAILABLE; }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
