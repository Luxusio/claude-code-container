#!/usr/bin/env node

import {spawnSync} from "child_process";
import {createInterface} from "readline";
import {existsSync, mkdirSync, writeFileSync} from "fs";
import {homedir} from "os";
import {basename, join} from "path";
import {formatScannedFiles, scanVersionFiles} from "./scanner.js";

const cwd = process.cwd();
const projectName = basename(cwd).toLowerCase().replace(/\s+/g, "-");
const containerName = `ccc-${projectName}`;
const sandboxDir = join(cwd, ".claude/ccc");
const dockerfilePath = join(sandboxDir, "Dockerfile");
const composePath = join(sandboxDir, "docker-compose.yml");
const miseConfigPath = join(cwd, ".mise.toml");
const dataDir = join(homedir(), ".ccc");
const miseCacheDir = join(dataDir, "mise");
const baseDockerfile = `FROM node:22-alpine
RUN apk add --no-cache git curl ca-certificates bash \\
    && npm install -g @anthropic-ai/claude-code \\
    && adduser -D -s /bin/bash -u 1000 claude \\
    && mkdir -p /workspace /claude \\
    && chown -R claude:claude /workspace /claude
USER claude
RUN curl https://mise.run | sh
ENV PATH="/home/claude/.local/bin:$PATH"
WORKDIR /workspace`;

// Interactive prompt helper
async function prompt(question: string, options: string[]): Promise<number> {
    const rl = createInterface({input: process.stdin, output: process.stdout});

    return new Promise((resolve) => {
        console.log(`\n${question}`);
        options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));

        const ask = () => {
            rl.question("\nSelect [1-" + options.length + "]: ", (answer) => {
                const num = parseInt(answer, 10);
                if (num >= 1 && num <= options.length) {
                    rl.close();
                    resolve(num - 1);
                } else {
                    ask();
                }
            });
        };
        ask();
    });
}

// Detect project tools using Claude CLI and write mise.toml directly
function detectProjectToolsAndWriteMiseConfig(): void {
    console.log("Scanning project files...");
    const scannedFiles = scanVersionFiles(cwd);
    const filesContext = formatScannedFiles(scannedFiles);

    console.log(`Found ${scannedFiles.size} version file(s). Analyzing with Claude...`);

    const defaultContent = `[tools]
# No tools detected - add your tools here
# node = "22"
`;

    const promptText = `Context:
${filesContext}

Task:
Write "${miseConfigPath}" using Write tool.

Constraints:
- DO NOT output text, explanation, or markdown
- DO NOT add comments to the file
- DO NOT invent tools not found in the files above
- Allowed tool names: node, java, python, go, rust, ruby, php, deno, bun
- Java format: java = "temurin-17" or "temurin-21"
- Default versions when unclear: node="22", python="3.12", java="temurin-21", go="1.23", rust="1.83", ruby="3.3"

Format (exactly):
[tools]
<tool> = "<version>"

If no tools detected:
${defaultContent}`;

    spawnSync("claude", ["-p", promptText, "--allowedTools", "Read,Write"], {
        encoding: "utf-8",
        cwd: cwd,
        timeout: 60000,
        stdio: "inherit"
    });

    // Ensure file exists with default content if Claude didn't create it
    if (!existsSync(miseConfigPath)) {
        writeFileSync(miseConfigPath, defaultContent);
    }
}

// Generate mise.toml content (only used for non-auto mode)
function generateMiseConfig(): string {
    return `[tools]
# Add your tools here
# node = "22"
`;
}

// Generate Dockerfile content (only used for non-auto mode)
function generateDockerfileContent(): string {
    return baseDockerfile + `

# Add your customizations here
# Example: RUN apk add --no-cache openjdk17
`;
}

// Detect project tools using Claude CLI and write Dockerfile directly
function detectProjectToolsAndWriteDockerfile(): void {
    console.log("Scanning project files...");
    mkdirSync(sandboxDir, {recursive: true});

    const scannedFiles = scanVersionFiles(cwd);
    const filesContext = formatScannedFiles(scannedFiles);

    console.log(`Found ${scannedFiles.size} version file(s). Analyzing with Claude...`);

    const promptText = `Context:
${filesContext}

Task:
Write "${dockerfilePath}" using Write tool.

Base Dockerfile (always include this exactly):
${baseDockerfile}

Constraints:
- DO NOT output text, explanation, or markdown
- DO NOT add packages not needed by detected tools
- Package map: java->openjdk17,maven | python->python3,py3-pip | go->go | ruby->ruby | rust->rust,cargo

Format:
<base dockerfile above>
RUN apk add --no-cache <packages>  # only if tools detected

If no tools detected, just write the base Dockerfile as-is.`;

    spawnSync("claude", ["-p", promptText, "--allowedTools", "Read,Write"], {
        encoding: "utf-8",
        cwd: cwd,
        timeout: 60000,
        stdio: "inherit"
    });

    // Ensure file exists with default content if Claude didn't create it
    if (!existsSync(dockerfilePath)) {
        writeFileSync(dockerfilePath, baseDockerfile);
    }
}

