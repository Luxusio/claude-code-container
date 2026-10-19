# Typed Hyper-V Linux seed provisioning

## Observable contract

When Device Lab creates a Linux VM, it must verify the exact VM ID, name,
ownership Notes, stopped state and image generation before writing SSH keys or
NoCloud media. The VM must have exactly one `CCC Bootstrap DHCP` adapter on
`Default Switch` with the derived bootstrap MAC. That MAC must occur exactly
once across the host's VM adapters and belong to the same VM.

Those names and the `02` to `06` bootstrap MAC derivation belong to Device Lab.
It supplies the adapter name, switch name and MAC explicitly to the typed
library operation. The reusable operation revalidates those expectations;
it does not select CCC defaults. Creation planning likewise receives an
explicit bootstrap MAC, which Device Lab uses for preflight and readback.

Device Lab creates SSH keys, a pinned known-hosts entry and `cidata.iso` under
the owner-scoped device roots. It validates the media command's VM identity,
media path and SSH host identity before changing the VM. The media builder does
not invoke Hyper-V VM cmdlets.

The typed Hyper-V operation rechecks VM ownership, stopped state, generation,
bootstrap adapter identity, the expected OS disk and absence of the seed ISO
attachment immediately before mutation. It attaches the ISO once, places the
OS disk first in the boot order and reads back the result. Generation 2 retains
Secure Boot Off; generation 1 uses the existing IDE-first BIOS order. Linux
provisioning preserves the current integration-service settings.

On failure after DVD attachment, Linux native configuration leaves the DVD
untouched when attachment identity cannot be proved; a matching ISO path or
controller slot alone is insufficient evidence for removal. Device Lab reports
a bounded error and performs its existing owner-scoped create rollback or
reconciliation. It never retries an attachment after a timeout or uncertain
native result.

## Verification cues

Test both generations and the Windows provisioning regression. Prove that
foreign or duplicate bootstrap MACs, changed VM identity/state, already
attached ISO, invalid media result, native readback mismatch and uncertain
transport outcomes cannot silently mark a Linux guest provisioned. Windows
PowerShell parser/Pester and disposable-host checks are separate release
evidence; Linux static tests do not establish them.
