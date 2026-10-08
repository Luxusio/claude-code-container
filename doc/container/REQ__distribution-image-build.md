# Explicit distribution image build

An installed npm or Unix-materialized CCC payload must provide a copyable, explicit image recovery command:

```text
node <absolute-payload>/scripts/build-distribution-image.mjs --runtime docker
node <absolute-payload>/scripts/build-distribution-image.mjs --runtime podman
```

`--runtime` is required and accepts only `docker` or `podman`. Missing, invalid, duplicate or extra arguments fail before invoking a runtime. The command never detects a runtime, builds on import, runs from the caller's working directory, or triggers automatically from image preparation/postinstall. `ensureImage` retains registry pull/tag/fallback/error behavior; only its local recovery hint changes. The hint observes the current selected runtime at the existing late failure point and quotes the actual payload path safely for POSIX shell or Windows PowerShell. JSON string quoting is not shell escaping.

The command resolves its payload root from its own module URL. It invokes the selected executable without a shell, with separate argv `build -t ccc -f <absolute-payload>/Dockerfile.distribution <absolute-payload>`, and a finite 20-minute timeout matching the source installer's existing image build budget. Unicode, spaces, apostrophes and shell metacharacters in payload paths remain literal argv. The tag is fixed `ccc`; no extra labels, source fallback, cwd-derived context or runtime probing is permitted.

Successful status zero alone reports completion. Every positive runtime exit status propagates unchanged, with an explicit bounded diagnostic. Spawn error, timeout, signal, null/missing/invalid status or thrown native invocation fail observably and never report success. Wrapper diagnostics are bounded; inherited runtime build output remains normal native output. Failure does not install, launch, stop or replace containers.

`Dockerfile.distribution` uses accepted prebuilt `dist/device-lab-mcp` and `dist/packages` in place of the source MCP builder. Chromium download, Go proxy build, Ubuntu/main-image packages, user/tool/mise/runtime layers, profile/cache/mount paths, entrypoint, environment and command remain the checkout recipe's existing semantics. All local COPY inputs must exist in each actual shipped payload; stage-to-stage sources are accounted for separately. The command and recipe, own Go proxy module and entrypoint ship with npm files and Unix installer payloads. There is no full TypeScript/workspace source graph, root lock/shrinkwrap requirement or altered dependency installation strategy in the MCP stage.

Checkout `Dockerfile` and `Containerfile` remain unchanged. Source global install continues source compilation and checkout-image build before Unix materialization, with the existing `content.hash` label calculation. The explicit distribution build adds no label: existing image preparation accepts an available unlabelled local image, while normal registry image/version behavior is unchanged. Unix materialization adds the recipe and retains its reduced package manifest, scripts and dist delivery.

Verification requires actual extracted npm and installer-materialized payload COPY closure, production command import/argument/failure/timeout/argv capture, actual emitted recovery hint, strict current declarations, and unchanged protected recipe/native bytes. Argv/closure/build-tool proofs do not establish a real Docker/Podman image build, image execution, network forwarding or platform acceptance. Root owns independent review/QA, complete build and both shipping forms; private author captures are nonattesting.
