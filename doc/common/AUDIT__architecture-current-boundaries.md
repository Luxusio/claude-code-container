# Current architecture boundaries and remaining work

Checked: 2026-10-15. Source reference: `b047dd3ca691a879135068e9148fcd3b14d4d41b` **plus current protected dirty working bytes**. This is a bounded owning-body audit, not an exhaustive source inventory or native execution result. Key current inputs are pinned below.

The [original ADR](ADR__ccc-target-architecture.md), [contracts](SPEC__ccc-architecture-contracts.md) and [migration packets](PLAN__ccc-architecture-migration.md) still define completion. The [historical inventory](architecture-operation-inventory.json) remains at c284; the [progress overlay](architecture-progress.json) preserves later qualified contributions. No operation IDs, acceptance gates or target architecture were added by this audit.

Latest qualified Source: `f57b092367ead801bffd02bd233082368b91feaf`. CB-06/07/08/09 now have independent review, affected portable emitted/public/package QA and local Source delivery. Earlier CB-04/05 qualification of R06/R03 remains: **17/25 complete (68%), eight remaining: five partial and three in progress**. R18/R19 retain their native/global conditions and receive no additional group credit. The original finding table, hashes and earlier qualification ceilings below are historical revision-bound witnesses; see the latest control/process section for current proof and limits.

## Audit-time disposition

Five independent read-only scouts traced Root, MCP/shared providers, broker/native, Hyper-V and distribution. The coordinator read the disputed bodies and reconciled specific retained exceptions. No product, test, build, provider, GUI or network command ran for these source findings. No native failure was reproduced.

Two previously completed structural groups reopen: **R03 workspace admission/recovery** and **R06 Hyper-V lifecycle**. Existing R17/R18/R19 partial groups gain precise Source work. The audit-time bounded subtotal became **15/25 complete (60%), ten remaining: seven partial and three in progress**. Historical 17/25 and its actual qualification remain valid for their narrower inspected scope. Source9c807d1e's six qualified seams are not retracted.

The former eight groups were Windows qualification holds. That description does not cover the newly demonstrated Source seams below. The original 218 in-scope / 219 inventoried operations and 75 packet gates are unchanged. `exhaustive`, `sourceScopeClosed` and denominator/universe certification remain false.

## Original source findings and repair scopes

