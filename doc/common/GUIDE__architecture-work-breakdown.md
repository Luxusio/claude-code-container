# Architecture work breakdown and progress

Updated: 2026\-10\-11. Source baseline: `c284ead3a637d4d31ca93661920ee0f0200b9077`.

Generated from [the source inventory](architecture-operation-inventory.json) and [the progress overlay](architecture-progress.json).

Known in-scope implementation TODOs: **218** (219 inventoried, 1 explicitly excluded).
Implemented including unmerged candidates: **180/218 (82.6%)**.
Integrated source: **180/218 (82.6%)**; historical baseline: **31**. Candidates: **0**; partial: **4**; TODO: **34**.

These are provisional, unweighted operation counts. Source scope closure and independent inventory re-review remain incomplete. They are not effort estimates or overall architecture/native acceptance percentages. A checked implementation row may still require review, integration and delivery gates. Partial bindings receive no completion credit. OpenCode is outside current scope; Codex and Claude/shared operations remain in scope.

## 0. Tracking and update rules

- One stable OP id counts once; helper files, ports, aliases and equivalent executor bindings do not add TODOs.
- `[x]` means implemented in the recorded baseline or candidate; the status label distinguishes integration. `[ ]` means partial or unimplemented.
- Update the overlay when a candidate, review or scope changes. Preserve historical inventory anchors. After verified source integration and local delivery, mark the lane accepted with its immutable acceptedIntegrationCommit; then run `node scripts/render-architecture-progress.mjs`. Partial bindings remain partial. A fresh inventory baseline is a separate validated refresh.
- Keep code implementation, review/QA, integration and native/reliability acceptance separate. Missing hook receipts never become a formal close PASS.
- Never launch hosted CI, workflow reruns or pushes without explicit user authorization.

## 0.1 Current candidate lanes

