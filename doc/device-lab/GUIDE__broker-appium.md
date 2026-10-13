# Broker Appium workflows

The broker Appium application owns server start and stop, session ensure and delete, bounded WebDriver requests, and metadata record and clear. All seven authenticated RPC routes use the same application. Status, listing, owner registration, physical leases, and device cleanup remain separate peers.

The application validates requests and selects the operation lock before effects. Request deadlines begin after the owner RPC queue and cover device-lock waiting, physical-lease heartbeat, and HTTP work. Only session ensure, session delete, and WebDriver requests refresh physical leases. Server and metadata operations keep their own admission rules.

Runtime provisioning and reuse are application policy: validate the shipped manifests, compare the runtime marker and entry, serialize installation, run the bounded npm command, and publish the marker only after successful validation. Native ports retain guarded paths, file bounds, atomic writes, executable discovery, command execution, process identity, listener ownership, and HTTP transport. Importing or constructing the application performs no installation or provider work.

Required native effects use a captured runtime capability for launch, synchronous installation and individual manifest/marker operations. Appium protocol work uses five finite ports: status, inspectSession, createSession, deleteSession, and sessionCommand. Each returns ok and an opaque receipt; status also returns ready, and creation returns sessionId and instrumentationInitializationFailed. The native adapter owns HTTP methods, route suffixes, session-ID encoding, GET body omission, the W3C alwaysMatch envelope, and response interpretation. The application reads semantic facts only.

Instrumentation reset has five fixed effects; its loop and existing one-session retry remain application policy. The core does not construct executables, argv, environment or working-directory recipes, and no native callback owns a complete provisioning workflow.

Each operation returns its specific server, session, request or metadata outcome and relevant refusal/partial-effect facts. WebDriver HTTP status and body remain genuine upstream protocol evidence in native receipts, opaque to the application. The native broker converter unwraps response, readiness, rollback, status and session observations independently from process-termination evidence, then maps these facts to existing CCC HTTP codes and envelopes, preserving safe diagnostics and error precedence.

A recorded URL or PID does not establish managed authority. Native verification requires the existing broker provenance, launch policy, process generation, listener, and loopback endpoint checks. Publication compares the captured Appium generation under the owner-state mutation lock. A successor remains intact on conflict; compensation targets only a newly launched owned process or the exact newly created session.

Existing-session reuse requires successful status and session inspection and remains allowed when ready is false. New-session polling rejects only literal false; absent or null upstream readiness retains compatibility. The native adapter chooses a nested string value.sessionId before a top-level string sessionId; an empty chosen ID keeps the existing missing-ID refusal.

Session deletion without a session is a no-op. Failed deletion preserves session metadata, and successful deletion retains managed server fields. Record and clear refuse replacement of a live managed runtime. HTTP requests retain their allowlist, body and response limits, redirect refusal, and deadline behavior.

Verification uses ordinary application ports and the existing authenticated broker, HTTP, install, lease, and process fixtures. Controlled fixtures prove policy and native admission behavior; they do not certify a live Appium installation or a real connected device. Fresh strict compilation, affected tests, build, and package checks are coordinated separately before delivery.
