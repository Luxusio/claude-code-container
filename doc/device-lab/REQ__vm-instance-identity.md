# VM instance identity

Managed windows-vm, linux-vm (Hyper-V or container QEMU), and macos-vm definitions receive a fresh opaque public deviceId on creation. The broker or provider composition generates it once using cryptographic randomness, with the backend routing prefix. A display name may contain spaces or Unicode and does not select an instance. Two creations with the same name produce distinct IDs and owned roots; creation, cloning and managed-image definitions cannot intentionally reuse a previous ID.

Public VM creation does not accept a caller-selected deviceId, or a QEMU labId. Reject this input before provider/persistence effects. force does not replace a VM definition under an old ID. If a generated identity collides with a stored definition or private creation residue, refuse before reconciliation, compensation or mutation of that resource. Issuing an ID occurs at admission, outside deterministic parsers; image resolution and internal reparsing retain that admitted identity through lock acquisition, creation, publication and failure compensation.

All public VM operations select the instance with deviceId alone, including exec, start/stop/reboot/delete/status, input, transfers and snapshots. The public MCP schema and flow inheritance do not require or advertise incarnationId. Normal results expose deviceId and display name without a second generation selector. Opt-in diagnostic native identity evidence may remain. Command output, accessibility trees and other guest payloads are opaque and must not have unrelated keys stripped merely because they contain incarnationId.

Existing definitions retain their recorded IDs, native resource names and paths. Selection is an exact owner-scoped ID lookup inside the existing operation lock, including missing-target paths. It never resolves a display name or redirects a deleted ID to a later definition. Deleting and recreating the same display name yields a different ID; operations using the deleted ID cannot affect the replacement.

Provider GUIDs, ownership Notes, private incarnation metadata, process birth identity, journals, captured console frames and publication CAS remain internal effect identities. Keep exact private identity checks during native actions and cleanup. A valid previously accepted orphan operation journal may finish cleanup of its captured GUID/Notes/generation under the locks when its owner record is absent. Without that accepted journal, missing targets are effect-free/not-found, or an effect-free idempotent delete. A mismatched journal, frame, native identity or concurrent successor retains existing refusal and recovery evidence.

VM CLI create positional text is the display name; the command prints the generated returned ID for subsequent operations. Non-VM creation ID behavior remains unchanged. Public clients and brokers use shared protocol version5 and the existing compatibility verification/repair path; a version4 broker cannot silently serve the new creation/one-ID contract.

Real-provider test helpers record and clean up only exact returned fixture IDs. Generic backend routing prefixes or display names cannot authorize test-residue deletion. Private console/setup diagnostic helpers may still use internal generation metadata retrieved through diagnostic evidence.

Verification uses existing application, broker, public MCP/CLI and provider fixture suites: same-name independent creation, chosen-ID and force refusal before effects, identity retained across image reparse/publication/compensation, deleted-ID refusal, one-ID operations with exact private effects, held-lock lookup freshness, private frame/journal/GUID/Notes mismatch, valid orphan recovery, and mixed protocol versions. Strict type checks include QEMU lifecycle contracts; controlled Linux and native Windows QA precede bounded acceptance. Real provider/hardware and whole-architecture certification are separate.

## Known ceiling

Unrecorded historical test fixtures remain outside automatic cleanup. Recover them only when their exact fixture IDs are established; display names and generic backend prefixes do not establish fixture ownership.

If a VM creation transport fails after submission, its outcome may be unknown. Do not automatically retry name-only creation because a second request creates a second instance. Inspect owner inventory to recover the generated ID; an explicitly new create request is a new birth.