| Finding | Reached body and trigger | Required next scope / accounting |
| --- | --- | --- |
| CB-01: stop completion contradicts observed VM state | Broker `hyperVTypedPowerObservation` forwards `power.ts:180`'s identity-matched final VM, including non-Off state. `application/lifecycle/hyper-v-stop-delete.ts:217` tests identity, then publishes `stopped` and clears its journal. `domain/lifecycle/hyper-v-stop-delete.ts:109` writes stopped unconditionally. A successful stop transport followed by Running/Stopping/unknown can therefore report completion. | Highest priority: require a qualifying stopped observation before publication/journal clear. Preserve unknown outcome, current receipt, CAS and retry evidence. Reopen R06 within original M05/M06; no claim the earlier power extraction introduced this behavior. |
| CB-02: auxiliary cleanup confuses signal delivery with exit | `broker-owner-cleanup.ts:30` and `:113` clear metadata when synchronous terminate/signal returns ok. Broker composition at `device-lab-broker.ts:5982` binds those functions; `device-lab-process-identity.ts:259` returns ok immediately after kill. A matching Appium process or iOS recorder that delays/ignores its signal can lose its receipt while live. Dedicated Appium/recording stops separately wait. | Highest priority: settled termination observations, retaining metadata/lease on alive or unknown, including lifecycle auxiliary cleanup callers. R17 already partial. Android copy-pending protection is retained but does not prove other process exit. |
| CB-03: owner cleanup has another stop authority | `broker.cleanup.owner` -> cleanupOwnerRuntime -> `brokerOwnerCleanupApplication` (`device-lab-broker.ts:5970`). prepareStop/runPreparedStop at :5985 reduce raw provider execution to success; `broker-owner-cleanup.ts:152` publishes stopped. Android normal stop separately confirms serial and process disappearance. Hyper-V cleanup uses raw stop descriptors, bypassing dedicated host-lock/journal/typed observation orchestration. | R17: compose the existing operation-specific stop ownership once. Preserve held device lock and child acquisition policy; avoid same cross-process lock reacquisition or a universal native stop abstraction. Dedicated Sandbox post-stop list observation was **not** demonstrated and is not claimed. |
| CB-04: native Hyper-V execution records remain inward | `nativeHyperVObservation` in broker :6542 exposes status/signal/stdout/stderr. `domain/lifecycle/hyper-v-create-start.ts:65` declares that shape. Application create/start :440/:492 fabricates mode/provider/status and raw execution fields; stop/delete domain :22 similarly carries native command records. | R06 native-result scope and existing R19 create/start scope: semantic observations plus opaque receipts, current legacy envelopes rendered outward. Preserve existing error precedence, journals, compensation and native fences; no duplicate Hyper-V library validation. |
| CB-05: workspace repair/addition decodes Git process/metadata syntax inward | `src/index.ts:519` -> worktree facade -> `rootWorkspaceRepair` at `src/worktree.ts:1997`. Native ports return spawn results. `application/workspace/repair-root.ts:66/:99/:112/:135/:176` consumes stdout/status, decodes gitdir/HEAD and constructs Git metadata bytes. Addition, nested and broken repair also classify raw Git add results. | Reopen R03 as the broader original M11 recovery seam. Native composition supplies branch/ref facts, metadata decoding/materialization and diagnostics; core retains identity, confirmation, admission, index agreement, compensation and successor rules. |
| CB-06: Android control/transfer interprets native receipts | `providers/application/android-control-transfer.mjs:23/:38/:52/:63` branches on status to allow transfer commit, rotation and second tap; emits stdout/stderr. Android backends :715 and physical :404 bind raw run/runWithTimeout, reached by public handlers. Domain also owns native keycode/rotation representations. | Extend already-partial R19 with actual Android control paths. Normalize native effects outward, retain stage lifecycle and ordering inward, preserve existing public payload/native predicates. This is original M08 control, not Android app-management or R21 attachment/recording. |
| CB-07: macOS observation domain supplies executed argv | `providers/domain/device-observation.mjs:56` constructs Tart/VZ/UTM argv and command metadata. `backends/macos-vm.mjs:48/:99` uses it for real spawn; :153 executes the domain-built stop plan. It also backs public providerPlan. | R18 already partial: keep provider selection/availability/claim policy inward; native recipes and public command materialization outward, with matching existing public metadata and actual arguments. |
| CB-08: session liveness decodes native process framing inward | `src/domain/session-lock.ts:42` parses Windows FOUND/MISSING stdout; `application/session-lock-liveness.ts:42` catches ESRCH/EPERM from its raw legacy probe port. Native facade is reached through current session claim reconciliation. | Original M10 source gate: native observation decoding outward, active/stale/unknown and token policy inward. No unsafe reclamation is proved. Do not assign this Root seam to iOS R10 or silently broaden the shared-mutation-lock R14 subtotal. |
| CB-09: null owner-resolution input bypasses semantic refusal | `/v1/owner/resolve` forwards parsed JSON to `application/broker-owner.ts:54`; resolve casts then dereferences input without null validation. JSON null reaches an outer failure rather than existing invalid-request outcome. | Existing owner/request validation scope: validate shape at the external boundary, retain semantic refusal and current public mapping. Source-derived trigger only; no live request was issued. |

Existing meaningful test surfaces for the next fixes include `architecture/hyper-v-stop-delete-core.test.ts`, broker commands and cleanup suites; `architecture/android-control-transfer.test.ts` and emulator/physical transfer-policy suites; workspace repair suites; session-liveness suites; macOS lifecycle/providerPlan tests. They were read as witnesses of scope, **not executed or counted as new PASS** here. Add behavioral negative cases for the demonstrated missing branch, not source-shape or verifier tests.

## Retained exceptions and unresolved contract qualification

