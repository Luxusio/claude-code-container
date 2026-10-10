# Container command execution

`src/application/container-exec.ts` owns the complete command session: acquire ownership before starting a container, select guarded replacement, coordinate setup, prepare the selected tool and environment, launch the command, and dispose its owned environment artifact and session. It returns a status. The private `exec` wrapper in `src/index.ts` binds the application and exits with that status for all existing CLI dispatch routes.

`src/ports/container-exec.ts` names the required observations, native effects and existing operation delegates. Lifecycle, setup, family and Codex configuration locks remain separate. The application keeps the final pinned container ID after a setup restart and uses it for clipboard shims, socket access, preparation and command execution. Reused containers skip heavy installation but still regenerate MCP configuration and pass final readiness checks.

`src/composition/container-exec.ts` binds existing container, session, worktree, clipboard, Codex and command authorities. The CLI supplies its asset directory and trusted CLI filename, along with the existing directory and project-tool preparation helpers. Composition does not import the CLI. Native ownership, process, file and container identity guards remain in their existing modules.

Early startup failures continue through `runCli` cleanup. Once the application creates an owned environment file, command completion or failure restores Codex access under its lock, disposes that artifact and cleans up the session. A denied Codex preparation returns its failure status without launching the user command. Optional cleanup diagnostics do not replace the command outcome.

Current tests cover these outcomes with ordinary fake ports and public CLI/native regressions. There are no archived implementation oracles, VM membranes or getter-order requirements. Fixture success does not certify live Docker/Podman interaction or native macOS/Windows hosts; those require actual host runs.
