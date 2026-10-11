# Device admin Hyper-V setup

`setupHyperVHost` composes the setup application; `devicesCliAsync` admits `devices setup hyper-v` through the setup domain and retains the explicit setup hook. The application owns confirmation, finite result classification, mutation ordering and license receipt decisions. The existing facade interprets native results and renders remedies and the public `{ok,text}` result.

The facade keeps canonical PowerShell and plain-directory checks, directory creation, native command construction and execution, shared locking, and guarded receipt persistence. The confirmed application callback enables the feature and reconciles the existing typed host-fabric peer while holding the shared mutation lock. Diagnostic mode does not enable features, reconcile fabric or accept a license. Setup never reboots the host automatically. Receipt read/write failures retain their rejection behavior; failed fabric reconciliation does not publish license acceptance.

The ports declare named native leaves and an explicit asynchronous mutation lock and fabric peer. Diagnostic probing uses 30 seconds. Confirmed feature work receives 15 minutes; fabric reconciliation then receives a fresh separate 15-minute deadline under the same lock. Lock wait and stale bounds remain 10 and 20 minutes. The initial receipt read precedes mode branching, and final acceptance publication remains outside the lock failure conversion so its original rejection propagates.

Ordinary setup/network suites cover trust, budgets, fabric failure, receipt reuse/failure and manual reboot advice. Independent review and shared strict/build/runtime QA remain required; actual elevated Windows host setup is unrun on Linux.