- Root session permission/ACK/global context in `src/session.ts` is an explicitly retained collaborator in inventory source dispositions (notably lines500/748). Finding policy there alone is not a new defect. This exception is distinct from CB-08's native stdout/error interpretation.
- `src/container-runtime.ts` rootless/SELinux/Desktop/Podman-machine and native mount/argv differences are adapter responsibilities under the explicit ContainerRuntime contract. No group reopens merely for their location.
- Hyper-V typed power/host-capacity admission and guarded native deletion remain deliberately retained adapters. Existing cabb56a2 scope excluded stop/delete migration; its actual qualification is preserved. Native identity/attachment rechecks are not business-policy leaks merely because they contain branches.
- Hyper-V `deadline.ts:14/:20/:24` and create/start composition still use Date.now. Backward clock changes can extend local budgets. Original SPEC requires monotonic budgets; earlier extraction guidance explicitly preserved legacy adapter timebases. The global target gap needs explicit clock-domain reconciliation, not a claim that preserved extraction behavior regressed.
- Broker capability/lock-owner branches at :3692/:4054/:9480 and the Root project-tool prelude at `src/index.ts:314` need complete current owner assignment before global composition closure. Existing lock inventory and session collaborators must be reconciled before proposing extraction. No new operation is counted from a helper.
- Existing broker endpoint candidate fallback is characterized behavior. Explicit remote-to-direct fallback remains forbidden; this audit does not authorize changing retained candidate replay behavior.
- Declared exports without internal consumers remain external compatibility APIs under the original contract. The clipboard stop API's resolved disposition is not reopened.

## Original completion requirements and evidence limits

| Original gate | Current owner / actual evidence | Still required |
| --- | --- | --- |
| Whole Source/callers | Original production universe pins c284; current actual reached bodies above; retained bounded M12 sixteen operations/40 bindings | Reconcile uninspected bodies and current callers. Neither 1732 tracked paths nor these five scouts proves exhaustive closure. |
| Dependencies/types | tsconfig.architecture includes five inward families; existing core-boundary tests inspect those roots; earlier actual strict/emitted checks retained | Qualify the complete migrated directory/consumer graph. Import checks alone do not detect CB-04/05/06 native shape interpretation. |
| Routes/authority | Actual CLI, MCP request composition and broker routes reach application owners; operation-specific locks remain explicit | Resolve CB-02/03 and remaining route/capability ownership, without a second acquiring authority. |
| Package/install/exports | Seventeen selected current distribution control inputs match retained native-observation QA; actual archive and materialized Unix consumers exist | Whole Windows/macOS install, embedded dependency independence and wildcard/declaration/native behavior exceed those witnesses. No redundant shipping rerun was launched. |
| Images | Current source recipes build MCP/packages; distribution recipe consumes prebuilt outputs. Shipping checker checks COPY inputs without image execution | Historical image recipe pins differ from current normalized bytes. Qualify changed inputs, then missing Docker/Podman acceptance when available. Historical PASS is retained, not promoted. |
| Reliability | Existing bounded health/status/echo soak, ownership residue and finite invariant evidence retained | Full operation-stage fault/cancellation/journal/compensation mapping and genuinely missing invariant cases. Durability process identity currently supports Linux/Windows, not Darwin repeat targets. |
| Native platforms | Eight original Windows holds remain; R12 includes125 unexecuted Windows cases | Owner-correct actual access and current inputs. Existing driver8704/target2860 terminal UNKNOWN. No restart/adoption from metadata or timeout; fake native runners are not native acceptance. Mac/provider/rootless/SELinux/remote gates remain separate. |
| Formal close | Prior actual review/QA results and local qualified Source commits retained | Automatic ordered receipts absent for prior parked tasks. Never fabricate or rerun substantive work only for receipts. |

## Inspected reach and exclusions

Root scout read CLI dispatch/workspace composition; all nine composition files; complete session facade and inward acquisition/ownership/cleanup/liveness/exec/handoff; full root repair; reached nested/broken/addition result handling; runtime capability and collector bodies; profile/tool/Codex/remote/credential entry paths. It did not review every helper in the large worktree facade, complete nested/broken transactions, every Docker/setup/clipboard/resume/home/doctor/admin body or embedded programs.

