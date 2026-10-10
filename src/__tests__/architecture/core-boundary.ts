import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

export type CoreLayer = "domain" | "ports" | "application";
export interface CoreBoundary { root: string; language: "mjs" | "ts"; }
const layers: readonly CoreLayer[] = ["domain", "ports", "application"];
const runtimeNames = new Set([
    "process", "Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "setImmediate", "clearImmediate", "queueMicrotask", "fetch", "globalThis", "global",
    "window", "document", "navigator", "performance", "crypto", "console", "Buffer",
    "require", "module", "exports", "__dirname", "__filename", "eval", "Function",
    "XMLHttpRequest", "WebSocket", "Worker", "Deno", "Bun", "Math",
]);
const pureMathMembers = new Set([
    "E", "LN10", "LN2", "LOG10E", "LOG2E", "PI", "SQRT1_2", "SQRT2",
    "abs", "acos", "acosh", "asin", "asinh", "atan", "atanh", "atan2", "cbrt",
    "ceil", "clz32", "cos", "cosh", "exp", "expm1", "floor", "fround", "hypot",
    "imul", "log", "log1p", "log2", "log10", "max", "min", "pow", "round",
    "sign", "sin", "sinh", "sqrt", "tan", "tanh", "trunc",
]);

function layerOf(file: string, boundary: CoreBoundary): CoreLayer | undefined {
    const suffix = relative(resolve(boundary.root), resolve(file));
    if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return undefined;
    return layers.find(layer => suffix.startsWith(`${layer}${sep}`));
}

// Dependency enforcement, not an execution sandbox. Reserved runtime names are
// rejected even when locally bound. Type imports also participate in the graph.
export function coreBoundaryViolations(source: string, file: string, boundary: CoreBoundary): string[] {
    const layer = layerOf(file, boundary);
    if (!layer) return ["source must belong to a core layer"];
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
        boundary.language === "mjs" ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const errors: string[] = [];
    const purePathImports = new Set<ts.ImportDeclaration>();
    const purePathNames = new Set<string>();
    for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
            || !["path", "node:path"].includes(statement.moduleSpecifier.text)) continue;
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        if (!clause || clause.name || clause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)
            || bindings.elements.length === 0 || !bindings.elements.every(item => !item.propertyName
                && !item.isTypeOnly && ["join", "win32"].includes(item.name.text))) continue;
        purePathImports.add(statement);
        for (const item of bindings.elements) purePathNames.add(item.name.text);
    }
    const checkImport = (specifier: ts.Node | undefined, typeOnly: boolean) => {
        if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) {
            errors.push("dependency must use a relative core path");
            return;
        }
        const extensionAllowed = boundary.language === "mjs"
            ? specifier.text.endsWith(".mjs") : specifier.text.endsWith(".js");
        const target = layerOf(resolve(dirname(file), specifier.text), boundary);
        const allowed = target && (layer === "application" || target === "domain"
            || layer === "ports" && target === "ports" && typeOnly);
        if (!extensionAllowed || !allowed) errors.push(`forbidden ${layer} dependency: ${specifier.text}`);
    };
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
            const clause = node.importClause;
            const bindings = clause?.namedBindings;
            const typeOnly = clause?.isTypeOnly === true || (!!bindings && ts.isNamedImports(bindings)
                && !clause?.name && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly));
            if (!purePathImports.has(node)) checkImport(node.moduleSpecifier, typeOnly);
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            const typeOnly = node.isTypeOnly || (!!node.exportClause && ts.isNamedExports(node.exportClause)
                && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
            checkImport(node.moduleSpecifier, typeOnly);
        }
        if (ts.isImportTypeNode(node)) checkImport(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true);
        if (ts.isJSDocImportTag(node)) checkImport(node.moduleSpecifier, true);
        if (ts.isImportEqualsDeclaration(node)) errors.push("import assignment");
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) errors.push("dynamic import");
        if (ts.isMetaProperty(node)) errors.push("runtime meta property");
        if (ts.isIdentifier(node) && purePathNames.has(node.text)) {
            const parent = node.parent;
            const declaration = ts.isImportSpecifier(parent) && parent.name === node;
            const directJoin = node.text === "join" && ts.isCallExpression(parent) && parent.expression === node;
            const directNormalize = node.text === "win32" && ts.isPropertyAccessExpression(parent)
                && parent.expression === node && parent.name.text === "normalize"
                && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
            const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
                || (ts.isPropertyAssignment(parent) && parent.name === node)
                || (ts.isMethodDeclaration(parent) && parent.name === node)
                || (ts.isPropertySignature(parent) && parent.name === node);
            if (!declaration && !directJoin && !directNormalize && !propertyName) errors.push(`forbidden path access: ${node.text}`);
        }
        if (ts.isIdentifier(node) && runtimeNames.has(node.text)) {
            const parent = node.parent;
            const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
                || (ts.isPropertyAssignment(parent) && parent.name === node)
                || (ts.isMethodDeclaration(parent) && parent.name === node)
                || (ts.isPropertySignature(parent) && parent.name === node);
            const pureMathAccess = node.text === "Math" && ts.isPropertyAccessExpression(parent)
                && parent.expression === node && pureMathMembers.has(parent.name.text);
            const pureDateParse = node.text === "Date" && ts.isPropertyAccessExpression(parent)
                && parent.expression === node && parent.name.text === "parse"
                && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
            const bufferType = node.text === "Buffer" && ts.isTypeReferenceNode(parent) && parent.typeName === node;
            const pureByteLength = node.text === "Buffer" && ts.isPropertyAccessExpression(parent)
                && parent.expression === node && parent.name.text === "byteLength"
                && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
            if (!propertyName && !pureMathAccess && !pureDateParse && !bufferType && !pureByteLength) errors.push(`runtime identifier: ${node.text}`);
        }
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === "Math" && node.name.text === "random") errors.push("implicit randomness");
        if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === "Math") errors.push("computed Math access");
        ts.forEachChild(node, visit);
        // TypeScript's ordinary child visitor omits JSDoc type dependencies.
        for (const comment of (node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? []) visit(comment);
    };
    visit(tree);
    return errors;
}
