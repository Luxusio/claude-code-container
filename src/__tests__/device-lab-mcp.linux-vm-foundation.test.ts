import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");
const TIMEOUT = 30000;

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
                HOME: homeDir,
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
            "device_image_list",
            "device_image_import",
            "device_create",
            "device_disk_materialize",
            "device_start",
            "device_reboot",
            "device_stop",
            "device_delete",
            "device_target_list",
            "device_readiness_probe",
            "device_session_open",
            "device_snapshot_create",
            "device_snapshot_restore",
            "device_snapshot_delete",
            "device_workspace_sync",
            "device_artifacts_export",
            "device_upload",
            "device_download",
            "device_exec",
            "device_guest_agent_status",
            "device_guest_agent_provision",
        ]));
        expect(names.some((name) => name.startsWith("lab_"))).toBe(false);
        const createTool = result.tools.find((tool) => tool.name === "device_create");
        expect(createTool?.inputSchema).toEqual(expect.objectContaining({
            properties: expect.objectContaining({
                guestSshHost: expect.objectContaining({ maxLength: 255 }),
                guestSshPort: expect.objectContaining({ minimum: 1, maximum: 65535 }),
                guestSshUser: expect.objectContaining({ maxLength: 64 }),
                guestSshKeyPath: expect.objectContaining({ maxLength: 4096 }),
                guestReadinessCommand: expect.objectContaining({ maxLength: 512 }),
                guestAgentName: expect.objectContaining({ maxLength: 64 }),
                guestAgentHealthCommand: expect.objectContaining({ maxLength: 512 }),
                guestAgentProvisionCommand: expect.objectContaining({ maxLength: 4096 }),
                guestAgentAutoProvision: expect.objectContaining({ type: "boolean" }),
            }),
        }));
        const guestExecTool = result.tools.find((tool) => tool.name === "device_exec");
        expect(guestExecTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["deviceId", "command"],
            properties: expect.objectContaining({
                command: expect.objectContaining({ maxLength: 4096 }),
                timeoutMs: expect.objectContaining({ minimum: 1, maximum: 600000 }),
            }),
        }));
        const openSessionTool = result.tools.find((tool) => tool.name === "device_session_open");
        expect(openSessionTool?.inputSchema).toEqual(expect.objectContaining({
            properties: expect.objectContaining({
                sessionType: expect.objectContaining({ enum: ["monitor", "metadata", "guest-ssh", "guest-agent"] }),
            }),
        }));
        const guestAgentStatusTool = result.tools.find((tool) => tool.name === "device_guest_agent_status");
        expect(guestAgentStatusTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["backend", "deviceId"],
            properties: expect.objectContaining({
                timeoutMs: expect.objectContaining({ minimum: 1, maximum: 600000 }),
            }),
        }));
        const guestAgentProvisionTool = result.tools.find((tool) => tool.name === "device_guest_agent_provision");
        expect(guestAgentProvisionTool?.inputSchema).toEqual(expect.objectContaining({
            required: ["backend", "deviceId"],
            properties: expect.objectContaining({
                timeoutMs: expect.objectContaining({ minimum: 1, maximum: 600000 }),
            }),
        }));
    });

    it("reports unsupported by default and still stores named lab metadata", { timeout: TIMEOUT }, async () => {
        const status = await client.callTool({ name: "device_inventory", arguments: { backend: "linux-vm" } });
        const statusPayload = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(statusPayload).toEqual(expect.objectContaining({
            ok: true,
            backend: "linux-vm",
            discovery: expect.objectContaining({ provider: "container-qemu", available: false, status: "unsupported", stateRoot }),
        }));

        const created = await client.callTool({ name: "device_create", arguments: { backend: "linux-vm", name: "MCP Lab" } });
        const createPayload = JSON.parse(((created.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(createPayload).toEqual(expect.objectContaining({
            ok: true,
            device: expect.objectContaining({ id: "mcp-lab", deviceId: "mcp-lab", backend: "linux-vm", runtimeState: "stopped" }),
        }));

        const start = await client.callTool({ name: "device_start", arguments: { backend: "linux-vm", deviceId: "mcp-lab" } });
        expect(start.isError).toBe(true);
        const startPayload = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(startPayload).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-provider-unsupported",
        }));

        const materialize = await client.callTool({ name: "device_disk_materialize", arguments: { backend: "linux-vm", deviceId: "mcp-lab" } });
        expect(materialize.isError).toBe(true);
        const materializePayload = JSON.parse(((materialize.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(materializePayload).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-not-found",
        }));

        const guestPush = await client.callTool({ name: "device_upload", arguments: { backend: "linux-vm", deviceId: "mcp-lab", localPath: stateRoot, remotePath: "/workspace" } });
        expect(guestPush.isError).toBe(true);
        const guestPushPayload = JSON.parse(((guestPush.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(guestPushPayload).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-not-running",
        }));

        const targets = await client.callTool({ name: "device_target_list", arguments: { backend: "linux-vm" } });
        const targetsPayload = JSON.parse(((targets.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(targetsPayload).toEqual(expect.objectContaining({
            ok: true,
            targets: [expect.objectContaining({ labId: "mcp-lab", targetKind: "lab-vm", readiness: "stopped" })],
        }));

        const session = await client.callTool({ name: "device_session_open", arguments: { backend: "linux-vm", deviceId: "mcp-lab", sessionId: "metadata-session", sessionType: "metadata" } });
        const sessionPayload = JSON.parse(((session.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(sessionPayload).toEqual(expect.objectContaining({
            ok: true,
            session: expect.objectContaining({
                id: "metadata-session",
                state: "unavailable",
                authority: "device-lab-metadata",
            }),
        }));

        const readiness = await client.callTool({ name: "device_readiness_probe", arguments: { backend: "linux-vm", deviceId: "mcp-lab" } });
        expect(readiness.isError).toBe(true);
        const readinessPayload = JSON.parse(((readiness.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(readinessPayload).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-not-running",
            readiness: expect.objectContaining({ state: "stopped" }),
        }));
    });

    it("imports base images and creates labs from image catalog ids over MCP", { timeout: TIMEOUT }, async () => {
        mkdirSync(join(stateRoot, "incoming"), { recursive: true });
        writeFileSync(join(stateRoot, "incoming", "mcp-base.qcow2"), "mcp-base");

        const imported = await client.callTool({
            name: "device_image_import",
            arguments: { backend: "linux-vm", name: "MCP Base", sourcePath: "incoming/mcp-base.qcow2" },
        });
        const importedPayload = JSON.parse(((imported.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(importedPayload).toEqual(expect.objectContaining({
            ok: true,
            image: expect.objectContaining({ id: "mcp-base", copied: true, format: "qcow2" }),
        }));

        const listed = await client.callTool({ name: "device_image_list", arguments: { backend: "linux-vm" } });
        const listedPayload = JSON.parse(((listed.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(listedPayload).toEqual(expect.objectContaining({
            ok: true,
            images: expect.arrayContaining([expect.objectContaining({ id: "mcp-base" })]),
        }));

        const created = await client.callTool({
            name: "device_create",
            arguments: { backend: "linux-vm", name: "MCP Image Lab", baseImageId: "mcp-base" },
        });
        const createdPayload = JSON.parse(((created.content as Array<{ text?: string }>)[0].text ?? "{}"));
        expect(createdPayload).toEqual(expect.objectContaining({
            ok: true,
            device: expect.objectContaining({
                id: "mcp-image-lab",
                image: expect.objectContaining({ baseImageId: "mcp-base" }),
            }),
        }));
    });
});
