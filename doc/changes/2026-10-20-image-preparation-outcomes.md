# Container image preparation outcomes

Image preparation now returns a specialized semantic result. The application distinguishes development/matching images, acknowledged registry tagging, and retained local fallback. Its native composition renders failure and build guidance; the public `ensureImage(): void` entry point aborts startup for failed or unconfirmed tagging.

Previously a successful pull followed by any tag receipt, including a nonzero exit or transport error, counted as preparation success. Native classification now requires clean exit zero; definite nonzero exit is failed, and missing/malformed receipt, error or signal is indeterminate. Raw subprocess output stays outside the application and tag diagnostics. No compensating tag/delete or automatic retry is introduced. An uncertain tag may already have changed its target, so rollback is not claimed.

The [requirements](../container/REQ__image-preparation-outcomes.md) retain development/matching admission, failed-pull local fallback and the existing missing-image build hint. The existing core, type, native facade and Docker test owners cover these behaviors. The facade's emitted-module witness fences subprocess leaves before importing the shipped Docker facade and checks startup cannot proceed past failed/unconfirmed tagging.

Portable qualification is separate from native acceptance. Existing stdout-based image existence, nullable label inspection, boolean pull observation and concurrent mutable-tag races remain limitations. No native Windows/macOS or real Docker/Podman behavior, global installation or whole architecture completion is claimed by these fixtures.
