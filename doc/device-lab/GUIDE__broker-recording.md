# Broker recording

Authenticated `broker.device.tool.invoke` routes recording start, stop, and status through one broker recording application. The application owns support decisions, runtime metadata, publication conflicts and finalization. It returns semantic observations, started/stopped facts, refusals and partial effects; the native broker converter supplies the existing public responses. Required native leaves separately launch Android/iOS recording, stop Android recording, pull its artifact and remove its remote file. Process recipes, private output paths, process identity, signaling and atomic state mutation remain native. Device operation locks remain in the broker binding.

Broker-managed recording uses Android screenrecord or an owned iOS simulator. Android defaults to 180 seconds. Windows Sandbox and macOS recording continue through their existing backend guest-helper routes; physical iOS recording remains unsupported through this broker path. Recording does not start a device or create an Appium session.

Status does not execute a provider command. It retains recording metadata when process identity is current or unavailable. An observed stale runtime can be cleared only if publication still matches the captured generation; a successor survives.

Start validates the supported target and physical lease before launching. Successful launch records the actual PID and identity. If publication loses a generation race, compensation signals only that newly launched owned runtime and reports the actual rollback outcome.

Stop preserves active metadata when signaling fails or exit remains uncertain. Android finalization interrupts screenrecord, copies its remote artifact, and attempts remote cleanup using bounded native commands. After confirmed exit, generation-checked clearing may succeed even when artifact copying fails; that partial result reports a stopped recording with a copy error. No new retry or rollback policy is introduced.

Ordinary application and consumed type tests cover policy failures; existing authenticated command, process, file, and lease fixtures cover native bindings. Real ADB and iOS recording require an available host and device. Static author checks are not runtime acceptance; independent review and coordinated QA precede delivery.
