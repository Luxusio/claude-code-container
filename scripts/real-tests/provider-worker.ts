import { writeFileSync } from "fs";
import { pathToFileURL } from "url";
import { consumeDeviceLabMcpToolCalls, consumeDeviceLabMcpToolSessions } from "./device-lab-mcp-client.ts";

const [, , file, outputFile] = process.argv;

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
        writeFileSync(outputFile, JSON.stringify({
            ok: true,
            file,
            name,
            result,
            toolCalls: consumeDeviceLabMcpToolCalls(),
            toolSessions: consumeDeviceLabMcpToolSessions(),
        }));
    } catch (error) {
        writeFileSync(outputFile, JSON.stringify({
            ok: false,
            file,
            name,
            error: serializeError(error),
        }));
        process.exitCode = 1;
    }
}

if (!file || !outputFile) {
    process.stderr.write("Usage: node provider-worker.ts <module> <output-file>\n");
    process.exitCode = 1;
} else {
    await main();
}