MCP/shared scout read complete server and selected request/presenter/flow/readiness/supervision bodies; reached routing and Appium transport; complete/substantial Android/iOS control/environment/app/observation, shared desktop/flow/physical/repository/generation/QEMU-image bodies; selected complete native adapters and device-store/lease/state bodies. Remaining native MCP discovery/HTTP/schema, full Sandbox/helper/macOS snapshots/QEMU lifecycle/transfers/state/files/process helpers were not certified.

Broker scout read actual HTTP/auth/lifecycle/tool/lock dispatch; owner/physical/recording/Appium/cleanup composition and application bodies; six observation routes, selected native identity/state facades; desktop/transfer; Hyper-V result/deadline seams. Full Hyper-V create/start/network/image/snapshot/native/storage/session/elevation, daemon/service/worker-tree and shared backend bodies remain uninspected in that scout.

Hyper-V scout read selected low-level selector/decoder/transport/guest client; generic reconcile/retry/create/bootstrap/network principal bodies; six ports; complete stop/delete/domain and lifecycle/delete/network adapters; selected create/readiness/power/publication/native removal bodies. It did not inspect every client/decoder/session/native asset/storage/image/application branch. Host-control is under packages/device-lab, not a separate Root src tree.

Distribution scout read four workspace manifests/lock/pins, build/assembly/import rewriting, installer/native launcher chain, exports, three recipes and MCP/recovery consumers; verified eight current native PowerShell source assets against manifests. Packaging consideration of clipboard/proxy/entrypoint inputs does not certify every runtime body. Source wildcard existence is weaker than complete installed contract parity.

These scope limits remain actionable original work. No full source-universe, whole migrated-directory, full distribution/native/reliability or Goal completion is asserted.

## Current key-body pins

SHA-256 is for actual working bytes at audit publication. This finite list authenticates the main witnesses; it is not an exhaustive file manifest or proof that every body in a listed file was reviewed.

