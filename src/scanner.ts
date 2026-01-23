import {existsSync, readdirSync, readFileSync, statSync} from "fs";
import {join, relative} from "path";

// Version detection file patterns by language
const VERSION_FILES: Record<string, string[]> = {
    // JavaScript/TypeScript ecosystem
    node: ["package.json", ".nvmrc", ".node-version", "volta.json", ".volta.json", "package-lock.json", "yarn.lock", ".yarnrc.yml", ".npmrc", "pnpm-lock.yaml"],
    deno: ["deno.json", "deno.jsonc", "import_map.json"],
    bun: ["bunfig.toml"],

    // JVM languages
    java: ["pom.xml", "build.gradle", "build.gradle.kts", "gradle.properties", "gradle-wrapper.properties", ".java-version", ".sdkmanrc", "system.properties", "settings.gradle.kts", "settings.gradle"],
    kotlin: ["build.gradle.kts", "gradle.properties"],
    scala: ["build.sbt", ".scala-version", "build.properties"],
    groovy: ["build.gradle"],
    clojure: ["project.clj", "deps.edn", "shadow-cljs.edn"],

    // Python ecosystem
    python: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", ".python-version", "runtime.txt", "environment.yml", "conda.yaml", "poetry.lock", "uv.lock", "Pipfile.lock"],

    // Systems languages
    go: ["go.mod", "go.work", "go.sum"],
    rust: ["Cargo.toml", "rust-toolchain", "rust-toolchain.toml"],
    zig: ["build.zig", "build.zig.zon"],
    c_cpp: ["CMakeLists.txt", "Makefile", "configure.ac", "meson.build", "conanfile.txt", "conanfile.py", "vcpkg.json", ".clang-version"],

    // Ruby ecosystem
    ruby: ["Gemfile", ".ruby-version", ".rvmrc", ".ruby-gemset", "Rakefile"],

    // PHP ecosystem
    php: ["composer.json", ".php-version", "artisan"],

    // Elixir/Erlang
    elixir: ["mix.exs", ".elixir-version", ".erlang-version", "rebar.config", "rebar3.config"],

    // Mobile/Cross-platform
    swift: ["Package.swift", ".swift-version", "Podfile"],
    flutter: ["pubspec.yaml", ".flutter-version", ".dart-version", "analysis_options.yaml"],
    kotlin_mobile: ["build.gradle.kts", "gradle.properties"],
    react_native: ["app.json", "metro.config.js"],

    // .NET ecosystem
    dotnet: ["*.csproj", "*.fsproj", "*.vbproj", "global.json", ".dotnet-version", "Directory.Build.props", "nuget.config"],

    // Functional languages
    haskell: ["stack.yaml", "cabal.project", "*.cabal", ".ghc-version", "hie.yaml"],
    ocaml: ["dune-project", "dune", "*.opam", ".ocaml-version", ".ocamlformat"],
    fsharp: ["*.fsproj", "global.json"],
    elm: ["elm.json"],
    purescript: ["spago.dhall", "packages.dhall"],

    // Scripting languages
    perl: ["cpanfile", "Makefile.PL", "Build.PL", ".perl-version"],
    lua: [".lua-version", ".luarocks", "*.rockspec"],
    r: ["DESCRIPTION", ".Rversion", "renv.lock"],

    // Scientific/Data
    julia: ["Project.toml", "Manifest.toml"],

    // Infrastructure/DevOps
    terraform: [".terraform-version", "versions.tf", "main.tf", "providers.tf", ".terraformrc", ".terraform.lock.hcl"],
    ansible: ["ansible.cfg", "requirements.yml", "galaxy.yml"],
    pulumi: ["Pulumi.yaml", "Pulumi.yml"],
    kubernetes: ["skaffold.yaml", "kustomization.yaml", "helmfile.yaml", "Chart.yaml"],

    // Container/Runtime
    docker: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".dockerignore"],
    nix: ["flake.nix", "shell.nix", "default.nix", ".envrc"],

    // Universal version managers
    universal: [".tool-versions", ".mise.toml", ".rtx.toml", ".asdf"]
};

// Directories to skip during scanning
const SKIP_DIRS = new Set([
    "node_modules", ".git", ".svn", ".hg", "vendor", "target", "build", "dist",
    ".gradle", ".maven", "__pycache__", ".venv", "venv", ".tox", ".pytest_cache",
    "Pods", ".flutter", ".dart_tool", ".pub-cache", "bin", "obj", ".vs", ".idea"
]);

// All patterns flattened for matching
const ALL_PATTERNS = Object.values(VERSION_FILES).flat();

// Check if filename matches any pattern
export function matchesPattern(filename: string): boolean {
    return ALL_PATTERNS.some(pattern => {
        if (pattern.startsWith("*")) {
            return filename.endsWith(pattern.slice(1));
        }
        return filename === pattern;
    });
}

