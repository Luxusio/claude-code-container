import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { isWindowsLxWorkspaceLink, removeWindowsLxWorkspaceLink } from "./windows-lx-workspace-link.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimePackages = ["hyper-v", "device-lab"];
const sourceLockModule = new URL("../packages/device-lab/providers/state/shared-mutation-lock.mjs", import.meta.url);
const embeddedLockModule = new URL("../dist/packages/device-lab/providers/state/shared-mutation-lock.mjs", import.meta.url);
const { withSharedMutationLock } = await import(
    entryStat(fileURLToPath(sourceLockModule)) ? sourceLockModule.href : embeddedLockModule.href,
);

function entryStat(path) {
    try { return lstatSync(path); }
    catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

function withWorkspaceBuildLock(projectRoot, operation) {
    return withSharedMutationLock(join(realpathSync(projectRoot), ".ccc-workspace-build.guard"), operation, {
        waitMs: 300_000,
        reclaimStale: true,
    });
}

function runNode(projectRoot, args, stage) {
    const result = spawnSync(process.execPath, args, {
        cwd: projectRoot, stdio: "inherit", windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw Object.assign(new Error(`workspace-build-failed: ${stage}`), {
            exitCode: Number.isInteger(result.status) && result.status > 0 ? result.status : 1,
        });
    }
}

function prepareRuntimeWorkspaceLinks(projectRoot) {
    const scope = join(projectRoot, "node_modules", "@ccc");
    const packages = runtimePackages.map(name => {
        const source = join(projectRoot, "packages", name);
        const stat = entryStat(source);
        if (!stat?.isDirectory() || stat.isSymbolicLink()
            || JSON.parse(readFileSync(join(source, "package.json"), "utf8")).name !== `@ccc/${name}`) {
            throw new Error(`workspace-source-invalid: ${name}`);
        }
        return { name, source, link: join(scope, name) };
    });
    for (const parent of [join(projectRoot, "node_modules"), scope]) {
        const stat = entryStat(parent);
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
            throw new Error("workspace-dependency-parent-invalid: restore local npm workspace dependencies with npm ci");
        }
        if (!stat && parent !== scope) {
            throw new Error("workspace-dependencies-missing: install npm workspace dependencies with npm ci");
        }
    }
    // Validate both entries before changing either one or removing build output.
    const lxLinks = new Set();
    const repairs = packages.filter(({ name, source, link }) => {
        let stat;
        try { stat = entryStat(link); }
        catch (error) {
            if (process.platform !== "win32" || !["EACCES", "EPERM"].includes(error.code)
                || !isWindowsLxWorkspaceLink(link)) throw error;
            lxLinks.add(link);
            return true;
        }
        if (!stat) return true;
        if (!stat.isSymbolicLink()) {
            throw new Error(`workspace-dependency-not-linked: @ccc/${name}; restore npm workspace dependencies with npm ci`);
        }
        const expectedSource = realpathSync(source);
        try { return relative(expectedSource, realpathSync(link)) !== ""; }
        catch (error) {
            if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error.code)) return true;
            throw error;
        }
    });
    if (!repairs.length) return;
    if (!entryStat(scope)) mkdirSync(scope);
    for (const { source, link } of repairs) {
        if (lxLinks.has(link)) removeWindowsLxWorkspaceLink(link);
        else if (entryStat(link)) unlinkSync(link);
        symlinkSync(process.platform === "win32" ? source : relative(scope, source), link,
            process.platform === "win32" ? "junction" : "dir");
    }
}

export function buildWorkspacePackages(projectRoot = root) {
    return withWorkspaceBuildLock(projectRoot, () => buildWorkspacePackagesInside(projectRoot));
}

function buildWorkspacePackagesInside(projectRoot) {
    prepareRuntimeWorkspaceLinks(projectRoot);
    for (const name of runtimePackages) {
        rmSync(join(projectRoot, "packages", name, "dist"), { recursive: true, force: true });
        runNode(projectRoot, [join(projectRoot, "node_modules/typescript/bin/tsc"),
            "-p", join(projectRoot, "packages", name, "tsconfig.json")], name);
    }
}

function exportTarget(manifest, subpath) {
    const exports = manifest.exports;
    const key = subpath ? `./${subpath}` : ".";
    let target = typeof exports === "string" && key === "." ? exports : exports?.[key];
    if (target === undefined && exports && typeof exports === "object") {
        for (const pattern of Object.keys(exports).filter(key => key.includes("*")).sort((a, b) => b.length - a.length)) {
            const [prefix, suffix] = pattern.split("*");
            if (!key.startsWith(prefix) || !key.endsWith(suffix) || key.length < prefix.length + suffix.length) continue;
            target = exports[pattern];
            if (target && typeof target === "object") target = target.import ?? target.default;
            const match = key.slice(prefix.length, suffix ? -suffix.length : undefined);
            if (typeof target === "string") target = target.replaceAll("*", match);
            else throw new Error(`workspace-export-unsupported: ${manifest.name} ${key}`);
            break;
        }
    }
    if (target && typeof target === "object") target = target.import ?? target.default;
    if (typeof target !== "string" || !target.startsWith("./")) {
        throw new Error(`workspace-export-missing: ${manifest.name} ${key}`);
    }
    return target;
}

