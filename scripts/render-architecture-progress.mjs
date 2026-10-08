import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const progress = JSON.parse(readFileSync(resolve(root, "doc/common/architecture-progress.json"), "utf8"));
const inventory = JSON.parse(readFileSync(resolve(root, "doc/common/architecture-operation-inventory.json"), "utf8"));
if (progress.schemaVersion !== 1 || typeof progress.baselineCommit !== "string" || !/^[a-f0-9]{40}$/.test(progress.baselineCommit)
    || progress.baselineCommit !== inventory.baselineCommit) throw Error("Progress baseline/schema mismatch");
if (typeof progress.updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(progress.updatedAt)
    || new Date(`${progress.updatedAt}T00:00:00Z`).toISOString().slice(0, 10) !== progress.updatedAt) throw Error("Invalid progress date");
if (progress.sourceDenominatorCertified && (inventory.closure.exhaustive !== true || inventory.gaps.length)) throw Error("Cannot certify a denominator with unresolved inventory closure");
const items = new Map();
for (const item of inventory.workItems) {
    if (typeof item.id !== "string" || !/^OP-[a-z0-9-]+$/.test(item.id) || items.has(item.id)
        || typeof item.countingOwner !== "string" || !/^M(?:0[0-9]|1[0-4])$/.test(item.countingOwner)
        || typeof item.operation !== "string" || !["migrated", "partial", "pending"].includes(item.implementationStatus)) throw Error("Invalid/duplicate operation: " + item.id);
    items.set(item.id, item);
}
const excluded = new Set(progress.excludedOperationIds);
if (excluded.size !== 1 || progress.excludedOperationIds.length !== 1 || !excluded.has("OP-opencode-data-access-preparation")) throw Error("Only the authorized OpenCode operation may be excluded");
const candidates = new Map();
for (const lane of progress.lanes) {
    if (typeof lane.commit !== "string" || !/^[a-f0-9]{40}$/.test(lane.commit)
        || !["pending", "accepted"].includes(lane.integration)
        || (lane.integration === "accepted"
            ? typeof lane.acceptedIntegrationCommit !== "string" || !/^[a-f0-9]{40}$/.test(lane.acceptedIntegrationCommit)
            : lane.acceptedIntegrationCommit !== undefined)) throw Error("Invalid candidate provenance: " + lane.id);
    for (const [ids, status] of [[lane.wholeOperationIds, "candidate"], [lane.partialOperationIds, "partial"]]) {
        for (const id of ids) {
            if (!items.has(id) || excluded.has(id) || candidates.has(id) || items.get(id).implementationStatus === "migrated") throw Error("Invalid/duplicate candidate operation: " + id);
            candidates.set(id, { status: status === "candidate" && lane.integration === "accepted" ? "integrated" : status, lane });
        }
    }
}
for (const id of excluded) if (!items.has(id)) throw Error("Missing excluded operation: " + id);
for (const lane of progress.planningLanes) for (const id of lane.coveredOperationIds) if (!items.has(id)) throw Error("Missing planning operation: " + id);
const statusFor = item => excluded.has(item.id) ? "excluded" : candidates.get(item.id)?.status
    ?? ({ migrated: "integrated", partial: "partial", pending: "todo" }[item.implementationStatus]);
const counts = { integrated: 0, candidate: 0, partial: 0, todo: 0, excluded: 0 };
for (const item of items.values()) counts[statusFor(item)]++;
const total = items.size - counts.excluded;
const implemented = counts.integrated + counts.candidate;
const baselineIntegrated = [...items.values()].filter(item => !excluded.has(item.id) && item.implementationStatus === "migrated").length;
const percent = count => (100 * count / total).toFixed(1);
const cell = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~\-]/g, "\\$&").replace(/[\r\n]+/g, " ");
const names = ["Baseline and inventory", "Core and ports", "State and identity", "Routes and transport", "Sandbox lifecycle", "Hyper-V lifecycle", "Images/network/admin", "Physical/recording/Appium", "Provider capabilities", "Device Lab entrypoints", "Sessions and containers", "Workspace/profiles/credentials/tools", "Host services/tool sessions/remote", "Composition and distribution", "Enforcement and reliability"];
const label = { integrated: "integrated", candidate: "implemented candidate", partial: "partial", todo: "TODO", excluded: "excluded" };
const out = ["# Architecture work breakdown and progress", "", `Updated: ${cell(progress.updatedAt)}. Source baseline: \`${inventory.baselineCommit}\`.`, "", "Generated from [the source inventory](architecture-operation-inventory.json) and [the progress overlay](architecture-progress.json).", "",
    `Known in-scope implementation TODOs: **${total}** (${items.size} inventoried, ${counts.excluded} explicitly excluded).`,
    `Implemented including unmerged candidates: **${implemented}/${total} (${percent(implemented)}%)**.`,
    `Integrated source: **${counts.integrated}/${total} (${percent(counts.integrated)}%)**; historical baseline: **${baselineIntegrated}**. Candidates: **${counts.candidate}**; partial: **${counts.partial}**; TODO: **${counts.todo}**.`, "",
    "These are provisional, unweighted operation counts. Source scope closure and independent inventory re-review remain incomplete. They are not effort estimates or overall architecture/native acceptance percentages. A checked implementation row may still require review, integration and delivery gates. Partial bindings receive no completion credit. OpenCode is outside current scope; Codex and Claude/shared operations remain in scope.", "",
    "## 0. Tracking and update rules", "",
    "- One stable OP id counts once; helper files, ports, aliases and equivalent executor bindings do not add TODOs.",
    "- `[x]` means implemented in the recorded baseline or candidate; the status label distinguishes integration. `[ ]` means partial or unimplemented.",
    "- Update the overlay when a candidate, review or scope changes. Preserve historical inventory anchors. After verified source integration and local delivery, mark the lane accepted with its immutable acceptedIntegrationCommit; then run `node scripts/render-architecture-progress.mjs`. Partial bindings remain partial. A fresh inventory baseline is a separate validated refresh.",
    "- Keep code implementation, review/QA, integration and native/reliability acceptance separate. Missing hook receipts never become a formal close PASS.",
    "- Never launch hosted CI, workflow reruns or pushes without explicit user authorization.", "", "## 0.1 Current candidate lanes", "", "| Lane | Whole operations | Partial operations | Commit | Review/QA | Integration |", "| --- | ---: | ---: | --- | --- | --- |"];