| Lane | Whole operations | Partial operations | Commit | Review/QA | Integration |
| --- | ---: | ---: | --- | --- | --- |
| runtime\-launch | 1 | 0 | `02c5a401` | code/security/qa actual PASS; hook receipts absent | accepted @ 10c86183 |
| workspace\-repair | 5 | 0 | `d7f578d8` | code/security/qa actual PASS in recovery run; hook receipts absent, formal close parked | accepted @ 10c86183 |
| codex\-launch | 1 | 0 | `ea96263f` | code/security/qa actual PASS; hook receipts absent | accepted @ 10c86183 |
| codex\-resume | 1 | 0 | `b625854d` | code/security/qa actual PASS; hook receipts absent | accepted @ 10c86183 |
| codex\-clipboard | 1 | 0 | `fb6c26f7` | code/security/qa actual PASS in recovery run; hook receipts absent, formal close parked | accepted @ 10c86183 |
| broker\-observations | 6 | 1 | `3f020650` | code/security/qa actual PASS in recovery run; hook receipts absent, formal close parked | accepted @ 10c86183 |
| sandbox\-stop | 0 | 0 | `e80e5afe` | code/security/qa actual PASS; hook receipts absent, formal source close parked Historical direct\-stop contribution; whole operation now counted once in sandbox\-request\-admin\-integration\. | accepted @ 10c86183 |
| codex\-state\-ownership | 1 | 0 | `912ec696` | independent code/security/QA actual PASS; one task\_verify attempted, hook receipts absent, formal close parked; admitted to root integration | accepted @ 10c86183 |
| lab\-state\-ownership | 1 | 0 | `75bd30de` | independent code/security/QA actual PASS; one task\_verify attempted, hook receipts absent, formal close parked; admitted to root integration | accepted @ 10c86183 |
| clipboard\-bridge | 4 | 0 | `fb7457c7` | independent code/security/QA actual PASS; one task\_verify attempted, hook receipts absent, formal close parked; admitted to root integration | accepted @ 10c86183 |
| destructive\-admission | 1 | 0 | `b94cb28d` | independent code/security/portable QA and actual local delivery PASS; formal hook attestation pending | accepted @ 19e4b93b |
| device\-flow | 1 | 0 | `d5b9bfe2` | independent code/security/portable QA and actual local delivery PASS; formal hook attestation pending | accepted @ 19e4b93b |
| container\-identity\-image | 1 | 0 | `4be2ab3a` | independent code/security/portable QA and actual local delivery PASS; formal hook attestation pending | accepted @ 19e4b93b |
| sandbox\-create | 1 | 0 | `c9261aed` | independent source/composed Code/Security and portable QA PASS; both payloads and verified local delivery; formal hook attestation pending | accepted @ da5d7d36 |
| state\-access | 0 | 1 | `8b74ef39` | independent source/composed Code/Security and portable QA PASS; both payloads and verified local delivery; formal hook attestation pending | accepted @ da5d7d36 |
| runtime\-capabilities | 1 | 0 | `8f97651b` | independent source/composed Code/Security and portable QA PASS; both payloads and verified local delivery; formal hook attestation pending | accepted @ da5d7d36 |
| mcp\-forward | 1 | 0 | `0cd28374` | independent source/composed Code/Security and portable QA PASS; both payloads and verified local delivery; formal hook attestation pending | accepted @ da5d7d36 |
| services\-clean\-harness\-integration | 10 | 0 | `ed8dda6c` | independent code/security/docs actual PASS; genuine build/BOTH42 each/full portable QA actual PASS; hook records absent, no formal close | accepted @ ed8dda6c |
| provider\-workspace\-followup\-integration | 11 | 0 | `b855553f` | Actual independent Code/Security/Docs PASS, genuine build36ff, strict/BOTH57 each/full524files12993tests with33 required terminal files/lint/final authentication PASS\. Local75byte delivery b855 verified; empty hook receipts parked, no formal close\. | accepted @ b855553f |
| admin\-qemu\-integration | 4 | 0 | `b855553f` | Actual independent Code/Security/Docs PASS, genuine build36ff, strict/BOTH57 each/full524files12993tests with33 required terminal files/lint/final authentication PASS\. Local75byte delivery b855 verified; empty hook receipts parked, no formal close\. | accepted @ b855553f |
| qemu\-admin\-lifecycle\-integration | 15 | 0 | `d24e5ca1` | Actual independent Code/Security/Docs PASS; current genuine build, strict contracts, 258 affected cases, seven package cases, actual npm/Unix startup smoke, lint and compiled CLI PASS\. Relevant unchanged tests carry\. Verified local source delivery; empty automatic receipts parked, no formal close\. | accepted @ d24e5ca1 |
| exec\-broker\-image\-integration | 4 | 0 | `acefb933` | Actual independent source/composed and affected Code/Security/Guide PASS\. Required JS and image\-test strict checks, genuine current production build, 17 affected files with 587 passing cases, lint, seven package cases, actual npm/Unix startup smoke and compiled CLI PASS\. Test\-only fixes carried unchanged successful production checks\. Verified local source delivery; empty automatic receipts parked, no formal close\. | accepted @ acefb933 |
| sandbox\-request\-admin\-integration | 6 | 0 | `d0bb62a9` | Actual independent source/composed and affected Code/Security/Docs PASS; strict consumed JS/TS contracts including five negative controls, current genuine build, 21 required files with 867 passing current cases using qualified unchanged results, lint, seven actual package cases, npm/Unix startup smoke and compiled CLI PASS\. Verified local source delivery and all97preserved user changes\. Empty automatic receipt stream parked after one verification; no formal close or native\-host certification\. | accepted @ d0bb62a9 |
| broker\-owner\-leases | 6 | 0 | `cbea3003` | Actual independent Code/Security/Docs and affected correction reviews PASS\. Current complete graph/strict source and fresh emitted contracts, genuine build, 103 image cases, 93 focused real\-worktree cases, lint, seven package cases, actual npm/Unix smoke and compiled CLI PASS; qualified unchanged owner/lease results carry and deleted metatests are excluded\. Actual local source delivery at cbea preserves all97 user changes\. Formal hook records and native\-host certification remain unverified\. | accepted @ cbea3003 |
| broker\-appium\-workflows | 7 | 0 | `58b7d1e9` | Actual independent source/composed/affected Code, Security and Docs PASS\. Current consumed strict contracts and seven negative controls, genuine complete build, 402 fresh regression cases, lint, seven package cases, real npm/Unix startup smoke and compiled CLI PASS\. Qualified unchanged graph/architecture evidence carries; removed verifier metatests excluded\. Source locally delivered at58b7d1e9 with all97 tracked user paths and diff bytes preserved\. Formal hook attestation and native Appium/device certification remain unverified\. | accepted @ 58b7d1e9 |
| device\-observation | 3 | 0 | `b669bf6c` | Actual independent source/composed/affected Code, Security and Docs PASS\. Current all eight native constructor contracts match; reached iOS/Linux binding issues fixed\. Genuine complete build plus actual changed package/MCP artifact refresh, fresh consumed implementation/emitted contracts, 130 fresh regression cases, 668 qualified unchanged cases, seven recording\-core cases, lint, seven package cases, real npm/Unix startup smoke and compiled CLI PASS\. Source locally delivered at b669bf6c preserving all97 user paths and diff bytes\. Unrelated legacy native\-JS strict diagnostics are not accepted; formal hook attestation and native\-host certification remain unverified\. | accepted @ b669bf6c |
| broker\-recording | 3 | 0 | `b669bf6c` | Actual independent source/composed/affected Code, Security and Docs PASS\. Current all eight native constructor contracts match; reached iOS/Linux binding issues fixed\. Genuine complete build plus actual changed package/MCP artifact refresh, fresh consumed implementation/emitted contracts, 130 fresh regression cases, 668 qualified unchanged cases, seven recording\-core cases, lint, seven package cases, real npm/Unix startup smoke and compiled CLI PASS\. Source locally delivered at b669bf6c preserving all97 user paths and diff bytes\. Unrelated legacy native\-JS strict diagnostics are not accepted; formal hook attestation and native\-host certification remain unverified\. | accepted @ b669bf6c |
| mobile\-control\-transfer | 9 | 0 | `5122a56a` | Actual independent composed and affected Code, Security and Guide PASS; independent current binding\-accounting confirms complete mobile9 and Windows/Linux snapshots5\. Original genuine build stages complete with unchanged early\-stage carries and two narrowly corrected fixture type aliases\. Fresh authenticated Android2/iOS1/Linuxsnapshot1 witnesses, 16 affected files416 cases0skip, 22 qualified core cases/strict native constructor\-body scopes, lint, seven package cases, actual npm/Unix startup smoke and compiled CLI PASS\. Source locally FF\-delivered at5122 preserving all97 user paths and diff bytes\. Unrelated legacy native\-JS diagnostics are not accepted; native host certification and formal hook attestation remain unverified\. | accepted @ 5122a56a |
| hyper\-v\-snapshot\-workflows | 5 | 0 | `5122a56a` | Actual independent composed and affected Code, Security and Guide PASS; independent current binding\-accounting confirms complete mobile9 and Windows/Linux snapshots5\. Original genuine build stages complete with unchanged early\-stage carries and two narrowly corrected fixture type aliases\. Fresh authenticated Android2/iOS1/Linuxsnapshot1 witnesses, 16 affected files416 cases0skip, 22 qualified core cases/strict native constructor\-body scopes, lint, seven package cases, actual npm/Unix startup smoke and compiled CLI PASS\. Source locally FF\-delivered at5122 preserving all97 user paths and diff bytes\. Unrelated legacy native\-JS diagnostics are not accepted; native host certification and formal hook attestation remain unverified\. | accepted @ 5122a56a |
| device\-transfers\-physical\-integration | 4 | 0 | `624c26f3` | Actual independent source/composed/affected Code, Security and Guide PASS; current literal all\-binding accounting confirms four whole and twelve partial operations\. Genuine original build complete with qualified unchanged prefix and corrected architecture declaration stage; nineteen affected whole files718cases0skip, lint, seven package cases, actual npm/Unix exports/assets/MCP startup and compiled CLI PASS\. Source31/artifacts1192/fixeddeps7551/links18/locks authenticated; only generated Vitest cache changed\. Actual normal local FF delivery624c preserves all97 user paths and diff bytes\. Original failure logs retained\. Unrelated legacy native\-JS diagnostics, native\-host certification and formal hook closure are unverified\. These twelve bindings were partial at624c; their remaining supported bindings close in device\-interaction\-integration atb4b8 and count once there\. | accepted @ 624c26f3 |
| device\-interaction\-integration | 13 | 0 | `b4b8e748` | Actual independent composed DEEP Code/Security/Docs PASS after both hunters; genuine complete current production build68\.656s, eighteen affected WHOLE files403cases0skip85\.296s, lint, seven semantic package cases, actual npm/Unix exports/assets/MCP startup and compiled CLI PASS\. Current strict/native body and consumed graph checks qualified unchanged inputs\. All\-binding audit includes actual Appium pointer/reverse\-orientation recipes, default authenticated Android emulator/physical orientation and Apple USB/WiFi/unknown UDID, Windows/Linux Hyper\-V controls/transfers\. Source29/emitted1207/fixeddeps7551/18links/2locks authenticated; generated Vitest cache only delta\. Actual normal local FF delivery b4b8 preserves all97 user paths and diff bytes\. No whole legacy\-native\-JS acceptance, native\-host certification or formal hook close claimed\. | accepted @ b4b8e748 |
| qemu\-guest\-workflows | 9 | 0 | `1ffe8d8c` | Actual independent source/composed/affected Code, Security and Guide PASS\. Current strict implementation, consumed negative contracts, core and scoped native constructors PASS; unrelated legacy native\-JS diagnostics remain unaccepted\. Joint genuine production build73\.851s plus sixteen required whole files360 effective cases, lint, seven semantic package cases, genuine npm/Unix exports/assets/MCP startup and compiled CLI PASS\. Actual public QEMU stdio snapshot journey covers all four actions; session/readiness/agent/sync/export retain their native guards\. Host\-broker QEMU snapshots remain explicitly unsupported\. Normal local FF delivery592701d0 preserves all97 user paths and diff bytes, with28 source pins/1216 artifacts/fixed dependencies/18 links authenticated; only generated Vitest cache changed\. Formal hook closure, native hosts and inventory certification remain unverified\. | accepted @ 592701d0 |
| macos\-image\-snapshots | 5 | 0 | `79fc8bf2` | Actual independent source/composed/affected Code, Security and Guide PASS\. Joint current QA and normal592701d0 local delivery qualify the same authenticated production build and sixteen whole files360 effective cases, lint/package7/npm/Unix/CLI checks as QEMU\. Genuine Mac stdio imagecreate/ownedclone/snapshotcreate/confirmedrestore/delete PASS\. All five advertised\-but\-blocked broker image/snapshot bindings return their exact authenticated501 refusals with unchanged owner/resources and no native child effects; this preserves the current contract discrepancy and does not implement positive broker support\. The public state\-write fixture now asserts its precise MCP error while retaining clone/delete compensation and empty state checks\. Existing VM\-create credit is not counted again\. Scoped native constructors and current contracts PASS; native Tart/macOS, unrelated legacy diagnostics, formal hook closure and inventory certification remain unverified\. | accepted @ 592701d0 |
| hyper\-v\-stop\-delete | 4 | 0 | `2c8bcbe6` | Actual independent source/composed/affected Code, Security and Guide PASS\. Current native package strict compilation and genuine production build64\.981s PASS; ten required whole files473 effective cases, lint, package7, real npm/Unix exports/assets/module\-chain startup and compiled CLI0/0/1 PASS\. The test\-only deadline correction imports the actual720000ms lifecycle budget instead of a stale600000ms offset, retaining504/Off/owner/journal/disk assertions\. Ordinary full\-record CAS stays distinct from replay selected\-ID authority; mutation\-free dry\-run and native resource guards remain\. Normal local4ced delivery preserves all97 user paths and binary diff;17source/1228artifacts/fixed dependencies/18links authenticated, only generated cache changed\. Native hosts, formal hook closure and inventory certification remain unverified\. | accepted @ 4cedc1fa |
| installer\-workflows | 4 | 0 | `ab5b5518` | Actual independent full/affected/composed Code, Security and Guide PASS\. Strict architecture compilation consumes actual native installer and synchronous application; installer three whole files35cases0skip PASS\. Same genuine joint build and ten whole files473cases/package7/lint/npm\+materializedUnix module\-chain/startup/CLI proof as Hyper\-V qualify normal4ced local delivery\. Source build precedes installation mutation; User PATH is scoped and best effort, image/cache/partial\-copy outcomes remain truthful\. Private executable PATH prevents disappearing fake Podman from falling through to a host runtime\. No live global installation, Windows User PATH/native runtime certification, formal hook closure or inventory certification is claimed\. | accepted @ 4cedc1fa |