| Current input | SHA-256 |
| --- | --- |
| `src/index.ts` | `d643e46a82c0027e7a88da59986796cb8e74805bee1e52d8e2cade6c49243e07` |
| `src/worktree.ts` | `d18145c8190bcbaf7595a4c06ebb30a8619f4b114834a64207909da092d8bfb9` |
| `src/application/workspace/repair-root.ts` | `6cad0642acd85b4bdbd4ffe74fa2f1af67248eb4811e1f16a631138ed833e060` |
| `src/application/workspace/repair-nested.ts` | `194b7de922f58b069d49446022a339e804b381d98f8d827f14d935b11ec05f53` |
| `src/application/workspace/repair-broken.ts` | `3a01a8f2c637dc17dc55b60d66b430ae26baac0cf1b4302b4f19ba43e928c644` |
| `src/application/workspace/worktree-addition.ts` | `809730f45eae2f605596b8d174b16b23c82b19abbd97a9875544cf40e10fd88f` |
| `src/domain/session-lock.ts` | `50c70bc2c2a5b437158f0eaf2c0cfb77c4ecb5267be41128565a4753c776919c` |
| `src/application/session-lock-liveness.ts` | `5efe9c8dee9dbc7a3165958b67a83707b7b26b80ab75e014fb5ea05de97d52c8` |
| `src/session-lock-liveness.ts` | `1a15e664c195802e146989ec6b26cb333e05e884f632bbef8d79ae97a4c66334` |
| `src/session.ts` | `4c4ea211cf6700775030f5a77a069a4864b216961f541bc558de578bbff215fe` |
| `src/container-runtime.ts` | `9f0efac44e886ebf5c841438595bed3304586cdc68903f52472b59cfbddc0a1f` |
| `packages/device-lab/src/device-lab-broker.ts` | `a39fab63b849af69eb93be2e8eef9e3e12f8142118ac37ee9a852299d1ec0b35` |
| `packages/device-lab/src/device-lab-process-identity.ts` | `d802391d5576aad9a0b9555d6d790c65285e8947c1afee67e975c1667ad40187` |
| `packages/device-lab/src/device-lab/application/broker-owner-cleanup.ts` | `81df0b9de5fb9599ca0949eb0f7e3cc1a45f3cc4b2141b266500ca5eadc6d9e3` |
| `packages/device-lab/src/device-lab/application/broker-owner.ts` | `5ecf93d62c03eeb88a9b0389405ee8744a2939881a5044906730ae6581b48325` |
| `packages/device-lab/src/device-lab/application/lifecycle/hyper-v-stop-delete.ts` | `ebabd1889f8b829c1f4df6ca99bdfcc57d7ef22a038b751a90ef0dcc1a5caa12` |
| `packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-stop-delete.ts` | `989cf2f9f59da00998f8cd02e4040fedf61c677dec6ac823637dfa671822f47b` |
| `packages/device-lab/src/device-lab/application/lifecycle/hyper-v-create-start.ts` | `1de56b39ed014645830b0f738bb84e38d5d0a7a0dac3552e7a425ee136a12e7f` |
| `packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-create-start.ts` | `8629900c580da55ad7ad6ebf8f5076b2a669c9c6109ebd6a89298e1ecae25326` |
| `packages/device-lab/src/device-lab/broker/hyper-v/power.ts` | `be5f475782d3ce4ec1bd30f28268d3d05efe769110d783936e028db31bd26d15` |
| `packages/device-lab/src/device-lab/broker/hyper-v/deadline.ts` | `9a19aa99b59e0d704199bd9539988f68af60666ce879cf11c0cccff302e20172` |
| `packages/device-lab/providers/application/android-control-transfer.mjs` | `b30f7c1046f0cc0dd580769254ee0aa189a24b85bf084ae16452b20d9484829f` |
| `packages/device-lab/providers/domain/android-control-transfer.mjs` | `8e3ff7d0dde82bd6b06d236affebb5bdf4d1cefd8b78d09f645cb70447d129de` |
| `packages/device-lab/providers/ports/android-control-transfer.d.mts` | `1eb4bad0ab5b2136db649c17a3905402f12fc8583fdabefec78cdf093cf108b1` |
| `packages/device-lab/providers/domain/device-observation.mjs` | `bee7a8272b0220df7271f63cd4c7eba03840348094472a8285d5e18f7d03922d` |
| `packages/device-lab/providers/backends/android.mjs` | `c8650e3e5682cabde9b76b5b8f40dfd6aa320b1af7197aa219fe3a6ed98bcd40` |
| `packages/device-lab/providers/backends/android-device.mjs` | `d1d68d8ab115988532b892ae208162c247dac84cf8fe56ca997dc9bf5a3a93ac` |
| `packages/device-lab/providers/backends/macos-vm.mjs` | `93960de152694efd1c74f27fe0ec1ed7556d2954606aaedcb70b31b261bdea3c` |
| `device-lab-mcp/src/server.mjs` | `babbca5a735106f606746219f63eb6f7a42ae44892f0a33af423618bf3c95725` |
| `device-lab-mcp/src/application/device-request.mjs` | `9f155dbd99f5aa6caf7e0d0cf942ce38ae1131e638cc83b88903265620645164` |
| `device-lab-mcp/src/application/broker-supervision.mjs` | `dde19057331afb2588c7fb17ccfc21c486acf582b2bc5d9c99c21ae106d6fe80` |
| `package.json` | `752eb15cb89489e6cad2a67b44c2ea8dc7c1840f0f009139ed6bb6309e088836` |
| `scripts/workspace-build.mjs` | `f7131d90269bc2a8958f8f2bb701f7c47b01525577ec0d3a384e8b00e3aa2829` |
| `scripts/install.js` | `64aa383d6216b13bed112c8b91be50fabd4803ae7e359cd5f039d09aefb662c3` |
| `scripts/install/application.mjs` | `e8d48f93a98b2f7fa54829ca56e20d855bbd68681d1001365e6e8e991c2e00b8` |
| `scripts/test-workspace-packages.mjs` | `f5d3deb59eeaae76df7f42c831fa039eb50a01cd09908caf63590ed6491ccd3a` |
| `tsconfig.architecture.json` | `b8983138897aaf9223d1db196fa4bf6480afaa63bd993b7a83ab64f6dda6f1d5` |

## Subsequent bounded stop/cleanup repair

