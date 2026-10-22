# Installer architecture

`createInstallerApplication` owns global install, uninstall, source postinstall and image preparation. `scripts/install.js` is the native CLI and compatibility export adapter. The application and domain are uncompiled ESM under `scripts/install/`: source npm postinstall can load them before compilation, and both npm's file list and Unix payload copying ship the same module chain. Import and factory construction perform no install or build effects.

Required synchronous ports bind individual filesystem/path operations, source npm build, runtime availability and image labels, immediate ready/failed image-build observations with the original cause, supplied content fingerprint inputs, trusted User-scope PowerShell PATH I/O, finite presentation events and process termination. Native composition renders terminal text and PowerShell PATH hints and materializes package JSON plus Unix/Windows launcher bytes and modes. They do not expose complete legacy workflows or a mutable native context. Content traversal and hashing stay native; the application selects the existing fingerprint input lists and content.hash/dockerfile.hash cache policy. GitHub credentials remain in the existing environment-secret mechanism.

Install builds source before modifying the previous installation. Missing runtime skips image preparation; a matching image label avoids rebuilding. Failed image preparation remains a failed image outcome while CLI installation may succeed. Uninstall uses no runtime. Packaged postinstall skips source build; source postinstall propagates the original build failure without recursively installing dependencies. The source-build port returns undefined or throws; it is distinct from the immediate ready/failed image-build observation.

Windows PATH policy reads and writes only the User value, preserving entry trimming, separator/case comparison and the 32767-character limit. It does not overwrite the merged process PATH. Unix installation prepares the complete payload and executable launcher in a private sibling directory before replacing the active paths. Application policy controls the staging, rename publication and caught-failure restoration through finite filesystem ports. The existing native install-directory leaf remains the owned subprocess fixture's redirection boundary.

Unix payload materialization, installation publication and uninstall share a cooperative exclusive destination guard. An existing guard is a prompt refusal, with no automatic stale-owner reclamation. Source and image builds remain outside the guard. Preparation failures preserve the previous regular or symlink launcher; publication failures restore the previous payload when restoration succeeds. A restoration failure preserves and names its recovery directory. See [Unix replacement requirements](REQ__unix-install-replacement.md).

Known ceiling: caught synchronous failures are recoverable under cooperative serialization; the two-path publication is not a crash transaction or a guarantee of uninterrupted concurrent CLI startup. Process/power-loss recovery, hostile noncooperative writers and native macOS sudo acceptance remain separate.

Ordinary core/type tests exercise policy and required synchronous capabilities; the existing private installer subprocess tests exercise real source and installed modules with owned destinations. Strict compilation must consume the native adapter and actual applications. Packaging, build and runtime acceptance belong to independent QA. No live global installation, Windows PATH modification or external container runtime certification is claimed by source inspection.


## Source builds invoked through sudo
On POSIX hosts, a source build invoked by root through sudo validates the complete numeric invoking UID/GID, then runs npm build in a child with that identity. Inside the child, HOME comes from that actual OS account after removing inherited root HOME. Inherited npm cache/userconfig overrides, including case variants, are removed so npm reads the invoking user's settings. Failed validation, account lookup or build never falls back to a root build or proceeds to installation. Ordinary-user, Windows and direct-root-without-sudo behavior is unchanged. The synchronous sourceBuild capability and import/factory inertness remain intact.

Before the user build, the sudo parent recovers legacy root-owned build outputs
only in `dist`, `packages/hyper-v/dist` and `packages/device-lab/dist`. All fixed
ancestors/output roots must be physical directories. Preflight the entire bounded
set before applying ownership; refuse root-owned hardlinked regular files,
set-ID entries and unsupported types. Skip interior symlinks without modifying
them, and preserve nonroot owners, bytes and ordinary modes. Recheck captured
identity/type before applying. This local recovery is not a filesystem transaction
against adversarial concurrent changes to a checkout already executed with sudo.

The build-created physical `node_modules/@ccc` directory is a nonrecursive
exception: recover its root owner, but never traverse dependencies, change its
workspace links or repair `node_modules` itself. Source files, credentials and
missing dependencies remain outside recovery. pngjs is already declared by the
MCP workspace and lockfile; restore installed dependencies rather than adding a
duplicate declaration or externalizing the import.

Recovery failure stops before build/publication. A native failure can leave
earlier generated entries repaired; there is no inverse chown, root build fallback
or automatic retry. The parent retains existing image/publication authority and
the previous installed CLI is not replaced until the user build succeeds.

For the reported macOS source checkout, run from the repository root:

```bash
sudo npm run install:global -- --skip-image
```

This command requires the updated installer. --skip-image leaves the unchanged
root-parent Docker/Podman context out of this CLI recovery. If dependencies are
missing, restore them separately as the ordinary checkout owner with
`npm ci --ignore-scripts --no-audit --no-fund`; do not run dependency installation
with sudo. Existing dependency-parent ownership may still need separately
verified repair. Broader publication-only privilege handling remains separate.

Known ceiling: portable native-leaf identity-option tests and an actual ordinary-user bootstrap do not certify macOS credential switching, this host's ownership/dependency state, or a live global installation. Actual host recovery requires its subsequent run.

## Installed Unix CLI runtime

The Unix launcher uses POSIX `exec` with the installer's absolute Node executable
and the installed entry point. Both paths are shell-quoted, and arguments and
terminal streams are forwarded unchanged. Project-local mise/PATH Node versions
do not select CCC's runtime. Installation/postinstall rejects Node below 20.19.0
before build or publication; uninstall and importing the installer remain inert
with respect to that check. Removing the selected Node requires reinstalling CCC;
there is no fallback to a different PATH executable. See
[the runtime requirement](REQ__installed-cli-node-runtime.md).

Sudo identity inputs must be canonical decimal integers within Node child-process credential limits: UID 1..2147483647 and GID 0..2147483647. Values above the signed 32-bit maximum are rejected before dispatch.

## Installed MCP diagnostic

The MCP build emits `diagnostic.mjs` beside each selected server output. The
production admin smoke command runs that standalone bundle; it does not import
the development real-test client or a runtime TypeScript loader. Its bundled
SDK checks the canonical advertised surface and read-only current-display
aliases in an owned server child with a private home/profile and a bounded
lifetime. The comprehensive Level 0 public-dispatch suite remains a separate
verification command. See [installed diagnostic requirements](REQ__installed-mcp-diagnostic.md).

Known ceiling: this installed protocol check does not certify native providers
or replace their real-platform acceptance tests.