for (const lane of progress.lanes) out.push(`| ${cell(lane.id)} | ${lane.wholeOperationIds.length} | ${lane.partialOperationIds.length} | \`${lane.commit.slice(0, 8)}\` | ${cell(lane.codeReview)} | ${cell(lane.integration)}${lane.integration === "accepted" ? ` @ ${lane.acceptedIntegrationCommit.slice(0, 8)}` : ""} |`);
out.push("", "## 0.2 Active next plans", "", "| Lane | Operation ids | State |", "| --- | --- | --- |");
for (const lane of progress.planningLanes) out.push(`| ${cell(lane.id)} | ${cell(lane.coveredOperationIds.join(", "))} | ${cell(lane.status)} |`);
for (let index = 0; index < names.length; index++) {
    const packet = `M${String(index).padStart(2, "0")}`;
    const rows = [...items.values()].filter(item => item.countingOwner === packet && !excluded.has(item.id));
    const done = rows.filter(item => ["integrated", "candidate"].includes(statusFor(item))).length;
    out.push("", `## ${index + 1}. ${packet} — ${names[index]} (${done}/${rows.length} implemented)`, "");
    if (!rows.length) { out.push("No separately counted product operations. This packet's foundation/structural acceptance obligations remain in the delivery gates below; zero operation rows does not mean completion."); continue; }
    for (const item of rows) {
        const status = statusFor(item), candidate = candidates.get(item.id);
        const source = candidate ? `${candidate.lane.id} @ ${candidate.lane.commit.slice(0, 8)}` : item.policyOwner;
        out.push(`- ${["integrated", "candidate"].includes(status) ? "[x]" : "[ ]"} \`${item.id}\` — ${cell(item.operation)}. **${label[status]}**; ${cell(source)}.`);
    }
}
out.push("", "## 16. Delivery gates (separate from implementation)", "", "Each current packet has source, portable contract, installed package, native and reliability obligations. These gates do not inflate the implementation denominator. Historical source-cutover evidence stays in the canonical inventory and is not counted again as a new TODO.", "", "| Packet | Source | Portable | Package | Native | Reliability |", "| --- | --- | --- | --- | --- | --- |");
const gateKinds = ["sourceCutover", "portableContract", "packageInstall", "native", "reliability"];
let gateTotal = 0;
for (let index = 0; index < names.length; index++) {
    const packet = `M${String(index).padStart(2, "0")}`;
    const row = gateKinds.map(kind => {
        const gates = inventory.acceptanceItems.filter(item => item.kind === kind && item.id.startsWith(`ACC-${packet}-`));
        if (gates.length !== 1) throw Error(`Ambiguous/missing packet gate: ${packet}/${kind}`);
        gateTotal++;
        return `${gates[0].status === "verified" ? "[x]" : "[ ]"} ${cell(gates[0].id)} (${cell(gates[0].status)})`;
    });
    out.push(`| ${packet} | ${row.join(" | ")} |`);
}
out.push("", `Current packet delivery gates: **${gateTotal}**. See the inventory for revision-bound evidence and exact requirements.`, "", "## 17. Inventory closure blockers", "", "The following locally reconciled gaps still await independent inventory acceptance. This is why the known denominator is provisional.", "", "| Gap | State | Required disposition |", "| --- | --- | --- |");
for (const gap of inventory.gaps) out.push(`| ${cell(gap.id)} | ${cell(gap.remediationStatus)} | ${cell(gap.reason)} |`);
out.push("", "## 18. Excluded scope", "");
for (const id of excluded) out.push(`- \`${id}\` — ${cell(items.get(id).operation)}. Retained separately; no implementation or integration without an explicit scope restoration.`);
out.push("");
writeFileSync(resolve(root, "doc/common/GUIDE__architecture-work-breakdown.md"), out.join("\n"));
console.log(JSON.stringify({ knownRequired: total, implemented, implementationPercent: percent(implemented), integrated: counts.integrated, integrationPercent: percent(counts.integrated), ...counts, currentPacketGates: gateTotal, sourceDenominatorCertified: progress.sourceDenominatorCertified }));