Task: `TASK__architecture-stop-completion-and-cleanup-proof-20261015`; Source commit: `1a3dbf97296774a8877eed99fd518268381968e5`. The original findings and hashes above remain historical witnesses. This section updates only CB-01/02/03's current repair disposition.

| Finding | Bounded implementation | Qualification / remaining condition |
| --- | --- | --- |
| CB-01 | Ordinary Hyper-V stop requires semantic success, exact VM identity and canonical `Off` before stopped publication or journal clear. Non-Off/unknown/conflicting observations retain recovery evidence; delete/replay policy remains. | Compiled core31PASS and fresh composed journey. R06 remains partial: CB-04 inward native execution representation and original qualification obligations remain. |
| CB-02 | Accepted signals are separate from expected-birth termination proof. The finite synchronous observer bounds probes; alive/unknown preserves metadata and leases. Exact predecessor checks guard later effects/escalation. | Runtime67PASS includes an actual owned Linux child exit/reap. Windows/Darwin probes are portable fixtures, not native acceptance. Darwin accepts an exact bounded raw ps birth-token match in the inherited locale. A different live token remains unavailable because locale/timezone formatting cannot prove birth replacement; only qualified absence/zombie evidence proves exit. Portable locale/timezone fixtures passed; real macOS acceptance is unverified. |
| CB-03 | Running virtual owner cleanup reuses the canonical stop operation under its already-held device lock, including provider confirmation, host locks/journals and conditional publication. Actual partial commits and opaque receipts are carried; deadlines are rechecked inside inventory/hardware/Sandbox release locks before mutation. | Cleanup64PASS, Appium98PASS/2 native Windows SKIP, fresh journey and qualified race carry. No second device-lock or raw-stop publication authority. Broader R17 qualification remains. |

Actual final Code r8 PASS after discovery budget exhausted; r7 reviewed final product Source and r8 independently reviewed the final test-only deletion against unchanged Source pins. Actual Security r7 PASS on broker 2ae7fb76 and observer e3a8c789, qualified carry for final domain failure-count deduplication and fixture/accounting-only edits: no process, lease, publication or deadline authority changed; required refusal still counts as failure. Not a new Security review of identical final bytes.

Independent qa-cli retry3 actual PASS after final Code PASS and qualified Security carry. Fresh exact Hyper-V lifecycle journey: 1 PASS, 169 filtered, 170 total; ordinary offline shipping PASS (npm archive, Unix payload, packaged CLI, public exports/assets and MCP stdio). This is not a fresh whole-file170 run. Authenticated retained evidence: QA5 compiled cores163PASS, Source cleanup64PASS, two strict emitted consumers, Appium98PASS/2 native Windows SKIP, and169 byte-unchanged commands cases. Runtime67PASS retains exact six-input provenance; race176PASS retains380 unchanged reached-path inputs, not identical whole-package or fresh execution evidence. Genuine QA5 Device Lab/Root/MCP emissions and assembly were authenticated and reused because the sole later change removes22 accounting/comment lines from a build-excluded test. QA6 reauthenticated14 final pins,1744 Source inputs,7598 dependency files,1055 assembled artifacts and274/44 raw Device Lab/Hyper-V artifacts; zero production TypeScript fallback in2117 resolution events. Evidence: `/tmp/ccc-stop-proof-01a13f5a/qa6/evidence/independent-terminal-audit.json` and sibling selection/authentication/results records. All observed QA4/QA5/QA6 process identities were gone; zero live QA environments. One npm registry lookup was denied before dispatch; no unexpected native dispatch occurred.

QA4 actual FAIL17 and QA5 actual FAIL1 remain retained. Corrected product duplicate conflict counting, stale fixture expectations and private raw/assembled QA layout; final test-only change removes the obsolete whole-journey450-call cap while retaining exact operation/deadline/identity/receipt assertions. Source, tests and behavior docs committed together at1a3dbf97296774a8877eed99fd518268381968e5. Precommit preservation verified1733 tracked metadata entries, all unowned tracked bytes,81 original untracked inputs/link targets, the original semantic index and both PR merge ancestors. Formal close is not claimed by this record. Required automatic ordered review/QA receipts remain a separate gate; direct finals are non-attesting when receipts are absent. The canonical task state records the final verification/park disposition.

