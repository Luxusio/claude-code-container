# Host broker native launch boundary

The host-broker supervision application delegates process launch and private-log lifetime to its native binding. Launch results distinguish a completed dispatch attempt from a failure carrying any captured provisional runtime. Readiness, compatibility and runtime publication remain supervision decisions.

The operation retains the primary failure when compensation fails and attempts compensation once. Native child identity, log fences and successor protection remain required by [the host-broker launch contract](../device-lab/REQ__host-broker-launch.md).

The existing broker tests exercise partial dispatch, both publication races, compensation refusal and exceptions, pending token observations, and actual child output after parent descriptor closure. Build, packaged execution and platform qualification have separate execution evidence. This change does not establish full broker, native-platform or architecture completion.
