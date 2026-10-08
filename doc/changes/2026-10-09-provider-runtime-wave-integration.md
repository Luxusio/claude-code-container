# Provider and runtime operation integration

Status: combined verification in progress. The local destination remains
`feature/device-mcp-squashed` at `9528cdf9`. No CI, push, global installation,
or native provider mutation is part of this work.

Three complete operations move policy inward while preserving their public
facades: destructive admission, ordered Device Lab flow, and container identity
image preparation. The admission policy has no effects and needs no application
wrapper. Flow retains native routing, codecs and fresh broker scopes in its
adapter. Identity retains native commands, image assets and lock authority.

The accepted source snapshots are admission `b94cb28d`, identity `4be2ab3a`,
and flow `d5b9bfe2`. Each received independent code and security review and
bounded source QA. Flow's final test-only archive correction received affected
review and a fresh 34-test integration recheck. Source QA remains distinct from
the pending compiled distribution and combined acceptance gates.

Ten original commits replayed without conflicts. Root helper commit `aef10c3b`
duplicates admission's final helper commit exactly; the mapping is recorded
without inventing an empty replay. The later archive correction replayed at
`5b8617dc`. All 29 source paths match their original snapshots. Original main
user-file hashes remain protected by the 97-file preservation manifest.

The shared MCP fixture now removes an unused import and uses the existing
NodeNext `.js` import convention. Actual compiler, source-loader and real MCP
fixture checks passed. An interrupted QA assembly was restored; its failure
and subsequent assembly and CLI success remain recorded.

The combined build and production lint passed. The first targeted run passed
306 tests but could not start 34 flow facade tests because Git archive output
exceeded the default subprocess buffer. The fixture now writes directly to an
exact private archive file, preserves the process fence, and exercises fresh
materialization every run. All 34 affected tests then passed.

Both actual shipping forms use the common checker: extracted npm payload and
installer-materialized payload. New checks cover immutable identity witnesses,
provider exports, strict declarations, ordered core flow and bundled public MCP
admission and flow behavior under effect fences. The first run found an emitted
relative import missing from the test's native dependency bindings. Its exact
path now uses the existing frozen lock observation; native import permissions
remain restricted. The corrected checker completed with exit 0 for both forms,
including current strict declaration consumers and public MCP checks. The
independent combined code and security reviews passed. The full portable run
then failed three session ownership cases: 11,574 passed, three failed and
151 skipped across 452 passing, one failing and ten skipped files. Its original
logs and JSON remain preserved; an isolated passing run does not waive it.

A guardian startup repair now removes cleanup-only imports from initialization
and awaits deferred cleanup before terminal exit. Native validation and public
synchronous cleanup contracts remain intact; the 5-second ACK and 15-second
fixture deadlines remain unchanged. The first original failure missed the ACK
deadline; attribution of the other two acquisition failures remains unresolved.
The repair received independent code and security PASS and bounded QA: 294
tests including all 19 emitted process cases, plus 220 supplemental native claim
and liveness tests. Replay `39947369` matches original `0828bce3`. Fresh current
build, both shipping forms and the full combined QA remain required.

The current WBS remains 52/218 implemented and integrated, with 19 partial
operations and 147 TODO. These three operations gain credit only after combined
acceptance. Historical inventory anchors, the provisional denominator and
unverified Windows/macOS/Colima and reliability requirements remain unchanged.
Automatic memory limits and Cargo parallel-job defaults remain removed.

Formal missing-hook blocks and the existing actual-results continuation
decision are recorded separately. No hook receipt, formal close, complete
architecture claim or native acceptance is inferred from these source results.
