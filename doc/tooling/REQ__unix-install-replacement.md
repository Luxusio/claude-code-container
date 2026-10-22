# Unix installation replacement

These engineering requirements derive from M13's installed-distribution parity
and the user's request to prevent reported installation failures. They are not
new user requirements for a transaction framework or changed storage layout.

- Prepare the complete replacement payload and executable launcher before
  changing the previous `ccc-dist` or `ccc`, including a legacy symlink launcher.
- A caught preparation failure leaves the previous installation runnable.
  A caught publication failure restores the previous installation when native
  restoration succeeds. Never report an installation success for these failures.
- Unix install publication, public payload materialization and uninstall share
  one cooperative exclusive destination guard. An existing guard causes a prompt
  refusal without removing it. Source/image builds are outside this guard.
- Refuse unsafe destination types and lexical/canonical overlap with each fixed
  copied input root and the consumed package manifest before staging.
  Rollback moves only this operation's published payload back into its private
  staging area; it does not recursively delete a live destination.
- If restoration fails, preserve the previous payload in its recovery directory
  and report that directory together with the publication and restoration errors.
- Keep the public payload export, `ccc-dist` path, pinned Node launcher,
  executable mode, literal argument forwarding and Windows installation behavior.
- Direct invocation through a symlinked entry or ancestor must dispatch the installer when Node has resolved the same actual module. Comparing only lexical argument spelling with the canonical module URL must not silently return success without executing. Importing the module, including with unrelated or unavailable process arguments, must not dispatch installation.

Private native subprocess tests must show that old CLI execution survives
copy/package/launcher preparation and publication failures. Also exercise the
legacy symlink, guard contention and failed-restoration backup preservation.

## Known ceiling

This contract covers caught synchronous failures and cooperating installers.
It does not promise an atomic two-path switch, uninterrupted concurrent CLI
startup, process/power-loss recovery, automatic stale-guard reclamation or
protection against hostile writers to the privileged installation directory.
Native macOS sudo recovery and a live global installation need separate evidence.
Input separation checks cover the declared roots; they do not traverse arbitrary
interior symlink target graphs in a trusted build checkout.
