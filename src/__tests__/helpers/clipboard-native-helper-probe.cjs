// Test actor: observe the real compiler and optionally replace an owned
// directory after it exits, before the product's publication callback runs.
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const originalSpawn = cp.spawn;
const originalSpawnSync = cp.spawnSync;
const log = process.env.CCC_CLIPBOARD_NATIVE_HELPER_LOG;
if (!log) throw new Error("Owned compiler observation log is required");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const record = value => fs.appendFileSync(log, JSON.stringify(value) + "\n", {mode: 0o600});
function startToken(pid) {
    const result = originalSpawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "stat=", "-o", "lstart="],
        {encoding: "utf8", timeout: 1000});
    const match = result.status === 0 && /^(\S+)\s+(.+)$/.exec(result.stdout.trim());
    return match && !match[1].includes("Z") ? `ps:${match[2]}` : null;
}
cp.spawn = function(command, args, options) {
    const child = Reflect.apply(originalSpawn, this, arguments);
    const program = typeof command === "string" ? path.basename(command) : "unknown";
    const kind = program === "cc" ? "compiler" : program.startsWith("clipboard-helper-darwin-") ? "helper" : "other";
    let sourceSha256;
    if (kind === "compiler" && Array.isArray(args)) {
        try { sourceSha256 = digest(fs.readFileSync(args.at(-1))); } catch { /* Recorded absence fails the witness. */ }
    }
    record({event: "spawn", kind, program, pid: child.pid ?? null,
        startToken: child.pid ? startToken(child.pid) : null, sourceSha256});
    child.once("error", error => record({event: "error", kind, pid: child.pid ?? null, code: error.code ?? null}));
    child.prependOnceListener("close", (status, signal) => {
        if (kind === "compiler" && status === 0 && process.env.CCC_CLIPBOARD_NATIVE_HELPER_SUBSTITUTE === "1") {
            try {
                const outputIndex = args.indexOf("-o");
                if (outputIndex < 0 || typeof args[outputIndex + 1] !== "string") throw new Error("No owned output");
                const output = args[outputIndex + 1];
                const bin = path.dirname(output);
                const moved = `${bin}.before-substitution`;
                fs.renameSync(bin, moved);
                fs.mkdirSync(bin, {mode: 0o700});
                const replacement = Buffer.from("owned replacement compiler output must remain untouched\n");
                fs.writeFileSync(output, replacement, {mode: 0o600, flag: "wx"});
                const stat = fs.lstatSync(output, {bigint: true});
                record({event: "substituted", kind, stage: path.basename(output), inode: String(stat.ino),
                    sha256: digest(replacement), mode: Number(stat.mode & 0o777n)});
            } catch { record({event: "probe-error", kind, code: "directory-substitution-failed"}); }
        }
        record({event: "close", kind, pid: child.pid ?? null, status, signal});
    });
    return child;
};
require("node:module").syncBuiltinESMExports();
