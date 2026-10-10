# Android control and transfer

Both Android adapters compose `createAndroidControlTransfer`. The shared application owns the selected tap, double tap, long press, swipe, drag, text, key, navigation and upload/download workflows. The domain builds action arguments and result data, preserving current defaults and the different emulator versus physical navigation payloads. The application refuses a failed first tap before issuing the second, and reports transfer success only after the required native steps succeed.

Required typed ports expose target observation, target-bound ADB execution, bounded transfer commands, guest-path validation and owned local stage allocation/commit/disposal. The adapters retain current owner and physical-lease guards, serial binding, command profiles and guarded file authority. Output stages are committed through the existing atomic publication helper and disposed in finally on command or commit failure. The existing response presenters retain bounded diagnostics. Construction starts no provider.

Common DeviceRequest aliases and authenticated broker backend-child routing reach these same adapters. Lifecycle, observation, wireless, recording, waits, screenshots and other Android settings remain separate peers. This Android cohort does not complete the corresponding operations across other providers or Appium bindings.

Current ordinary core/type and public emulator/physical suites are the verification surfaces. Independent review and shared strict/build/runtime QA are required before delivery. Static development alone does not prove runtime behavior; actual host/device ADB certification remains unrun unless separately authorized.
