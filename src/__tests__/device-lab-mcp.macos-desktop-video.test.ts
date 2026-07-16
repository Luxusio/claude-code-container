import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleMacosTool } from "../../device-lab-mcp/src/backends/macos-vm.mjs";
import { cleanupFakeMacosMcpContext, createFakeMacosMcpContext, type FakeMacosMcpContext } from "./helpers/fake-macos-mcp-fixture.js";

describe("macOS VM desktop helper and video tools with fake Tart provider", () => {
    let context: FakeMacosMcpContext;
    let homeDir: string;
    let logPath: string;

    beforeAll(() => {
        context = createFakeMacosMcpContext();
        homeDir = context.homeDir;
        logPath = context.logPath;
    });

    afterAll(() => {
        cleanupFakeMacosMcpContext(context);
    });

    it("executes desktop helper, file transfer, screenshot, accessibility, and recording actions", async () => {
        const create = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Fake Tart",
            provider: "auto",
            image: "ghcr.io/example/macos:latest",
            memoryMb: 4096,
            cpus: 2,
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
        });
        expect(create?.isError).not.toBe(true);

        const start = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(start?.isError).not.toBe(true);
        const started = JSON.parse(((start?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { helper: { hostHelperScript: string; provisioning: { status: string; provider: string; remoteScriptPath: string } } };
            helper: { status: string; provider: string };
        };
        expect(started.helper).toEqual(expect.objectContaining({ status: "provisioned", provider: "ssh-scp" }));
        expect(started.device.helper.provisioning).toEqual(expect.objectContaining({
            status: "provisioned",
            provider: "ssh-scp",
            remoteScriptPath: "/tmp/ccc-macos-fake-tart-guest-helper.sh",
        }));
        const hostHelperScript = readFileSync(started.device.helper.hostHelperScript, "utf-8");
        expect(hostHelperScript).toContain("window_list)");
        expect(hostHelperScript).toContain("accessibility_snapshot)");

        const exec = await handleMacosTool("device_exec", { deviceId: "macos-fake-tart", command: "whoami" });
        expect(exec?.isError).not.toBe(true);
        expect(JSON.parse(((exec?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({
            stdout: "ssh output\n",
            stderr: "",
            status: 0,
            provider: "ssh",
        });

        const failedExec = await handleMacosTool("device_exec", { deviceId: "macos-fake-tart", command: "fail-command" });
        expect(failedExec?.isError).not.toBe(true);
        const failedExecPayload = JSON.parse(((failedExec?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            stdout: string;
            stderr: string;
            status: number;
        };
        expect(failedExecPayload.stdout).toContain("ssh failure stdout");
        expect(failedExecPayload.stderr).toContain("ssh failure stderr");
        expect(failedExecPayload.status).toBe(7);

        const uploadSource = join(homeDir, "mac-upload.txt");
        writeFileSync(uploadSource, "upload");
        const upload = await handleMacosTool("device_upload", { deviceId: "macos-fake-tart", localPath: uploadSource, remotePath: "/tmp/mac-upload.txt" });
        expect(upload?.isError).not.toBe(true);
        expect(JSON.parse(((upload?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({
            uploaded: { localPath: uploadSource, remotePath: "/tmp/mac-upload.txt" },
            stdout: "",
            stderr: "",
            provider: "scp",
        });

        const downloadTarget = join(homeDir, "mac-download.txt");
        const download = await handleMacosTool("device_download", { deviceId: "macos-fake-tart", remotePath: "/tmp/mac-download.txt", localPath: downloadTarget });
        expect(download?.isError).not.toBe(true);
        expect(JSON.parse(((download?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual({
            downloaded: { remotePath: "/tmp/mac-download.txt", localPath: downloadTarget },
            stdout: "",
            stderr: "",
            provider: "scp",
        });
        expect(readFileSync(downloadTarget, "utf-8")).toBe("fakepng");
        const transferLog = readFileSync(logPath, "utf-8");
        const uploadStagePath = transferLog.match(/scp .* (\/tmp\/ccc-device-upload-\S+\/payload) ccc@127\.0\.0\.1:\/tmp\/mac-upload\.txt/)?.[1];
        const downloadStagePath = transferLog.match(/ccc@127\.0\.0\.1:\/tmp\/mac-download\.txt (\/tmp\/ccc-device-download-\S+\/payload)/)?.[1];
        expect(uploadStagePath).toBeTruthy();
        expect(downloadStagePath).toBeTruthy();
        expect(existsSync(uploadStagePath || "")).toBe(false);
        expect(existsSync(downloadStagePath || "")).toBe(false);

        const logBeforeRejectedTransfer = readFileSync(logPath, "utf-8");
        const rejectedUpload = await handleMacosTool("device_upload", { deviceId: "macos-fake-tart", localPath: uploadSource, remotePath: "/tmp/bad file.txt" });
        expect(rejectedUpload?.isError).toBe(true);
        expect((rejectedUpload?.content as Array<{ text?: string }>)[0].text).toContain("upload-remote-path-scp-unsafe-path");
        const rejectedDownload = await handleMacosTool("device_download", { deviceId: "macos-fake-tart", remotePath: "/tmp/../escape.txt", localPath: join(homeDir, "bad-mac-download.txt") });
        expect(rejectedDownload?.isError).toBe(true);
        expect((rejectedDownload?.content as Array<{ text?: string }>)[0].text).toContain("download-remote-path-traversal-rejected");
        expect(readFileSync(logPath, "utf-8")).toBe(logBeforeRejectedTransfer);

        const screenshot = await handleMacosTool("device_screenshot", { deviceId: "macos-fake-tart" });
        expect(screenshot?.isError).not.toBe(true);
        expect((screenshot?.content as Array<{ type: string; data: string; mimeType: string }>)[0]).toEqual({
            type: "image",
            data: Buffer.from("fakepng").toString("base64"),
            mimeType: "image/png",
        });
        const screenshotLog = readFileSync(logPath, "utf-8");
        const localScreenshotPath = screenshotLog.match(/ccc@127\.0\.0\.1:\/tmp\/ccc-macos-fake-tart-[0-9a-f-]+-screenshot\.png (\S+)/)?.[1];
        expect(localScreenshotPath).toMatch(/ccc-macos-screenshot-/);
        expect(existsSync(localScreenshotPath || "")).toBe(false);

        const click = await handleMacosTool("device_click", {
            deviceId: "macos-fake-tart",
            x: 22,
            y: 33,
            button: "right",
        });
        expect(click?.isError).not.toBe(true);
        expect(JSON.parse(((click?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "ssh-macos-helper",
            remoteScriptPath: "/tmp/ccc-macos-fake-tart-guest-helper.sh",
            clicked: { x: 22, y: 33, button: "right" },
        }));

        const doubleClick = await handleMacosTool("device_double_click", {
            deviceId: "macos-fake-tart",
            x: 44,
            y: 55,
        });
        expect(doubleClick?.isError).not.toBe(true);
        expect(JSON.parse(((doubleClick?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "ssh-macos-helper",
            doubleClicked: { x: 44, y: 55, button: "left" },
        }));

        const key = await handleMacosTool("device_key", {
            deviceId: "macos-fake-tart",
            key: "Command+Shift+A",
        });
        expect(key?.isError).not.toBe(true);
        expect(JSON.parse(((key?.content as Array<{ text?: string }>)[0].text ?? "{}")).key).toEqual({
            key: "Command+Shift+A",
            keyCode: 0,
            modifiers: ["command", "shift"],
        });

        const unsupportedKey = await handleMacosTool("device_key", {
            deviceId: "macos-fake-tart",
            key: "Hyper+Nope",
        });
        expect(unsupportedKey?.isError).toBe(true);
        expect((unsupportedKey?.content as Array<{ text?: string }>)[0].text).toContain("Unsupported macOS key expression");
        const unsupportedModifier = await handleMacosTool("device_key", {
            deviceId: "macos-fake-tart",
            key: "Hyper+A",
        });
        expect(unsupportedModifier?.isError).toBe(true);
        expect((unsupportedModifier?.content as Array<{ text?: string }>)[0].text).toContain("Unsupported macOS key expression");

        const type = await handleMacosTool("device_type", {
            deviceId: "macos-fake-tart",
            text: "hello 'mac' {literal}",
        });
        expect(type?.isError).not.toBe(true);
        expect(JSON.parse(((type?.content as Array<{ text?: string }>)[0].text ?? "{}")).typed).toEqual({
            text: "hello 'mac' {literal}",
        });

        const scroll = await handleMacosTool("device_scroll", {
            deviceId: "macos-fake-tart",
            direction: "left",
            amount: 4,
        });
        expect(scroll?.isError).not.toBe(true);
        expect(JSON.parse(((scroll?.content as Array<{ text?: string }>)[0].text ?? "{}")).scrolled).toEqual({
            direction: "left",
            amount: 4,
        });

        const cursor = await handleMacosTool("device_cursor_position", { deviceId: "macos-fake-tart" });
        expect(cursor?.isError).not.toBe(true);
        expect(JSON.parse(((cursor?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "ssh-macos-helper",
            cursor: { x: 101, y: 202 },
        }));

        const windowList = await handleMacosTool("device_window_list", { deviceId: "macos-fake-tart" });
        expect(windowList?.isError).not.toBe(true);
        expect(JSON.parse(((windowList?.content as Array<{ text?: string }>)[0].text ?? "{}"))).toEqual(expect.objectContaining({
            provider: "macos-system-events",
            remoteScriptPath: "/tmp/ccc-macos-fake-tart-guest-helper.sh",
            windows: [
                expect.objectContaining({
                    processName: "TextEdit",
                    processId: 501,
                    title: "Notes",
                    role: "AXWindow",
                    position: [10, 20],
                    size: [300, 200],
                }),
            ],
        }));

        const accessibilitySnapshot = await handleMacosTool("device_accessibility_snapshot", {
            deviceId: "macos-fake-tart",
            maxDepth: 99,
            maxNodes: 5000,
        });
        expect(accessibilitySnapshot?.isError).not.toBe(true);
        const accessibilitySnapshotPayload = JSON.parse(((accessibilitySnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            remoteScriptPath: string;
            accessibility: {
                provider: string;
                maxDepth: number;
                maxNodes: number;
                nodeCount: number;
                root: { name: string; role: string; children: Array<{ name: string; role: string; children: Array<{ name: string; role: string }> }> };
            };
        };
        expect(accessibilitySnapshotPayload.provider).toBe("macos-system-events");
        expect(accessibilitySnapshotPayload.remoteScriptPath).toBe("/tmp/ccc-macos-fake-tart-guest-helper.sh");
        expect(accessibilitySnapshotPayload.accessibility).toEqual(expect.objectContaining({
            provider: "macos-system-events",
            maxDepth: 8,
            maxNodes: 1000,
            nodeCount: 3,
        }));
        expect(accessibilitySnapshotPayload.accessibility.root.children[0]).toEqual(expect.objectContaining({
            name: "TextEdit",
            role: "AXApplication",
            children: [expect.objectContaining({ name: "Notes", role: "AXWindow" })],
        }));

        const minimumAccessibilitySnapshot = await handleMacosTool("device_accessibility_snapshot", {
            deviceId: "macos-fake-tart",
            maxDepth: -9,
            maxNodes: 0,
        });
        expect(minimumAccessibilitySnapshot?.isError).not.toBe(true);
        expect(JSON.parse(((minimumAccessibilitySnapshot?.content as Array<{ text?: string }>)[0].text ?? "{}")).accessibility).toEqual(expect.objectContaining({
            maxDepth: 0,
            maxNodes: 1,
            nodeCount: 1,
            root: expect.objectContaining({ children: [] }),
        }));

        const initialRecordStatus = await handleMacosTool("device_record_video_status", { deviceId: "macos-fake-tart" });
        expect(initialRecordStatus?.isError).not.toBe(true);
        expect(JSON.parse(((initialRecordStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toBeNull();

        const stopWithoutRecording = await handleMacosTool("device_record_video_stop", { deviceId: "macos-fake-tart" });
        expect(stopWithoutRecording?.isError).toBe(true);
        expect((stopWithoutRecording?.content as Array<{ text?: string }>)[0].text).toContain("No macOS VM recording active");

        const recordStart = await handleMacosTool("device_record_video_start", {
            deviceId: "macos-fake-tart",
            remotePath: "/tmp/custom-macos-recording.mov",
            localPath: join(homeDir, "custom-macos-recording.mov"),
            timeLimitSec: 30,
        });
        expect(recordStart?.isError).not.toBe(true);
        const recordStartPayload = JSON.parse(((recordStart?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deviceId: string;
            recording: { active: boolean; provider: string; runtimeId: string; processIdentity: { pid: number; startToken: string; commandHash: string }; remotePath: string; localPath: string; timeLimitSec: number };
        };
        expect(recordStartPayload.deviceId).toBe("macos-fake-tart");
        expect(recordStartPayload.recording).toEqual(expect.objectContaining({
            active: true,
            provider: "ssh-screencapture-video",
            runtimeId: expect.any(String),
            processIdentity: expect.objectContaining({
                pid: expect.any(Number),
                startToken: expect.any(String),
                commandHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
            remotePath: "/tmp/custom-macos-recording.mov",
            localPath: join(homeDir, "custom-macos-recording.mov"),
            timeLimitSec: 30,
        }));

        const duplicateRecordStart = await handleMacosTool("device_record_video_start", { deviceId: "macos-fake-tart" });
        expect(duplicateRecordStart?.isError).toBe(true);
        expect((duplicateRecordStart?.content as Array<{ text?: string }>)[0].text).toContain("macOS VM recording already active");

        const logBeforeInvalidRecordStop = readFileSync(logPath, "utf-8");
        const invalidRecordStop = await handleMacosTool("device_record_video_stop", {
            deviceId: "macos-fake-tart",
            localPath: join(homeDir, ".env"),
        });
        expect(invalidRecordStop?.isError).toBe(true);
        expect((invalidRecordStop?.content as Array<{ text?: string }>)[0].text).toContain("recording-local-path-secret-looking-file");
        expect(readFileSync(logPath, "utf-8").slice(logBeforeInvalidRecordStop.length)).toBe("");

        const activeRecordStatus = await handleMacosTool("device_record_video_status", { deviceId: "macos-fake-tart" });
        expect(activeRecordStatus?.isError).not.toBe(true);
        expect(JSON.parse(((activeRecordStatus?.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: true,
            provider: "ssh-screencapture-video",
        }));

        const recordStop = await handleMacosTool("device_record_video_stop", { deviceId: "macos-fake-tart" });
        expect(recordStop?.isError).not.toBe(true);
        const recordStopPayload = JSON.parse(((recordStop?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            recording: { active: boolean; localPath: string };
            device: { recording: unknown };
        };
        expect(recordStopPayload.recording).toEqual(expect.objectContaining({
            active: false,
            provider: "ssh-screencapture-video",
            remotePath: "/tmp/custom-macos-recording.mov",
            localPath: join(homeDir, "custom-macos-recording.mov"),
            timeLimitSec: 30,
        }));
        expect(recordStopPayload.device.recording).toBeNull();
        expect(readFileSync(join(homeDir, "custom-macos-recording.mov"), "utf-8")).toBe("fakepng");

        const retryRecordingPath = join(homeDir, "retry-macos-recording.mov");
        writeFileSync(retryRecordingPath, "original");
        const retryRecordStart = await handleMacosTool("device_record_video_start", {
            deviceId: "macos-fake-tart",
            remotePath: "/tmp/fail-once-recording-copy.mov",
            localPath: retryRecordingPath,
        });
        expect(retryRecordStart?.isError).not.toBe(true);
        const rejectedRecordCopy = await handleMacosTool("device_record_video_stop", { deviceId: "macos-fake-tart" });
        expect(rejectedRecordCopy?.isError).toBe(true);
        expect((rejectedRecordCopy?.content as Array<{ text?: string }>)[0].text).toContain("remains pending finalization");
        expect(readFileSync(retryRecordingPath, "utf-8")).toBe("original");
        const pendingMacosRecording = await handleMacosTool("device_record_video_status", { deviceId: "macos-fake-tart" });
        expect(JSON.parse(((pendingMacosRecording?.content as Array<{ text?: string }>)[0].text ?? "{}")).recording).toEqual(expect.objectContaining({
            active: false,
            remotePath: "/tmp/fail-once-recording-copy.mov",
        }));
        const retriedRecordCopy = await handleMacosTool("device_record_video_stop", { deviceId: "macos-fake-tart" });
        expect(retriedRecordCopy?.isError).not.toBe(true);
        expect(readFileSync(retryRecordingPath, "utf-8")).toBe("fakepng");

        const stop = await handleMacosTool("device_stop", { deviceId: "macos-fake-tart" });
        expect(stop?.isError).not.toBe(true);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("ssh -p 2222 -o BatchMode=yes -o StrictHostKeyChecking=no ccc@127.0.0.1 whoami");
        expect(log).toContain("scp -P 2222 -o BatchMode=yes -o StrictHostKeyChecking=no");
        expect(log).toContain("ccc-guest-helper.sh ccc@127.0.0.1:/tmp/ccc-macos-fake-tart-guest-helper.sh");
        expect(log).toContain("chmod 700 '/tmp/ccc-macos-fake-tart-guest-helper.sh'");
        expect(log).toMatch(/screencapture -x '\/tmp\/ccc-macos-fake-tart-[0-9a-f-]+-screenshot\.png'/);
        expect(log).toMatch(/rm -f -- '\/tmp\/ccc-macos-fake-tart-[0-9a-f-]+-screenshot\.png'/);
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' click '22' '33' 'right'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' double_click '44' '55' 'left'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' key '0' 'command,shift'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' type 'hello '\\''mac'\\'' {literal}'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' scroll 'left' '4'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' cursor_position");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' window_list");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' accessibility_snapshot '8' '1000'");
        expect(log).toContain("'/tmp/ccc-macos-fake-tart-guest-helper.sh' accessibility_snapshot '0' '1'");
        expect(log).toContain("screencapture -v '/tmp/custom-macos-recording.mov'");
        expect(log).toContain("pkill -INT -f");
        expect(log).toMatch(/ccc@127\.0\.0\.1:\/tmp\/custom-macos-recording\.mov \/tmp\/ccc-device-download-\S+\/payload/);
        expect(log.match(/ccc@127\.0\.0\.1:\/tmp\/fail-once-recording-copy\.mov \/tmp\/ccc-device-download-\S+\/payload/g)).toHaveLength(2);
    });
});
