#!/usr/bin/env node

import {spawnSync} from "child_process";
import {createInterface} from "readline";
import {existsSync, mkdirSync, writeFileSync} from "fs";
import {homedir, platform} from "os";
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
const defaultImage = "1uxus/claude-code-container:latest";

// Shell config files to auto-detect and mount
const SHELL_CONFIGS = [
    ".bashrc", ".bash_profile", ".profile",
    ".zshrc", ".zprofile", ".zshenv",
    ".gitconfig", ".inputrc"
];

// Normalize path for Docker volume mounts (Windows compatibility)
function dockerPath(p: string): string {
    if (platform() === "win32") {
        // C:\Users\... → /c/Users/...
        return p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
    }
    return p;
}

// Detect existing shell config files and generate mount strings
function getShellConfigMounts(): string[] {
    const home = homedir();
    const mounts: string[] = [];

    for (const file of SHELL_CONFIGS) {
        const hostPath = join(home, file);
        if (existsSync(hostPath)) {
            mounts.push(`      - ${dockerPath(hostPath)}:/home/claude/${file}:ro`);
        }
    }
    return mounts;
}

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
    return `FROM ${defaultImage}

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

    const defaultContent = `FROM ${defaultImage}

# No additional tools detected
`;

    const promptText = `Context:
${filesContext}

Task:
Write "${dockerfilePath}" using Write tool.

Constraints:
- DO NOT output text, explanation, or markdown
- DO NOT add packages not needed by detected tools
- DO NOT use multiple RUN commands (combine with &&)
- Base image: ${defaultImage}
- Package map: java->openjdk17,maven | python->python3,py3-pip | go->go | ruby->ruby | rust->rust,cargo

Format (exactly):
FROM ${defaultImage}

RUN apk add --no-cache <packages>

If no tools detected:
${defaultContent}`;

    spawnSync("claude", ["-p", promptText, "--allowedTools", "Read,Write"], {
        encoding: "utf-8",
        cwd: cwd,
        timeout: 60000,
        stdio: "inherit"
    });

    // Ensure file exists with default content if Claude didn't create it
    if (!existsSync(dockerfilePath)) {
        writeFileSync(dockerfilePath, defaultContent);
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

// Check which mode is active
function getMode(): "mise" | "dockerfile" | "default" {
    if (existsSync(miseConfigPath)) return "mise";
    if (existsSync(dockerfilePath)) return "dockerfile";
    return "default";
}

function generateCompose(mode: "mise" | "dockerfile" | "default"): void {
    mkdirSync(sandboxDir, {recursive: true});
    mkdirSync(dataDir, {recursive: true});

    let imageOrBuild: string;
    let volumes: string;

    // Get shell config mounts (read-only)
    const shellMounts = getShellConfigMounts();
    const shellMountsStr = shellMounts.length > 0 ? "\n" + shellMounts.join("\n") : "";

    if (mode === "dockerfile") {
        imageOrBuild = `build: .`;
        volumes = `      - ${dockerPath(cwd)}:/workspace
      - ${dockerPath(dataDir)}:/claude${shellMountsStr}`;
    } else {
        imageOrBuild = `image: ${defaultImage}`;
        mkdirSync(miseCacheDir, {recursive: true});
        volumes = `      - ${dockerPath(cwd)}:/workspace
      - ${dockerPath(dataDir)}:/claude
      - ${dockerPath(miseCacheDir)}:/home/claude/.local/share/mise${shellMountsStr}`;
    }

    const compose = `
services:
  sandbox:
    ${imageOrBuild}
    container_name: ${containerName}
    volumes:
${volumes}
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

function run(cmd: string[], mode: "mise" | "dockerfile" | "default"): void {
    if (mode === "dockerfile") {
        console.log("Building container...");
        const buildResult = dockerCompose(["-f", composePath, "build"]);

        if (buildResult.status !== 0) {
            console.error("Build failed");
            process.exit(1);
        }

        spawnSync("docker", ["image", "prune", "-f"], {stdio: "ignore"});
    } else {
        console.log("Pulling image...");
        spawnSync("docker", ["pull", defaultImage], {stdio: "inherit"});
    }

    console.log("Starting container...");

    // For mise mode, run mise install first
    let finalCmd: string[];
    if (mode === "mise" && cmd[0] === "claude") {
        finalCmd = ["sh", "-c", "mise install --yes 2>/dev/null; exec " + cmd.join(" ")];
    } else {
        finalCmd = cmd;
    }

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

    const mode = getMode();
    generateCompose(mode);

    if (command === "shell") {
        run(["bash"], mode);
    } else {
        run(["claude", "--dangerously-skip-permissions"], mode);
    }
}

main();
