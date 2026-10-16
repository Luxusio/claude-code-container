# macOS recorder settlement before image and snapshot mutation

Force clone, snapshot create and snapshot restore must settle the captured recording before cloning an owned source or deleting/replacing its primary instance. A VM already recorded as stopped still requires this check when recording metadata remains. Resuming a prepared or activated restore candidate must not bypass recorder settlement or replay an already completed preparation.

Use the existing lifecycle recorder policy within the current lifecycle claim. A refused signal without proven prior exit, an unconfirmed captured process exit, or an observation exception must preserve recording and restore-recovery evidence and prevent subsequent clone/primary deletion. A provider stop already completed remains a truthful partial stopped state; a failed stop does not fabricate that partial state. Return the existing cleanup-incomplete failure or exact observation exception as appropriate.

After waiting, qualify the unchanged current lifecycle claim and exact captured recording generation before clearing recording metadata or continuing provider effects. A replacement lifecycle or recorder is a conflict; preserve successor metadata and existing restore candidates. Failure to publish a guarded abort cannot be reported as successful cleanup.

A confirmed captured recorder exit permits the existing image/snapshot flow to proceed. Native exit waiting uses the recorded process identity rather than PID absence alone. Guest interruption, the existing one-second exit allowance, ordinary clone rollback, candidate activation recovery, public redaction and existing native owner/source locks remain in their established owners. No second lifecycle lock or generic recorder service is introduced.

Verification uses the existing lifecycle core/type tests and public fake-provider macOS/recorder-rollback tests for no recorder, confirmed exit, signal refusal, false/unavailable exit, successor replacement and partial provider stop, including already-stopped and resumed restore cases. These portable and emitted witnesses do not establish actual macOS/Tart provider acceptance.
