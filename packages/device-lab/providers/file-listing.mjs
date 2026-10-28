import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { jsonResult } from "./responses.mjs";

export const LIST_FILES_DEFAULT_LIMIT = 100;
export const LIST_FILES_MAX_LIMIT = 500;
export const LIST_FILES_OUTPUT_LIMIT_BYTES = 12000;
export const LIST_FILES_COMMAND_LIMIT_CHARS = 4096;
const HEADER = "CCC-LIST-V1\0";
const TYPES = new Set(["file", "directory", "symlink", "other"]);
export function validateListFilesArgs(args = {}) {
    if (typeof args.path !== "string" || !args.path.length || args.path.length > 4096 || args.path.includes("\0")) return "list_files requires a nonempty path of at most 4096 characters without NUL";
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > LIST_FILES_MAX_LIMIT)) return "list_files limit must be an integer from 1 to 500";
    if (args.bundleId !== undefined && (typeof args.bundleId !== "string" || !args.bundleId || args.bundleId.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(args.bundleId))) return "list_files bundleId is invalid";
    if (args.containerType !== undefined && !["data", "app", "groups"].includes(args.containerType)) return "list_files containerType must be data, app, or groups";
    return null;
}
const shellQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
export function buildListFilesCommand(backend, args) {
    const error = validateListFilesArgs(args);
    if (error) throw new Error(error);
    const limit = args.limit ?? LIST_FILES_DEFAULT_LIMIT;
    let command;
    if (["windows-sandbox", "windows-vm"].includes(backend)) {
        const path = Buffer.from(args.path, "utf8").toString("base64");
        command = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path}'));$d=Get-Item -LiteralPath $p -Force;if(-not $d.PSIsContainer){throw 'list-files-not-directory'};$a=New-Object 'Collections.Generic.List[string]';$bytes=32;$tr=$false;foreach($f in [IO.Directory]::EnumerateFileSystemEntries($d.FullName)) {if($a.Count -ge ${limit}){$tr=$true;break};$i=Get-Item -LiteralPath $f -Force;$t=if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){'symlink'}elseif($i.PSIsContainer){'directory'}else{'file'};$e=[ordered]@{name=$i.Name;type=$t};if($t -eq 'file'){$e.size=$i.Length};$j=ConvertTo-Json -InputObject $e -Compress;$n=[Text.Encoding]::UTF8.GetByteCount($j)+1;if($bytes+$n -gt ${LIST_FILES_OUTPUT_LIMIT_BYTES}){$tr=$true;break};$bytes+=$n;$a.Add($j)};'{'+'"entries":['+($a -join ',')+']'+$(if($tr){',"truncated":true'})+'}'`;
    } else if (["android-emulator", "android-device", "linux-vm", "macos-vm"].includes(backend)) {
        const stat = backend === "macos-vm" ? 'stat -f %z "$f"' : 'stat -c %s -- "$f"';
        command = `LC_ALL=C;export LC_ALL;p=${shellQuote(args.path)};case "$p" in /*) ;; *) p=./$p;; esac;CDPATH= cd -P "$p" || exit 1;[ -r . ] && [ -x . ] || { printf '%s\\n' 'list-files-permission-denied' >&2;exit 1; };printf 'CCC-LIST-V1\\000';c=0;b=32;tr=0;for f in ./* ./.[!.]* ./..?*;do [ -e "$f" ] || [ -L "$f" ] || continue;if [ "$c" -ge ${limit} ];then tr=1;break;fi;n=\${f#./};s=;if [ -L "$f" ];then t=symlink;elif [ -d "$f" ];then t=directory;elif [ -f "$f" ];then t=file;s=$(${stat} 2>/dev/null) || s=;case "$s" in *[!0-9]*) s=;;esac;else t=other;fi;z=$((\${#n}+\${#s}+\${#t}+3));if [ $((b+z)) -gt ${LIST_FILES_OUTPUT_LIMIT_BYTES} ];then tr=1;break;fi;printf '%s\\000%s\\000%s\\000' "$t" "$s" "$n";b=$((b+z));c=$((c+1));done;printf 'END\\000%s\\000' "$tr"`;
    } else throw new Error("list-files-unsupported-backend");
    if (backend === "macos-vm") command = `/bin/sh -c ${shellQuote(command)}`;
    if (command.length > LIST_FILES_COMMAND_LIMIT_CHARS) throw new Error("list-files-path-exceeds-command-budget");
    return command;
}
function checkedListing(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.entries) || value.entries.length > LIST_FILES_MAX_LIMIT
        || (value.truncated !== undefined && value.truncated !== true)) throw new Error("list-files-invalid-output");
    const entries = value.entries.map(entry => {
        if (!entry || typeof entry.name !== "string" || !entry.name || entry.name.includes("/") || entry.name.includes("\0") || [".", ".."].includes(entry.name) || !TYPES.has(entry.type)) throw new Error("list-files-invalid-entry");
        if (entry.size !== undefined && (entry.type !== "file" || !Number.isSafeInteger(entry.size) || entry.size < 0)) throw new Error("list-files-invalid-size");
        return { name: entry.name, type: entry.type, ...(entry.size !== undefined ? { size: entry.size } : {}) };
    });
    return { entries, ...(value.truncated ? { truncated: true } : {}) };
}
export function parseListFilesOutput(stdout) {
    if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > LIST_FILES_OUTPUT_LIMIT_BYTES) throw new Error("list-files-output-limit");
    if (!stdout.startsWith(HEADER)) return checkedListing(JSON.parse(stdout));
    const parts = stdout.slice(HEADER.length).split("\0");
    const entries = [];
    while (parts[0] !== "END") {
        if (parts.length < 3 || entries.length >= LIST_FILES_MAX_LIMIT) throw new Error("list-files-invalid-output");
        const [type, size, name] = parts.splice(0, 3);
        if (size !== "" && !/^\d+$/.test(size)) throw new Error("list-files-invalid-size");
        entries.push({ name, type, ...(size ? { size: Number(size) } : {}) });
    }
    if (parts.length !== 3 || !["0", "1"].includes(parts[1]) || !/^\r?\n?$/.test(parts[2])) throw new Error("list-files-incomplete-output");
    return checkedListing({ entries, ...(parts[1] === "1" ? { truncated: true } : {}) });
}
export function listFilesFromExecResult(raw, args = {}) {
    if (raw?.isError) return raw;
    try {
        const texts = raw?.content?.filter(item => item.type === "text") || [];
        if (texts.length !== 1) throw new Error("list-files-invalid-execution-result");
        const envelope = JSON.parse(texts[0].text);
        if (envelope.ok === false || envelope.error) return jsonResult(envelope);
        const execution = typeof envelope.stdout === "string" ? envelope : envelope.result;
        if (!execution || typeof execution.stdout !== "string" || execution.ok === false || execution.error || execution.status !== 0) {
            return jsonResult({ ok: false, error: "list-files-execution-failed", execution: execution || envelope });
        }
        const listing = parseListFilesOutput(execution.stdout);
        if (listing.entries.length > (args.limit ?? LIST_FILES_DEFAULT_LIMIT)) throw new Error("list-files-entry-limit");
        return jsonResult({ ...listing, ...(execution.stderr ? { warnings: [execution.stderr] } : {}), ...(args.incarnationId ? { incarnationId: args.incarnationId } : {}) });
    } catch (error) { return jsonResult({ ok: false, error: "list-files-invalid-result", detail: error.message }); }
}