At that stop/cleanup checkpoint, these repairs contributed no whole structural-group credit: **15/25 complete (60%), ten remaining: seven partial and three in progress**. CB-04 and all other original findings remain in their groups. The original218 in-scope cutovers,219 inventoried operations and75 delivery gates are unchanged. No exhaustive Source/caller/export closure, native-platform certification, reliability or whole-Goal completion is claimed.

Native Windows/macOS acceptance was not executed in this task. The previously recorded owner/access condition was not retried or resolved here; driver8704/target2860 termination remains unknown. No runtime metadata adoption, provider restart or native completion is claimed. The retained global clock-domain reconciliation and other audit exceptions remain outside this repair.

## Subsequent semantic lifecycle and Workspace qualification

Task: `TASK__architecture-native-results-and-workspace-repair-20261015`; Source commit: `0211995a168faa2132b2bab42707659578d82ff0`. This completes CB-04/05's reviewed Source scope. The original finding table and previous stop/cleanup checkpoint remain historical; CB-06/07/08/09 are not completed here.

| Finding | Current implementation | Qualification |
| --- | --- | --- |
| CB-04 | Core lifecycle/readiness uses semantic facts and opaque receipts; existing native bindings decode execution and present legacy/synthetic summaries and diagnostic overlays. Exact VM plus canonical `Off`, precedence, journals and compensation remain. | Final independent Code r4 PASS and qualified prior Security carry. Strict emitted11, compiled readiness27 and whole broker170 PASS. |
| CB-05 | Four Workspace applications consume semantic Git/metadata observations; existing native bindings own framing and actual staged/no-op inode plus exact bytes. Core retains admission, confirmation, index and successor-safe compensation. | Workspace339PASS/9existing native skips across runs: original336 plus corrected-setup1 and final2. This is not a fresh whole-suite pass. |

Twenty unchanged compiled files394PASS, strict architecture, genuine Device Lab/Root/MCP emissions, scoped Source lint and ordinary assembly are authenticated carry. Fresh ordinary offline npm archive and materialized Unix payload CLI/public-export/MCP checks passed. QA authenticated1745 inputs,7598 dependencies per fixture,1055 assembled/537 raw artifacts and zero production TypeScript fallback in emitted tests. Whole worktree intentionally exercises the real Source CLI.

Original QA1/QA2 type-fixture failures and QA3 whole-worktree3 failures, first setup retry2 failures and diagnostic failure remain retained. QA3 setup repairs touched only private launcher/preload/fake external-runtime/owned-parent tsx IPC bindings; product Source, tests and original dependency bytes stayed unchanged. The standalone CLI passed with finite fake capability observations; the final two inventory cases used their own unchanged transport fixtures. Ordinary shipping used neither extra fixture nor observer. One optional npm registry lookup was denied before dispatch and is retained; no external communication occurred. All1002 observed runtime identities were gone, with zero survivors.

Source, tests and the boundary REQ (39 paths) were locally committed with1736 original tracked metadata entries,1692 unowned tracked files,81 original untracked inputs, the semantic index and both PR merge ancestors preserved. Evidence: `/tmp/ccc-native-results-workspace-01a13fd3/qa3/evidence/final-qualified-runtime-audit.json` (SHA-256 `b35d44e29999b2e62a3d38ffea48ec7ab61511b4405380c84c154c45a1fb6c4f`) and `/tmp/ccc-native-results-workspace-01a13fd3/source-delivery.json`. No CI or push ran.

R03/R06 return to completed within the confirmed structural subtotal: **17/25 (68%), eight remaining**. R19 receives only its Hyper-V readiness contribution and remains partial. No operation or delivery-gate denominator changed.

### Known ceiling

Native Windows/macOS and real providers were not executed here. Original whole-Source/caller/export closure, reliability, native and formal gates remain unverified; CB-06/07/08/09 remain Source work. No whole-Goal completion. Automatic ordered review/QA attestation remains separate; formal close is not claimed by this document.

## Semantic control, provider recipes and process qualification (2026-10-16)

