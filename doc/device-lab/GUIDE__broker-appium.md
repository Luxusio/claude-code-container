# Broker Appium workflows

The broker Appium application owns server start and stop, session ensure and delete, bounded WebDriver requests, and metadata record and clear. All seven authenticated RPC routes use the same application. Status, listing, owner registration, physical leases, and device cleanup remain separate peers.

The application validates requests and selects the operation lock before effects. Request deadlines begin after the owner RPC queue and cover device-lock waiting, physical-lease heartbeat, and HTTP work. Only session ensure, session delete, and WebDriver requests refresh physical leases. Server and metadata operations keep their own admission rules.

Runtime provisioning and reuse are application policy: validate the shipped manifests, compare the runtime marker and entry, serialize installation, run the bounded npm command, and publish the marker only after successful validation. Native ports retain guarded paths, file bounds, atomic writes, executable discovery, command execution, process identity, listener ownership, and HTTP transport. Importing or constructing the application performs no installation or provider work.

A recorded URL or PID does not establish managed authority. Native verification requires the existing broker provenance, launch policy, process generation, listener, and loopback endpoint checks. Publication compares the captured Appium generation under the owner-state mutation lock. A successor remains intact on conflict; compensation targets only a newly launched owned process or the exact newly created session.

Session deletion without a session is a no-op. Failed deletion preserves session metadata, and successful deletion retains managed server fields. Record and clear refuse replacement of a live managed runtime. HTTP requests retain their allowlist, body and response limits, redirect refusal, and deadline behavior.

Verification uses ordinary application ports and the existing authenticated broker, HTTP, install, lease, and process fixtures. Controlled fixtures prove policy and native admission behavior; they do not certify a live Appium installation or a real connected device. Fresh strict compilation, affected tests, build, and package checks are coordinated separately before delivery.