// Host reads are restricted to a verified simulator app container. Buffer the
// listing until all directory identities and containment checks still hold.
export function listContainedDirectory(containerRoot, requestedPath, limit = LIST_FILES_DEFAULT_LIMIT) {
    const error = validateListFilesArgs({ path: requestedPath, limit });
    if (error) throw new Error(error);
    const root = realpathSync(containerRoot);
    const path = resolve(root, requestedPath);
    const subpath = relative(root, path);
    if (subpath === ".." || subpath.startsWith(`..${sep}`) || resolve(root, subpath) !== path) throw new Error("list-files-container-escape");
    const components = [root];
    for (const part of subpath.split(sep).filter(Boolean)) components.push(join(components.at(-1), part));
    const identities = components.map(component => ({ path: component, stat: lstatSync(component) }));
    const assertBound = () => {
        if (realpathSync(containerRoot) !== root) throw new Error("list-files-container-changed");
        for (const item of identities) {
            const now = lstatSync(item.path);
            if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== item.stat.dev || now.ino !== item.stat.ino) throw new Error("list-files-container-changed");
        }
        if (realpathSync(path) !== path) throw new Error("list-files-container-escape");
    };
    assertBound();
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let directory;
    try {
        const bound = fstatSync(fd), expected = identities.at(-1).stat;
        if (bound.dev !== expected.dev || bound.ino !== expected.ino) throw new Error("list-files-container-changed");
        const anchor = process.platform === "linux" ? `/proc/self/fd/${fd}` : path;
        directory = opendirSync(anchor);
        assertBound();
        const entries = [];
        let bytes = 32, truncated = false;
        for (;;) {
            assertBound();
            const item = directory.readSync();
            assertBound();
            if (!item) break;
            if (entries.length >= limit) { truncated = true; break; }
            const type = item.isSymbolicLink() ? "symlink" : item.isDirectory() ? "directory" : item.isFile() ? "file" : "other";
            const entry = { name: item.name, type };
            if (type === "file") {
                const metadata = lstatSync(join(anchor, item.name));
                assertBound();
                if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("list-files-entry-changed");
                entry.size = metadata.size;
            }
            const count = Buffer.byteLength(JSON.stringify(entry)) + 1;
            if (bytes + count > LIST_FILES_OUTPUT_LIMIT_BYTES) { truncated = true; break; }
            entries.push(entry); bytes += count;
        }
        assertBound();
        return checkedListing({ entries, ...(truncated ? { truncated: true } : {}) });
    } finally { directory?.closeSync(); closeSync(fd); }
}