## 0.2 Active next plans

| Lane | Operation ids | State |
| --- | --- | --- |
| clipboard\-bridge | OP\-clipboard\-read, OP\-clipboard\-write, OP\-clipboard\-server\-ensure, OP\-clipboard\-server\-retire | source and combined review/QA PASS; accepted local feature delivery at10c86183; formal missing\-hook close remains parked, native acceptance unverified |
| codex\-state\-ownership | OP\-codex\-state\-ownership\-migration | source and combined review/QA PASS; accepted local feature delivery at10c86183; formal missing\-hook close remains parked, native acceptance unverified |
| lab\-state\-ownership | OP\-lab\-state\-ownership\-migration | source and combined review/QA PASS; accepted local feature delivery at10c86183; formal missing\-hook close remains parked, native acceptance unverified |
| destructive\-admission | OP\-device\-destructive\-admission | source, both shipping forms, combined portable QA and independent local delivery PASS at19e4b93b; accepted feature source, formal verification pending and native acceptance unverified |
| device\-flow | OP\-device\-flow | source, both shipping forms, combined portable QA and independent local delivery PASS at19e4b93b; accepted feature source, formal verification pending and native acceptance unverified |
| container\-identity\-image | OP\-container\-identity\-image | source, both shipping forms, combined portable QA and independent local delivery PASS at19e4b93b; accepted feature source, formal verification pending and native acceptance unverified |
| sandbox\-create | OP\-windows\-sandbox\-create | Whole operation source and both shipping forms passed combined portable QA\. Verified local source delivery da5d7d36; formal hook attestation pending and native acceptance unverified\. |
| state\-access | OP\-state\-storage | Partial state\-read/native\-adapter binding accepted; broader atomic/CAS/repository storage remains incomplete; no whole credit\. Verified local source delivery da5d7d36; formal hook attestation pending and native acceptance unverified\. |
| runtime\-capabilities | OP\-runtime\-capabilities | Whole operation source and both shipping forms passed combined portable QA\. Verified local source delivery da5d7d36; formal hook attestation pending and native acceptance unverified\. |
| mcp\-forward | OP\-mcp\-forward | Whole operation source and both shipping forms passed combined portable QA\. Verified local source delivery da5d7d36; formal hook attestation pending and native acceptance unverified\. |
| broker\-owner\-leases | OP\-broker\-owner\-register, OP\-broker\-owner\-resolve, OP\-lease\-claim, OP\-lease\-heartbeat, OP\-lease\-prune, OP\-lease\-release | Six whole operations accepted and locally delivered at cbea3003 after actual independent Code/Security/Docs and current combined QA PASS; all97 user changes preserved\. Formal hook attestation and native\-host certification remain unverified\. |
| verifier\-trim |  | Seven obsolete custom VM loaders and synthetic graph metatests removed; meaningful ordinary CLI/connection\-deadline checks and actual entire graph retained\. Current combined QA and actual local delivery at cbea3003 PASS\. No operation credit; formal hook attestation remains unverified\. |
| broker\-appium\-workflows | OP\-appium\-server\-start, OP\-appium\-server\-stop, OP\-appium\-session\-ensure, OP\-appium\-session\-delete, OP\-appium\-request, OP\-appium\-record, OP\-appium\-clear | Seven whole operations accepted and locally delivered at58b7d1e9 after actual independent review and current joint QA PASS\. Both native broker and public MCP callers verified portably; formal hook attestation and real Appium/device certification remain unverified\. |
| verifier\-trim\-final |  | Eight obsolete custom loader tests removed; nine ordinary behavior cases added in three existing test files\. Independent source/composed/affected Code PASS, current strict/ordinary joint QA and local delivery at58b7d1e9 PASS\. Test\-only, zero operation credit; formal hook attestation remains unverified\. |
| device\-observation | OP\-backend\-discovery, OP\-device\-inventory, OP\-device\-owned\-list | Three whole operations accepted and locally delivered at b669bf6c after actual independent review and current joint QA PASS\. All eight native discovery bindings and public/broker callers checked portably; formal hook attestation and native\-host certification remain unverified\. |
| broker\-recording | OP\-recording\-start, OP\-recording\-finalize, OP\-recording\-status | Three whole operations accepted in current joint b669bf6c delivery after actual independent review and shared QA PASS\. Original recording worktree retained until source task disposition; no native\-host or formal close claim\. |
| android\-control\-transfer | OP\-device\-click, OP\-device\-long\-press, OP\-device\-swipe, OP\-device\-drag, OP\-device\-type, OP\-device\-key, OP\-device\-back, OP\-device\-home, OP\-device\-forward, OP\-device\-recents, OP\-device\-power\-key, OP\-device\-lock, OP\-device\-unlock, OP\-device\-upload, OP\-device\-download | Accepted Android input/transfer contribution5122 and orientation contributionfb219 in reviewed current b4b8 delivery\. Nine mobile operations count in mobile\-control\-transfer; global control/transfer and orientation count once in device\-interaction\-integration after current all\-binding/public QA\. Native/formal certification unverified\. |
| ios\-control\-transfer | OP\-device\-click, OP\-device\-long\-press, OP\-device\-swipe, OP\-device\-drag, OP\-device\-type, OP\-device\-key, OP\-device\-home, OP\-device\-lock, OP\-device\-unlock, OP\-device\-orientation, OP\-device\-upload, OP\-device\-download | Accepted simulator/physical input and simulator transfer5122 contribution; supported global controls/transfers and orientation count once in device\-interaction\-integration atb4b8 after current all\-binding/public QA\. Physical iOS transfer remains unsupported; native/formal certification unverified\. |
| hyper\-v\-snapshot\-workflows | OP\-hyperv\-snapshot\-list, OP\-hyperv\-snapshot\-create, OP\-hyperv\-snapshot\-restore, OP\-hyperv\-snapshot\-delete, OP\-hyperv\-snapshot\-repair | All five Windows/Linux snapshot workflows accepted and locally delivered at5122 with four repair contexts and genuine authenticated native\-transport witnesses\. No other lifecycle/reboot/native\-host credit; formal hook close unverified\. |
| qemu\-guest\-transfer | OP\-device\-upload, OP\-device\-download | QEMU inward guest transfer contribution624c and actual current artifact/exception guards retained\. Remaining Hyper\-V/global supported bindings close atb4b8; upload/download counted once in device\-interaction\-integration\. Native/formal certification unverified\. |
| desktop\-control\-transfer | OP\-device\-click, OP\-device\-drag, OP\-device\-key, OP\-device\-type, OP\-device\-scroll, OP\-device\-cursor\-move, OP\-device\-cursor\-query, OP\-device\-focus\-window, OP\-device\-window\-list, OP\-device\-upload, OP\-device\-download | Accepted X11/Windows Sandbox/macOS inward source624c plus reviewed current Hyper\-V Windows/Linux contributionb4b8 complete eleven supported global bindings\. Count once in device\-interaction\-integration after current genuine public/native\-transport QA and local delivery\. Native/formal certification unverified\. |
| apple\-wireless\-completion | OP\-apple\-trust\-diagnostic | Accepted broker Apple trust624c plus current inward public iOS wireless b4b8 closes required BIND\-broker\-ios\-device\-device\_wireless\. Current authenticated DEFAULT child USB/WiFi/unknown\-UDID status and provider/MCP refusal proofs PASS; literal udid forwarding fix included with pre\-edit REQ\. One whole OP\-apple\-trust\-diagnostic counted in device\-interaction\-integration\. Native/formal certification unverified\. |
| android\-orientation | OP\-device\-orientation | Orientation source fb219, accepted b4b8 after actual independent reviews/current joint QA; all27 literal bindings include Android12\+iOS12\+Appiumrecipes3 and real native broker/MCP paths\. Whole OP\-device\-orientation counted once in device\-interaction\-integration\. Native/formal certification unverified\. |
| hyper\-v\-desktop\-transfer | OP\-device\-click, OP\-device\-drag, OP\-device\-key, OP\-device\-type, OP\-device\-scroll, OP\-device\-cursor\-move, OP\-device\-cursor\-query, OP\-device\-focus\-window, OP\-device\-window\-list, OP\-device\-upload, OP\-device\-download | Four source/correction commits composed through13e217 thenb4b8; concrete DTO/inward focus, readonly carrier and type\-only client labels reviewed\. Genuine current build/public Windows/Linux controls/transfers QA and accepted\-parent local delivery PASS\. Eleven global operations count once in device\-interaction\-integration with accepted other providers; native/formal certification unverified\. |

