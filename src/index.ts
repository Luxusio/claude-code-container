#!/usr/bin/env node

import {spawnSync} from "child_process";
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,} from "fs";
import {homedir, tmpdir} from "os";
import {basename, join} from "path";

const cwd = process.cwd();
const projectName = basename(cwd).toLowerCase().replace(/\s+/g, "-");
const containerName = `ccc-${projectName}`;
const sandboxDir = join(cwd, ".claude/ccc");
const dockerfilePath = join(sandboxDir, "Dockerfile");
const dataDir = join(homedir(), ".ccc");
const idePort = 7142;

const defaultDockerfile = `FROM node:22-alpine

RUN apk add --no-cache git curl ca-certificates bash \\
    && npm install -g @anthropic-ai/claude-code \\
    && adduser -D -s /bin/bash -u 1000 claude \\
    && mkdir -p /workspace /claude \\
    && chown -R claude:claude /workspace /claude

USER claude
WORKDIR /workspace
`;

function init(): void {
    if (existsSync(dockerfilePath)) {
        console.log(`Already exists: ${dockerfilePath}`);
        return;
    }

    mkdirSync(sandboxDir, {recursive: true});
    writeFileSync(dockerfilePath, defaultDockerfile);
    console.log(`Created: .claude/ccc/Dockerfile`);
}

function generateCompose(exposeIdePort: boolean = false): string {
    mkdirSync(dataDir, {recursive: true});

    const portsSection = exposeIdePort ? `
    ports:
      - "${idePort}:${idePort}"` : "";

    const compose = `
services:
  sandbox:
    build: ${sandboxDir}
    container_name: ${containerName}
    volumes:
      - ${cwd}:/workspace
      - ${dataDir}:/claude
    environment:
      - CLAUDE_CONFIG_DIR=/claude
    working_dir: /workspace
    stdin_open: true
    tty: true${portsSection}
    read_only: true
    tmpfs:
      - /tmp:size=512m,mode=1777
      - /home/claude:size=256m,mode=755
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
      - DAC_OVERRIDE
    security_opt:
      - no-new-privileges:true
    pids_limit: 256
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
        reservations:
          memory: 512M
`.trim();

    const tempDir = mkdtempSync(join(tmpdir(), "claude-sandbox-"));
    const composePath = join(tempDir, "docker-compose.yml");
    writeFileSync(composePath, compose);
    return composePath;
}

function dockerCompose(args: string[]): ReturnType<typeof spawnSync> {
    let result = spawnSync("docker", ["compose", ...args], {stdio: "inherit"});

    if (result.error) {
        result = spawnSync("docker-compose", args, {stdio: "inherit"});
    }

    return result;
}

function run(composePath: string, cmd: string[]): void {
    console.log("Building container...");
    const buildResult = dockerCompose(["-f", composePath, "build"]);

    if (buildResult.status !== 0) {
        console.error("Build failed");
        process.exit(1);
    }

    spawnSync("docker", ["image", "prune", "-f"], {stdio: "ignore"});

    console.log("Starting container...");
    const runResult = dockerCompose(["-f", composePath, "run", "--rm", "sandbox", ...cmd]);

    dockerCompose(["-f", composePath, "down", "--rmi", "local"]);
    spawnSync("docker", ["image", "prune", "-f"], {stdio: "ignore"});

    if (runResult.error) {
        console.error("Run failed:", runResult.error.message);
        process.exit(1);
    }
}

function main(): void {
    const command = process.argv[2];

    if (command === "init") {
        init();
        return;
    }

    if (!existsSync(dockerfilePath)) {
        console.error("Dockerfile not found. Run: ccc init");
        process.exit(1);
    }

    const isIdeMode = command === "ide";
    const composePath = generateCompose(isIdeMode);

    process.on("exit", () => {
        try {
            rmSync(composePath, {recursive: true});
        } catch {
        }
    });

    if (command === "shell") {
        run(composePath, ["bash"]);
    } else {
        run(composePath, ["claude", "--dangerously-skip-permissions"]);
    }
}

main();