Task: `TASK__architecture-control-process-owner-boundaries-20261016`; Source commit: `f57b092367ead801bffd02bd233082368b91feaf`. This qualifies the four bounded Source findings below; original global/native/reliability/formal gates remain.

| Finding | Qualified ownership | Actual affected proof |
| --- | --- | --- |
| CB-06 | Android core retains admission, ordering, staging, conditional commit and disposal; native bindings decode status, map intentions and render public evidence. | 36 owning cases; public Android/broker family203PASS/2 existing Windows-only skips. |
| CB-07 | macOS selection remains inward; finite outward materialization supplies native recipes and the existing public plan. | 26 owning and26 public cases; both exact legacy package routes consumed by actual Node/strict TypeScript. |
| CB-08 | Existing session facade owns Windows stdout and native errno decoding; application/domain preserve opaque token and active/stale/unknown policy. | 249 owning cases qualified across runs,421 public session/claim/cleanup/clipboard cases; actual owned Linux zombie. Source-labeled child cases here execute authenticated emitted JS. |
| CB-09 | Invalid top-level owner data returns existing semantic400 refusal before identity, registration or auth; existing route/renderer and other mappings remain. | 55 application cases and109 broker cases across runs:106 retained passes plus3 fresh recovered cases,106 filtered. |

Independent final DEEP Code review and Security review passed. Security is qualified carry for the sole later test-import typing correction; no Source/authority change followed its review. QA passed eight owning files475 cases across preserved runs, two actual plain Node/strict TypeScript package cases and sixteen fresh public whole files650PASS/2existing native Windows skips. These are not a fresh single all-green25-file invocation; original failures and the exact broker retry remain recorded. Development477 was not added as fresh QA.

Fresh genuine Device Lab/Root emission, MCP bundle, strict architecture and five emitted consumers (`skipLibCheck:false`), scoped typed Source lint, version injection and assembly passed. Unchanged Hyper-V44 outputs and resume bundle/eight inputs are authenticated carry. Fresh ordinary offline npm archive and Unix payload CLI/public-export/assets/bundled-MCP checks passed.

Private setup corrected an inactive Main-only Vitest cache classification,18 pinned native MCP assets and three exact Source-shaped child URLs/tsx bootstraps bound to genuine emitted JS. Product, test, dependency and guard bytes remained unchanged during QA. Initial fixture failures and three denied tsx socket attempts remain retained. One optional npm registry lookup was denied before dispatch.

The audited routes record35,708 Node resolutions,2,476 Vitest resolutions and9,615 loads/transforms over595 physical targets, with zero hash mismatch/Main resolution/production TypeScript. Five redirects bind the three declared child URLs. Dedicated package children passed functional Node/TypeScript checks but cleared audit environment; no per-child or all-child resolution trace is claimed. All991 observed process identities and groups were gone, with no live/zombie survivors.

Independent final authentication preserved1752 inputs,1737 tracked metadata records,1712 unowned tracked byte records,81 original untracked inputs/link targets, the original105-path binary diff, index/HEAD and both PR merge ancestors. Main7598 dependency proof is before-check carry; private dependencies were reauthenticated afterward. The guarded Source commit contains only30 owned Source/test/REQ paths.

Evidence: `/tmp/ccc-control-process-owner-01a14069/qa1/evidence/independent-qa-final-evidence.json` (SHA-256 `352e6432feb42b090165de8eb074dafa23f8b4c030312d405cf06abd98b0589f`) and `/tmp/ccc-control-process-owner-01a14069/source-delivery.json`. Source at `f57b092367ead801bffd02bd233082368b91feaf` contributes to existing R18/R19 and original M10/owner scope; **17/25 (68%), eight remaining** is unchanged. No operation or gate denominator changed.

### Known ceiling

Native Windows/macOS and real providers were not executed. Whole Source/caller/export closure, reliability and formal acceptance remain unverified. The existing Hyper-V monotonic clock-domain reconciliation and finite capability/lock-owner/CLI composition decisions remain original work. Historical native owner/access and driver-terminal UNKNOWN records were not retried or resolved here. Automatic ordered review/QA attestation is separate, and formal close or whole-Goal completion is not claimed.