## 1. M00 — Baseline and inventory (0/0 implemented)

No separately counted product operations. This packet's foundation/structural acceptance obligations remain in the delivery gates below; zero operation rows does not mean completion.

## 2. M01 — Core and ports (0/0 implemented)

No separately counted product operations. This packet's foundation/structural acceptance obligations remain in the delivery gates below; zero operation rows does not mean completion.

## 3. M02 — State and identity (2/4 implemented)

- [ ] `OP-owner-repository` — Owner repository. **partial**; packages/device\-lab/providers/application/owner\-device\-repository\.mjs.
- [ ] `OP-state-storage` — State storage. **partial**; state\-access @ 8b74ef39.
- [x] `OP-broker-owner-register` — Register canonical host project/profile broker owner mapping. **integrated**; broker\-owner\-leases @ cbea3003.
- [x] `OP-broker-owner-resolve` — Resolve registered canonical owner and ensure broker auth material. **integrated**; broker\-owner\-leases @ cbea3003.

## 4. M03 — Routes and transport (6/6 implemented)

- [x] `OP-device-dispatch` — Select and dispatch supported device operation. **integrated**; sandbox\-request\-admin\-integration @ d0bb62a9.
- [x] `OP-device-inventory` — Device inventory. **integrated**; device\-observation @ b669bf6c.
- [x] `OP-backend-discovery` — Backend discovery. **integrated**; device\-observation @ b669bf6c.
- [x] `OP-device-destructive-admission` — Authorize existing destructive Device Lab action. **integrated**; destructive\-admission @ b94cb28d.
- [x] `OP-device-flow` — Run bounded ordered Device Lab action flow. **integrated**; device\-flow @ d5b9bfe2.
- [x] `OP-device-owned-list` — List current owner device definitions. **integrated**; device\-observation @ b669bf6c.

## 5. M04 — Sandbox lifecycle (4/4 implemented)

- [x] `OP-windows-sandbox-create` — windows\-sandbox create. **integrated**; sandbox\-create @ c9261aed.
- [x] `OP-windows-sandbox-start` — windows\-sandbox start. **integrated**; sandbox\-request\-admin\-integration @ d0bb62a9.
- [x] `OP-windows-sandbox-stop` — windows\-sandbox stop. **integrated**; sandbox\-request\-admin\-integration @ d0bb62a9.
- [x] `OP-windows-sandbox-delete` — windows\-sandbox delete. **integrated**; sandbox\-request\-admin\-integration @ d0bb62a9.

## 6. M05 — Hyper-V lifecycle (9/15 implemented)

- [ ] `OP-windows-vm-create` — windows\-vm create. **TODO**; packages/device\-lab/src/device\-lab\-broker\.ts.
- [ ] `OP-windows-vm-start` — windows\-vm start. **TODO**; packages/device\-lab/src/device\-lab\-broker\.ts.
- [x] `OP-windows-vm-stop` — windows\-vm stop. **integrated**; hyper\-v\-stop\-delete @ 2c8bcbe6.
- [x] `OP-windows-vm-delete` — windows\-vm delete. **integrated**; hyper\-v\-stop\-delete @ 2c8bcbe6.
- [ ] `OP-hyper-v-linux-create` — hyper\-v\-linux create. **TODO**; packages/device\-lab/src/device\-lab\-broker\.ts.
- [ ] `OP-hyper-v-linux-start` — hyper\-v\-linux start. **TODO**; packages/device\-lab/src/device\-lab\-broker\.ts.
- [x] `OP-hyper-v-linux-stop` — hyper\-v\-linux stop. **integrated**; hyper\-v\-stop\-delete @ 2c8bcbe6.
- [x] `OP-hyper-v-linux-delete` — hyper\-v\-linux delete. **integrated**; hyper\-v\-stop\-delete @ 2c8bcbe6.
- [x] `OP-hyperv-snapshot-list` — List exact owned Hyper\-V snapshot. **integrated**; hyper\-v\-snapshot\-workflows @ 5122a56a.
- [x] `OP-hyperv-snapshot-create` — Create exact owned Hyper\-V snapshot. **integrated**; hyper\-v\-snapshot\-workflows @ 5122a56a.
- [x] `OP-hyperv-snapshot-restore` — Restore exact owned Hyper\-V snapshot. **integrated**; hyper\-v\-snapshot\-workflows @ 5122a56a.
- [x] `OP-hyperv-snapshot-delete` — Delete exact owned Hyper\-V snapshot. **integrated**; hyper\-v\-snapshot\-workflows @ 5122a56a.
- [x] `OP-hyperv-snapshot-repair` — Repair exact owned Hyper\-V snapshot. **integrated**; hyper\-v\-snapshot\-workflows @ 5122a56a.
- [ ] `OP-hyperv-linux-guest-trust` — Validate and reconcile allocated Hyper\-V Linux guest SSH trust. **TODO**; packages/device\-lab/src/device\-lab/broker/hyper\-v/network\.ts.
- [ ] `OP-device-reboot` — Reboot exact owned Hyper\-V VM. **TODO**; packages/device\-lab/src/device\-lab\-broker\.ts.

