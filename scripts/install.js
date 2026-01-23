#!/usr/bin/env node

import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const distFile = join(projectRoot, "dist", "index.js");
const isWindows = process.platform === "win32";

function getInstallDir() {
    if (isWindows) {
        const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
        return join(localAppData, "Programs", "ccc");
    } else {
        return "/usr/local/bin";
    }
}

function install() {
    // Always run npm install (dependencies may have updated)
    console.log("Installing dependencies...");
    execSync("npm install", { cwd: projectRoot, stdio: "inherit" });

    // Always build (source may have updated)
    console.log("Building...");
    execSync("npm run build", { cwd: projectRoot, stdio: "inherit" });

    const installDir = getInstallDir();

    if (isWindows) {
        mkdirSync(installDir, { recursive: true });
        const cmdPath = join(installDir, "ccc.cmd");
        const cmdContent = `@echo off\r\nnode "${distFile}" %*\r\n`;
        writeFileSync(cmdPath, cmdContent);
        console.log(`Installed: ${cmdPath}`);

        // Check PATH
        const pathDirs = (process.env.PATH || "").split(";");
        if (!pathDirs.some(p => p.toLowerCase() === installDir.toLowerCase())) {
            console.log(`\nAdd to PATH (run in PowerShell as Admin):`);
            console.log(`  [Environment]::SetEnvironmentVariable("Path", $env:Path + ";${installDir}", "User")`);
        }
    } else {
        const targetPath = join(installDir, "ccc");
        try {
            if (existsSync(targetPath)) {
                unlinkSync(targetPath);
            }
            symlinkSync(distFile, targetPath);
            chmodSync(distFile, 0o755);
            console.log(`Installed: ${targetPath}`);
        } catch (e) {
            if (e.code === "EACCES") {
                console.error("Permission denied. Run with sudo:");
                console.error("  sudo npm run install:global");
                process.exit(1);
            }
            throw e;
        }
    }

    console.log("\nDone! Run 'ccc --help' to verify.");
}

function uninstall() {
    const installDir = getInstallDir();

    if (isWindows) {
        const cmdPath = join(installDir, "ccc.cmd");
        if (existsSync(cmdPath)) {
            unlinkSync(cmdPath);
            console.log(`Removed: ${cmdPath}`);
        } else {
            console.log("Not installed.");
        }
    } else {
        const targetPath = join(installDir, "ccc");
        try {
            if (existsSync(targetPath)) {
                unlinkSync(targetPath);
                console.log(`Removed: ${targetPath}`);
            } else {
                console.log("Not installed.");
            }
        } catch (e) {
            if (e.code === "EACCES") {
                console.error("Permission denied. Run with sudo:");
                console.error("  sudo npm run uninstall:global");
                process.exit(1);
            }
            throw e;
        }
    }
}

// Main
const args = process.argv.slice(2);
if (args.includes("--uninstall") || args.includes("-u")) {
    uninstall();
} else {
    install();
}