// Scan project for version files and return their contents
export function scanVersionFiles(baseDir: string, dir: string = baseDir, depth: number = 0, maxDepth: number = 3): Map<string, string> {
    const results = new Map<string, string>();
    if (depth > maxDepth) return results;

    try {
        const entries = readdirSync(dir, {withFileTypes: true});

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
                    const subResults = scanVersionFiles(baseDir, fullPath, depth + 1, maxDepth);
                    subResults.forEach((content, path) => results.set(path, content));
                }
            } else if (entry.isFile() && matchesPattern(entry.name)) {
                try {
                    const stats = statSync(fullPath);
                    // Skip files larger than 100KB
                    if (stats.size <= 100 * 1024) {
                        const content = readFileSync(fullPath, "utf-8");
                        const relPath = relative(baseDir, fullPath);
                        results.set(relPath, content);
                    }
                } catch {
                    // Skip unreadable files
                }
            }
        }
    } catch {
        // Skip unreadable directories
    }

    return results;
}

// Format scanned files for prompt
export function formatScannedFiles(files: Map<string, string>): string {
    if (files.size === 0) {
        return "No version files found in project.";
    }

    let output = "Detected version files:\n\n";
    files.forEach((content, path) => {
        // Truncate very long files, LLM can read full file if needed
        const truncated = content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated, use Read tool for full content)" : content;
        output += `=== ${path} ===\n${truncated}\n\n`;
    });
    return output;
}

// Version hint for pre-parsed tool versions
export interface VersionHint {
    tool: string;
    version: string;
    source: string;
}

// Extract version hints from scanned files
export function extractVersionHints(files: Map<string, string>): VersionHint[] {
    const hints: VersionHint[] = [];

    files.forEach((content, path) => {
        const filename = path.split("/").pop() || path;

        // Plain version files (direct content)
        if (filename === ".nvmrc" || filename === ".node-version") {
            const v = content.trim().replace(/^v/, "");
            if (v) hints.push({tool: "node", version: v, source: path});
        }
        if (filename === ".python-version") {
            const v = content.trim();
            if (v) hints.push({tool: "python", version: v, source: path});
        }
        if (filename === ".ruby-version") {
            const v = content.trim();
            if (v) hints.push({tool: "ruby", version: v, source: path});
        }
        if (filename === ".java-version") {
            const v = content.trim();
            if (v) hints.push({tool: "java", version: `temurin-${v}`, source: path});
        }
        if (filename === "rust-toolchain" && !path.endsWith(".toml")) {
            const v = content.trim();
            if (v) hints.push({tool: "rust", version: v, source: path});
        }
        if (filename === ".terraform-version") {
            const v = content.trim();
            if (v) hints.push({tool: "terraform", version: v, source: path});
        }

        // .tool-versions (asdf/mise format)
        if (filename === ".tool-versions") {
            content.split("\n").forEach(line => {
                const match = line.match(/^(\w+)\s+(.+)$/);
                if (match) hints.push({tool: match[1], version: match[2].trim(), source: path});
            });
        }

        // package.json engines.node
        if (filename === "package.json") {
            try {
                const pkg = JSON.parse(content);
                if (pkg.engines?.node) {
                    const v = pkg.engines.node.replace(/[^\d.]/g, "").split(".")[0];
                    if (v) hints.push({tool: "node", version: v, source: path});
                }
            } catch { /* ignore */ }
        }

        // volta.json
        if (filename === "volta.json" || filename === ".volta.json") {
            try {
                const v = JSON.parse(content);
                if (v.node) hints.push({tool: "node", version: v.node.replace(/^v/, ""), source: path});
            } catch { /* ignore */ }
        }

        // global.json (.NET SDK)
        if (filename === "global.json") {
            try {
                const v = JSON.parse(content).sdk?.version;
                if (v) hints.push({tool: "dotnet", version: v, source: path});
            } catch { /* ignore */ }
        }

        // .sdkmanrc (SDKMAN JVM)
        if (filename === ".sdkmanrc") {
            const m = content.match(/^java=(.+)$/m);
            if (m) hints.push({tool: "java", version: m[1].trim(), source: path});
        }

        // pyproject.toml
        if (filename === "pyproject.toml") {
            const match = content.match(/requires-python\s*=\s*["']>=?(\d+\.\d+)/);
            if (match) hints.push({tool: "python", version: match[1], source: path});
        }

        // go.mod
        if (filename === "go.mod") {
            const match = content.match(/^go\s+(\d+\.\d+)/m);
            if (match) hints.push({tool: "go", version: match[1], source: path});
        }

        // Cargo.toml rust-version
        if (filename === "Cargo.toml") {
            const match = content.match(/rust-version\s*=\s*["'](\d+\.\d+)/);
            if (match) hints.push({tool: "rust", version: match[1], source: path});
        }

        // rust-toolchain.toml
        if (filename === "rust-toolchain.toml") {
            const match = content.match(/channel\s*=\s*["']([^"']+)/);
            if (match) hints.push({tool: "rust", version: match[1], source: path});
        }
    });

    // Deduplicate: keep first occurrence per tool
    const seen = new Set<string>();
    return hints.filter(h => {
        if (seen.has(h.tool)) return false;
        seen.add(h.tool);
        return true;
    });
}

// Format hints for prompt
export function formatVersionHints(hints: VersionHint[]): string {
    if (hints.length === 0) return "";
    return "Pre-extracted versions:\n" + hints.map(h => `  ${h.tool} = "${h.version}" (from ${h.source})`).join("\n") + "\n\n";
}