## 7. M06 — Images/network/admin (10/14 implemented)

- [x] `OP-device-admin-cleanup` — Clean owned Device Lab resources. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-device-admin-prune` — Prune stale Device Lab records. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-device-admin-diagnostics` — Diagnose and smoke Device Lab. **integrated**; sandbox\-request\-admin\-integration @ d0bb62a9.
- [x] `OP-device-admin-setup` — Set up Hyper\-V host fabric. **integrated**; sandbox\-request\-admin\-integration @ d0bb62a9.
- [x] `OP-broker-owner-cleanup` — Broker owner cleanup. **integrated**; device\-transfers\-physical\-integration @ 624c26f3.
- [x] `OP-hyperv-image-import` — Import or reuse exact CCC Hyper\-V VHDX image. **integrated**; exec\-broker\-image\-integration @ acefb933.
- [ ] `OP-hyperv-fabric-allocation` — Allocate exact Hyper\-V device network address. **TODO**; packages/device\-lab/src/device\-lab/broker/hyper\-v/network\.ts.
- [x] `OP-qemu-image-import` — Qemu image import. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-device-admin-inventory` — Read host admin current\-owner and explicit all\-project device inventory. **integrated**; admin\-qemu\-integration @ b855553f.
- [ ] `OP-hyperv-fabric-ensure` — Ensure and recover shared Hyper\-V host fabric. **TODO**; packages/device\-lab/src/device\-lab/broker/hyper\-v/network\.ts.
- [ ] `OP-hyperv-fabric-release` — Release exact allocation and recover owned Hyper\-V host fabric cleanup. **TODO**; packages/device\-lab/src/device\-lab/broker/hyper\-v/network\.ts.
- [ ] `OP-hyperv-allocation-reconcile` — Reconcile orphaned Hyper\-V network allocations. **TODO**; packages/device\-lab/src/device\-lab/broker/hyper\-v/network\.ts.
- [x] `OP-hyperv-image-acquire` — Acquire and recover automatic Hyper\-V base image cache. **integrated**; exec\-broker\-image\-integration @ acefb933.
- [x] `OP-qemu-image-list` — List owner QEMU base\-image definitions. **integrated**; admin\-qemu\-integration @ b855553f.

## 8. M07 — Physical/recording/Appium (26/26 implemented)

- [x] `OP-lease-claim` — Lease claim. **integrated**; broker\-owner\-leases @ cbea3003.
- [x] `OP-lease-heartbeat` — Lease heartbeat. **integrated**; broker\-owner\-leases @ cbea3003.
- [x] `OP-lease-prune` — Lease prune. **integrated**; broker\-owner\-leases @ cbea3003.
- [x] `OP-lease-release` — Lease release. **integrated**; broker\-owner\-leases @ cbea3003.
- [x] `OP-physical-attach` — Physical attach. **integrated**; device\-transfers\-physical\-integration @ 624c26f3.
- [x] `OP-physical-detach` — Physical detach. **integrated**; device\-transfers\-physical\-integration @ 624c26f3.
- [x] `OP-apple-trust-diagnostic` — Apple trust diagnostic. **integrated**; device\-interaction\-integration @ b4b8e748.
- [x] `OP-recording-start` — Recording start. **integrated**; broker\-recording @ b669bf6c.
- [x] `OP-recording-finalize` — Recording finalize. **integrated**; broker\-recording @ b669bf6c.
- [x] `OP-recording-status` — Recording status. **integrated**; broker\-recording @ b669bf6c.
- [x] `OP-appium-server-start` — Appium server start. **integrated**; broker\-appium\-workflows @ 58b7d1e9.
- [x] `OP-appium-server-stop` — Appium server stop. **integrated**; broker\-appium\-workflows @ 58b7d1e9.
- [x] `OP-appium-session-ensure` — Appium session ensure. **integrated**; broker\-appium\-workflows @ 58b7d1e9.
- [x] `OP-appium-session-delete` — Appium session delete. **integrated**; broker\-appium\-workflows @ 58b7d1e9.
- [x] `OP-appium-request` — Appium request. **integrated**; broker\-appium\-workflows @ 58b7d1e9.
- [x] `OP-appium-record` — Appium record. **integrated**; broker\-appium\-workflows @ 58b7d1e9.
- [x] `OP-appium-clear` — Appium clear. **integrated**; broker\-appium\-workflows @ 58b7d1e9.
- [x] `OP-physical-stop` — Stop volatile physical\-device auxiliary runtime. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-broker-physical-stop` — Stop broker physical runtime and release exact lease. **integrated**; device\-transfers\-physical\-integration @ 624c26f3.
- [x] `OP-android-wireless-status` — Android wireless status. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-android-wireless-usb-tcpip` — Android wireless usb\-tcpip. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-android-wireless-pair` — Android wireless pair. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-android-wireless-connect` — Android wireless connect. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-appium-list` — List selected owner/backend device Appium projections, including idle device entries with appium:null. **integrated**; broker\-observations @ 3f020650.
- [x] `OP-lease-list` — List active exact\-owner physical hardware leases without claiming, refreshing, pruning or releasing them. **integrated**; broker\-observations @ 3f020650.
- [x] `OP-physical-list` — Observe owned physical device definitions together with active owned leases and Android native host candidates. **integrated**; broker\-observations @ 3f020650.

## 9. M08 — Provider capabilities (53/76 implemented)

