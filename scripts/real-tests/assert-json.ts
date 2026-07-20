import { createHash } from "crypto";
import { readFileSync } from "fs";
import { TOOLS as DEVICE_LAB_MCP_TOOLS } from "../../device-lab-mcp/src/tools.mjs";

const file = process.argv[2];
const quiet = process.argv.includes("--quiet");
const platformResult = process.argv.includes("--platform-result");
const allowedSkipCategoryText = Object.prototype.hasOwnProperty.call(process.env, "CCC_REAL_DEVICE_LAB_ALLOWED_SKIP_CATEGORIES")
    ? process.env.CCC_REAL_DEVICE_LAB_ALLOWED_SKIP_CATEGORIES
    : "provider-prerequisite,host-platform,host-virtualization";
const allowedSkipCategories = new Set(
    String(allowedSkipCategoryText || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
);
const requiredMcpSessionSourceText = Object.prototype.hasOwnProperty.call(process.env, "CCC_REAL_DEVICE_LAB_REQUIRED_MCP_SESSION_SOURCES")
    ? process.env.CCC_REAL_DEVICE_LAB_REQUIRED_MCP_SESSION_SOURCES
    : "source,dist";
const requiredMcpSessionSources = String(requiredMcpSessionSourceText || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

if (!file) {
    console.error("Usage: node scripts/real-tests/assert-json.ts <summary.json>");
    process.exit(1);
}

const summary = JSON.parse(readFileSync(file, "utf-8"));
const failures = [];
const toolCoverage = summary.toolCoverage || {};
const mcpSessions = Array.isArray(summary.mcpSessions) ? summary.mcpSessions : [];
const toolCalls = Array.isArray(toolCoverage.calls) ? toolCoverage.calls : [];
const skipCategories = Array.isArray(summary.skipCategories) ? summary.skipCategories : [];
const categorizedSkipCount = skipCategories.reduce((total, item) => total + Number(item?.count || 0), 0);
const unexpectedSkipCategories = skipCategories.filter((item) => !allowedSkipCategories.has(item?.category));
const providerGapSkipCategories = new Set(["provider-prerequisite", "host-platform", "host-virtualization"]);
const providerValues = new Set(["auto", "tart", "vz", "utmctl"]);
const directOkExemptDiagnosticTools = new Set([
    "device_base_image_clone",
    "device_base_image_create",
    "device_snapshot_create",
    "device_snapshot_delete",
    "device_snapshot_restore",
    "device_wireless",
]);
function canonicalToolSurface() {
    const tools = DEVICE_LAB_MCP_TOOLS.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema || {},
    }));
    return {
        toolCount: tools.length,
        sha256: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
    };
}
const currentToolSurface = canonicalToolSurface();
const artifactToolSurface = toolCoverage.canonicalToolSurface || {};
const uncalledNonProviderArgumentEnumFacets = (toolCoverage.uncalledAdvertisedArgumentEnumFacets || [])
    .filter((facet) => !/:(?:backend|provider)=/.test(String(facet)));
const uncalledProviderArgumentEnumFacets = (toolCoverage.uncalledAdvertisedArgumentEnumFacets || [])
    .filter((facet) => /:(?:backend|provider)=/.test(String(facet)));
