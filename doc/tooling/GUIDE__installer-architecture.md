# Installer architecture

`createInstallerApplication` owns global install, uninstall, source postinstall and image preparation. `scripts/install.js` is the native CLI and compatibility export adapter. The application and domain are uncompiled ESM under `scripts/install/`: source npm postinstall can load them before compilation, and both npm's file list and Unix payload copying ship the same module chain. Import and factory construction perform no install or build effects.

Required synchronous ports bind individual filesystem/path operations, source npm build, runtime availability and image labels, bounded container build receipts, supplied content fingerprint inputs, trusted User-scope PowerShell PATH I/O, output and process termination. They do not expose complete legacy workflows or a mutable native context. Content traversal and hashing stay native; the application selects the existing fingerprint input lists and content.hash/dockerfile.hash cache policy. GitHub credentials remain in the existing environment-secret mechanism.

Install builds source before modifying the previous installation. Missing runtime skips image preparation; a matching image label avoids rebuilding. Failed image preparation remains a failed image outcome while CLI installation may succeed. Uninstall uses no runtime. Packaged postinstall skips source build; source postinstall warns on a build failure without recursively installing dependencies.

Windows PATH policy reads and writes only the User value, preserving entry trimming, separator/case comparison and the 32767-character limit. It does not overwrite the merged process PATH. Unix installation refuses root or source-equal payload targets before removal, preserves symlink replacement and wrapper mode 0755, and retains permission-denied exit behavior. Copy and publication failures keep actual partial effects; no transaction or rollback is added. The existing native install-directory leaf remains the owned subprocess fixture's redirection boundary.

Ordinary core/type tests exercise policy and required synchronous capabilities; the existing private installer subprocess tests exercise real source and installed modules with owned destinations. Strict compilation must consume the native adapter and actual applications. Packaging, build and runtime acceptance belong to independent QA. No live global installation, Windows PATH modification or external container runtime certification is claimed by source inspection.


## Source builds invoked through sudo
On POSIX hosts, a source build invoked by root through sudo validates the complete numeric invoking UID/GID, then runs npm build in a child with that identity. Inside the child, HOME comes from that actual OS account after removing inherited root HOME. Inherited npm cache/userconfig overrides, including case variants, are removed so npm reads the invoking user's settings. Failed validation, account lookup or build never falls back to a root build or proceeds to installation. Ordinary-user, Windows and direct-root-without-sudo behavior is unchanged. The synchronous sourceBuild capability and import/factory inertness remain intact.

This changes source-build ownership only. The parent retains existing image and publication authority; this is not an internal publication-elevation workflow. Existing owners and missing dependencies are not repaired automatically. pngjs is already declared by the MCP workspace and lockfile. Restore workspace dependencies rather than externalizing it or adding a duplicate root dependency.

For the reported macOS source checkout, run from the repository root:

```bash
for p in node_modules dist packages/hyper-v/dist packages/device-lab/dist; do
  if [ -e "$p" ]; then
    sudo find "$p" -user root -exec chown -h "$(id -u):$(id -g)" {} +
  fi
done
npm ci --ignore-scripts --no-audit --no-fund
sudo npm run install:global -- --skip-image
```

The final command requires the updated installer. --skip-image leaves the unchanged root-parent Docker/Podman context out of this recovery. Dependency installation must not use sudo. Broader publication-only privilege handling remains separate work.

Known ceiling: portable native-leaf identity-option tests and an actual ordinary-user bootstrap do not certify macOS credential switching, this host's ownership/dependency state, or a live global installation. Actual host recovery requires its subsequent run.

Sudo identity inputs must be canonical decimal integers within Node child-process credential limits: UID 1..2147483647 and GID 0..2147483647. Values above the signed 32-bit maximum are rejected before dispatch.