- [x] `OP-android-emulator-create` — android\-emulator create. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-android-emulator-start` — android\-emulator start. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-android-emulator-stop` — android\-emulator stop. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-android-emulator-delete` — android\-emulator delete. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-ios-simulator-create` — ios\-simulator create. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-ios-simulator-start` — ios\-simulator start. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-ios-simulator-stop` — ios\-simulator stop. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-ios-simulator-delete` — ios\-simulator delete. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-macos-vm-create` — macos\-vm create. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-macos-vm-start` — macos\-vm start. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-macos-vm-stop` — macos\-vm stop. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-macos-vm-delete` — macos\-vm delete. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-container-qemu-create` — container\-qemu create. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-container-qemu-start` — container\-qemu start. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-container-qemu-stop` — container\-qemu stop. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-container-qemu-delete` — container\-qemu delete. **integrated**; qemu\-admin\-lifecycle\-integration @ d24e5ca1.
- [x] `OP-qemu-session-open` — Qemu session open. **integrated**; qemu\-guest\-workflows @ 1ffe8d8c.
- [x] `OP-qemu-workspace-sync` — Qemu workspace sync. **integrated**; qemu\-guest\-workflows @ 1ffe8d8c.
- [x] `OP-qemu-artifact-export` — Qemu artifact export. **integrated**; qemu\-guest\-workflows @ 1ffe8d8c.
- [x] `OP-qemu-readiness` — Qemu readiness. **integrated**; qemu\-guest\-workflows @ 1ffe8d8c.
- [x] `OP-qemu-guest-agent` — Qemu guest agent. **integrated**; qemu\-guest\-workflows @ 1ffe8d8c.
- [x] `OP-macos-base-image-create` — Base image create macOS Tart VM. **integrated**; macos\-image\-snapshots @ 79fc8bf2.
- [x] `OP-macos-base-image-clone` — Base image clone macOS Tart VM. **integrated**; macos\-image\-snapshots @ 79fc8bf2.
- [x] `OP-macos-snapshot-create` — Snapshot create macOS Tart VM. **integrated**; macos\-image\-snapshots @ 79fc8bf2.
- [x] `OP-macos-snapshot-restore` — Snapshot restore macOS Tart VM. **integrated**; macos\-image\-snapshots @ 79fc8bf2.
- [x] `OP-macos-snapshot-delete` — Snapshot delete macOS Tart VM. **integrated**; macos\-image\-snapshots @ 79fc8bf2.
- [x] `OP-qemu-snapshot-list` — List owned QEMU snapshot. **integrated**; qemu\-guest\-workflows @ 1ffe8d8c.
- [x] `OP-qemu-snapshot-create` — Create owned QEMU snapshot. **integrated**; qemu\-guest\-workflows @ 1ffe8d8c.
- [x] `OP-qemu-snapshot-restore` — Restore owned QEMU snapshot. **integrated**; qemu\-guest\-workflows @ 1ffe8d8c.
- [x] `OP-qemu-snapshot-delete` — Delete owned QEMU snapshot. **integrated**; qemu\-guest\-workflows @ 1ffe8d8c.
- [ ] `OP-device-airplane-mode` — Toggle Android emulator airplane mode. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-app-clear-data` — Clear application data. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-app-install` — Install application on device. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-app-launch` — Launch application on device. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-app-stop` — Stop application on device. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-app-uninstall` — Uninstall application on device. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-back` — Press mobile Back. **integrated**; mobile\-control\-transfer @ 5122a56a.
- [ ] `OP-device-battery` — Set Android emulator battery. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-click` — Click or tap device point. **integrated**; device\-interaction\-integration @ b4b8e748.
- [ ] `OP-device-clipboard-read` — Read mobile clipboard. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-clipboard-write` — Write mobile clipboard. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-cursor-move` — Move device cursor. **integrated**; device\-interaction\-integration @ b4b8e748.
- [x] `OP-device-cursor-query` — Observe device cursor. **integrated**; device\-interaction\-integration @ b4b8e748.
- [x] `OP-device-download` — Download bounded guest artifact. **integrated**; device\-interaction\-integration @ b4b8e748.
- [x] `OP-device-drag` — Drag on device. **integrated**; device\-interaction\-integration @ b4b8e748.
- [ ] `OP-device-exec` — Execute guest command. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-focus-window` — Focus exact device window. **integrated**; device\-interaction\-integration @ b4b8e748.
- [x] `OP-device-forward` — Press Android Forward. **integrated**; mobile\-control\-transfer @ 5122a56a.
- [x] `OP-device-home` — Press mobile Home. **integrated**; mobile\-control\-transfer @ 5122a56a.
- [x] `OP-device-key` — Send device key. **integrated**; device\-interaction\-integration @ b4b8e748.
- [ ] `OP-device-list-files` — List immediate guest directory. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-location` — Set supported virtual device location. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-lock` — Lock mobile screen. **integrated**; mobile\-control\-transfer @ 5122a56a.
- [x] `OP-device-long-press` — Long press mobile device. **integrated**; mobile\-control\-transfer @ 5122a56a.
- [ ] `OP-device-network` — Set supported virtual device network. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-open-url` — Open URL on mobile device. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-orientation` — Set mobile orientation. **integrated**; device\-interaction\-integration @ b4b8e748.
- [ ] `OP-device-permission-grant` — Grant application permission. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-permission-revoke` — Revoke application permission. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-power-key` — Press Android power key. **integrated**; mobile\-control\-transfer @ 5122a56a.
- [x] `OP-device-recents` — Show Android recent applications. **integrated**; mobile\-control\-transfer @ 5122a56a.
- [ ] `OP-device-reset` — Reset existing device/app data. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-device-screenshot` — Capture device screenshot. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-scroll` — Scroll device viewport. **integrated**; device\-interaction\-integration @ b4b8e748.
- [ ] `OP-device-session-status` — Observe mobile automation session. **partial**; broker\-observations @ 3f020650.
- [ ] `OP-device-status` — Observe device runtime status. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-swipe` — Swipe on mobile device. **integrated**; mobile\-control\-transfer @ 5122a56a.
- [x] `OP-device-type` — Type text on device. **integrated**; device\-interaction\-integration @ b4b8e748.
- [ ] `OP-device-ui` — Observe device UI/accessibility. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-unlock` — Unlock mobile screen. **integrated**; mobile\-control\-transfer @ 5122a56a.
- [x] `OP-device-upload` — Upload bounded project file. **integrated**; device\-interaction\-integration @ b4b8e748.
- [ ] `OP-mobile-wait-app` — Wait boundedly for application. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [ ] `OP-mobile-wait-text` — Wait boundedly for mobile text. **TODO**; device\-lab\-mcp/src/server\.mjs.
- [x] `OP-device-window-list` — List device windows. **integrated**; device\-interaction\-integration @ b4b8e748.
- [x] `OP-qemu-disk-materialize` — Materialize owned QEMU overlay disk. **integrated**; admin\-qemu\-integration @ b855553f.
- [x] `OP-qemu-target-list` — List exact owner guest targets. **integrated**; admin\-qemu\-integration @ b855553f.

## 10. M09 — Device Lab entrypoints (4/4 implemented)

- [x] `OP-broker-supervision` — Supervise authenticated host broker. **integrated**; exec\-broker\-image\-integration @ acefb933.
- [x] `OP-device-lifecycle-plan` — Preview one owner\-scoped lifecycle command with validation, idempotency/conflict checks, metadata capacity, incarnation/attachment fences and provider command DTO; execute no planned lifecycle mutation. **integrated**; broker\-observations @ 3f020650.
- [x] `OP-broker-status` — Observe broker runtime/process epoch, package/protocol version, persistence paths, service descriptor/owner and elevation gate facts without ensuring broker or installing service. **integrated**; broker\-observations @ 3f020650.
- [x] `OP-broker-service-status` — Observe OS service\-manager installed/running/owner diagnostics for status only, including dry\-run preview. **integrated**; broker\-observations @ 3f020650.

## 11. M10 — Sessions and containers (14/14 implemented)

- [x] `OP-container-runtime` — Select container runtime. **integrated**; src/application/container\-runtime\-selection\.ts.
- [x] `OP-session-acquire` — Acquire and transfer session ownership. **integrated**; src/application/session\-acquisition\.ts.
- [x] `OP-session-cleanup` — Clean up ended session. **integrated**; src/application/session\-cleanup\.ts.
- [x] `OP-container-reuse` — Reuse, defer or replace existing container. **integrated**; src/application/container\-existing\-lifecycle\.ts.
- [x] `OP-container-create` — Create fresh project container. **integrated**; runtime\-launch @ 02c5a401.
- [x] `OP-container-stop` — Stop project container. **integrated**; src/application/container\-destructive\-lifecycle\.ts.
- [x] `OP-container-remove` — Remove project container. **integrated**; src/application/container\-destructive\-lifecycle\.ts.
- [x] `OP-container-exec` — Execute tool or command in project container. **integrated**; exec\-broker\-image\-integration @ acefb933.
- [x] `OP-clean` — Clean containers/images/volumes. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.
- [x] `OP-container-image` — Prepare container image. **integrated**; src/application/container\-image\-preparation\.ts.
- [x] `OP-container-socket` — Prepare container socket access. **integrated**; src/application/container\-socket\-access\.ts.
- [x] `OP-runtime-capabilities` — Observe and cache selected runtime capabilities. **integrated**; runtime\-capabilities @ 8f97651b.
- [x] `OP-container-identity-image` — Prepare validated derived container identity image. **integrated**; container\-identity\-image @ 4be2ab3a.
- [x] `OP-lab-state-ownership-migration` — prepareLabStateOwnership. **integrated**; lab\-state\-ownership @ 75bd30de.

## 12. M11 — Workspace/profiles/credentials/tools (31/33 implemented)

- [x] `OP-home-migrate` — Migrate legacy home layout. **integrated**; src/application/home\-layout\-migration\.ts.
- [x] `OP-workspace-unified-create` — Create unified workspace. **integrated**; src/application/workspace/unified\-creation\.ts.
- [x] `OP-workspace-multi-create` — Create multi\-repository workspace. **integrated**; src/application/workspace/multi\-creation\.ts.
- [x] `OP-workspace-unified-remove` — Remove unified workspace. **integrated**; src/application/workspace/unified\-removal\.ts.
- [x] `OP-workspace-multi-remove` — Remove multi\-repository workspace. **integrated**; src/application/workspace/multi\-removal\.ts.
- [x] `OP-tool-selection` — Select preferred tool and metadata. **integrated**; src/application/tool\-preferences\.ts.
- [ ] `OP-tool-setup` — Prepare requested tool launcher. **partial**; src/application/requested\-tool\-setup\.ts.
- [x] `OP-version-context` — Discover version files and render tool context. **integrated**; src/application/tooling/version\-file\-scanning\.ts.
- [x] `OP-credential-paths` — Resolve and prepare host credential paths. **integrated**; src/application/credentials/host\-paths\.ts.
- [x] `OP-credential-ssh-refresh` — Refresh host SSH material. **integrated**; src/application/credentials/host\-refresh\.ts.
- [x] `OP-credential-git-refresh` — Refresh host Git configuration. **integrated**; src/application/credentials/host\-refresh\.ts.
- [x] `OP-codex-host-access` — Restore Codex host access. **integrated**; src/application/credentials/codex\-host\-access\.ts.
- [x] `OP-codex-ordered-preparation` — Prepare ordered Codex credentials/configuration. **integrated**; src/application/credentials/codex\-config\-preparation\.ts.
- [x] `OP-install-claude` — Ensure container claude installation. **integrated**; src/application/tooling/container\-installation\.ts.
- [x] `OP-install-npm` — Ensure container npm installation. **integrated**; src/application/tooling/container\-installation\.ts.
- [x] `OP-install-bubblewrap` — Ensure container bubblewrap installation. **integrated**; src/application/tooling/container\-installation\.ts.
- [x] `OP-install-uv` — Ensure container uv installation. **integrated**; src/application/tooling/container\-installation\.ts.
- [x] `OP-workspace-create-admission` — Admit and dispatch workspace create. **integrated**; workspace\-repair @ d7f578d8.
- [x] `OP-workspace-remove-admission` — Admit and dispatch workspace remove. **integrated**; workspace\-repair @ d7f578d8.
- [ ] `OP-workspace-open` — workspace open. **TODO**; src/index\.ts.
- [x] `OP-workspace-content-repair-admission` — workspace content repair admission. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-workspace-cli-remove` — workspace cli remove. **integrated**; provider\-workspace\-followup\-integration @ b855553f.
- [x] `OP-workspace-nested-repair` — Repair missing or empty nested repository worktrees. **integrated**; workspace\-repair @ d7f578d8.
- [x] `OP-workspace-root-recovery` — Recover owned workspace root Git metadata. **integrated**; workspace\-repair @ d7f578d8.
- [x] `OP-workspace-broken-content-repair` — Replace explicitly confirmed broken nested checkout while preserving content. **integrated**; workspace\-repair @ d7f578d8.
- [x] `OP-profile-list` — List reserved\-default and named profiles. **integrated**; src/application/profile\-catalog\.ts.
- [x] `OP-profile-create` — Create explicit named profile. **integrated**; src/application/profile\-catalog\.ts.
- [x] `OP-profile-ensure` — Ensure builtin named profile. **integrated**; src/application/profile\-catalog\.ts.
- [x] `OP-profile-remove` — Remove explicit named profile. **integrated**; src/application/profile\-catalog\.ts.
- [x] `OP-home-config-read` — Read CCC configuration leniently. **integrated**; src/application/home/config\.ts.
- [x] `OP-home-config-update` — Update CCC configuration atomically. **integrated**; src/application/home/config\.ts.
- [x] `OP-home-default-ensure` — Ensure marked no\-profile account. **integrated**; src/application/home/layout\-paths\.ts.
- [x] `OP-codex-state-ownership-migration` — prepareCodexStateOwnership. **integrated**; codex\-state\-ownership @ 912ec696.