const explainedProviderValues = new Set();
for (const item of skipCategories.filter((record) => providerGapSkipCategories.has(record?.category))) {
    const records = Array.isArray(item.records) ? item.records : [];
    const text = records.map((record) => `${record?.test || ""} ${record?.step || ""} ${record?.reason || ""}`).join("\n").toLowerCase();
    if (/android/.test(text) && /emulator/.test(text)) explainedProviderValues.add("backend=android-emulator");
    if (/android/.test(text) && /(?:physical|device|adb)/.test(text)) explainedProviderValues.add("backend=android-device");
    if (/ios/.test(text) && /simulator/.test(text)) explainedProviderValues.add("backend=ios-simulator");
    if (/ios/.test(text) && /(?:physical|device|xcrun|macos host)/.test(text)) explainedProviderValues.add("backend=ios-device");
    if (/windows|wsb/.test(text)) explainedProviderValues.add("backend=windows-sandbox");
    if (/macos|tart|vz|utmctl/.test(text)) explainedProviderValues.add("backend=macos-vm");
}
const unexplainedProviderArgumentEnumFacets = uncalledProviderArgumentEnumFacets.filter((facet) => {
    const match = /^([^:]+):(backend|provider)=(.+)$/.exec(String(facet));
    if (!match) return true;
    const [, , key, value] = match;
    if (key === "provider" && providerValues.has(value)) return !explainedProviderValues.has("backend=macos-vm");
    return !explainedProviderValues.has(`${key}=${value}`);
});
function providerFacetIsExplained(facet) {
    const match = /^([^:]+):(backend|provider)=(.+)$/.exec(String(facet));
    if (!match) return false;
    const [, , key, value] = match;
    if (key === "provider" && providerValues.has(value)) return explainedProviderValues.has("backend=macos-vm");
    return explainedProviderValues.has(`${key}=${value}`);
}
const calledAdvertisedArgumentEnumFacets = Array.isArray(toolCoverage.calledAdvertisedArgumentEnumFacets)
    ? toolCoverage.calledAdvertisedArgumentEnumFacets
    : [];