// Create mise config
function createMiseConfig(auto: boolean): void {
    if (auto) {
        detectProjectToolsAndWriteMiseConfig();
    } else {
        const content = generateMiseConfig();
        writeFileSync(miseConfigPath, content);
    }
    console.log(`Created: .mise.toml`);
}

// Create Dockerfile
function createDockerfile(auto: boolean): void {
    if (auto) {
        detectProjectToolsAndWriteDockerfile();
    } else {
        mkdirSync(sandboxDir, {recursive: true});
        const content = generateDockerfileContent();
        writeFileSync(dockerfilePath, content);
    }
    console.log(`Created: .claude/ccc/Dockerfile`);
}

// Interactive init
async function init(): Promise<void> {
    // Check if already initialized
    if (existsSync(miseConfigPath)) {
        console.log("Already initialized: .mise.toml");
        return;
    }
    if (existsSync(dockerfilePath)) {
        console.log("Already initialized: .claude/ccc/Dockerfile");
        return;
    }

    // Mode selection
    const mode = await prompt("How do you want to configure the container?", [
        "mise (recommended) - Use mise.toml for tool versions",
        "Custom Dockerfile - Full control over container"
    ]);

    // Auto-configure selection
    const auto = await prompt("Auto-configure based on your project?", [
        "Yes - Analyze project files",
        "No - Create minimal template"
    ]);

    if (mode === 0) {
        createMiseConfig(auto === 0);
    } else {
        createDockerfile(auto === 0);
    }
}

function generateCompose(): void {
    mkdirSync(sandboxDir, {recursive: true});
    mkdirSync(dataDir, {recursive: true});
    mkdirSync(miseCacheDir, {recursive: true});

    const compose = `
services:
  sandbox:
    build: .
    container_name: ${containerName}
    volumes:
      - ${cwd}:/workspace
      - ${dataDir}:/claude
      - ${miseCacheDir}:/home/claude/.local/share/mise
    environment:
      - CLAUDE_CONFIG_DIR=/claude
    working_dir: /workspace
    stdin_open: true
    tty: true
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

    writeFileSync(composePath, compose);
}

function dockerCompose(args: string[]): ReturnType<typeof spawnSync> {
    let result = spawnSync("docker", ["compose", ...args], {stdio: "inherit"});

    if (result.error) {
        result = spawnSync("docker-compose", args, {stdio: "inherit"});
    }

    return result;
}

function run(cmd: string[], useMise: boolean): void {
    // Generate base Dockerfile if not exists
    if (!existsSync(dockerfilePath)) {
        mkdirSync(sandboxDir, {recursive: true});
        writeFileSync(dockerfilePath, baseDockerfile);
    }

    console.log("Building container...");
    const buildResult = dockerCompose(["-f", composePath, "build"]);
    if (buildResult.status !== 0) {
        console.error("Build failed");
        process.exit(1);
    }
    spawnSync("docker", ["image", "prune", "-f"], {stdio: "ignore"});

    console.log("Starting container...");
    const finalCmd = useMise && cmd[0] === "claude"
        ? ["sh", "-c", "mise install --yes 2>/dev/null; exec " + cmd.join(" ")]
        : cmd;

    const runResult = dockerCompose(["-f", composePath, "run", "--rm", "sandbox", ...finalCmd]);
    dockerCompose(["-f", composePath, "down"]);

    if (runResult.error) {
        console.error("Run failed:", runResult.error.message);
        process.exit(1);
    }
}

async function main(): Promise<void> {
    const command = process.argv[2];

    if (command === "init") {
        await init();
        return;
    }

    const useMise = existsSync(miseConfigPath);
    generateCompose();

    if (command === "shell") {
        run(["bash"], useMise);
    } else {
        run(["claude", "--dangerously-skip-permissions"], useMise);
    }
}

main();
