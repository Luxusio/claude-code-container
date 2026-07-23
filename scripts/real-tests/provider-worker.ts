import { closeSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { consumeDeviceLabMcpToolCalls, consumeDeviceLabMcpToolSessions } from "./device-lab-mcp-client.ts";

const [, , file] = process.argv;
const parentPid = process.ppid;

const parentWatchdog = setInterval(() => {
    try {
        process.kill(parentPid, 0);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ESRCH") process.exit(143);
    }
}, 250);

function writeResult(value: unknown) {
    clearInterval(parentWatchdog);
    writeFileSync(3, JSON.stringify(value));
    closeSync(3);
}

function serializeError(error: unknown) {
    const value = error as { message?: string; stack?: string };
    return {
        message: value?.message || String(error),
        stack: value?.stack || value?.message || String(error),
    };
}

async function main() {
    let name = file;
    try {
        const mod = await import(pathToFileURL(file).href);
        name = mod.name || file;
        consumeDeviceLabMcpToolCalls();
        consumeDeviceLabMcpToolSessions();
        const result = await mod.run();
        writeResult({
            ok: true,
            file,
            name,
            result,
            toolCalls: consumeDeviceLabMcpToolCalls(),
            toolSessions: consumeDeviceLabMcpToolSessions(),
        });
        process.exit(0);
    } catch (error) {
        writeResult({
            ok: false,
            file,
            name,
            error: serializeError(error),
        });
        process.exit(1);
    }
}

if (!file) {
    process.stderr.write("Usage: node provider-worker.ts <module>\n");
    process.exitCode = 1;
} else {
    await main();
}
