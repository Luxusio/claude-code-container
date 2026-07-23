import { spawnSync } from "child_process";

const workerPid = Number(process.argv[2]);
const parentPid = Number(process.argv[3]);
let completed = false;
let cleanupStarted = false;

function terminateWorkerTree(force = false) {
    if (!Number.isInteger(workerPid) || workerPid <= 0) return;
    if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/pid", String(workerPid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 5000,
        });
        return;
    }
    try {
        process.kill(-workerPid, force ? "SIGKILL" : "SIGTERM");
    } catch {
        try {
            process.kill(workerPid, force ? "SIGKILL" : "SIGTERM");
        } catch {
            // The worker already exited.
        }
    }
}

function parentAlive() {
    if (!Number.isInteger(parentPid) || parentPid <= 0) return false;
    try {
        process.kill(parentPid, 0);
        return true;
    } catch {
        return false;
    }
}

function cleanAfterParentExit() {
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (completed) {
        process.exit(0);
        return;
    }
    terminateWorkerTree();
    setTimeout(() => {
        terminateWorkerTree(true);
        process.exit(0);
    }, 1000);
}

const parentTimer = setInterval(() => {
    if (!parentAlive()) {
        clearInterval(parentTimer);
        cleanAfterParentExit();
    }
}, 100);

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
    if (String(chunk).includes("complete")) completed = true;
});
process.stdin.on("end", () => {
    clearInterval(parentTimer);
    cleanAfterParentExit();
});
process.stdin.resume();