## 13. M12 — Host services/tool sessions/remote (15/16 implemented)

- [x] `OP-clipboard-write` — Publish host clipboard text/image. **integrated**; clipboard\-bridge @ fb7457c7.
- [ ] `OP-clipboard-x11-sync` — Synchronize X11 and host clipboard. **TODO**; scripts/ccc\-x11\-bridge.
- [x] `OP-codex-launch` — Prepare interactive Codex daemon launch. **integrated**; codex\-launch @ ea96263f.
- [x] `OP-codex-resume` — Recover qualified Codex resume once. **integrated**; codex\-resume @ b625854d.
- [x] `OP-remote-exec` — Execute command through remote lease. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.
- [x] `OP-localhost-proxy` — Forward transparent localhost connection. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.
- [x] `OP-mcp-forward` — Regenerate per\-profile MCP configuration. **integrated**; mcp\-forward @ 0cd28374.
- [x] `OP-localhost-proxy-setup` — Verify container localhost proxy. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.
- [x] `OP-remote-setup` — Present remote setup guidance. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.
- [x] `OP-remote-check` — Remote check. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.
- [x] `OP-remote-terminate` — Terminate project Mutagen sync. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.
- [x] `OP-clipboard-server-ensure` — Clipboard server ensure. **integrated**; clipboard\-bridge @ fb7457c7.
- [x] `OP-clipboard-server-retire` — Clipboard server retire. **integrated**; clipboard\-bridge @ fb7457c7.
- [x] `OP-clipboard-read` — Read coherent host clipboard snapshot. **integrated**; clipboard\-bridge @ fb7457c7.
- [x] `OP-codex-clipboard-attachment` — Attach clipboard image to eligible Codex invocation. **integrated**; codex\-clipboard @ fb6c26f7.
- [x] `OP-codex-harness-bootstrap` — Ensure existing Codex Harness integration. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.

## 14. M13 — Composition and distribution (6/6 implemented)