const diagnosticOnlyTools = new Set(toolCoverage.publicToolsWithOnlyExpectedErrorEvidence || []);
function diagnosticOnlyToolIsExplained(tool) {
    const toolProviderFacets = calledAdvertisedArgumentEnumFacets
        .filter((facet) => String(facet).startsWith(`${tool}:`))
        .filter((facet) => /:(?:backend|provider)=/.test(String(facet)));
    return toolProviderFacets.length > 0 && toolProviderFacets.some(providerFacetIsExplained);
}
const unexplainedDiagnosticOnlyTools = [...diagnosticOnlyTools].filter((tool) => !diagnosticOnlyToolIsExplained(tool));
const unjustifiedMissingDirectOkTools = (toolCoverage.publicToolsWithoutDirectOk || []).filter((tool) => (
    !directOkExemptDiagnosticTools.has(tool) || !diagnosticOnlyTools.has(tool) || !diagnosticOnlyToolIsExplained(tool)
));
function stableArray(values) {
    return (Array.isArray(values) ? values : []).map(String).sort();
}
function arraysEqual(left, right) {
    const a = stableArray(left);
    const b = stableArray(right);
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
const providerGapAuditMismatches = [
    ["explainedProviderValues", toolCoverage.explainedProviderValues, [...explainedProviderValues]],
    ["unexplainedProviderArgumentEnumFacets", toolCoverage.unexplainedProviderArgumentEnumFacets, unexplainedProviderArgumentEnumFacets],
    ["unexplainedDiagnosticOnlyTools", toolCoverage.unexplainedDiagnosticOnlyTools, unexplainedDiagnosticOnlyTools],
    ["unjustifiedMissingDirectOkTools", toolCoverage.unjustifiedMissingDirectOkTools, unjustifiedMissingDirectOkTools],
]
    .filter(([, artifact]) => Array.isArray(artifact))
    .filter(([, artifact, computed]) => !arraysEqual(artifact, computed))
    .map(([field, artifact, computed]) => ({ field, artifact: stableArray(artifact), computed: stableArray(computed) }));
const envKey = (...parts) => parts.join("_");
const forbiddenMcpSessionEnvKeys = new Set([
    envKey("CCC", "DEVICE", "LAB", "OWNER", "BASIS"),
    envKey("CCC", "DEVICE", "LAB", "BACKEND", "MODULE", "URL"),
    envKey("CCC", "DEVICE", "LAB", "BACKEND", "HANDLER"),
    envKey("CCC", "DEVICE", "LAB", "TOOL"),
    envKey("CCC", "DEVICE", "LAB", "TOOL", "ARGS"),
    envKey("CCC", "DEVICE", "LAB", "IMPLICIT", "BROKER"),
]);
const forbiddenMcpSessionEnvOverrides = mcpSessions.flatMap((session) => (
    Array.isArray(session?.envOverrides)
        ? session.envOverrides
            .map(String)
            .filter((key) => forbiddenMcpSessionEnvKeys.has(key))
            .map((key) => ({ session: session?.id || session?.name || "unknown", key }))
        : []
));

if (Number(summary.fail || 0) > 0) failures.push(`fail=${summary.fail}`);
if (Number(summary.skip || 0) !== categorizedSkipCount) failures.push(`uncategorizedSkips=${Number(summary.skip || 0) - categorizedSkipCount}`);
if (Number(summary.strictSkipFailures || 0) > 0) failures.push(`strictSkipFailures=${summary.strictSkipFailures}`);
if (Number(summary.strictCoverageFailures || 0) > 0) failures.push(`strictCoverageFailures=${summary.strictCoverageFailures}`);
if (Number(summary.strictOutcomeFailures || 0) > 0) failures.push(`strictOutcomeFailures=${summary.strictOutcomeFailures}`);
if (!platformResult && (toolCoverage.uncalledAdvertisedTools || []).length > 0) failures.push(`uncalledAdvertisedTools=${toolCoverage.uncalledAdvertisedTools.length}`);
if (!platformResult && (toolCoverage.unscriptedAdvertisedTools || []).length > 0) failures.push(`unscriptedAdvertisedTools=${toolCoverage.unscriptedAdvertisedTools.length}`);
if (!platformResult && (toolCoverage.publicToolsWithoutOkOrExpectedError || []).length > 0) failures.push(`publicToolsWithoutOkOrExpectedError=${toolCoverage.publicToolsWithoutOkOrExpectedError.length}`);
if (!platformResult && (toolCoverage.publicToolsWithoutEvidence || []).length > 0) failures.push(`publicToolsWithoutEvidence=${toolCoverage.publicToolsWithoutEvidence.length}`);
if (!platformResult && unexplainedDiagnosticOnlyTools.length > 0) failures.push(`unexplainedDiagnosticOnlyTools=${unexplainedDiagnosticOnlyTools.length}`);
if (!platformResult && unjustifiedMissingDirectOkTools.length > 0) failures.push(`unjustifiedMissingDirectOkTools=${unjustifiedMissingDirectOkTools.length}`);
if (providerGapAuditMismatches.length > 0) failures.push(`providerGapAuditMismatch=${providerGapAuditMismatches.length}`);
if (!platformResult && (toolCoverage.publicFlowStepToolsWithoutOkOrExpectedError || []).length > 0) failures.push(`publicFlowStepToolsWithoutOkOrExpectedError=${toolCoverage.publicFlowStepToolsWithoutOkOrExpectedError.length}`);
if (!platformResult && (toolCoverage.uncalledScriptedTools || []).length > 0) failures.push(`uncalledScriptedTools=${toolCoverage.uncalledScriptedTools.length}`);
if (!platformResult && (toolCoverage.uncalledScriptedArgumentFacets || []).length > 0) failures.push(`uncalledScriptedArgumentFacets=${toolCoverage.uncalledScriptedArgumentFacets.length}`);
if ((toolCoverage.invalidScriptedArgumentFacets || []).length > 0) failures.push(`invalidScriptedArgumentFacets=${toolCoverage.invalidScriptedArgumentFacets.length}`);
if (!platformResult && uncalledNonProviderArgumentEnumFacets.length > 0) failures.push(`uncalledNonProviderArgumentEnumFacets=${uncalledNonProviderArgumentEnumFacets.length}`);
if (!platformResult && unexplainedProviderArgumentEnumFacets.length > 0) failures.push(`unexplainedProviderArgumentEnumFacets=${unexplainedProviderArgumentEnumFacets.length}`);
if ((toolCoverage.unadvertisedTools || []).length > 0) failures.push(`unadvertisedTools=${toolCoverage.unadvertisedTools.length}`);
if ((toolCoverage.incompleteOutcomeRecords || []).length > 0) failures.push(`incompleteOutcomeRecords=${toolCoverage.incompleteOutcomeRecords.length}`);
if ((toolCoverage.argumentSchemaFailureRecords || []).length > 0) failures.push(`argumentSchemaFailureRecords=${toolCoverage.argumentSchemaFailureRecords.length}`);
if ((toolCoverage.flowStepArgumentSchemaFailures || []).length > 0) failures.push(`flowStepArgumentSchemaFailures=${toolCoverage.flowStepArgumentSchemaFailures.length}`);
if ((toolCoverage.unexpectedErrorResultRecords || []).length > 0) failures.push(`unexpectedErrorResultRecords=${toolCoverage.unexpectedErrorResultRecords.length}`);
if ((toolCoverage.expectedErrorPayloadFailures || []).length > 0) failures.push(`expectedErrorPayloadFailures=${toolCoverage.expectedErrorPayloadFailures.length}`);
if ((toolCoverage.okPublicPayloadFailures || []).length > 0) failures.push(`okPublicPayloadFailures=${toolCoverage.okPublicPayloadFailures.length}`);
if ((toolCoverage.emptyOkPublicPayloadRecords || []).length > 0) failures.push(`emptyOkPublicPayloadRecords=${toolCoverage.emptyOkPublicPayloadRecords.length}`);
if ((toolCoverage.unexpectedFlowStepErrorRecords || []).length > 0) failures.push(`unexpectedFlowStepErrorRecords=${toolCoverage.unexpectedFlowStepErrorRecords.length}`);
if ((toolCoverage.expectedFlowStepPayloadFailures || []).length > 0) failures.push(`expectedFlowStepPayloadFailures=${toolCoverage.expectedFlowStepPayloadFailures.length}`);
if ((toolCoverage.okPublicFlowStepPayloadFailures || []).length > 0) failures.push(`okPublicFlowStepPayloadFailures=${toolCoverage.okPublicFlowStepPayloadFailures.length}`);
if ((toolCoverage.emptyOkPublicFlowStepPayloadRecords || []).length > 0) failures.push(`emptyOkPublicFlowStepPayloadRecords=${toolCoverage.emptyOkPublicFlowStepPayloadRecords.length}`);
if (unexpectedSkipCategories.length > 0) failures.push(`unexpectedSkipCategories=${unexpectedSkipCategories.map((item) => item.category).join(",")}`);
if (artifactToolSurface.sha256 !== currentToolSurface.sha256 || artifactToolSurface.toolCount !== currentToolSurface.toolCount) failures.push("canonicalToolSurfaceMismatch");
if (mcpSessions.length === 0) failures.push("mcpSessionsMissing");
const invalidMcpSessions = mcpSessions.filter((session) => !session?.serverPath || !session?.serverSource);
if (invalidMcpSessions.length > 0) failures.push(`invalidMcpSessions=${invalidMcpSessions.length}`);
const invalidMcpSessionFingerprints = mcpSessions.filter((session) => (
    session?.serverFile?.exists !== true
    || !Number.isInteger(session?.serverFile?.size)
    || session.serverFile.size <= 0
    || !/^[a-f0-9]{64}$/.test(String(session?.serverFile?.sha256 || ""))
));
if (invalidMcpSessionFingerprints.length > 0) failures.push(`invalidMcpSessionFingerprints=${invalidMcpSessionFingerprints.length}`);
const invalidMcpSessionToolSurfaces = mcpSessions.filter((session) => (
    session?.advertisedToolSurface?.sha256 !== currentToolSurface.sha256
    || session?.advertisedToolSurface?.toolCount !== currentToolSurface.toolCount
));
if (invalidMcpSessionToolSurfaces.length > 0) failures.push(`invalidMcpSessionToolSurfaces=${invalidMcpSessionToolSurfaces.length}`);
const mcpSessionSources = new Set(mcpSessions.map((session) => session?.serverSource).filter(Boolean));
const missingMcpSessionSources = requiredMcpSessionSources.filter((source) => !mcpSessionSources.has(source));
if (missingMcpSessionSources.length > 0) failures.push(`missingMcpSessionSources=${missingMcpSessionSources.join(",")}`);
if (forbiddenMcpSessionEnvOverrides.length > 0) failures.push(`forbiddenMcpSessionEnvOverrides=${forbiddenMcpSessionEnvOverrides.length}`);
const mcpSessionIds = new Set(mcpSessions.map((session) => session?.id).filter(Boolean));
const unlinkedMcpCallRecords = toolCalls.filter((call) => call?.outcome !== "declared" && !mcpSessionIds.has(call?.mcpSessionId));
if (unlinkedMcpCallRecords.length > 0) failures.push(`unlinkedMcpCallRecords=${unlinkedMcpCallRecords.length}`);
const mcpSessionSourceById = new Map(mcpSessions.map((session) => [session?.id, session?.serverSource]).filter(([id, source]) => id && source));
const advertisedTools = Array.isArray(toolCoverage.advertisedTools) ? toolCoverage.advertisedTools.map(String).sort() : [];
const publicToolsByMcpSessionSource = Object.fromEntries(requiredMcpSessionSources
    .filter((source) => mcpSessionSources.has(source))
    .map((source) => {
        const tools = [...new Set(toolCalls
            .filter((call) => mcpSessionSourceById.get(call?.mcpSessionId) === source)
            .filter((call) => call?.outcome !== "declared")
            .map((call) => String(call?.tool || ""))
            .filter((tool) => advertisedTools.includes(tool)))]
            .sort();
        return [source, tools];
    }));
const missingPublicToolsByMcpSessionSource = Object.fromEntries(Object.entries(publicToolsByMcpSessionSource)
    .map(([source, tools]) => [source, advertisedTools.filter((tool) => !tools.includes(tool))])
    .filter(([, missing]) => missing.length > 0));
const missingPublicToolSourceCount = Object.keys(missingPublicToolsByMcpSessionSource).length;
if (!platformResult && missingPublicToolSourceCount > 0) failures.push(`missingPublicToolsByMcpSessionSource=${missingPublicToolSourceCount}`);
const publicToolsWithoutDirectOkByMcpSessionSource = Object.fromEntries(Object.keys(publicToolsByMcpSessionSource).map((source) => {
    const directOkTools = new Set(toolCalls
        .filter((call) => mcpSessionSourceById.get(call?.mcpSessionId) === source && call?.outcome === "ok")
        .map((call) => String(call?.tool || ""))
        .filter((tool) => advertisedTools.includes(tool)));
    return [source, advertisedTools.filter((tool) => !directOkTools.has(tool))];
}));
const unjustifiedMissingDirectOkToolsByMcpSessionSource = Object.fromEntries(Object.entries(publicToolsWithoutDirectOkByMcpSessionSource)
    .filter(([source]) => !Object.hasOwn(missingPublicToolsByMcpSessionSource, source))
    .map(([source, tools]) => [source, tools.filter((tool) => !diagnosticOnlyTools.has(tool))])
    .filter(([, tools]) => tools.length > 0));
const unjustifiedMissingDirectOkSourceCount = Object.keys(unjustifiedMissingDirectOkToolsByMcpSessionSource).length;
if (!platformResult && unjustifiedMissingDirectOkSourceCount > 0) failures.push(`unjustifiedMissingDirectOkToolsByMcpSessionSource=${unjustifiedMissingDirectOkSourceCount}`);

const output = {
    ok: failures.length === 0,
    failures,
    host: summary.host || null,
    total: summary.total,
    pass: summary.pass,
    skip: summary.skip,
    fail: summary.fail,
    strictSkipFailures: summary.strictSkipFailures || 0,
    strictCoverageFailures: summary.strictCoverageFailures || 0,
    strictOutcomeFailures: summary.strictOutcomeFailures || 0,
    calledPublic: Array.isArray(toolCoverage.calledPublicTools) ? toolCoverage.calledPublicTools.length : 0,
    advertised: Array.isArray(toolCoverage.advertisedTools) ? toolCoverage.advertisedTools.length : 0,
    canonicalToolSurface: artifactToolSurface,
    currentCanonicalToolSurface: currentToolSurface,
    mcpSessions: {
        total: mcpSessions.length,
        bySource: Object.fromEntries([...new Set(mcpSessions.map((session) => session.serverSource || "unknown"))]
            .sort()
            .map((source) => [source, mcpSessions.filter((session) => (session.serverSource || "unknown") === source).length])),
        serverPaths: [...new Set(mcpSessions.map((session) => session.serverPath).filter(Boolean))].sort(),
        serverFiles: [...new Map<any, any>(mcpSessions
            .filter((session) => session.serverPath && session.serverFile?.sha256)
            .map((session) => [session.serverPath, {
                path: session.serverPath,
                source: session.serverSource || "unknown",
                size: session.serverFile.size,
                sha256: session.serverFile.sha256,
            }])).values()].sort((a, b) => a.path.localeCompare(b.path)),
        advertisedToolSurfaces: [...new Map<any, any>(mcpSessions
            .filter((session) => session.serverPath && session.advertisedToolSurface?.sha256)
            .map((session) => [session.serverPath, {
                path: session.serverPath,
                source: session.serverSource || "unknown",
                toolCount: session.advertisedToolSurface.toolCount,
                sha256: session.advertisedToolSurface.sha256,
            }])).values()].sort((a, b) => a.path.localeCompare(b.path)),
    },
    forbiddenMcpSessionEnvOverrides,
    unlinkedMcpCallRecords,
    publicToolsByMcpSessionSource,
    missingPublicToolsByMcpSessionSource,
    publicToolsWithoutDirectOkByMcpSessionSource,
    unjustifiedMissingDirectOkToolsByMcpSessionSource,
    publicToolsWithoutOkOrExpectedError: toolCoverage.publicToolsWithoutOkOrExpectedError || [],
    publicToolsWithoutEvidence: toolCoverage.publicToolsWithoutEvidence || [],
    publicToolsWithoutDirectOk: toolCoverage.publicToolsWithoutDirectOk || [],
    publicToolsWithOnlyExpectedErrorEvidence: toolCoverage.publicToolsWithOnlyExpectedErrorEvidence || [],
    unexplainedDiagnosticOnlyTools,
    unjustifiedMissingDirectOkTools,
    providerGapAuditMismatches,
    publicFlowStepToolsWithoutOkOrExpectedError: toolCoverage.publicFlowStepToolsWithoutOkOrExpectedError || [],
    unscriptedAdvertisedTools: toolCoverage.unscriptedAdvertisedTools || [],
    argumentSchemaFailureRecords: toolCoverage.argumentSchemaFailureRecords || [],
    flowStepArgumentSchemaFailures: toolCoverage.flowStepArgumentSchemaFailures || [],
    expectedErrorPayloadFailures: toolCoverage.expectedErrorPayloadFailures || [],
    okPublicPayloadFailures: toolCoverage.okPublicPayloadFailures || [],
    emptyOkPublicPayloadRecords: toolCoverage.emptyOkPublicPayloadRecords || [],
    unexpectedFlowStepErrorRecords: toolCoverage.unexpectedFlowStepErrorRecords || [],
    expectedFlowStepPayloadFailures: toolCoverage.expectedFlowStepPayloadFailures || [],
    okPublicFlowStepPayloadFailures: toolCoverage.okPublicFlowStepPayloadFailures || [],
    emptyOkPublicFlowStepPayloadRecords: toolCoverage.emptyOkPublicFlowStepPayloadRecords || [],
    uncalledProviderArgumentEnumFacets,
    uncalledNonProviderArgumentEnumFacets,
    invalidScriptedArgumentFacets: toolCoverage.invalidScriptedArgumentFacets || [],
    explainedProviderValues: [...explainedProviderValues].sort(),
    unexplainedProviderArgumentEnumFacets,
    skippedCategories: skipCategories,
};

if (!quiet) {
    console.log(JSON.stringify(output, null, 2));
} else if (!output.ok) {
    console.error(`VALIDATION FAILED ${output.failures.join(" ")}`);
}
process.exit(output.ok ? 0 : 1);