function importLiteral(node) {
    const parent = node.parent;
    return (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node
        || ts.isCallExpression(parent) && parent.arguments[0] === node
            && (parent.expression.kind === ts.SyntaxKind.ImportKeyword
                || ts.isIdentifier(parent.expression) && parent.expression.text === "require"
                || ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "resolve"
                    && ts.isMetaProperty(parent.expression.expression) && parent.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword)
        || ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent);
}

function filesUnder(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
    });
}

export function assembleWorkspaceRuntime(projectRoot = root) {
    return withWorkspaceBuildLock(projectRoot, () => assembleWorkspaceRuntimeInside(projectRoot));
}

function assembleWorkspaceRuntimeInside(projectRoot) {
    const dist = join(projectRoot, "dist");
    // The current display is served by Device Lab. Remove only the obsolete
    // standalone bundle, including outputs left by an incremental checkout.
    rmSync(join(dist, "x11-mcp"), { recursive: true, force: true });
    // TypeScript does not remove outputs whose sources moved into a workspace.
    // Keep CLI-owned modules (notably device-lab-admin) and unrelated bundles.
    const movedModules = readdirSync(join(projectRoot, "packages/device-lab/src"))
        .filter(name => /^device-lab.*\.ts$/.test(name) || name === "windows-system-powershell.ts")
        .map(name => name.slice(0, -3));
    for (const name of movedModules) {
        for (const extension of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
            rmSync(join(dist, name + extension), { force: true });
        }
    }
    for (const path of ["device-lab", "host-control/hyper-v", "hyper-v-windows"]) {
        rmSync(join(dist, path), { recursive: true, force: true });
    }
    const embeddedRoot = join(dist, "packages");
    const manifests = new Map();
    // Only our generated package directories are replaced. Other dist artifacts belong
    // to the CLI and Device Lab bundle and must survive assembly.
    for (const name of runtimePackages) {
        const source = join(projectRoot, "packages", name);
        const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
        const destination = join(embeddedRoot, name);
        rmSync(destination, { recursive: true, force: true });
        mkdirSync(destination, { recursive: true });
        for (const path of ["package.json", "dist", "powershell", ...(name === "device-lab" ? ["providers", "appium-runtime"] : [])]) {
            cpSync(join(source, path), join(destination, path), { recursive: true,
                filter: candidate => !relative(source, candidate).split(sep).includes("node_modules") });
        }
        manifests.set(manifest.name, { manifest, destination });
    }
    for (const file of filesUnder(dist)) {
        const path = relative(dist, file).split(sep).join("/");
        if (path.startsWith("real-tests/") || !/\.(?:[cm]?js|[cm]?ts)$/.test(file)) continue;
        const source = readFileSync(file, "utf8");
        const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const replacements = [];
        function visit(node) {
            if (ts.isStringLiteral(node) && importLiteral(node)) {
                for (const [name, { manifest, destination }] of manifests) {
                    if (node.text !== name && !node.text.startsWith(`${name}/`)) continue;
                    const exported = exportTarget(manifest, node.text === name ? "" : node.text.slice(name.length + 1));
                    const target = resolve(destination, exported);
                    if (!target.startsWith(destination + sep) || !existsSync(target)) {
                        throw new Error(`workspace-export-artifact-missing: ${node.text}`);
                    }
                    let imported = relative(dirname(file), target).split(sep).join("/");
                    if (!imported.startsWith(".")) imported = `./${imported}`;
                    replacements.push({ start: node.getStart(parsed), end: node.end, text: JSON.stringify(imported) });
                    break;
                }
            }
            ts.forEachChild(node, visit);
        }
        visit(parsed);
        let rewritten = source;
        for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
            rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
        }
        if (rewritten !== source) writeFileSync(file, rewritten);
    }
}

function buildAll(projectRoot = root) {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("Run the complete build through npm run build.");
    return withWorkspaceBuildLock(projectRoot, () => {
        const npm = (script) => runNode(projectRoot, [npmCli, "run", script], script);
        buildWorkspacePackagesInside(projectRoot);
        assembleWorkspaceRuntimeInside(projectRoot);
        npm("test:hyper-v:static");
        runNode(projectRoot, [join(projectRoot, "node_modules/typescript/bin/tsc")], "CLI TypeScript");
        for (const script of [
            "typecheck:hyper-v:windows:contracts", "typecheck:real-tests", "typecheck:tests", "typecheck:architecture",
            "bundle:hyper-v:windows:library-test", "bundle:hyper-v:windows:library-privileged-test",
            "bundle:hyper-v:windows:network-host-test",
        ]) npm(script);
        const utils = join(projectRoot, "dist/utils.js");
        const version = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version;
        writeFileSync(utils, readFileSync(utils, "utf8").replace("__CLI_VERSION__", version));
        npm("build:device-lab-mcp");
        npm("bundle:codex-resume-runtime");
        assembleWorkspaceRuntimeInside(projectRoot);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const mode = process.argv[2];
    try {
        if (mode === "build") buildWorkspacePackages();
        else if (mode === "assemble") assembleWorkspaceRuntime();
        else if (mode === "all") buildAll();
        else throw new Error("Usage: node scripts/workspace-build.mjs build|assemble|all");
    } catch (error) {
        if (!Number.isInteger(error?.exitCode) || error.exitCode < 1) throw error;
        console.error(error.message);
        process.exitCode = error.exitCode;
    }
}