- [x] `OP-doctor` — Diagnose CCC runtime. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.
- [x] `OP-labs-diagnostics` — Report lab\-runner status/doctor/smoke. **integrated**; services\-clean\-harness\-integration @ ed8dda6c.
- [x] `OP-global-install` — Install CCC global entrypoint. **integrated**; installer\-workflows @ ab5b5518.
- [x] `OP-global-uninstall` — Uninstall CCC global entrypoint. **integrated**; installer\-workflows @ ab5b5518.
- [x] `OP-source-postinstall` — Handle npm postinstall source/artifact mode. **integrated**; installer\-workflows @ ab5b5518.
- [x] `OP-install-image-build` — Prepare content\-hashed installer container image. **integrated**; installer\-workflows @ ab5b5518.

## 15. M14 — Enforcement and reliability (0/0 implemented)

No separately counted product operations. This packet's foundation/structural acceptance obligations remain in the delivery gates below; zero operation rows does not mean completion.

## 16. Delivery gates (separate from implementation)

Each current packet has source, portable contract, installed package, native and reliability obligations. These gates do not inflate the implementation denominator. Historical source-cutover evidence stays in the canonical inventory and is not counted again as a new TODO.

| Packet | Source | Portable | Package | Native | Reliability |
| --- | --- | --- | --- | --- | --- |
| M00 | [ ] ACC\-M00\-source (unverified) | [ ] ACC\-M00\-portable (unverified) | [ ] ACC\-M00\-install (unverified) | [ ] ACC\-M00\-native (unverified) | [ ] ACC\-M00\-reliability (unverified) |
| M01 | [ ] ACC\-M01\-source (unverified) | [ ] ACC\-M01\-portable (unverified) | [ ] ACC\-M01\-install (unverified) | [ ] ACC\-M01\-native (unverified) | [ ] ACC\-M01\-reliability (unverified) |
| M02 | [ ] ACC\-M02\-source (unverified) | [ ] ACC\-M02\-portable (unverified) | [ ] ACC\-M02\-install (unverified) | [ ] ACC\-M02\-native (unverified) | [ ] ACC\-M02\-reliability (unverified) |
| M03 | [ ] ACC\-M03\-source (unverified) | [ ] ACC\-M03\-portable (unverified) | [ ] ACC\-M03\-install (unverified) | [ ] ACC\-M03\-native (unverified) | [ ] ACC\-M03\-reliability (unverified) |
| M04 | [ ] ACC\-M04\-source (unverified) | [ ] ACC\-M04\-portable (unverified) | [ ] ACC\-M04\-install (unverified) | [ ] ACC\-M04\-native (unverified) | [ ] ACC\-M04\-reliability (unverified) |
| M05 | [ ] ACC\-M05\-source (unverified) | [ ] ACC\-M05\-portable (unverified) | [ ] ACC\-M05\-install (unverified) | [ ] ACC\-M05\-native (unverified) | [ ] ACC\-M05\-reliability (unverified) |
| M06 | [ ] ACC\-M06\-source (unverified) | [ ] ACC\-M06\-portable (unverified) | [ ] ACC\-M06\-install (unverified) | [ ] ACC\-M06\-native (unverified) | [ ] ACC\-M06\-reliability (unverified) |
| M07 | [ ] ACC\-M07\-source (unverified) | [ ] ACC\-M07\-portable (unverified) | [ ] ACC\-M07\-install (unverified) | [ ] ACC\-M07\-native (unverified) | [ ] ACC\-M07\-reliability (unverified) |
| M08 | [ ] ACC\-M08\-source (unverified) | [ ] ACC\-M08\-portable (unverified) | [ ] ACC\-M08\-install (unverified) | [ ] ACC\-M08\-native (unverified) | [ ] ACC\-M08\-reliability (unverified) |
| M09 | [ ] ACC\-M09\-source (unverified) | [ ] ACC\-M09\-portable (unverified) | [ ] ACC\-M09\-install (unverified) | [ ] ACC\-M09\-native (unverified) | [ ] ACC\-M09\-reliability (unverified) |
| M10 | [ ] ACC\-M10\-source (unverified) | [ ] ACC\-M10\-portable (unverified) | [ ] ACC\-M10\-install (unverified) | [ ] ACC\-M10\-native (unverified) | [ ] ACC\-M10\-reliability (unverified) |
| M11 | [ ] ACC\-M11\-source (unverified) | [ ] ACC\-M11\-portable (unverified) | [ ] ACC\-M11\-install (unverified) | [ ] ACC\-M11\-native (unverified) | [ ] ACC\-M11\-reliability (unverified) |
| M12 | [ ] ACC\-M12\-source (unverified) | [ ] ACC\-M12\-portable (unverified) | [ ] ACC\-M12\-install (unverified) | [ ] ACC\-M12\-native (unverified) | [ ] ACC\-M12\-reliability (unverified) |
| M13 | [ ] ACC\-M13\-source (unverified) | [ ] ACC\-M13\-portable (unverified) | [ ] ACC\-M13\-install (unverified) | [ ] ACC\-M13\-native (unverified) | [ ] ACC\-M13\-reliability (unverified) |
| M14 | [ ] ACC\-M14\-source (unverified) | [ ] ACC\-M14\-portable (unverified) | [ ] ACC\-M14\-install (unverified) | [ ] ACC\-M14\-native (unverified) | [ ] ACC\-M14\-reliability (unverified) |

Current packet delivery gates: **75**. See the inventory for revision-bound evidence and exact requirements.

## 17. Inventory closure blockers

The following locally reconciled gaps still await independent inventory acceptance. This is why the known denominator is provisional.

| Gap | State | Required disposition |
| --- | --- | --- |
| GAP\-review\-create\-completion | locally\-source\-reconciled\-awaiting\-independent\-review | Container create retains assigned launch argument and mount policy; bounded extraction is not whole\-operation completion\. |
| GAP\-review\-observation\-routes | locally\-source\-reconciled\-awaiting\-independent\-review | Propagate the source\-grounded broker observation proposals and reconcile every reachable method before counting a complete denominator\. |
| GAP\-review\-inventory\-authority | locally\-source\-reconciled\-awaiting\-independent\-review | Reconcile owner\-definition versus available\-candidate inventory and preserve direct iOS metadata reconciliation\. |
| GAP\-review\-retired\-references | locally\-source\-reconciled\-awaiting\-independent\-review | Current proof owners and CLI dependencies must resolve to current canonical operations, not retired IDs\. |
| GAP\-review\-macos\-dispositions | locally\-source\-reconciled\-awaiting\-independent\-review | Preserve supported direct Tart routes and record exact broker refusals in every binding copy\. |
| GAP\-review\-binding\-authority | locally\-source\-reconciled\-awaiting\-independent\-review | Propagate grounded source/caller and lock category proposals to all canonical and operation\-local binding records\. |
| GAP\-review\-semantic\-references | locally\-source\-reconciled\-awaiting\-independent\-review | Recheck import/reference relationships; an unrelated nearby AST call is not dependency proof\. |
| GAP\-review\-closure\-text | locally\-source\-reconciled\-awaiting\-independent\-review | Reconcile stale source\-scope explanations separately from unverified native acceptance\. |
| GAP\-review\-image\-owner | locally\-source\-reconciled\-awaiting\-independent\-review | Current Hyper\-V image\-import handler/owner references must identify image\-store policy rather than catalog/license support\. |

## 18. Excluded scope

- `OP-opencode-data-access-preparation` — prepareOpenCodeDataDirectory. Retained separately; no implementation or integration without an explicit scope restoration.
