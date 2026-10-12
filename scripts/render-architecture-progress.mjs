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
const structuralPlans = progress.planningLanes.filter(lane => lane.id.endsWith("-structural"));
const structuralCounts = { completed: 0, partial: 0, "in-progress": 0, pending: 0 };
const structuralIds = new Set();
for (const lane of structuralPlans) {
    if (structuralIds.has(lane.id) || typeof lane.workStatus !== "string" || !Object.hasOwn(structuralCounts, lane.workStatus)
        || [lane.title, lane.remainingWork, lane.completionCriteria].some(value => typeof value !== "string" || !value.trim())
        || (lane.workStatus === "completed" && (typeof lane.acceptedIntegrationCommit !== "string"
            || !/^[a-f0-9]{40}$/.test(lane.acceptedIntegrationCommit)))) {
        throw Error("Invalid structural group: " + lane.id);
    }
    structuralIds.add(lane.id);
    structuralCounts[lane.workStatus]++;
}
if (!structuralPlans.length) throw Error("Missing structural groups");
const structuralRemaining = structuralPlans.length - structuralCounts.completed;
const structuralPercent = (100 * structuralCounts.completed / structuralPlans.length).toFixed(1);
const percent = count => (100 * count / total).toFixed(1);
const cell = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~\-]/g, "\\$&").replace(/[\r\n]+/g, " ");
const names = ["Baseline and inventory", "Core and ports", "State and identity", "Routes and transport", "Sandbox lifecycle", "Hyper-V lifecycle", "Images/network/admin", "Physical/recording/Appium", "Provider capabilities", "Device Lab entrypoints", "Sessions and containers", "Workspace/profiles/credentials/tools", "Host services/tool sessions/remote", "Composition and distribution", "Enforcement and reliability"];
const label = { integrated: "integrated", candidate: "implemented candidate", partial: "partial", todo: "TODO", excluded: "excluded" };
const structuralLabel = { completed: "완료", partial: "부분 완료", "in-progress": "진행 중", pending: "미착수" };
const out = ["# Architecture work breakdown and progress", "", `Updated: ${cell(progress.updatedAt)}. Source baseline: \`${inventory.baselineCommit}\`.`, "", "Generated from [the source inventory](architecture-operation-inventory.json) and [the progress overlay](architecture-progress.json).", "",
    `확인된 구조 정리 그룹: **${structuralCounts.completed}/${structuralPlans.length} 완료 (${structuralPercent}%)**, **${structuralRemaining}개 남음**.`,
    `부분 완료: **${structuralCounts.partial}**; 진행 중: **${structuralCounts["in-progress"]}**; 미착수: **${structuralCounts.pending}**.`, "",
    "이 수치는 현재 확인된 구조 정리 그룹을 같은 비중으로 센 것이다. 전체 전환의 노력·완료율이나 전수조사 완료를 의미하지 않는다. 완료는 해당 그룹 범위의 독립 리뷰·portable QA·로컬 통합이 확인된 상태다. 부분 완료·진행 중·미착수는 완료 수에 포함하지 않는다. Native 플랫폼, reliability, 전체 소스 범위 및 formal close는 아래 별도 조건으로 남는다.", "",
    "## 0. 남은 구조 정리", "", "| 그룹 | 상태 | 남은 작업 | 완료 조건 | 확인한 소스 |", "| --- | --- | --- | --- | --- |"];
