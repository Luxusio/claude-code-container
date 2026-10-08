# Ordered device-flow architecture

The public `run_flow` facade delegates its complete sequential workflow to
`packages/device-lab/providers/application/device-flow.mjs`. Domain policy in
`domain/device-flow.mjs` owns the 50-step limit and normalized target sharing;
`ports/device-flow.d.mts` declares the required semantic observations, scope,
dispatch and rendering operations. The facade retains schemas, MCP codecs,
native provider effects, broker locks and destructive admission authority.

Each step is read and validated immediately before execution. Earlier effects
can therefore change later observations. The application creates a fresh broker
scope for every valid step. Inside that callback, operation resolution happens
before step-argument rereading, normalization and dispatch. Only this dispatch
construction and execution are caught; validation, admission presentation and
post-execution processing retain their original exception boundaries.

The application resolves the operation again after the awaited dispatch. It
classifies the raw result before presenting it, so compact action output cannot
erase a provider failure. Presented native blocks remain ordered after the outer
JSON summary, including early stop and continue-on-error flows. Labels, truthy
or falsy `stopOnError`, own legacy `name` refusal and mutable step-array length
retain their existing observation behavior.

Target inheritance first requires the tool schema's `required` array to include
`deviceId`, then requires each individual target property to exist. Only
`deviceId` and `incarnationId` are inherited. An explicit changed `deviceId`
suppresses the inherited target group; changing `backend` alone does not.
Per-step destructive confirmation remains explicit.

The three `src/__tests__/architecture/device-flow-*.test.ts` witnesses cover
ordered core traces, the actual frozen versus current MCP facade and required
type/dependency contracts. The baseline is revision
`10c8618383811ced1f24305c35f6098ab858d25d`, frozen before production edits in the
ignored `proof/device-flow-baseline` directory with a SHA256 manifest. The facade
witness imports frozen local schema, argument, admission and output modules,
substitutes leaf transport/provider effects and verifies byte-identical original
provider aliases. Integration can rematerialize the same revision if that ignored
archive is absent. Existing canonical-flow, flow-output, flow-wait and
broker-call-flow tests retain actual stdio, raw-error and native-output coverage.
The architecture compiler must execute the negative type witnesses; runtime test
transpilation alone cannot prove them.

This is a source migration candidate until independent code/security review and
focused QA pass. Package proof separately imports the new provider exports from
an isolated assembled or packed installation. Root shipping proof separately
runs the shipped or bundled MCP entry over actual stdio and records the combined
integration outcome. Native and reliability acceptance remains unverified here;
this guide does not credit those gates, all of M07 or the overall migration.
