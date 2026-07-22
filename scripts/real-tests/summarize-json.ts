import { readFileSync } from "fs";

const file = process.argv[2];
if (!file) {
    console.error("Usage: node scripts/real-tests/summarize-json.ts <summary.json>");
    process.exit(1);
}

const summary = JSON.parse(readFileSync(file, "utf-8"));
const records = Array.isArray(summary.records) ? summary.records : [];
const mcpSessions = Array.isArray(summary.mcpSessions) ? summary.mcpSessions : [];

function groupByStatus(status) {
    const grouped = new Map();
    for (const record of records.filter((item) => item?.status === status)) {
        const reason = record.reason || record.detail || "(no reason)";
        const current = grouped.get(reason) || { reason, count: 0, records: [] };
        current.count += 1;
        current.records.push({
            test: record.test,
            ...(record.step ? { step: record.step } : {}),
        });
        grouped.set(reason, current);
    }
    return [...grouped.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function skipCategory(record) {
    const reason = String(record?.reason || "");
    if (/missing (?:adb|emulator|xcrun|wsb|tart|vz|utmctl|xdotool|scrot)|no installed Android SDK system image|no physical (?:iOS|Android) device visible|missing CCC_REAL_|current display prerequisites/.test(reason)) return "provider-prerequisite";
    if (/not a (?:macOS|Windows|Linux) host/.test(reason)) return "host-platform";
    if (/hyper-v-management-permission/.test(reason)) return "host-permission";
    if (/\/dev\/kvm is not available/.test(reason)) return "host-virtualization";
    return "other";
}

function groupSkipsByCategory() {
    if (Array.isArray(summary.skipCategories)) return summary.skipCategories;
    const grouped = new Map();
    for (const record of records.filter((item) => item?.status === "SKIP")) {
        const category = skipCategory(record);
        const current = grouped.get(category) || { category, count: 0, records: [] };
        current.count += 1;
        current.records.push({
            test: record.test,
            ...(record.step ? { step: record.step } : {}),
            ...(record.reason ? { reason: record.reason } : {}),
        });
        grouped.set(category, current);
    }
    return [...grouped.values()].sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

const output = {
    host: summary.host || null,
    total: summary.total ?? records.length,
    pass: summary.pass ?? records.filter((record) => record.status === "PASS").length,
    skip: summary.skip ?? records.filter((record) => record.status === "SKIP").length,
    fail: summary.fail ?? records.filter((record) => record.status === "FAIL").length,
    failOnSkip: summary.failOnSkip === true,
    failOnCoverageGap: summary.failOnCoverageGap === true,
    ...(Number.isInteger(summary.strictSkipFailures) ? { strictSkipFailures: summary.strictSkipFailures } : {}),
    ...(Number.isInteger(summary.strictCoverageFailures) ? { strictCoverageFailures: summary.strictCoverageFailures } : {}),
    ...(Number.isInteger(summary.strictOutcomeFailures) ? { strictOutcomeFailures: summary.strictOutcomeFailures } : {}),
    ...(summary.toolCoverage ? {
        toolCoverage: {
            canonicalToolSurface: summary.toolCoverage.canonicalToolSurface || null,
            advertised: Array.isArray(summary.toolCoverage.advertisedTools) ? summary.toolCoverage.advertisedTools.length : 0,
            called: Array.isArray(summary.toolCoverage.calledTools) ? summary.toolCoverage.calledTools.length : 0,
            calledPublic: Array.isArray(summary.toolCoverage.calledPublicTools) ? summary.toolCoverage.calledPublicTools.length : 0,
            calledHiddenCompatibility: Array.isArray(summary.toolCoverage.calledHiddenCompatibilityTools) ? summary.toolCoverage.calledHiddenCompatibilityTools.length : 0,
            calledArgumentFacets: Array.isArray(summary.toolCoverage.calledArgumentFacets) ? summary.toolCoverage.calledArgumentFacets.length : 0,
            callOutcomes: summary.toolCoverage.callOutcomes || {},
            toolOutcomeSummary: summary.toolCoverage.toolOutcomeSummary || {},
            toolEvidenceSummary: summary.toolCoverage.toolEvidenceSummary || {},
            publicToolsWithoutOkOrExpectedError: summary.toolCoverage.publicToolsWithoutOkOrExpectedError || [],
            publicToolsWithoutEvidence: summary.toolCoverage.publicToolsWithoutEvidence || [],
            publicToolsWithoutDirectOk: summary.toolCoverage.publicToolsWithoutDirectOk || [],
            publicToolsWithOnlyExpectedErrorEvidence: summary.toolCoverage.publicToolsWithOnlyExpectedErrorEvidence || [],
            unexplainedDiagnosticOnlyTools: summary.toolCoverage.unexplainedDiagnosticOnlyTools || [],
            unjustifiedMissingDirectOkTools: summary.toolCoverage.unjustifiedMissingDirectOkTools || [],
            explainedProviderValues: summary.toolCoverage.explainedProviderValues || [],
            unexplainedProviderArgumentEnumFacets: summary.toolCoverage.unexplainedProviderArgumentEnumFacets || [],
            scripted: Array.isArray(summary.toolCoverage.scriptedTools) ? summary.toolCoverage.scriptedTools.length : 0,
            scriptedPublic: Array.isArray(summary.toolCoverage.scriptedPublicTools) ? summary.toolCoverage.scriptedPublicTools.length : 0,
            scriptedHiddenCompatibility: Array.isArray(summary.toolCoverage.scriptedHiddenCompatibilityTools) ? summary.toolCoverage.scriptedHiddenCompatibilityTools.length : 0,
            scriptedArgumentFacets: Array.isArray(summary.toolCoverage.scriptedArgumentFacets) ? summary.toolCoverage.scriptedArgumentFacets.length : 0,
            invalidScriptedArgumentFacets: summary.toolCoverage.invalidScriptedArgumentFacets || [],
            uncalledAdvertisedTools: summary.toolCoverage.uncalledAdvertisedTools || [],
            unscriptedAdvertisedTools: summary.toolCoverage.unscriptedAdvertisedTools || [],
            uncalledScriptedTools: summary.toolCoverage.uncalledScriptedTools || [],
            uncalledScriptedArgumentFacets: summary.toolCoverage.uncalledScriptedArgumentFacets || [],
            unadvertisedTools: summary.toolCoverage.unadvertisedTools || [],
            incompleteOutcomeRecords: summary.toolCoverage.incompleteOutcomeRecords || [],
            argumentSchemaFailureRecords: summary.toolCoverage.argumentSchemaFailureRecords || [],
            flowStepArgumentSchemaFailures: summary.toolCoverage.flowStepArgumentSchemaFailures || [],
            unexpectedErrorResultRecords: summary.toolCoverage.unexpectedErrorResultRecords || [],
            expectedErrorResultRecords: summary.toolCoverage.expectedErrorResultRecords || [],
            expectedErrorPayloadFailures: summary.toolCoverage.expectedErrorPayloadFailures || [],
            okPublicPayloadFailures: summary.toolCoverage.okPublicPayloadFailures || [],
            emptyOkPublicPayloadRecords: summary.toolCoverage.emptyOkPublicPayloadRecords || [],
            flowStepOutcomeSummary: summary.toolCoverage.flowStepOutcomeSummary || {},
            flowStepToolOutcomeSummary: summary.toolCoverage.flowStepToolOutcomeSummary || {},
            publicFlowStepTools: summary.toolCoverage.publicFlowStepTools || [],
            publicFlowStepToolsWithoutOkOrExpectedError: summary.toolCoverage.publicFlowStepToolsWithoutOkOrExpectedError || [],
            expectedFlowStepErrorRecords: summary.toolCoverage.expectedFlowStepErrorRecords || [],
            unexpectedFlowStepErrorRecords: summary.toolCoverage.unexpectedFlowStepErrorRecords || [],
            expectedFlowStepPayloadFailures: summary.toolCoverage.expectedFlowStepPayloadFailures || [],
            okPublicFlowStepPayloadFailures: summary.toolCoverage.okPublicFlowStepPayloadFailures || [],
            emptyOkPublicFlowStepPayloadRecords: summary.toolCoverage.emptyOkPublicFlowStepPayloadRecords || [],
            argumentFacetSamples: Array.isArray(summary.toolCoverage.calledArgumentFacets)
                ? summary.toolCoverage.calledArgumentFacets.slice(0, 25)
                : [],
            scriptedArgumentFacetSamples: Array.isArray(summary.toolCoverage.scriptedArgumentFacets)
                ? summary.toolCoverage.scriptedArgumentFacets.slice(0, 25)
                : [],
        },
    } : {}),
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
    skippedCategories: groupSkipsByCategory(),
    skippedReasons: groupByStatus("SKIP"),
    failedReasons: groupByStatus("FAIL"),
};

console.log(JSON.stringify(output, null, 2));