for (const lane of structuralPlans.filter(lane => lane.workStatus !== "completed")) {
    const source = (lane.sourceTrace?.remainingPaths ?? lane.sourceTrace?.owningPaths ?? []).join(", ");
    out.push(`| ${cell(lane.title)} | ${structuralLabel[lane.workStatus]} | ${cell(lane.remainingWork)} | ${cell(lane.completionCriteria)} | ${cell(source)} |`);
}
out.push("", "## 0.1 완료한 구조 정리", "", "| 그룹 | 통합 커밋 | 완료 조건 |", "| --- | --- | --- |");
for (const lane of structuralPlans.filter(lane => lane.workStatus === "completed")) {
    out.push(`| ${cell(lane.title)} | \`${lane.acceptedIntegrationCommit.slice(0, 8)}\` | ${cell(lane.completionCriteria)} |`);
}
out.push("", "각 그룹의 stable ID, 과거 기여, 실제 QA·통합 근거는 progress overlay의 해당 planningLanes 항목에 유지한다. 새 잔여 작업이 확인되면 기존 그룹을 부분 완료로 되돌리고 조건을 갱신한다. helper·포트·테스트 파일을 별도 작업으로 세지 않는다.", "",
    "## 0.2 기능 전환 기록 (참고)", "",
    `Known in-scope operation cutovers: **${total}** (${items.size} inventoried, ${counts.excluded} explicitly excluded).`,
    `Implemented including unmerged candidates: **${implemented}/${total} (${percent(implemented)}%)**.`,
    `Integrated source: **${counts.integrated}/${total} (${percent(counts.integrated)}%)**; historical baseline: **${baselineIntegrated}**. Candidates: **${counts.candidate}**; partial: **${counts.partial}**; TODO: **${counts.todo}**.`, "",
    "These are provisional, unweighted operation counts. Source scope closure and independent inventory re-review remain incomplete. They are not effort estimates or overall architecture/native acceptance percentages. A checked implementation row may still require review, integration and delivery gates. Partial bindings receive no completion credit. OpenCode is outside current scope; Codex and Claude/shared operations remain in scope.", "",
    "Accepted historical structural commits remain recorded even when current group debt makes workStatus partial. Overall migration completion remains unverified.", "",
    "## 0.3 Tracking and update rules", "",
    "- One stable OP id counts once; helper files, ports, aliases and equivalent executor bindings do not add TODOs.",
    "- `[x]` means implemented in the recorded baseline or candidate; the status label distinguishes integration. `[ ]` means partial or unimplemented.",
    "- Update the overlay when a candidate, review or scope changes. Preserve historical inventory anchors. After verified source integration and local delivery, mark the lane accepted with its immutable acceptedIntegrationCommit; then run `node scripts/render-architecture-progress.mjs`. Partial bindings remain partial. A fresh inventory baseline is a separate validated refresh.",
    "- Keep code implementation, review/QA, integration and native/reliability acceptance separate. Missing hook receipts never become a formal close PASS.",
    "- Structural completion uses workStatus, never acceptedIntegrationCommit alone. Record concrete remainingWork and completionCriteria; update only after actual qualified evidence. Then regenerate this Guide.",
    "- Never launch hosted CI, workflow reruns or pushes without explicit user authorization.", "", "## 0.4 Historical operation lanes", "", "| Lane | Whole operations | Partial operations | Commit | Review/QA | Integration |", "| --- | ---: | ---: | --- | --- | --- |");
for (const lane of progress.lanes) out.push(`| ${cell(lane.id)} | ${lane.wholeOperationIds.length} | ${lane.partialOperationIds.length} | \`${lane.commit.slice(0, 8)}\` | ${cell(lane.codeReview)} | ${cell(lane.integration)}${lane.integration === "accepted" ? ` @ ${lane.acceptedIntegrationCommit.slice(0, 8)}` : ""} |`);
out.push("", "Current whole-source/exports/caller closure, final type/composition integration, final package/install/image qualification, reliability/resource evidence, native-platform acceptance and formal disposition remain separate original completion gates.", "", "## 0.5 Other plans and historical contributions", "", "| Lane | Operation ids | State |", "| --- | --- | --- |");
for (const lane of progress.planningLanes.filter(lane => !lane.id.endsWith("-structural"))) out.push(`| ${cell(lane.id)} | ${cell(lane.coveredOperationIds.join(", "))} | ${cell(lane.status)} |`);
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
for (const gap of inventory.gaps) out.push(`| ${cell(gap.id)} | ${cell(gap.remediationStatus)} | ${cell(gap.currentSourceDisposition?.reason ?? gap.currentAuditDisposition?.reason ?? gap.reason)} |`);
out.push("", "## 18. Excluded scope", "");
for (const id of excluded) out.push(`- \`${id}\` — ${cell(items.get(id).operation)}. Retained separately; no implementation or integration without an explicit scope restoration.`);
out.push("");
writeFileSync(resolve(root, "doc/common/GUIDE__architecture-work-breakdown.md"), out.join("\n"));
console.log(JSON.stringify({ structuralGroups: structuralPlans.length, structuralCounts, structuralRemaining, structuralPercent, knownRequired: total, implemented, implementationPercent: percent(implemented), integrated: counts.integrated, integrationPercent: percent(counts.integrated), ...counts, currentPacketGates: gateTotal, sourceDenominatorCertified: progress.sourceDenominatorCertified }));
