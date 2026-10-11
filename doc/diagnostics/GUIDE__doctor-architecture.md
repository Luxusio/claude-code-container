# Doctor architecture

The synchronous public `runDoctor(projectPath): boolean` in `src/doctor.ts` resolves the project context, composes the diagnostic application, renders its report, and returns the report's success. `src/application/doctor.ts` accepts a `DoctorRequest` and returns a `DoctorReport`. The domain declares semantic checks; `src/ports/doctor.ts` supplies finite observations without process receipts, filesystem capabilities or terminal publication callbacks.

The application owns check order and severity: runtime readiness, image, container, identity-scoped mise cache, active sessions, stale project locks and the launcher. An absent daemon returns only a runtime error and performs no downstream observations. Warnings allow success; errors make the report unsuccessful. Container running state is observed independently for the container check and the later launcher check, so a transition can change whether the launcher is examined.

Native composition owns project naming, runtime selection, identity/cache naming, image/container helpers, subprocess argv/options, launcher protocol parsing, lock-directory reads and terminal presentation. Version observation uses trimmed stdout even when the process status is nonzero; the application falls back to runtime-info version, and rendering supplies “unknown” when neither is available. Launcher status0 with nonempty output is ready, status2 with nonempty output is unmanaged by the updater, and other observations are missing.

Lock observation returns names from the existing directory or an empty list when absent. Unexpected filesystem, helper and subprocess exceptions propagate. The application filters old, new and profile lock names for the current project and compares their count with observed active sessions. Doctor uses the read-only session observer: it does not prune claims, remove locks or repair runtime state.

The facade owns names, prose, icons and summary output. Every rendered check and summary passes through the existing terminal control/bidi sanitizer; the header retains its deliberate surrounding newlines. Native observations carry data rather than preformatted terminal rows. Internal typed composition uses ordinary functions without getter, receiver or capture preservation machinery.

Verification separates semantic decisions and consumed negative type contracts from native command interpretation and public output/no-prune tests. The actual compiled and extracted CLI must execute its real Doctor routing and map the public boolean to exit0 or exit1. Source slicing and synthetic module-loader execution are not substitutes for that shipping check. Verification status comes from actual independent review and joined QA, not from this Guide.

## Known ceiling

Controlled tests and shipped CLI checks do not certify live runtime/auth/platform reliability or completion of the full architecture Goal. The existing missing-image hint suggests the selected runtime's `build -t ccc .` in caller cwd; its usefulness outside a source checkout remains a separate product concern. Main's home/profile prelude is separately owned.
