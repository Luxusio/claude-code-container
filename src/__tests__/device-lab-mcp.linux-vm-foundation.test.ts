import { deviceLabTestHomeEnvironment } from "./helpers/device-lab-test-environment.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listLabs } from "@ccc/device-lab/providers/backends/linux-vm.mjs";

const repoRoot = join(__dirname, "../..");
const TIMEOUT = 30000;

describe("direct Linux inventory state admission", () => {
    it("returns an empty owner inventory without reading another owner's malformed lab", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-linux-observation-empty-"));
        try {
            const foreignLab = join(root, "owners", "foreign", "labs", "foreign-lab");
            mkdirSync(foreignLab, { recursive: true });
            writeFileSync(join(foreignLab, "lab.json"), "{");
            expect(listLabs({ stateRoot: root, ownerId: "current", strictState: true })).toEqual({ ok: true, ownerId: "current", labs: [] });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("omits malformed lab state ordinarily but rejects it when strict state is requested", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-linux-observation-invalid-"));
        try {
            const lab = join(root, "owners", "current", "labs", "broken-lab");
            mkdirSync(lab, { recursive: true });
            writeFileSync(join(lab, "lab.json"), "{");
            expect(listLabs({ stateRoot: root, ownerId: "current" })).toEqual({ ok: true, ownerId: "current", labs: [] });
            expect(() => listLabs({ stateRoot: root, ownerId: "current", strictState: true })).toThrow("lab-state-invalid");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

describe("device-lab Linux VM foundation", () => {
    let client: Client;
    let homeDir: string;
    let stateRoot: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-lab-mcp-home-"));
        stateRoot = join(homeDir, "labs");
        mkdirSync(stateRoot, { recursive: true });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                ...deviceLabTestHomeEnvironment(homeDir),
                NODE_ENV: "test",
                CCC_LAB_STATE_DIR: stateRoot,
                CCC_PROFILE: "lab-mcp-test",
            },
        });
        client = new Client({ name: "ccc-lab-mcp-test-client", version: "1.0.0" }, { capabilities: {} });
        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        rmSync(homeDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("lists Linux VM device tools without exposing legacy lab tools", { timeout: TIMEOUT }, async () => {
        const result = await client.listTools();
        const names = result.tools.map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining([
            "list_images",
            "import_image",
            "create_linux_vm",
            "start",
            "reboot",
            "stop",
            "delete",
            "snapshot",
            "status",
            "upload",
            "download",
            "exec",
        ]));
        expect(names.some((name) => name.startsWith("lab_"))).toBe(false);
        const createTool = result.tools.find((tool) => tool.name === "create_linux_vm");
        expect(createTool?.inputSchema).toEqual(expect.objectContaining({
            properties: expect.objectContaining({
                ssh: expect.objectContaining({ additionalProperties: false, properties: expect.objectContaining({
                    host: expect.objectContaining({ maxLength: 255 }),
                    port: expect.objectContaining({ minimum: 1, maximum: 65535 }),
                    user: expect.objectContaining({ maxLength: 64 }),
                    keyPath: expect.objectContaining({ maxLength: 4096 }),
                    readinessCommand: expect.objectContaining({ maxLength: 512 }),
                }) }),
                agent: expect.objectContaining({ additionalProperties: false, properties: expect.objectContaining({
                    healthCommand: expect.objectContaining({ maxLength: 512 }),
                    provisionCommand: expect.objectContaining({ maxLength: 4096 }),
                    autoProvision: expect.objectContaining({ type: "boolean" }),
                }) }),
            }),
        }));
        const guestExecTool = result.tools.find((tool) => tool.name === "exec");
        expect(guestExecTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["deviceId", "command"],
            properties: expect.objectContaining({
                command: expect.objectContaining({ maxLength: 4096 }),
                timeoutMs: expect.objectContaining({ minimum: 1, maximum: 600000 }),
            }),
        }));
        for (const removed of ["disk_materialize", "target_list", "readiness_probe", "session_open", "guest_agent_status", "guest_agent_provision"]) {
            expect(names).not.toContain(removed);
        }
        const statusTool = result.tools.find((tool) => tool.name === "status");
        expect(statusTool?.inputSchema.required).toEqual(["deviceId"]);
    });

    it("reports unsupported by default and still stores named lab metadata", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "devices", arguments: { view: "available", backend: "linux-vm", detail: true } });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(statusPayload).toEqual(expect.objectContaining({
            ok: true,
            backend: "linux-vm",
            discovery: expect.objectContaining({ provider: "container-qemu", available: false, status: "unsupported", stateRoot }),
        }));

        const created = await client.callTool({ name: "create_linux_vm", arguments: { detail: true,  name: "MCP Lab" } });
        const createPayload = JSON.parse(((created.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(createPayload).toEqual(expect.objectContaining({
            ok: true,
            device: expect.objectContaining({ deviceId: "mcp-lab", backend: "linux-vm", runtimeState: "stopped" }),
        }));

        const start = await client.callTool({ name: "start", arguments: { detail: true, deviceId: "mcp-lab" } });
        expect(start.isError).toBe(true);
        const startPayload = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(startPayload).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-provider-unsupported",
        }));

        const guestPush = await client.callTool({ name: "upload", arguments: { detail: true, deviceId: "mcp-lab", localPath: stateRoot, remotePath: "/workspace" } });
        expect(guestPush.isError).toBe(true);
        const guestPushPayload = JSON.parse(((guestPush.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(guestPushPayload).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-not-running",
        }));

        const observed = await client.callTool({ name: "status", arguments: { detail: true, deviceId: "mcp-lab" } });
        expect(observed.isError).not.toBe(true);
        const observedPayload = JSON.parse(((observed.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(observedPayload).toEqual(expect.objectContaining({
            ok: true,
            device: expect.objectContaining({ deviceId: "mcp-lab", runtimeState: "stopped" }),
            readiness: expect.objectContaining({ state: "stopped" }),
        }));
        const stopped = await client.callTool({ name: "stop", arguments: { detail: true, deviceId: "mcp-lab" } });
        expect(stopped.isError).not.toBe(true);
        expect(JSON.parse(((stopped.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(
            expect.objectContaining({ ok: true, stopped: false, device: expect.objectContaining({ runtimeState: "stopped" }) }),
        );
        const deleted = await client.callTool({ name: "delete", arguments: { detail: true, deviceId: "mcp-lab", confirmDestructive: true } });
        expect(deleted.isError, JSON.stringify(deleted.content)).not.toBe(true);
        expect(JSON.parse(((deleted.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(
            expect.objectContaining({ ok: true, deleted: true, labId: "mcp-lab" }),
        );
    });

    it("imports base images and creates labs from image catalog ids over MCP", { timeout: TIMEOUT }, async () => {
        mkdirSync(join(stateRoot, "incoming"), { recursive: true });
        writeFileSync(join(stateRoot, "incoming", "mcp-base.qcow2"), "mcp-base");

        const imported = await client.callTool({
            name: "import_image",
            arguments: { detail: true, name: "MCP Base", sourcePath: "incoming/mcp-base.qcow2" },
        });
        const importedPayload = JSON.parse(((imported.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(importedPayload).toEqual(expect.objectContaining({
            ok: true,
            image: expect.objectContaining({ id: "mcp-base", copied: true, format: "qcow2" }),
        }));

        const duplicate = await client.callTool({
            name: "import_image",
            arguments: { detail: true, name: "MCP Base", sourcePath: "incoming/missing.raw" },
        });
        expect(JSON.parse(((duplicate.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(
            expect.objectContaining({ ok: false, error: "base-image-already-exists", imageId: "mcp-base" }),
        );
        const reference = await client.callTool({
            name: "import_image",
            arguments: { detail: true, name: "MCP Reference", sourcePath: "incoming/mcp-base.qcow2", copy: false },
        });
        expect(JSON.parse(((reference.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(
            expect.objectContaining({ ok: true, image: expect.objectContaining({
                id: "mcp-reference", copied: false, format: "qcow2", sizeBytes: 8,
                path: join(stateRoot, "incoming", "mcp-base.qcow2"),
            }) }),
        );

        const listed = await client.callTool({ name: "list_images", arguments: { detail: true, } });
        const listedPayload = JSON.parse(((listed.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(listedPayload).toEqual(expect.objectContaining({
            ok: true,
            images: expect.arrayContaining([expect.objectContaining({ id: "mcp-base" })]),
        }));

        const created = await client.callTool({
            name: "create_linux_vm",
            arguments: { detail: true,  name: "MCP Image Lab", baseImageId: "mcp-base" },
        });
        const createdPayload = JSON.parse(((created.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(createdPayload).toEqual(expect.objectContaining({
            ok: true,
            device: expect.objectContaining({
                deviceId: "mcp-image-lab",
                image: expect.objectContaining({ baseImageId: "mcp-base" }),
            }),
        }));
    });
});
