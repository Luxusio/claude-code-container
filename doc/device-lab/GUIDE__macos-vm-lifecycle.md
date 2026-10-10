# Direct macOS VM lifecycle

`handleMacosTool` remains the direct public entry point. Owner/device and clone-source locks, validation and native response formatting remain in the facade. Create/start/stop/delete dispatch to the lifecycle application.

The application owns admission, stale-claim recovery, conditional publication and compensation. Image creation handles Tart cloning, managed-resource metadata and claim rollback. Base-image clone and snapshots retain separate workflows without duplicate credit.

Start owns planning, launch, runtime publication and boot/helper progression. Successors can veto publication; rollback preserves resources referenced by the successor. Stop/delete must retain recording identity and recovery metadata when signal verification or bounded exit confirmation fails. Resource deletion must refuse uncertain recording cleanup, while reporting completed provider effects and publication conflicts.

Domain facts describe resources, records and SSH selection. Required semantic ports expose repository, commands, launch, recording, SSH, clock and responses. Native adapters retain CAS, process identity, guarded keys/artifacts, provider execution and readiness. Inward layers do not observe ambient native APIs.

Current core/fake-port, actual facade/MCP, authenticated broker and strict port tests cover workflows, compensation, successors and partial failures. Genuine build and ordinary actual package smoke verify emitted output and startup. No frozen facade, historical arity, getter/receiver order or separate permission framework is required.

Whole-operation credit requires direct and broker policy bindings and current integration QA. Real macOS, Tart/VZ/UTM and guest acceptance remain separate and unverified in portable fixtures.
