import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { spawn, spawnSync } from "child_process";
import { accessSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { homedir, hostname, uptime } from "os";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { isDeepStrictEqual } from "util";
import { Worker } from "worker_threads";
import { androidAvdHome, listOwnedAndroidAvdArtifacts, ownedAndroidAvdName, removeOwnedAndroidAvdArtifacts } from "../device-lab-mcp/src/state/android-avd-storage.mjs";
import { deviceLabOwnerFromProjectMountPath, deviceLabOwnerId as canonicalDeviceLabOwnerId, deviceLabProjectMountPath } from "./device-lab-owner.js";
import { assertOwnerDeviceStateWritable, ownerDeviceStateErrorCode, readOwnerDeviceStateFile } from "./device-lab-owner-state.js";
import { readPhysicalLeaseStateFile, readWindowsSandboxLockStateFile, validatePhysicalLease, validateWindowsSandboxLock } from "./device-lab-ownership-state.js";
import { deviceLabProjectEnumerationErrorCode, enumerateDeviceProjectIds } from "./device-lab-project-state.js";
import { assertDeviceLabPathWithinRoot, deviceLabStateFileErrorCode, readDeviceLabBinaryFile, readDeviceLabBinaryFileWithinRoot, readDeviceLabStateFile, readDeviceLabTextFile, withDeviceLabReadableFile, writeDeviceLabBinaryFile } from "./device-lab-state-file.js";
import { deviceRuntimeProcessIdentityMatches, inspectDeviceRuntimeProcessIdentity, probeDeviceRuntimeProcessLiveness, readDeviceRuntimeProcessIdentity, readDeviceRuntimeProcessStartToken, signalDeviceRuntimeProcess, type DeviceRuntimeProcessIdentity } from "./device-lab-process-identity.js";
import { withSharedMutationLock, withSharedMutationLockAsync, writeFileAtomically, writeJsonFileAtomically } from "./device-lab-shared-state.js";
import { canonicalWindowsPowerShellPath, canonicalWindowsSystemExecutablePath, hiddenWindowsPowerShellArgs, terminateWindowsProcessByStartToken, windowsHandleBoundTerminationScript } from "./windows-system-powershell.js";
import { assertHyperVOperationDeadline, HyperVOperationDeadlineError, hyperVOperationDeadlineExpired, hyperVRemainingTimeout } from "./device-lab/broker/hyper-v/deadline.js";
import {
    assertNoSymlinkPathComponents,
    hyperVImageProfile,
    hyperVImageRoot as hyperVImageStoreRoot,
    readHyperVImageManifestMetadata as readHyperVImageManifestMetadataFromStore,
    resolveHyperVImageForCreate as resolveHyperVImageForCreateFromStore,
    type HyperVImageProfile,
} from "./device-lab/broker/hyper-v/image-store.js";
import {
    adoptHyperVLinuxSshHostIdentity as adoptHyperVLinuxSshHostIdentityWithRuntime,
    cachedHyperVOwnerDevicesReader,
    ensureHyperVNetworkAllocation as ensureHyperVNetworkAllocationWithRuntime,
    hyperVNetworkAllocationReferenced,
    reconcileHyperVLinuxSshHostIdentity as reconcileHyperVLinuxSshHostIdentityWithRuntime,
    releaseHyperVNetworkAllocationAndCleanup as releaseHyperVNetworkAllocationAndCleanupWithRuntime,
    validateHyperVLinuxSshHostIdentity as validateHyperVLinuxSshHostIdentityWithRuntime,
    type HyperVNetworkRuntime,
    type HyperVNetworkStateRuntime,
} from "./device-lab/broker/hyper-v/network.js";
import {
    clearHyperVOperationJournal as clearHyperVOperationJournalFile,
    clearHyperVSnapshotJournal,
    hyperVOperationJournalPath as hyperVOperationJournalFilePath,
    hyperVSnapshotJournalPath as hyperVSnapshotJournalFilePath,
    readHyperVOperationJournal as readHyperVOperationJournalFile,
    readHyperVSnapshotJournal as readHyperVSnapshotJournalFile,
    writeHyperVOperationJournal as writeHyperVOperationJournalFile,
    writeHyperVSnapshotJournal as writeHyperVSnapshotJournalFile,
    type HyperVJournalPersistenceRuntime,
    type HyperVOperationJournal,
    type HyperVSnapshotJournal,
} from "./device-lab/broker/hyper-v/operation-journal.js";
import { hyperVBoundedErrorCode, hyperVProviderDiagnosticCode, publicHyperVArtifactCleanup, publicHyperVCreateConfiguration, publicHyperVNetworkCleanup, redactHyperVDeviceSecrets, redactHyperVResultSecrets, redactProviderCommandInput } from "./device-lab/broker/hyper-v/public-response.js";
export { redactProviderCommandInput } from "./device-lab/broker/hyper-v/public-response.js";
import { assertHyperVPrivateDeviceRoot, cleanupHyperVDeviceArtifacts, ensureHyperVPrivateDeviceRoot, hyperVDeviceIncarnationId, hyperVDeviceRoot, hyperVPrivateDeviceRoot, readHyperVIncarnationRecord, validHyperVIncarnationId, writeHyperVIncarnationRecord } from "./device-lab/broker/hyper-v/state.js";
import { HYPER_V_PROVIDER_IMAGE_FINALIZATION_CONTRACT, hyperVBootstrapNetworkCleanupCommand, hyperVBootstrapNetworkCommand, hyperVCreateCommand, hyperVDeleteCommand, hyperVGuestBootDiagnosticCommand, hyperVGuestDownloadCommand, hyperVGuestExecCommand, hyperVGuestProvisionCommand, hyperVGuestReadyCommand, hyperVGuestUploadCommand, hyperVLinuxNetworkFinalizeCommand, hyperVLinuxScpUploadCommand, hyperVLinuxSeedCommand, hyperVLinuxSshExecCommand, hyperVLinuxSshReadyCommand, hyperVReadinessCommand, hyperVRebootCommand, hyperVRecoverOrphanCommand, hyperVSnapshotCreateCommand, hyperVSnapshotDeleteCommand, hyperVSnapshotName, hyperVSnapshotRestoreCommand, hyperVStartCommand, hyperVStatusCommand, hyperVStopCommand, hyperVVmName, parseHyperVBootstrapNetworkCleanupObservation, parseHyperVBootstrapNetworkObservation, parseHyperVDeleteObservation, parseHyperVGuestBootDiagnosticObservation, parseHyperVGuestExecObservation, parseHyperVGuestProvisionObservation, parseHyperVGuestReadyFailureObservation, parseHyperVGuestReadyObservation, parseHyperVGuestTransferObservation, parseHyperVReadiness, parseHyperVRecoveryObservation, parseHyperVSnapshotDeleteObservation, parseHyperVSnapshotObservation, parseHyperVVmObservation } from "./host-control/hyper-v/index.js";
import { iosSimulatorCreateCommand, iosSimulatorCreatedUdid, iosSimulatorDeleteCommand } from "./device-lab/providers/ios-simulator.js";
import { CLI_VERSION } from "./utils.js";

export const DEVICE_BROKER_DEFAULT_HOST = "127.0.0.1";
export const DEVICE_BROKER_DEFAULT_PORT = 17373;
export const DEVICE_BROKER_NAME = "ccc-device-broker";
export const DEVICE_BROKER_RPC_BODY_LIMIT = 64 * 1024;
export const DEVICE_BROKER_REQUEST_BODY_TIMEOUT_MS = 5000;
export const DEVICE_BROKER_ERROR_RESPONSE_LIMIT = 256 * 1024;
export const DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const DEVICE_BROKER_RPC_RESPONSE_LIMIT_BYTES = 64 * 1024 * 1024;
const DEVICE_BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES = 32 * 1024;
export const DEVICE_BROKER_INVENTORY_FILE_LIMIT = 256 * 1024;
export const DEVICE_BROKER_INVENTORY_DEVICE_LIMIT = 200;
export const DEVICE_BROKER_PHYSICAL_LEASE_DIRECTORY_ENTRY_LIMIT = 1024;
export const DEVICE_BROKER_AUTH_DIRECTORY_ENTRY_LIMIT = 1024;
export const DEVICE_BROKER_COMMAND_TIMEOUT_MS = 5000;
export const DEVICE_BROKER_ANDROID_INVENTORY_TIMEOUT_MS = 15000;
const DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS = 30000;
const DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_BUFFER_MS = 15000;
export const DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS = 300000;
export const DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS = 600000;
export const DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS = 10 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS = 20 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS = 5 * 60 * 1000;

export function hyperVLinuxGuestSignalDeadlineAt(startedAt: number): number {
    return startedAt + DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS;
}

export function hyperVLinuxGuestSignalTimedOut(startedAt: number, observedAt: number, guestSignalObserved: boolean): boolean {
    return !guestSignalObserved && observedAt >= hyperVLinuxGuestSignalDeadlineAt(startedAt);
}
export const DEVICE_BROKER_HYPER_V_IMAGE_PREPARE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_IMAGE_LOCK_WAIT_MS = DEVICE_BROKER_HYPER_V_IMAGE_PREPARE_TIMEOUT_MS + 15000;
export const DEVICE_BROKER_HYPER_V_IMAGE_ACQUIRE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS = 5 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_CREATE_POST_ACQUIRE_BUDGET_MS = 80 * 60 * 1000 - 15000;
export const DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS = DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS
    + DEVICE_BROKER_HYPER_V_IMAGE_LOCK_WAIT_MS
    + DEVICE_BROKER_HYPER_V_IMAGE_ACQUIRE_TIMEOUT_MS
    + DEVICE_BROKER_HYPER_V_CREATE_POST_ACQUIRE_BUDGET_MS;
export const DEVICE_BROKER_MAX_RPC_TIMEOUT_MS = DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS + 15000;
export const DEVICE_BROKER_HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS = 2 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_LIFECYCLE_TIMEOUT_MS = DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS
    + DEVICE_BROKER_HYPER_V_PROVIDER_LIFECYCLE_TIMEOUT_MS;

export function hyperVProviderDeadlineAt(
    backend: string,
    command: string,
    cleanupDeadlineAt: number,
): number {
    const needsCleanupReserve = command === "device_create"
        || (backend === "linux-vm" && (command === "device_start" || command === "device_reboot"));
    return needsCleanupReserve && Number.isFinite(cleanupDeadlineAt)
        ? cleanupDeadlineAt - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS
        : cleanupDeadlineAt;
}

export function hyperVLifecycleCleanupTimeoutMs(
    backend: string,
    command: string,
    operationTimeoutMs: number,
): number {
    return operationTimeoutMs + (backend === "linux-vm"
        && (command === "device_start" || command === "device_reboot")
        ? DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS
        : 0);
}

function hyperVLifecycleOperationTimeoutMs(parsed: CommandParamSuccess): number {
    if ((parsed.command !== "device_start" && parsed.command !== "device_reboot") || parsed.waitForBoot === false) {
        return DEVICE_BROKER_HYPER_V_LIFECYCLE_TIMEOUT_MS;
    }
    const bootTimeoutMs = Number.isFinite(parsed.bootTimeoutMs)
        ? Math.min(DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS, Math.max(1000, Number(parsed.bootTimeoutMs)))
        : 5 * 60 * 1000;
    return DEVICE_BROKER_HYPER_V_LIFECYCLE_TIMEOUT_MS + bootTimeoutMs;
}
const DEVICE_BROKER_BOUNDED_WAIT_TOOLS = new Set(["mobile_wait_for_text", "mobile_wait_for_app"]);
const DEVICE_BROKER_APPIUM_READY_TIMEOUT_MS = 60000;
const DEVICE_BROKER_APPIUM_SESSION_TIMEOUT_MS = 240000;
const DEVICE_BROKER_APPIUM_FETCH_MAX_TIMEOUT_MS = 300000;
const DEVICE_BROKER_APPIUM_REQUEST_TIMEOUT_MS = 30000;
export const DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const DEVICE_BROKER_APPIUM_INSTALL_TIMEOUT_MS = 300000;
const DEVICE_BROKER_APPIUM_INSTALL_LOCK_WAIT_MS = DEVICE_BROKER_APPIUM_INSTALL_TIMEOUT_MS + 15000;
const DEVICE_BROKER_APPIUM_INSTALL_LOCK_STALE_MS = 15 * 60 * 1000;
const DEVICE_BROKER_APPIUM_LAUNCH_POLICY = "node-direct-hidden-v1";
const DEVICE_BROKER_APPIUM_PORT_SCAN_LIMIT = 128;
const DEVICE_BROKER_APPIUM_AUTO_PORT_MIN = 20000;
const DEVICE_BROKER_APPIUM_AUTO_PORT_MAX = 39999;
export const DEVICE_BROKER_COMMAND_OUTPUT_LIMIT = 32 * 1024;
export const DEVICE_BROKER_AUTO_START_TIMEOUT_MS = 30000;
const DEVICE_BROKER_STARTUP_ATTEMPT_HISTORY_LIMIT = 8;
const DEVICE_BROKER_WINDOWS_SANDBOX_REGISTRATION_TIMEOUT_MS = 60000;
const DEVICE_BROKER_WINDOWS_SANDBOX_LIST_TIMEOUT_MS = 10000;
const DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS = 180000;
const DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_CONFIRM_TIMEOUT_MS = 30000;
const DEVICE_BROKER_MACOS_PROVIDER_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const DEVICE_BROKER_CAPABILITY_HOST_BACKEND_READINESS = "http-host-backend-readiness-api";
const DEVICE_BROKER_CAPABILITY_LIFECYCLE_DEVICE_CREATE = "http-lifecycle-device-create-command";
const DEVICE_BROKER_CAPABILITY_DESKTOP_DEVICE_TOOL_PROXY = "http-desktop-device-tool-proxy";
const DEVICE_BROKER_CAPABILITY_DESKTOP_DEVICE_TOOL_TIMEOUTS = "http-desktop-device-tool-timeouts";
const DEVICE_BROKER_CAPABILITY_WINDOWS_SANDBOX_HELPER_CONFIG = "http-windows-sandbox-helper-config";
const DEVICE_BROKER_CAPABILITY_ANDROID_DEVICE_TOOL_PROXY = "http-android-device-tool-proxy";
const DEVICE_BROKER_CAPABILITY_VERSION_REPORTING = "http-broker-version-reporting";
const DEVICE_BROKER_CAPABILITY_HIDDEN_PROVIDER_CHILDREN = "windows-hidden-provider-children-v7";
const DEVICE_BROKER_CAPABILITY_WINDOWS_SANDBOX_WINDOW_MINIMIZE = "windows-sandbox-window-minimize-v4";
const DEVICE_BROKER_CAPABILITY_WINDOWS_SANDBOX_RUNTIME_OWNERSHIP = "windows-sandbox-runtime-snapshot-ownership-v1";
const DEVICE_BROKER_CAPABILITY_APPIUM3_NPM_RUNTIME = "appium3-scoped-security-npm-cwd-v1";
const DEVICE_BROKER_CAPABILITY_EXISTING_OWNER_AUTH = "constant-time-existing-owner-auth-v1";
const DEVICE_BROKER_CAPABILITY_ATOMIC_OWNER_AUTH = "atomic-owner-secret-provisioning-v1";
const DEVICE_BROKER_CAPABILITY_OWNER_MUTATION_SERIALIZATION = "owner-mutation-serialization-v1";
const DEVICE_BROKER_CAPABILITY_ATOMIC_OWNER_DEVICE_STATE = "atomic-owner-device-state-v1";
const DEVICE_BROKER_CAPABILITY_CROSS_PROCESS_OWNER_STATE = "cross-process-owner-state-serialization-v1";
const DEVICE_BROKER_CAPABILITY_OWNER_DEVICE_IDENTITY_FENCING = "owner-device-identity-fencing-v1";
const DEVICE_BROKER_CAPABILITY_RPC_FAULT_CONTAINMENT = "rpc-fault-containment-v1";
const DEVICE_BROKER_CAPABILITY_SHARED_LEASE_SERIALIZATION = "cross-owner-physical-lease-serialization-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_LEASE_OPERATION_FENCING = "physical-lease-operation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_LIFECYCLE_LEASE_FENCING = "physical-lifecycle-lease-fencing-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_OPERATION_SERIALIZATION = "physical-attach-detach-operation-serialization-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_DETACH_RUNTIME_CLEANUP = "physical-detach-runtime-cleanup-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_RUNTIME_CLEANUP_LEASE_FENCING = "physical-runtime-cleanup-lease-fencing-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_LEASE_STATE_WRITE_ROLLBACK = "physical-lease-state-write-rollback-v1";
const DEVICE_BROKER_CAPABILITY_RUNTIME_CLEANUP_FAILURE_PRESERVATION = "runtime-cleanup-failure-preservation-v1";
const DEVICE_BROKER_CAPABILITY_APPIUM_RUNTIME_GENERATION_FENCING = "appium-runtime-generation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_WINDOWS_SINGLETON_FENCING = "windows-sandbox-singleton-fencing-v1";
const DEVICE_BROKER_CAPABILITY_DEVICE_OPERATION_SERIALIZATION = "cross-process-device-operation-serialization-v1";
const DEVICE_BROKER_CAPABILITY_DEVICE_RUNTIME_SERIALIZATION = "cross-process-device-runtime-serialization-v1";
const DEVICE_BROKER_CAPABILITY_DIRECT_RECORDING_GENERATION_FENCING = "direct-recording-generation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_DIRECT_APPIUM_GENERATION_FENCING = "direct-appium-generation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_FINITE_DEVICE_OPERATION_SERIALIZATION = "finite-device-operation-serialization-v1";
const DEVICE_BROKER_CAPABILITY_DIRECT_RUNTIME_PROCESS_IDENTITY = "direct-runtime-process-identity-v1";
const DEVICE_BROKER_CAPABILITY_HOST_RECORDING_PROCESS_IDENTITY = "host-recording-process-identity-v1";
const DEVICE_BROKER_CAPABILITY_RUNTIME_PROCESS_OBSERVATION = "runtime-process-observation-v1";
const DEVICE_BROKER_CAPABILITY_HOST_APPIUM_PROCESS_IDENTITY = "host-appium-process-identity-v1";
const DEVICE_BROKER_CAPABILITY_APPIUM_PORT_PROCESS_IDENTITY = "appium-port-process-identity-fencing-v1";
const DEVICE_BROKER_CAPABILITY_BROKER_OWNED_OWNER_AUTH = "broker-owned-owner-secret-provisioning-v1";
const DEVICE_BROKER_CAPABILITY_PORT_PROCESS_IDENTITY = "host-broker-port-process-identity-v1";
const DEVICE_BROKER_CAPABILITY_PROCESS_START_TOKEN = "host-broker-process-start-token-v1";
const DEVICE_BROKER_CAPABILITY_OWNER_GENERATION_HMAC_AUTH = "owner-generation-hmac-auth-v1";
const DEVICE_BROKER_CAPABILITY_DIRECT_APPIUM_PROCESS_IDENTITY = "direct-appium-process-identity-v1";
const DEVICE_BROKER_CAPABILITY_OWNER_DEVICE_STATE_VALIDATION = "owner-device-state-validation-v1";
const DEVICE_BROKER_CAPABILITY_OWNERSHIP_STATE_VALIDATION = "shared-device-ownership-state-validation-v1";
const DEVICE_BROKER_CAPABILITY_ANDROID_PORT_ALLOCATION_FENCING = "android-emulator-port-allocation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_BOUNDED_ERROR_RESPONSES = "bounded-error-responses-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_LEASE_DIRECTORY_FENCING = "physical-lease-directory-fencing-v1";
const DEVICE_BROKER_CAPABILITY_OWNER_AUTH_DIRECTORY_FENCING = "owner-auth-directory-fencing-v1";
const DEVICE_BROKER_CAPABILITY_APPIUM_RUNTIME_INSTALLATION_FENCING = "appium-runtime-installation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_APPIUM_HTTP_TRANSPORT_FENCING = "bounded-no-redirect-appium-http-transport-v1";
const DEVICE_BROKER_CAPABILITY_WINDOWS_PROVIDER_LAUNCHER_FENCING = "windows-provider-launcher-path-fencing-v1";
const DEVICE_BROKER_CAPABILITY_CANONICAL_OWNER_DEVICE_IDS = "canonical-owner-device-ids-v1";
const DEVICE_BROKER_CAPABILITY_IOS_SIMULATOR_OWNER_IDENTITY_FENCING = "ios-simulator-owner-identity-fencing-v1";
const DEVICE_BROKER_CAPABILITY_IOS_SIMULATOR_PROVIDER_CREATE = "ios-simulator-provider-create-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_APPIUM_LEASE_FENCING = "physical-appium-lease-fencing-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_DEVICE_TOOL_LEASE_FENCING = "physical-device-tool-lease-fencing-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_LIFECYCLE_USE_LEASE_REFRESH = "physical-lifecycle-use-lease-refresh-v1";
const DEVICE_BROKER_CAPABILITY_APPIUM_LIVE_RUNTIME_METADATA_FENCING = "appium-live-runtime-metadata-fencing-v1";
const DEVICE_BROKER_CAPABILITY_DIRECT_ANDROID_LIFECYCLE_GENERATION_FENCING = "direct-android-lifecycle-generation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_DIRECT_IOS_LIFECYCLE_GENERATION_FENCING = "direct-ios-lifecycle-generation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_DIRECT_WINDOWS_LIFECYCLE_GENERATION_FENCING = "direct-windows-lifecycle-generation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_DIRECT_MACOS_LIFECYCLE_GENERATION_FENCING = "direct-macos-lifecycle-generation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_DIRECT_MACOS_SNAPSHOT_CLONE_GENERATION_FENCING = "direct-macos-snapshot-clone-generation-fencing-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_DIRECT_STATE_TRANSITION_FENCING = "physical-direct-state-transition-fencing-v1";
const DEVICE_BROKER_CAPABILITY_MULTI_PROJECT_OWNER_RESOLVE = "multi-project-owner-resolve-v1";
const DEVICE_BROKER_CAPABILITY_STOPPED_ANDROID_STATUS_OBSERVATION = "stopped-android-status-observation-v1";
const DEVICE_BROKER_CAPABILITY_STOPPED_ANDROID_BOOT_METADATA = "stopped-android-boot-metadata-v1";
const DEVICE_BROKER_CAPABILITY_WINDOWS_BEST_EFFORT_MINIMIZE = "windows-sandbox-best-effort-minimize-v1";
const DEVICE_BROKER_CAPABILITY_GUEST_HELPER_RECORDING_PROXY = "guest-helper-recording-proxy-v1";
const DEVICE_BROKER_CAPABILITY_PHYSICAL_UNATTACHED_WIRELESS = "physical-unattached-wireless-routing-v1";
const DEVICE_BROKER_CAPABILITY_ANDROID_RECORDING_SIGNAL_FALLBACK = "android-recording-signal-fallback-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_LIFECYCLE = "hyper-v-vm-managed-auto-images-v20";
const DEVICE_BROKER_CAPABILITY_HYPER_V_SETUP_NETWORK = "hyper-v-setup-network-v10";
const DEVICE_BROKER_CAPABILITY_HYPER_V_GUEST_READINESS_DIAGNOSTICS = "hyper-v-guest-readiness-diagnostics-v15";
const DEVICE_BROKER_CAPABILITY_HYPER_V_AZURE_BOOTSTRAP_DHCP = "hyper-v-azure-bootstrap-dhcp-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_BOOTSTRAP_NIC_CLEANUP = "hyper-v-bootstrap-nic-cleanup-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_BOOTSTRAP_SSH_FINALIZE = "hyper-v-bootstrap-ssh-finalize-v2";
const DEVICE_BROKER_CAPABILITY_HYPER_V_WINDOWS_SPECIALIZE_SEED = "hyper-v-windows-specialize-seed-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_WINDOWS_SPECIALIZE_ACCOUNT = "hyper-v-windows-specialize-account-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_WINDOWS_BOOT_CONTRACT = "hyper-v-windows-boot-contract-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_BOOT_DISK_GENERATION = "hyper-v-boot-disk-generation-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_LINUX_CREATE_RESPONSE = "hyper-v-linux-create-response-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_IMAGE_ACQUISITION_STAGE_CACHE = "hyper-v-image-acquisition-stage-cache-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_POWERSHELL_STAGE_PROPAGATION = "hyper-v-powershell-stage-propagation-v1";
const DEVICE_BROKER_CAPABILITY_HYPER_V_AUTOMATIC_IMAGE_FINALIZATION = HYPER_V_PROVIDER_IMAGE_FINALIZATION_CONTRACT;
const DEVICE_BROKER_CAPABILITY_HYPER_V_NETWORK_FAILURE_DIAGNOSTICS = "hyper-v-network-failure-diagnostics-v9";
const DEVICE_BROKER_REQUIRED_CAPABILITIES = [
    DEVICE_BROKER_CAPABILITY_HOST_BACKEND_READINESS,
    DEVICE_BROKER_CAPABILITY_LIFECYCLE_DEVICE_CREATE,
    DEVICE_BROKER_CAPABILITY_DESKTOP_DEVICE_TOOL_PROXY,
    DEVICE_BROKER_CAPABILITY_DESKTOP_DEVICE_TOOL_TIMEOUTS,
    DEVICE_BROKER_CAPABILITY_WINDOWS_SANDBOX_HELPER_CONFIG,
    DEVICE_BROKER_CAPABILITY_ANDROID_DEVICE_TOOL_PROXY,
    DEVICE_BROKER_CAPABILITY_VERSION_REPORTING,
    DEVICE_BROKER_CAPABILITY_HIDDEN_PROVIDER_CHILDREN,
    DEVICE_BROKER_CAPABILITY_WINDOWS_SANDBOX_WINDOW_MINIMIZE,
    DEVICE_BROKER_CAPABILITY_WINDOWS_SANDBOX_RUNTIME_OWNERSHIP,
    DEVICE_BROKER_CAPABILITY_APPIUM3_NPM_RUNTIME,
    DEVICE_BROKER_CAPABILITY_EXISTING_OWNER_AUTH,
    DEVICE_BROKER_CAPABILITY_ATOMIC_OWNER_AUTH,
    DEVICE_BROKER_CAPABILITY_OWNER_MUTATION_SERIALIZATION,
    DEVICE_BROKER_CAPABILITY_ATOMIC_OWNER_DEVICE_STATE,
    DEVICE_BROKER_CAPABILITY_CROSS_PROCESS_OWNER_STATE,
    DEVICE_BROKER_CAPABILITY_OWNER_DEVICE_IDENTITY_FENCING,
    DEVICE_BROKER_CAPABILITY_RPC_FAULT_CONTAINMENT,
    DEVICE_BROKER_CAPABILITY_SHARED_LEASE_SERIALIZATION,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_LEASE_OPERATION_FENCING,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_LIFECYCLE_LEASE_FENCING,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_OPERATION_SERIALIZATION,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_DETACH_RUNTIME_CLEANUP,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_RUNTIME_CLEANUP_LEASE_FENCING,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_LEASE_STATE_WRITE_ROLLBACK,
    DEVICE_BROKER_CAPABILITY_RUNTIME_CLEANUP_FAILURE_PRESERVATION,
    DEVICE_BROKER_CAPABILITY_APPIUM_RUNTIME_GENERATION_FENCING,
    DEVICE_BROKER_CAPABILITY_WINDOWS_SINGLETON_FENCING,
    DEVICE_BROKER_CAPABILITY_DEVICE_OPERATION_SERIALIZATION,
    DEVICE_BROKER_CAPABILITY_DEVICE_RUNTIME_SERIALIZATION,
    DEVICE_BROKER_CAPABILITY_DIRECT_RECORDING_GENERATION_FENCING,
    DEVICE_BROKER_CAPABILITY_DIRECT_APPIUM_GENERATION_FENCING,
    DEVICE_BROKER_CAPABILITY_FINITE_DEVICE_OPERATION_SERIALIZATION,
    DEVICE_BROKER_CAPABILITY_DIRECT_RUNTIME_PROCESS_IDENTITY,
    DEVICE_BROKER_CAPABILITY_HOST_RECORDING_PROCESS_IDENTITY,
    DEVICE_BROKER_CAPABILITY_RUNTIME_PROCESS_OBSERVATION,
    DEVICE_BROKER_CAPABILITY_HOST_APPIUM_PROCESS_IDENTITY,
    DEVICE_BROKER_CAPABILITY_APPIUM_PORT_PROCESS_IDENTITY,
    DEVICE_BROKER_CAPABILITY_BROKER_OWNED_OWNER_AUTH,
    DEVICE_BROKER_CAPABILITY_PORT_PROCESS_IDENTITY,
    DEVICE_BROKER_CAPABILITY_PROCESS_START_TOKEN,
    DEVICE_BROKER_CAPABILITY_OWNER_GENERATION_HMAC_AUTH,
    DEVICE_BROKER_CAPABILITY_DIRECT_APPIUM_PROCESS_IDENTITY,
    DEVICE_BROKER_CAPABILITY_OWNER_DEVICE_STATE_VALIDATION,
    DEVICE_BROKER_CAPABILITY_OWNERSHIP_STATE_VALIDATION,
    DEVICE_BROKER_CAPABILITY_ANDROID_PORT_ALLOCATION_FENCING,
    DEVICE_BROKER_CAPABILITY_BOUNDED_ERROR_RESPONSES,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_LEASE_DIRECTORY_FENCING,
    DEVICE_BROKER_CAPABILITY_OWNER_AUTH_DIRECTORY_FENCING,
    DEVICE_BROKER_CAPABILITY_APPIUM_RUNTIME_INSTALLATION_FENCING,
    DEVICE_BROKER_CAPABILITY_APPIUM_HTTP_TRANSPORT_FENCING,
    DEVICE_BROKER_CAPABILITY_WINDOWS_PROVIDER_LAUNCHER_FENCING,
    DEVICE_BROKER_CAPABILITY_CANONICAL_OWNER_DEVICE_IDS,
    DEVICE_BROKER_CAPABILITY_IOS_SIMULATOR_OWNER_IDENTITY_FENCING,
    DEVICE_BROKER_CAPABILITY_IOS_SIMULATOR_PROVIDER_CREATE,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_APPIUM_LEASE_FENCING,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_DEVICE_TOOL_LEASE_FENCING,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_LIFECYCLE_USE_LEASE_REFRESH,
    DEVICE_BROKER_CAPABILITY_APPIUM_LIVE_RUNTIME_METADATA_FENCING,
    DEVICE_BROKER_CAPABILITY_DIRECT_ANDROID_LIFECYCLE_GENERATION_FENCING,
    DEVICE_BROKER_CAPABILITY_DIRECT_IOS_LIFECYCLE_GENERATION_FENCING,
    DEVICE_BROKER_CAPABILITY_DIRECT_WINDOWS_LIFECYCLE_GENERATION_FENCING,
    DEVICE_BROKER_CAPABILITY_DIRECT_MACOS_LIFECYCLE_GENERATION_FENCING,
    DEVICE_BROKER_CAPABILITY_DIRECT_MACOS_SNAPSHOT_CLONE_GENERATION_FENCING,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_DIRECT_STATE_TRANSITION_FENCING,
    DEVICE_BROKER_CAPABILITY_MULTI_PROJECT_OWNER_RESOLVE,
    DEVICE_BROKER_CAPABILITY_STOPPED_ANDROID_STATUS_OBSERVATION,
    DEVICE_BROKER_CAPABILITY_STOPPED_ANDROID_BOOT_METADATA,
    DEVICE_BROKER_CAPABILITY_GUEST_HELPER_RECORDING_PROXY,
    DEVICE_BROKER_CAPABILITY_PHYSICAL_UNATTACHED_WIRELESS,
    DEVICE_BROKER_CAPABILITY_ANDROID_RECORDING_SIGNAL_FALLBACK,
    DEVICE_BROKER_CAPABILITY_HYPER_V_LIFECYCLE,
    DEVICE_BROKER_CAPABILITY_HYPER_V_SETUP_NETWORK,
    DEVICE_BROKER_CAPABILITY_HYPER_V_GUEST_READINESS_DIAGNOSTICS,
    DEVICE_BROKER_CAPABILITY_HYPER_V_AZURE_BOOTSTRAP_DHCP,
    DEVICE_BROKER_CAPABILITY_HYPER_V_BOOTSTRAP_NIC_CLEANUP,
    DEVICE_BROKER_CAPABILITY_HYPER_V_BOOTSTRAP_SSH_FINALIZE,
    DEVICE_BROKER_CAPABILITY_HYPER_V_WINDOWS_SPECIALIZE_SEED,
    DEVICE_BROKER_CAPABILITY_HYPER_V_WINDOWS_SPECIALIZE_ACCOUNT,
    DEVICE_BROKER_CAPABILITY_HYPER_V_WINDOWS_BOOT_CONTRACT,
    DEVICE_BROKER_CAPABILITY_HYPER_V_BOOT_DISK_GENERATION,
    DEVICE_BROKER_CAPABILITY_HYPER_V_LINUX_CREATE_RESPONSE,
    DEVICE_BROKER_CAPABILITY_HYPER_V_IMAGE_ACQUISITION_STAGE_CACHE,
    DEVICE_BROKER_CAPABILITY_HYPER_V_POWERSHELL_STAGE_PROPAGATION,
    DEVICE_BROKER_CAPABILITY_HYPER_V_AUTOMATIC_IMAGE_FINALIZATION,
    DEVICE_BROKER_CAPABILITY_HYPER_V_NETWORK_FAILURE_DIAGNOSTICS,
];
const DEVICE_BROKER_DETACHED_READY_MS = 150;
const DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS = 3000;
const DEVICE_BROKER_PHYSICAL_LEASE_TTL_MS = 60 * 60 * 1000;
const DEVICE_BROKER_PHYSICAL_LEASE_MIN_TTL_MS = 30 * 1000;
const DEVICE_BROKER_PHYSICAL_LEASE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEVICE_BROKER_PHYSICAL_LEASE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const DEVICE_BROKER_AUTH_LOCK_WAIT_MS = 5000;
const DEVICE_BROKER_AUTH_LOCK_STALE_MS = 30000;
const DEVICE_BROKER_HYPER_V_HOST_LOCK_STALE_MS = 30 * 60 * 1000;
export const DEVICE_BROKER_HYPER_V_OWNER_QUOTA = Object.freeze({
    maxDefinedVms: 16,
    maxConfiguredMemoryMb: 256 * 1024,
    maxConfiguredCpus: 128,
    maxConfiguredDiskBytes: 2 * 1024 * 1024 * 1024 * 1024,
    maxRunningVms: 4,
    maxRunningMemoryMb: 128 * 1024,
    maxRunningCpus: 64,
});
const DEVICE_BROKER_AUTH_FILE_LIMIT_BYTES = 4096;
const DEVICE_BROKER_OWNER_REGISTRATION_FILE_LIMIT_BYTES = 16 * 1024;
const DEVICE_BROKER_RUNTIME_FILE_LIMIT_BYTES = 64 * 1024;
const DEVICE_BROKER_SERVICE_OWNER_FILE_LIMIT_BYTES = 16 * 1024;
const DEVICE_BROKER_APPIUM_RUNTIME_MARKER_LIMIT_BYTES = 16 * 1024;
const DEVICE_BROKER_HYPER_V_GUEST_UPLOAD_LIMIT_BYTES = 128 * 1024 * 1024;
const DEVICE_BROKER_HYPER_V_OPERATION_JOURNAL_LIMIT_BYTES = 16 * 1024;
export const DEVICE_BROKER_APPIUM_PACKAGE_MANIFEST_LIMIT_BYTES = 64 * 1024;
export const DEVICE_BROKER_APPIUM_LOCK_MANIFEST_LIMIT_BYTES = 8 * 1024 * 1024;
const DEVICE_BROKER_APPIUM_ENTRY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEVICE_BROKER_WINDOWS_CONFIG_LIMIT_BYTES = 256 * 1024;
const DEVICE_BROKER_WINDOWS_MINIMIZE_RESULT_LIMIT_BYTES = 64;
const ANDROID_EMULATOR_PORT_MIN = 5554;
const ANDROID_EMULATOR_PORT_MAX = 5682;
const DEVICE_BROKER_ANDROID_PORT_LOCK_WAIT_MS = 30000;
const DEVICE_BROKER_ANDROID_PORT_LOCK_STALE_MS = 15 * 60 * 1000;
const DEVICE_BROKER_BACKEND_STATE_KEYS = ["android", "android-device", "ios", "ios-device", "windows", "windows-vm", "linux-vm", "macos"];
const DEVICE_BROKER_PHYSICAL_BACKENDS = new Set(["android-device", "ios-device"]);
const DEVICE_BROKER_MACOS_PROVIDERS = new Set(["tart", "vz", "utmctl"]);
const ANDROID_EMULATOR_CAPABILITIES = [
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop",
    "device_status", "device_exec", "device_screenshot",
    "device_record_video_start", "device_record_video_stop", "device_record_video_status",
    "device_upload", "device_download", "device_reset",
    "device_install_app", "device_launch_app",
    "mobile_session_status", "mobile_dump_ui", "mobile_tap",
    "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag",
    "mobile_type_text", "mobile_key", "mobile_home", "mobile_back",
    "mobile_forward", "mobile_recents", "mobile_power", "mobile_lock",
    "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
    "mobile_set_orientation", "mobile_open_url", "mobile_install_app",
    "mobile_launch_app", "mobile_uninstall_app", "mobile_stop_app",
    "mobile_clear_app_data", "mobile_grant_permission", "mobile_revoke_permission",
    "mobile_set_location", "mobile_set_battery", "mobile_set_network",
    "mobile_toggle_airplane_mode", "mobile_set_clipboard",
    "mobile_get_clipboard", "mobile_wait_for_text", "mobile_wait_for_app",
    "mobile_screenshot",
];
const ANDROID_REAL_CAPABILITIES = [
    "device_inventory", "device_attach", "device_detach", "device_start", "device_stop",
    "device_status", "device_wireless", "device_exec", "device_screenshot",
    "device_record_video_start", "device_record_video_stop", "device_record_video_status",
    "device_upload", "device_download", "device_reset",
    "device_install_app", "device_launch_app",
    "mobile_session_status", "mobile_dump_ui", "mobile_tap",
    "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag", "mobile_type_text", "mobile_key", "mobile_home",
    "mobile_back", "mobile_forward", "mobile_recents", "mobile_power",
    "mobile_lock", "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
    "mobile_set_orientation", "mobile_open_url", "mobile_install_app",
    "mobile_launch_app", "mobile_uninstall_app", "mobile_stop_app",
    "mobile_clear_app_data", "mobile_grant_permission", "mobile_revoke_permission",
    "mobile_set_clipboard",
    "mobile_get_clipboard", "mobile_wait_for_text", "mobile_wait_for_app",
    "mobile_screenshot",
];
const IOS_SIMULATOR_CAPABILITIES = [
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop",
    "device_status", "device_exec", "device_screenshot",
    "device_record_video_start", "device_record_video_stop", "device_record_video_status",
    "device_upload", "device_download", "device_reset",
    "device_install_app", "device_launch_app", "mobile_open_url", "mobile_install_app",
    "mobile_launch_app", "mobile_screenshot", "mobile_session_status", "mobile_dump_ui",
    "mobile_tap", "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag", "mobile_type_text", "mobile_key", "mobile_home", "mobile_lock",
    "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right", "mobile_set_orientation",
    "mobile_uninstall_app", "mobile_stop_app", "mobile_clear_app_data",
    "mobile_grant_permission", "mobile_revoke_permission", "mobile_set_location",
    "mobile_set_clipboard", "mobile_get_clipboard", "mobile_wait_for_text", "mobile_wait_for_app",
];
const IOS_REAL_CAPABILITIES = [
    "device_inventory", "device_attach", "device_detach", "device_start", "device_stop",
    "device_status", "device_wireless", "mobile_session_status", "mobile_dump_ui",
    "device_screenshot", "device_install_app", "device_launch_app",
    "mobile_install_app", "mobile_launch_app", "mobile_screenshot",
    "mobile_tap", "mobile_double_tap", "mobile_long_press", "mobile_swipe",
    "mobile_drag", "mobile_type_text", "mobile_key", "mobile_home",
    "mobile_lock", "mobile_unlock", "mobile_rotate_left", "mobile_rotate_right",
    "mobile_set_orientation", "mobile_wait_for_text", "mobile_wait_for_app",
    "mobile_stop_app",
];
const DESKTOP_DEVICE_CAPABILITIES = [
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop",
    "device_status", "device_exec", "device_screenshot", "device_click",
    "device_double_click", "device_key", "device_type", "device_scroll",
    "device_cursor_position", "device_window_list", "device_accessibility_snapshot",
    "device_record_video_start", "device_record_video_stop", "device_record_video_status",
    "device_upload", "device_download",
];
const MACOS_VM_CAPABILITIES = [
    ...DESKTOP_DEVICE_CAPABILITIES,
    "device_base_image_create", "device_base_image_clone",
    "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete",
];
const HYPER_V_VM_CAPABILITIES = [
    "device_inventory", "device_create", "device_delete", "device_start", "device_stop", "device_reboot", "device_status",
    "device_exec", "device_upload", "device_download",
    "device_snapshot_list", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete",
];
const DEVICE_BROKER_COMMAND_BACKENDS = new Map([
    ["android-emulator", "android"],
    ["android-device", "android-device"],
    ["ios-simulator", "ios"],
    ["ios-device", "ios-device"],
    ["windows-sandbox", "windows"],
    ["windows-vm", "windows-vm"],
    ["linux-vm", "linux-vm"],
    ["macos-vm", "macos"],
]);
const DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS = [
    "windows-sandbox",
    "windows-vm",
    "linux-vm",
    "macos-vm",
    "android-emulator",
    "android-device",
    "ios-simulator",
    "ios-device",
];
const DEVICE_BROKER_CREATABLE_BACKENDS = new Set(["android-emulator", "ios-simulator", "windows-sandbox", "windows-vm", "linux-vm", "macos-vm"]);
const DEVICE_BROKER_APPIUM_BACKENDS = new Map([
    ["android-emulator", "android"],
    ["android-device", "android-device"],
    ["ios-simulator", "ios"],
    ["ios-device", "ios-device"],
]);
const DEVICE_BROKER_STATE_BACKENDS = new Map([...DEVICE_BROKER_COMMAND_BACKENDS].map(([backend, stateKey]) => [stateKey, backend]));
const DEVICE_BROKER_HYPER_V_BACKENDS = new Set(["windows-vm", "linux-vm"]);

function isHyperVBackend(backend: string | null | undefined): boolean {
    return typeof backend === "string" && DEVICE_BROKER_HYPER_V_BACKENDS.has(backend);
}

function hyperVSecureBootConfiguration(backend: string) {
    const linuxGuest = backend === "linux-vm";
    return {
        secureBootEnabled: !linuxGuest,
        secureBootTemplate: linuxGuest
            ? "MicrosoftUEFICertificateAuthority" as const
            : "MicrosoftWindows" as const,
    };
}
const DEVICE_BROKER_LIFECYCLE_COMMANDS = new Set(["device_create", "device_status", "device_start", "device_stop", "device_reboot", "device_delete"]);
const LIFECYCLE_METHOD_RE = /^(device|mobile)\./;
const DEVICE_BROKER_DESKTOP_TOOL_METHODS = new Set([
    "device_exec",
    "device_screenshot",
    "device_click",
    "device_double_click",
    "device_key",
    "device_type",
    "device_scroll",
    "device_cursor_position",
    "device_window_list",
    "device_accessibility_snapshot",
]);
const DEVICE_BROKER_DESKTOP_FILE_TOOL_METHODS = new Set([
    "device_upload",
    "device_download",
]);
const DEVICE_BROKER_ANDROID_TOOL_METHODS = new Set([
    "device_status",
    "device_exec",
    "device_screenshot",
    "device_upload",
    "device_download",
    "device_reset",
    "device_install_app",
    "device_launch_app",
    "mobile_session_status",
    "mobile_dump_ui",
    "mobile_tap",
    "mobile_double_tap",
    "mobile_long_press",
    "mobile_swipe",
    "mobile_drag",
    "mobile_type_text",
    "mobile_key",
    "mobile_home",
    "mobile_back",
    "mobile_forward",
    "mobile_recents",
    "mobile_power",
    "mobile_lock",
    "mobile_unlock",
    "mobile_rotate_left",
    "mobile_rotate_right",
    "mobile_set_orientation",
    "mobile_open_url",
    "mobile_install_app",
    "mobile_launch_app",
    "mobile_uninstall_app",
    "mobile_stop_app",
    "mobile_clear_app_data",
    "mobile_grant_permission",
    "mobile_revoke_permission",
    "mobile_set_location",
    "mobile_set_battery",
    "mobile_set_network",
    "mobile_toggle_airplane_mode",
    "mobile_set_clipboard",
    "mobile_get_clipboard",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
    "mobile_screenshot",
]);
const DEVICE_BROKER_ANDROID_PHYSICAL_UNSAFE_BASE_TOOLS = new Set([
    "mobile_set_location",
    "mobile_set_battery",
    "mobile_set_network",
    "mobile_toggle_airplane_mode",
]);
const DEVICE_BROKER_ANDROID_DEVICE_TOOL_METHODS = new Set(
    ["device_wireless", ...DEVICE_BROKER_ANDROID_TOOL_METHODS].filter((tool) => !DEVICE_BROKER_ANDROID_PHYSICAL_UNSAFE_BASE_TOOLS.has(tool)),
);
const DEVICE_BROKER_IOS_SIMULATOR_TOOL_METHODS = new Set([
    "device_status",
    "device_exec",
    "device_screenshot",
    "device_upload",
    "device_download",
    "device_reset",
    "device_install_app",
    "device_launch_app",
    "mobile_open_url",
    "mobile_install_app",
    "mobile_launch_app",
    "mobile_screenshot",
    "mobile_session_status",
    "mobile_dump_ui",
    "mobile_tap",
    "mobile_double_tap",
    "mobile_long_press",
    "mobile_swipe",
    "mobile_drag",
    "mobile_type_text",
    "mobile_key",
    "mobile_home",
    "mobile_lock",
    "mobile_unlock",
    "mobile_rotate_left",
    "mobile_rotate_right",
    "mobile_set_orientation",
    "mobile_uninstall_app",
    "mobile_stop_app",
    "mobile_clear_app_data",
    "mobile_grant_permission",
    "mobile_revoke_permission",
    "mobile_set_location",
    "mobile_set_clipboard",
    "mobile_get_clipboard",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
]);
const DEVICE_BROKER_IOS_DEVICE_TOOL_METHODS = new Set([
    "device_wireless",
    "device_status",
    "device_screenshot",
    "device_install_app",
    "device_launch_app",
    "mobile_install_app",
    "mobile_launch_app",
    "mobile_screenshot",
    "mobile_session_status",
    "mobile_dump_ui",
    "mobile_tap",
    "mobile_double_tap",
    "mobile_long_press",
    "mobile_swipe",
    "mobile_drag",
    "mobile_type_text",
    "mobile_key",
    "mobile_home",
    "mobile_lock",
    "mobile_unlock",
    "mobile_rotate_left",
    "mobile_rotate_right",
    "mobile_set_orientation",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
    "mobile_stop_app",
]);
const DEVICE_BROKER_BACKEND_TOOL_METHODS = new Set([
    ...DEVICE_BROKER_DESKTOP_TOOL_METHODS,
    ...DEVICE_BROKER_DESKTOP_FILE_TOOL_METHODS,
    ...DEVICE_BROKER_ANDROID_TOOL_METHODS,
    ...DEVICE_BROKER_IOS_SIMULATOR_TOOL_METHODS,
    ...DEVICE_BROKER_IOS_DEVICE_TOOL_METHODS,
    "device_snapshot_list",
    "device_snapshot_create",
    "device_snapshot_restore",
    "device_snapshot_delete",
]);
const DEVICE_BROKER_UNATTACHED_TOOL_METHODS = new Set(["device_wireless"]);
const DEVICE_BROKER_TOOL_METHODS = new Set(["device_inventory", "device_record_video_status", "device_record_video_start", "device_record_video_stop", ...DEVICE_BROKER_BACKEND_TOOL_METHODS]);
const DEVICE_BROKER_READ_ONLY_TOOL_METHODS = new Set([
    "device_inventory",
    "device_status",
    "device_snapshot_list",
    "device_screenshot",
    "device_cursor_position",
    "device_window_list",
    "device_accessibility_snapshot",
    "device_record_video_status",
    "mobile_session_status",
    "mobile_dump_ui",
    "mobile_get_clipboard",
    "mobile_wait_for_text",
    "mobile_wait_for_app",
    "mobile_screenshot",
]);
const DEVICE_BROKER_MUTATING_RPC_METHODS = new Set([
    "broker.cleanup.owner",
    "broker.lease.claim",
    "broker.lease.heartbeat",
    "broker.lease.prune",
    "broker.lease.release",
    "broker.physical.attach",
    "broker.physical.detach",
    "broker.apple.trust",
    "broker.command.invoke",
    "broker.appium.record",
    "broker.appium.clear",
    "broker.appium.start",
    "broker.appium.stop",
    "broker.appium.session.ensure",
    "broker.appium.session.delete",
    "broker.appium.request",
]);
const brokerOwnerMutationTails = new Map<string, Promise<void>>();
const brokerAuthNonces = new Map<string, number>();
const DEVICE_BROKER_SERVICE_ACTIONS = new Set(["status"]);
const DEVICE_BROKER_APPLE_TRUST_ACTIONS = new Set(["status", "pair", "connect"]);
const DEVICE_BROKER_RECORDING_PROVIDERS = new Map([
    ["android", "adb-screenrecord"],
    ["android-device", "adb-screenrecord"],
    ["ios", "simctl-recordVideo"],
    ["windows", "windows-helper-frame-archive"],
    ["macos", "ssh-screencapture-video"],
]);
type DeviceBrokerAppiumRequestMethod = "GET" | "POST";

const DEVICE_BROKER_APPIUM_REQUEST_ALLOWLIST = new Map<string, ReadonlySet<DeviceBrokerAppiumRequestMethod>>([
    ["/source", new Set(["GET"])],
    ["/screenshot", new Set(["GET"])],
    ["/actions", new Set(["POST"])],
    ["/keys", new Set(["POST"])],
    ["/back", new Set(["POST"])],
    ["/orientation", new Set(["POST"])],
    ["/url", new Set(["POST"])],
    ["/location", new Set(["POST"])],
    ["/execute/sync", new Set(["POST"])],
    ["/appium/device/press_keycode", new Set(["POST"])],
    ["/appium/device/install_app", new Set(["POST"])],
    ["/appium/device/activate_app", new Set(["POST"])],
    ["/appium/device/remove_app", new Set(["POST"])],
    ["/appium/device/terminate_app", new Set(["POST"])],
    ["/appium/device/set_clipboard", new Set(["POST"])],
    ["/appium/device/get_clipboard", new Set(["POST"])],
    ["/appium/device/app_state", new Set(["POST"])],
]);

export interface DeviceBrokerOptions {
    cwd?: string;
    profile?: string;
    host?: string;
    port?: number;
    startedAt?: string;
    ownerId?: string;
    providerPaths?: Record<string, string>;
    commandTimeoutMs?: number;
    requestBodyTimeoutMs?: number;
    commandRunner?: ProviderCommandRunner;
    deviceToolRunner?: BrokerDeviceToolRunner;
    windowsDeviceArtifactCleaner?: (ownerId: string, deviceId: string) => WindowsSandboxDeviceArtifactCleanup;
    platform?: NodeJS.Platform;
    cliPath?: string;
    portProcessResolver?: BrokerPortProcessResolver;
}

type BrokerRpcResult = { status: number; payload: unknown };
type NormalizedBrokerOptions = {
    cwd: string;
    profile?: string;
    host: string;
    port: number;
    startedAt: string;
    providerPaths: Record<string, string>;
    commandTimeoutMs: number;
    requestBodyTimeoutMs: number;
    commandRunner: ProviderCommandRunner;
    deviceToolRunner: BrokerDeviceToolRunner;
    windowsDeviceArtifactCleaner: (ownerId: string, deviceId: string) => WindowsSandboxDeviceArtifactCleanup;
    usesDefaultCommandRunner: boolean;
    platform: NodeJS.Platform;
    cliPath: string;
    portProcessResolver: BrokerPortProcessResolver;
    strictAppiumPortOwnership: boolean;
};
type LeaseParamError = { ok: false; status: number; error: string; allowed?: string[] };
type LeaseParamSuccess = {
    ok: true;
    backend: string;
    hardwareId: string;
    deviceId: string | null;
    connection: string;
    transport: object;
    ttlMs: number;
    claimId: string | null;
    claimNonce: string | null;
};
type CommandParamError = { ok: false; status: number; error: string; allowed?: string[] };
type CommandParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
    command: string;
    deviceId: string;
    expectedIncarnationId?: string;
    force: boolean;
    startIfStopped?: boolean;
    dryRun: boolean;
    headless?: boolean;
    minimized?: boolean;
    waitForBoot?: boolean;
    bootTimeoutMs?: number;
    deleteAvd?: boolean;
    deleteSimulator?: boolean;
    create?: Record<string, unknown>;
};
type AppiumParamError = { ok: false; status: number; error: string; allowed?: string[] };
type AppiumParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
    deviceId: string;
};
type AppiumListParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
};
type AppiumMetadataResult = { ok: true; appium: Record<string, unknown> } | { ok: false; status: number; error: string };
type AppiumRequestParamError = { ok: false; status: number; error: string; allowed?: string[] };
type AppiumRequestParamSuccess = AppiumParamSuccess & {
    method: DeviceBrokerAppiumRequestMethod;
    path: string;
    body: unknown;
};
type AppiumRequestBodyValidation = { ok: true } | { ok: false; status: number; error: string; allowed?: string[] };
type DeviceToolParamError = { ok: false; status: number; error: string; allowed?: string[]; supported?: string[] };
type DeviceToolParamSuccess = {
    ok: true;
    tool: string;
    backend: string | null;
    stateKey: string | null;
    deviceId: string | null;
    remotePath: string | null;
    localPath: string | null;
    timeLimitSec: number | null;
    params: Record<string, unknown>;
};
type AttachParamError = { ok: false; status: number; error: string; allowed?: string[] };
type AttachParamSuccess = {
    ok: true;
    backend: string;
    stateKey: string;
    deviceId: string;
    name: string | null;
    serial: string | null;
    udid: string | null;
    connection: string;
    connectionProvided: boolean;
    host: string | null;
    port: number | null;
};
type AppleTrustParamError = { ok: false; status: number; error: string; allowed?: string[] };
type AppleTrustParamSuccess = {
    ok: true;
    action: string;
    backend: "ios-device";
    udid: string | null;
};
export type ProviderCommand = {
    mode: "exec" | "detached" | "noop";
    provider: string;
    executable?: string;
    args?: string[];
    input?: string;
    reason?: string;
    sandboxId?: string;
    requestedSandboxId?: string;
    windowStyle?: "minimized";
    waitForExit?: boolean;
    windowsHiddenLauncher?: boolean;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
};
type ProviderCommandResult = {
    mode: string;
    provider: string;
    executable?: string;
    args?: string[];
    input?: string;
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    pid?: number;
    processIdentity?: DeviceRuntimeProcessIdentity;
    timedOut?: boolean;
    cleanup?: BrokerProcessTreeCleanup;
};
type ProviderCommandRunnerOptions = {
    timeoutMs: number;
    outputLimit: number;
    wrapperTimeoutMs?: number;
    cleanupGraceMs?: number;
};
type ProviderCommandRunner = (command: ProviderCommand, options: ProviderCommandRunnerOptions) => ProviderCommandResult;
type BrokerDeviceToolRunner = (ownerId: string, parsed: DeviceToolParamSuccess, match: DeviceToolMatch, normalized: NormalizedBrokerOptions) => BrokerRpcResult | Promise<BrokerRpcResult>;
type ServiceAction = "status";
type ServicePlan = {
    supported: boolean;
    platform: NodeJS.Platform;
    manager: string;
    serviceName: string;
    definitionPath: string | null;
    command: string[];
    diagnostics: string[];
    files: { path: string; content: string }[];
    commands: ProviderCommand[];
};
type ServiceOwnerRecord = {
    ownerId: string;
    serviceName: string;
    manager: string;
    installedAt: string;
    updatedAt: string;
};
type BrokerSpawn = typeof spawn;
export type BrokerPortProcess = {
    pid: number;
    commandLine?: string | null;
    processIdentity?: DeviceRuntimeProcessIdentity | null;
    processStartToken?: string | null;
};
export type BrokerPortProcessResolver = (port: number, platform: NodeJS.Platform) => BrokerPortProcess | null;

export interface HostDeviceBrokerOptions extends DeviceBrokerOptions {
    bindHost?: string;
    probeHost?: string;
    timeoutMs?: number;
    startupTimeoutMs?: number;
    spawnImpl?: BrokerSpawn;
    portProcessResolver?: BrokerPortProcessResolver;
    processIdentityReader?: (pid: number, platform: NodeJS.Platform) => DeviceRuntimeProcessIdentity | null;
    processStartTokenReader?: (pid: number, platform: NodeJS.Platform) => string | null;
    env?: NodeJS.ProcessEnv;
    enabled?: boolean;
}

export type HostDeviceBrokerOwnerRpcResult = {
    ok: boolean;
    status: number | null;
    ownerId: string;
    host: string;
    port: number;
    body: Record<string, unknown> | null;
    error?: string;
    detail?: string;
};

function brokerRoot(): string {
    return join(homedir(), ".ccc/devices");
}

function brokerPrivateRoot(): string {
    return join(homedir(), ".ccc/device-broker-private");
}

function brokerRuntimeFile(): string {
    return join(brokerRoot(), "broker", "runtime.json");
}

function writeHostBrokerRuntime(runtime: Record<string, unknown>): void {
    writeJsonFileAtomically(brokerRuntimeFile(), runtime);
}

function readHostBrokerRuntime(): Record<string, unknown> | null {
    try {
        return readDeviceLabStateFile(brokerRuntimeFile(), (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-broker-runtime");
            return parsed as Record<string, unknown>;
        }, "broker-runtime", DEVICE_BROKER_RUNTIME_FILE_LIMIT_BYTES);
    } catch {
        return null;
    }
}

function removeHostBrokerRuntime(): void {
    try {
        unlinkSync(brokerRuntimeFile());
    } catch {
        // Stale metadata cleanup is best-effort.
    }
}

function hostBrokerRuntimeMatchesRequiredBindHost(runtime: Record<string, unknown> | null, port: number, bindHost: string): boolean {
    if (bindHost === DEVICE_BROKER_DEFAULT_HOST) return true;
    return runtime?.managedBy === "ccc-host"
        && runtime.port === port
        && runtime.host === bindHost;
}

function hostBrokerStatusMatchesRequiredBindHost(compatibility: unknown, port: number, bindHost: string): boolean {
    const broker = compatibilityBrokerRecord(compatibility);
    return broker?.port === port && broker?.host === bindHost;
}

function hostBrokerProbeCandidates(bindHost: string, probeHost: string): string[] {
    const candidates = [
        probeHost,
        "127.0.0.1",
        "host.docker.internal",
        "host.containers.internal",
        "gateway.docker.internal",
        "172.17.0.1",
        "10.0.2.2",
        bindHost,
    ];
    return [...new Set(candidates.filter((host) => host && host !== "0.0.0.0" && host !== "::"))];
}

function brokerWindowsSandboxLockPath(): string {
    return join(brokerRoot(), "host-locks", "windows-sandbox.json");
}

function brokerWindowsSandboxMutationLockPath(): string {
    return join(brokerRoot(), "host-locks", "windows-sandbox.mutation.lock");
}

function brokerHyperVMutationLockPath(): string {
    return join(brokerRoot(), "host-locks", "hyper-v.mutation.lock");
}

function currentBootId(): string {
    try {
        return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
        return `${hostname()}:${Math.floor((Date.now() - uptime() * 1000) / 1000)}`;
    }
}

function sameBootIdentity(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    const leftMatch = typeof left === "string" ? left.match(/^(.*):(\d+)$/) : null;
    const rightMatch = typeof right === "string" ? right.match(/^(.*):(\d+)$/) : null;
    return Boolean(leftMatch && rightMatch
        && leftMatch[1] === rightMatch[1]
        && Math.abs(Number(leftMatch[2]) - Number(rightMatch[2])) <= 5);
}

function readBrokerWindowsSandboxLock(): Record<string, unknown> | null {
    return readWindowsSandboxLockStateFile(brokerWindowsSandboxLockPath());
}

function staleBrokerWindowsSandboxLock(lock: Record<string, unknown> | null): boolean {
    return Boolean(lock?.bootId && !sameBootIdentity(lock.bootId, currentBootId()));
}

function sameBrokerWindowsSandboxLockOwner(lock: Record<string, unknown> | null, ownerId: string, device: unknown, sandboxId?: string): boolean {
    const deviceId = field(device, "id");
    return lock?.ownerId === ownerId
        && lock?.deviceId === deviceId
        && (!lock?.sandboxId || !sandboxId || lock.sandboxId === sandboxId);
}

function brokerWindowsSandboxIdForStop(ownerId: string, device: unknown): string | null {
    const recorded = field(device, "sandboxId");
    if (isGuid(recorded)) return recorded;
    if (field(device, "status") !== "stopped") return null;
    const lock = readBrokerWindowsSandboxLock();
    const sandboxId = field(lock, "sandboxId");
    const claimId = field(lock, "claimId");
    return lock?.provider === "windows-sandbox"
        && lock?.host === hostname()
        && sameBootIdentity(lock?.bootId, currentBootId())
        && Boolean(claimId && /^[a-f0-9]{16,128}$/i.test(claimId))
        && isGuid(sandboxId)
        && sameBrokerWindowsSandboxLockOwner(lock, ownerId, device, sandboxId)
        ? sandboxId
        : null;
}

function claimBrokerWindowsSandboxLock(ownerId: string, device: unknown, sandboxId?: string): { ok: true } | { ok: false; error: string; lock: Record<string, unknown> | null } {
    return withSharedMutationLock(brokerWindowsSandboxMutationLockPath(), () => {
        const lockPath = brokerWindowsSandboxLockPath();
        const existing = readBrokerWindowsSandboxLock();
        if (staleBrokerWindowsSandboxLock(existing)) {
            try { unlinkSync(lockPath); } catch { /* retry handles persistent failure */ }
        }
        const current = staleBrokerWindowsSandboxLock(existing) ? null : existing;
        const sameOwner = sameBrokerWindowsSandboxLockOwner(current, ownerId, device, sandboxId);
        const lock = {
            provider: "windows-sandbox",
            host: hostname(),
            bootId: currentBootId(),
            ownerId,
            deviceId: field(device, "id") || "unknown",
            sandboxId: sandboxId || null,
            claimId: sameOwner && typeof current?.claimId === "string" ? current.claimId : randomBytes(16).toString("hex"),
            pid: process.pid,
            acquiredAt: sameOwner && typeof current?.acquiredAt === "string" ? current.acquiredAt : new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        if (!current || sameOwner) {
            validateWindowsSandboxLock(lock);
            writeJsonFileAtomically(lockPath, lock);
            return { ok: true };
        }
        return {
            ok: false,
            error: `Windows Sandbox is already claimed on this host by owner ${String(current?.ownerId || "unknown")} device ${String(current?.deviceId || "unknown")}. Windows Sandbox supports one running instance per host.`,
            lock: current,
        };
    });
}

function releaseBrokerWindowsSandboxLock(ownerId: string, device: unknown, sandboxId?: string): void {
    withSharedMutationLock(brokerWindowsSandboxMutationLockPath(), () => {
        const existing = readBrokerWindowsSandboxLock();
        if (!sameBrokerWindowsSandboxLockOwner(existing, ownerId, device, sandboxId)) return;
        try { unlinkSync(brokerWindowsSandboxLockPath()); } catch { /* ignore missing lock */ }
    });
}

function updateBrokerWindowsSandboxLockRuntimeId(ownerId: string, device: unknown, claimedSandboxId: string | undefined, runtimeSandboxId: string): void {
    withSharedMutationLock(brokerWindowsSandboxMutationLockPath(), () => {
        const existing = readBrokerWindowsSandboxLock();
        if (!sameBrokerWindowsSandboxLockOwner(existing, ownerId, device, claimedSandboxId)) return;
        const updated = {
            ...existing,
            sandboxId: runtimeSandboxId,
            requestedSandboxId: claimedSandboxId || null,
            updatedAt: new Date().toISOString(),
        };
        validateWindowsSandboxLock(updated);
        writeJsonFileAtomically(brokerWindowsSandboxLockPath(), updated);
    });
}

function deviceBrokerPersistence(ownerId: string) {
    const root = brokerRoot();
    const ownerRoot = join(root, "owners", ownerId);
    const backendRoots = Object.fromEntries(DEVICE_BROKER_BACKEND_STATE_KEYS.map((stateKey) => [stateKey, join(ownerRoot, stateKey)]));
    return {
        root,
        durableAcrossContainerRecreation: true,
        environmentVariablesRequired: false,
        ownerScoped: {
            ownerRoot,
            backendRoots,
            deviceDefinitions: Object.fromEntries(DEVICE_BROKER_BACKEND_STATE_KEYS.map((stateKey) => [stateKey, join(ownerRoot, stateKey, "devices.json")])),
            appiumMetadata: "stored on owner device records as appium; host-broker-owned server processes include processOwner=host-broker and startedBy=broker.appium.start",
            recordings: {
                android: join(ownerRoot, "android", "<device-id>", "recordings"),
                ios: join(ownerRoot, "ios", "<device-id>", "recordings"),
                windows: join(ownerRoot, "windows", "<device-id>", "recordings"),
                macos: join(ownerRoot, "macos", "<device-id>", "recordings"),
                metadata: "stored on owner device records as recording",
            },
            helpers: {
                windows: join(ownerRoot, "windows", "<device-id>", "tools"),
                macos: join(ownerRoot, "macos", "<device-id>", "tools"),
            },
            images: {
                androidAvd: "host Android SDK AVD storage; CCC stores only owner-prefixed avdName metadata in owner devices",
                iosSimulator: "host CoreSimulator storage; CCC stores only owner-prefixed simulatorName/UDID metadata in owner devices",
                macosVm: "provider-owned VM instances named from ccc-<owner-id>-<device-id>; metadata is stored under the macos owner root",
                windowsSandbox: "ephemeral Windows Sandbox instances; CCC stores owner-scoped .wsb/helper/scratch metadata under the windows owner root",
            },
            snapshots: {
                macosVm: "Tart snapshots are represented by owner-scoped provider clones recorded on the macos device definition",
            },
        },
        brokerScoped: {
            brokerRoot: join(root, "broker"),
            authRoot: join(root, "broker", "auth"),
            locksRoot: join(root, "broker", "locks"),
            logsRoot: join(root, "broker", "logs"),
            serviceRoot: join(root, "broker", "service"),
            runtimeFile: join(root, "broker", "runtime.json"),
        },
        hostToolchains: {
            ownership: "host-owned",
            discovery: "PATH plus explicit providerPaths supplied by CCC tests or host integrations",
            appium: "host Appium executable is discovered through PATH/providerPaths; broker stores only owner-scoped process/session metadata",
            androidSdk: "host Android SDK/emulator/adb/avdmanager state is not deleted by owner cleanup",
            xcode: "host Xcode/xcrun/simctl/xctrace/devicectl state is not deleted by owner cleanup",
            windowsSandbox: "host Windows Sandbox feature and wsb command are not deleted by owner cleanup",
            macosVmProviders: "host tart/vz/utmctl installations and provider image catalogs are not deleted by owner cleanup",
        },
        cleanupBoundary: {
            ownerCleanupMayMutate: [ownerRoot, join(root, "physical-leases", "<backend>", "locks", "<hardware-id>.json")],
            ownerCleanupPreserves: [
                join(root, "owners", "<foreign-owner-id>"),
                join(root, "broker", "auth"),
                join(root, "broker", "service"),
                join(root, "broker", "logs"),
                "host SDKs, Appium packages, Xcode, Windows Sandbox, and VM provider installations",
                "shared/base VM images and host provider catalogs",
            ],
            staleMetadataPolicy: "owner cleanup clears stale owner appium/recording metadata and retries provider stops without deleting shared toolchain caches or foreign owner state",
        },
        diagnostics: [
            "If a CCC container is recreated, broker state remains under the host user home at ~/.ccc/devices.",
            "If host toolchains are missing after recreation, status/smoke commands report missing prerequisites instead of silently recreating devices.",
            "Owner cleanup is scoped to the current owner namespace and physical leases for that owner.",
        ],
    };
}

function deviceBrokerOwnerId(cwd: string, profile?: string): string {
    return canonicalDeviceLabOwnerId(cwd || "/project", profile);
}

type DeviceBrokerOwnerRegistration = {
    version: 1;
    ownerId: string;
    ownerBasis: string;
    projectMountPath: string;
    hostProjectPath: string;
    profile: string | null;
    registeredAt: string;
};

function deviceBrokerOwnerRegistrationDirectoryChain(): string[] {
    const root = brokerRoot();
    return [root, join(root, "broker"), join(root, "broker", "owners")];
}

function inspectDeviceBrokerOwnerRegistrationDirectory(): boolean {
    for (const directory of deviceBrokerOwnerRegistrationDirectoryChain()) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw new Error("device-broker-owner-registration-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("device-broker-owner-registration-directory-invalid");
        }
    }
    return true;
}

function ensureDeviceBrokerOwnerRegistrationDirectory(): void {
    const [root, ...children] = deviceBrokerOwnerRegistrationDirectoryChain();
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("device-broker-owner-registration-directory-create-failed");
    }
    for (const directory of [root, ...children]) {
        if (directory !== root) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("device-broker-owner-registration-directory-create-failed");
            }
        }
        try {
            const stat = lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("device-broker-owner-registration-directory-invalid");
        } catch (error) {
            if (error instanceof Error && error.message === "device-broker-owner-registration-directory-invalid") throw error;
            throw new Error("device-broker-owner-registration-directory-read-failed");
        }
    }
}

export function deviceBrokerOwnerRegistrationFile(ownerId: string): string {
    if (!/^[a-f0-9]{16}$/.test(ownerId)) throw new Error("invalid-owner-id");
    return join(brokerRoot(), "broker", "owners", `${ownerId}.json`);
}

export function deviceBrokerHostProjectMountPath(hostProjectPath: string): string | null {
    if (deviceLabOwnerFromProjectMountPath(hostProjectPath)) return hostProjectPath;
    const windowsStyle = /^[a-zA-Z]:[\\/]/.test(hostProjectPath) || /^\\\\/.test(hostProjectPath);
    const pathApi = windowsStyle && win32.isAbsolute(hostProjectPath)
        ? win32
        : posix.isAbsolute(hostProjectPath) ? posix : null;
    if (!pathApi) return null;
    const normalized = pathApi.resolve(hostProjectPath);
    if (normalized !== hostProjectPath) return null;
    const name = pathApi.basename(normalized).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    return `/project/${name}-${hash}`;
}

function validateDeviceBrokerOwnerRegistration(value: unknown, expectedOwnerId: string): DeviceBrokerOwnerRegistration {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-owner-registration");
    const registration = value as Record<string, unknown>;
    const profile = registration.profile === null ? undefined : registration.profile;
    if (registration.version !== 1
        || registration.ownerId !== expectedOwnerId
        || typeof registration.ownerBasis !== "string"
        || typeof registration.projectMountPath !== "string"
        || typeof registration.hostProjectPath !== "string"
        || (profile !== undefined && typeof profile !== "string")
        || typeof registration.registeredAt !== "string"
        || deviceBrokerHostProjectMountPath(registration.hostProjectPath) === null) {
        throw new Error("invalid-owner-registration");
    }
    const identity = deviceLabOwnerFromProjectMountPath(registration.projectMountPath, profile as string | undefined);
    if (!identity
        || identity.ownerId !== expectedOwnerId
        || identity.ownerBasis !== registration.ownerBasis
        || deviceBrokerHostProjectMountPath(registration.hostProjectPath) !== registration.projectMountPath) {
        throw new Error("invalid-owner-registration");
    }
    return registration as DeviceBrokerOwnerRegistration;
}

function readDeviceBrokerOwnerRegistration(ownerId: string): DeviceBrokerOwnerRegistration | null {
    if (!inspectDeviceBrokerOwnerRegistrationDirectory()) return null;
    return readDeviceLabStateFile(
        deviceBrokerOwnerRegistrationFile(ownerId),
        (value) => validateDeviceBrokerOwnerRegistration(value, ownerId),
        "device-broker-owner-registration",
        DEVICE_BROKER_OWNER_REGISTRATION_FILE_LIMIT_BYTES,
    );
}

export function registerDeviceBrokerOwner(cwd: string, profile?: string, expectedOwnerId?: string): DeviceBrokerOwnerRegistration {
    const hostProjectPath = resolve(cwd);
    const projectMountPath = deviceLabProjectMountPath(hostProjectPath);
    const identity = deviceLabOwnerFromProjectMountPath(projectMountPath, profile);
    if (!identity || (expectedOwnerId !== undefined && identity.ownerId !== expectedOwnerId)) {
        throw new Error("device-broker-owner-registration-mismatch");
    }
    ensureDeviceBrokerOwnerRegistrationDirectory();
    const file = deviceBrokerOwnerRegistrationFile(identity.ownerId);
    const registration: DeviceBrokerOwnerRegistration = {
        version: 1,
        ownerId: identity.ownerId,
        ownerBasis: identity.ownerBasis,
        projectMountPath: identity.projectMountPath,
        hostProjectPath,
        profile: identity.profile ?? null,
        registeredAt: new Date().toISOString(),
    };
    return withSharedMutationLock(`${file}.lock`, () => {
        const existing = readDeviceBrokerOwnerRegistration(identity.ownerId);
        if (existing
            && existing.ownerBasis === registration.ownerBasis
            && existing.projectMountPath === registration.projectMountPath
            && existing.profile === registration.profile) return existing;
        writeJsonFileAtomically(file, registration);
        return registration;
    }, { waitMs: DEVICE_BROKER_AUTH_LOCK_WAIT_MS, staleMs: DEVICE_BROKER_AUTH_LOCK_STALE_MS });
}

export function deviceBrokerOwnerToken(ownerId: string): string {
    const secret = deviceBrokerOwnerSecret(ownerId);
    return createHash("sha256").update(`${DEVICE_BROKER_NAME}:owner:${ownerId}:secret:${secret}`).digest("hex");
}

function readBoundedUtf8Descriptor(descriptor: number, limitBytes: number): string {
    const buffer = Buffer.allocUnsafe(limitBytes + 1);
    let total = 0;
    while (total <= limitBytes) {
        const count = readSync(descriptor, buffer, total, buffer.length - total, null);
        if (count === 0) return buffer.subarray(0, total).toString("utf8");
        total += count;
    }
    throw new Error("control-state-file-too-large");
}

function readDeviceBrokerOwnerSecret(ownerId: string): string | null {
    const file = deviceBrokerAuthSecretFile(ownerId);
    let fd: number | null = null;
    try {
        if (!inspectDeviceBrokerAuthDirectory()) return null;
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        fd = openSync(file, fsConstants.O_RDONLY | noFollow);
        const stat = fstatSync(fd);
        const pathStat = lstatSync(file);
        if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() || stat.nlink !== 1
            || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) return null;
        if (stat.size > DEVICE_BROKER_AUTH_FILE_LIMIT_BYTES) return null;
        const parsed = JSON.parse(readBoundedUtf8Descriptor(fd, DEVICE_BROKER_AUTH_FILE_LIMIT_BYTES)) as { ownerId?: unknown; secret?: unknown };
        if (parsed.ownerId !== ownerId || typeof parsed.secret !== "string" || !/^[a-f0-9]{64}$/.test(parsed.secret)) return null;
        try { fchmodSync(fd, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
        return parsed.secret;
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try { closeSync(fd); } catch { /* best effort after a read failure */ }
        }
    }
}

function existingDeviceBrokerOwnerToken(ownerId: string): string | null {
    const secret = readDeviceBrokerOwnerSecret(ownerId);
    return secret
        ? createHash("sha256").update(`${DEVICE_BROKER_NAME}:owner:${ownerId}:secret:${secret}`).digest("hex")
        : null;
}

function deviceBrokerAuthDirectoryChain(): string[] {
    const root = brokerRoot();
    return [root, join(root, "broker"), join(root, "broker", "auth")];
}

function inspectDeviceBrokerAuthDirectory(): boolean {
    for (const directory of deviceBrokerAuthDirectoryChain()) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw new Error("device-broker-auth-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("device-broker-auth-directory-invalid");
        }
    }
    return true;
}

function ensureDeviceBrokerAuthDirectory(): void {
    const [root, ...children] = deviceBrokerAuthDirectoryChain();
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("device-broker-auth-directory-create-failed");
    }
    for (const directory of [root, ...children]) {
        if (directory !== root) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("device-broker-auth-directory-create-failed");
            }
        }
        let stat;
        try {
            stat = lstatSync(directory);
        } catch {
            throw new Error("device-broker-auth-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("device-broker-auth-directory-invalid");
        }
    }
}

function deviceBrokerLogDirectoryChain(): string[] {
    const root = brokerRoot();
    return [root, join(root, "broker"), join(root, "broker", "logs")];
}

function ensureDeviceBrokerLogDirectory(): void {
    const [root, ...children] = deviceBrokerLogDirectoryChain();
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("host-broker-log-directory-create-failed");
    }
    for (const directory of [root, ...children]) {
        if (directory !== root) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("host-broker-log-directory-create-failed");
            }
        }
        try {
            const stat = lstatSync(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("host-broker-log-directory-invalid");
        } catch (error) {
            if (error instanceof Error && error.message === "host-broker-log-directory-invalid") throw error;
            throw new Error("host-broker-log-directory-read-failed");
        }
    }
}

function createHostBrokerLogFile(): { path: string; descriptor: number } {
    ensureDeviceBrokerLogDirectory();
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const path = join(brokerRoot(), "broker", "logs", `host-broker-${Date.now()}-${randomBytes(8).toString("hex")}.log`);
        let descriptor: number | null = null;
        try {
            descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
            const opened = fstatSync(descriptor);
            const current = lstatSync(path);
            if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.nlink !== 1 || current.nlink !== 1
                || (opened.dev !== 0 && current.dev !== 0 && opened.dev !== current.dev)
                || (opened.ino !== 0 && current.ino !== 0 && opened.ino !== current.ino)) {
                throw new Error("host-broker-log-file-invalid");
            }
            try { fchmodSync(descriptor, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
            return { path, descriptor };
        } catch (error) {
            if (descriptor !== null) closeSync(descriptor);
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            if (error instanceof Error && error.message === "host-broker-log-file-invalid") throw error;
            throw new Error("host-broker-log-file-create-failed");
        }
    }
    throw new Error("host-broker-log-file-create-failed");
}

function removeAbandonedDeviceBrokerAuthArtifacts(file: string): void {
    const prefix = `${basename(file)}.`;
    let directory: ReturnType<typeof opendirSync> | null = null;
    try {
        directory = opendirSync(dirname(file));
        let entryCount = 0;
        while (entryCount < DEVICE_BROKER_AUTH_DIRECTORY_ENTRY_LIMIT) {
            const entry = directory.readSync();
            if (!entry) break;
            entryCount += 1;
            if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.startsWith(prefix) || !/\.(?:tmp|invalid)$/.test(entry.name)) continue;
            rmSync(join(dirname(file), entry.name), { force: true });
        }
    } catch {
        // Auth provisioning can continue when stale-artifact cleanup is unavailable.
    } finally {
        if (directory) {
            try { directory.closeSync(); } catch { /* best effort after cleanup */ }
        }
    }
}

function quarantineInvalidDeviceBrokerAuthFile(file: string): string | null {
    const quarantined = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.invalid`;
    try {
        renameSync(file, quarantined);
        return quarantined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export function deviceBrokerAuthSecretFile(ownerId: string): string {
    if (!/^[a-f0-9]{16}$/.test(ownerId)) throw new Error("invalid-owner-id");
    return join(brokerRoot(), "broker", "auth", `${ownerId}.json`);
}

export function deviceBrokerOwnerSecret(ownerId: string): string {
    const file = deviceBrokerAuthSecretFile(ownerId);
    if (inspectDeviceBrokerAuthDirectory()) {
        const existing = readDeviceBrokerOwnerSecret(ownerId);
        if (existing) return existing;
    }

    const lockFile = `${file}.lock`;
    ensureDeviceBrokerAuthDirectory();
    try {
        return withSharedMutationLock(lockFile, () => {
            const concurrent = readDeviceBrokerOwnerSecret(ownerId);
            if (concurrent) return concurrent;
            removeAbandonedDeviceBrokerAuthArtifacts(file);
            const quarantined = quarantineInvalidDeviceBrokerAuthFile(file);

            try {
                const secret = randomBytes(32).toString("hex");
                writeJsonFileAtomically(file, {
                    ownerId,
                    secret,
                    createdAt: new Date().toISOString(),
                    version: 1,
                });
                return secret;
            } finally {
                if (quarantined) rmSync(quarantined, { recursive: true, force: true });
            }
        }, { waitMs: DEVICE_BROKER_AUTH_LOCK_WAIT_MS, staleMs: DEVICE_BROKER_AUTH_LOCK_STALE_MS });
    } catch (error) {
        if ((error as Error & { code?: string }).code === "shared-mutation-lock-timeout") {
            throw new Error("device-broker-auth-lock-timeout");
        }
        throw error;
    }
}

function normalizeBrokerOptions(options: DeviceBrokerOptions = {}): NormalizedBrokerOptions {
    const cwd = options.cwd || process.cwd();
    const host = options.host || DEVICE_BROKER_DEFAULT_HOST;
    const port = Number.isInteger(options.port) ? Number(options.port) : DEVICE_BROKER_DEFAULT_PORT;
    const startedAt = options.startedAt || new Date().toISOString();
    const commandTimeoutMs = Number.isFinite(options.commandTimeoutMs)
        ? Math.min(30000, Math.max(1, Number(options.commandTimeoutMs)))
        : DEVICE_BROKER_COMMAND_TIMEOUT_MS;
    const requestBodyTimeoutMs = Number.isFinite(options.requestBodyTimeoutMs)
        ? Math.min(30000, Math.max(1, Number(options.requestBodyTimeoutMs)))
        : DEVICE_BROKER_REQUEST_BODY_TIMEOUT_MS;
    return {
        cwd,
        profile: options.profile,
        host,
        port,
        startedAt,
        providerPaths: options.providerPaths || {},
        commandTimeoutMs,
        requestBodyTimeoutMs,
        commandRunner: options.commandRunner || defaultProviderCommandRunner,
        deviceToolRunner: options.deviceToolRunner || defaultBrokerDeviceToolRunner,
        windowsDeviceArtifactCleaner: options.windowsDeviceArtifactCleaner || cleanupBrokerWindowsDeviceArtifacts,
        usesDefaultCommandRunner: !options.commandRunner,
        platform: options.platform || process.platform,
        cliPath: options.cliPath || process.argv[1] || "ccc",
        portProcessResolver: options.portProcessResolver || discoverBrokerPortProcess,
        strictAppiumPortOwnership: !options.commandRunner || options.portProcessResolver !== undefined,
    };
}

function boundedHostBrokerRawText(text: string): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= DEVICE_BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES) return text;
    const suffix = "...[truncated]";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    let prefix = bytes.subarray(0, DEVICE_BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES - suffixBytes).toString("utf8");
    while (Buffer.byteLength(prefix, "utf8") + suffixBytes > DEVICE_BROKER_INVALID_RESPONSE_RAW_LIMIT_BYTES) {
        prefix = prefix.slice(0, -1);
    }
    return `${prefix}${suffix}`;
}

export async function readHostBrokerHttpJson(response: Response, maxBytes: number) {
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false as const, error: "broker-redirect-disallowed", body: null, maxBytes };
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
        if (BigInt(declaredLength) > BigInt(maxBytes)) {
            await response.body?.cancel().catch(() => undefined);
            return { ok: false as const, error: "broker-response-too-large", body: null, declaredBytes: declaredLength, maxBytes };
        }
    }
    if (!response.body) {
        return { ok: false as const, error: "invalid-broker-json", body: null, receivedBytes: 0, maxBytes };
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return { ok: false as const, error: "broker-response-too-large", body: null, receivedBytes: total, maxBytes };
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }

    const text = Buffer.concat(chunks, total).toString("utf8");
    try {
        const body: unknown = text ? JSON.parse(text) : null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("broker response is not an object");
        return { ok: true as const, body: body as Record<string, unknown>, receivedBytes: total, maxBytes };
    } catch {
        return {
            ok: false as const,
            error: "invalid-broker-json",
            body: { raw: boundedHostBrokerRawText(text) },
            receivedBytes: total,
            maxBytes,
        };
    }
}

async function probeHostBrokerHealth(host: string, port: number, timeoutMs: number) {
    const endpoint = `http://${host}:${port}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const startedAt = Date.now();
    try {
        const response = await fetch(endpoint, { signal: controller.signal, redirect: "manual" });
        const parsed = await readHostBrokerHttpJson(response, DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
        const body = parsed.body as Record<string, unknown> | null;
        return {
            endpoint,
            available: parsed.ok && response.ok && body?.ok === true && body?.name === DEVICE_BROKER_NAME,
            status: response.status,
            body,
            ...(!parsed.ok ? { error: parsed.error, maxBytes: parsed.maxBytes } : {}),
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            endpoint,
            available: false,
            status: null,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function probeHostBrokerOwnerResolve(host: string, port: number, timeoutMs: number, cwd: string, expectedOwnerId: string, profile?: string) {
    const endpoint = `http://${host}:${port}/v1/owner/resolve`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const startedAt = Date.now();
    try {
        const response = await fetch(endpoint, {
            method: "POST",
            signal: controller.signal,
            redirect: "manual",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                projectMountPath: deviceLabProjectMountPath(cwd),
                profile: profile ?? null,
            }),
        });
        const parsed = await readHostBrokerHttpJson(response, DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
        const body = parsed.body as Record<string, unknown> | null;
        const resolvedOwnerId = parsed.ok && body?.result && typeof body.result === "object"
            ? (body.result as { ownerId?: unknown }).ownerId
            : null;
        const ownerCompatible = resolvedOwnerId === expectedOwnerId;
        return {
            endpoint,
            available: parsed.ok && response.ok && body?.ok === true,
            compatible: parsed.ok && response.ok && typeof resolvedOwnerId === "string" && /^[a-f0-9]{16}$/.test(resolvedOwnerId) && ownerCompatible,
            status: response.status,
            body,
            ownerId: typeof resolvedOwnerId === "string" ? resolvedOwnerId : null,
            expectedOwnerId,
            ownerCompatible,
            ...(!parsed.ok ? { error: parsed.error, maxBytes: parsed.maxBytes } : {}),
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            endpoint,
            available: false,
            compatible: false,
            status: null,
            body: null,
            ownerId: null,
            expectedOwnerId,
            ownerCompatible: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function probeHostBrokerStatus(host: string, port: number, timeoutMs: number, cwd: string, expectedOwnerId: string, profile?: string) {
    const endpoint = `http://${host}:${port}/status`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const startedAt = Date.now();
    let ownerResolve: Awaited<ReturnType<typeof probeHostBrokerOwnerResolve>> | null = null;
    try {
        const response = await fetch(endpoint, { signal: controller.signal, redirect: "manual" });
        const parsed = await readHostBrokerHttpJson(response, DEVICE_BROKER_CONTROL_RESPONSE_LIMIT_BYTES);
        const body = parsed.body as Record<string, unknown> | null;
        const implemented = parsed.ok && body?.broker && typeof body.broker === "object"
            ? (body.broker as { implemented?: unknown }).implemented
            : null;
        const capabilities = Array.isArray(implemented) ? implemented.map(String) : [];
        const missingCapabilities = DEVICE_BROKER_REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability));
        const broker = parsed.ok && body?.broker && typeof body.broker === "object"
            ? body.broker as { version?: unknown }
            : null;
        const brokerVersion = typeof broker?.version === "string" ? broker.version : null;
        const versionComparison = compareBrokerVersions(brokerVersion, CLI_VERSION);
        const versionCompatible = versionComparison === 0;
        ownerResolve = await probeHostBrokerOwnerResolve(host, port, timeoutMs, cwd, expectedOwnerId, profile);
        return {
            endpoint,
            available: parsed.ok && response.ok && body?.ok === true,
            compatible: parsed.ok && response.ok && missingCapabilities.length === 0 && versionCompatible && ownerResolve.compatible,
            status: response.status,
            body,
            missingCapabilities,
            version: brokerVersion,
            expectedVersion: CLI_VERSION,
            versionCompatible,
            versionComparison,
            brokerNewerThanCli: versionComparison !== null && versionComparison > 0,
            ownerResolve,
            ...(!parsed.ok ? { error: parsed.error, maxBytes: parsed.maxBytes } : {}),
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        return {
            endpoint,
            available: false,
            compatible: false,
            status: null,
            body: null,
            missingCapabilities: DEVICE_BROKER_REQUIRED_CAPABILITIES,
            version: null,
            expectedVersion: CLI_VERSION,
            versionCompatible: false,
            ownerResolve,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
        };
    } finally {
        clearTimeout(timer);
    }
}

function compareBrokerVersions(left: string | null, right: string): number | null {
    if (left === right) return 0;
    const parse = (value: string | null) => {
        const match = value?.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
        return match ? {
            core: match.slice(1, 4).map(Number),
            prerelease: match[4]?.split(".") || [],
        } : null;
    };
    const leftParts = parse(left);
    const rightParts = parse(right);
    if (!leftParts || !rightParts) return null;
    for (let index = 0; index < 3; index += 1) {
        if (leftParts.core[index] !== rightParts.core[index]) return leftParts.core[index] > rightParts.core[index] ? 1 : -1;
    }
    if (leftParts.prerelease.length === 0 || rightParts.prerelease.length === 0) {
        if (leftParts.prerelease.length === rightParts.prerelease.length) return 0;
        return leftParts.prerelease.length === 0 ? 1 : -1;
    }
    const identifiers = Math.max(leftParts.prerelease.length, rightParts.prerelease.length);
    for (let index = 0; index < identifiers; index += 1) {
        const leftIdentifier = leftParts.prerelease[index];
        const rightIdentifier = rightParts.prerelease[index];
        if (leftIdentifier === undefined || rightIdentifier === undefined) return leftIdentifier === undefined ? -1 : 1;
        if (leftIdentifier === rightIdentifier) continue;
        const leftNumeric = /^\d+$/.test(leftIdentifier);
        const rightNumeric = /^\d+$/.test(rightIdentifier);
        if (leftNumeric && rightNumeric) return BigInt(leftIdentifier) > BigInt(rightIdentifier) ? 1 : -1;
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    return 0;
}

export const compareBrokerVersionsForTest = compareBrokerVersions;

async function stopIncompatibleHostBroker(
    ownerId: string,
    port: number,
    compatibility: unknown,
    platform: NodeJS.Platform = process.platform,
    portProcessResolver: BrokerPortProcessResolver = discoverBrokerPortProcess,
    expectedCliPath?: string,
) {
    if (compatibility && typeof compatibility === "object"
        && (compatibility as { brokerNewerThanCli?: unknown }).brokerNewerThanCli === true) {
        return {
            stopped: false,
            restartable: false,
            reason: "broker-newer-than-cli",
            compatibility,
        };
    }
    const persistedRuntime = readHostBrokerRuntime();
    const statusRuntime = hostBrokerRuntimeFromStatus(ownerId, port, compatibility);
    if (typeof statusRuntime?.platform === "string" && statusRuntime.platform !== platform) {
        return {
            stopped: false,
            restartable: false,
            reason: "runtime-host-platform-mismatch",
            runtime: statusRuntime,
            compatibility,
            currentPlatform: platform,
            hostPlatform: statusRuntime.platform,
        };
    }
    const portRuntime = hostBrokerRuntimeFromPortProcess(
        ownerId,
        port,
        compatibility,
        platform,
        portProcessResolver,
        persistedRuntime,
        statusRuntime,
        expectedCliPath,
    );
    if (!portRuntime) {
        return {
            stopped: false,
            restartable: false,
            reason: "unverified-broker-port-process",
            persistedRuntime,
            statusRuntime,
            compatibility,
        };
    }
    const pid = Number(portRuntime.pid);
    const persistedMatchesPort = Number(persistedRuntime?.pid) === pid && Number(persistedRuntime?.port) === port;
    const statusMatchesPort = Number(statusRuntime?.pid) === pid && Number(statusRuntime?.port) === port;
    const runtime = {
        ...(persistedMatchesPort ? persistedRuntime : {}),
        ...(statusMatchesPort ? statusRuntime : {}),
        ...portRuntime,
    };
    const usedStatusRuntime = statusMatchesPort && !persistedMatchesPort;
    if (typeof runtime.platform === "string" && runtime.platform !== platform) {
        return {
            stopped: false,
            restartable: false,
            reason: "runtime-host-platform-mismatch",
            runtime,
            compatibility,
            currentPlatform: platform,
            hostPlatform: runtime.platform,
        };
    }
    if (!processIsAlive(pid)) {
        removeHostBrokerRuntime();
        return { stopped: true, restartable: true, reason: "runtime-pid-not-alive", runtime, compatibility };
    }
    const expectedIdentity = runtime.processIdentity as DeviceRuntimeProcessIdentity | undefined;
    const expectedStartToken = typeof runtime.processStartToken === "string"
        ? runtime.processStartToken
        : null;
    const readCurrentIdentity = (value: number) => {
        const current = portProcessResolver(port, platform);
        if (!current || current.pid !== value) return null;
        return current.processIdentity || readDeviceRuntimeProcessIdentity(value, { platform });
    };
    const readCurrentStartToken = (value: number) => {
        const current = portProcessResolver(port, platform);
        if (!current || current.pid !== value) return null;
        return current.processStartToken
            || current.processIdentity?.startToken
            || readDeviceRuntimeProcessStartToken(value, { platform });
    };
    const identityOptions = { platform, readIdentity: readCurrentIdentity };
    const initialIdentity = expectedIdentity
        ? inspectDeviceRuntimeProcessIdentity(expectedIdentity, pid, identityOptions)
        : null;
    const initialStartToken = expectedStartToken ? readCurrentStartToken(pid) : null;
    if ((initialIdentity && initialIdentity.status !== "match")
        || (!initialIdentity && (!expectedStartToken || initialStartToken !== expectedStartToken))) {
        const status = initialIdentity?.status || (initialStartToken ? "mismatch" : "unavailable");
        return {
            stopped: false,
            restartable: false,
            reason: status === "exited"
                ? "runtime-pid-not-alive"
                : status === "mismatch"
                    ? "runtime-process-identity-mismatch"
                    : "runtime-process-identity-unavailable",
            runtime,
            compatibility,
            observation: initialIdentity || { status, currentStartToken: initialStartToken },
        };
    }
    if (process.platform === "win32") {
        const windowsIdentity = expectedIdentity
            ? inspectDeviceRuntimeProcessIdentity(expectedIdentity, pid, identityOptions)
            : null;
        const windowsStartToken = expectedStartToken ? readCurrentStartToken(pid) : null;
        if ((windowsIdentity && windowsIdentity.status !== "match")
            || (!windowsIdentity && windowsStartToken !== expectedStartToken)) {
            const status = windowsIdentity?.status || (windowsStartToken ? "mismatch" : "unavailable");
            return {
                stopped: false,
                restartable: false,
                reason: `runtime-process-identity-${status}`,
                runtime,
                compatibility,
                observation: windowsIdentity || { status, currentStartToken: windowsStartToken },
            };
        }
        const stopped = terminateWindowsProcessTree(pid, expectedIdentity, false, expectedStartToken || undefined);
        if (!stopped.ok) {
            return { stopped: false, restartable: false, reason: "runtime-stop-failed", runtime, compatibility, detail: stopped.error };
        }
        removeHostBrokerRuntime();
        return {
            stopped: true,
            restartable: true,
            reason: usedStatusRuntime
                ? "status-runtime-incompatible-contract"
                : portRuntime
                    ? "port-runtime-incompatible-contract"
                    : "runtime-incompatible-contract",
            runtime,
            compatibility,
            detail: stopped,
        };
    }
    try {
        const termIdentity = inspectDeviceRuntimeProcessIdentity(expectedIdentity, pid, identityOptions);
        if (termIdentity.status !== "match") {
            return { stopped: false, restartable: false, reason: `runtime-process-identity-${termIdentity.status}`, runtime, compatibility, observation: termIdentity };
        }
        process.kill(pid, "SIGTERM");
        const exited = await waitForProcessExit(pid, 1500);
        if (!exited) {
            const killIdentity = inspectDeviceRuntimeProcessIdentity(expectedIdentity, pid, identityOptions);
            if (killIdentity.status !== "match") {
                if (killIdentity.status === "exited") {
                    removeHostBrokerRuntime();
                    return { stopped: true, restartable: true, reason: "runtime-pid-gone-after-signal", runtime, compatibility };
                }
                return { stopped: false, restartable: false, reason: `runtime-process-identity-${killIdentity.status}`, runtime, compatibility, observation: killIdentity };
            }
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // The process may have exited after the SIGTERM wait.
            }
        }
        const killed = exited || await waitForProcessExit(pid, 500);
        if (!killed) {
            return { stopped: false, restartable: false, reason: "runtime-pid-still-alive", runtime, compatibility };
        }
        removeHostBrokerRuntime();
        return {
            stopped: true,
            restartable: true,
            reason: usedStatusRuntime
                ? "status-runtime-incompatible-contract"
                : portRuntime
                    ? "port-runtime-incompatible-contract"
                    : "runtime-incompatible-contract",
            runtime,
            compatibility,
        };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!processIsAlive(pid)) {
            removeHostBrokerRuntime();
            return { stopped: true, restartable: true, reason: "runtime-pid-gone-after-signal", runtime, compatibility, detail };
        }
        return { stopped: false, restartable: false, reason: "runtime-stop-failed", runtime, compatibility, detail };
    }
}

function compatibilityBrokerRecord(compatibility: unknown): Record<string, unknown> | null {
    if (!compatibility || typeof compatibility !== "object") return null;
    const body = (compatibility as { body?: unknown }).body;
    const broker = body && typeof body === "object" ? (body as { broker?: unknown }).broker : null;
    return broker && typeof broker === "object" ? broker as Record<string, unknown> : null;
}

function hostBrokerRuntimeFromStatus(ownerId: string, port: number, compatibility: unknown): Record<string, unknown> | null {
    const record = compatibilityBrokerRecord(compatibility);
    if (!record) return null;
    const processRecord = record.process && typeof record.process === "object"
        ? record.process as Record<string, unknown>
        : {};
    const serviceManager = record.serviceManager && typeof record.serviceManager === "object"
        ? record.serviceManager as Record<string, unknown>
        : {};
    const serviceCommand = Array.isArray(serviceManager.command) ? serviceManager.command.map(String) : [];
    const cliPath = serviceCommand[1] || null;
    const cwd = cliPath ? cliPath.replace(/[\\/]+dist[\\/]+index\.js$/i, "") : null;
    const pid = Number(processRecord.pid ?? record.pid);
    if (record.name !== DEVICE_BROKER_NAME) return null;
    if (record.mode !== "host-broker-daemon") return null;
    if (record.port !== port) return null;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return {
        name: DEVICE_BROKER_NAME,
        managedBy: "ccc-host-status",
        ownerId: typeof record.ownerId === "string" ? record.ownerId : ownerId,
        pid,
        host: typeof record.host === "string" ? record.host : null,
        probeHost: DEVICE_BROKER_DEFAULT_HOST,
        hostCandidates: hostBrokerProbeCandidates(
            typeof record.host === "string" ? record.host : DEVICE_BROKER_DEFAULT_HOST,
            DEVICE_BROKER_DEFAULT_HOST,
        ),
        port,
        version: typeof record.version === "string" ? record.version : null,
        platform: typeof serviceManager.platform === "string" ? serviceManager.platform : null,
        command: serviceCommand[0] || null,
        args: serviceCommand.slice(1),
        cwd,
        startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
        processStartToken: typeof processRecord.startToken === "string" ? processRecord.startToken : null,
        source: "broker-status",
    };
}

function hostBrokerRuntimeFromPortProcess(
    ownerId: string,
    port: number,
    compatibility: unknown,
    platform: NodeJS.Platform,
    portProcessResolver: BrokerPortProcessResolver,
    persistedRuntime: Record<string, unknown> | null,
    statusRuntime: Record<string, unknown> | null,
    expectedCliPath?: string,
): Record<string, unknown> | null {
    const record = compatibilityBrokerRecord(compatibility);
    const process = portProcessResolver(port, platform);
    if (!process || !Number.isInteger(process.pid) || process.pid <= 0) return null;
    if (statusRuntime && Number(statusRuntime.pid) !== process.pid) return null;
    const commandLine = process.commandLine?.trim() || "";
    const commandLineVerified = isBrokerServeCommandLine(commandLine, port, expectedCliPath);
    const observedStartToken = process.processStartToken
        || process.processIdentity?.startToken
        || readDeviceRuntimeProcessStartToken(process.pid, { platform });
    const persistedStartToken = typeof persistedRuntime?.processStartToken === "string"
        ? persistedRuntime.processStartToken
        : null;
    const statusStartToken = typeof statusRuntime?.processStartToken === "string"
        ? statusRuntime.processStartToken
        : null;
    const persistedMetadataMatches = persistedRuntime?.name === DEVICE_BROKER_NAME
        && persistedRuntime?.managedBy === "ccc-host"
        && Number(persistedRuntime?.pid) === process.pid
        && Number(persistedRuntime?.port) === port;
    const persistedContinuity = !persistedRuntime
        || (persistedMetadataMatches
            && observedStartToken !== null
            && (observedStartToken === persistedStartToken
                || (!persistedStartToken
                    && typeof persistedRuntime.startedAt === "string"
                    && persistedRuntime.startedAt === statusRuntime?.startedAt)));
    const statusMetadataMatches = statusRuntime?.name === DEVICE_BROKER_NAME
        && statusRuntime?.managedBy === "ccc-host-status"
        && Number(statusRuntime?.pid) === process.pid
        && Number(statusRuntime?.port) === port;
    const statusIdentityVerified = statusMetadataMatches
        && observedStartToken !== null
        && observedStartToken === statusStartToken;
    const legacyStatusWithoutToken = (!statusRuntime || statusMetadataMatches)
        && !statusStartToken;
    const legacyPersistedCommandContinuity = !persistedRuntime || persistedMetadataMatches;
    const commandLineTrusted = commandLineVerified
        && persistedContinuity
        && (statusIdentityVerified || (legacyPersistedCommandContinuity && legacyStatusWithoutToken));
    const metadataVerified = commandLine.length === 0
        && Boolean(persistedRuntime)
        && persistedContinuity
        && statusIdentityVerified;
    if (!commandLineTrusted && !metadataVerified) return null;
    const processIdentity = process.processIdentity || readDeviceRuntimeProcessIdentity(process.pid, { platform });
    if (!processIdentity && !metadataVerified) return null;
    return {
        name: DEVICE_BROKER_NAME,
        managedBy: commandLineVerified ? "ccc-host-port" : "ccc-host-port-metadata",
        ownerId,
        pid: process.pid,
        host: typeof record?.host === "string" ? record.host : null,
        port,
        commandLine: commandLine || null,
        ...(processIdentity ? { processIdentity } : {}),
        processStartToken: observedStartToken,
        identitySource: commandLineVerified ? "port-command-line" : "port-pid-plus-runtime-and-status",
    };
}

export const hostBrokerRuntimeFromPortProcessForTest = hostBrokerRuntimeFromPortProcess;

function isBrokerServeCommandLine(commandLine: string, port: number, expectedCliPath?: string): boolean {
    const normalized = commandLine.replace(/["']/g, " ").replace(/\s+/g, " ").trim();
    const normalizedPath = (value: string) => value.replace(/["']/g, "").replace(/\\/g, "/").toLowerCase();
    const commandTokens = Array.from(commandLine.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g), (match) => match[1] ?? match[2] ?? match[3]);
    const expectedPathVerified = !expectedCliPath || (commandTokens.length > 1
        && /(?:^|\/)node(?:\.exe)?$/i.test(normalizedPath(commandTokens[0]))
        && normalizedPath(commandTokens[1]) === normalizedPath(expectedCliPath));
    return /\bdevices\s+broker\s+serve\b/i.test(normalized)
        && (/\bccc(?:\.cmd|\.exe)?\b/i.test(normalized) || /\bnode(?:\.exe)?\b.*\bindex\.js\b/i.test(normalized))
        && new RegExp(`(?:^|\\s)--port(?:=|\\s+)${port}(?:\\s|$)`).test(normalized)
        && expectedPathVerified;
}

function discoverBrokerPortProcess(port: number, platform: NodeJS.Platform): BrokerPortProcess | null {
    if (platform === "linux") return discoverLinuxBrokerPortProcess(port);
    if (platform === "darwin") return discoverCommandBrokerPortProcess("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], "darwin");
    if (platform === "win32") return discoverWindowsBrokerPortProcess(port);
    return null;
}

function discoverLinuxBrokerPortProcess(port: number): BrokerPortProcess | null {
    const portHex = port.toString(16).toUpperCase().padStart(4, "0");
    const inodes = new Set<string>();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        try {
            const lines = readFileSync(file, "utf8").trim().split(/\n/).slice(1);
            for (const line of lines) {
                const fields = line.trim().split(/\s+/);
                const localAddress = fields[1] || "";
                const state = fields[3] || "";
                const inode = fields[9] || "";
                if (state === "0A" && localAddress.split(":").pop() === portHex && inode) inodes.add(inode);
            }
        } catch {
            // /proc may be unavailable from containers or restricted hosts.
        }
    }
    if (inodes.size === 0) return null;
    try {
        for (const pidText of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
            const fdRoot = `/proc/${pidText}/fd`;
            let fds: string[] = [];
            try { fds = readdirSync(fdRoot); } catch { continue; }
            for (const fd of fds) {
                let target = "";
                try { target = readlinkSync(join(fdRoot, fd)); } catch { continue; }
                const match = /^socket:\[(\d+)\]$/.exec(target);
                if (!match || !inodes.has(match[1])) continue;
                const pid = Number(pidText);
                let commandLine = "";
                try { commandLine = readFileSync(`/proc/${pidText}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch { /* ignore */ }
                return { pid, commandLine, processIdentity: readDeviceRuntimeProcessIdentity(pid, { platform: "linux" }) };
            }
        }
    } catch {
        return null;
    }
    return null;
}

function discoverCommandBrokerPortProcess(command: string, args: string[], platform: NodeJS.Platform): BrokerPortProcess | null {
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 1000 });
    if (result.status !== 0 || !result.stdout) return null;
    const pid = platform === "darwin"
        ? Number((result.stdout.match(/^p(\d+)$/m) || [])[1])
        : NaN;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", windowsHide: true, timeout: 1000 });
    return { pid, commandLine: ps.stdout.trim(), processIdentity: readDeviceRuntimeProcessIdentity(pid, { platform }) };
}

export function parseWindowsBrokerNetstatListenerForTest(output: string, port: number): BrokerPortProcess | null {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    for (const line of output.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 5 || fields[0]?.toUpperCase() !== "TCP") continue;
        const localPort = Number(/:(\d+)$/.exec(fields[1] || "")?.[1]);
        const remotePort = Number(/:(\d+)$/.exec(fields[2] || "")?.[1]);
        const pid = Number(fields.at(-1));
        if (localPort === port && remotePort === 0 && Number.isInteger(pid) && pid > 0) {
            return { pid, commandLine: "" };
        }
    }
    return null;
}

function discoverWindowsBrokerPortProcess(port: number): BrokerPortProcess | null {
    const netstatPath = canonicalWindowsSystemExecutablePath("netstat.exe");
    const netstat = netstatPath ? spawnSync(netstatPath, ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
    }) : { status: null, stdout: "" };
    const listener = netstat.status === 0
        ? parseWindowsBrokerNetstatListenerForTest(netstat.stdout || "", port)
        : null;
    if (!listener) return null;
    const powershell = canonicalWindowsPowerShellPath();
    const script = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${listener.pid}"`,
        `$h = Get-Process -Id ${listener.pid} -ErrorAction SilentlyContinue`,
        "if (-not $p -or -not $h) { exit 1 }",
        "[pscustomobject]@{ pid = [int]$p.ProcessId; commandLine = [string]$p.CommandLine; startToken = $h.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
    ].join("; ");
    const result = powershell ? spawnSync(powershell, hiddenWindowsPowerShellArgs(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]), {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
    }) : { status: null, stdout: "" };
    if (result.status === 0 && result.stdout) {
        try {
            const parsed = JSON.parse(result.stdout) as { pid?: unknown; commandLine?: unknown; startToken?: unknown };
            const pid = Number(parsed.pid);
            const commandLine = typeof parsed.commandLine === "string" ? parsed.commandLine.replace(/\r?\n/g, " ").trim() : "";
            const startToken = typeof parsed.startToken === "string" ? `windows:${parsed.startToken}` : "";
            if (pid === listener.pid && commandLine && startToken) {
                return {
                    pid,
                    commandLine,
                    processIdentity: {
                        pid,
                        startToken,
                        commandHash: createHash("sha256").update(commandLine).digest("hex"),
                    },
                    processStartToken: startToken,
                };
            }
        } catch {
            // Fall through to the locale-independent netstat listener lookup.
        }
    }
    return {
        ...listener,
        processIdentity: readDeviceRuntimeProcessIdentity(listener.pid, { platform: "win32" }),
        processStartToken: readDeviceRuntimeProcessStartToken(listener.pid, { platform: "win32" }),
    };
}

function hostBrokerCompatibilityDiagnostics(attempts: unknown[]): string[] {
    const diagnostics: string[] = [];
    for (const attempt of attempts) {
        if (!attempt || typeof attempt !== "object") continue;
        const record = attempt as Record<string, unknown>;
        if (record.reason === "missing-runtime") {
            diagnostics.push("existing broker is not restartable from this container because broker runtime metadata is missing");
        } else if (record.reason === "unverified-broker-port-process") {
            diagnostics.push("existing broker port owner could not be verified as the current CCC broker process");
        } else if (record.reason === "runtime-not-current-ccc-host-port") {
            diagnostics.push("existing broker runtime belongs to a different port");
        } else if (record.reason === "runtime-pid-still-alive") {
            diagnostics.push("existing broker did not stop after automatic restart request");
        } else if (record.reason === "runtime-stop-failed") {
            diagnostics.push(`existing broker restart failed: ${String(record.detail || "unknown error")}`);
        } else if (record.reason === "runtime-host-platform-mismatch") {
            diagnostics.push(`existing broker runs on ${String(record.hostPlatform || "another host platform")} and must be restarted by host CCC, not ${String(record.currentPlatform || "this container")}`);
        } else if (record.reason === "broker-newer-than-cli") {
            diagnostics.push("existing broker is newer than this CCC CLI and will not be downgraded");
        }
        if ("versionCompatible" in record && record.versionCompatible === false) {
            diagnostics.push(`existing broker version ${String(record.version || "unknown")} does not match CLI version ${String(record.expectedVersion || CLI_VERSION)}`);
        }
        const ownerResolve = record.ownerResolve;
        if (ownerResolve && typeof ownerResolve === "object") {
            const ownerRecord = ownerResolve as Record<string, unknown>;
            if (ownerRecord.status === 405) {
                diagnostics.push("existing broker does not support the current owner-resolve POST contract");
            } else if (ownerRecord.ownerCompatible === false && ownerRecord.ownerId) {
                diagnostics.push(`existing broker resolved owner ${String(ownerRecord.ownerId)} instead of ${String(ownerRecord.expectedOwnerId || "current owner")}`);
            } else if (ownerRecord.available === false) {
                diagnostics.push("existing broker owner resolution is unavailable");
            }
        }
    }
    return [...new Set(diagnostics)];
}

function verifiedHostBrokerCapabilities(status: unknown): string[] {
    if (!status || typeof status !== "object") return [];
    const body = (status as { body?: unknown }).body;
    if (!body || typeof body !== "object") return [];
    const broker = (body as { broker?: unknown }).broker;
    if (!broker || typeof broker !== "object") return [];
    const implemented = (broker as { implemented?: unknown }).implemented;
    return Array.isArray(implemented) ? implemented.map(String) : [];
}

function verifiedHostBrokerIdentity(status: unknown): { pid: number; startedAt: string; processStartToken: string | null } | null {
    if (!status || typeof status !== "object") return null;
    const body = (status as { body?: unknown }).body;
    if (!body || typeof body !== "object") return null;
    const broker = (body as { broker?: unknown }).broker;
    if (!broker || typeof broker !== "object") return null;
    const record = broker as { process?: unknown; startedAt?: unknown };
    const processRecord = record.process && typeof record.process === "object"
        ? record.process as { pid?: unknown; startToken?: unknown }
        : null;
    const pid = Number(processRecord?.pid);
    const startedAt = typeof record.startedAt === "string" ? record.startedAt : "";
    const processStartToken = typeof processRecord?.startToken === "string"
        ? processRecord.startToken
        : "";
    return Number.isInteger(pid) && pid > 0 && startedAt && processStartToken
        ? { pid, startedAt, processStartToken }
        : null;
}

export const verifiedHostBrokerIdentityForTest = verifiedHostBrokerIdentity;

export function verifySpawnedHostBrokerListenerForTest(
    pid: number | null,
    spawnedIdentity: DeviceRuntimeProcessIdentity | null,
    listener: BrokerPortProcess | null,
    listenerIdentity: DeviceRuntimeProcessIdentity | null,
    port: number,
    cliPath: string,
    startTokens: {
        spawned?: string | null;
        listener?: string | null;
        status?: string | null;
    } = {},
): boolean {
    const tokenEvidenceProvided = Boolean(startTokens.spawned || startTokens.listener || startTokens.status);
    const startTokensVerified = !tokenEvidenceProvided || Boolean(
        startTokens.spawned
        && startTokens.spawned === startTokens.listener
        && startTokens.spawned === startTokens.status,
    );
    const commandLineIdentityVerified = Boolean(
        pid
        && spawnedIdentity
        && listener?.pid === pid
        && listenerIdentity
        && deviceRuntimeProcessIdentityMatches(spawnedIdentity, listenerIdentity)
        && isBrokerServeCommandLine(listener.commandLine?.trim() || "", port, cliPath)
        && startTokensVerified,
    );
    const redactedStartTokenVerified = Boolean(
        pid
        && listener?.pid === pid
        && !listener.commandLine?.trim()
        && startTokens.spawned
        && startTokens.spawned === startTokens.listener
        && startTokens.spawned === startTokens.status,
    );
    return commandLineIdentityVerified || redactedStartTokenVerified;
}

function retainRecentBrokerAttempt(attempts: unknown[], attempt: unknown) {
    attempts.push(attempt);
    if (attempts.length > DEVICE_BROKER_STARTUP_ATTEMPT_HISTORY_LIMIT) attempts.shift();
}

export const retainRecentBrokerAttemptForTest = retainRecentBrokerAttempt;

async function waitForHostBrokerReady(host: string, port: number, timeoutMs: number, cwd: string, expectedOwnerId: string, profile?: string) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const attempts: unknown[] = [];
    while (Date.now() <= deadline) {
        const remaining = Math.min(250, Math.max(1, deadline - Date.now()));
        const health = await probeHostBrokerHealth(host, port, remaining);
        retainRecentBrokerAttempt(attempts, health);
        if (health.available) {
            const status = await probeHostBrokerStatus(host, port, remaining, cwd, expectedOwnerId, profile);
            retainRecentBrokerAttempt(attempts, status);
            if (status.compatible) return { available: true, compatible: true, attempts, selected: status };
        }
        await sleep(50);
    }
    return { available: false, compatible: false, attempts, selected: null };
}

export async function ensureHostDeviceBroker(options: HostDeviceBrokerOptions = {}) {
    if (options.enabled === false || process.env.CCC_DEVICE_BROKER_AUTO_START === "0") {
        return { ok: true, skipped: true, reason: "disabled" };
    }

    const bindHost = options.bindHost || options.host || DEVICE_BROKER_DEFAULT_HOST;
    const initial = normalizeBrokerOptions({ ...options, host: bindHost });
    const ownerId = options.ownerId || deviceBrokerOwnerId(initial.cwd, options.profile);
    const runtime = readHostBrokerRuntime();
    const runtimePort = runtime?.managedBy === "ccc-host"
        && Number.isInteger(runtime.port)
        ? Number(runtime.port)
        : null;
    const port = !Number.isInteger(options.port) && runtimePort !== null ? runtimePort : initial.port;
    const normalized = port === initial.port ? initial : { ...initial, port };
    const probeHost = options.probeHost || DEVICE_BROKER_DEFAULT_HOST;
    const probeTimeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Number(options.timeoutMs)) : 250;
    const startupTimeoutMs = Number.isFinite(options.startupTimeoutMs)
        ? Math.max(1, Number(options.startupTimeoutMs))
        : DEVICE_BROKER_AUTO_START_TIMEOUT_MS;

    registerDeviceBrokerOwner(normalized.cwd, options.profile);
    deviceBrokerOwnerToken(ownerId);

    const before = await probeHostBrokerHealth(probeHost, port, probeTimeoutMs);
    const prelaunchAttempts: unknown[] = [before];
    const portProcessResolver = options.portProcessResolver || discoverBrokerPortProcess;
    const processIdentityReader = options.processIdentityReader
        || ((pid: number, platform: NodeJS.Platform) => readDeviceRuntimeProcessIdentity(pid, { platform }));
    const processStartTokenReader = options.processStartTokenReader
        || ((pid: number, platform: NodeJS.Platform) => readDeviceRuntimeProcessStartToken(pid, { platform }));
    if (before.available) {
        const compatibility = await probeHostBrokerStatus(probeHost, port, probeTimeoutMs, normalized.cwd, ownerId, options.profile);
        prelaunchAttempts.push(compatibility);
        const runtime = readHostBrokerRuntime();
        const statusRuntime = hostBrokerRuntimeFromStatus(ownerId, port, compatibility);
        const verifiedRuntime = compatibility.compatible
            ? hostBrokerRuntimeFromPortProcess(
                ownerId,
                port,
                compatibility,
                normalized.platform,
                portProcessResolver,
                runtime,
                statusRuntime,
                normalized.cliPath,
            )
            : null;
        const verifiedIdentity = verifiedHostBrokerIdentity(compatibility);
        prelaunchAttempts.push({ reason: verifiedRuntime ? "compatible-broker-process-verified" : "compatible-broker-process-unverified", runtime: verifiedRuntime });
        if (compatibility.compatible && (hostBrokerRuntimeMatchesRequiredBindHost(runtime, port, bindHost)
            || hostBrokerStatusMatchesRequiredBindHost(compatibility, port, bindHost))
            && verifiedRuntime
            && verifiedIdentity?.pid === Number(verifiedRuntime.pid)) {
            writeHostBrokerRuntime({
                ...(runtime || {}),
                ...(statusRuntime || {}),
                ...verifiedRuntime,
                name: DEVICE_BROKER_NAME,
                managedBy: "ccc-host",
                ownerId,
                pid: verifiedIdentity.pid,
                host: typeof verifiedRuntime.host === "string" ? verifiedRuntime.host : bindHost,
                probeHost,
                port,
                startedAt: verifiedIdentity.startedAt,
                processStartToken: verifiedIdentity.processStartToken,
            });
            return {
                ok: true,
                ownerId,
                launched: false,
                reused: true,
                host: bindHost,
                probeHost,
                port,
                verifiedCapabilities: verifiedHostBrokerCapabilities(compatibility),
                verifiedBrokerPid: verifiedIdentity.pid,
                verifiedBrokerStartedAt: verifiedIdentity.startedAt,
                verifiedBrokerProcessStartToken: verifiedIdentity.processStartToken,
                attempts: prelaunchAttempts,
            };
        }
        const restartReason = compatibility.compatible
            ? { ...(compatibility as Record<string, unknown>), runtimeBindHostMismatch: true, expectedHost: bindHost, runtimeHost: runtime?.host ?? null }
            : compatibility;
        const stopped = await stopIncompatibleHostBroker(ownerId, port, restartReason, normalized.platform, portProcessResolver, normalized.cliPath);
        prelaunchAttempts.push(stopped);
        if (!stopped.restartable) {
            return {
                ok: false,
                ownerId,
                launched: false,
                reused: false,
                error: "host-broker-incompatible",
                host: bindHost,
                probeHost,
                port,
                attempts: prelaunchAttempts,
                diagnostics: hostBrokerCompatibilityDiagnostics(prelaunchAttempts),
            };
        }
    } else {
        const listener = portProcessResolver(port, normalized.platform);
        if (listener) {
            const stopped = await stopIncompatibleHostBroker(
                ownerId,
                port,
                { ...before, reason: "unhealthy-broker-port-owner" },
                normalized.platform,
                portProcessResolver,
                normalized.cliPath,
            );
            prelaunchAttempts.push(stopped);
            if (!stopped.restartable) {
                return {
                    ok: false,
                    ownerId,
                    launched: false,
                    reused: false,
                    error: "host-broker-incompatible",
                    host: bindHost,
                    probeHost,
                    port,
                    attempts: prelaunchAttempts,
                    diagnostics: hostBrokerCompatibilityDiagnostics(prelaunchAttempts),
                };
            }
        }
    }

    const command = process.execPath;
    const args = [normalized.cliPath, "devices", "broker", "serve", "--host", bindHost, "--port", String(port)];
    let logPath = join(brokerRoot(), "broker", "logs", "host-broker-pending.log");
    const spawnImpl = options.spawnImpl || spawn;
    const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env || {}) };
    if (options.profile && !env.CCC_PROFILE) env.CCC_PROFILE = options.profile;

    let logFd: number | null = null;
    try {
        const log = createHostBrokerLogFile();
        logPath = log.path;
        logFd = log.descriptor;
        const child = spawnImpl(command, args, {
            cwd: normalized.cwd,
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env,
            windowsHide: true,
        });
        child.once("error", () => { /* readiness probe below reports startup failure */ });
        child.once("exit", () => { /* readiness probe below reports early exit as timeout */ });
        const pid = child.pid || null;
        let spawnedProcessIdentity = pid ? processIdentityReader(pid, normalized.platform) : null;
        let spawnedProcessStartToken = pid ? processStartTokenReader(pid, normalized.platform) : null;
        for (let attempt = 0; pid && (!spawnedProcessIdentity || !spawnedProcessStartToken) && attempt < 20; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            spawnedProcessIdentity ||= processIdentityReader(pid, normalized.platform);
            spawnedProcessStartToken ||= processStartTokenReader(pid, normalized.platform);
        }
        child.unref();

        const ready = await waitForHostBrokerReady(probeHost, port, startupTimeoutMs, normalized.cwd, ownerId, options.profile);
        if (!ready.available) {
            let startupCleanup: Record<string, unknown> = { attempted: false, reason: "spawned-process-identity-unavailable" };
            if (pid) {
                const observation = inspectDeviceRuntimeProcessIdentity(spawnedProcessIdentity, pid, {
                    platform: normalized.platform,
                    readIdentity: (value) => processIdentityReader(value, normalized.platform),
                });
                const currentStartToken = spawnedProcessStartToken
                    ? processStartTokenReader(pid, normalized.platform)
                    : null;
                if (observation.status === "match"
                    || (spawnedProcessStartToken && currentStartToken === spawnedProcessStartToken)) {
                    try {
                        const result = process.platform === "win32"
                            ? terminateWindowsProcessTree(pid, spawnedProcessIdentity || undefined, false, spawnedProcessStartToken || undefined)
                            : currentStartToken === spawnedProcessStartToken
                                ? (process.kill(pid, "SIGTERM"), { ok: true })
                                : { ok: false, error: "runtime-process-start-token-mismatch" };
                        startupCleanup = {
                            attempted: true,
                            ok: result.ok,
                            pid,
                            signal: "SIGTERM",
                            ...("error" in result && result.error ? { error: result.error } : {}),
                        };
                    } catch (error) {
                        startupCleanup = { attempted: true, ok: false, pid, signal: "SIGTERM", error: error instanceof Error ? error.message : String(error) };
                    }
                } else {
                    startupCleanup = { attempted: false, reason: `spawned-process-identity-${observation.status}`, observation };
                }
            }
            return {
                ok: false,
                ownerId,
                launched: true,
                reused: false,
                error: "host-broker-health-timeout",
                host: bindHost,
                probeHost,
                port,
                command,
                args,
                logPath,
                startupCleanup,
                attempts: [...prelaunchAttempts, ...ready.attempts],
            };
        }

        const listener = portProcessResolver(port, normalized.platform);
        const listenerIdentity = listener?.processIdentity
            || (listener?.pid ? processIdentityReader(listener.pid, normalized.platform) : null);
        const listenerStartToken = listener?.processStartToken
            || listenerIdentity?.startToken
            || (listener?.pid ? processStartTokenReader(listener.pid, normalized.platform) : null);
        const verifiedIdentity = verifiedHostBrokerIdentity(ready.selected);
        const listenerVerified = verifySpawnedHostBrokerListenerForTest(
            pid,
            spawnedProcessIdentity,
            listener,
            listenerIdentity,
            port,
            normalized.cliPath,
            {
                spawned: spawnedProcessStartToken,
                listener: listenerStartToken,
                status: verifiedIdentity?.processStartToken,
            },
        );
        if (!listenerVerified || !verifiedIdentity || verifiedIdentity.pid !== pid) {
            const observation = pid
                ? inspectDeviceRuntimeProcessIdentity(spawnedProcessIdentity, pid, {
                    platform: normalized.platform,
                    readIdentity: (value) => processIdentityReader(value, normalized.platform),
                })
                : { status: "unavailable", current: null };
            const currentStartToken = pid && spawnedProcessStartToken
                ? processStartTokenReader(pid, normalized.platform)
                : null;
            if (pid && (observation.status === "match"
                || (spawnedProcessStartToken && currentStartToken === spawnedProcessStartToken))) {
                try {
                    if (process.platform === "win32") {
                        terminateWindowsProcessTree(pid, spawnedProcessIdentity || undefined, false, spawnedProcessStartToken || undefined);
                    } else if (currentStartToken === spawnedProcessStartToken) {
                        process.kill(pid, "SIGTERM");
                    }
                } catch { /* bounded failure below is sufficient */ }
            }
            return {
                ok: false,
                ownerId,
                launched: true,
                reused: false,
                error: "host-broker-launch-process-unverified",
                host: bindHost,
                probeHost,
                port,
                command,
                args,
                logPath,
                listener: listener ? { pid: listener.pid, processIdentity: listenerIdentity } : null,
                attempts: [...prelaunchAttempts, ...ready.attempts],
            };
        }

        const runtime = {
            name: DEVICE_BROKER_NAME,
            managedBy: "ccc-host",
            version: CLI_VERSION,
            ownerId,
            pid,
            host: bindHost,
            probeHost,
            hostCandidates: hostBrokerProbeCandidates(bindHost, probeHost),
            port,
            command,
            args,
            cwd: normalized.cwd,
            profile: options.profile || null,
            logPath,
            startedAt: verifiedIdentity.startedAt,
            processStartToken: verifiedIdentity.processStartToken || listenerStartToken || null,
        };
        writeHostBrokerRuntime(runtime);
        return {
            ok: true,
            ownerId,
            launched: true,
            reused: false,
            runtime,
            host: bindHost,
            probeHost,
            port,
            verifiedCapabilities: verifiedHostBrokerCapabilities(ready.selected),
            ...(verifiedIdentity ? {
                verifiedBrokerPid: verifiedIdentity.pid,
                verifiedBrokerStartedAt: verifiedIdentity.startedAt,
                verifiedBrokerProcessStartToken: verifiedIdentity.processStartToken,
            } : {}),
            attempts: [...prelaunchAttempts, ...ready.attempts],
        };
    } catch (error) {
        return {
            ok: false,
            ownerId,
            launched: false,
            reused: false,
            error: "host-broker-launch-failed",
            detail: error instanceof Error ? error.message : String(error),
            host: bindHost,
            probeHost,
            port,
            command,
            args,
            logPath,
            attempts: prelaunchAttempts,
        };
    } finally {
        if (logFd !== null) {
            try { closeSync(logFd); } catch { /* ignore close failure */ }
        }
    }
}

export async function invokeHostDeviceBrokerOwnerRpc(
    method: string,
    params: Record<string, unknown>,
    options: HostDeviceBrokerOptions & { rpcTimeoutMs?: number; ensureHostBroker?: typeof ensureHostDeviceBroker } = {},
): Promise<HostDeviceBrokerOwnerRpcResult> {
    const readiness = await (options.ensureHostBroker || ensureHostDeviceBroker)(options);
    const readinessRecord = readiness as Record<string, unknown>;
    const ownerId = typeof readinessRecord.ownerId === "string"
        ? readinessRecord.ownerId
        : deviceBrokerOwnerId(options.cwd || process.cwd(), options.profile);
    const host = typeof readinessRecord.probeHost === "string"
        ? readinessRecord.probeHost
        : DEVICE_BROKER_DEFAULT_HOST;
    const port = Number.isInteger(readinessRecord.port)
        ? Number(readinessRecord.port)
        : DEVICE_BROKER_DEFAULT_PORT;
    if (!("ok" in readiness) || readiness.ok !== true) {
        return {
            ok: false,
            status: null,
            ownerId,
            host,
            port,
            body: null,
            error: "error" in readiness && typeof readiness.error === "string" ? readiness.error : "host-broker-unavailable",
            ...(typeof readinessRecord.detail === "string" ? { detail: readinessRecord.detail } : {}),
        };
    }

    const verifiedBrokerPid = Number(readinessRecord.verifiedBrokerPid);
    const verifiedBrokerProcessStartToken = typeof readinessRecord.verifiedBrokerProcessStartToken === "string"
        ? readinessRecord.verifiedBrokerProcessStartToken
        : "";
    const platform = options.platform || process.platform;
    const portProcessResolver = options.portProcessResolver || discoverBrokerPortProcess;
    const processStartTokenReader = options.processStartTokenReader
        || ((pid: number, targetPlatform: NodeJS.Platform) => readDeviceRuntimeProcessStartToken(pid, { platform: targetPlatform }));
    const listener = Number.isInteger(verifiedBrokerPid) && verifiedBrokerPid > 0
        ? portProcessResolver(port, platform)
        : null;
    const listenerStartToken = listener?.processStartToken
        || (listener?.pid ? processStartTokenReader(listener.pid, platform) : null);
    if (!listener
        || listener.pid !== verifiedBrokerPid
        || !verifiedBrokerProcessStartToken
        || listenerStartToken !== verifiedBrokerProcessStartToken) {
        return {
            ok: false,
            status: null,
            ownerId,
            host,
            port,
            body: null,
            error: "broker-runtime-process-unverified",
        };
    }

    const timeoutMs = Number.isFinite(options.rpcTimeoutMs)
        ? Math.min(DEVICE_BROKER_MAX_RPC_TIMEOUT_MS, Math.max(1, Number(options.rpcTimeoutMs)))
        : 300000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`http://${host}:${port}/v1/owners/${encodeURIComponent(ownerId)}/rpc`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-ccc-device-token": deviceBrokerOwnerToken(ownerId),
            },
            body: JSON.stringify({ method, params }),
            signal: controller.signal,
            redirect: "manual",
        });
        const responseBody = await readHostBrokerHttpJson(response, DEVICE_BROKER_RPC_RESPONSE_LIMIT_BYTES);
        const parsed = responseBody.body as Record<string, unknown> | null;
        return {
            ok: responseBody.ok && response.ok && parsed?.ok === true,
            status: response.status,
            ownerId,
            host,
            port,
            body: parsed,
            ...(!responseBody.ok || !response.ok || parsed?.ok !== true
                ? { error: !responseBody.ok ? responseBody.error : typeof parsed?.error === "string" ? parsed.error : `broker-rpc-http-${response.status}` }
                : {}),
        };
    } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        return {
            ok: false,
            status: null,
            ownerId,
            host,
            port,
            body: null,
            error: timedOut ? "broker-rpc-timeout" : "broker-rpc-unavailable",
            detail: error instanceof Error ? error.message : String(error),
        };
    } finally {
        clearTimeout(timeout);
    }
}

export function deviceBrokerStatus(options: DeviceBrokerOptions = {}) {
    const normalized = normalizeBrokerOptions(options);
    const ownerId = options.ownerId || deviceBrokerOwnerId(normalized.cwd, options.profile);
    const root = brokerRoot();
    const service = deviceBrokerServicePlan(normalized);
    const serviceOwner = readServiceOwner();
    const runtimeFile = brokerRuntimeFile();
    const runtime = readHostBrokerRuntime();
    return {
        name: DEVICE_BROKER_NAME,
        version: CLI_VERSION,
        host: normalized.host,
        port: normalized.port,
        url: `http://${normalized.host}:${normalized.port}`,
        ownerId,
        hostId: hostname(),
        mode: "host-broker-daemon",
        lazy: true,
        process: {
            pid: process.pid,
            startToken: readDeviceRuntimeProcessStartToken(process.pid),
        },
        startupPolicy: "host ccc auto-starts the broker for containers; daemon startup never starts device providers",
        startedAt: normalized.startedAt,
        state: {
            root,
            ownerRoot: join(root, "owners", ownerId),
            brokerRoot: join(root, "broker"),
            locksRoot: join(root, "broker", "locks"),
            logsRoot: join(root, "broker", "logs"),
            runtimeFile,
            rootExists: existsSync(root),
        },
        runtime: {
            file: runtimeFile,
            present: runtime !== null,
            metadata: runtime,
        },
        containerContract: {
            environmentRequired: false,
            ownerResolution: "host-broker-resolve",
            deviceStateMounted: existsSync(root),
        },
        persistence: deviceBrokerPersistence(ownerId),
        serviceManager: {
            supported: service.supported,
            platform: service.platform,
            manager: service.manager,
            serviceName: service.serviceName,
            definitionPath: service.definitionPath,
            command: service.command,
            diagnostics: service.diagnostics,
            owner: serviceOwner,
            ownedByCurrentOwner: serviceOwner?.ownerId === ownerId,
            actions: ["status"],
        },
        implemented: [
            "http-health",
            "http-status",
            "http-owner-rpc",
            "owner-token-guard",
            DEVICE_BROKER_CAPABILITY_HOST_BACKEND_READINESS,
            "http-physical-lease-api",
            "http-physical-attach-api",
            "http-lifecycle-command-plan",
            DEVICE_BROKER_CAPABILITY_LIFECYCLE_DEVICE_CREATE,
            "http-readonly-device-tool-routing",
            "http-recording-device-tool-routing",
            DEVICE_BROKER_CAPABILITY_DESKTOP_DEVICE_TOOL_PROXY,
            DEVICE_BROKER_CAPABILITY_DESKTOP_DEVICE_TOOL_TIMEOUTS,
            DEVICE_BROKER_CAPABILITY_WINDOWS_SANDBOX_HELPER_CONFIG,
            DEVICE_BROKER_CAPABILITY_ANDROID_DEVICE_TOOL_PROXY,
            DEVICE_BROKER_CAPABILITY_VERSION_REPORTING,
            DEVICE_BROKER_CAPABILITY_HIDDEN_PROVIDER_CHILDREN,
            DEVICE_BROKER_CAPABILITY_WINDOWS_PROVIDER_LAUNCHER_FENCING,
            DEVICE_BROKER_CAPABILITY_CANONICAL_OWNER_DEVICE_IDS,
            DEVICE_BROKER_CAPABILITY_IOS_SIMULATOR_OWNER_IDENTITY_FENCING,
            DEVICE_BROKER_CAPABILITY_IOS_SIMULATOR_PROVIDER_CREATE,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_APPIUM_LEASE_FENCING,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_DEVICE_TOOL_LEASE_FENCING,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_LIFECYCLE_USE_LEASE_REFRESH,
            DEVICE_BROKER_CAPABILITY_APPIUM_LIVE_RUNTIME_METADATA_FENCING,
            DEVICE_BROKER_CAPABILITY_DIRECT_ANDROID_LIFECYCLE_GENERATION_FENCING,
            DEVICE_BROKER_CAPABILITY_DIRECT_IOS_LIFECYCLE_GENERATION_FENCING,
            DEVICE_BROKER_CAPABILITY_DIRECT_WINDOWS_LIFECYCLE_GENERATION_FENCING,
            DEVICE_BROKER_CAPABILITY_DIRECT_MACOS_LIFECYCLE_GENERATION_FENCING,
            DEVICE_BROKER_CAPABILITY_DIRECT_MACOS_SNAPSHOT_CLONE_GENERATION_FENCING,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_DIRECT_STATE_TRANSITION_FENCING,
            DEVICE_BROKER_CAPABILITY_MULTI_PROJECT_OWNER_RESOLVE,
            DEVICE_BROKER_CAPABILITY_STOPPED_ANDROID_STATUS_OBSERVATION,
            DEVICE_BROKER_CAPABILITY_STOPPED_ANDROID_BOOT_METADATA,
            DEVICE_BROKER_CAPABILITY_GUEST_HELPER_RECORDING_PROXY,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_UNATTACHED_WIRELESS,
            DEVICE_BROKER_CAPABILITY_ANDROID_RECORDING_SIGNAL_FALLBACK,
            DEVICE_BROKER_CAPABILITY_HYPER_V_LIFECYCLE,
            DEVICE_BROKER_CAPABILITY_HYPER_V_SETUP_NETWORK,
            DEVICE_BROKER_CAPABILITY_HYPER_V_GUEST_READINESS_DIAGNOSTICS,
            DEVICE_BROKER_CAPABILITY_HYPER_V_AZURE_BOOTSTRAP_DHCP,
            DEVICE_BROKER_CAPABILITY_HYPER_V_BOOTSTRAP_NIC_CLEANUP,
            DEVICE_BROKER_CAPABILITY_HYPER_V_BOOTSTRAP_SSH_FINALIZE,
            DEVICE_BROKER_CAPABILITY_HYPER_V_WINDOWS_SPECIALIZE_SEED,
            DEVICE_BROKER_CAPABILITY_HYPER_V_WINDOWS_SPECIALIZE_ACCOUNT,
            DEVICE_BROKER_CAPABILITY_HYPER_V_WINDOWS_BOOT_CONTRACT,
            DEVICE_BROKER_CAPABILITY_HYPER_V_BOOT_DISK_GENERATION,
            DEVICE_BROKER_CAPABILITY_HYPER_V_LINUX_CREATE_RESPONSE,
            DEVICE_BROKER_CAPABILITY_HYPER_V_IMAGE_ACQUISITION_STAGE_CACHE,
            DEVICE_BROKER_CAPABILITY_HYPER_V_POWERSHELL_STAGE_PROPAGATION,
            DEVICE_BROKER_CAPABILITY_HYPER_V_AUTOMATIC_IMAGE_FINALIZATION,
            DEVICE_BROKER_CAPABILITY_HYPER_V_NETWORK_FAILURE_DIAGNOSTICS,
            DEVICE_BROKER_CAPABILITY_WINDOWS_BEST_EFFORT_MINIMIZE,
            DEVICE_BROKER_CAPABILITY_WINDOWS_SANDBOX_WINDOW_MINIMIZE,
            DEVICE_BROKER_CAPABILITY_WINDOWS_SANDBOX_RUNTIME_OWNERSHIP,
            DEVICE_BROKER_CAPABILITY_APPIUM3_NPM_RUNTIME,
            "http-appium-process-api",
            "http-appium-webdriver-session-api",
            "bounded-appium-webdriver-request-proxy",
            DEVICE_BROKER_CAPABILITY_APPIUM_HTTP_TRANSPORT_FENCING,
            "owner-runtime-cleanup-rpc",
            "high-level-mobile-broker-routing-compatible",
            "bounded-provider-command-execution",
            "host-ccc-auto-start-compatible",
            "owner-state-path-reporting",
            "zero-config-default-port",
            "secret-backed-owner-token-auth",
            DEVICE_BROKER_CAPABILITY_EXISTING_OWNER_AUTH,
            DEVICE_BROKER_CAPABILITY_ATOMIC_OWNER_AUTH,
            DEVICE_BROKER_CAPABILITY_OWNER_MUTATION_SERIALIZATION,
            DEVICE_BROKER_CAPABILITY_ATOMIC_OWNER_DEVICE_STATE,
            DEVICE_BROKER_CAPABILITY_CROSS_PROCESS_OWNER_STATE,
            DEVICE_BROKER_CAPABILITY_OWNER_DEVICE_IDENTITY_FENCING,
            DEVICE_BROKER_CAPABILITY_RPC_FAULT_CONTAINMENT,
            DEVICE_BROKER_CAPABILITY_SHARED_LEASE_SERIALIZATION,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_LEASE_OPERATION_FENCING,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_LIFECYCLE_LEASE_FENCING,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_OPERATION_SERIALIZATION,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_DETACH_RUNTIME_CLEANUP,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_RUNTIME_CLEANUP_LEASE_FENCING,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_LEASE_STATE_WRITE_ROLLBACK,
            DEVICE_BROKER_CAPABILITY_RUNTIME_CLEANUP_FAILURE_PRESERVATION,
            DEVICE_BROKER_CAPABILITY_APPIUM_RUNTIME_GENERATION_FENCING,
            DEVICE_BROKER_CAPABILITY_APPIUM_RUNTIME_INSTALLATION_FENCING,
            DEVICE_BROKER_CAPABILITY_WINDOWS_SINGLETON_FENCING,
            DEVICE_BROKER_CAPABILITY_DEVICE_OPERATION_SERIALIZATION,
            DEVICE_BROKER_CAPABILITY_DEVICE_RUNTIME_SERIALIZATION,
            DEVICE_BROKER_CAPABILITY_DIRECT_RECORDING_GENERATION_FENCING,
            DEVICE_BROKER_CAPABILITY_DIRECT_APPIUM_GENERATION_FENCING,
            DEVICE_BROKER_CAPABILITY_FINITE_DEVICE_OPERATION_SERIALIZATION,
            DEVICE_BROKER_CAPABILITY_DIRECT_RUNTIME_PROCESS_IDENTITY,
            DEVICE_BROKER_CAPABILITY_HOST_RECORDING_PROCESS_IDENTITY,
            DEVICE_BROKER_CAPABILITY_RUNTIME_PROCESS_OBSERVATION,
            DEVICE_BROKER_CAPABILITY_HOST_APPIUM_PROCESS_IDENTITY,
            DEVICE_BROKER_CAPABILITY_APPIUM_PORT_PROCESS_IDENTITY,
            DEVICE_BROKER_CAPABILITY_BROKER_OWNED_OWNER_AUTH,
            DEVICE_BROKER_CAPABILITY_PORT_PROCESS_IDENTITY,
            DEVICE_BROKER_CAPABILITY_PROCESS_START_TOKEN,
            DEVICE_BROKER_CAPABILITY_OWNER_GENERATION_HMAC_AUTH,
            DEVICE_BROKER_CAPABILITY_DIRECT_APPIUM_PROCESS_IDENTITY,
            DEVICE_BROKER_CAPABILITY_OWNER_DEVICE_STATE_VALIDATION,
            DEVICE_BROKER_CAPABILITY_OWNERSHIP_STATE_VALIDATION,
            DEVICE_BROKER_CAPABILITY_ANDROID_PORT_ALLOCATION_FENCING,
            DEVICE_BROKER_CAPABILITY_BOUNDED_ERROR_RESPONSES,
            DEVICE_BROKER_CAPABILITY_PHYSICAL_LEASE_DIRECTORY_FENCING,
            DEVICE_BROKER_CAPABILITY_OWNER_AUTH_DIRECTORY_FENCING,
            "host-service-manager-diagnostics",
        ],
        deferred: [],
    };
}

function serviceNameForPlatform(platform: NodeJS.Platform): string {
    if (platform === "darwin") return "com.ccc.device-broker";
    if (platform === "win32") return "CCC Device Broker";
    return "ccc-device-broker";
}

function serviceCommand(normalized: NormalizedBrokerOptions): string[] {
    return [
        process.execPath,
        normalized.cliPath,
        "devices",
        "broker",
        "serve",
        "--host",
        normalized.host,
        "--port",
        String(normalized.port),
    ];
}

function serviceLogPath(name: "out" | "err"): string {
    return join(brokerRoot(), "broker", "logs", `service.${name}.log`);
}

function serviceOwnerFile(): string {
    return join(brokerRoot(), "broker", "service", "owner.json");
}

function readServiceOwner(): ServiceOwnerRecord | null {
    try {
        return readDeviceLabStateFile(serviceOwnerFile(), (value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-service-owner");
            const parsed = value as Partial<ServiceOwnerRecord>;
            if (
                typeof parsed.ownerId !== "string"
                || !/^[a-f0-9]{16}$/.test(parsed.ownerId)
                || typeof parsed.serviceName !== "string"
                || typeof parsed.manager !== "string"
            ) throw new Error("invalid-service-owner");
            return {
                ownerId: parsed.ownerId,
                serviceName: parsed.serviceName,
                manager: parsed.manager,
                installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : new Date(0).toISOString(),
                updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
            };
        }, "broker-service-owner", DEVICE_BROKER_SERVICE_OWNER_FILE_LIMIT_BYTES);
    } catch {
        // Invalid service owner metadata is treated as absent.
    }
    return null;
}

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function systemdQuote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function psQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function brokerAppiumRuntimeRoot() {
    return join(brokerRoot(), "broker", "appium-runtime");
}

function brokerAppiumRuntimeDirectoryChain(): string[] {
    const root = brokerRoot();
    return [root, join(root, "broker"), brokerAppiumRuntimeRoot()];
}

function brokerAppiumRuntimeInstallLockFile(): string {
    return join(brokerRoot(), "broker", "appium-runtime.install.lock");
}

function inspectBrokerAppiumRuntimeDirectory(): boolean {
    for (const directory of brokerAppiumRuntimeDirectoryChain()) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw new Error("appium-runtime-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("appium-runtime-directory-invalid");
        }
    }
    return true;
}

function ensureBrokerAppiumRuntimeDirectory(): void {
    const [root, ...children] = brokerAppiumRuntimeDirectoryChain();
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("appium-runtime-directory-create-failed");
    }
    for (const directory of [root, ...children]) {
        if (directory !== root) {
            try {
                mkdirSync(directory, { mode: 0o700 });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("appium-runtime-directory-create-failed");
            }
        }
        let stat;
        try {
            stat = lstatSync(directory);
        } catch {
            throw new Error("appium-runtime-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("appium-runtime-directory-invalid");
        }
    }
}

function inspectBrokerAppiumNodeModulesDirectory(): boolean {
    const nodeModules = join(brokerAppiumRuntimeRoot(), "node_modules");
    try {
        const stat = lstatSync(nodeModules);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("appium-runtime-directory-invalid");
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        if (error instanceof Error && error.message === "appium-runtime-directory-invalid") throw error;
        throw new Error("appium-runtime-directory-read-failed");
    }
}

function brokerAppiumRuntimeEntryIsValid(entry: string): boolean {
    try {
        assertDeviceLabPathWithinRoot(brokerAppiumRuntimeRoot(), entry, "appium-runtime-entry");
        return withDeviceLabReadableFile(
            entry,
            "appium-runtime-entry",
            DEVICE_BROKER_APPIUM_ENTRY_LIMIT_BYTES,
            () => true,
        ) === true;
    } catch {
        return false;
    }
}

function brokerAppiumRuntimeExecutable(normalized: NormalizedBrokerOptions) {
    const binary = normalized.platform === "win32" ? "appium.cmd" : "appium";
    return join(brokerAppiumRuntimeRoot(), "node_modules", ".bin", binary);
}

function brokerAppiumRuntimeEntry() {
    return join(brokerAppiumRuntimeRoot(), "node_modules", "appium", "index.js");
}

function providerExecutable(name: string, normalized: NormalizedBrokerOptions): string | null {
    const injected = normalized.providerPaths[name];
    if (injected) return injected;
    if (["adb", "emulator", "avdmanager"].includes(name)) return findAndroidTool(name, normalized);
    if (normalized.platform === "darwin" && DEVICE_BROKER_MACOS_PROVIDERS.has(name)) return findMacosProvider(name);
    if (name === "appium") {
        const runtimeExecutable = brokerAppiumRuntimeExecutable(normalized);
        if (existsSync(runtimeExecutable)) return runtimeExecutable;
    }
    return resolveExecutablePath(name);
}

const WINDOWS_SYSTEM_POWERSHELL_PATH = "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function canonicalWindowsPowerShellForElevation(): string | null {
    if (process.platform !== "win32") return null;
    try {
        assertNoSymlinkPathComponents(dirname(WINDOWS_SYSTEM_POWERSHELL_PATH), "hyper-v-system-powershell");
        const source = lstatSync(WINDOWS_SYSTEM_POWERSHELL_PATH);
        if (!source.isFile() || source.isSymbolicLink()) return null;
        const resolved = realpathSync.native(WINDOWS_SYSTEM_POWERSHELL_PATH);
        const executable = /^\\\\\?\\[A-Za-z]:\\/.test(resolved) ? resolved.slice(4) : resolved;
        if (!/^[A-Za-z]:\\/.test(executable)) return null;
        assertNoSymlinkPathComponents(dirname(executable), "hyper-v-system-powershell");
        const target = lstatSync(executable);
        return target.isFile() && !target.isSymbolicLink() ? executable : null;
    } catch {
        return null;
    }
}

function hyperVElevationExecutable(standardExecutable: string): string {
    if (process.platform !== "win32") return standardExecutable;
    const canonical = canonicalWindowsPowerShellForElevation();
    if (!canonical) throw new Error("hyper-v-system-powershell-unavailable");
    return canonical;
}

function serviceProviderCommand(provider: string, executable: string | null, args: string[]): ProviderCommand {
    if (!executable) return { mode: "noop", provider, reason: `${provider} unavailable` };
    return { mode: "exec", provider, executable, args };
}

function linuxServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    const executable = providerExecutable("systemctl", normalized);
    const serviceName = `${serviceNameForPlatform("linux")}.service`;
    const definitionPath = join(homedir(), ".config", "systemd", "user", serviceName);
    const command = serviceCommand(normalized);
    const content = [
        "[Unit]",
        "Description=CCC Device Broker",
        "Documentation=https://github.com/anthropics/claude-code",
        "",
        "[Service]",
        "Type=simple",
        `WorkingDirectory=${systemdQuote(normalized.cwd)}`,
        `ExecStart=${command.map(systemdQuote).join(" ")}`,
        "Restart=on-failure",
        "RestartSec=2",
        `StandardOutput=append:${serviceLogPath("out")}`,
        `StandardError=append:${serviceLogPath("err")}`,
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
    return {
        supported: Boolean(executable),
        platform: "linux",
        manager: "systemd-user",
        serviceName,
        definitionPath,
        command,
        diagnostics: executable ? [] : ["systemctl not found; user systemd service management is unavailable"],
        files: [{ path: definitionPath, content }],
        commands: [],
    };
}

function macosServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    const executable = providerExecutable("launchctl", normalized);
    const label = serviceNameForPlatform("darwin");
    const definitionPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const command = serviceCommand(normalized);
    const array = command.map((arg) => `        <string>${xmlEscape(arg)}</string>`).join("\n");
    const content = [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
        "<plist version=\"1.0\">",
        "<dict>",
        "    <key>Label</key>",
        `    <string>${xmlEscape(label)}</string>`,
        "    <key>ProgramArguments</key>",
        "    <array>",
        array,
        "    </array>",
        "    <key>WorkingDirectory</key>",
        `    <string>${xmlEscape(normalized.cwd)}</string>`,
        "    <key>EnvironmentVariables</key>",
        "    <dict>",
        "        <key>PATH</key>",
        `        <string>${xmlEscape([...DEVICE_BROKER_MACOS_PROVIDER_PATHS, "/usr/sbin", "/sbin"].join(":"))}</string>`,
        "    </dict>",
        "    <key>RunAtLoad</key>",
        "    <false/>",
        "    <key>KeepAlive</key>",
        "    <false/>",
        "    <key>StandardOutPath</key>",
        `    <string>${xmlEscape(serviceLogPath("out"))}</string>`,
        "    <key>StandardErrorPath</key>",
        `    <string>${xmlEscape(serviceLogPath("err"))}</string>`,
        "</dict>",
        "</plist>",
        "",
    ].join("\n");
    return {
        supported: Boolean(executable),
        platform: "darwin",
        manager: "launchd-user",
        serviceName: label,
        definitionPath,
        command,
        diagnostics: executable ? [] : ["launchctl not found; launchd service management is unavailable"],
        files: [{ path: definitionPath, content }],
        commands: [],
    };
}

function windowsServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    const executable = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
    const serviceName = serviceNameForPlatform("win32");
    const command = serviceCommand(normalized);
    return {
        supported: Boolean(executable),
        platform: "win32",
        manager: "scheduled-task",
        serviceName,
        definitionPath: null,
        command,
        diagnostics: executable ? [] : ["PowerShell not found; Windows scheduled task service management is unavailable"],
        files: [],
        commands: [],
    };
}

function unsupportedServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    const platform = normalized.platform;
    return {
        supported: false,
        platform,
        manager: "unsupported",
        serviceName: serviceNameForPlatform(platform),
        definitionPath: null,
        command: serviceCommand(normalized),
        diagnostics: [`unsupported host platform for broker service management: ${platform}`],
        files: [],
        commands: [],
    };
}

function deviceBrokerServicePlan(normalized: NormalizedBrokerOptions): ServicePlan {
    if (normalized.platform === "darwin") return macosServicePlan(normalized);
    if (normalized.platform === "win32") return windowsServicePlan(normalized);
    if (normalized.platform === "linux") return linuxServicePlan(normalized);
    return unsupportedServicePlan(normalized);
}

function serviceCommandsFor(action: ServiceAction, plan: ServicePlan, normalized: NormalizedBrokerOptions): ProviderCommand[] {
    if (!plan.supported) return [];
    if (plan.platform === "linux") {
        const executable = providerExecutable("systemctl", normalized);
        return [
            serviceProviderCommand("systemctl", executable, ["--user", "is-active", plan.serviceName]),
            serviceProviderCommand("systemctl", executable, ["--user", "is-enabled", plan.serviceName]),
        ];
    }
    if (plan.platform === "darwin") {
        const executable = providerExecutable("launchctl", normalized);
        const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
        const target = `${domain}/${plan.serviceName}`;
        void action;
        return [serviceProviderCommand("launchctl", executable, ["print", target])];
    }
    if (plan.platform === "win32") {
        const executable = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
        const task = psQuote(plan.serviceName);
        void action;
        return [serviceProviderCommand("powershell", executable, hiddenWindowsPowerShellArgs(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Get-ScheduledTask -TaskName ${task} | Select-Object TaskName,State | ConvertTo-Json -Compress`]))];
    }
    return [];
}

export function deviceBrokerService(action: string = "status", options: DeviceBrokerOptions & { dryRun?: boolean } = {}) {
    const normalized = normalizeBrokerOptions(options);
    const ownerId = options.ownerId || deviceBrokerOwnerId(normalized.cwd, options.profile);
    const requested = DEVICE_BROKER_SERVICE_ACTIONS.has(action) ? action as ServiceAction : null;
    if (!requested) {
        return {
            ok: false,
            error: "invalid-service-action",
            action,
            allowed: [...DEVICE_BROKER_SERVICE_ACTIONS],
        };
    }
    const plan = deviceBrokerServicePlan(normalized);
    const commands = serviceCommandsFor(requested, plan, normalized);
    const dryRun = options.dryRun === true;
    const serviceOwner = readServiceOwner();
    const ownedByCurrentOwner = serviceOwner?.ownerId === ownerId;
    const installedBefore = plan.definitionPath ? existsSync(plan.definitionPath) : serviceOwner ? true : null;
    if (!plan.supported) {
        return {
            ok: false,
            ownerId,
            action: requested,
            dryRun,
            service: { ...plan, commands },
            serviceOwner,
            ownedByCurrentOwner,
            installed: installedBefore,
            running: null,
            results: [],
            changed: false,
            error: "service-manager-unsupported",
            diagnostics: plan.diagnostics,
        };
    }
    if (dryRun) {
        return {
            ok: true,
            ownerId,
            action: requested,
            dryRun,
            service: { ...plan, commands },
            serviceOwner,
            ownedByCurrentOwner,
            installed: installedBefore,
            running: null,
            results: [],
            changed: false,
            diagnostics: plan.diagnostics,
        };
    }
    const results = commands.map((command) => normalized.commandRunner(command, {
        timeoutMs: normalized.commandTimeoutMs,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    }));
    const running = results.length > 0 ? commandSucceeded(results[0]) : null;
    return {
        ok: true,
        ownerId,
        action: requested,
        dryRun,
        service: { ...plan, commands },
        serviceOwner,
        ownedByCurrentOwner,
        installed: installedBefore,
        installedBefore,
        running,
        results,
        changed: false,
        diagnostics: plan.diagnostics,
    };
}

const BROKER_ERROR_SUMMARY_KEYS = ["ok", "error", "code", "ownerId", "method", "backend", "deviceId", "tool", "status"];

function truncateBrokerDiagnostic(value: unknown, limitBytes = 4096): string {
    const text = String(value ?? "");
    if (Buffer.byteLength(text, "utf8") <= limitBytes) return text;
    const suffix = "\n...[truncated]";
    const prefixBudget = Math.max(0, limitBytes - Buffer.byteLength(suffix));
    let prefix = Buffer.from(text, "utf8").subarray(0, prefixBudget).toString("utf8");
    while (prefix && Buffer.byteLength(prefix, "utf8") > prefixBudget) prefix = prefix.slice(0, -1);
    return `${prefix}${suffix}`;
}

export function boundedBrokerErrorPayload(status: number, body: unknown): unknown {
    if (status < 400) return body;
    let originalBytes: number;
    try {
        originalBytes = Buffer.byteLength(JSON.stringify(body, null, 2), "utf8");
    } catch (error) {
        return {
            ok: false,
            error: "broker-response-serialization-failed",
            detail: truncateBrokerDiagnostic(error instanceof Error ? error.message : String(error)),
        };
    }
    if (originalBytes <= DEVICE_BROKER_ERROR_RESPONSE_LIMIT) return body;
    const source = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const summary: Record<string, unknown> = {};
    for (const key of BROKER_ERROR_SUMMARY_KEYS) {
        const value = source[key];
        if (value === null || typeof value === "boolean" || typeof value === "number") summary[key] = value;
        else if (typeof value === "string") summary[key] = truncateBrokerDiagnostic(value);
    }
    if (summary.ok === undefined) summary.ok = false;
    if (typeof summary.error !== "string") summary.error = "broker-error-response-too-large";
    return {
        ...summary,
        diagnosticTruncated: true,
        originalBytes,
        maxBytes: DEVICE_BROKER_ERROR_RESPONSE_LIMIT,
    };
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    let responseStatus = status;
    let responseBody = boundedBrokerErrorPayload(status, body);
    let payload: string;
    try {
        payload = JSON.stringify(responseBody, null, 2);
    } catch (error) {
        responseStatus = 500;
        responseBody = {
            ok: false,
            error: "broker-response-serialization-failed",
            detail: truncateBrokerDiagnostic(error instanceof Error ? error.message : String(error)),
        };
        payload = JSON.stringify(responseBody, null, 2);
    }
    res.writeHead(responseStatus, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        ...headers,
    });
    res.end(payload);
}

function readRequestJson(req: IncomingMessage, limit = DEVICE_BROKER_RPC_BODY_LIMIT, timeoutMs = DEVICE_BROKER_REQUEST_BODY_TIMEOUT_MS): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let resolved = false;
        const timer = setTimeout(() => {
            req.pause();
            finish({ ok: false, status: 408, error: "request-body-timeout" });
        }, timeoutMs);

        function finish(result: { ok: true; body: unknown } | { ok: false; status: number; error: string }) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve(result);
        }

        req.on("data", (chunk: Buffer) => {
            if (resolved) return;
            total += chunk.length;
            if (total > limit) {
                finish({ ok: false, status: 413, error: "request-too-large" });
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (resolved) return;
            try {
                const text = Buffer.concat(chunks).toString("utf8");
                finish({ ok: true, body: text ? JSON.parse(text) : {} });
            } catch {
                finish({ ok: false, status: 400, error: "invalid-json" });
            }
        });
        req.on("error", () => finish({ ok: false, status: 400, error: "request-read-failed" }));
    });
}

function ownerInventory(ownerId: string, redactSecrets = false) {
    const root = brokerRoot();
    const backends = DEVICE_BROKER_BACKEND_STATE_KEYS.map((stateKey) => {
        const file = join(root, "owners", ownerId, stateKey, "devices.json");
        if (!existsSync(file)) return { stateKey, devices: [], exists: false };
        try {
            const stat = statSync(file);
            if (stat.size > DEVICE_BROKER_INVENTORY_FILE_LIMIT) {
                return {
                    stateKey,
                    devices: [],
                    exists: true,
                    truncated: true,
                    error: "inventory-file-too-large",
                    maxBytes: DEVICE_BROKER_INVENTORY_FILE_LIMIT,
                    bytes: stat.size,
                };
            }
            const devices = readOwnerDeviceStateFile(file, DEVICE_BROKER_INVENTORY_FILE_LIMIT);
            return {
                stateKey,
                devices: redactSecrets
                    ? devices.slice(0, DEVICE_BROKER_INVENTORY_DEVICE_LIMIT).map(redactBrokerDeviceSecrets)
                    : devices.slice(0, DEVICE_BROKER_INVENTORY_DEVICE_LIMIT),
                exists: true,
                truncated: devices.length > DEVICE_BROKER_INVENTORY_DEVICE_LIMIT,
                totalDevices: devices.length,
                maxDevices: DEVICE_BROKER_INVENTORY_DEVICE_LIMIT,
            };
        } catch (error) {
            return { stateKey, devices: [], exists: true, error: ownerDeviceStateErrorCode(error) || "inventory-read-failed" };
        }
    });
    return {
        ownerId,
        root,
        ownerRoot: join(root, "owners", ownerId),
        backends,
    };
}

async function hostBackends(ownerId: string, normalized: NormalizedBrokerOptions) {
    const adb = providerExecutable("adb", normalized);
    const emulator = providerExecutable("emulator", normalized);
    const avdmanager = providerExecutable("avdmanager", normalized);
    const xcrun = providerExecutable("xcrun", normalized);
    const xcodebuild = providerExecutable("xcodebuild", normalized);
    const wsb = providerExecutable("wsb", normalized);
    const powershell = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
    const ssh = providerExecutable("ssh.exe", normalized) || providerExecutable("ssh", normalized);
    const scp = providerExecutable("scp.exe", normalized) || providerExecutable("scp", normalized);
    const macosProviders = [...DEVICE_BROKER_MACOS_PROVIDERS]
        .map((name) => ({ name, command: providerExecutable(name, normalized) }))
        .filter((provider): provider is { name: string; command: string } => Boolean(provider.command));

    const androidMissing = [
        ...(adb ? [] : ["adb"]),
        ...(emulator ? [] : ["emulator"]),
    ];
    const androidProvisioningMissing = avdmanager ? [] : ["avdmanager"];
    const androidDeviceMissing = adb ? [] : ["adb"];
    const iosSimulatorMissing = xcrun ? [] : ["xcrun"];
    const iosDeviceMissing = [
        ...(xcrun ? [] : ["xcrun"]),
        ...(xcodebuild ? [] : ["xcodebuild"]),
    ];
    const windowsMissing = wsb ? [] : ["wsb"];
    let hyperVReadiness = null;
    if (normalized.platform === "win32" && powershell) {
        const readinessResult = await hyperVProviderCommandRunner(normalized, hyperVReadinessCommand(powershell), {
            timeoutMs: Math.min(15000, normalized.commandTimeoutMs),
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
        hyperVReadiness = commandSucceeded(readinessResult) ? parseHyperVReadiness(readinessResult.stdout || "") : null;
    }
    const hyperVMissing = normalized.platform !== "win32"
        ? ["windows-host"]
        : !powershell
            ? ["powershell"]
            : hyperVReadiness
                ? hyperVReadiness.missing
                : ["hyper-v-readiness"];
    const hyperVLinuxMissing = [
        ...hyperVMissing,
        ...(hyperVReadiness?.linuxImageMissing || []),
        ...(ssh ? [] : ["ssh"]),
        ...(scp ? [] : ["scp"]),
    ];
    const macosMissing = normalized.platform !== "darwin"
        ? ["macos-host"]
        : (macosProviders.length > 0 ? [] : ["macos-vm-provider"]);

    return {
        ownerId,
        hostId: hostname(),
        platform: normalized.platform,
        source: "host-broker-provider-discovery",
        startsDevices: false,
        backends: [
            {
                name: "android-emulator",
                host: "host-or-container",
                creatable: true,
                available: androidMissing.length === 0,
                lazy: true,
                status: androidMissing.length === 0 ? "available" : "missing-prerequisites",
                missing: androidMissing,
                tools: { adb, emulator, avdmanager },
                provisioning: { available: androidProvisioningMissing.length === 0, missing: androidProvisioningMissing },
                capabilities: ANDROID_EMULATOR_CAPABILITIES,
            },
            {
                name: "android-device",
                host: "host-usb-adb",
                creatable: false,
                attachable: true,
                available: androidDeviceMissing.length === 0,
                lazy: true,
                status: androidDeviceMissing.length === 0 ? "available" : "missing-prerequisites",
                missing: androidDeviceMissing,
                tools: { adb },
                capabilities: ANDROID_REAL_CAPABILITIES,
            },
            {
                name: "ios-simulator",
                host: "macos-host",
                creatable: true,
                available: iosSimulatorMissing.length === 0,
                lazy: true,
                status: iosSimulatorMissing.length === 0 ? "available" : "missing-prerequisites",
                missing: iosSimulatorMissing,
                tools: { xcrun },
                capabilities: IOS_SIMULATOR_CAPABILITIES,
            },
            {
                name: "ios-device",
                host: "macos-host-usb-xcode",
                creatable: false,
                attachable: true,
                available: iosDeviceMissing.length === 0,
                lazy: true,
                status: iosDeviceMissing.length === 0 ? "available" : "missing-prerequisites",
                missing: iosDeviceMissing,
                tools: { xcrun, xcodebuild },
                capabilities: IOS_REAL_CAPABILITIES,
            },
            {
                name: "windows-sandbox",
                host: "windows-host",
                creatable: true,
                available: windowsMissing.length === 0,
                lazy: true,
                status: windowsMissing.length === 0 ? "available" : "missing-prerequisites",
                missing: windowsMissing,
                tools: { wsb },
                capabilities: DESKTOP_DEVICE_CAPABILITIES,
            },
            {
                name: "windows-vm",
                host: "windows-host",
                creatable: true,
                available: hyperVMissing.length === 0,
                lazy: true,
                status: hyperVMissing.length === 0 ? "available" : "missing-prerequisites",
                missing: hyperVMissing,
                provider: "hyper-v",
                tools: { powershell },
                readiness: hyperVReadiness,
                capabilities: HYPER_V_VM_CAPABILITIES,
            },
            ...(normalized.platform === "win32" ? [{
                name: "linux-vm",
                host: "windows-host",
                creatable: true,
                available: hyperVLinuxMissing.length === 0,
                lazy: true,
                status: hyperVLinuxMissing.length === 0 ? "available" : "missing-prerequisites",
                missing: hyperVLinuxMissing,
                provider: "hyper-v",
                guestTransport: "ssh",
                tools: { powershell, ssh, scp },
                readiness: hyperVReadiness,
                capabilities: HYPER_V_VM_CAPABILITIES,
            }] : []),
            {
                name: "macos-vm",
                host: "macos-host",
                creatable: true,
                available: macosMissing.length === 0,
                lazy: true,
                status: macosMissing.length === 0 ? "available" : "missing-prerequisites",
                missing: macosMissing,
                providers: macosProviders,
                capabilities: MACOS_VM_CAPABILITIES,
            },
        ],
    };
}

function backendForStateKey(stateKey: string): string | null {
    return typeof DEVICE_BROKER_STATE_BACKENDS.get(stateKey) === "string" ? DEVICE_BROKER_STATE_BACKENDS.get(stateKey) as string : null;
}

function validateDeviceToolParams(params: unknown): DeviceToolParamError | DeviceToolParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-device-tool-params", supported: [...DEVICE_BROKER_TOOL_METHODS] };
    }
    const record = params as Record<string, unknown>;
    const tool = typeof record.tool === "string" ? record.tool : "";
    if (!tool) return { ok: false, status: 400, error: "missing-device-tool", supported: [...DEVICE_BROKER_TOOL_METHODS] };
    if (!DEVICE_BROKER_TOOL_METHODS.has(tool)) {
        return { ok: false, status: 501, error: "broker-device-tool-not-supported", supported: [...DEVICE_BROKER_TOOL_METHODS] };
    }
    const backend = typeof record.backend === "string" && record.backend ? record.backend : null;
    const stateKey = backend ? DEVICE_BROKER_COMMAND_BACKENDS.get(backend) : null;
    if (backend && !stateKey) {
        return { ok: false, status: 400, error: "invalid-device-tool-backend", allowed: [...DEVICE_BROKER_COMMAND_BACKENDS.keys()] };
    }
    const deviceId = typeof record.deviceId === "string" && record.deviceId ? record.deviceId : null;
    if (deviceId && (deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId))) {
        return { ok: false, status: 400, error: "invalid-device-id" };
    }
    if ((tool === "device_record_video_status" || tool === "device_record_video_start" || tool === "device_record_video_stop" || DEVICE_BROKER_BACKEND_TOOL_METHODS.has(tool))
        && !DEVICE_BROKER_UNATTACHED_TOOL_METHODS.has(tool)
        && !deviceId) {
        return { ok: false, status: 400, error: "missing-device-id" };
    }
    const remotePath = typeof record.remotePath === "string" && record.remotePath ? record.remotePath : null;
    const localPath = typeof record.localPath === "string" && record.localPath ? record.localPath : null;
    const rawTimeLimit = Number(record.timeLimitSec);
    const timeLimitSec = Number.isFinite(rawTimeLimit) ? Math.max(1, Math.min(1800, Math.floor(rawTimeLimit))) : null;
    return { ok: true, tool, backend, stateKey: stateKey || null, deviceId, remotePath, localPath, timeLimitSec, params: record };
}

function invokeDeviceInventory(ownerId: string, parsed: DeviceToolParamSuccess, normalized: NormalizedBrokerOptions) {
    const inventory = ownerInventory(ownerId);
    const backends = parsed.stateKey
        ? inventory.backends.filter((entry) => entry.stateKey === parsed.stateKey)
        : inventory.backends;
    const hostInventory = parsed.backend === "android-device" ? androidHostDeviceInventory(normalized) : null;
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                tool: parsed.tool,
                backend: parsed.backend,
                devices: parsed.stateKey ? (backends[0]?.devices || []) : undefined,
                backends: backends.map((entry) => ({
                    ...entry,
                    backend: backendForStateKey(entry.stateKey),
                })),
                ...(hostInventory ? { hostDevices: hostInventory.devices, hostInventory } : {}),
                source: "host-broker-owner-state",
                startsDevices: false,
            },
        },
    };
}

type DeviceToolMatch = { stateKey: string; backend: string | null; device: Record<string, unknown> };

function findOwnerDeviceForTool(ownerId: string, parsed: DeviceToolParamSuccess): DeviceToolMatch | BrokerRpcResult {
    const stateKeys = parsed.stateKey ? [parsed.stateKey] : DEVICE_BROKER_BACKEND_STATE_KEYS;
    const matches: DeviceToolMatch[] = [];
    for (const stateKey of stateKeys) {
        const devices = readOwnerDevices(ownerId, stateKey);
        const found = devices.find((device) => device && typeof device === "object" && (device as Record<string, unknown>).id === parsed.deviceId);
        if (found && typeof found === "object") matches.push({ stateKey, backend: backendForStateKey(stateKey), device: found as Record<string, unknown> });
    }
    if (matches.length === 0) {
        return { status: 404, payload: { ok: false, error: "owner-device-not-found", deviceId: parsed.deviceId, backend: parsed.backend } };
    }
    if (matches.length > 1) {
        return { status: 409, payload: { ok: false, error: "ambiguous-device-backend", deviceId: parsed.deviceId, matches: matches.map((match) => match.backend) } };
    }
    return matches[0];
}

function invokeDeviceRecordingStatus(ownerId: string, parsed: DeviceToolParamSuccess) {
    const match = findOwnerDeviceForTool(ownerId, parsed);
    if ("status" in match) return match;
    const provider = DEVICE_BROKER_RECORDING_PROVIDERS.get(match.stateKey) || null;
    const observedRecording = match.device.recording && typeof match.device.recording === "object" && !Array.isArray(match.device.recording)
        ? match.device.recording as Record<string, unknown>
        : null;
    const observation = observedRecording?.processIdentity && typeof observedRecording.pid === "number"
        ? inspectDeviceRuntimeProcessIdentity(observedRecording.processIdentity, observedRecording.pid)
        : null;
    const recordingIsCurrent = !observation
        || observation.status === "match"
        || observation.status === "unavailable";
    const transition = recordingIsCurrent || !observedRecording
        ? null
        : transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), observedRecording, null);
    const recording = transition?.matched ? null : match.device.recording || null;
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                tool: parsed.tool,
                deviceId: parsed.deviceId,
                backend: match.backend,
                stateKey: match.stateKey,
                recording,
                provider,
                supported: Boolean(provider),
                source: "host-broker-owner-state",
                startsDevices: false,
            },
        },
    };
}

function ownerRecordingDir(ownerId: string, stateKey: string, deviceId: string) {
    return join(brokerRoot(), "owners", ownerId, stateKey, deviceId, "recordings");
}

function ownerRecordingLocalPath(ownerId: string, stateKey: string, deviceId: string, extension: string) {
    return join(ownerRecordingDir(ownerId, stateKey, deviceId), `recording-${Date.now()}.${extension}`);
}

async function sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: unknown) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: unknown, timeoutMs = DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return true;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if (!processIsAlive(pid)) return true;
        await sleep(50);
    }
    return !processIsAlive(pid);
}

async function startDetachedProviderCommand(command: ProviderCommand, normalized: NormalizedBrokerOptions, label: string): Promise<ProviderCommandResult> {
    if (command.mode !== "detached") {
        return normalized.commandRunner(command, {
            timeoutMs: normalized.commandTimeoutMs,
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
    }
    if (!command.executable) {
        return { mode: "detached", provider: command.provider, error: "missing-executable", status: null };
    }
    const executable = command.executable;
    if (!executableExists(executable)) {
        return { mode: "detached", provider: command.provider, executable, args: command.args || [], status: null, error: "executable-not-found" };
    }
    return await new Promise((resolve) => {
        let settled = false;
        let child: ReturnType<typeof spawn> | null = null;
        const done = (result: ProviderCommandResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const ready = () => {
            if (settled || !child) return;
            const processIdentity = readDeviceRuntimeProcessIdentity(child.pid);
            if (!processIdentity) {
                try { child.kill("SIGTERM"); } catch { /* already exited */ }
                done({ mode: "detached", provider: command.provider, executable, args: command.args || [], pid: child.pid, status: null, error: `${label} process identity could not be established` });
                return;
            }
            settled = true;
            child.unref();
            resolve({ mode: "detached", provider: command.provider, executable, args: command.args || [], pid: child.pid, processIdentity, status: 0 });
        };
        const timer = setTimeout(ready, DEVICE_BROKER_DETACHED_READY_MS);
        let launcherCleanupPath: string | undefined;
        try {
            const invocation = detachedProviderCommandSpawn(command);
            launcherCleanupPath = invocation.cleanupPath;
            const commandEnv = hiddenProviderCommandEnv(command.env);
            const spawned = spawn(invocation.executable || executable, invocation.args, hiddenChildProcessOptions({
                detached: true,
                stdio: "ignore" as const,
                ...(commandEnv ? { env: { ...process.env, ...commandEnv } } : {}),
                ...(command.cwd ? { cwd: command.cwd } : {}),
            }));
            child = spawned;
            scheduleWindowsLauncherCleanup(launcherCleanupPath, spawned);
            spawned.once("error", (error) => done({ mode: "detached", provider: command.provider, executable, args: command.args || [], status: null, error: `${label} failed to start: ${error.message}` }));
            spawned.once("exit", (code, signal) => done({ mode: "detached", provider: command.provider, executable, args: command.args || [], pid: spawned.pid, status: code, signal, error: `${label} exited before it was ready: ${signal || `exit ${code}`}` }));
        } catch (error) {
            removeWindowsLauncher(launcherCleanupPath);
            done({ mode: "detached", provider: command.provider, executable, args: command.args || [], status: null, error: error instanceof Error ? error.message : String(error) });
        }
    });
}

function recordingUnsupported(ownerId: string, parsed: DeviceToolParamSuccess, match: DeviceToolMatch, reason: string): BrokerRpcResult {
    return {
        status: 501,
        payload: {
            ok: false,
            error: "broker-device-recording-unsupported",
            ownerId,
            tool: parsed.tool,
            backend: match.backend,
            stateKey: match.stateKey,
            deviceId: parsed.deviceId,
            reason,
            fallbackAvailable: false,
            directProviderFallback: false,
            startsDevices: false,
        },
    };
}

function recordingRuntimeMatches(expected: unknown, current: unknown): boolean {
    if (expected === null || expected === undefined) return current === null || current === undefined;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
        || !current || typeof current !== "object" || Array.isArray(current)) return false;
    const expectedRecord = expected as Record<string, unknown>;
    const currentRecord = current as Record<string, unknown>;
    const expectedRuntimeId = typeof expectedRecord.runtimeId === "string" ? expectedRecord.runtimeId : null;
    const currentRuntimeId = typeof currentRecord.runtimeId === "string" ? currentRecord.runtimeId : null;
    if (expectedRuntimeId || currentRuntimeId) return expectedRuntimeId !== null && expectedRuntimeId === currentRuntimeId;
    const identityFields = ["authority", "processOwner", "startedBy", "pid", "provider", "startedAt", "remotePath", "localPath"];
    return identityFields.every((field) => expectedRecord[field] === currentRecord[field]);
}

function transitionOwnerRecordingRuntime(
    ownerId: string,
    stateKey: string,
    deviceId: string,
    expected: unknown,
    replacement: Record<string, unknown> | null,
) {
    let found = false;
    let matched = false;
    let currentRecording: unknown = null;
    let updatedDevice: Record<string, unknown> | null = null;
    mutateOwnerDevices(ownerId, stateKey, (devices) => devices.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || (candidate as { id?: unknown }).id !== deviceId) return candidate;
        found = true;
        const record = candidate as Record<string, unknown>;
        currentRecording = record.recording ?? null;
        if (!recordingRuntimeMatches(expected, currentRecording)) return candidate;
        matched = true;
        updatedDevice = { ...record, recording: replacement, updatedAt: new Date().toISOString() };
        return updatedDevice;
    }));
    return { found, matched, currentRecording, device: updatedDevice };
}

function recordingStartPlan(ownerId: string, parsed: DeviceToolParamSuccess, match: DeviceToolMatch, normalized: NormalizedBrokerOptions): { command: ProviderCommand; recording: Record<string, unknown> } | { error: BrokerRpcResult } {
    const deviceId = String(parsed.deviceId);
    const provider = DEVICE_BROKER_RECORDING_PROVIDERS.get(match.stateKey) || "unknown";
    const now = new Date().toISOString();
    if (match.stateKey === "android" || match.stateKey === "android-device") {
        const serial = androidSerial(match.device);
        if (!serial) {
            return { error: { status: 400, payload: { ok: false, error: "missing-provider-metadata", missing: ["serial or port"], backend: match.backend, deviceId } } };
        }
        const remotePath = parsed.remotePath || `/sdcard/ccc-${deviceId}-recording.mp4`;
        const localPath = parsed.localPath || ownerRecordingLocalPath(ownerId, match.stateKey, deviceId, "mp4");
        mkdirSync(dirname(localPath), { recursive: true });
        const timeLimitSec = parsed.timeLimitSec || 180;
        return {
            command: {
                mode: "detached",
                provider: "adb",
                executable: executableFor("adb", normalized),
                args: ["-s", serial, "shell", "screenrecord", "--time-limit", String(timeLimitSec), remotePath],
            },
            recording: {
                active: true,
                provider,
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.device.recording.start",
                remotePath,
                localPath,
                timeLimitSec,
                startedAt: now,
            },
        };
    }
    if (match.stateKey === "ios") {
        const ownedTarget = resolveBrokerOwnedIosSimulatorTarget(ownerId, match.device, normalized);
        if (!ownedTarget.ok) {
            return { error: { status: 409, payload: { ok: false, error: ownedTarget.error, missing: ownedTarget.missing, backend: match.backend, deviceId } } };
        }
        const localPath = parsed.localPath || ownerRecordingLocalPath(ownerId, match.stateKey, deviceId, "mp4");
        mkdirSync(dirname(localPath), { recursive: true });
        return {
            command: {
                mode: "detached",
                provider: "xcrun",
                executable: executableFor("xcrun", normalized),
                args: ["simctl", "io", ownedTarget.target, "recordVideo", localPath],
            },
            recording: {
                active: true,
                provider,
                authority: "host-broker",
                processOwner: "host-broker",
                startedBy: "broker.device.recording.start",
                localPath,
                timeLimitSec: parsed.timeLimitSec,
                startedAt: now,
            },
        };
    }
    if (match.stateKey === "ios-device") return { error: recordingUnsupported(ownerId, parsed, match, "physical iOS recording is not mutated through broker.device.tool.invoke; use a dedicated Appium/Xcode/device-farm path when available") };
    if (match.stateKey === "windows") return { error: recordingUnsupported(ownerId, parsed, match, "Windows Sandbox recording is not broker-managed because it uses the guest-helper file channel") };
    if (match.stateKey === "macos") return { error: recordingUnsupported(ownerId, parsed, match, "macOS VM recording is not broker-managed because it uses the SSH guest-helper bridge") };
    return { error: recordingUnsupported(ownerId, parsed, match, "recording is not supported for this backend through broker.device.tool.invoke") };
}

async function invokeDeviceRecordingStart(ownerId: string, parsed: DeviceToolParamSuccess, normalized: NormalizedBrokerOptions) {
    const match = findOwnerDeviceForTool(ownerId, parsed);
    if ("status" in match) return match;
    const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, match, String(parsed.deviceId));
    if (leaseFailure) return leaseFailure;
    const currentRecording = match.device.recording && typeof match.device.recording === "object" ? match.device.recording as Record<string, unknown> : null;
    if (currentRecording?.active) {
        return { status: 409, payload: { ok: false, error: "recording-already-active", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, recording: currentRecording } };
    }
    const plan = recordingStartPlan(ownerId, parsed, match, normalized);
    if ("error" in plan) return plan.error;
    const execution = normalized.usesDefaultCommandRunner
        ? await startDetachedProviderCommand(plan.command, normalized, String(plan.recording.provider || parsed.tool))
        : normalized.commandRunner(plan.command, {
            timeoutMs: normalized.commandTimeoutMs,
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
    if (!commandSucceeded(execution)) {
        return { status: 502, payload: { ok: false, error: "recording-start-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, execution } };
    }
    const recording: Record<string, unknown> = {
        ...plan.recording,
        runtimeId: randomBytes(16).toString("hex"),
        pid: execution.pid ?? null,
        ...(execution.processIdentity ? { processIdentity: execution.processIdentity } : {}),
    };
    const transition = transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), currentRecording, recording);
    if (!transition.matched) {
        const rollback = signalBrokerOwnedRecording(recording, normalized, "SIGINT");
        return {
            status: 409,
            payload: {
                ok: false,
                error: "recording-runtime-state-conflict",
                ownerId,
                backend: match.backend,
                stateKey: match.stateKey,
                deviceId: parsed.deviceId,
                found: transition.found,
                currentRecording: transition.currentRecording,
                rollback,
            },
        };
    }
    const updated = transition.device;
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                tool: parsed.tool,
                backend: match.backend,
                stateKey: match.stateKey,
                deviceId: parsed.deviceId,
                provider: recording.provider,
                recording,
                device: updated,
                execution,
                source: "host-broker-owner-state",
                startsDevices: false,
            },
        },
    };
}

async function invokeDeviceRecordingStop(ownerId: string, parsed: DeviceToolParamSuccess, normalized: NormalizedBrokerOptions) {
    const match = findOwnerDeviceForTool(ownerId, parsed);
    if ("status" in match) return match;
    const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, match, String(parsed.deviceId));
    if (leaseFailure) return leaseFailure;
    const recording = match.device.recording && typeof match.device.recording === "object" ? match.device.recording as Record<string, unknown> : null;
    if (!recording?.active) {
        return { status: 409, payload: { ok: false, error: "recording-not-active", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, recording: recording || null } };
    }
    if (match.stateKey === "windows") return recordingUnsupported(ownerId, parsed, match, "Windows Sandbox recording stop is not broker-managed because it uses the guest-helper file channel");
    if (match.stateKey === "macos") return recordingUnsupported(ownerId, parsed, match, "macOS VM recording stop is not broker-managed because it uses the SSH guest-helper bridge");
    if (match.stateKey === "ios-device") return recordingUnsupported(ownerId, parsed, match, "physical iOS recording stop is not managed through broker.device.tool.invoke");

    const signal = signalBrokerOwnedRecording(recording, normalized, "SIGINT");
    if (!signal.ok) {
        return { status: 502, payload: { ok: false, error: "recording-stop-signal-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, recording, startsDevices: false } };
    }
    const executions: ProviderCommandResult[] = [];
    let artifactCopy: ProviderCommandResult | null = null;
    let stopCommandFailed: ProviderCommandResult | null = null;
    const provider = DEVICE_BROKER_RECORDING_PROVIDERS.get(match.stateKey) || String(recording.provider || "unknown");
    const localPath = parsed.localPath || (typeof recording.localPath === "string" ? recording.localPath : ownerRecordingLocalPath(ownerId, match.stateKey, String(parsed.deviceId), "mp4"));
    mkdirSync(dirname(localPath), { recursive: true });
    let serial: string | null = null;
    if (match.stateKey === "android" || match.stateKey === "android-device") {
        serial = androidSerial(match.device);
        if (!serial) return { status: 400, payload: { ok: false, error: "missing-provider-metadata", missing: ["serial or port"], backend: match.backend, deviceId: parsed.deviceId } };
        const pkillCommand: ProviderCommand = { mode: "exec", provider: "adb", executable: executableFor("adb", normalized), args: ["-s", serial, "shell", "pkill", "-2", "screenrecord"] };
        const pkill = normalized.commandRunner(pkillCommand, { timeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
        executions.push(pkill);
        if (!commandSucceeded(pkill)) stopCommandFailed = pkill;
    }
    const processExited = normalized.usesDefaultCommandRunner
        ? await waitForProcessExit(recording.pid, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS)
        : true;
    if (!processExited) {
        return { status: 502, payload: { ok: false, error: "recording-process-still-running", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, executions, recording, startsDevices: false } };
    }
    const hostRecorderWasSignaled = signal.attempted === true && signal.ok === true;
    if (stopCommandFailed && !hostRecorderWasSignaled && !("stale" in signal && signal.stale)) {
        return { status: 502, payload: { ok: false, error: "recording-stop-command-failed", ownerId, backend: match.backend, stateKey: match.stateKey, deviceId: parsed.deviceId, signal, executions, recording, startsDevices: false } };
    }
    if (match.stateKey === "android" || match.stateKey === "android-device") {
        if (!serial) return { status: 400, payload: { ok: false, error: "missing-provider-metadata", missing: ["serial or port"], backend: match.backend, deviceId: parsed.deviceId } };
        if (typeof recording.remotePath === "string" && recording.remotePath) {
            const pullCommand: ProviderCommand = { mode: "exec", provider: "adb", executable: executableFor("adb", normalized), args: ["-s", serial, "pull", recording.remotePath, localPath] };
            artifactCopy = normalized.commandRunner(pullCommand, { timeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
            if (artifactCopy) executions.push(artifactCopy);
            const rmCommand: ProviderCommand = { mode: "exec", provider: "adb", executable: executableFor("adb", normalized), args: ["-s", serial, "shell", "rm", "-f", recording.remotePath] };
            executions.push(normalized.commandRunner(rmCommand, { timeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT }));
        }
    }
    const stoppedAt = new Date().toISOString();
    const transition = transitionOwnerRecordingRuntime(ownerId, match.stateKey, String(parsed.deviceId), recording, null);
    if (!transition.matched) {
        return {
            status: 409,
            payload: {
                ok: false,
                error: "recording-runtime-state-conflict",
                ownerId,
                backend: match.backend,
                stateKey: match.stateKey,
                deviceId: parsed.deviceId,
                found: transition.found,
                currentRecording: transition.currentRecording,
                signal,
                executions,
            },
        };
    }
    const updated = transition.device;
    const copyFailed = artifactCopy && !commandSucceeded(artifactCopy);
    return {
        status: copyFailed ? 502 : 200,
        payload: {
            ok: !copyFailed,
            ...(copyFailed ? { error: "recording-artifact-copy-failed" } : {}),
            result: {
                ownerId,
                tool: parsed.tool,
                backend: match.backend,
                stateKey: match.stateKey,
                deviceId: parsed.deviceId,
                stopped: true,
                provider,
                signal,
                executions,
                recording: { ...recording, active: false, localPath, stoppedAt },
                device: updated,
                source: "host-broker-owner-state",
                startsDevices: false,
            },
        },
    };
}

function brokerDeviceToolSupportedMethods(backend: string | null): Set<string> {
    const recordingTools = ["device_record_video_status", "device_record_video_start", "device_record_video_stop"];
    if (isHyperVBackend(backend)) {
        return new Set(["device_exec", "device_upload", "device_download", "device_snapshot_list", "device_snapshot_create", "device_snapshot_restore", "device_snapshot_delete"]);
    }
    if (backend === "windows-sandbox" || backend === "macos-vm") {
        return new Set([...DEVICE_BROKER_DESKTOP_TOOL_METHODS, ...DEVICE_BROKER_DESKTOP_FILE_TOOL_METHODS, ...recordingTools]);
    }
    if (backend === "android-emulator") return new Set([...DEVICE_BROKER_ANDROID_TOOL_METHODS, ...recordingTools]);
    if (backend === "android-device") return new Set([...DEVICE_BROKER_ANDROID_DEVICE_TOOL_METHODS, ...recordingTools]);
    if (backend === "ios-simulator") return new Set([...DEVICE_BROKER_IOS_SIMULATOR_TOOL_METHODS, ...recordingTools]);
    if (backend === "ios-device") return new Set([...DEVICE_BROKER_IOS_DEVICE_TOOL_METHODS]);
    return new Set();
}

function brokerDeviceToolSupportedByBackend(backend: string | null, tool: string) {
    return brokerDeviceToolSupportedMethods(backend).has(tool);
}

export function deviceBrokerToolContractForTest() {
    const capabilities = new Map<string, string[]>([
        ["android-emulator", ANDROID_EMULATOR_CAPABILITIES],
        ["android-device", ANDROID_REAL_CAPABILITIES],
        ["ios-simulator", IOS_SIMULATOR_CAPABILITIES],
        ["ios-device", IOS_REAL_CAPABILITIES],
        ["windows-sandbox", DESKTOP_DEVICE_CAPABILITIES],
        ["windows-vm", HYPER_V_VM_CAPABILITIES],
        ["linux-vm", HYPER_V_VM_CAPABILITIES],
        ["macos-vm", MACOS_VM_CAPABILITIES],
    ]);
    return {
        backends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS.map((backend) => ({
            backend,
            capabilities: [...(capabilities.get(backend) || [])],
            supportedTools: [...brokerDeviceToolSupportedMethods(backend)],
        })),
    };
}

function joinHostProjectPath(root: string, rel: string): string {
    const parts = rel.split("/").filter(Boolean);
    if (/^[A-Za-z]:[\\/]/.test(root)) return [root.replace(/[\\/]+$/, ""), ...parts].join("\\");
    return join(root, ...parts);
}

type BrokerHostPathTranslation = { ok: true; value: unknown } | { ok: false };

function translateContainerProjectPathForHost(value: unknown, normalized: NormalizedBrokerOptions): BrokerHostPathTranslation {
    if (typeof value !== "string") return { ok: true, value };
    const absolute = posix.isAbsolute(value) || win32.isAbsolute(value);
    if (!absolute) return { ok: true, value };
    const projectMount = deviceLabProjectMountPath(normalized.cwd);
    if (posix.isAbsolute(value) && (value === projectMount || value.startsWith(`${projectMount}/`))) {
        const rel = value.slice(projectMount.length).replace(/^\/+/, "");
        const parts = rel.split("/").filter(Boolean);
        if (parts.some((part) => part === "." || part === ".." || part.includes("\\"))) return { ok: false };
        return { ok: true, value: joinHostProjectPath(normalized.cwd, rel) };
    }
    if (isAbsolute(value) && pathWithin(normalized.cwd, value)) {
        return { ok: true, value: resolve(value) };
    }
    return { ok: false };
}

function translateDeviceToolPathsForHost(parsed: DeviceToolParamSuccess, normalized: NormalizedBrokerOptions): DeviceToolParamSuccess | BrokerRpcResult {
    const params = { ...parsed.params };
    for (const key of ["localPath", "path"]) {
        if (typeof params[key] === "string") {
            const translated = translateContainerProjectPathForHost(params[key], normalized);
            if (!translated.ok) {
                return {
                    status: 400,
                    payload: { ok: false, error: "device-tool-path-outside-project-mount", field: key },
                };
            }
            params[key] = translated.value;
        }
    }
    return {
        ...parsed,
        localPath: typeof params.localPath === "string" && params.localPath ? params.localPath : null,
        params,
    };
}

type HyperVTrackedSnapshot = {
    id: string;
    name: string;
    providerName: string;
    snapshotType?: string;
    createdAt?: string;
};

function hyperVJournalPersistenceRuntime(): HyperVJournalPersistenceRuntime {
    return {
        deviceRoot: hyperVDeviceRoot,
        ensurePrivateDeviceRoot: ensureHyperVPrivateDeviceRoot,
        readDevices: readOwnerDevices,
        journalLimitBytes: DEVICE_BROKER_HYPER_V_OPERATION_JOURNAL_LIMIT_BYTES,
    };
}

function hyperVSnapshotJournalPath(ownerId: string, backend: string, deviceId: string): string {
    return hyperVSnapshotJournalFilePath(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

function readHyperVSnapshotJournal(ownerId: string, backend: string, deviceId: string): HyperVSnapshotJournal | null {
    return readHyperVSnapshotJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

function writeHyperVSnapshotJournal(ownerId: string, backend: string, deviceId: string, incarnationId: string, tool: HyperVSnapshotJournal["tool"], snapshotName: string, providerName: string, snapshotId?: string): void {
    writeHyperVSnapshotJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
        incarnationId,
        tool,
        snapshotName,
        providerName,
        snapshotId,
    );
}

async function reconcileHyperVSnapshotJournal(ownerId: string, backend: string, deviceId: string, device: Record<string, unknown>, powershell: string, normalized: NormalizedBrokerOptions): Promise<
    | { ok: true; device: Record<string, unknown>; reconciled: boolean }
    | { ok: false; status: number; error: string; detail?: string }> {
    let journal: HyperVSnapshotJournal | null;
    try {
        journal = readHyperVSnapshotJournal(ownerId, backend, deviceId);
    } catch (error) {
        return {
            ok: false,
            status: 409,
            error: "hyper-v-snapshot-journal-invalid",
            detail: hyperVBoundedErrorCode(error, "hyper-v-snapshot-journal-invalid"),
        };
    }
    if (!journal) return { ok: true, device, reconciled: false };
    const vmId = field(device, "vmId");
    const vmName = field(device, "vmName");
    const diskPath = field(device, "diskPath");
    const incarnationId = hyperVDeviceIncarnationId(device);
    if (!vmId || !vmName || !diskPath || !incarnationId || incarnationId !== journal.incarnationId) return { ok: false, status: 409, error: "hyper-v-snapshot-reconciliation-metadata-invalid" };
    const execution = await hyperVProviderCommandRunner(normalized, hyperVStatusCommand({ executable: powershell, ownerId, deviceId, incarnationId, vmName, vmId, diskPath }), { timeoutMs: 30000, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
    if (!commandSucceeded(execution)) return { ok: false, status: 502, error: "hyper-v-snapshot-reconciliation-failed", detail: hyperVProviderDiagnosticCode(execution, "hyper-v-snapshot-reconciliation-failed") };
    const observation = parseHyperVVmObservation(execution.stdout || "");
    if (!observation || observation.vmId !== vmId.toLowerCase() || observation.vmName !== vmName || resolve(observation.diskPath || "") !== resolve(diskPath)) return { ok: false, status: 502, error: "hyper-v-snapshot-reconciliation-invalid-result" };
    const live = (observation.snapshots || []).filter((snapshot) => snapshot.snapshotName === journal!.providerName);
    if (live.length > 1) return { ok: false, status: 409, error: "hyper-v-snapshot-reconciliation-ambiguous" };
    const tracked = trackedHyperVSnapshots(device);
    let snapshots = tracked;
    let activeSnapshotId = typeof device.activeSnapshotId === "string" ? device.activeSnapshotId : null;
    if (journal.tool === "device_snapshot_create" && live.length === 1) {
        const snapshotId = live[0].snapshotId.toLowerCase();
        snapshots = [...tracked.filter((snapshot) => snapshot.name !== journal!.snapshotName && snapshot.id.toLowerCase() !== snapshotId), {
            id: snapshotId,
            name: journal.snapshotName,
            providerName: journal.providerName,
            ...(live[0].snapshotType ? { snapshotType: live[0].snapshotType } : {}),
            createdAt: journal.startedAt,
        }];
    } else if (journal.tool === "device_snapshot_delete" && live.length === 0) {
        snapshots = tracked.filter((snapshot) => snapshot.id.toLowerCase() !== journal!.snapshotId!.toLowerCase());
        if (activeSnapshotId?.toLowerCase() === journal.snapshotId!.toLowerCase()) activeSnapshotId = null;
    } else if (journal.tool === "device_snapshot_restore" && live.length === 1 && live[0].snapshotId.toLowerCase() === journal.snapshotId!.toLowerCase()) {
        activeSnapshotId = journal.snapshotId!.toLowerCase();
    }
    let updated = device;
    mutateOwnerDevices(ownerId, backend, (devices) => devices.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || (candidate as Record<string, unknown>).id !== deviceId) return candidate;
        updated = { ...(candidate as Record<string, unknown>), snapshots, activeSnapshotId, runtimeState: observation.state, status: observation.state.toLowerCase() === "running" ? "running" : "stopped", updatedAt: new Date().toISOString() };
        return updated;
    }));
    rmSync(hyperVSnapshotJournalPath(ownerId, backend, deviceId), { force: true });
    return { ok: true, device: updated, reconciled: true };
}

function trackedHyperVSnapshots(device: Record<string, unknown>): HyperVTrackedSnapshot[] {
    if (!Array.isArray(device.snapshots)) return [];
    return device.snapshots.flatMap((snapshot) => {
        if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
        const record = snapshot as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.providerName !== "string") return [];
        return [{
            id: record.id,
            name: record.name,
            providerName: record.providerName,
            ...(typeof record.snapshotType === "string" ? { snapshotType: record.snapshotType } : {}),
            ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
        }];
    });
}

function transitionHyperVSnapshotState(ownerId: string, backend: string, deviceId: string, expected: Record<string, unknown>, replacement: Record<string, unknown>) {
    let found = false;
    let matched = false;
    let current: Record<string, unknown> | null = null;
    mutateOwnerDevices(ownerId, backend, (devices) => devices.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || (candidate as Record<string, unknown>).id !== deviceId) return candidate;
        found = true;
        current = candidate as Record<string, unknown>;
        if (!isDeepStrictEqual(candidate, expected)) return candidate;
        matched = true;
        current = replacement;
        return replacement;
    }));
    return { found, matched, device: current };
}

function hyperVSnapshotStateConflict(ownerId: string, backend: string, deviceId: string, transition: ReturnType<typeof transitionHyperVSnapshotState>, rollback?: unknown): BrokerRpcResult {
    return {
        status: 409,
        payload: {
            ok: false,
            error: "hyper-v-snapshot-state-conflict",
            ownerId,
            backend,
            deviceId,
            found: transition.found,
            currentDevice: redactHyperVDeviceSecrets(transition.device),
            ...(rollback ? { rollback } : {}),
        },
    };
}

async function invokeHyperVDeviceTool(ownerId: string, parsed: DeviceToolParamSuccess, match: DeviceToolMatch, normalized: NormalizedBrokerOptions): Promise<BrokerRpcResult> {
    const deviceId = String(parsed.deviceId);
    let device = match.device;
    const powershell = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
    if (!powershell) return { status: 400, payload: { ok: false, error: "missing-provider-command", missing: ["powershell"], backend: match.backend, deviceId } };
    if ((parsed.tool === "device_snapshot_restore" || parsed.tool === "device_snapshot_delete")
        && parsed.params.confirmDestructive !== true) {
        return {
            status: 400,
            payload: {
                ok: false,
                error: "destructive-confirmation-required",
                confirmationField: "confirmDestructive",
                ownerId,
                backend: match.backend,
                deviceId,
                tool: parsed.tool,
            },
        };
    }
    const initialIncarnationId = hyperVDeviceIncarnationId(device);
    if (!DEVICE_BROKER_READ_ONLY_TOOL_METHODS.has(parsed.tool)) {
        const expectedIncarnationId = parsed.params.incarnationId;
        if (!validHyperVIncarnationId(expectedIncarnationId)) {
            return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-required", ownerId, backend: match.backend, deviceId, tool: parsed.tool } };
        }
        if (!initialIncarnationId || expectedIncarnationId !== initialIncarnationId) {
            return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-conflict", ownerId, backend: match.backend, deviceId, tool: parsed.tool } };
        }
    }
    if (parsed.tool === "device_snapshot_list" || parsed.tool === "device_snapshot_create" || parsed.tool === "device_snapshot_restore" || parsed.tool === "device_snapshot_delete") {
        const reconciliation = await reconcileHyperVSnapshotJournal(ownerId, match.stateKey, deviceId, device, powershell, normalized);
        if (!reconciliation.ok) return { status: reconciliation.status, payload: { ok: false, error: reconciliation.error, ownerId, backend: match.backend, deviceId, ...(reconciliation.detail ? { detail: reconciliation.detail } : {}) } };
        device = reconciliation.device;
    }
    const vmId = typeof device.vmId === "string" ? device.vmId : null;
    const vmName = typeof device.vmName === "string" ? device.vmName : null;
    const diskPath = typeof device.diskPath === "string" ? device.diskPath : null;
    const incarnationId = hyperVDeviceIncarnationId(device);
    if (!vmId || !vmName || !diskPath || !incarnationId) {
        return { status: 409, payload: { ok: false, error: "missing-provider-metadata", missing: ["vmId", "vmName", "diskPath", "incarnationId"], backend: match.backend, deviceId } };
    }
    if (parsed.tool === "device_snapshot_list") {
        const execution = await hyperVProviderCommandRunner(normalized, hyperVStatusCommand({ executable: powershell, ownerId, deviceId, incarnationId, vmName, vmId, diskPath }), { timeoutMs: 120000, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
        if (!commandSucceeded(execution)) {
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: "hyper-v-snapshot-list-provider-failed",
                    ownerId,
                    backend: match.backend,
                    deviceId,
                    execution: redactProviderCommandInput(
                        execution,
                        true,
                        "hyper-v-snapshot-list-provider-failed",
                    ),
                },
            };
        }
        const observation = parseHyperVVmObservation(execution.stdout || "");
        if (!observation
            || observation.vmId.toLowerCase() !== vmId.toLowerCase()
            || observation.vmName !== vmName
            || resolve(observation.diskPath || "") !== resolve(diskPath)) {
            return { status: 502, payload: { ok: false, error: "hyper-v-snapshot-list-invalid-result", ownerId, backend: match.backend, deviceId } };
        }
        const tracked = trackedHyperVSnapshots(device);
        const providerSnapshots = Array.isArray(observation.snapshots) ? observation.snapshots : [];
        const liveById = new Map(providerSnapshots.map((snapshot) => [snapshot.snapshotId.toLowerCase(), snapshot]));
        const trackedIds = new Set(tracked.map((snapshot) => snapshot.id.toLowerCase()));
        const ownerPrefix = `ccc-${ownerId}-`;
        const untracked = providerSnapshots.filter((snapshot) => snapshot.snapshotName.startsWith(ownerPrefix) && !trackedIds.has(snapshot.snapshotId.toLowerCase()));
        const missing = tracked.filter((snapshot) => {
            const live = liveById.get(snapshot.id.toLowerCase());
            return !live || live.snapshotName !== snapshot.providerName;
        });
        if (untracked.length > 0 || missing.length > 0) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "hyper-v-snapshot-inventory-conflict",
                    ownerId,
                    backend: match.backend,
                    deviceId,
                    untracked: untracked.map((snapshot) => ({ id: snapshot.snapshotId, providerName: snapshot.snapshotName })),
                    missing: missing.map((snapshot) => ({ id: snapshot.id, name: snapshot.name })),
                },
            };
        }
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId,
                    backend: match.backend,
                    stateKey: match.stateKey,
                    deviceId,
                    tool: parsed.tool,
                    provider: "hyper-v",
                    snapshots: tracked,
                    activeSnapshotId: typeof device.activeSnapshotId === "string" ? device.activeSnapshotId : null,
                    startsDevices: false,
                },
            },
        };
    }
    if (match.backend === "linux-vm" && (parsed.tool === "device_exec" || parsed.tool === "device_upload" || parsed.tool === "device_download")) {
        const deviceRoot = field(device, "deviceRoot");
        const privateRoot = field(device, "privateRoot");
        const sshPrivateKeyPath = field(device, "sshPrivateKeyPath");
        const sshHostPublicKeyPath = field(device, "sshHostPublicKeyPath");
        const sshHostKeyFingerprint = field(device, "sshHostKeyFingerprint");
        const knownHostsPath = field(device, "sshKnownHostsPath");
        const guestUsername = field(device, "guestUsername");
        const networkAddress = field(device, "networkAddress");
        const expectedRoot = hyperVDeviceRoot(ownerId, "linux-vm", deviceId);
        const expectedPrivateRoot = hyperVPrivateDeviceRoot(ownerId, "linux-vm", deviceId);
        if (deviceRoot !== expectedRoot
            || privateRoot !== expectedPrivateRoot
            || sshPrivateKeyPath !== join(expectedPrivateRoot, "secrets", "id_ed25519")
            || sshHostPublicKeyPath !== join(expectedPrivateRoot, "secrets", "ssh_host_ed25519_key.pub")
            || knownHostsPath !== join(expectedPrivateRoot, "secrets", "known_hosts")
            || !sshHostKeyFingerprint || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(sshHostKeyFingerprint)
            || !guestUsername || !networkAddress) {
            return { status: 409, payload: { ok: false, error: "hyper-v-linux-guest-metadata-invalid", backend: match.backend, deviceId } };
        }
        try {
            assertHyperVPrivateDeviceRoot(ownerId, "linux-vm", deviceId, privateRoot);
            if (!withDeviceLabReadableFile(sshPrivateKeyPath, "hyper-v-linux-ssh-private-key", 64 * 1024, () => true)) throw new Error("hyper-v-linux-ssh-private-key-unavailable");
            if (!validateHyperVLinuxSshHostIdentity(ownerId, deviceId, sshHostPublicKeyPath, knownHostsPath, networkAddress, sshHostKeyFingerprint)) throw new Error("hyper-v-linux-ssh-host-identity-invalid");
        } catch (error) {
            return { status: 409, payload: { ok: false, error: deviceLabStateFileErrorCode(error) || (error instanceof Error ? error.message : "hyper-v-linux-ssh-private-key-invalid"), backend: match.backend, deviceId } };
        }
        const timeoutMs = Math.min(DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS, Math.max(1000, typeof parsed.params.helperTimeoutMs === "number" ? parsed.params.helperTimeoutMs : 30000));
        const common = { deviceRoot, privateRoot, sshPrivateKeyPath, knownHostsPath, guestUsername, networkAddress, timeoutMs };
        let providerCommand: ProviderCommand;
        let localPath: string | null = null;
        let stagingPath: string | null = null;
        let sourceBytes: number | null = null;
        let downloadMaxBytes: number | null = null;
        try {
            if (parsed.tool === "device_exec") {
                const ssh = providerExecutable("ssh.exe", normalized) || providerExecutable("ssh", normalized);
                if (!ssh) return { status: 503, payload: { ok: false, error: "missing-provider-command", missing: ["ssh"], backend: match.backend, deviceId } };
                providerCommand = hyperVLinuxSshExecCommand({ ...common, executable: ssh, guestCommand: typeof parsed.params.command === "string" ? parsed.params.command : "" });
            } else {
                const rawLocalPath = parsed.localPath || "";
                localPath = isAbsolute(rawLocalPath) ? resolve(rawLocalPath) : resolve(normalized.cwd, rawLocalPath);
                assertDeviceLabPathWithinRoot(normalized.cwd, localPath, "hyper-v-linux-guest-transfer");
                if (parsed.tool === "device_upload") {
                    const scp = providerExecutable("scp.exe", normalized) || providerExecutable("scp", normalized);
                    if (!scp) return { status: 503, payload: { ok: false, error: "missing-provider-command", missing: ["scp"], backend: match.backend, deviceId } };
                    const stagingRoot = join(privateRoot, "transfers");
                    mkdirSync(stagingRoot, { recursive: true });
                    assertNoSymlinkPathComponents(stagingRoot, "hyper-v-linux-guest-transfer-staging");
                    stagingPath = join(stagingRoot, `upload-${randomBytes(16).toString("hex")}.tmp`);
                    const maxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                    const source = readDeviceLabBinaryFileWithinRoot(normalized.cwd, localPath, "hyper-v-linux-guest-upload", maxBytes);
                    if (source === null) return { status: 404, payload: { ok: false, error: "hyper-v-linux-guest-upload-source-missing", backend: match.backend, deviceId } };
                    sourceBytes = source.length;
                    writeDeviceLabBinaryFile(privateRoot, stagingPath, source, "hyper-v-linux-guest-upload-staging", { allowNestedCreate: true });
                    providerCommand = hyperVLinuxScpUploadCommand({ ...common, executable: scp, localPath: stagingPath, remotePath: parsed.remotePath || "" });
                } else {
                    downloadMaxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                    const ssh = providerExecutable("ssh.exe", normalized) || providerExecutable("ssh", normalized);
                    if (!ssh) return { status: 503, payload: { ok: false, error: "missing-provider-command", missing: ["ssh"], backend: match.backend, deviceId } };
                    const remotePath = parsed.remotePath || "";
                    const encodedPath = Buffer.from(remotePath, "utf8").toString("base64");
                    providerCommand = hyperVLinuxSshExecCommand({ ...common, executable: ssh, guestCommand: `set -o pipefail; p=$(printf %s ${encodedPath} | base64 -d); head -c ${downloadMaxBytes + 1} -- "$p" | base64 -w0` });
                }
            }
        } catch (error) {
            return { status: 400, payload: { ok: false, error: deviceLabStateFileErrorCode(error) || (error instanceof Error ? error.message : "invalid-hyper-v-linux-guest-options"), backend: match.backend, deviceId } };
        }
        const outputLimit = parsed.tool === "device_download" && downloadMaxBytes !== null
            ? Math.ceil((downloadMaxBytes + 1) / 3) * 4 + 4096
            : DEVICE_BROKER_COMMAND_OUTPUT_LIMIT;
        const execution = await hyperVProviderCommandRunner(normalized, providerCommand, { timeoutMs, outputLimit });
        if (!commandSucceeded(execution)) {
            if (stagingPath) rmSync(stagingPath, { force: true });
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: "hyper-v-linux-guest-provider-failed",
                    ownerId,
                    backend: match.backend,
                    deviceId,
                    execution: redactProviderCommandInput(
                        execution,
                        true,
                        "hyper-v-linux-guest-provider-failed",
                    ),
                },
            };
        }
        let bytes = sourceBytes;
        if (parsed.tool === "device_download" && localPath) {
            try {
                const maxBytes = downloadMaxBytes || 16 * 1024 * 1024;
                const encoded = String(execution.stdout || "").trim();
                if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("hyper-v-linux-guest-download-invalid-base64");
                const downloaded = Buffer.from(encoded, "base64");
                if (downloaded.length > maxBytes) {
                    return { status: 413, payload: { ok: false, error: "hyper-v-linux-guest-download-source-too-large", ownerId, backend: match.backend, deviceId, bytes: downloaded.length, maxFileBytes: maxBytes } };
                }
                bytes = downloaded.length;
                writeDeviceLabBinaryFile(normalized.cwd, localPath, downloaded, "hyper-v-linux-guest-download");
            } catch (error) {
                return { status: 502, payload: { ok: false, error: deviceLabStateFileErrorCode(error) || "hyper-v-linux-guest-download-invalid-artifact", ownerId, backend: match.backend, deviceId } };
            }
        } else if (stagingPath) {
            rmSync(stagingPath, { force: true });
        }
        return { status: 200, payload: { ok: true, result: { ownerId, backend: match.backend, stateKey: match.stateKey, deviceId, tool: parsed.tool, provider: parsed.tool === "device_upload" ? "hyper-v-scp" : "hyper-v-ssh", status: 0, stdout: parsed.tool === "device_download" ? "" : execution.stdout || "", stderr: execution.stderr || "", ...(localPath ? { localPath } : {}), ...(parsed.remotePath ? { remotePath: parsed.remotePath } : {}), ...(bytes !== null ? { bytes } : {}), startsDevices: false } } };
    }
    if (parsed.tool === "device_exec" || parsed.tool === "device_upload" || parsed.tool === "device_download") {
        const deviceRoot = typeof device.deviceRoot === "string" ? device.deviceRoot : null;
        const privateRoot = typeof device.privateRoot === "string" ? device.privateRoot : null;
        const credentialPath = typeof device.guestCredentialPath === "string" ? device.guestCredentialPath : null;
        const expectedRoot = hyperVDeviceRoot(ownerId, "windows-vm", deviceId);
        const expectedPrivateRoot = hyperVPrivateDeviceRoot(ownerId, "windows-vm", deviceId);
        const expectedCredential = join(expectedPrivateRoot, "secrets", "guest.credential.xml");
        if (deviceRoot !== expectedRoot || privateRoot !== expectedPrivateRoot || credentialPath !== expectedCredential) {
            return { status: 409, payload: { ok: false, error: "hyper-v-guest-metadata-invalid", backend: match.backend, deviceId } };
        }
        try {
            assertHyperVPrivateDeviceRoot(ownerId, "windows-vm", deviceId, privateRoot);
            const credentialAvailable = withDeviceLabReadableFile(credentialPath, "hyper-v-guest-credential", 64 * 1024, () => true);
            if (!credentialAvailable) return { status: 409, payload: { ok: false, error: "hyper-v-guest-credential-unavailable", backend: match.backend, deviceId } };
        } catch (error) {
            return { status: 409, payload: { ok: false, error: deviceLabStateFileErrorCode(error) || "hyper-v-guest-credential-invalid", backend: match.backend, deviceId } };
        }
        const base = { executable: powershell, ownerId, deviceId, incarnationId, vmName, vmId, diskPath, deviceRoot, privateRoot, credentialPath };
        let providerCommand: ProviderCommand;
        let transferLocalPath: string | null = null;
        let transferStagingPath: string | null = null;
        try {
            if (parsed.tool === "device_exec") {
                providerCommand = hyperVGuestExecCommand({ ...base, guestCommand: typeof parsed.params.command === "string" ? parsed.params.command : "" });
            } else {
                const rawLocalPath = parsed.localPath || "";
                const localPath = isAbsolute(rawLocalPath) ? resolve(rawLocalPath) : resolve(normalized.cwd, rawLocalPath);
                assertDeviceLabPathWithinRoot(normalized.cwd, localPath, "hyper-v-guest-transfer");
                transferLocalPath = localPath;
                if (parsed.tool === "device_upload") {
                    const maxBytes = typeof parsed.params.maxFileBytes === "number"
                        ? Math.min(parsed.params.maxFileBytes, DEVICE_BROKER_HYPER_V_GUEST_UPLOAD_LIMIT_BYTES)
                        : 16 * 1024 * 1024;
                    const source = readDeviceLabBinaryFileWithinRoot(normalized.cwd, localPath, "hyper-v-guest-upload", maxBytes);
                    if (source === null) return { status: 404, payload: { ok: false, error: "hyper-v-guest-upload-source-missing", backend: match.backend, deviceId } };
                    const stagingRoot = join(privateRoot, "transfers");
                    mkdirSync(stagingRoot, { recursive: true });
                    assertNoSymlinkPathComponents(stagingRoot, "hyper-v-guest-upload-staging");
                    transferStagingPath = join(stagingRoot, `upload-${randomBytes(16).toString("hex")}.tmp`);
                    writeDeviceLabBinaryFile(privateRoot, transferStagingPath, source, "hyper-v-guest-upload-staging", { allowNestedCreate: true });
                }
                if (parsed.tool === "device_download") {
                    const stagingRoot = join(privateRoot, "downloads");
                    mkdirSync(stagingRoot, { recursive: true });
                    assertNoSymlinkPathComponents(stagingRoot, "hyper-v-guest-download-staging");
                    transferStagingPath = join(stagingRoot, `download-${randomBytes(16).toString("hex")}.tmp`);
                }
                const downloadMaxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                providerCommand = parsed.tool === "device_upload"
                    ? hyperVGuestUploadCommand({ ...base, localPath: transferStagingPath!, remotePath: parsed.remotePath || "" })
                    : hyperVGuestDownloadCommand({ ...base, localPath: transferStagingPath!, remotePath: parsed.remotePath || "", maxBytes: downloadMaxBytes });
            }
        } catch (error) {
            return { status: 400, payload: { ok: false, error: deviceLabStateFileErrorCode(error) || (error instanceof Error ? error.message : "invalid-hyper-v-guest-options"), backend: match.backend, deviceId } };
        }
        const timeoutMs = Math.min(DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS, Math.max(1000, typeof parsed.params.helperTimeoutMs === "number" ? parsed.params.helperTimeoutMs : 30000));
        const execution = await hyperVProviderCommandRunner(normalized, providerCommand, { timeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
        if (!commandSucceeded(execution)) {
            if (transferStagingPath) rmSync(transferStagingPath, { force: true });
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: "hyper-v-guest-provider-failed",
                    ownerId,
                    backend: match.backend,
                    deviceId,
                    execution: redactProviderCommandInput(
                        execution,
                        true,
                        "hyper-v-guest-provider-failed",
                    ),
                },
            };
        }
        const observation = parsed.tool === "device_exec"
            ? parseHyperVGuestExecObservation(execution.stdout || "")
            : parseHyperVGuestTransferObservation(execution.stdout || "");
        if (!observation) {
            if (transferStagingPath) rmSync(transferStagingPath, { force: true });
            return { status: 502, payload: { ok: false, error: "hyper-v-guest-invalid-result", ownerId, backend: match.backend, deviceId } };
        }
        if (parsed.tool === "device_download" && transferLocalPath && transferStagingPath) {
            try {
                const maxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                const downloaded = readDeviceLabBinaryFile(transferStagingPath, "hyper-v-guest-download-staging", maxBytes);
                const downloadedBytes = downloaded?.length ?? null;
                if (downloadedBytes === null || !("bytes" in observation) || observation.bytes !== downloadedBytes) {
                    return { status: 502, payload: { ok: false, error: "hyper-v-guest-download-invalid-artifact", ownerId, backend: match.backend, deviceId } };
                }
                writeDeviceLabBinaryFile(normalized.cwd, transferLocalPath, downloaded!, "hyper-v-guest-download");
                observation.localPath = transferLocalPath;
            } catch (error) {
                return { status: 502, payload: { ok: false, error: deviceLabStateFileErrorCode(error) || "hyper-v-guest-download-invalid-artifact", ownerId, backend: match.backend, deviceId } };
            } finally {
                rmSync(transferStagingPath, { force: true });
            }
        } else if (parsed.tool === "device_upload" && transferLocalPath && transferStagingPath) {
            if (!("bytes" in observation)) {
                rmSync(transferStagingPath, { force: true });
                return { status: 502, payload: { ok: false, error: "hyper-v-guest-upload-invalid-result", ownerId, backend: match.backend, deviceId } };
            }
            observation.localPath = transferLocalPath;
            rmSync(transferStagingPath, { force: true });
        }
        const guestFailed = parsed.tool === "device_exec" && "status" in observation && observation.status !== 0;
        return {
            status: guestFailed ? 422 : 200,
            payload: {
                ok: !guestFailed,
                ...(guestFailed ? { error: "hyper-v-guest-command-failed" } : {}),
                result: { ownerId, backend: match.backend, stateKey: match.stateKey, deviceId, tool: parsed.tool, provider: "hyper-v-powershell-direct", ...observation, startsDevices: false },
            },
        };
    }
    const requestedName = typeof parsed.params.snapshotName === "string" ? parsed.params.snapshotName : null;
    const requestedId = typeof parsed.params.snapshotId === "string" ? parsed.params.snapshotId.toLowerCase() : null;
    const snapshots = trackedHyperVSnapshots(device);
    let tracked: HyperVTrackedSnapshot | null = null;
    if (parsed.tool !== "device_snapshot_create") {
        const matches = snapshots.filter((snapshot) => (!requestedName || snapshot.name === requestedName) && (!requestedId || snapshot.id.toLowerCase() === requestedId));
        if ((!requestedName && !requestedId) || matches.length !== 1) {
            return { status: 404, payload: { ok: false, error: "hyper-v-snapshot-not-found", ownerId, backend: match.backend, deviceId, snapshotName: requestedName, snapshotId: requestedId } };
        }
        tracked = matches[0];
    }
    if (parsed.tool === "device_snapshot_create") {
        if (!requestedName) return { status: 400, payload: { ok: false, error: "missing-snapshot-name", deviceId } };
        if (snapshots.some((snapshot) => snapshot.name === requestedName)) {
            return { status: 409, payload: { ok: false, error: "hyper-v-snapshot-already-exists", ownerId, backend: match.backend, deviceId, snapshotName: requestedName } };
        }
    }
    const snapshotName = parsed.tool === "device_snapshot_create" ? String(requestedName) : String(tracked?.name);
    const expectedProviderName = hyperVSnapshotName(ownerId, snapshotName);
    let providerCommand: ProviderCommand;
    try {
        const options = { executable: powershell, ownerId, deviceId, incarnationId, vmName, vmId, diskPath, snapshotName, snapshotId: tracked?.id || null, force: parsed.params.force === true };
        providerCommand = parsed.tool === "device_snapshot_create"
            ? hyperVSnapshotCreateCommand(options)
            : parsed.tool === "device_snapshot_restore"
                ? hyperVSnapshotRestoreCommand(options)
                : hyperVSnapshotDeleteCommand(options);
    } catch (error) {
        return {
            status: 400,
            payload: {
                ok: false,
                error: hyperVBoundedErrorCode(
                    error,
                    "invalid-hyper-v-snapshot-options",
                ),
                ownerId,
                backend: match.backend,
                deviceId,
            },
        };
    }
    try {
        writeHyperVSnapshotJournal(ownerId, match.stateKey, deviceId, incarnationId, parsed.tool as HyperVSnapshotJournal["tool"], snapshotName, expectedProviderName, tracked?.id);
    } catch (error) {
        return {
            status: 409,
            payload: {
                ok: false,
                error: "hyper-v-snapshot-journal-write-failed",
                ownerId,
                backend: match.backend,
                deviceId,
                detail: hyperVBoundedErrorCode(
                    error,
                    "hyper-v-snapshot-journal-write-failed",
                ),
            },
        };
    }
    const execution = await hyperVProviderCommandRunner(normalized, providerCommand, { timeoutMs: 120000, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
    if (!commandSucceeded(execution)) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "hyper-v-snapshot-provider-failed",
                ownerId,
                backend: match.backend,
                deviceId,
                execution: redactProviderCommandInput(
                    execution,
                    true,
                    "hyper-v-snapshot-provider-failed",
                ),
            },
        };
    }
    const observation = parsed.tool === "device_snapshot_delete"
        ? parseHyperVSnapshotDeleteObservation(execution.stdout || "")
        : parseHyperVSnapshotObservation(execution.stdout || "");
    if (!observation || observation.snapshotName !== expectedProviderName || (tracked && observation.snapshotId.toLowerCase() !== tracked.id.toLowerCase())) {
        return { status: 502, payload: { ok: false, error: "hyper-v-snapshot-invalid-result", ownerId, backend: match.backend, deviceId } };
    }
    const now = new Date().toISOString();
    const snapshot: HyperVTrackedSnapshot = tracked || {
        id: observation.snapshotId.toLowerCase(),
        name: snapshotName,
        providerName: observation.snapshotName,
        ...(observation.snapshotType ? { snapshotType: observation.snapshotType } : {}),
        createdAt: now,
    };
    const nextSnapshots = parsed.tool === "device_snapshot_create"
        ? [...snapshots, snapshot]
        : parsed.tool === "device_snapshot_delete"
            ? snapshots.filter((candidate) => candidate.id.toLowerCase() !== snapshot.id.toLowerCase())
            : snapshots;
    const replacement = {
        ...device,
        snapshots: nextSnapshots,
        ...(parsed.tool === "device_snapshot_restore" ? { activeSnapshotId: snapshot.id, status: "stopped", runtimeState: observation.state || "Off" } : {}),
        ...(parsed.tool === "device_snapshot_delete" && device.activeSnapshotId === snapshot.id ? { activeSnapshotId: null } : {}),
        updatedAt: now,
    };
    const transition = transitionHyperVSnapshotState(ownerId, match.stateKey, deviceId, device, replacement);
    if (!transition.matched) {
        if (parsed.tool === "device_snapshot_create") {
            const rollbackCommand = hyperVSnapshotDeleteCommand({ executable: powershell, ownerId, deviceId, incarnationId, vmName, vmId, diskPath, snapshotName, snapshotId: snapshot.id });
            const rollback = await hyperVProviderCommandRunner(normalized, rollbackCommand, { timeoutMs: 120000, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
            const rollbackObservation = commandSucceeded(rollback) ? parseHyperVSnapshotDeleteObservation(rollback.stdout || "") : null;
            const rollbackConfirmed = Boolean(rollbackObservation
                && rollbackObservation.snapshotId.toLowerCase() === snapshot.id.toLowerCase()
                && rollbackObservation.snapshotName === expectedProviderName);
            return hyperVSnapshotStateConflict(ownerId, String(match.backend), deviceId, transition, {
                execution: redactProviderCommandInput(
                    rollback,
                    true,
                    "hyper-v-snapshot-rollback-failed",
                ),
                confirmed: rollbackConfirmed,
                ...(!rollbackConfirmed ? { error: "hyper-v-snapshot-rollback-unconfirmed" } : {}),
            });
        }
        return hyperVSnapshotStateConflict(ownerId, String(match.backend), deviceId, transition);
    }
    clearHyperVSnapshotJournal(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        match.stateKey,
        deviceId,
    );
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: match.backend,
                stateKey: match.stateKey,
                deviceId,
                tool: parsed.tool,
                provider: "hyper-v",
                snapshot,
                device: redactHyperVDeviceSecrets(transition.device),
                execution: redactProviderCommandInput(execution, true),
                startsDevices: false,
            },
        },
    };
}

async function invokeBackendDeviceTool(ownerId: string, parsed: DeviceToolParamSuccess, normalized: NormalizedBrokerOptions): Promise<BrokerRpcResult> {
    const match = findOwnerDeviceForTool(ownerId, parsed);
    if ("status" in match) return match;
    if (!brokerDeviceToolSupportedByBackend(match.backend, parsed.tool)) {
        return {
            status: 501,
            payload: {
                ok: false,
                error: "broker-device-tool-backend-not-supported",
                backend: match.backend,
                tool: parsed.tool,
                deviceId: parsed.deviceId,
                supportedTools: [...brokerDeviceToolSupportedMethods(match.backend)],
                supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
            },
        };
    }
    const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, match, String(parsed.deviceId));
    if (leaseFailure) return leaseFailure;
    if (isHyperVBackend(match.backend)) return await invokeHyperVDeviceTool(ownerId, parsed, match, normalized);
    return await normalized.deviceToolRunner(ownerId, parsed, match, normalized);
}

async function invokeDeviceTool(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions): Promise<BrokerRpcResult> {
    const validation = validateDeviceToolParams(params);
    if (!validation.ok) {
        const { status, ...payload } = validation;
        return { status, payload };
    }
    const parsed = translateDeviceToolPathsForHost(validation, normalized);
    if ("status" in parsed) return parsed;
    if (parsed.tool === "device_inventory") return invokeDeviceInventory(ownerId, parsed, normalized);
    if (DEVICE_BROKER_UNATTACHED_TOOL_METHODS.has(parsed.tool)) {
        if (parsed.backend !== "android-device" && parsed.backend !== "ios-device") {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error: "invalid-unattached-device-tool-backend",
                    backend: parsed.backend,
                    tool: parsed.tool,
                    allowed: ["android-device", "ios-device"],
                },
            };
        }
        if (!brokerDeviceToolSupportedByBackend(parsed.backend, parsed.tool)) {
            return { status: 501, payload: { ok: false, error: "broker-device-tool-backend-not-supported", backend: parsed.backend, tool: parsed.tool } };
        }
        return await normalized.deviceToolRunner(ownerId, parsed, {
            stateKey: String(parsed.stateKey),
            backend: parsed.backend,
            device: {},
        }, normalized);
    }
    if (parsed.tool === "device_record_video_status" || parsed.tool === "device_record_video_start" || parsed.tool === "device_record_video_stop") {
        const match = findOwnerDeviceForTool(ownerId, parsed);
        if ("status" in match) return match;
        if (match.stateKey === "windows" || match.stateKey === "macos") {
            // The out-of-process backend owns this same cross-process lock.
            return await invokeBackendDeviceTool(ownerId, parsed, normalized);
        }
        if (parsed.tool === "device_record_video_status") return invokeDeviceRecordingStatus(ownerId, parsed);
        try {
            return await withOwnerDeviceOperation(ownerId, match.stateKey, String(parsed.deviceId), () => parsed.tool === "device_record_video_start"
                ? invokeDeviceRecordingStart(ownerId, parsed, normalized)
                : invokeDeviceRecordingStop(ownerId, parsed, normalized));
        } catch (error) {
            if (!isDeviceOperationLockTimeout(error)) throw error;
            return deviceOperationLockFailure(ownerId, match.backend || match.stateKey, String(parsed.deviceId), error);
        }
    }
    if (DEVICE_BROKER_BACKEND_TOOL_METHODS.has(parsed.tool)) {
        if (isHyperVBackend(parsed.backend)) {
            try {
                return await withOwnerDeviceOperation(ownerId, String(parsed.stateKey), String(parsed.deviceId), () => invokeBackendDeviceTool(ownerId, parsed, normalized));
            } catch (error) {
                if (!isDeviceOperationLockTimeout(error)) throw error;
                return deviceOperationLockFailure(ownerId, String(parsed.backend), String(parsed.deviceId), error);
            }
        }
        return await invokeBackendDeviceTool(ownerId, parsed, normalized);
    }
    return { status: 501, payload: { ok: false, error: "broker-device-tool-not-supported", supported: [...DEVICE_BROKER_TOOL_METHODS] } };
}

function ownerDevicesFile(ownerId: string, stateKey: string) {
    return join(brokerRoot(), "owners", ownerId, stateKey, "devices.json");
}

function ownerDevicesMutationLockFile(ownerId: string, stateKey: string) {
    return join(brokerRoot(), "owners", ownerId, stateKey, "devices.mutation.lock");
}

function ownerDeviceOperationLockFile(ownerId: string, stateKey: string, deviceId: string) {
    const key = createHash("sha256").update(deviceId).digest("hex").slice(0, 32);
    return join(brokerRoot(), "owners", ownerId, stateKey, "operations", `${key}.lock`);
}

function withOwnerDeviceOperation<T>(ownerId: string, stateKey: string, deviceId: string, operation: () => Promise<T> | T) {
    return withSharedMutationLockAsync(ownerDeviceOperationLockFile(ownerId, stateKey, deviceId), operation, {
        waitMs: 30000,
        staleMs: 15 * 60 * 1000,
    });
}

function isDeviceOperationLockTimeout(error: unknown): error is Error & { code: "shared-mutation-lock-timeout" } {
    return error instanceof Error && (error as Error & { code?: string }).code === "shared-mutation-lock-timeout";
}

function deviceOperationLockFailure(ownerId: string, backend: string, deviceId: string, error: unknown): BrokerRpcResult {
    return {
        status: 409,
        payload: {
            ok: false,
            error: "device-operation-lock-failed",
            ownerId,
            backend,
            deviceId,
            detail: isHyperVBackend(backend)
                ? hyperVBoundedErrorCode(
                    error,
                    "hyper-v-device-operation-lock-failed",
                )
                : "device-operation-lock-failed",
        },
    };
}

function readOwnerDevices(ownerId: string, stateKey: string) {
    return readOwnerDeviceStateFile(ownerDevicesFile(ownerId, stateKey), DEVICE_BROKER_INVENTORY_FILE_LIMIT);
}

function ownerDeviceStateFailure(error: unknown, context: { backend?: string; stateKey?: string } = {}): BrokerRpcResult {
    const code = ownerDeviceStateErrorCode(error);
    if (!code) throw error;
    return {
        status: code === "owner-devices-file-too-large" ? 413 : code === "owner-devices-state-read-failed" ? 503 : 409,
        payload: { ok: false, error: code, ...context },
    };
}

function assertUniqueOwnerDeviceIds(devices: unknown[]) {
    const ids = new Set<string>();
    for (const device of devices) {
        const id = device && typeof device === "object" ? (device as Record<string, unknown>).id : null;
        if (typeof id !== "string" || !id) continue;
        if (ids.has(id)) throw new Error(`owner-device-id-conflict:${id}`);
        ids.add(id);
    }
}

function mutateOwnerDevices(ownerId: string, stateKey: string, updater: (devices: unknown[]) => unknown[]) {
    return withSharedMutationLock(ownerDevicesMutationLockFile(ownerId, stateKey), () => {
        const devices = updater(readOwnerDevices(ownerId, stateKey));
        assertUniqueOwnerDeviceIds(devices);
        assertOwnerDeviceStateWritable(devices, DEVICE_BROKER_INVENTORY_FILE_LIMIT);
        writeJsonFileAtomically(ownerDevicesFile(ownerId, stateKey), { devices });
        return devices;
    });
}

function claimOwnerDevice(ownerId: string, stateKey: string, device: Record<string, unknown>, uniqueFields: Array<string | string[]>) {
    return withSharedMutationLock(ownerDevicesMutationLockFile(ownerId, stateKey), () => {
        const devices = readOwnerDevices(ownerId, stateKey);
        for (const selector of uniqueFields) {
            const fields = Array.isArray(selector) ? selector : [selector];
            const values = fields.map((field) => device[field]);
            if (values.some((value) => value === null || value === undefined || value === "")) continue;
            const existing = devices.find((candidate) => candidate && typeof candidate === "object" && fields.every((field, index) => (candidate as Record<string, unknown>)[field] === values[index]));
            if (existing) {
                const field = fields.join("+");
                const value = fields.length === 1 ? values[0] : Object.fromEntries(fields.map((key, index) => [key, values[index]]));
                return {
                    ok: false as const,
                    error: field === "id" ? "owner-device-id-conflict" : "owner-device-identity-conflict",
                    field,
                    value,
                    existing: existing as Record<string, unknown>,
                };
            }
        }
        const next = [...devices, device];
        assertOwnerDeviceStateWritable(next, DEVICE_BROKER_INVENTORY_FILE_LIMIT);
        writeJsonFileAtomically(ownerDevicesFile(ownerId, stateKey), { devices: next });
        return { ok: true as const, device };
    });
}

function escapeXml(value: unknown): string {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function brokerWindowsConfigPath(ownerId: string, deviceId: string): string {
    return join(brokerWindowsDeviceRoot(ownerId, deviceId), `${deviceId}.wsb`);
}

function brokerWindowsDeviceRoot(ownerId: string, deviceId: string): string {
    return join(brokerRoot(), "owners", ownerId, "windows", deviceId);
}

function pathWithin(root: string, candidate: string): boolean {
    const child = relative(resolve(root), resolve(candidate));
    return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function brokerWindowsToolsDir(ownerId: string, deviceId: string): string {
    return join(brokerWindowsDeviceRoot(ownerId, deviceId), "tools");
}

function brokerWindowsHelperPaths(ownerId: string, deviceId: string) {
    const scratch = brokerWindowsDeviceRoot(ownerId, deviceId);
    const tools = brokerWindowsToolsDir(ownerId, deviceId);
    const downloads = join(scratch, "downloads");
    return {
        scratch,
        tools,
        downloads,
        hostHelperScript: join(tools, "ccc-guest-helper.ps1"),
        hostBootstrapScript: join(tools, "ccc-guest-helper-bootstrap.ps1"),
        hostBootstrapLauncherScript: join(tools, "ccc-guest-helper-bootstrap.vbs"),
        readyMarkerPath: join(downloads, "ccc-guest-helper-bootstrap.ready.txt"),
        minimizeWatchdogCancelPath: join(downloads, "ccc-minimize-watchdog.cancel"),
        minimizeWatchdogResultPath: join(downloads, "ccc-minimize-watchdog.result.txt"),
        guestBootstrapScript: "C:\\ccc\\tools\\ccc-guest-helper-bootstrap.ps1",
        guestBootstrapLauncherScript: "C:\\ccc\\tools\\ccc-guest-helper-bootstrap.vbs",
        guestHelperScript: "C:\\ccc\\scratch\\ccc-guest-helper.ps1",
        guestToolsHelperScript: "C:\\ccc\\tools\\ccc-guest-helper.ps1",
        guestDownloadsDir: "C:\\ccc\\scratch\\downloads",
    };
}

type WindowsSandboxDeviceArtifactCleanup = {
    ok: boolean;
    removed: boolean;
    deviceRoot: string;
    error?: string;
};

export function cleanupBrokerWindowsDeviceArtifacts(
    ownerId: string,
    deviceId: string,
    options: {
        removeTree?: typeof rmSync;
        pathExists?: typeof existsSync;
    } = {},
): WindowsSandboxDeviceArtifactCleanup {
    const windowsRoot = join(brokerRoot(), "owners", ownerId, "windows");
    const deviceRoot = brokerWindowsDeviceRoot(ownerId, deviceId);
    const pathExists = options.pathExists || existsSync;
    try {
        assertDeviceLabPathWithinRoot(windowsRoot, deviceRoot, "windows-sandbox-device-artifacts");
        if (!pathExists(deviceRoot)) return { ok: true, removed: false, deviceRoot };
        if (lstatSync(deviceRoot).isSymbolicLink()) {
            return { ok: false, removed: false, deviceRoot, error: "windows-sandbox-device-artifacts-path-invalid" };
        }
        (options.removeTree || rmSync)(deviceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        if (pathExists(deviceRoot)) {
            return { ok: false, removed: false, deviceRoot, error: "windows-sandbox-device-artifacts-remained" };
        }
        return { ok: true, removed: true, deviceRoot };
    } catch (error) {
        return {
            ok: false,
            removed: false,
            deviceRoot,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function brokerWindowsHelperAssetPath(normalized: NormalizedBrokerOptions): string {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const localPackageRoot = basename(moduleDir) === "src" || basename(moduleDir) === "dist"
        ? dirname(moduleDir)
        : moduleDir;
    const candidates = [packageRootForBroker(normalized), localPackageRoot]
        .map((root) => join(root, "device-lab-mcp", "src", "backends", "windows-helper.ps1"));
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    throw new Error(`windows-helper-asset-missing: ${candidates.join(", ")}`);
}

function brokerWindowsBootstrapScript(helper: ReturnType<typeof brokerWindowsHelperPaths>): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$ToolsHelper = '${helper.guestToolsHelperScript}'`,
        `$ScratchHelper = '${helper.guestHelperScript}'`,
        `$Downloads = '${helper.guestDownloadsDir}'`,
        "$BootstrapStdoutPath = Join-Path $Downloads 'ccc-guest-helper-bootstrap.stdout.txt'",
        "$BootstrapStderrPath = Join-Path $Downloads 'ccc-guest-helper-bootstrap.stderr.txt'",
        "$StdoutPath = Join-Path $Downloads 'ccc-guest-helper.stdout.txt'",
        "$StderrPath = Join-Path $Downloads 'ccc-guest-helper.stderr.txt'",
        "try {",
        "  New-Item -ItemType Directory -Force -Path $Downloads,(Split-Path $ScratchHelper) | Out-Null",
        "  Set-Content -Path $BootstrapStdoutPath -Value ('bootstrap-start ' + (Get-Date).ToString('o')) -Encoding UTF8",
        "  while (-not (Test-Path -LiteralPath $ToolsHelper)) {",
        "    Add-Content -Path $BootstrapStdoutPath -Value ('waiting-helper ' + (Get-Date).ToString('o'))",
        "    Start-Sleep -Milliseconds 500",
        "  }",
        "  Copy-Item -Force -LiteralPath $ToolsHelper -Destination $ScratchHelper",
        "  $Process = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ScratchHelper) -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -WindowStyle Hidden -PassThru",
        "  Add-Content -Path $BootstrapStdoutPath -Value ('helper-pid ' + $Process.Id)",
        "  Set-Content -Path (Join-Path $Downloads 'ccc-guest-helper-bootstrap.ready.txt') -Value (Get-Date).ToString('o') -Encoding UTF8",
        "} catch {",
        "  Set-Content -Path $BootstrapStderrPath -Value $_.Exception.ToString() -Encoding UTF8",
        "  throw",
        "}",
        "",
    ].join("\n");
}

function brokerWindowsBootstrapLauncherScript(helper: ReturnType<typeof brokerWindowsHelperPaths>): string {
    const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helper.guestBootstrapScript}"`;
    return [
        "Set Shell = CreateObject(\"WScript.Shell\")",
        `Shell.Run "${command.replace(/"/g, "\"\"")}", 0, False`,
        "",
    ].join("\r\n");
}

function writeBrokerWindowsConfig(ownerId: string, deviceId: string, create: Record<string, unknown>, normalized: NormalizedBrokerOptions): string {
    const configPath = brokerWindowsConfigPath(ownerId, deviceId);
    const helper = brokerWindowsHelperPaths(ownerId, deviceId);
    const windowsRoot = join(brokerRoot(), "owners", ownerId, "windows");
    for (const path of [helper.scratch, helper.tools, join(helper.scratch, "inbox"), join(helper.scratch, "outbox"), join(helper.scratch, "uploads"), helper.downloads]) {
        mkdirSync(path, { recursive: true });
    }
    for (const file of [helper.hostHelperScript, helper.hostBootstrapScript, helper.hostBootstrapLauncherScript, configPath]) {
        assertDeviceLabPathWithinRoot(windowsRoot, file, "windows-sandbox-workspace");
    }
    const helperAsset = readDeviceLabTextFile(
        brokerWindowsHelperAssetPath(normalized),
        "windows-sandbox-helper-asset",
        DEVICE_BROKER_WINDOWS_CONFIG_LIMIT_BYTES,
    );
    if (!helperAsset) throw new Error("windows-helper-asset-empty");
    writeFileAtomically(helper.hostHelperScript, helperAsset);
    writeFileAtomically(helper.hostBootstrapScript, brokerWindowsBootstrapScript(helper));
    writeFileAtomically(helper.hostBootstrapLauncherScript, brokerWindowsBootstrapLauncherScript(helper));
    const networking = create.networking === true ? "Enable" : "Disable";
    const clipboard = create.clipboard === true ? "Enable" : "Disable";
    const vgpu = create.vgpu === true ? "Enable" : "Disable";
    const memoryMb = typeof create.memoryMb === "number" && Number.isFinite(create.memoryMb) ? create.memoryMb : 4096;
    const mappedFolders = [
        [join(helper.scratch, "inbox"), "C:\\ccc\\scratch\\inbox", false],
        [join(helper.scratch, "outbox"), "C:\\ccc\\scratch\\outbox", false],
        [join(helper.scratch, "uploads"), "C:\\ccc\\scratch\\uploads", false],
        [helper.downloads, "C:\\ccc\\scratch\\downloads", false],
        [helper.tools, "C:\\ccc\\tools", true],
    ] as const;
    const config = [
        "<Configuration>",
        `  <VGpu>${escapeXml(vgpu)}</VGpu>`,
        `  <Networking>${escapeXml(networking)}</Networking>`,
        `  <ClipboardRedirection>${escapeXml(clipboard)}</ClipboardRedirection>`,
        `  <MemoryInMB>${escapeXml(memoryMb)}</MemoryInMB>`,
        "  <MappedFolders>",
        ...mappedFolders.flatMap(([hostFolder, sandboxFolder, readOnly]) => [
            "    <MappedFolder>",
            `      <HostFolder>${escapeXml(hostFolder)}</HostFolder>`,
            `      <SandboxFolder>${escapeXml(sandboxFolder)}</SandboxFolder>`,
            `      <ReadOnly>${readOnly ? "true" : "false"}</ReadOnly>`,
            "    </MappedFolder>",
        ]),
        "  </MappedFolders>",
        "  <LogonCommand>",
        `    <Command>wscript.exe //B ${escapeXml(helper.guestBootstrapLauncherScript)}</Command>`,
        "  </LogonCommand>",
        "</Configuration>",
        "",
    ].join("\n");
    writeFileAtomically(configPath, config);
    return configPath;
}

function createOwnerDeviceRecord(ownerId: string, parsed: CommandParamSuccess): unknown {
    const create = parsed.create || {};
    const now = new Date().toISOString();
    const name = String(create.name || parsed.deviceId);
    if (parsed.backend === "android-emulator") {
        return {
            id: parsed.deviceId,
            name,
            backend: parsed.backend,
            kind: "mobile",
            platform: "android",
            ownerId,
            avdName: brokerAndroidAvdName(ownerId, create, name),
            avdRoot: androidAvdHome(),
            ...(typeof create.port === "number" ? { port: create.port } : {}),
            ...(typeof create.systemImage === "string" ? { systemImage: create.systemImage } : {}),
            ...(typeof create.deviceProfile === "string" ? { deviceProfile: create.deviceProfile } : {}),
            headless: create.headless !== false,
            createAvd: create.createAvd === true,
            provisioned: create.createAvd === true,
            recording: null,
            status: "stopped",
            creatable: true,
            createdAt: now,
            updatedAt: now,
            authority: "host-broker",
        };
    }
    if (parsed.backend === "ios-simulator") {
        return {
            id: parsed.deviceId,
            name,
            backend: parsed.backend,
            kind: "mobile",
            platform: "ios",
            ownerId,
            simulatorName: create.simulatorName || `ccc-${ownerId}-${brokerSlug(name)}`,
            ...(typeof create.deviceType === "string" ? { deviceType: create.deviceType } : {}),
            ...(typeof create.runtime === "string" ? { runtime: create.runtime } : {}),
            ...(typeof create.udid === "string" ? { udid: create.udid } : {}),
            createSimulator: create.createSimulator === true,
            recording: null,
            status: "stopped",
            creatable: true,
            createdAt: now,
            updatedAt: now,
            authority: "host-broker",
        };
    }
    if (parsed.backend === "windows-sandbox") {
        const configPath = brokerWindowsConfigPath(ownerId, parsed.deviceId);
        return {
            id: parsed.deviceId,
            name,
            backend: parsed.backend,
            kind: "desktop",
            platform: "windows",
            ownerId,
            networking: create.networking === true,
            clipboard: create.clipboard === true,
            vgpu: create.vgpu === true,
            memoryMb: typeof create.memoryMb === "number" ? create.memoryMb : 4096,
            minimized: create.minimized !== false,
            configPath,
            recording: null,
            status: "stopped",
            creatable: true,
            createdAt: now,
            updatedAt: now,
            authority: "host-broker",
        };
    }
    if (isHyperVBackend(parsed.backend)) {
        const linuxGuest = parsed.backend === "linux-vm";
        const incarnationId = String(create.incarnationId || "");
        const vmName = hyperVVmName(ownerId, parsed.deviceId, incarnationId);
        const deviceRoot = hyperVDeviceRoot(ownerId, parsed.backend, parsed.deviceId);
        const privateRoot = hyperVPrivateDeviceRoot(ownerId, parsed.backend, parsed.deviceId);
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        const profile = typeof create.profile === "string" ? create.profile : linuxGuest ? "ubuntu-lts" : "windows-11";
        const secureBoot = hyperVSecureBootConfiguration(parsed.backend);
        return {
            id: parsed.deviceId,
            name,
            backend: parsed.backend,
            kind: linuxGuest ? "vm" : "desktop",
            platform: linuxGuest ? "linux" : "windows",
            ownerId,
            provider: "hyper-v",
            ...(validHyperVIncarnationId(create.incarnationId) ? { incarnationId: create.incarnationId } : {}),
            vmName,
            ...(typeof create.vmId === "string" ? { vmId: create.vmId.toLowerCase() } : {}),
            profile,
            baseImagePath: typeof create.image === "string" ? create.image : create.sourceImage,
            baseImageSha256: typeof create.baseImageSha256 === "string" ? create.baseImageSha256 : undefined,
            ...((create.baseImageGeneration === 1 || create.baseImageGeneration === 2) ? { baseImageGeneration: create.baseImageGeneration } : {}),
            ...(typeof create.sourceImage === "string" ? { sourceImage: create.sourceImage } : {}),
            deviceRoot,
            privateRoot,
            diskPath,
            guestTransport: linuxGuest ? "ssh" : "powershell-direct",
            ...(linuxGuest ? {
                seedDiskPath: join(deviceRoot, "disks", "cidata.iso"),
                sshPrivateKeyPath: join(privateRoot, "secrets", "id_ed25519"),
                sshPublicKeyPath: join(privateRoot, "secrets", "id_ed25519.pub"),
                sshHostPrivateKeyPath: join(privateRoot, "secrets", "ssh_host_ed25519_key"),
                sshHostPublicKeyPath: join(privateRoot, "secrets", "ssh_host_ed25519_key.pub"),
                sshKnownHostsPath: join(privateRoot, "secrets", "known_hosts"),
                ...(typeof create.sshHostKeyFingerprint === "string" ? { sshHostKeyFingerprint: create.sshHostKeyFingerprint } : {}),
            } : { guestCredentialPath: join(privateRoot, "secrets", "guest.credential.xml") }),
            ...(typeof create.guestUsername === "string" ? { guestUsername: create.guestUsername } : {}),
            ...(create.guestProvisioned === true ? { guestProvisioned: true } : {}),
            ...(typeof create.guestUnattendPath === "string" ? { guestUnattendPath: create.guestUnattendPath } : {}),
            memoryMb: typeof create.memoryMb === "number" ? create.memoryMb : 4096,
            cpus: typeof create.cpus === "number" ? create.cpus : 2,
            diskMaxBytes: typeof create.diskMaxBytes === "number" ? create.diskMaxBytes : 0,
            networking: create.networking !== false,
            ...(typeof create.switchName === "string" ? { switchName: create.switchName } : {}),
            ...(typeof create.networkAddress === "string" ? { networkAddress: create.networkAddress } : {}),
            ...(typeof create.macAddress === "string" ? { macAddress: create.macAddress } : {}),
            ...(typeof create.networkGateway === "string" ? { networkGateway: create.networkGateway } : {}),
            ...(typeof create.networkPrefix === "string" ? { networkPrefix: create.networkPrefix } : {}),
            ...(create.outboundPolicy === "nat" ? { outboundPolicy: "nat" } : {}),
            ...secureBoot,
            snapshots: [],
            status: "stopped",
            runtimeState: "Off",
            creatable: true,
            createdAt: now,
            updatedAt: now,
            authority: "host-broker",
        };
    }
    if (parsed.backend === "macos-vm") {
        const ssh = macosBrokerSshConfig(create);
        return {
            id: parsed.deviceId,
            name,
            backend: parsed.backend,
            kind: "desktop",
            platform: "macos",
            ownerId,
            provider: create.provider === "auto" || !create.provider ? "tart" : create.provider,
            providerInstance: typeof create.providerInstance === "string" && create.providerInstance
                ? create.providerInstance
                : `ccc-${ownerId}-${brokerSlug(parsed.deviceId)}`,
            ...(typeof create.image === "string" ? { image: create.image } : {}),
            ...(typeof create.cpus === "number" ? { cpus: create.cpus } : {}),
            ...(ssh ? { ssh } : {}),
            recording: null,
            status: "stopped",
            creatable: true,
            createdAt: now,
            updatedAt: now,
            authority: "host-broker",
        };
    }
    return {
        id: parsed.deviceId,
        name,
        backend: parsed.backend,
        ownerId,
        status: "stopped",
        createdAt: now,
        updatedAt: now,
        authority: "host-broker",
    };
}

function createOwnerDeviceUniqueFields(parsed: CommandParamSuccess): Array<string | string[]> {
    if (parsed.backend === "android-emulator") return ["id", "avdName", "port"];
    if (parsed.backend === "ios-simulator") return ["id", "udid", "simulatorName"];
    if (parsed.backend === "macos-vm") return ["id", ["provider", "providerInstance"]];
    if (isHyperVBackend(parsed.backend)) return ["id", "vmId", "vmName", "diskPath"];
    return ["id"];
}

async function rollbackProviderCreateAfterConflict(
    parsed: CommandParamSuccess,
    device: Record<string, unknown>,
    existing: Record<string, unknown> | null,
    providerCommand: ProviderCommand | null | undefined,
    normalized: NormalizedBrokerOptions,
    hyperVDeadlineAt = Number.POSITIVE_INFINITY,
) {
    if (!providerCommand || providerCommand.mode === "noop") {
        return { attempted: false, ok: true, reason: "no-provider-resource-created" };
    }
    if (parsed.backend === "android-emulator") {
        if (existing?.avdName === device.avdName) return { attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device" };
        const rollbackOwnerId = field(device, "ownerId");
        if (!rollbackOwnerId) return { attempted: false, ok: false, reason: "created-avd-owner-id-missing" };
        const avdName = field(device, "avdName");
        if (!avdName || !ownedAndroidAvdName(avdName, rollbackOwnerId)) {
            return { attempted: false, ok: false, reason: "created-avd-identity-unverified" };
        }
        const live = liveAndroidAvdNames(normalized);
        if (!live.ok || live.names.has(avdName)) {
            return {
                attempted: false,
                ok: false,
                reason: live.ok && live.names.has(avdName)
                    ? "created-avd-active"
                    : "created-avd-liveness-unverified",
            };
        }
        const processState = androidAvdProcessState(avdName, normalized);
        if (!processState.ok || processState.active) {
            return {
                attempted: false,
                ok: false,
                reason: processState.ok && processState.active
                    ? "created-avd-active"
                    : "created-avd-liveness-unverified",
            };
        }
        const avdRoot = approvedAndroidAvdRoot(field(device, "avdRoot"), normalized.platform);
        if (!avdRoot) return { attempted: false, ok: false, reason: "created-avd-root-unavailable" };
        try {
            const cleanup = removeOwnedAndroidAvdArtifacts(avdName, rollbackOwnerId, {
                root: avdRoot,
                verifyInactive: () => androidAvdIsInactiveForBroker(avdName, normalized),
            });
            return { attempted: true, ok: true, artifactsRemoved: cleanup.removed };
        } catch {
            return {
                attempted: true,
                ok: false,
                reason: "android-avd-artifact-cleanup-failed",
            };
        }
    }
    if (parsed.backend === "ios-simulator") {
        if (existing?.udid === device.udid) return { attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device" };
        const udid = typeof device.udid === "string" ? device.udid : "";
        if (!udid) return { attempted: false, ok: false, reason: "created-simulator-udid-missing" };
        const executable = typeof providerCommand.executable === "string" ? providerCommand.executable : "";
        if (!executable) return { attempted: false, ok: false, reason: "created-simulator-provider-command-missing" };
        const result = normalized.commandRunner(iosSimulatorDeleteCommand(executable, udid), { timeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
        return { attempted: true, ok: commandSucceeded(result), result };
    }
    if (isHyperVBackend(parsed.backend)) {
        if (existing?.vmId === device.vmId || existing?.vmName === device.vmName || existing?.diskPath === device.diskPath) {
            return { attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device" };
        }
        const powershell = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
        const incarnationId = device && typeof device === "object" && !Array.isArray(device)
            ? hyperVDeviceIncarnationId(device as Record<string, unknown>)
            : null;
        if (!powershell || !incarnationId || typeof device.vmName !== "string" || typeof device.diskPath !== "string" || typeof device.deviceRoot !== "string") {
            return { attempted: false, ok: false, reason: "created-hyper-v-vm-identity-missing" };
        }
        try {
            const rollbackCommand = hyperVRecoverOrphanCommand({
                executable: powershell,
                ownerId: String(device.ownerId),
                deviceId: String(device.id),
                incarnationId,
                vmName: device.vmName,
                deviceRoot: device.deviceRoot,
                diskPath: device.diskPath,
                auxiliaryMediaPaths: [
                    join(device.deviceRoot, "disks", parsed.backend === "linux-vm" ? "cidata.iso" : "autounattend.iso"),
                ],
            });
            const result = await hyperVProviderCommandRunner(normalized, rollbackCommand, { timeoutMs: hyperVRemainingTimeout(hyperVDeadlineAt, 120000), outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
            const publicResult = redactProviderCommandInput(
                result,
                true,
                "hyper-v-rollback-command-failed",
            );
            if (!commandSucceeded(result)) {
                return { attempted: true, ok: false, result: publicResult };
            }
            const observation = parseHyperVRecoveryObservation(result.stdout || "");
            if (!observation) {
                return {
                    attempted: true,
                    ok: false,
                    reason: "hyper-v-rollback-invalid-result",
                    result: publicResult,
                };
            }
            const allocation = await releaseHyperVNetworkAllocationAndCleanup(String(device.ownerId), String(device.id), incarnationId, normalized, hyperVDeadlineAt);
            const artifacts = allocation.ok
                ? cleanupHyperVDeviceArtifacts(String(device.ownerId), parsed.backend, String(device.id))
                : { ok: false, removed: false, reason: "network-allocation-cleanup-failed" };
            if (!artifacts.ok || !allocation.ok) {
                return {
                    attempted: true,
                    ok: false,
                    result: publicResult,
                    artifacts: {
                        ok: artifacts.ok,
                        removed: artifacts.removed,
                        ...(!artifacts.ok ? { error: "hyper-v-artifact-cleanup-failed" } : {}),
                    },
                    allocation: {
                        ok: allocation.ok,
                        released: allocation.released,
                        ...(!allocation.ok ? {
                            error: typeof allocation.error === "string"
                                && /^hyper-v-[a-z0-9-]{3,128}$/.test(allocation.error)
                                ? allocation.error
                                : "hyper-v-network-cleanup-failed",
                        } : {}),
                    },
                };
            }
            return {
                attempted: true,
                ok: true,
                result: publicResult,
                observation: {
                    recoveredVm: observation.recoveredVm,
                    removedDisk: observation.removedDisk,
                },
                artifacts: { ok: true, removed: artifacts.removed },
                allocation: {
                    ok: true,
                    released: allocation.released,
                },
            };
        } catch (error) {
            return {
                attempted: false,
                ok: false,
                reason: "hyper-v-rollback-plan-failed",
            };
        }
    }
    if (parsed.backend === "macos-vm") {
        if (existing?.provider === device.provider && existing?.providerInstance === device.providerInstance) {
            return { attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device" };
        }
        const result = normalized.commandRunner({
            mode: "exec",
            provider: providerCommand.provider,
            executable: providerCommand.executable,
            args: ["delete", String(device.providerInstance)],
        }, { timeoutMs: normalized.commandTimeoutMs, outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
        return { attempted: true, ok: commandSucceeded(result), result };
    }
    return { attempted: false, ok: true, reason: "create-does-not-provision-a-provider-resource" };
}

function validAndroidEmulatorPort(port: unknown): port is number {
    return Number.isInteger(port)
        && Number(port) >= ANDROID_EMULATOR_PORT_MIN
        && Number(port) <= ANDROID_EMULATOR_PORT_MAX
        && Number(port) % 2 === 0;
}

function androidEmulatorPortAllocationLockFile() {
    return join(brokerRoot(), "broker", "locks", "android-emulator-ports.mutation.lock");
}

function allocatedAndroidEmulatorPorts(): Set<number> {
    const ports = new Set<number>();
    const ownersRoot = join(brokerRoot(), "owners");
    for (const ownerId of enumerateDeviceProjectIds(ownersRoot, (name) => /^[a-f0-9]{16}$/.test(name))) {
        const devices = readOwnerDevices(ownerId, "android");
        for (const device of devices) {
            const port = numberField(device, "port");
            if (validAndroidEmulatorPort(port)) ports.add(port);
        }
    }
    return ports;
}

type AndroidEmulatorPortAllocation =
    | { ok: true; port: number }
    | { ok: false; status: number; error: string; allowed?: string; detail?: string };

function resolveAndroidEmulatorCreatePort(ownerId: string, parsed: CommandParamSuccess, additionalUsedPorts: Iterable<number> = []): AndroidEmulatorPortAllocation {
    const requested = parsed.create?.port;
    if (requested !== undefined && !validAndroidEmulatorPort(requested)) {
        return {
            ok: false,
            status: 400,
            error: "invalid-android-emulator-port",
            allowed: `even integer ${ANDROID_EMULATOR_PORT_MIN}-${ANDROID_EMULATOR_PORT_MAX}`,
        };
    }
    let used: Set<number>;
    try {
        used = allocatedAndroidEmulatorPorts();
    } catch (error) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-port-inventory-unavailable",
            detail: ownerDeviceStateErrorCode(error) || deviceLabProjectEnumerationErrorCode(error) || "android-emulator-port-inventory-read-failed",
        };
    }
    for (const port of additionalUsedPorts) {
        if (validAndroidEmulatorPort(port)) used.add(port);
    }
    if (requested !== undefined) {
        return used.has(requested)
            ? { ok: false, status: 409, error: "android-emulator-port-conflict", detail: `port-${requested}-already-allocated` }
            : { ok: true, port: requested };
    }
    const slotCount = ((ANDROID_EMULATOR_PORT_MAX - ANDROID_EMULATOR_PORT_MIN) / 2) + 1;
    const initialSlot = Number.parseInt(createHash("sha256").update(`${ownerId}\0${parsed.deviceId}`).digest("hex").slice(0, 8), 16) % slotCount;
    for (let offset = 0; offset < slotCount; offset += 1) {
        const port = ANDROID_EMULATOR_PORT_MIN + (((initialSlot + offset) % slotCount) * 2);
        if (!used.has(port)) return { ok: true as const, port };
    }
    return { ok: false as const, status: 409, error: "android-emulator-port-pool-exhausted" };
}

function androidEmulatorPortsFromAdbDevices(output: unknown): Set<number> {
    const ports = new Set<number>();
    for (const line of String(output || "").split(/\r?\n/)) {
        const match = line.trim().match(/^emulator-(\d+)\s+/);
        if (!match) continue;
        const port = Number(match[1]);
        if (validAndroidEmulatorPort(port)) ports.add(port);
    }
    return ports;
}

function liveAndroidEmulatorPortsForAllocation(normalized: NormalizedBrokerOptions):
    | { ok: true; ports: Set<number> }
    | { ok: false; status: number; error: string; detail: string } {
    const adb = providerExecutable("adb", normalized);
    if (!adb) return { ok: true, ports: new Set() };
    const result = normalized.commandRunner({ mode: "exec", provider: "adb", executable: adb, args: ["devices", "-l"] }, {
        timeoutMs: 10000,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(result)) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-live-port-inventory-unavailable",
            detail: result.stderr || result.stdout || result.error || `adb-exit-${result.status ?? "unknown"}`,
        };
    }
    return { ok: true, ports: androidEmulatorPortsFromAdbDevices(result.stdout) };
}

function liveAndroidAvdNames(normalized: NormalizedBrokerOptions):
    | { ok: true; names: Set<string> }
    | { ok: false; status: number; error: string; detail: string } {
    const adb = providerExecutable("adb", normalized);
    if (!adb) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-runtime-inventory-unavailable",
            detail: "missing-adb",
        };
    }
    const inventory = normalized.commandRunner({
        mode: "exec",
        provider: "adb",
        executable: adb,
        args: ["devices", "-l"],
    }, {
        timeoutMs: 10000,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(inventory)) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-runtime-inventory-unavailable",
            detail: inventory.stderr || inventory.stdout || inventory.error || `adb-exit-${inventory.status ?? "unknown"}`,
        };
    }
    const emulatorLines = String(inventory.stdout || "").split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^emulator-\d+\s+/.test(line));
    const unavailable = emulatorLines.filter((line) => !/^emulator-\d+\s+device\b/.test(line));
    if (unavailable.length > 0) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-runtime-target-unavailable",
            detail: unavailable.join(", "),
        };
    }
    const names = new Set<string>();
    for (const line of emulatorLines) {
        const serial = /^(emulator-\d+)/.exec(line)?.[1];
        if (!serial) {
            return {
                ok: false,
                status: 503,
                error: "android-emulator-runtime-identity-unavailable",
                detail: "invalid-emulator-serial",
            };
        }
        const result = normalized.commandRunner({
            mode: "exec",
            provider: "adb",
            executable: adb,
            args: ["-s", serial, "emu", "avd", "name"],
        }, {
            timeoutMs: 10000,
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
        if (!commandSucceeded(result)) {
            return {
                ok: false,
                status: 503,
                error: "android-emulator-runtime-identity-unavailable",
                detail: result.stderr || result.stdout || result.error || `adb-exit-${result.status ?? "unknown"}`,
            };
        }
        const name = String(result.stdout || "").split(/\r?\n/)
            .map((value) => value.trim())
            .find((value) => value && value !== "OK");
        if (!name) {
            return {
                ok: false,
                status: 503,
                error: "android-emulator-runtime-identity-unavailable",
                detail: `missing-avd-name-for-${serial}`,
            };
        }
        names.add(name);
    }
    return { ok: true, names };
}

function approvedAndroidAvdRoot(recordedRoot: unknown, platform: NodeJS.Platform): string | null {
    if (typeof recordedRoot !== "string" || !recordedRoot) return null;
    const approved = resolve(androidAvdHome());
    const recorded = resolve(recordedRoot);
    const normalize = (value: string) => platform === "win32" ? value.toLowerCase() : value;
    return normalize(approved) === normalize(recorded) ? approved : null;
}

function androidAvdProcessState(avdName: string, normalized: NormalizedBrokerOptions):
    | { ok: true; active: boolean }
    | { ok: false; status: number; error: string; detail: string } {
    if (!ownedAndroidAvdName(avdName, avdName.slice(4, 20))) {
        return { ok: false, status: 409, error: "android-avd-identity-unavailable", detail: "invalid-avd-name" };
    }
    const command: ProviderCommand = normalized.platform === "win32"
        ? {
            mode: "exec",
            provider: "process-inventory",
            executable: "powershell.exe",
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(emulator|qemu-system-.*)\\.exe$' } | ForEach-Object { [string]$_.CommandLine }",
            ],
        }
        : {
            mode: "exec",
            provider: "process-inventory",
            executable: "/bin/ps",
            args: ["-eo", "args="],
        };
    const result = normalized.commandRunner(command, {
        timeoutMs: 10000,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(result)) {
        return {
            ok: false,
            status: 503,
            error: "android-emulator-process-inventory-unavailable",
            detail: result.stderr || result.stdout || result.error || `process-inventory-exit-${result.status ?? "unknown"}`,
        };
    }
    const escaped = avdName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(`(?:^|\\s)(?:-avd(?:\\s+|=)["']?${escaped}(?=["'\\s]|$)|@${escaped}(?=\\s|$))`);
    return {
        ok: true,
        active: String(result.stdout || "").split(/\r?\n/).some((line) => matcher.test(line)),
    };
}

function androidAvdIsInactiveForBroker(avdName: string, normalized: NormalizedBrokerOptions): boolean {
    const live = liveAndroidAvdNames(normalized);
    if (!live.ok || live.names.has(avdName)) return false;
    const processState = androidAvdProcessState(avdName, normalized);
    return processState.ok && !processState.active;
}

function resolveAndroidEmulatorCreatePortForInvoke(
    ownerId: string,
    parsed: CommandParamSuccess,
    normalized: NormalizedBrokerOptions,
): AndroidEmulatorPortAllocation {
    const stateAllocation = resolveAndroidEmulatorCreatePort(ownerId, parsed);
    if (!stateAllocation.ok) return stateAllocation;
    const live = liveAndroidEmulatorPortsForAllocation(normalized);
    if (!live.ok) return live;
    return live.ports.has(stateAllocation.port)
        ? resolveAndroidEmulatorCreatePort(ownerId, parsed, live.ports)
        : stateAllocation;
}

function usesDefaultBrokerTartMacosCredentials(create: Record<string, unknown>) {
    const provider = create.provider === "auto" || !create.provider ? "tart" : String(create.provider);
    if (provider !== "tart") return false;
    const image = typeof create.image === "string" ? create.image : "";
    return image === "ccc-macos-base" ||
        /^ghcr\.io\/cirruslabs\/macos-[^:]+(?:[:@].*)?$/.test(image) ||
        /^macos-[^-]+-base$/.test(image);
}

function macosBrokerSshConfig(create: Record<string, unknown>) {
    const hasExplicitSsh = Boolean(create.sshHost || create.sshUser || create.sshKeyPath || create.sshPassword);
    const useDefaultPassword = !hasExplicitSsh && usesDefaultBrokerTartMacosCredentials(create);
    if (!hasExplicitSsh && !useDefaultPassword) return null;
    return {
        host: typeof create.sshHost === "string" ? create.sshHost : null,
        port: typeof create.sshPort === "number" ? create.sshPort : 22,
        user: typeof create.sshUser === "string" ? create.sshUser : (useDefaultPassword ? "admin" : null),
        keyPath: typeof create.sshKeyPath === "string" ? create.sshKeyPath : null,
        password: typeof create.sshPassword === "string" ? create.sshPassword : (useDefaultPassword ? "admin" : null),
    };
}

function physicalLeaseLocksDir(backend: string) {
    return join(brokerRoot(), "physical-leases", backend, "locks");
}

function physicalLeaseLockFile(backend: string, hardwareId: string) {
    return join(physicalLeaseLocksDir(backend), `${encodeURIComponent(hardwareId)}.json`);
}

function physicalLeaseMutationLockFile(backend: string, hardwareId: string) {
    return join(physicalLeaseLocksDir(backend), `${encodeURIComponent(hardwareId)}.mutation.lock`);
}

function normalizedLeaseTtlMs(value: unknown) {
    if (value === undefined || value === null) return DEVICE_BROKER_PHYSICAL_LEASE_TTL_MS;
    if (typeof value !== "number" || !Number.isInteger(value) || value < DEVICE_BROKER_PHYSICAL_LEASE_MIN_TTL_MS || value > DEVICE_BROKER_PHYSICAL_LEASE_MAX_TTL_MS) {
        return null;
    }
    return value;
}

function validateLeaseParams(params: unknown, action: "claim" | "list" | "release" | "heartbeat" | "prune"): LeaseParamError | LeaseParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-lease-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    if (!DEVICE_BROKER_PHYSICAL_BACKENDS.has(backend)) {
        return { ok: false, status: 400, error: "invalid-lease-backend", allowed: [...DEVICE_BROKER_PHYSICAL_BACKENDS] };
    }
    if (input.all === true) {
        return { ok: false, status: 403, error: "all-owner-lease-list-requires-admin" };
    }
    const hardwareId = typeof input.hardwareId === "string" ? input.hardwareId.trim() : "";
    if (action !== "list" && action !== "prune" && (!hardwareId || hardwareId.length > 256 || /[\u0000-\u001f]/.test(hardwareId))) {
        return { ok: false, status: 400, error: "invalid-hardware-id" };
    }
    const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : null;
    if (deviceId !== null && (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId))) {
        return { ok: false, status: 400, error: "invalid-device-id" };
    }
    const connection = typeof input.connection === "string" ? input.connection : "unknown";
    if (!["usb", "wifi", "unknown"].includes(connection)) {
        return { ok: false, status: 400, error: "invalid-connection" };
    }
    const transport = input.transport && typeof input.transport === "object" && !Array.isArray(input.transport)
        ? input.transport
        : {};
    const ttlMs = normalizedLeaseTtlMs(input.ttlMs);
    if (ttlMs === null) {
        return { ok: false, status: 400, error: "invalid-lease-ttl-ms" };
    }
    const claimId = typeof input.claimId === "string" ? input.claimId.trim() : null;
    const claimNonce = typeof input.claimNonce === "string" ? input.claimNonce.trim() : null;
    if (claimId !== null && (!claimId || claimId.length > 128 || /[^a-zA-Z0-9._:-]/.test(claimId))) {
        return { ok: false, status: 400, error: "invalid-lease-claim-id" };
    }
    if (claimNonce !== null && (!claimNonce || claimNonce.length > 128 || /[^a-zA-Z0-9._:-]/.test(claimNonce))) {
        return { ok: false, status: 400, error: "invalid-lease-claim-nonce" };
    }
    return { ok: true, backend, hardwareId, deviceId, connection, transport, ttlMs, claimId, claimNonce };
}

function leaseParamError(parsed: LeaseParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}

function readLeaseFile(file: string, backend?: string, hardwareId?: string) {
    return readPhysicalLeaseStateFile(file, backend, hardwareId);
}

function leaseExpiryFrom(updatedAt: string, ttlMs: number) {
    return new Date(new Date(updatedAt).getTime() + ttlMs).toISOString();
}

function leaseTtlMs(lease: Record<string, unknown> | null | undefined) {
    return typeof lease?.ttlMs === "number" && Number.isInteger(lease.ttlMs) && lease.ttlMs > 0
        ? lease.ttlMs
        : DEVICE_BROKER_PHYSICAL_LEASE_TTL_MS;
}

function leaseExpiresAt(lease: Record<string, unknown>) {
    if (typeof lease.expiresAt === "string" && !Number.isNaN(Date.parse(lease.expiresAt))) return lease.expiresAt;
    const updatedAt = typeof lease.updatedAt === "string" && !Number.isNaN(Date.parse(lease.updatedAt)) ? lease.updatedAt : new Date(0).toISOString();
    return leaseExpiryFrom(updatedAt, leaseTtlMs(lease));
}

function leaseExpired(lease: Record<string, unknown>, nowMs = Date.now()) {
    return Date.parse(leaseExpiresAt(lease)) <= nowMs;
}

function physicalDeviceLeaseMatches(ownerId: string, stateKey: string, deviceId: string, device: unknown) {
    if (!DEVICE_BROKER_PHYSICAL_BACKENDS.has(stateKey) || !device || typeof device !== "object") return false;
    const record = device as Record<string, unknown>;
    const hardwareId = stateKey === "android-device" ? field(record, "serial") : field(record, "udid");
    const lease = hardwareId ? readLeaseFile(physicalLeaseLockFile(stateKey, hardwareId), stateKey, hardwareId) : null;
    return Boolean(lease
        && !leaseExpired(lease)
        && lease.ownerId === ownerId
        && lease.deviceId === deviceId
        && typeof record.leaseClaimId === "string"
        && record.leaseClaimId.length > 0
        && lease.claimId === record.leaseClaimId
        && typeof record.leaseClaimNonce === "string"
        && record.leaseClaimNonce.length > 0
        && lease.claimNonce === record.leaseClaimNonce);
}

function refreshPhysicalDeviceLeaseForOperation(ownerId: string, match: DeviceToolMatch, deviceId: string): BrokerRpcResult | null {
    if (!DEVICE_BROKER_PHYSICAL_BACKENDS.has(match.stateKey)) return null;
    const hardwareId = match.stateKey === "android-device" ? field(match.device, "serial") : field(match.device, "udid");
    const claimId = field(match.device, "leaseClaimId");
    const claimNonce = field(match.device, "leaseClaimNonce");
    const heartbeat = hardwareId && claimId && claimNonce
        ? heartbeatPhysicalBrokerLease(ownerId, {
            backend: match.stateKey,
            hardwareId,
            deviceId,
            claimId,
            claimNonce,
        })
        : null;
    if (heartbeat?.status === 200) return null;
    const leaseError = heartbeat?.payload && typeof heartbeat.payload === "object" && !Array.isArray(heartbeat.payload)
        ? field(heartbeat.payload as Record<string, unknown>, "error")
        : null;
    return {
        status: 409,
        payload: {
            ok: false,
            error: "physical-device-not-attached",
            ownerId,
            backend: match.backend,
            deviceId,
            ...(leaseError ? { leaseError } : {}),
            remedy: "attach the physical device before using host-backed device tools",
        },
    };
}

function withLeaseExpiry(lease: Record<string, unknown>, ttlMs = leaseTtlMs(lease), now = new Date().toISOString()) {
    return {
        ...lease,
        ttlMs,
        heartbeatAt: now,
        updatedAt: now,
        expiresAt: leaseExpiryFrom(now, ttlMs),
    };
}

function writeLeaseFile(file: string, lease: Record<string, unknown>) {
    validatePhysicalLease(lease);
    writeJsonFileAtomically(file, lease);
}

const brokerPhysicalLeaseHeartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

function brokerPhysicalLeaseHeartbeatKey(ownerId: string, backend: string, hardwareId: string, deviceId?: string) {
    return `${ownerId}\0${backend}\0${hardwareId}\0${deviceId || ""}`;
}

function brokerPhysicalLeaseHeartbeatIntervalMs(ttlMs: number) {
    return Math.max(10 * 1000, Math.min(DEVICE_BROKER_PHYSICAL_LEASE_HEARTBEAT_INTERVAL_MS, Math.floor(ttlMs / 3)));
}

function stopBrokerPhysicalLeaseHeartbeat(ownerId: string, backend: string, hardwareId: string, deviceId?: string) {
    const key = brokerPhysicalLeaseHeartbeatKey(ownerId, backend, hardwareId, deviceId);
    const timer = brokerPhysicalLeaseHeartbeatTimers.get(key);
    if (!timer) return false;
    clearInterval(timer);
    brokerPhysicalLeaseHeartbeatTimers.delete(key);
    return true;
}

function startBrokerPhysicalLeaseHeartbeat(ownerId: string, backend: string, hardwareId: string, deviceId: string, options: { ttlMs?: number; claimId?: string; claimNonce?: string } = {}) {
    const ttlMs = options.ttlMs || DEVICE_BROKER_PHYSICAL_LEASE_TTL_MS;
    stopBrokerPhysicalLeaseHeartbeat(ownerId, backend, hardwareId, deviceId);
    const intervalMs = brokerPhysicalLeaseHeartbeatIntervalMs(ttlMs);
    const timer = setInterval(() => {
        const result = heartbeatPhysicalBrokerLease(ownerId, { backend, hardwareId, deviceId, ttlMs, claimId: options.claimId, claimNonce: options.claimNonce });
        if (result.status !== 200) stopBrokerPhysicalLeaseHeartbeat(ownerId, backend, hardwareId, deviceId);
    }, intervalMs);
    timer.unref?.();
    brokerPhysicalLeaseHeartbeatTimers.set(brokerPhysicalLeaseHeartbeatKey(ownerId, backend, hardwareId, deviceId), timer);
    return { intervalMs, ttlMs };
}

function stopAllBrokerPhysicalLeaseHeartbeats() {
    for (const timer of brokerPhysicalLeaseHeartbeatTimers.values()) clearInterval(timer);
    brokerPhysicalLeaseHeartbeatTimers.clear();
}

type PhysicalLeaseDirectoryScan =
    | { ok: true; entries: Array<{ file: string; hardwareId: string }> }
    | { ok: false; status: number; payload: Record<string, unknown> };

type PhysicalLeaseDirectoryInspection =
    | { ok: true; exists: boolean }
    | { ok: false; status: number; payload: Record<string, unknown> };

function physicalLeaseDirectoryFailure(backend: string, detail: string): PhysicalLeaseDirectoryInspection {
    return {
        ok: false,
        status: 409,
        payload: {
            ok: false,
            error: "physical-lease-directory-invalid",
            backend,
            detail,
        },
    };
}

function inspectPhysicalLeaseDirectory(backend: string): PhysicalLeaseDirectoryInspection {
    const root = brokerRoot();
    const directories = [
        root,
        join(root, "physical-leases"),
        join(root, "physical-leases", backend),
        physicalLeaseLocksDir(backend),
    ];
    for (const directory of directories) {
        let stat;
        try {
            stat = lstatSync(directory);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, exists: false };
            return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-path-invalid");
        }
    }
    return { ok: true, exists: true };
}

function ensurePhysicalLeaseDirectory(backend: string): PhysicalLeaseDirectoryInspection {
    const root = brokerRoot();
    const directories = [
        root,
        join(root, "physical-leases"),
        join(root, "physical-leases", backend),
        physicalLeaseLocksDir(backend),
    ];
    for (const directory of directories) {
        try {
            mkdirSync(directory, { recursive: directory === root, mode: 0o700 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-create-failed");
            }
        }
        let stat;
        try {
            stat = lstatSync(directory);
        } catch {
            return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-read-failed");
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            return physicalLeaseDirectoryFailure(backend, "physical-lease-directory-path-invalid");
        }
    }
    return { ok: true, exists: true };
}

function scanPhysicalLeaseDirectory(backend: string): PhysicalLeaseDirectoryScan {
    const locksDir = physicalLeaseLocksDir(backend);
    const inspection = inspectPhysicalLeaseDirectory(backend);
    if (!inspection.ok) return inspection;
    if (!inspection.exists) return { ok: true, entries: [] };
    try {
        assertDeviceLabPathWithinRoot(brokerRoot(), locksDir, "physical-lease-directory");
        const directory = opendirSync(locksDir);
        const entries: Array<{ file: string; hardwareId: string }> = [];
        let entryCount = 0;
        try {
            while (true) {
                const entry = directory.readSync();
                if (!entry) break;
                entryCount += 1;
                if (entryCount > DEVICE_BROKER_PHYSICAL_LEASE_DIRECTORY_ENTRY_LIMIT) {
                    return {
                        ok: false,
                        status: 507,
                        payload: {
                            ok: false,
                            error: "physical-lease-directory-entry-limit-exceeded",
                            backend,
                            limit: DEVICE_BROKER_PHYSICAL_LEASE_DIRECTORY_ENTRY_LIMIT,
                        },
                    };
                }
                if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
                const encodedHardwareId = entry.name.slice(0, -".json".length);
                let hardwareId: string;
                try {
                    hardwareId = decodeURIComponent(encodedHardwareId);
                } catch {
                    continue;
                }
                if (!hardwareId || hardwareId.length > 256 || /[\u0000-\u001f]/.test(hardwareId)) continue;
                if (encodeURIComponent(hardwareId) !== encodedHardwareId) continue;
                entries.push({ file: join(locksDir, entry.name), hardwareId });
            }
        } finally {
            directory.closeSync();
        }
        return { ok: true, entries };
    } catch (error) {
        return {
            ok: false,
            status: 409,
            payload: {
                ok: false,
                error: "physical-lease-directory-invalid",
                backend,
                detail: deviceLabStateFileErrorCode(error) || "physical-lease-directory-read-failed",
            },
        };
    }
}

function listPhysicalLeases(ownerId: string, backend: string) {
    const scan = scanPhysicalLeaseDirectory(backend);
    if (!scan.ok) return scan;
    const leases = [];
    for (const { file, hardwareId } of scan.entries) {
        const lease = readLeaseFile(file, backend, hardwareId);
        if (!lease || lease.ownerId !== ownerId) continue;
        if (leaseExpired(lease)) continue;
        leases.push({ ...lease, expiresAt: leaseExpiresAt(lease), ttlMs: leaseTtlMs(lease) });
    }
    return { ok: true as const, leases };
}

function createPhysicalLease(ownerId: string, parsed: LeaseParamSuccess, now: string) {
    return withLeaseExpiry({
        backend: parsed.backend,
        hardwareId: parsed.hardwareId,
        ownerId,
        deviceId: parsed.deviceId,
        connection: parsed.connection,
        transport: parsed.transport,
        claimId: randomBytes(16).toString("hex"),
        ...(parsed.claimNonce ? { claimNonce: parsed.claimNonce } : {}),
        claimedAt: now,
    }, parsed.ttlMs, now);
}

function claimPhysicalLease(ownerId: string, params: unknown): BrokerRpcResult {
    const parsed = validateLeaseParams(params, "claim");
    if (!parsed.ok) return leaseParamError(parsed);
    const directory = ensurePhysicalLeaseDirectory(parsed.backend);
    if (!directory.ok) return { status: directory.status, payload: directory.payload };
    const file = physicalLeaseLockFile(parsed.backend, parsed.hardwareId);
    return withSharedMutationLock(physicalLeaseMutationLockFile(parsed.backend, parsed.hardwareId), () => {
        const now = new Date().toISOString();
        const existing = readLeaseFile(file, parsed.backend, parsed.hardwareId);
        if (existing && !leaseExpired(existing) && existing.ownerId === ownerId) {
            if (parsed.deviceId && existing.deviceId && existing.deviceId !== parsed.deviceId) {
                return { status: 409, payload: { ok: false, error: "physical-lease-device-mismatch", conflict: existing } };
            }
            if (parsed.claimNonce && existing.claimNonce !== parsed.claimNonce) {
                return { status: 409, payload: { ok: false, error: "physical-lease-operation-conflict", conflict: existing } };
            }
            const refreshed = withLeaseExpiry(existing, parsed.ttlMs, now);
            writeLeaseFile(file, refreshed);
            return { status: 200, payload: { ok: true, result: { lease: refreshed, created: false, reused: true, heartbeat: true } } };
        }
        if (existing && !leaseExpired(existing)) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "physical-lease-conflict",
                    conflict: existing,
                },
            };
        }
        const lease = createPhysicalLease(ownerId, parsed, now);
        writeLeaseFile(file, lease);
        return { status: 200, payload: { ok: true, result: { lease, created: true } } };
    });
}

function heartbeatPhysicalBrokerLease(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "heartbeat");
    if (!parsed.ok) return leaseParamError(parsed);
    const directory = inspectPhysicalLeaseDirectory(parsed.backend);
    if (!directory.ok) return { status: directory.status, payload: directory.payload };
    if (!directory.exists) return { status: 404, payload: { ok: false, error: "physical-lease-not-found" } };
    const file = physicalLeaseLockFile(parsed.backend, parsed.hardwareId);
    return withSharedMutationLock(physicalLeaseMutationLockFile(parsed.backend, parsed.hardwareId), () => {
        const existing = readLeaseFile(file, parsed.backend, parsed.hardwareId);
        if (!existing) return { status: 404, payload: { ok: false, error: "physical-lease-not-found" } };
        if (existing.ownerId !== ownerId) {
            if (leaseExpired(existing)) {
                try { unlinkSync(file); } catch { /* ignore */ }
                return { status: 404, payload: { ok: false, error: "physical-lease-expired", pruned: true, lease: existing } };
            }
            return { status: 403, payload: { ok: false, error: "physical-lease-owned-by-another-owner", conflict: existing } };
        }
        if (parsed.deviceId && existing.deviceId && existing.deviceId !== parsed.deviceId) {
            return { status: 409, payload: { ok: false, error: "physical-lease-device-mismatch", lease: existing } };
        }
        if (parsed.claimId && existing.claimId !== parsed.claimId) {
            return { status: 409, payload: { ok: false, error: "physical-lease-claim-mismatch", lease: existing } };
        }
        if (parsed.claimNonce && existing.claimNonce !== parsed.claimNonce) {
            return { status: 409, payload: { ok: false, error: "physical-lease-operation-mismatch", lease: existing } };
        }
        if (leaseExpired(existing)) {
            try { unlinkSync(file); } catch { /* ignore */ }
            return { status: 404, payload: { ok: false, error: "physical-lease-expired", pruned: true, lease: existing } };
        }
        const refreshed = withLeaseExpiry(existing, parsed.ttlMs);
        writeLeaseFile(file, refreshed);
        return { status: 200, payload: { ok: true, result: { lease: refreshed, heartbeat: true } } };
    });
}

function physicalLeaseReleaseConflict(ownerId: string, parsed: LeaseParamSuccess, existing: Record<string, unknown> | null): BrokerRpcResult | null {
    if (!existing) return { status: 404, payload: { ok: false, error: "physical-lease-not-found" } };
    if (existing.ownerId !== ownerId) {
        return { status: 403, payload: { ok: false, error: "physical-lease-owned-by-another-owner", conflict: existing } };
    }
    if (parsed.deviceId && existing.deviceId && existing.deviceId !== parsed.deviceId) {
        return { status: 409, payload: { ok: false, error: "physical-lease-device-mismatch", lease: existing } };
    }
    if (parsed.claimId && existing.claimId !== parsed.claimId) {
        return { status: 409, payload: { ok: false, error: "physical-lease-claim-mismatch", lease: existing } };
    }
    if (parsed.claimNonce && existing.claimNonce !== parsed.claimNonce) {
        return { status: 409, payload: { ok: false, error: "physical-lease-operation-mismatch", lease: existing } };
    }
    return null;
}

function completePhysicalBrokerLeaseRelease(ownerId: string, parsed: LeaseParamSuccess, file: string, existing: Record<string, unknown>): BrokerRpcResult {
    unlinkSync(file);
    stopBrokerPhysicalLeaseHeartbeat(ownerId, parsed.backend, parsed.hardwareId, parsed.deviceId || undefined);
    return { status: 200, payload: { ok: true, result: { released: true, lease: existing } } };
}

function restorePhysicalBrokerLeaseRelease(ownerId: string, parsed: LeaseParamSuccess, file: string, existing: Record<string, unknown>) {
    if (existsSync(file)) {
        return { attempted: true, ok: false, error: "physical-lease-rollback-path-occupied", lease: readLeaseFile(file, parsed.backend, parsed.hardwareId) };
    }
    try {
        const restored: Record<string, unknown> = withLeaseExpiry(existing);
        writeLeaseFile(file, restored);
        const deviceId = typeof restored.deviceId === "string" ? restored.deviceId : parsed.deviceId;
        const heartbeat = deviceId
            ? startBrokerPhysicalLeaseHeartbeat(ownerId, parsed.backend, parsed.hardwareId, deviceId, {
                ttlMs: leaseTtlMs(restored),
                claimId: typeof restored.claimId === "string" ? restored.claimId : undefined,
                claimNonce: typeof restored.claimNonce === "string" ? restored.claimNonce : undefined,
            })
            : null;
        return { attempted: true, ok: true, lease: restored, heartbeat };
    } catch (error) {
        return {
            attempted: true,
            ok: false,
            error: "physical-lease-rollback-write-failed",
            detail: error instanceof Error ? error.message : String(error),
        };
    }
}

function releasePhysicalBrokerLease(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "release");
    if (!parsed.ok) return leaseParamError(parsed);
    const directory = inspectPhysicalLeaseDirectory(parsed.backend);
    if (!directory.ok) return { status: directory.status, payload: directory.payload };
    if (!directory.exists) return { status: 404, payload: { ok: false, error: "physical-lease-not-found" } };
    const file = physicalLeaseLockFile(parsed.backend, parsed.hardwareId);
    return withSharedMutationLock(physicalLeaseMutationLockFile(parsed.backend, parsed.hardwareId), () => {
        const existing = readLeaseFile(file, parsed.backend, parsed.hardwareId);
        const conflict = physicalLeaseReleaseConflict(ownerId, parsed, existing);
        if (conflict) return conflict;
        return completePhysicalBrokerLeaseRelease(ownerId, parsed, file, existing!);
    });
}

function prunePhysicalBrokerLeases(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "prune");
    if (!parsed.ok) return leaseParamError(parsed);
    const pruned: Array<Record<string, unknown>> = [];
    const scan = scanPhysicalLeaseDirectory(parsed.backend);
    if (!scan.ok) return { status: scan.status, payload: scan.payload };
    for (const { file, hardwareId } of scan.entries) {
        withSharedMutationLock(physicalLeaseMutationLockFile(parsed.backend, hardwareId), () => {
            const lease = readLeaseFile(file, parsed.backend, hardwareId);
            if (!lease || lease.ownerId !== ownerId || !leaseExpired(lease)) return;
            try {
                unlinkSync(file);
                pruned.push({ ...lease, expired: true, expiresAt: leaseExpiresAt(lease) });
            } catch {
                // A later prune can retry.
            }
        });
    }
    return { status: 200, payload: { ok: true, result: { ownerId, backend: parsed.backend, pruned } } };
}

function listPhysicalBrokerLeases(ownerId: string, params: unknown) {
    const parsed = validateLeaseParams(params, "list");
    if (!parsed.ok) return leaseParamError(parsed);
    const listed = listPhysicalLeases(ownerId, parsed.backend);
    if (!listed.ok) return { status: listed.status, payload: listed.payload };
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                leases: listed.leases,
            },
        },
    };
}

function validateAttachParams(params: unknown): AttachParamError | AttachParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-attach-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    if (!DEVICE_BROKER_PHYSICAL_BACKENDS.has(backend)) {
        return { ok: false, status: 400, error: "invalid-attach-backend", allowed: [...DEVICE_BROKER_PHYSICAL_BACKENDS] };
    }
    const stateKey = backend;
    const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
    const serial = typeof input.serial === "string" && input.serial.trim() ? input.serial.trim() : null;
    const udid = typeof input.udid === "string" && input.udid.trim() ? input.udid.trim() : null;
    const identity = backend === "android-device" ? serial || (typeof input.host === "string" ? input.host : null) : udid;
    const deviceId = typeof input.deviceId === "string" && input.deviceId.trim()
        ? input.deviceId.trim()
        : `${backend}-${createHash("sha256").update(String(identity || name || "real-device")).digest("hex").slice(0, 10)}`;
    if (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId)) {
        return { ok: false, status: 400, error: "invalid-device-id" };
    }
    const connectionProvided = typeof input.connection === "string";
    const connection = connectionProvided ? String(input.connection) : "usb";
    if (!["usb", "wifi"].includes(connection)) return { ok: false, status: 400, error: "invalid-connection" };
    const host = typeof input.host === "string" && input.host.trim() ? input.host.trim() : null;
    const port = Number.isFinite(input.port) ? Number(input.port) : null;
    return { ok: true, backend, stateKey, deviceId, name, serial, udid, connection, connectionProvided, host, port };
}

function attachParamError(parsed: AttachParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}

function parseAdbDevices(text: string) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("List of devices"))
        .map((line) => {
            const [serial, state, ...detailParts] = line.split(/\s+/);
            const details = Object.fromEntries(detailParts.map((part) => {
                const index = part.indexOf(":");
                return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, true];
            }));
            return { serial, state: state || "unknown", details };
        })
        .filter((device) => device.serial);
}

function androidHostDeviceInventory(normalized: NormalizedBrokerOptions) {
    const adb = executableFor("adb", normalized);
    const command = normalized.commandRunner({ mode: "exec", provider: "adb", executable: adb, args: ["devices", "-l"] }, {
        timeoutMs: Math.max(normalized.commandTimeoutMs, DEVICE_BROKER_ANDROID_INVENTORY_TIMEOUT_MS),
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    const devices = commandSucceeded(command)
        ? parseAdbDevices(command.stdout || "").map((device) => ({
            ...device,
            connection: String(device.serial).includes(":") ? "wifi" : "usb",
            emulator: String(device.serial).startsWith("emulator-"),
            attachable: device.state === "device" && !String(device.serial).startsWith("emulator-"),
            reason: device.state === "device"
                ? String(device.serial).startsWith("emulator-") ? "emulator-not-physical" : "ready"
                : `adb-state-${device.state}`,
        }))
        : [];
    return {
        provider: "adb",
        command: {
            provider: command.provider,
            executable: command.executable,
            args: command.args,
            status: command.status,
            stderr: command.stderr,
            error: command.error,
            timedOut: command.timedOut,
        },
        ok: commandSucceeded(command),
        devices,
        count: devices.length,
    };
}

function resolveSingleUsbAndroidTarget(parsed: AttachParamSuccess, normalized: NormalizedBrokerOptions): { ok: true; target: string; inventory: ReturnType<typeof androidHostDeviceInventory> } | { ok: false; status: number; payload: Record<string, unknown> } {
    const inventory = androidHostDeviceInventory(normalized);
    if (!inventory.ok) return { ok: false, status: 502, payload: { ok: false, error: "adb-inventory-failed", inventory } };
    const candidates = inventory.devices.filter((device) => device.connection === "usb" && device.attachable);
    if (candidates.length === 1) return { ok: true, target: candidates[0].serial, inventory };
    return {
        ok: false,
        status: candidates.length === 0 ? 404 : 409,
        payload: {
            ok: false,
            error: candidates.length === 0 ? "android-device-not-visible" : "android-device-selection-required",
            backend: parsed.backend,
            connection: parsed.connection,
            hostDevices: inventory.devices,
            candidates,
            message: candidates.length === 0
                ? "No attachable USB Android device is visible to host adb."
                : "Multiple attachable USB Android devices are visible; pass serial.",
        },
    };
}

function parseXctraceDevices(text: string) {
    return String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.endsWith(":") && !line.includes("Simulator"))
        .map((line) => {
            const matches = [...line.matchAll(/\(([^()]*)\)/g)].map((match) => match[1]);
            const udid = matches.find((value) => /^[A-Fa-f0-9-]{8,}$/.test(value));
            if (!udid) return null;
            const version = matches.find((value) => value !== udid && /\d/.test(value)) || null;
            const name = line.split(" (")[0].trim();
            if (!/\b(iPhone|iPad|iPod)\b/i.test(name)) return null;
            const markers = matches.filter((value) => value !== udid && value !== version);
            const connection = markers.some((value) => /^(network|wifi|wi-fi)$/i.test(value.trim())) ? "wifi" : "usb";
            const availability = markers.some((value) => /^(unavailable|not available|disconnected)$/i.test(value.trim())) ? "unavailable" : "available";
            return { name, udid, version, connection, availability, raw: line };
        })
        .filter(Boolean) as Array<{ name: string; udid: string; version: string | null; connection: string; availability: string; raw: string }>;
}

function validateAppleTrustParams(params: unknown): AppleTrustParamError | AppleTrustParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-apple-trust-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "ios-device";
    if (backend !== "ios-device") {
        return { ok: false, status: 400, error: "invalid-apple-trust-backend", allowed: ["ios-device"] };
    }
    const action = typeof input.action === "string" && input.action.trim() ? input.action.trim() : "status";
    if (!DEVICE_BROKER_APPLE_TRUST_ACTIONS.has(action)) {
        return { ok: false, status: 400, error: "invalid-apple-trust-action", allowed: [...DEVICE_BROKER_APPLE_TRUST_ACTIONS] };
    }
    const udid = typeof input.udid === "string" && input.udid.trim() ? input.udid.trim() : null;
    return { ok: true, action, backend, udid };
}

function appleTrustManualSteps() {
    return [
        "Connect the iPhone or iPad to the macOS host over USB, unlock it, and accept the Trust This Computer prompt.",
        "Enable Developer Mode on the device when iOS requires it.",
        "Open Xcode Devices and Simulators on the macOS host and enable network pairing if Wi-Fi attach is needed.",
        "Re-run device_wireless with backend=ios-device and action=status, then call device_attach when xctrace reports the UDID as USB or Network.",
    ];
}

function appleTrustDiagnostic(action: string, udid: string | null, hostDevice: ReturnType<typeof parseXctraceDevices>[number] | null, inventory: ProviderCommandResult | null) {
    const visible = Boolean(hostDevice);
    const networkVisible = hostDevice?.connection === "wifi";
    const unavailable = hostDevice?.availability === "unavailable";
    const readyToAttach = visible && !unavailable;
    const manualRequired = action !== "status" || !readyToAttach;
    return {
        backend: "ios-device",
        action,
        udid,
        provider: "xcrun-xctrace",
        selected: hostDevice,
        visible,
        networkVisible,
        readyToAttach,
        manualRequired,
        trustState: visible ? unavailable ? "visible-unavailable" : "visible-to-xctrace" : "not-visible",
        supportedActions: ["status"],
        unsupportedActions: ["pair", "connect"],
        attachFlow: networkVisible
            ? "Call device_attach with backend=ios-device, connection=wifi, and this UDID."
            : readyToAttach
                ? "Call device_attach with backend=ios-device and this UDID for USB attach, or complete Xcode network pairing first for Wi-Fi attach."
                : "Complete Apple trust, Developer Mode, and Xcode pairing on the macOS host, then re-run this status check.",
        manualSteps: appleTrustManualSteps(),
        safety: {
            bypassesTrustPrompt: false,
            powersOffDevice: false,
            erasesDevice: false,
            disconnectsDevice: false,
        },
        inventoryCommand: inventory ? {
            provider: inventory.provider,
            executable: inventory.executable,
            args: inventory.args,
            status: inventory.status,
            stderr: inventory.stderr,
        } : null,
    };
}

function appleTrustParamError(parsed: AppleTrustParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}

function existingPhysicalDevice(ownerId: string, stateKey: string, deviceId: string, hardwareId: string, hardwareField: "serial" | "udid") {
    return readOwnerDevices(ownerId, stateKey).find((device) => {
        if (!device || typeof device !== "object") return false;
        const candidate = device as Record<string, unknown>;
        return candidate.id === deviceId || candidate[hardwareField] === hardwareId;
    });
}

function detachedPhysicalDeviceCanReattach(existing: Record<string, unknown>, deviceId: string, hardwareId: string, hardwareField: "serial" | "udid") {
    return existing.id === deviceId
        && existing[hardwareField] === hardwareId
        && existing.status === "detached";
}

function claimOrReattachPhysicalOwnerDevice(
    ownerId: string,
    stateKey: string,
    device: Record<string, unknown>,
    hardwareField: "serial" | "udid",
) {
    return withSharedMutationLock(ownerDevicesMutationLockFile(ownerId, stateKey), () => {
        const devices = readOwnerDevices(ownerId, stateKey);
        const conflicts = devices.filter((candidate) => candidate && typeof candidate === "object" && (
            (candidate as Record<string, unknown>).id === device.id
            || (candidate as Record<string, unknown>)[hardwareField] === device[hardwareField]
        )) as Array<Record<string, unknown>>;
        if (conflicts.length === 0) {
            const next = [...devices, device];
            assertOwnerDeviceStateWritable(next, DEVICE_BROKER_INVENTORY_FILE_LIMIT);
            writeJsonFileAtomically(ownerDevicesFile(ownerId, stateKey), { devices: next });
            return { ok: true as const, device, reattached: false };
        }
        if (conflicts.length !== 1 || !detachedPhysicalDeviceCanReattach(conflicts[0], String(device.id), String(device[hardwareField]), hardwareField)) {
            return { ok: false as const, error: "owner-device-already-attached", existing: conflicts[0] || null };
        }
        const next = devices.map((candidate) => candidate === conflicts[0] ? device : candidate);
        assertOwnerDeviceStateWritable(next, DEVICE_BROKER_INVENTORY_FILE_LIMIT);
        writeJsonFileAtomically(ownerDevicesFile(ownerId, stateKey), { devices: next });
        return { ok: true as const, device, reattached: true };
    });
}

function brokerAttachAndroid(ownerId: string, parsed: AttachParamSuccess, normalized: NormalizedBrokerOptions) {
    const adb = executableFor("adb", normalized);
    if (parsed.connection === "wifi" && !parsed.host && !parsed.serial) {
        return { status: 400, payload: { ok: false, error: "missing-android-wifi-target" } };
    }
    let initialInventory: ReturnType<typeof androidHostDeviceInventory> | null = null;
    const resolvedUsbTarget = parsed.connection === "usb" && !parsed.serial
        ? resolveSingleUsbAndroidTarget(parsed, normalized)
        : null;
    if (resolvedUsbTarget && !resolvedUsbTarget.ok) return { status: resolvedUsbTarget.status, payload: resolvedUsbTarget.payload };
    if (resolvedUsbTarget?.ok) initialInventory = resolvedUsbTarget.inventory;
    const target = parsed.connection === "wifi"
        ? (parsed.serial?.includes(":") ? parsed.serial : `${parsed.host || parsed.serial}:${parsed.port || 5555}`)
        : (parsed.serial || (resolvedUsbTarget?.ok ? resolvedUsbTarget.target : null));
    if (!target || target.startsWith("emulator-")) {
        return { status: 400, payload: { ok: false, error: target?.startsWith("emulator-") ? "android-emulator-not-physical-device" : "missing-android-serial" } };
    }
    const existing = existingPhysicalDevice(ownerId, parsed.stateKey, parsed.deviceId, target, "serial") as Record<string, unknown> | undefined;
    if (existing && !detachedPhysicalDeviceCanReattach(existing, parsed.deviceId, target, "serial")) {
        return { status: 409, payload: { ok: false, error: "owner-device-already-attached", deviceId: parsed.deviceId, hardwareId: target } };
    }
    const leaseClaimNonce = randomBytes(16).toString("hex");
    const lease = claimPhysicalLease(ownerId, {
        backend: parsed.backend,
        hardwareId: target,
        deviceId: parsed.deviceId,
        connection: parsed.connection,
        claimNonce: leaseClaimNonce,
        transport: parsed.connection === "wifi" ? { type: "wifi", host: parsed.host || target.split(":")[0], port: Number(target.split(":")[1] || parsed.port || 5555) } : { type: "usb" },
    });
    if (lease.status !== 200) return lease;
    const leasePayload = lease.payload as { result?: { lease?: Record<string, unknown> } };
    const leaseRecord = leasePayload.result?.lease;
    const releaseLease = () => releasePhysicalBrokerLease(ownerId, {
        backend: parsed.backend,
        hardwareId: target,
        deviceId: parsed.deviceId,
        claimId: leaseRecord?.claimId,
        claimNonce: leaseClaimNonce,
    });
    if (parsed.connection === "wifi") {
        const connect = normalized.commandRunner({ mode: "exec", provider: "adb", executable: adb, args: ["connect", target] }, {
            timeoutMs: normalized.commandTimeoutMs,
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
        if (!commandSucceeded(connect)) {
            releaseLease();
            return { status: 502, payload: { ok: false, error: "adb-connect-failed", command: connect } };
        }
    }
    const inventory = initialInventory || androidHostDeviceInventory(normalized);
    if (!inventory.ok) {
        releaseLease();
        return { status: 502, payload: { ok: false, error: "adb-inventory-failed", inventory } };
    }
    const hostDevice = inventory.devices.find((device) => device.serial === target);
    if (!hostDevice) {
        releaseLease();
        return { status: 404, payload: { ok: false, error: "android-device-not-visible", hardwareId: target, inventory } };
    }
    if (hostDevice.state !== "device") {
        releaseLease();
        return { status: 409, payload: { ok: false, error: "android-device-not-attachable", hardwareId: target, state: hostDevice.state } };
    }
    const now = new Date().toISOString();
    const device = {
        id: parsed.deviceId,
        name: parsed.name || target,
        backend: "android-device",
        kind: "mobile",
        platform: "android",
        physical: true,
        ownerId,
        serial: target,
        connection: parsed.connection,
        transport: parsed.connection === "wifi" ? { type: "wifi", host: parsed.host || target.split(":")[0], port: Number(target.split(":")[1] || parsed.port || 5555) } : { type: "usb", host: null, port: null },
        hostDetails: hostDevice.details,
        leaseClaimId: leaseRecord?.claimId,
        leaseClaimNonce,
        status: "attached",
        creatable: false,
        attachable: true,
        attachedAt: now,
        updatedAt: now,
    };
    try {
        const claim = claimOrReattachPhysicalOwnerDevice(ownerId, parsed.stateKey, device, "serial");
        if (!claim.ok) {
            releaseLease();
            return { status: 409, payload: { ok: false, error: claim.error, existing: claim.existing } };
        }
    } catch (error) {
        releaseLease();
        return { status: 500, payload: { ok: false, error: "owner-state-write-failed", detail: error instanceof Error ? error.message : String(error) } };
    }
    const heartbeat = startBrokerPhysicalLeaseHeartbeat(ownerId, parsed.backend, target, parsed.deviceId, {
        ttlMs: leaseTtlMs(leaseRecord),
        claimId: typeof leaseRecord?.claimId === "string" ? leaseRecord.claimId : undefined,
        claimNonce: leaseClaimNonce,
    });
    return { status: 200, payload: { ok: true, result: { device, lease: leasePayload.result?.lease, heartbeat, provider: "adb", inventory } } };
}

function brokerAttachIos(ownerId: string, parsed: AttachParamSuccess, normalized: NormalizedBrokerOptions) {
    if (!parsed.udid) return { status: 400, payload: { ok: false, error: "missing-ios-udid" } };
    const existing = existingPhysicalDevice(ownerId, parsed.stateKey, parsed.deviceId, parsed.udid, "udid") as Record<string, unknown> | undefined;
    if (existing && !detachedPhysicalDeviceCanReattach(existing, parsed.deviceId, parsed.udid, "udid")) {
        return { status: 409, payload: { ok: false, error: "owner-device-already-attached", deviceId: parsed.deviceId, hardwareId: parsed.udid } };
    }
    const xcrun = executableFor("xcrun", normalized);
    const inventory = normalized.commandRunner({ mode: "exec", provider: "xcrun", executable: xcrun, args: ["xctrace", "list", "devices"] }, {
        timeoutMs: normalized.commandTimeoutMs,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(inventory)) return { status: 502, payload: { ok: false, error: "xctrace-inventory-failed", command: inventory, diagnostic: appleTrustDiagnostic("status", parsed.udid, null, inventory) } };
    const hostDevice = parseXctraceDevices(inventory.stdout || "").find((device) => device.udid === parsed.udid);
    if (!hostDevice) return { status: 404, payload: { ok: false, error: "ios-device-not-visible", hardwareId: parsed.udid, command: inventory, diagnostic: appleTrustDiagnostic("status", parsed.udid, null, inventory) } };
    if (hostDevice.availability === "unavailable") {
        return { status: 409, payload: { ok: false, error: "ios-device-not-attachable", hardwareId: parsed.udid, command: inventory, diagnostic: appleTrustDiagnostic("status", parsed.udid, hostDevice, inventory) } };
    }
    if (parsed.connection === "wifi" && hostDevice.connection !== "wifi") {
        return { status: 409, payload: { ok: false, error: "ios-wifi-device-not-network-visible", hardwareId: parsed.udid, diagnostic: appleTrustDiagnostic("connect", parsed.udid, hostDevice, inventory) } };
    }
    const connection = parsed.connectionProvided ? parsed.connection : hostDevice.connection;
    const leaseClaimNonce = randomBytes(16).toString("hex");
    const lease = claimPhysicalLease(ownerId, {
        backend: parsed.backend,
        hardwareId: parsed.udid,
        deviceId: parsed.deviceId,
        connection,
        claimNonce: leaseClaimNonce,
        transport: { type: connection, host: connection === "wifi" ? parsed.host : null, port: connection === "wifi" ? parsed.port : null, visibleVia: "xctrace" },
    });
    if (lease.status !== 200) return lease;
    const leasePayload = lease.payload as { result?: { lease?: Record<string, unknown> } };
    const leaseRecord = leasePayload.result?.lease;
    const releaseLease = () => releasePhysicalBrokerLease(ownerId, {
        backend: parsed.backend,
        hardwareId: parsed.udid,
        deviceId: parsed.deviceId,
        claimId: leaseRecord?.claimId,
        claimNonce: leaseClaimNonce,
    });
    const now = new Date().toISOString();
    const device = {
        id: parsed.deviceId,
        name: parsed.name || hostDevice.name || parsed.udid,
        backend: "ios-device",
        kind: "mobile",
        platform: "ios",
        physical: true,
        ownerId,
        udid: parsed.udid,
        connection,
        transport: { type: connection, host: connection === "wifi" ? parsed.host : null, port: connection === "wifi" ? parsed.port : null, visibleVia: "xctrace" },
        hostDetails: hostDevice,
        leaseClaimId: leaseRecord?.claimId,
        leaseClaimNonce,
        status: "attached",
        creatable: false,
        attachable: true,
        attachedAt: now,
        updatedAt: now,
    };
    try {
        const claim = claimOrReattachPhysicalOwnerDevice(ownerId, parsed.stateKey, device, "udid");
        if (!claim.ok) {
            releaseLease();
            return { status: 409, payload: { ok: false, error: claim.error, existing: claim.existing } };
        }
    } catch (error) {
        releaseLease();
        return { status: 500, payload: { ok: false, error: "owner-state-write-failed", detail: error instanceof Error ? error.message : String(error) } };
    }
    const heartbeat = startBrokerPhysicalLeaseHeartbeat(ownerId, parsed.backend, parsed.udid, parsed.deviceId, {
        ttlMs: leaseTtlMs(leaseRecord),
        claimId: typeof leaseRecord?.claimId === "string" ? leaseRecord.claimId : undefined,
        claimNonce: leaseClaimNonce,
    });
    return { status: 200, payload: { ok: true, result: { device, lease: leasePayload.result?.lease, heartbeat, provider: "xcrun", inventory } } };
}

function appleTrustStatus(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAppleTrustParams(params);
    if (!parsed.ok) return appleTrustParamError(parsed);
    const xcrun = executableFor("xcrun", normalized);
    const inventory = normalized.commandRunner({ mode: "exec", provider: "xcrun", executable: xcrun, args: ["xctrace", "list", "devices"] }, {
        timeoutMs: normalized.commandTimeoutMs,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(inventory)) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: inventory.error === "executable-not-found" ? "ios-wireless-missing-xcrun" : "xctrace-inventory-failed",
                result: {
                    ownerId,
                    ...appleTrustDiagnostic(parsed.action, parsed.udid, null, inventory),
                },
            },
        };
    }
    const devices = parseXctraceDevices(inventory.stdout || "");
    const selected = parsed.udid ? devices.find((device) => device.udid === parsed.udid) || null : null;
    const diagnostic = {
        ownerId,
        ...appleTrustDiagnostic(parsed.action, parsed.udid, selected, inventory),
        inventory: {
            devices,
            count: devices.length,
        },
    };
    if (parsed.action === "status") {
        return { status: 200, payload: { ok: true, result: diagnostic } };
    }
    if (selected?.connection === "wifi" && selected.availability !== "unavailable" && parsed.action === "connect") {
        return { status: 200, payload: { ok: true, result: { ...diagnostic, alreadyNetworkVisible: true, manualRequired: false } } };
    }
    return {
        status: 409,
        payload: {
            ok: false,
            error: "ios-apple-pairing-manual-required",
            result: diagnostic,
        },
    };
}

function attachPhysicalDevice(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAttachParams(params);
    if (!parsed.ok) return attachParamError(parsed);
    return parsed.backend === "android-device"
        ? brokerAttachAndroid(ownerId, parsed, normalized)
        : brokerAttachIos(ownerId, parsed, normalized);
}

function detachPhysicalDevice(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAttachParams(params);
    if (!parsed.ok) return attachParamError(parsed);
    const input = params as Record<string, unknown>;
    if (typeof input.deviceId !== "string" || !input.deviceId.trim()) {
        return { status: 400, payload: { ok: false, error: "invalid-device-id" } };
    }
    const devices = readOwnerDevices(ownerId, parsed.stateKey);
    const device = devices.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId) as Record<string, unknown> | undefined;
    if (!device) return { status: 404, payload: { ok: false, error: "owner-device-not-found", deviceId: parsed.deviceId } };
    const lifecycleParams: CommandParamSuccess = {
        ok: true,
        backend: parsed.backend,
        stateKey: parsed.stateKey,
        command: "device_stop",
        deviceId: parsed.deviceId,
        force: false,
        dryRun: false,
    };
    const hardwareId = parsed.backend === "android-device" ? String(device.serial || "") : String(device.udid || "");
    const releaseParams = hardwareId ? validateLeaseParams({
        backend: parsed.backend,
        hardwareId,
        deviceId: parsed.deviceId,
        claimId: device.leaseClaimId,
        claimNonce: device.leaseClaimNonce,
    }, "release") : null;
    if (releaseParams && !releaseParams.ok) return leaseParamError(releaseParams);

    const cleanupAndDetach = (
        release: BrokerRpcResult | null,
        releaseAction?: () => BrokerRpcResult,
        rollbackAction?: () => ReturnType<typeof restorePhysicalBrokerLeaseRelease>,
    ): BrokerRpcResult => {
        if (release && release.status !== 200 && release.status !== 404) {
            return {
                status: release.status === 409 ? 409 : 502,
                payload: {
                    ok: false,
                    error: "physical-lease-release-failed",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    release: release.payload,
                },
            };
        }
        const auxiliaryCleanup = cleanupLifecycleAuxiliaryRuntime(ownerId, lifecycleParams, normalized);
        if (auxiliaryCleanup?.result.ok === false) {
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: "auxiliary-runtime-cleanup-failed",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    result: {
                        device: redactBrokerDeviceSecrets(auxiliaryCleanup.device || device),
                        auxiliaryCleanup: auxiliaryCleanup.result,
                        detached: false,
                    },
                },
            };
        }
        const cleanedDevice = (auxiliaryCleanup?.device || device) as Record<string, unknown>;
        const completedRelease = releaseAction ? releaseAction() : release;
        try {
            mutateOwnerDevices(ownerId, parsed.stateKey, (current) => current.filter((candidate) => !(candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId)));
        } catch (error) {
            const leaseRollback = rollbackAction ? rollbackAction() : { attempted: false, ok: true };
            return {
                status: leaseRollback.ok ? 500 : 502,
                payload: {
                    ok: false,
                    error: leaseRollback.ok ? "owner-state-write-failed" : "physical-lease-rollback-failed",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    detail: error instanceof Error ? error.message : String(error),
                    result: {
                        device: redactBrokerDeviceSecrets(cleanedDevice),
                        detached: false,
                        release: completedRelease?.payload || null,
                        leaseRollback,
                        ...(auxiliaryCleanup ? { auxiliaryCleanup: auxiliaryCleanup.result } : {}),
                    },
                },
            };
        }
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    detached: parsed.deviceId,
                    device: redactBrokerDeviceSecrets(cleanedDevice),
                    release: completedRelease?.payload || null,
                    ...(auxiliaryCleanup ? { auxiliaryCleanup: auxiliaryCleanup.result } : {}),
                    physicalDevicePoweredOff: false,
                    disconnected: false,
                },
            },
        };
    };

    if (!releaseParams || !hardwareId) return cleanupAndDetach(null);
    const directory = inspectPhysicalLeaseDirectory(releaseParams.backend);
    if (!directory.ok) return { status: directory.status, payload: directory.payload };
    if (!directory.exists) return cleanupAndDetach({ status: 404, payload: { ok: false, error: "physical-lease-not-found" } });
    const file = physicalLeaseLockFile(releaseParams.backend, releaseParams.hardwareId);
    return withSharedMutationLock(physicalLeaseMutationLockFile(releaseParams.backend, releaseParams.hardwareId), () => {
        const existing = readLeaseFile(file, releaseParams.backend, releaseParams.hardwareId);
        const conflict = physicalLeaseReleaseConflict(ownerId, releaseParams, existing);
        return cleanupAndDetach(
            conflict,
            conflict ? undefined : () => completePhysicalBrokerLeaseRelease(ownerId, releaseParams, file, existing!),
            conflict ? undefined : () => restorePhysicalBrokerLeaseRelease(ownerId, releaseParams, file, existing!),
        );
    });
}

async function withPhysicalDeviceOperation(
    ownerId: string,
    params: unknown,
    operation: () => Promise<BrokerRpcResult> | BrokerRpcResult,
): Promise<BrokerRpcResult> {
    const parsed = validateAttachParams(params);
    if (!parsed.ok) return attachParamError(parsed);
    try {
        return await withOwnerDeviceOperation(ownerId, parsed.stateKey, parsed.deviceId, operation);
    } catch (error) {
        if (!isDeviceOperationLockTimeout(error)) throw error;
        return deviceOperationLockFailure(ownerId, parsed.backend, parsed.deviceId, error);
    }
}

function listAttachedPhysicalDevices(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateLeaseParams(params, "list");
    if (!parsed.ok) return leaseParamError(parsed);
    const listed = listPhysicalLeases(ownerId, parsed.backend);
    if (!listed.ok) return { status: listed.status, payload: listed.payload };
    const hostInventory = parsed.backend === "android-device" ? androidHostDeviceInventory(normalized) : null;
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                devices: readOwnerDevices(ownerId, parsed.backend),
                leases: listed.leases,
                ...(hostInventory ? { hostDevices: hostInventory.devices, hostInventory } : {}),
            },
        },
    };
}

function brokerSlug(value: unknown): string {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "device";
}

function defaultDeviceIdForBackend(backend: string, name: string): string {
    const suffix = brokerSlug(name);
    if (backend === "android-emulator") return `android-${suffix}`;
    if (backend === "ios-simulator") return `ios-${suffix}`;
    if (backend === "windows-sandbox") return `windows-${suffix}`;
    if (backend === "windows-vm") return `windows-vm-${suffix}`;
    if (backend === "linux-vm") return `linux-vm-${suffix}`;
    if (backend === "macos-vm") return `macos-${suffix}`;
    return suffix;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
    const value = input[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
    const value = input[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
    const value = input[key];
    return typeof value === "boolean" ? value : undefined;
}

function createCommandParams(backend: string, input: Record<string, unknown>): Record<string, unknown> | null {
    const name = optionalString(input, "name");
    if (!name) return null;
    return {
        name,
        avdName: optionalString(input, "avdName"),
        port: optionalNumber(input, "port"),
        systemImage: optionalString(input, "systemImage"),
        deviceProfile: optionalString(input, "deviceProfile"),
        createAvd: optionalBoolean(input, "createAvd"),
        headless: optionalBoolean(input, "headless"),
        minimized: optionalBoolean(input, "minimized"),
        simulatorName: optionalString(input, "simulatorName"),
        deviceType: optionalString(input, "deviceType"),
        runtime: optionalString(input, "runtime"),
        udid: optionalString(input, "udid"),
        createSimulator: optionalBoolean(input, "createSimulator"),
        networking: optionalBoolean(input, "networking"),
        clipboard: optionalBoolean(input, "clipboard"),
        vgpu: optionalBoolean(input, "vgpu"),
        memoryMb: optionalNumber(input, "memoryMb"),
        provider: optionalString(input, "provider"),
        image: optionalString(input, "image"),
        sourceImage: optionalString(input, "sourceImage"),
        baseImageSha256: optionalString(input, "baseImageSha256"),
        baseImageGeneration: optionalNumber(input, "baseImageGeneration"),
        profile: optionalString(input, "profile"),
        switchName: optionalString(input, "switchName"),
        networkAddress: optionalString(input, "networkAddress"),
        macAddress: optionalString(input, "macAddress"),
        networkGateway: optionalString(input, "networkGateway"),
        networkPrefix: optionalString(input, "networkPrefix"),
        outboundPolicy: optionalString(input, "outboundPolicy"),
        incarnationId: optionalString(input, "incarnationId"),
        secureBootTemplate: optionalString(input, "secureBootTemplate"),
        vmId: optionalString(input, "vmId"),
        cpus: optionalNumber(input, "cpus"),
        diskMaxBytes: optionalNumber(input, "diskMaxBytes"),
        sshHost: optionalString(input, "sshHost"),
        sshPort: optionalNumber(input, "sshPort"),
        sshUser: optionalString(input, "sshUser"),
        sshKeyPath: optionalString(input, "sshKeyPath"),
        sshPassword: optionalString(input, "sshPassword"),
        backend,
    };
}

function validateCommandParams(params: unknown): CommandParamError | CommandParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-command-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    const stateKey = DEVICE_BROKER_COMMAND_BACKENDS.get(backend);
    if (!stateKey) {
        return { ok: false, status: 400, error: "invalid-command-backend", allowed: [...DEVICE_BROKER_COMMAND_BACKENDS.keys()] };
    }
    const command = typeof input.command === "string" ? input.command : "";
    if (!DEVICE_BROKER_LIFECYCLE_COMMANDS.has(command)) {
        return { ok: false, status: 400, error: "unsupported-lifecycle-command", allowed: [...DEVICE_BROKER_LIFECYCLE_COMMANDS] };
    }
    if (command === "device_create" && !DEVICE_BROKER_CREATABLE_BACKENDS.has(backend)) {
        return { ok: false, status: 400, error: "invalid-create-backend", allowed: [...DEVICE_BROKER_CREATABLE_BACKENDS] };
    }
    if (command === "device_reboot" && !isHyperVBackend(backend)) {
        return { ok: false, status: 400, error: "invalid-reboot-backend", allowed: [...DEVICE_BROKER_HYPER_V_BACKENDS] };
    }
    const create = command === "device_create" ? createCommandParams(backend, input) : undefined;
    if (command === "device_create" && !create) {
        return { ok: false, status: 400, error: "invalid-device-name" };
    }
    if (command === "device_create" && backend === "linux-vm" && create?.networking === false) {
        return { ok: false, status: 400, error: "linux-vm-networking-required" };
    }
    if (backend === "linux-vm"
        && (command === "device_start" || command === "device_reboot")
        && input.waitForBoot === false) {
        return { ok: false, status: 400, error: "linux-vm-bootstrap-requires-boot-wait" };
    }
    const deviceId = typeof input.deviceId === "string" && input.deviceId.trim()
        ? input.deviceId.trim()
        : command === "device_create"
            ? defaultDeviceIdForBackend(backend, String(create?.name || "device"))
            : "";
    if (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId)) {
        return { ok: false, status: 400, error: "invalid-device-id" };
    }
    const dryRun = input.dryRun === true;
    return {
        ok: true,
        backend,
        stateKey,
        command,
        deviceId,
        ...(typeof input.incarnationId === "string" ? { expectedIncarnationId: input.incarnationId } : {}),
        force: input.force === true,
        ...(typeof input.startIfStopped === "boolean" ? { startIfStopped: input.startIfStopped } : {}),
        dryRun,
        ...(typeof input.headless === "boolean" ? { headless: input.headless } : {}),
        ...(typeof input.minimized === "boolean" ? { minimized: input.minimized } : {}),
        ...(typeof input.waitForBoot === "boolean" ? { waitForBoot: input.waitForBoot } : {}),
        ...(typeof input.bootTimeoutMs === "number" && Number.isFinite(input.bootTimeoutMs) ? { bootTimeoutMs: input.bootTimeoutMs } : {}),
        ...(typeof input.deleteAvd === "boolean" ? { deleteAvd: input.deleteAvd } : {}),
        ...(typeof input.deleteSimulator === "boolean" ? { deleteSimulator: input.deleteSimulator } : {}),
        ...(create ? { create } : {}),
    };
}

function commandParamError(parsed: CommandParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}

function validateAppiumParams(params: unknown, action: "status" | "record" | "clear" | "start" | "stop" | "session" | "delete-session" | "request"): AppiumParamError | AppiumParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-appium-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    const stateKey = DEVICE_BROKER_APPIUM_BACKENDS.get(backend);
    if (!stateKey) {
        return { ok: false, status: 400, error: "invalid-appium-backend", allowed: [...DEVICE_BROKER_APPIUM_BACKENDS.keys()] };
    }
    const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : "";
    if (!deviceId || deviceId.length > 128 || /[^a-zA-Z0-9._:-]/.test(deviceId)) {
        return { ok: false, status: 400, error: action === "record" ? "invalid-device-id" : "invalid-appium-device-id" };
    }
    return { ok: true, backend, stateKey, deviceId };
}

function allowedAppiumRequests() {
    return [...DEVICE_BROKER_APPIUM_REQUEST_ALLOWLIST.entries()]
        .flatMap(([path, methods]) => [...methods].map((method) => `${method} ${path}`));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonBodySize(value: unknown) {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
        return Infinity;
    }
}

function safeText(value: unknown, maxLength = 512): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f]/.test(value);
}

function safeAbsolutePath(value: unknown) {
    return safeText(value, 1024) && value.startsWith("/") && !value.includes("..") && !value.includes("://");
}

function safeAppId(value: unknown) {
    return safeText(value, 256) && /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(value);
}

function safeAndroidComponent(value: unknown) {
    return safeText(value, 256) && /^[A-Za-z][A-Za-z0-9_.$]*(?:\.[A-Za-z][A-Za-z0-9_.$]*)*\/\.?[A-Za-z][A-Za-z0-9_.$]*$/.test(value);
}

function emptyOrPlainBody(body: unknown) {
    return body === null || isPlainRecord(body);
}

function validateAndroidShellRequest(command: unknown, args: unknown): AppiumRequestBodyValidation {
    if (command === "svc" && Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
        const [service, action] = args;
        if (args.length === 2 && ["wifi", "data"].includes(service) && ["enable", "disable"].includes(action)) {
            return { ok: true };
        }
    }
    if (command === "settings" && Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
        const [verb, namespace, key, value] = args;
        if (args.length === 4 && verb === "put" && namespace === "system" && key === "accelerometer_rotation" && ["0", "1"].includes(value)) {
            return { ok: true };
        }
        if (args.length === 4 && verb === "put" && namespace === "system" && key === "user_rotation" && ["0", "1", "2", "3"].includes(value)) {
            return { ok: true };
        }
        if (args.length === 4 && verb === "put" && namespace === "global" && key === "airplane_mode_on" && ["0", "1"].includes(value)) {
            return { ok: true };
        }
    }
    if (command === "am" && Array.isArray(args) && args.length === 3 && args[0] === "start" && args[1] === "-n" && safeAndroidComponent(args[2])) {
        return { ok: true };
    }
    if (command === "am" && Array.isArray(args) && args.every((arg) => typeof arg === "string")) {
        if (args.length === 6 && args[0] === "broadcast" && args[1] === "-a" && args[2] === "android.intent.action.AIRPLANE_MODE" && args[3] === "--ez" && args[4] === "state" && ["true", "false"].includes(args[5])) {
            return { ok: true };
        }
    }
    if (command === "pm" && Array.isArray(args) && args.length === 2 && args[0] === "clear" && safeAppId(args[1])) {
        return { ok: true };
    }
    return { ok: false, status: 403, error: "disallowed-appium-mobile-shell-command", allowed: ["settings put system accelerometer_rotation", "settings put system user_rotation", "settings put global airplane_mode_on", "svc wifi|data enable|disable", "am broadcast airplane mode", "am start -n <component>", "pm clear <package>"] };
}

function validateAppiumExecuteSyncBody(backend: string, body: unknown): AppiumRequestBodyValidation {
    if (!isPlainRecord(body) || typeof body.script !== "string") {
        return { ok: false, status: 400, error: "invalid-appium-execute-sync-body" };
    }
    const args = body.args;
    if (body.script === "mobile: shell") {
        if (!backend.startsWith("android") || !Array.isArray(args) || args.length !== 1 || !isPlainRecord(args[0])) {
            return { ok: false, status: 403, error: "disallowed-appium-mobile-shell-command" };
        }
        return validateAndroidShellRequest(args[0].command, args[0].args);
    }
    if (body.script === "mobile: activeAppInfo" && backend.startsWith("ios") && Array.isArray(args) && args.length === 0) {
        return { ok: true };
    }
    if (body.script === "mobile: pressButton" && backend.startsWith("ios") && Array.isArray(args) && args.length === 1 && isPlainRecord(args[0]) && args[0].name === "home") {
        return { ok: true };
    }
    if ((body.script === "mobile: lock" || body.script === "mobile: unlock") && backend.startsWith("ios") && Array.isArray(args) && args.length === 0) {
        return { ok: true };
    }
    return { ok: false, status: 403, error: "disallowed-appium-mobile-script", allowed: ["mobile: activeAppInfo", "mobile: pressButton home", "mobile: lock", "mobile: unlock", "mobile: shell allowlist"] };
}

function validateAppiumRequestBody(backend: string, method: DeviceBrokerAppiumRequestMethod, path: string, body: unknown): AppiumRequestBodyValidation {
    const allowedMethods = DEVICE_BROKER_APPIUM_REQUEST_ALLOWLIST.get(path);
    if (!allowedMethods?.has(method)) {
        return { ok: false, status: 403, error: "disallowed-appium-request", allowed: allowedAppiumRequests() };
    }
    if (method === "GET") {
        return body === null ? { ok: true } : { ok: false, status: 400, error: "invalid-appium-request-body" };
    }
    if (!emptyOrPlainBody(body)) {
        return { ok: false, status: 400, error: "invalid-appium-request-body" };
    }
    if (path === "/execute/sync") return validateAppiumExecuteSyncBody(backend, body);
    if (path === "/actions") return isPlainRecord(body) && Array.isArray(body.actions) && body.actions.length > 0 && body.actions.length <= 8
        ? { ok: true }
        : { ok: false, status: 400, error: "invalid-appium-actions-body" };
    if (path === "/keys") return isPlainRecord(body) && safeText(body.text, 4096) && Array.isArray(body.value) && body.value.every((entry) => typeof entry === "string")
        ? { ok: true }
        : { ok: false, status: 400, error: "invalid-appium-keys-body" };
    if (path === "/back") return isPlainRecord(body) && Object.keys(body).length === 0
        ? { ok: true }
        : { ok: false, status: 400, error: "invalid-appium-back-body" };
    if (path === "/orientation") return isPlainRecord(body) && typeof body.orientation === "string" && ["PORTRAIT", "LANDSCAPE"].includes(body.orientation)
        ? { ok: true }
        : { ok: false, status: 400, error: "invalid-appium-orientation-body" };
    if (path === "/url") return isPlainRecord(body) && safeText(body.url, 2048) && /^[a-z][a-z0-9+.-]*:/i.test(body.url)
        ? { ok: true }
        : { ok: false, status: 400, error: "invalid-appium-url-body" };
    if (path === "/location") {
        const location = isPlainRecord(body) ? body.location : null;
        return isPlainRecord(location)
            && typeof location.latitude === "number" && Number.isFinite(location.latitude) && location.latitude >= -90 && location.latitude <= 90
            && typeof location.longitude === "number" && Number.isFinite(location.longitude) && location.longitude >= -180 && location.longitude <= 180
            && (location.altitude === undefined || (typeof location.altitude === "number" && Number.isFinite(location.altitude)))
            ? { ok: true }
            : { ok: false, status: 400, error: "invalid-appium-location-body" };
    }
    if (path === "/appium/device/press_keycode") return backend.startsWith("android") && isPlainRecord(body) && Number.isInteger(body.keycode) && Number(body.keycode) >= 0 && Number(body.keycode) <= 300
        ? { ok: true }
        : { ok: false, status: 403, error: "disallowed-appium-press-keycode" };
    if (path === "/appium/device/install_app") return isPlainRecord(body) && safeAbsolutePath(body.appPath)
        ? { ok: true }
        : { ok: false, status: 400, error: "invalid-appium-install-app-body" };
    if (["/appium/device/activate_app", "/appium/device/remove_app", "/appium/device/terminate_app", "/appium/device/app_state"].includes(path)) {
        return isPlainRecord(body) && safeAppId(body.appId)
            ? { ok: true }
            : { ok: false, status: 400, error: "invalid-appium-app-id-body" };
    }
    if (path === "/appium/device/set_clipboard") return isPlainRecord(body) && safeText(body.content, 16384) && body.contentType === "plaintext" && (body.label === undefined || safeText(body.label, 128))
        ? { ok: true }
        : { ok: false, status: 400, error: "invalid-appium-clipboard-body" };
    if (path === "/appium/device/get_clipboard") return isPlainRecord(body) && body.contentType === "plaintext"
        ? { ok: true }
        : { ok: false, status: 400, error: "invalid-appium-clipboard-body" };
    return { ok: false, status: 403, error: "disallowed-appium-request", allowed: allowedAppiumRequests() };
}

function validateAppiumRequestParams(params: unknown): AppiumRequestParamError | AppiumRequestParamSuccess {
    const parsed = validateAppiumParams(params, "request");
    if (!parsed.ok) return parsed;
    const input = params as Record<string, unknown>;
    const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET";
    if (!["GET", "POST"].includes(method)) {
        return { ok: false, status: 400, error: "invalid-appium-request-method", allowed: ["GET", "POST"] };
    }
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!path || path.length > 512 || !path.startsWith("/") || path.includes("://") || path.includes("..") || /[\u0000-\u001f]/.test(path)) {
        return { ok: false, status: 400, error: "invalid-appium-request-path" };
    }
    const body = input.body ?? null;
    if (body !== null && (!isPlainRecord(body) || jsonBodySize(body) > DEVICE_BROKER_RPC_BODY_LIMIT)) {
        return { ok: false, status: 400, error: "invalid-appium-request-body" };
    }
    const bodyValidation = validateAppiumRequestBody(parsed.backend, method as DeviceBrokerAppiumRequestMethod, path, body);
    if (!bodyValidation.ok) return bodyValidation;
    return { ...parsed, method: method as DeviceBrokerAppiumRequestMethod, path, body };
}

function requestedAppiumPort(params: unknown) {
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    const input = params as Record<string, unknown>;
    const value = input.port ?? input.appiumPort ?? input.serverPort;
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

function defaultAppiumPort(ownerId: string, backend: string, deviceId: string) {
    const digest = createHash("sha256").update(`${ownerId}:${backend}:${deviceId}:appium`).digest();
    return 20000 + digest.readUInt16BE(0) % 20000;
}

function appiumAutomationName(backend: string) {
    return backend.startsWith("android") ? "UiAutomator2" : "XCUITest";
}

function appiumProviderName(backend: string) {
    return backend.startsWith("android") ? "appium-uiautomator2" : "appium-xcuitest";
}

function javaHomeForAppium(normalized: NormalizedBrokerOptions) {
    if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
    const javaName = normalized.platform === "win32" ? "java.exe" : "java";
    const candidates = normalized.platform === "win32"
        ? [
            process.env.ProgramFiles ? join(process.env.ProgramFiles, "Android", "Android Studio", "jbr") : "",
            process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Android Studio", "jbr") : "",
        ]
        : normalized.platform === "darwin"
            ? ["/Applications/Android Studio.app/Contents/jbr/Contents/Home"]
            : ["/opt/android-studio/jbr"];
    for (const candidate of candidates.filter(Boolean)) {
        if (existsSync(join(candidate, "bin", javaName))) return candidate;
    }
    const java = resolveExecutablePath(javaName);
    return java && existsSync(java) ? dirname(dirname(java)) : null;
}

export function windowsHiddenChildProcessPreloadScript() {
    return [
        '"use strict";',
        'const childProcess = require("node:child_process");',
        'const { syncBuiltinESMExports } = require("node:module");',
        'const marker = Symbol.for("ccc.windowsHiddenChildProcesses");',
        'if (!childProcess[marker]) {',
        '  const hidden = (options) => ({ ...(options && typeof options === "object" ? options : {}), windowsHide: true });',
        '  const spawn = childProcess.spawn;',
        '  childProcess.spawn = function(command, args, options) {',
        '    return Array.isArray(args) ? spawn.call(this, command, args, hidden(options)) : spawn.call(this, command, hidden(args));',
        '  };',
        '  const spawnSync = childProcess.spawnSync;',
        '  childProcess.spawnSync = function(command, args, options) {',
        '    return Array.isArray(args) ? spawnSync.call(this, command, args, hidden(options)) : spawnSync.call(this, command, hidden(args));',
        '  };',
        '  const exec = childProcess.exec;',
        '  childProcess.exec = function(command, options, callback) {',
        '    return typeof options === "function" ? exec.call(this, command, hidden(), options) : exec.call(this, command, hidden(options), callback);',
        '  };',
        '  const execSync = childProcess.execSync;',
        '  childProcess.execSync = function(command, options) { return execSync.call(this, command, hidden(options)); };',
        '  const execFile = childProcess.execFile;',
        '  childProcess.execFile = function(file, args, options, callback) {',
        '    if (!Array.isArray(args)) return typeof args === "function" ? execFile.call(this, file, hidden(), args) : execFile.call(this, file, [], hidden(args), options);',
        '    return typeof options === "function" ? execFile.call(this, file, args, hidden(), options) : execFile.call(this, file, args, hidden(options), callback);',
        '  };',
        '  const execFileSync = childProcess.execFileSync;',
        '  childProcess.execFileSync = function(file, args, options) {',
        '    return Array.isArray(args) ? execFileSync.call(this, file, args, hidden(options)) : execFileSync.call(this, file, [], hidden(args));',
        '  };',
        '  const fork = childProcess.fork;',
        '  childProcess.fork = function(modulePath, args, options) {',
        '    return Array.isArray(args) ? fork.call(this, modulePath, args, hidden(options)) : fork.call(this, modulePath, [], hidden(args));',
        '  };',
        '  Object.defineProperty(childProcess, marker, { value: true });',
        '  syncBuiltinESMExports();',
        '}',
        '',
    ].join("\n");
}

function ensureBrokerLauncherDirectory(directory: string): void {
    const root = resolve(brokerRoot());
    const target = resolve(directory);
    const child = relative(root, target);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error("windows-provider-launcher-path-outside-root");
    }
    const segments = child ? child.split(sep) : [];
    let current = root;
    try {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        for (const segment of ["", ...segments]) {
            if (segment) {
                current = join(current, segment);
                try {
                    mkdirSync(current, { mode: 0o700 });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                }
            }
            const stat = lstatSync(current);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("windows-provider-launcher-directory-invalid");
        }
    } catch (error) {
        if (error instanceof Error && error.message === "windows-provider-launcher-directory-invalid") throw error;
        throw new Error("windows-provider-launcher-directory-unavailable");
    }
}

function createExclusiveBrokerLauncher(directory: string, prefix: string, extension: string, content: string): string {
    ensureBrokerLauncherDirectory(directory);
    const bytes = Buffer.from(content, "utf8");
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const path = join(directory, `${prefix}-${randomBytes(16).toString("hex")}.${extension}`);
        let descriptor: number | null = null;
        try {
            descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
            let offset = 0;
            while (offset < bytes.length) {
                const count = writeSync(descriptor, bytes, offset, bytes.length - offset);
                if (count <= 0) throw new Error("windows-provider-launcher-write-failed");
                offset += count;
            }
            try { fchmodSync(descriptor, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
            const opened = fstatSync(descriptor);
            const current = lstatSync(path);
            ensureBrokerLauncherDirectory(directory);
            if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || opened.nlink !== 1 || current.nlink !== 1
                || opened.size !== bytes.length || current.size !== bytes.length
                || (opened.dev !== 0 && current.dev !== 0 && opened.dev !== current.dev)
                || (opened.ino !== 0 && current.ino !== 0 && opened.ino !== current.ino)) {
                throw new Error("windows-provider-launcher-file-invalid");
            }
            closeSync(descriptor);
            descriptor = null;
            return path;
        } catch (error) {
            if (descriptor !== null) closeSync(descriptor);
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            if (error instanceof Error && error.message.startsWith("windows-provider-launcher-")) throw error;
            throw new Error("windows-provider-launcher-create-failed");
        }
    }
    throw new Error("windows-provider-launcher-create-failed");
}

function brokerLauncherMatches(path: string, content: string): boolean {
    try {
        assertDeviceLabPathWithinRoot(brokerRoot(), path, "windows-provider-launcher");
        ensureBrokerLauncherDirectory(dirname(path));
        return readDeviceLabTextFile(path, "windows-provider-launcher", Buffer.byteLength(content) + 1) === content;
    } catch {
        return false;
    }
}

let cachedWindowsHiddenPreload: { root: string; path: string; content: string } | null = null;

function windowsHiddenChildProcessPreloadPath() {
    const content = windowsHiddenChildProcessPreloadScript();
    const root = resolve(brokerRoot());
    if (cachedWindowsHiddenPreload?.root === root
        && cachedWindowsHiddenPreload.content === content
        && brokerLauncherMatches(cachedWindowsHiddenPreload.path, content)) {
        return cachedWindowsHiddenPreload.path;
    }
    const path = createExclusiveBrokerLauncher(join(root, "broker", "launchers"), "hidden-child-processes", "cjs", content);
    cachedWindowsHiddenPreload = { root, path, content };
    return path;
}

function appendNodeRequireOption(nodeOptions: string | undefined, preloadPath: string) {
    const normalizedPath = preloadPath.replace(/\\/g, "/").replace(/"/g, '\\"');
    if (nodeOptions?.includes(normalizedPath)) return nodeOptions.trim();
    return [nodeOptions?.trim(), `--require="${normalizedPath}"`].filter(Boolean).join(" ");
}

export function hiddenProviderCommandEnv(env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform = process.platform) {
    if (platform !== "win32") return env;
    const merged = { ...(env || {}) };
    merged.NODE_OPTIONS = appendNodeRequireOption(merged.NODE_OPTIONS ?? process.env.NODE_OPTIONS, windowsHiddenChildProcessPreloadPath());
    return merged;
}

function appiumCommandEnv(backend: string, normalized: NormalizedBrokerOptions) {
    const env: NodeJS.ProcessEnv = {};
    if (normalized.platform === "win32") {
        env.NODE_OPTIONS = hiddenProviderCommandEnv(undefined, normalized.platform)?.NODE_OPTIONS;
    }
    if (backend.startsWith("android")) {
        const adb = providerExecutable("adb", normalized);
        const discoveredSdkRoot = adb && basename(dirname(adb)).toLowerCase() === "platform-tools"
            ? dirname(dirname(adb))
            : null;
        const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || discoveredSdkRoot;
        if (sdkRoot) {
            env.ANDROID_HOME = sdkRoot;
            env.ANDROID_SDK_ROOT = sdkRoot;
        }
        const javaHome = javaHomeForAppium(normalized);
        if (javaHome) env.JAVA_HOME = javaHome;
    }
    return Object.keys(env).length > 0 ? env : undefined;
}

function readBrokerAppiumRuntimeManifests(packageRoot: string) {
    const sourcePackage = join(packageRoot, "device-lab-mcp", "package.json");
    const sourceLock = join(packageRoot, "device-lab-mcp", "package-lock.json");
    try {
        assertDeviceLabPathWithinRoot(packageRoot, sourcePackage, "appium-runtime-package");
        assertDeviceLabPathWithinRoot(packageRoot, sourceLock, "appium-runtime-lock");
        const packageText = readDeviceLabTextFile(
            sourcePackage,
            "appium-runtime-package",
            DEVICE_BROKER_APPIUM_PACKAGE_MANIFEST_LIMIT_BYTES,
        );
        const lockText = readDeviceLabTextFile(
            sourceLock,
            "appium-runtime-lock",
            DEVICE_BROKER_APPIUM_LOCK_MANIFEST_LIMIT_BYTES,
        );
        if (packageText === null || lockText === null) {
            return { ok: false as const, error: "appium-runtime-manifest-missing", sourcePackage, sourceLock };
        }
        for (const text of [packageText, lockText]) {
            const parsed = JSON.parse(text) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("invalid-appium-runtime-manifest");
            }
        }
        return { ok: true as const, packageText, lockText, sourcePackage, sourceLock };
    } catch (error) {
        return {
            ok: false as const,
            error: "appium-runtime-manifest-invalid",
            detail: deviceLabStateFileErrorCode(error) || "appium-runtime-manifest-invalid",
            sourcePackage,
            sourceLock,
        };
    }
}

function appiumRuntimeOperationError(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : "";
    return /^appium-runtime-[a-z0-9-]+$/.test(message) ? message : fallback;
}

function ensureBrokerAppiumRuntime(normalized: NormalizedBrokerOptions) {
    const injected = normalized.providerPaths.appium;
    if (injected) return { ok: true as const, executable: injected, argsPrefix: [] as string[], provisioned: false, source: "provider-path" };

    const packageRoot = packageRootForBroker(normalized);
    const manifests = readBrokerAppiumRuntimeManifests(packageRoot);
    if (!manifests.ok) return manifests;

    const runtimeRoot = brokerAppiumRuntimeRoot();
    const executable = brokerAppiumRuntimeExecutable(normalized);
    const entry = brokerAppiumRuntimeEntry();
    const markerFile = join(runtimeRoot, ".ccc-runtime.json");
    const manifestHash = createHash("sha256").update(manifests.packageText).update(manifests.lockText).digest("hex");
    try {
        ensureBrokerAppiumRuntimeDirectory();
        return withSharedMutationLock(brokerAppiumRuntimeInstallLockFile(), () => {
            ensureBrokerAppiumRuntimeDirectory();
            if (!inspectBrokerAppiumRuntimeDirectory()) throw new Error("appium-runtime-directory-invalid");
            try {
                const marker = readDeviceLabStateFile(markerFile, (value) => {
                    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-appium-runtime-marker");
                    return value as { manifestHash?: unknown };
                }, "appium-runtime-marker", DEVICE_BROKER_APPIUM_RUNTIME_MARKER_LIMIT_BYTES);
                if (marker?.manifestHash === manifestHash && brokerAppiumRuntimeEntryIsValid(entry)) {
                    return { ok: true as const, executable: process.execPath, argsPrefix: [entry], provisioned: false, source: "broker-runtime" };
                }
            } catch {
                // A linked, malformed, or incomplete runtime is never reused.
            }

            const npm = resolveExecutablePath(normalized.platform === "win32" ? "npm.cmd" : "npm") || resolveExecutablePath("npm");
            if (!npm) return { ok: false as const, error: "appium-runtime-npm-missing", runtimeRoot };
            inspectBrokerAppiumNodeModulesDirectory();
            writeFileAtomically(join(runtimeRoot, "package.json"), manifests.packageText);
            writeFileAtomically(join(runtimeRoot, "package-lock.json"), manifests.lockText);
            try {
                unlinkSync(markerFile);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("appium-runtime-marker-remove-failed");
            }
            const command: ProviderCommand = {
                mode: "exec",
                provider: "npm-appium-runtime",
                executable: npm,
                args: ["ci", "--prefix", runtimeRoot, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
            };
            const execution = normalized.commandRunner(command, {
                timeoutMs: DEVICE_BROKER_APPIUM_INSTALL_TIMEOUT_MS,
                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
            });
            if (!commandSucceeded(execution) || !inspectBrokerAppiumRuntimeDirectory()
                || !inspectBrokerAppiumNodeModulesDirectory() || !brokerAppiumRuntimeEntryIsValid(entry)) {
                return {
                    ok: false as const,
                    error: "appium-runtime-install-failed",
                    runtimeRoot,
                    executable,
                    entry,
                    execution,
                };
            }
            writeJsonFileAtomically(markerFile, {
                manifestHash,
                installedAt: new Date().toISOString(),
                packageRoot,
            });
            return { ok: true as const, executable: process.execPath, argsPrefix: [entry], provisioned: true, source: "broker-runtime", execution };
        }, {
            waitMs: DEVICE_BROKER_APPIUM_INSTALL_LOCK_WAIT_MS,
            staleMs: DEVICE_BROKER_APPIUM_INSTALL_LOCK_STALE_MS,
        });
    } catch (error) {
        const lockTimeout = (error as Error & { code?: string }).code === "shared-mutation-lock-timeout";
        return {
            ok: false as const,
            error: lockTimeout
                ? "appium-runtime-install-lock-timeout"
                : appiumRuntimeOperationError(error, "appium-runtime-install-failed"),
            runtimeRoot,
        };
    }
}

function appiumCapabilities(backend: string, device: unknown) {
    if (!device || typeof device !== "object") return {};
    const record = device as Record<string, unknown>;
    if (backend.startsWith("android")) {
        const serial = androidSerial(device);
        return {
            platformName: "Android",
            "appium:automationName": "UiAutomator2",
            "appium:deviceName": field(device, "name") || field(device, "id") || backend,
            "appium:adbExecTimeout": 120000,
            "appium:uiautomator2ServerInstallTimeout": 120000,
            "appium:uiautomator2ServerLaunchTimeout": 120000,
            ...(serial ? { "appium:udid": serial } : {}),
            ...(typeof record.avdName === "string" && record.avdName ? { "appium:avd": record.avdName } : {}),
        };
    }
    return {
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:deviceName": field(device, "simulatorName") || field(device, "name") || field(device, "id") || backend,
        ...(typeof record.udid === "string" && record.udid ? { "appium:udid": record.udid } : {}),
        ...(backend === "ios-device" ? { "appium:realDevice": true } : {}),
    };
}

function appiumInstrumentationInitializationFailed(response: Awaited<ReturnType<typeof fetchAppiumJson>>) {
    const text = JSON.stringify(response.body || {}).toLowerCase();
    return text.includes("instrumentation process cannot be initialized")
        || text.includes("uiautomator2 server cannot be started");
}

function resetAndroidAppiumInstrumentation(device: unknown, normalized: NormalizedBrokerOptions) {
    const adb = providerExecutable("adb", normalized);
    const serial = androidSerial(device);
    if (!adb || !serial) return { attempted: false, ok: false, error: "missing-adb-or-serial", results: [] };
    const commands = [
        ["shell", "am", "force-stop", "io.appium.uiautomator2.server"],
        ["shell", "am", "force-stop", "io.appium.uiautomator2.server.test"],
        ["uninstall", "io.appium.uiautomator2.server"],
        ["uninstall", "io.appium.uiautomator2.server.test"],
        ["uninstall", "io.appium.settings"],
    ];
    const results = commands.map((args) => normalized.commandRunner({
        mode: "exec",
        provider: "adb-appium-recovery",
        executable: adb,
        args: ["-s", serial, ...args],
    }, {
        timeoutMs: 30000,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    }));
    return { attempted: true, ok: true, adb, serial, results };
}

async function readBoundedAppiumResponse(response: Response) {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return {
            ok: false as const,
            error: "appium-response-too-large",
            declaredBytes: Number(declaredLength),
            maxBytes: DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES,
        };
    }
    if (!response.body) return { ok: true as const, text: "", bytes: 0 };

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES) {
                await reader.cancel().catch(() => undefined);
                return {
                    ok: false as const,
                    error: "appium-response-too-large",
                    receivedBytes: total,
                    maxBytes: DEVICE_BROKER_APPIUM_RESPONSE_LIMIT_BYTES,
                };
            }
            chunks.push(Buffer.from(value));
        }
        return { ok: true as const, text: Buffer.concat(chunks, total).toString("utf8"), bytes: total };
    } finally {
        reader.releaseLock();
    }
}

async function fetchAppiumJson(url: string, options: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(DEVICE_BROKER_APPIUM_FETCH_MAX_TIMEOUT_MS, Math.max(1, options.timeoutMs || DEVICE_BROKER_COMMAND_TIMEOUT_MS)));
    try {
        const response = await fetch(url, {
            method: options.method || "GET",
            signal: controller.signal,
            redirect: "manual",
            headers: options.body === undefined ? undefined : { "content-type": "application/json" },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => undefined);
            return {
                ok: false,
                status: response.status,
                body: { error: "appium-redirect-disallowed" },
            };
        }
        const bounded = await readBoundedAppiumResponse(response);
        if (!bounded.ok) {
            return {
                ok: false,
                status: response.status,
                body: bounded,
            };
        }
        const text = bounded.text;
        let body: unknown = null;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = { raw: truncateOutput(text, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT) };
        }
        return { ok: response.ok, status: response.status, body };
    } catch (error) {
        return {
            ok: false,
            status: null,
            body: {
                error: error instanceof Error && error.name === "AbortError" ? "timeout" : error instanceof Error ? error.message : String(error),
            },
        };
    } finally {
        clearTimeout(timer);
    }
}

export function appiumWebDriverRequestTimeoutMs(commandTimeoutMs: number) {
    return Math.min(
        DEVICE_BROKER_APPIUM_FETCH_MAX_TIMEOUT_MS,
        Math.max(DEVICE_BROKER_APPIUM_REQUEST_TIMEOUT_MS, Number.isFinite(commandTimeoutMs) ? commandTimeoutMs : 0),
    );
}

async function waitForAppiumServerReady(serverUrl: string, timeoutMs = DEVICE_BROKER_APPIUM_READY_TIMEOUT_MS) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let response: Awaited<ReturnType<typeof fetchAppiumJson>> | null = null;
    while (Date.now() <= deadline) {
        const remainingMs = Math.max(1, deadline - Date.now());
        response = await fetchAppiumJson(`${serverUrl}/status`, {
            method: "GET",
            timeoutMs: Math.min(2000, remainingMs),
        });
        const body = response.body as { value?: { ready?: unknown } } | null;
        if (response.ok && body?.value?.ready !== false) return { ok: true, response };
        if (Date.now() < deadline) await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
    }
    return { ok: false, response };
}

function brokerOwnedAppiumPid(appium: unknown) {
    if (!appium || typeof appium !== "object") return null;
    const metadata = appium as { authority?: unknown; serverPid?: unknown; processOwner?: unknown; startedBy?: unknown };
    if (metadata.authority !== "host-broker"
        || metadata.processOwner !== "host-broker"
        || metadata.startedBy !== "broker.appium.start") return null;
    return typeof metadata.serverPid === "number" && Number.isInteger(metadata.serverPid) && metadata.serverPid > 0
        ? metadata.serverPid
        : null;
}

function claimsBrokerOwnedAppiumRuntime(appium: unknown) {
    if (!appium || typeof appium !== "object" || Array.isArray(appium)) return false;
    const metadata = appium as { authority?: unknown; processOwner?: unknown; startedBy?: unknown };
    return metadata.authority === "host-broker"
        && metadata.processOwner === "host-broker"
        && metadata.startedBy === "broker.appium.start";
}

function brokerOwnedAppiumEndpoint(appium: unknown) {
    if (!appium || typeof appium !== "object" || Array.isArray(appium)) {
        return { ok: false as const, error: "appium-runtime-metadata-incomplete" };
    }
    const metadata = appium as { authority?: unknown; serverUrl?: unknown; port?: unknown; processOwner?: unknown; startedBy?: unknown };
    if (metadata.authority !== "host-broker"
        || metadata.processOwner !== "host-broker"
        || metadata.startedBy !== "broker.appium.start"
        || typeof metadata.serverUrl !== "string") {
        return { ok: false as const, error: "appium-runtime-metadata-incomplete" };
    }

    // Broker-launched Appium always listens at the loopback origin root. Keeping this
    // grammar deliberately narrow rejects URL parser aliases, credentials, path
    // prefixes, query strings, and fragments before any host request is attempted.
    const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(metadata.serverUrl);
    if (!match) {
        return { ok: false as const, error: "appium-server-url-unsafe", serverUrl: metadata.serverUrl };
    }
    const urlPort = Number(match[1]);
    if (!Number.isInteger(urlPort) || urlPort <= 0 || urlPort > 65535) {
        return { ok: false as const, error: "appium-server-url-unsafe", serverUrl: metadata.serverUrl };
    }
    if (metadata.port !== undefined
        && (typeof metadata.port !== "number"
            || !Number.isInteger(metadata.port)
            || metadata.port !== urlPort)) {
        return {
            ok: false as const,
            error: "appium-server-url-port-mismatch",
            port: metadata.port,
            urlPort,
            serverUrl: metadata.serverUrl,
        };
    }
    return { ok: true as const, port: urlPort, serverUrl: `http://127.0.0.1:${urlPort}` };
}

function brokerLaunchedAppiumServerUrl(appium: unknown) {
    const endpoint = brokerOwnedAppiumEndpoint(appium);
    return endpoint.ok ? endpoint.serverUrl : null;
}

function brokerOwnedAppiumPort(appium: unknown) {
    const endpoint = brokerOwnedAppiumEndpoint(appium);
    return endpoint.ok ? endpoint.port : null;
}

function brokerOwnedAppiumRuntime(appium: unknown) {
    if (!appium || typeof appium !== "object" || Array.isArray(appium)) return null;
    const metadata = appium as Record<string, unknown>;
    const pid = brokerOwnedAppiumPid(metadata);
    if (!pid) return null;
    return {
        runtimeId: metadata.runtimeId,
        pid,
        processIdentity: metadata.processIdentity,
    };
}

function reusableBrokerOwnedAppium(appium: unknown, normalized: NormalizedBrokerOptions) {
    if (!appium || typeof appium !== "object") return false;
    const metadata = appium as { launchPolicy?: unknown };
    if (metadata.launchPolicy !== DEVICE_BROKER_APPIUM_LAUNCH_POLICY) return false;
    return liveBrokerOwnedAppiumRuntime(appium, normalized);
}

function liveBrokerOwnedAppiumRuntime(appium: unknown, normalized: NormalizedBrokerOptions) {
    const runtime = brokerOwnedAppiumRuntime(appium);
    if (!runtime) return false;
    if (!normalized.usesDefaultCommandRunner) return true;
    return inspectDeviceRuntimeProcessIdentity(runtime.processIdentity, runtime.pid).status === "match";
}

function verifyBrokerOwnedAppiumListener(appium: unknown, normalized: NormalizedBrokerOptions) {
    const runtime = brokerOwnedAppiumRuntime(appium);
    const endpoint = brokerOwnedAppiumEndpoint(appium);
    if (!endpoint.ok) return { ...endpoint, runtime };
    const { port, serverUrl } = endpoint;
    if (!normalized.strictAppiumPortOwnership) {
        return port && serverUrl
            ? { ok: true, runtime, port, serverUrl, simulated: true }
            : { ok: false, error: "appium-runtime-metadata-incomplete", port, serverUrl };
    }
    if (!runtime || !port || !serverUrl) {
        return { ok: false, error: "appium-runtime-metadata-incomplete", port, serverUrl };
    }
    if (typeof runtime.runtimeId !== "string" || runtime.runtimeId.length === 0 || !runtime.processIdentity) {
        return { ok: false, error: "appium-runtime-process-identity-missing", runtime, port, serverUrl };
    }
    const observation = inspectDeviceRuntimeProcessIdentity(runtime.processIdentity, runtime.pid);
    if (observation.status !== "match") {
        return {
            ok: false,
            error: observation.status === "mismatch"
                ? "appium-runtime-process-identity-mismatch"
                : "appium-runtime-process-identity-unavailable",
            runtime,
            port,
            serverUrl,
            observation,
        };
    }
    const listener = normalized.portProcessResolver(port, normalized.platform);
    if (!listener) {
        return { ok: false, error: "appium-port-listener-unavailable", runtime, port, serverUrl, observation };
    }
    if (listener.pid !== runtime.pid) {
        return {
            ok: false,
            error: "appium-port-listener-identity-mismatch",
            runtime,
            port,
            serverUrl,
            observation,
            listener,
        };
    }
    return { ok: true, runtime, port, serverUrl, observation, listener };
}

async function waitForBrokerOwnedAppiumListener(
    appium: unknown,
    normalized: NormalizedBrokerOptions,
    timeoutMs = DEVICE_BROKER_APPIUM_READY_TIMEOUT_MS,
) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let verification = verifyBrokerOwnedAppiumListener(appium, normalized);
    while (!verification.ok
        && verification.error === "appium-port-listener-unavailable"
        && Date.now() < deadline) {
        await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
        verification = verifyBrokerOwnedAppiumListener(appium, normalized);
    }
    return verification;
}

function selectAvailableAppiumPort(
    ownerId: string,
    backend: string,
    deviceId: string,
    params: unknown,
    record: Record<string, unknown>,
    normalized: NormalizedBrokerOptions,
) {
    const explicitPort = requestedAppiumPort(params);
    const preferredPort = explicitPort
        || (typeof record.appiumPort === "number" && Number.isInteger(record.appiumPort) && record.appiumPort > 0 && record.appiumPort <= 65535
            ? record.appiumPort
            : defaultAppiumPort(ownerId, backend, deviceId));
    if (!normalized.strictAppiumPortOwnership) {
        return { ok: true, port: preferredPort, attempts: [{ port: preferredPort, occupied: false, simulated: true }] };
    }
    const occupied = normalized.portProcessResolver(preferredPort, normalized.platform);
    if (!occupied) return { ok: true, port: preferredPort, attempts: [{ port: preferredPort, occupied: false }] };
    if (explicitPort) {
        return {
            ok: false,
            error: "appium-port-occupied",
            port: preferredPort,
            listener: occupied,
            attempts: [{ port: preferredPort, occupied: true }],
        };
    }
    const attempts = [{ port: preferredPort, occupied: true }];
    const start = preferredPort >= DEVICE_BROKER_APPIUM_AUTO_PORT_MIN && preferredPort <= DEVICE_BROKER_APPIUM_AUTO_PORT_MAX
        ? preferredPort
        : defaultAppiumPort(ownerId, backend, deviceId);
    const range = DEVICE_BROKER_APPIUM_AUTO_PORT_MAX - DEVICE_BROKER_APPIUM_AUTO_PORT_MIN + 1;
    for (let offset = 1; offset < DEVICE_BROKER_APPIUM_PORT_SCAN_LIMIT; offset += 1) {
        const port = DEVICE_BROKER_APPIUM_AUTO_PORT_MIN
            + ((start - DEVICE_BROKER_APPIUM_AUTO_PORT_MIN + offset) % range);
        const listener = normalized.portProcessResolver(port, normalized.platform);
        attempts.push({ port, occupied: Boolean(listener) });
        if (!listener) return { ok: true, port, attempts };
    }
    return { ok: false, error: "appium-port-range-exhausted", port: preferredPort, listener: occupied, attempts };
}

export function windowsProcessTreeOutcome(status: number | null, output: string, aliveAfter: boolean) {
    const stale = !aliveAfter || /not found|no running instance|not recognized/i.test(output);
    return {
        ok: status === 0 || stale,
        stale,
    };
}

function terminateWindowsProcessTree(
    pid: number,
    expectedIdentity?: DeviceRuntimeProcessIdentity,
    forceTreeAttempt = false,
    expectedStartToken?: string,
) {
    if (expectedIdentity) {
        const observation = inspectDeviceRuntimeProcessIdentity(expectedIdentity, pid);
        if (observation.status === "exited" && !forceTreeAttempt) {
            return {
                attempted: false,
                ok: true,
                stale: true,
                pid,
                signal: "SIGTERM" as const,
                status: null,
                observation,
                error: undefined,
            };
        }
        if (observation.status !== "match") {
            return {
                attempted: false,
                ok: false,
                stale: false,
                pid,
                signal: "SIGTERM" as const,
                status: null,
                observation,
                error: observation.status === "mismatch"
                    ? "runtime-process-identity-mismatch"
                    : "runtime-process-identity-unavailable",
            };
        }
    }
    if (!forceTreeAttempt && !processIsAlive(pid)) {
        return {
            attempted: false,
            ok: true,
            stale: true,
            pid,
            signal: "SIGTERM" as const,
            status: null,
            error: undefined,
        };
    }
    if (expectedStartToken && readDeviceRuntimeProcessStartToken(pid, { platform: "win32" }) !== expectedStartToken) {
        return {
            attempted: false,
            ok: false,
            stale: false,
            pid,
            signal: "SIGTERM" as const,
            status: null,
            error: "runtime-process-start-token-mismatch",
        };
    }
    const startToken = expectedStartToken || expectedIdentity?.startToken;
    if (!startToken) {
        return {
            attempted: false,
            ok: false,
            stale: false,
            pid,
            signal: "SIGTERM" as const,
            status: null,
            error: "runtime-process-start-token-unavailable",
        };
    }
    const result = terminateWindowsProcessByStartToken(pid, startToken);
    return {
        attempted: true,
        ok: result.ok,
        stale: !processIsAlive(pid),
        pid,
        signal: "SIGTERM" as const,
        status: result.status,
        error: result.ok ? undefined : result.reason || result.error || `process handle termination exited ${result.status}`,
    };
}

export type BrokerProcessTreeCleanup = {
    attempted: boolean;
    ok: boolean;
    stale?: boolean;
    pid: number;
    signal: "SIGKILL";
    platform: NodeJS.Platform;
    error?: string;
};

type BrokerProcessTreeCleanupOptions = {
    platform?: NodeJS.Platform;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    terminateWindowsTree?: (pid: number) => { attempted?: boolean; ok: boolean; stale?: boolean; error?: string };
    expectedIdentity?: DeviceRuntimeProcessIdentity | null;
    readIdentity?: (pid: number) => DeviceRuntimeProcessIdentity | null;
    requireIdentity?: boolean;
};

/** Terminates a process tree whose root was spawned by this broker invocation. */
export function terminateBrokerSpawnedProcessTree(
    pid: unknown,
    options: BrokerProcessTreeCleanupOptions = {},
): BrokerProcessTreeCleanup {
    const platform = options.platform || process.platform;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        return { attempted: false, ok: false, pid: 0, signal: "SIGKILL", platform, error: "spawned-process-pid-missing" };
    }
    if (options.requireIdentity) {
        if (!options.expectedIdentity) {
            return { attempted: false, ok: false, pid, signal: "SIGKILL", platform, error: "spawned-process-identity-missing" };
        }
        const observation = inspectDeviceRuntimeProcessIdentity(options.expectedIdentity, pid, {
            platform,
            ...(options.readIdentity ? { readIdentity: options.readIdentity } : {}),
        });
        if (observation.status === "exited") {
            return { attempted: false, ok: true, stale: true, pid, signal: "SIGKILL", platform };
        }
        if (observation.status !== "match") {
            return {
                attempted: false,
                ok: false,
                pid,
                signal: "SIGKILL",
                platform,
                error: observation.status === "mismatch"
                    ? "spawned-process-identity-mismatch"
                    : "spawned-process-identity-unavailable",
            };
        }
    }
    if (platform === "win32") {
        const outcome = (options.terminateWindowsTree || ((value: number) => terminateWindowsProcessTree(
            value,
            options.expectedIdentity || undefined,
            true,
            options.expectedIdentity?.startToken,
        )))(pid);
        return {
            attempted: outcome.attempted !== false,
            ok: outcome.ok,
            ...(outcome.stale === true ? { stale: true } : {}),
            pid,
            signal: "SIGKILL",
            platform,
            ...(outcome.error ? { error: outcome.error } : {}),
        };
    }
    try {
        // Backend/provider wrappers are spawned as POSIX process-group leaders.
        (options.kill || process.kill)(-pid, "SIGKILL");
        return { attempted: true, ok: true, pid, signal: "SIGKILL", platform };
    } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : null;
        return {
            attempted: true,
            ok: code === "ESRCH",
            ...(code === "ESRCH" ? { stale: true } : {}),
            pid,
            signal: "SIGKILL",
            platform,
            ...(code === "ESRCH" ? {} : { error: error instanceof Error ? error.message : String(error) }),
        };
    }
}

function normalizedWindowsCommandLine(value: string) {
    return value.replace(/\\/g, "/").toLowerCase();
}

export function managedAppiumCommandLine(commandLine: string, packageRoot: string, runtimeRoot: string, _brokerMetadata = false) {
    const normalizedCommandLine = normalizedWindowsCommandLine(commandLine);
    const normalizedPackageRoot = normalizedWindowsCommandLine(packageRoot);
    const normalizedRuntimeRoot = normalizedWindowsCommandLine(runtimeRoot);
    const appiumCommand = /(?:^|[\/])appium(?:[\/]|\.cmd|\.js|\s)/i.test(normalizedCommandLine);
    const managedPath = normalizedCommandLine.includes(normalizedRuntimeRoot)
        || normalizedCommandLine.includes(`${normalizedPackageRoot}/node_modules/appium`)
        || normalizedCommandLine.includes(`${normalizedPackageRoot}/device-lab-mcp/node_modules/appium`);
    return appiumCommand && managedPath;
}

function terminateManagedAppiumPortListener(port: number, normalized: NormalizedBrokerOptions) {
    if (!normalized.strictAppiumPortOwnership) return { attempted: false, ok: true, simulated: true };
    const listener = normalized.portProcessResolver(port, normalized.platform);
    if (!listener) return { attempted: false, ok: true };
    return {
        attempted: false,
        ok: false,
        blocked: true,
        error: "appium-port-occupied-after-allocation",
        port,
        listener,
    };
}

function terminateBrokerOwnedAppium(appium: unknown, normalized?: NormalizedBrokerOptions) {
    const runtime = brokerOwnedAppiumRuntime(appium);
    if (!runtime) return { attempted: false, ok: true };
    if (normalized && !normalized.usesDefaultCommandRunner) {
        return { attempted: false, ok: true, simulated: true, reason: "injected-command-runner" };
    }
    if (typeof runtime.runtimeId !== "string" || !runtime.processIdentity) {
        const liveness = probeDeviceRuntimeProcessLiveness(runtime.pid);
        if (liveness === "exited") {
            return { attempted: false, ok: true, stale: true, reason: "runtime-process-exited" };
        }
        return {
            attempted: false,
            ok: false,
            reason: liveness === "alive" ? "runtime-process-identity-missing" : "runtime-process-identity-unavailable",
            liveness,
        };
    }
    const serverPid = runtime.pid;
    if (process.platform === "win32") {
        const port = brokerOwnedAppiumPort(appium);
        const listener = port ? discoverWindowsBrokerPortProcess(port) : null;
        const listenerIsManagedAppium = normalized && listener?.commandLine
            ? managedAppiumCommandLine(listener.commandLine, packageRootForBroker(normalized), brokerAppiumRuntimeRoot())
            : false;
        const separateManagedListener = listenerIsManagedAppium && listener && listener.pid !== serverPid ? listener : null;
        const listenerIdentity = separateManagedListener
            ? readDeviceRuntimeProcessIdentity(separateManagedListener.pid)
            : null;
        if (separateManagedListener && !listenerIdentity) {
            return {
                attempted: false,
                ok: false,
                error: "appium-listener-process-identity-unavailable",
                listener: separateManagedListener,
                listenerPort: port,
            };
        }
        const processTree = terminateWindowsProcessTree(serverPid, runtime.processIdentity as DeviceRuntimeProcessIdentity);
        if (!processTree.ok) return processTree;
        const listenerTree = listenerIdentity && separateManagedListener
            ? terminateWindowsProcessTree(separateManagedListener.pid, listenerIdentity)
            : null;
        return {
            ...processTree,
            ok: processTree.ok && (!listenerTree || listenerTree.ok),
            processTree,
            ...(listenerTree ? { listenerTree, listenerPort: port } : {}),
        };
    }
    return signalDeviceRuntimeProcess(runtime, "SIGTERM");
}

async function terminateBrokerOwnedAppiumAndWait(appium: unknown, normalized: NormalizedBrokerOptions) {
    const pid = brokerOwnedAppiumPid(appium);
    const signal = terminateBrokerOwnedAppium(appium, normalized);
    if (!signal.ok) return { ...signal, exited: false, exitVerified: true };
    if (!pid || process.platform === "win32") {
        return { ...signal, exited: true, exitVerified: true };
    }
    if (!normalized.usesDefaultCommandRunner) {
        return { ...signal, exited: true, exitVerified: false };
    }
    if (await waitForProcessExit(pid, DEVICE_BROKER_RECORDING_STOP_TIMEOUT_MS)) {
        return { ...signal, exited: true, exitVerified: true };
    }
    const runtime = brokerOwnedAppiumRuntime(appium);
    const force = runtime ? signalDeviceRuntimeProcess(runtime, "SIGKILL") : { attempted: false, ok: false, reason: "runtime-process-metadata-missing" };
    const exited = force.ok && await waitForProcessExit(pid, 500);
    return {
        ...signal,
        ok: exited,
        exited,
        exitVerified: true,
        force,
        ...(!exited ? { error: force.error || "appium-process-still-running" } : {}),
    };
}

function signalBrokerOwnedRecording(recording: Record<string, unknown>, normalized: NormalizedBrokerOptions, signal: NodeJS.Signals) {
    const owned = recording.authority === "host-broker"
        && recording.processOwner === "host-broker"
        && recording.startedBy === "broker.device.recording.start";
    if (!owned) return { attempted: false, ok: false, reason: "recording-process-not-broker-owned" };
    if (!normalized.usesDefaultCommandRunner) {
        return { attempted: false, ok: true, simulated: true, reason: "injected-command-runner" };
    }
    return signalDeviceRuntimeProcess(recording, signal);
}

function deviceHasRuntimeMetadata(record: Record<string, unknown>) {
    return (record.appium !== undefined && record.appium !== null)
        || (record.recording !== undefined && record.recording !== null);
}

type PhysicalLeaseReleaseGuard = {
    attempted: boolean;
    parsed: LeaseParamSuccess | null;
    file: string | null;
    existing: Record<string, unknown> | null;
    preflight: BrokerRpcResult | null;
};

function withOwnerPhysicalLeaseReleaseGuard<T>(
    ownerId: string,
    stateKey: string,
    record: Record<string, unknown>,
    operation: (guard: PhysicalLeaseReleaseGuard) => T,
): T {
    const hardwareId = stateKey === "android-device"
        ? (typeof record.serial === "string" ? record.serial : "")
        : (typeof record.udid === "string" ? record.udid : "");
    if (!hardwareId) return operation({ attempted: false, parsed: null, file: null, existing: null, preflight: null });
    const parsed = validateLeaseParams({
        backend: stateKey,
        hardwareId,
        deviceId: record.id,
        claimId: record.leaseClaimId,
        claimNonce: record.leaseClaimNonce,
    }, "release");
    if (!parsed.ok) {
        return operation({ attempted: true, parsed: null, file: null, existing: null, preflight: leaseParamError(parsed) });
    }
    const file = physicalLeaseLockFile(parsed.backend, parsed.hardwareId);
    return withSharedMutationLock(physicalLeaseMutationLockFile(parsed.backend, parsed.hardwareId), () => {
        const existing = readLeaseFile(file, parsed.backend, parsed.hardwareId);
        return operation({
            attempted: true,
            parsed,
            file,
            existing,
            preflight: physicalLeaseReleaseConflict(ownerId, parsed, existing),
        });
    });
}

function cleanupOwnerPhysicalLease(ownerId: string, guard: PhysicalLeaseReleaseGuard) {
    if (guard.preflight && guard.preflight.status !== 404) {
        return { attempted: guard.attempted, ok: false, status: guard.preflight.status, payload: guard.preflight.payload };
    }
    if (!guard.attempted || !guard.parsed || !guard.file || !guard.existing) {
        return {
            attempted: guard.attempted,
            ok: true,
            ...(guard.preflight ? { status: guard.preflight.status, payload: guard.preflight.payload } : {}),
        };
    }
    const released = completePhysicalBrokerLeaseRelease(ownerId, guard.parsed, guard.file, guard.existing);
    return { attempted: true, ok: true, status: released.status, payload: released.payload };
}

function shouldStopOwnerDevice(stateKey: string, status: unknown) {
    if (stateKey === "android-device" || stateKey === "ios-device") return false;
    return ["running", "booted", "started", "starting"].includes(String(status || "").toLowerCase());
}

function cleanupOwnerDeviceRuntime(
    ownerId: string,
    stateKey: string,
    device: unknown,
    normalized: NormalizedBrokerOptions,
    options: { stopDevices: boolean; detachPhysical: boolean },
    physicalLeaseGuard?: PhysicalLeaseReleaseGuard,
): { device: unknown; changed: boolean; result: Record<string, unknown> } {
    if (!device || typeof device !== "object" || Array.isArray(device)) {
        return { device, changed: false, result: { skipped: true, reason: "invalid-device-record" } };
    }
    const record = device as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const backend = DEVICE_BROKER_STATE_BACKENDS.get(stateKey) || stateKey;
    const result: Record<string, unknown> = { stateKey, backend, deviceId: id, changed: false };
    const physical = stateKey === "android-device" || stateKey === "ios-device";
    if (physical && options.detachPhysical && !physicalLeaseGuard) {
        return withOwnerPhysicalLeaseReleaseGuard(ownerId, stateKey, record, (guard) => cleanupOwnerDeviceRuntime(ownerId, stateKey, record, normalized, options, guard));
    }
    if (physicalLeaseGuard?.preflight && physicalLeaseGuard.preflight.status !== 404) {
        result.physical = {
            detached: false,
            poweredOff: false,
            disconnected: false,
            lease: cleanupOwnerPhysicalLease(ownerId, physicalLeaseGuard),
        };
        return { device, changed: false, result };
    }
    let updated = { ...record };
    let changed = false;

    if (record.appium !== undefined && record.appium !== null) {
        const signal = terminateBrokerOwnedAppium(record.appium, normalized);
        const cleared = signal.ok;
        if (cleared) {
            updated.appium = null;
            changed = true;
        }
        result.appium = { cleared, signal };
    }

    if (record.recording !== undefined && record.recording !== null) {
        const recording = record.recording && typeof record.recording === "object" ? record.recording as Record<string, unknown> : {};
        const signal = signalBrokerOwnedRecording(recording, normalized, "SIGINT");
        const cleared = signal.ok;
        if (cleared) {
            updated.recording = null;
            changed = true;
        }
        result.recording = { cleared, signal };
    }

    if ((stateKey === "android-device" || stateKey === "ios-device") && options.detachPhysical) {
        const lease = cleanupOwnerPhysicalLease(ownerId, physicalLeaseGuard!);
        if (lease.ok && updated.status !== "detached") {
            updated.status = "detached";
            changed = true;
        }
        result.physical = { detached: lease.ok, poweredOff: false, disconnected: false, lease };
    } else if (options.stopDevices && id && shouldStopOwnerDevice(stateKey, record.status)) {
        const parsed = { ok: true as const, backend, stateKey, command: "device_stop", deviceId: id, force: true, dryRun: false };
        const providerCommand = providerCommandFor(ownerId, parsed, record, normalized);
        if ("error" in providerCommand) {
            result.stop = { attempted: false, ok: false, error: providerCommand.error, missing: providerCommand.missing };
        } else {
            const execution = normalized.commandRunner(providerCommand, {
                timeoutMs: normalized.commandTimeoutMs,
                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
            });
            const ok = commandSucceeded(execution);
            result.stop = { attempted: true, ok, execution };
            if (ok) {
                updated.status = "stopped";
                if (stateKey === "windows") releaseBrokerWindowsSandboxLock(ownerId, record, providerCommand.sandboxId);
                changed = true;
            }
        }
    }

    if (changed) updated.updatedAt = new Date().toISOString();
    result.changed = changed;
    if (!changed && !deviceHasRuntimeMetadata(record)) result.skipped = true;
    return { device: changed ? updated : device, changed, result };
}

async function cleanupOwnerRuntime(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const input = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
    const stopDevices = input.stopDevices !== false;
    const detachPhysical = input.detachPhysical !== false;
    const backendFilter = typeof input.backend === "string"
        ? DEVICE_BROKER_BACKEND_STATE_KEYS.includes(input.backend) ? input.backend : DEVICE_BROKER_COMMAND_BACKENDS.get(input.backend)
        : null;
    if (input.backend !== undefined && !backendFilter) {
        return { status: 400, payload: { ok: false, error: "invalid-cleanup-backend", allowed: [...DEVICE_BROKER_BACKEND_STATE_KEYS, ...DEVICE_BROKER_COMMAND_BACKENDS.keys()] } };
    }
    const stateKeys = backendFilter ? [backendFilter] : DEVICE_BROKER_BACKEND_STATE_KEYS;
    const results = [];
    let changedDevices = 0;
    let failed = 0;
    for (const stateKey of stateKeys) {
        let backendChanged = false;
        const deviceResults: unknown[] = [];
        let observedDevices: unknown[];
        try {
            observedDevices = readOwnerDevices(ownerId, stateKey);
        } catch (error) {
            failed += 1;
            results.push({
                stateKey,
                ok: false,
                error: ownerDeviceStateErrorCode(error) || "owner-devices-state-mutation-failed",
            });
            continue;
        }
        for (const observedDevice of observedDevices) {
            const deviceId = observedDevice && typeof observedDevice === "object" && !Array.isArray(observedDevice)
                ? (observedDevice as { id?: unknown }).id
                : null;
            if (typeof deviceId !== "string" || !deviceId) {
                const cleanup = cleanupOwnerDeviceRuntime(ownerId, stateKey, observedDevice, normalized, { stopDevices, detachPhysical });
                deviceResults.push(cleanup.result);
                continue;
            }
            try {
                const cleanup = await withOwnerDeviceOperation(ownerId, stateKey, deviceId, () => {
                    const latest = readOwnerDevices(ownerId, stateKey).find((candidate) => {
                        return candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as { id?: unknown }).id === deviceId;
                    });
                    if (!latest) {
                        return { changed: false, result: { stateKey, backend: DEVICE_BROKER_STATE_BACKENDS.get(stateKey) || stateKey, deviceId, skipped: true, reason: "device-no-longer-present" } };
                    }
                    const cleanupAndPersist = (guard?: PhysicalLeaseReleaseGuard) => {
                        const runtimeCleanup = cleanupOwnerDeviceRuntime(ownerId, stateKey, latest, normalized, { stopDevices, detachPhysical }, guard);
                        let persisted = !runtimeCleanup.changed;
                        let stateConflict = false;
                        if (runtimeCleanup.changed) {
                            try {
                                mutateOwnerDevices(ownerId, stateKey, (devices) => devices.map((candidate) => {
                                    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || (candidate as { id?: unknown }).id !== deviceId) return candidate;
                                    if (!isDeepStrictEqual(candidate, latest)) {
                                        stateConflict = true;
                                        return candidate;
                                    }
                                    persisted = true;
                                    return runtimeCleanup.device;
                                }));
                            } catch (error) {
                                const physicalLease = (runtimeCleanup.result.physical as { lease?: { status?: number } } | undefined)?.lease;
                                const releasedLease = guard?.parsed && guard.file && guard.existing && physicalLease?.status === 200;
                                const leaseRollback = releasedLease
                                    ? restorePhysicalBrokerLeaseRelease(ownerId, guard.parsed!, guard.file!, guard.existing!)
                                    : { attempted: false, ok: true };
                                return {
                                    changed: false,
                                    result: {
                                        ...(runtimeCleanup.result as Record<string, unknown>),
                                        stateWrite: {
                                            ok: false,
                                            error: leaseRollback.ok ? "owner-state-write-failed" : "physical-lease-rollback-failed",
                                            detail: error instanceof Error ? error.message : String(error),
                                            leaseRollback,
                                        },
                                    },
                                };
                            }
                        }
                        return {
                            changed: runtimeCleanup.changed && persisted,
                            result: {
                                ...(runtimeCleanup.result as Record<string, unknown>),
                                ...(stateConflict || !persisted ? { stateConflict: true } : {}),
                            },
                        };
                    };
                    const physical = stateKey === "android-device" || stateKey === "ios-device";
                    return physical && detachPhysical
                        ? withOwnerPhysicalLeaseReleaseGuard(ownerId, stateKey, latest as Record<string, unknown>, cleanupAndPersist)
                        : cleanupAndPersist();
                });
                if (cleanup.changed) {
                    backendChanged = true;
                    changedDevices += 1;
                }
                deviceResults.push(cleanup.result);
                const outcome = cleanup.result as { stateConflict?: boolean; stateWrite?: { ok?: boolean }; stop?: { ok?: boolean; attempted?: boolean }; appium?: { signal?: { ok?: boolean; attempted?: boolean } }; recording?: { signal?: { ok?: boolean; attempted?: boolean } }; physical?: { lease?: { ok?: boolean; attempted?: boolean } } };
                if (outcome.stateConflict) failed += 1;
                if (outcome.stateWrite && !outcome.stateWrite.ok) failed += 1;
                if (outcome.stop?.attempted && !outcome.stop.ok) failed += 1;
                if (outcome.appium?.signal?.attempted && !outcome.appium.signal.ok) failed += 1;
                if (outcome.recording?.signal && !outcome.recording.signal.ok) failed += 1;
                if (outcome.physical?.lease?.attempted && !outcome.physical.lease.ok) failed += 1;
            } catch (error) {
                if (!isDeviceOperationLockTimeout(error)) throw error;
                failed += 1;
                deviceResults.push({
                    stateKey,
                    backend: DEVICE_BROKER_STATE_BACKENDS.get(stateKey) || stateKey,
                    deviceId,
                    changed: false,
                    error: "device-operation-lock-failed",
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        }
        results.push({ stateKey, ok: true, changed: backendChanged, devices: deviceResults });
    }
    return {
        status: 200,
        payload: {
            ok: failed === 0,
            result: {
                ownerId,
                cleaned: true,
                stopDevices,
                detachPhysical,
                changedDevices,
                failed,
                results,
                authority: "host-broker",
            },
        },
    };
}

function validateAppiumListParams(params: unknown): AppiumParamError | AppiumListParamSuccess {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-appium-params" };
    }
    const input = params as Record<string, unknown>;
    const backend = typeof input.backend === "string" ? input.backend : "";
    const stateKey = DEVICE_BROKER_APPIUM_BACKENDS.get(backend);
    if (!stateKey) {
        return { ok: false, status: 400, error: "invalid-appium-backend", allowed: [...DEVICE_BROKER_APPIUM_BACKENDS.keys()] };
    }
    return { ok: true, backend, stateKey };
}

function appiumParamError(parsed: AppiumParamError) {
    return {
        status: parsed.status,
        payload: {
            ok: false,
            error: parsed.error,
            ...(parsed.allowed ? { allowed: parsed.allowed } : {}),
        },
    };
}

function stringMetadataField(input: Record<string, unknown>, name: string, maxLength: number) {
    const value = input[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f]/.test(trimmed)) return null;
    return trimmed;
}

function numberMetadataField(input: Record<string, unknown>, name: string, min: number, max: number) {
    const value = input[name];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return null;
    return value;
}

function appiumMetadata(params: unknown): AppiumMetadataResult {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { ok: false, status: 400, error: "invalid-appium-params" };
    }
    const root = params as Record<string, unknown>;
    const nested = root.appium && typeof root.appium === "object" && !Array.isArray(root.appium)
        ? root.appium as Record<string, unknown>
        : null;
    const input = nested ? { ...root, ...nested } : root;
    const serverUrl = stringMetadataField(input, "serverUrl", 2048);
    if (serverUrl === null) return { ok: false, status: 400, error: "invalid-appium-server-url" };
    if (serverUrl !== undefined) {
        try {
            const parsed = new URL(serverUrl);
            if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, status: 400, error: "invalid-appium-server-url" };
        } catch {
            return { ok: false, status: 400, error: "invalid-appium-server-url" };
        }
    }
    const sessionId = stringMetadataField(input, "sessionId", 512);
    if (sessionId === null) return { ok: false, status: 400, error: "invalid-appium-session-id" };
    const automationName = stringMetadataField(input, "automationName", 128);
    if (automationName === null) return { ok: false, status: 400, error: "invalid-appium-automation-name" };
    const provider = stringMetadataField(input, "provider", 128);
    if (provider === null) return { ok: false, status: 400, error: "invalid-appium-provider" };
    const serverPid = numberMetadataField(input, "serverPid", 1, Number.MAX_SAFE_INTEGER);
    if (serverPid === null) return { ok: false, status: 400, error: "invalid-appium-server-pid" };
    const port = numberMetadataField(input, "port", 1, 65535);
    if (port === null) return { ok: false, status: 400, error: "invalid-appium-port" };
    const physical = input.physical;
    if (physical !== undefined && typeof physical !== "boolean") {
        return { ok: false, status: 400, error: "invalid-appium-physical" };
    }
    const metadata: Record<string, unknown> = {
        authority: "host-broker",
        runtimeId: randomBytes(16).toString("hex"),
        updatedAt: new Date().toISOString(),
    };
    if (serverUrl !== undefined) metadata.serverUrl = serverUrl;
    if (sessionId !== undefined) metadata.sessionId = sessionId;
    if (automationName !== undefined) metadata.automationName = automationName;
    if (provider !== undefined) metadata.provider = provider;
    if (serverPid !== undefined) metadata.serverPid = serverPid;
    if (port !== undefined) metadata.port = port;
    if (physical !== undefined) metadata.physical = physical;
    if (!metadata.serverUrl && !metadata.sessionId && !metadata.serverPid && !metadata.port) {
        return { ok: false, status: 400, error: "missing-appium-metadata" };
    }
    return { ok: true, appium: metadata };
}

function field(device: unknown, name: string): string | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "string" && value ? value : null;
}

function numberField(device: unknown, name: string): number | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(device: unknown, name: string): boolean | null {
    if (!device || typeof device !== "object") return null;
    const value = (device as Record<string, unknown>)[name];
    return typeof value === "boolean" ? value : null;
}

function executableFor(provider: string, normalized: NormalizedBrokerOptions) {
    return providerExecutable(provider, normalized) || provider;
}

function isGuid(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function randomGuid(): string {
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function androidSerial(device: unknown) {
    return field(device, "serial") || (numberField(device, "port") ? `emulator-${numberField(device, "port")}` : null);
}

function androidEmulatorHeadlessArgs(parsed: CommandParamSuccess, device: unknown): string[] {
    const deviceHeadless = device && typeof device === "object" ? (device as Record<string, unknown>).headless : undefined;
    const headless = typeof parsed.headless === "boolean"
        ? parsed.headless
        : deviceHeadless !== false;
    return headless ? ["-no-window", "-no-audio"] : [];
}

const ANDROID_EMULATOR_NETSIM_NO_UI_ARGS = ["-netsim-args", "--no-cli-ui --no-web-ui"];

function androidEmulatorStartArgs(parsed: CommandParamSuccess, device: unknown): string[] {
    return [...androidEmulatorHeadlessArgs(parsed, device), ...ANDROID_EMULATOR_NETSIM_NO_UI_ARGS];
}

function brokerAndroidAvdPrefix(ownerId: string): string {
    return `ccc-${ownerId}-`;
}

function brokerAndroidAvdName(ownerId: string, create: Record<string, unknown>, fallbackName: string): string {
    return typeof create.avdName === "string" && create.avdName
        ? create.avdName
        : `${brokerAndroidAvdPrefix(ownerId)}${brokerSlug(fallbackName)}`;
}

function hyperVImageRoot(): string {
    return hyperVImageStoreRoot(brokerPrivateRoot());
}

function readHyperVImageManifestMetadata(profile: HyperVImageProfile) {
    return readHyperVImageManifestMetadataFromStore(brokerPrivateRoot(), profile);
}

function resolveHyperVImageForCreate(
    ownerId: string,
    parsed: CommandParamSuccess,
    params: unknown,
    normalized: NormalizedBrokerOptions,
    deadlineAt = Number.POSITIVE_INFINITY,
) {
    return resolveHyperVImageForCreateFromStore(ownerId, parsed, params, {
        cwd: normalized.cwd,
        privateRoot: brokerPrivateRoot(),
        resolveExecutable: (name) => providerExecutable(name, normalized),
        run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
        limits: {
            acquireTimeoutMs: DEVICE_BROKER_HYPER_V_IMAGE_ACQUIRE_TIMEOUT_MS,
            prepareTimeoutMs: DEVICE_BROKER_HYPER_V_IMAGE_PREPARE_TIMEOUT_MS,
            lockWaitMs: DEVICE_BROKER_HYPER_V_IMAGE_LOCK_WAIT_MS,
            commandOutputBytes: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        },
    }, deadlineAt);
}

function hyperVNetworkStateRuntime(): HyperVNetworkStateRuntime {
    return {
        privateRoot: brokerPrivateRoot(),
        assertSafePath: assertNoSymlinkPathComponents,
    };
}

function hyperVNetworkRuntime(normalized: NormalizedBrokerOptions): HyperVNetworkRuntime {
    const readDevices = cachedHyperVOwnerDevicesReader(readOwnerDevices);
    return {
        ...hyperVNetworkStateRuntime(),
        resolveExecutable: (name) => providerExecutable(name, normalized),
        resolveElevationExecutable: hyperVElevationExecutable,
        run: (command, options) => hyperVProviderCommandRunner(normalized, command, options),
        commandOutputBytes: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        allocationReferenced: (allocation) => hyperVNetworkAllocationReferenced(allocation, readDevices),
    };
}

function ensureHyperVNetworkAllocation(
    ownerId: string,
    deviceId: string,
    incarnationId: string,
    normalized: NormalizedBrokerOptions,
    deadlineAt = Number.POSITIVE_INFINITY,
) {
    return ensureHyperVNetworkAllocationWithRuntime(
        hyperVNetworkRuntime(normalized),
        ownerId,
        deviceId,
        incarnationId,
        deadlineAt,
    );
}

function releaseHyperVNetworkAllocationAndCleanup(
    ownerId: string,
    deviceId: string,
    incarnationId: string | null | undefined,
    normalized: NormalizedBrokerOptions,
    deadlineAt = Number.POSITIVE_INFINITY,
) {
    return releaseHyperVNetworkAllocationAndCleanupWithRuntime(
        hyperVNetworkRuntime(normalized),
        ownerId,
        deviceId,
        incarnationId,
        deadlineAt,
    );
}

function validateHyperVLinuxSshHostIdentity(
    ownerId: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    expectedFingerprint: string,
): boolean {
    return validateHyperVLinuxSshHostIdentityWithRuntime(
        hyperVNetworkStateRuntime(),
        ownerId,
        deviceId,
        hostPublicKeyPath,
        knownHostsPath,
        networkAddress,
        expectedFingerprint,
    );
}

function adoptHyperVLinuxSshHostIdentity(
    ownerId: string,
    deviceId: string,
    observedKnownHostsPath: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    commitFingerprint?: (fingerprint: string) => boolean,
): { fingerprint: string } | null {
    return adoptHyperVLinuxSshHostIdentityWithRuntime(
        hyperVNetworkStateRuntime(),
        ownerId,
        deviceId,
        observedKnownHostsPath,
        hostPublicKeyPath,
        knownHostsPath,
        networkAddress,
        commitFingerprint,
    );
}

function persistHyperVLinuxSshHostIdentity(
    ownerId: string,
    stateKey: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    fingerprint: string,
): boolean {
    let persisted = false;
    mutateOwnerDevices(ownerId, stateKey, (devices) => devices.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || (candidate as { id?: unknown }).id !== deviceId) return candidate;
        const current = candidate as Record<string, unknown>;
        if (current.sshHostPublicKeyPath !== hostPublicKeyPath
            || current.sshKnownHostsPath !== knownHostsPath
            || current.networkAddress !== networkAddress
            || !validateHyperVLinuxSshHostIdentity(
                ownerId,
                deviceId,
                hostPublicKeyPath,
                knownHostsPath,
                networkAddress,
                fingerprint,
            )) return candidate;
        persisted = true;
        return {
            ...current,
            sshHostKeyFingerprint: fingerprint,
            sshHostKeySource: "authenticated-bootstrap",
            updatedAt: new Date().toISOString(),
        };
    }));
    return persisted;
}

function reconcileHyperVLinuxSshHostIdentity(
    ownerId: string,
    stateKey: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
): { fingerprint: string } | null {
    return reconcileHyperVLinuxSshHostIdentityWithRuntime(
        hyperVNetworkStateRuntime(),
        ownerId,
        deviceId,
        hostPublicKeyPath,
        knownHostsPath,
        networkAddress,
        (fingerprint) => persistHyperVLinuxSshHostIdentity(
            ownerId,
            stateKey,
            deviceId,
            hostPublicKeyPath,
            knownHostsPath,
            networkAddress,
            fingerprint,
        ),
    );
}

async function reconcileHyperVCreateResidue(ownerId: string, backend: string, deviceId: string, normalized: NormalizedBrokerOptions, deadlineAt = Number.POSITIVE_INFINITY, incarnationId?: string | null): Promise<
    | { ok: true; recoveredVm: boolean; removedDisk: boolean; releasedAddress: boolean }
    | { ok: false; status: number; error: string; detail?: string }> {
    const powershell = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
    if (!powershell) return { ok: false, status: 503, error: "missing-provider-command", detail: "powershell" };
    if (!isHyperVBackend(backend)) return { ok: false, status: 400, error: "hyper-v-backend-invalid" };
    const privateRoot = hyperVPrivateDeviceRoot(ownerId, backend, deviceId);
    let expectedIncarnationId = validHyperVIncarnationId(incarnationId) ? incarnationId : null;
    if (!expectedIncarnationId) {
        try {
            expectedIncarnationId = readHyperVIncarnationRecord(ownerId, backend, deviceId)?.incarnationId || null;
        } catch (error) {
            return {
                ok: false,
                status: 409,
                error: "hyper-v-incarnation-record-invalid",
                detail: hyperVBoundedErrorCode(
                    error,
                    "hyper-v-incarnation-record-invalid",
                ),
            };
        }
    }
    if (!expectedIncarnationId) {
        if (existsSync(privateRoot)) return { ok: false, status: 409, error: "hyper-v-incarnation-record-missing" };
        const allocation = await releaseHyperVNetworkAllocationAndCleanup(ownerId, deviceId, null, normalized, deadlineAt);
        return allocation.ok
            ? { ok: true, recoveredVm: false, removedDisk: false, releasedAddress: allocation.released }
            : {
                ok: false,
                status: 502,
                error: "hyper-v-recovery-cleanup-failed",
                detail: typeof allocation.error === "string"
                    && /^hyper-v-[a-z0-9-]{3,128}$/.test(allocation.error)
                    ? allocation.error
                    : "hyper-v-network-cleanup-failed",
            };
    }
    const deviceRoot = hyperVDeviceRoot(ownerId, backend, deviceId);
    const diskPath = join(deviceRoot, "disks", "root.vhdx");
    let command: ProviderCommand;
    try {
        command = hyperVRecoverOrphanCommand({
            executable: powershell,
            ownerId,
            deviceId,
            incarnationId: expectedIncarnationId,
            vmName: hyperVVmName(ownerId, deviceId, expectedIncarnationId),
            deviceRoot,
            diskPath,
            auxiliaryMediaPaths: [join(deviceRoot, "disks", backend === "linux-vm" ? "cidata.iso" : "autounattend.iso")],
        });
    } catch (error) {
        return {
            ok: false,
            status: 400,
            error: "hyper-v-recovery-plan-failed",
            detail: hyperVBoundedErrorCode(
                error,
                "hyper-v-recovery-plan-failed",
            ),
        };
    }
    const execution = await hyperVProviderCommandRunner(normalized, command, { timeoutMs: hyperVRemainingTimeout(deadlineAt, 120000), outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
    assertHyperVOperationDeadline(deadlineAt);
    if (!commandSucceeded(execution)) return { ok: false, status: 502, error: "hyper-v-recovery-failed", detail: hyperVProviderDiagnosticCode(execution, "hyper-v-recovery-failed") };
    const observation = parseHyperVRecoveryObservation(execution.stdout || "");
    if (!observation) return { ok: false, status: 502, error: "hyper-v-recovery-invalid-result" };
    const allocation = await releaseHyperVNetworkAllocationAndCleanup(ownerId, deviceId, expectedIncarnationId, normalized, deadlineAt);
    const artifacts = allocation.ok
        ? cleanupHyperVDeviceArtifacts(ownerId, backend, deviceId)
        : { ok: false, removed: false, error: "network-allocation-cleanup-failed" };
    if (!artifacts.ok || !allocation.ok) {
        return {
            ok: false,
            status: 502,
            error: "hyper-v-recovery-cleanup-failed",
            detail: !artifacts.ok
                ? "hyper-v-artifact-cleanup-failed"
                : typeof allocation.error === "string"
                    && /^hyper-v-[a-z0-9-]{3,128}$/.test(allocation.error)
                    ? allocation.error
                    : "hyper-v-network-cleanup-failed",
        };
    }
    return { ok: true, recoveredVm: observation.recoveredVm, removedDisk: observation.removedDisk, releasedAddress: allocation.released };
}

function hyperVOperationJournalPath(ownerId: string, backend: string, deviceId: string): string {
    return hyperVOperationJournalFilePath(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

function readHyperVOperationJournal(ownerId: string, backend: string, deviceId: string): HyperVOperationJournal | null {
    return readHyperVOperationJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

function writeHyperVOperationJournal(ownerId: string, parsed: CommandParamSuccess): { ok: true; path: string } | { ok: false; error: string } {
    return writeHyperVOperationJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        parsed,
    );
}

function clearHyperVOperationJournal(ownerId: string, backend: string, deviceId: string): void {
    clearHyperVOperationJournalFile(
        hyperVJournalPersistenceRuntime(),
        ownerId,
        backend,
        deviceId,
    );
}

async function reconcileHyperVOperation(ownerId: string, backend: string, deviceId: string, normalized: NormalizedBrokerOptions, deadlineAt = Number.POSITIVE_INFINITY): Promise<
    | { ok: true; reconciled: boolean }
    | { ok: false; status: number; error: string; detail?: string }> {
    let journal: HyperVOperationJournal | null;
    try {
        journal = readHyperVOperationJournal(ownerId, backend, deviceId);
    } catch (error) {
        return {
            ok: false,
            status: 409,
            error: "hyper-v-operation-journal-invalid",
            detail: hyperVBoundedErrorCode(error, "hyper-v-operation-journal-invalid"),
        };
    }
    if (!journal) return { ok: true, reconciled: false };
    const currentDevice = readOwnerDevices(ownerId, backend).find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === deviceId) as Record<string, unknown> | undefined;
    if (currentDevice && hyperVDeviceIncarnationId(currentDevice) !== journal.incarnationId) {
        return { ok: false, status: 409, error: "hyper-v-operation-incarnation-conflict" };
    }
    const powershell = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
    if (!powershell) return { ok: false, status: 503, error: "missing-provider-command", detail: "powershell" };
    const deviceRoot = hyperVDeviceRoot(ownerId, backend, deviceId);
    const base = {
        executable: powershell,
        ownerId,
        deviceId,
        incarnationId: journal.incarnationId,
        vmName: journal.vmName,
        vmId: journal.vmId,
        diskPath: journal.diskPath,
        auxiliaryMediaPaths: [join(deviceRoot, "disks", backend === "linux-vm" ? "cidata.iso" : "autounattend.iso")],
    };
    if (journal.command === "device_delete") {
        const execution = await hyperVProviderCommandRunner(normalized, hyperVDeleteCommand(base), { timeoutMs: hyperVRemainingTimeout(deadlineAt, 120000), outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
        assertHyperVOperationDeadline(deadlineAt);
        if (!commandSucceeded(execution)) return { ok: false, status: 502, error: "hyper-v-delete-reconciliation-failed", detail: hyperVProviderDiagnosticCode(execution, "hyper-v-delete-reconciliation-failed") };
        const observation = parseHyperVDeleteObservation(execution.stdout || "");
        if (!observation || observation.vmId !== journal.vmId || observation.vmName !== journal.vmName || resolve(observation.diskPath || "") !== resolve(journal.diskPath)) return { ok: false, status: 502, error: "hyper-v-delete-reconciliation-invalid-result" };
        const allocation = await releaseHyperVNetworkAllocationAndCleanup(ownerId, deviceId, journal.incarnationId, normalized, deadlineAt);
        const artifacts = allocation.ok
            ? cleanupHyperVDeviceArtifacts(ownerId, backend, deviceId)
            : { ok: false, removed: false, error: "network-allocation-cleanup-failed" };
        if (!artifacts.ok || !allocation.ok) {
            return {
                ok: false,
                status: 502,
                error: "hyper-v-delete-reconciliation-cleanup-failed",
                detail: [artifacts.ok ? null : `artifacts:${artifacts.error}`, allocation.ok ? null : `allocation:${allocation.error}`].filter(Boolean).join("; "),
            };
        }
        mutateOwnerDevices(ownerId, backend, (devices) => devices.filter((candidate) => !candidate || typeof candidate !== "object" || (candidate as Record<string, unknown>).id !== deviceId));
        return { ok: true, reconciled: true };
    }
    const execution = await hyperVProviderCommandRunner(normalized, hyperVStatusCommand(base), { timeoutMs: hyperVRemainingTimeout(deadlineAt, 30000), outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
    assertHyperVOperationDeadline(deadlineAt);
    if (!commandSucceeded(execution)) return { ok: false, status: 502, error: "hyper-v-state-reconciliation-failed", detail: hyperVProviderDiagnosticCode(execution, "hyper-v-state-reconciliation-failed") };
    const observation = parseHyperVVmObservation(execution.stdout || "");
    if (!observation || observation.vmId !== journal.vmId || observation.vmName !== journal.vmName || resolve(observation.diskPath || "") !== resolve(journal.diskPath)) return { ok: false, status: 502, error: "hyper-v-state-reconciliation-invalid-result" };
    const state = observation.state.toLowerCase();
    if (state !== "running" && state !== "off") return { ok: false, status: 409, error: "hyper-v-operation-still-transitioning", detail: observation.state };
    mutateOwnerDevices(ownerId, backend, (devices) => devices.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || (candidate as Record<string, unknown>).id !== deviceId) return candidate;
        return { ...(candidate as Record<string, unknown>), status: state === "running" ? "running" : "stopped", runtimeState: observation.state, hyperVStatus: observation.status, updatedAt: new Date().toISOString() };
    }));
    clearHyperVOperationJournal(ownerId, backend, deviceId);
    return { ok: true, reconciled: true };
}

function providerCommandForCreate(ownerId: string, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions): ProviderCommand | { error: string; missing: string[] } {
    const create = parsed.create || {};
    if (parsed.backend === "android-emulator" && create.createAvd === true) {
        const systemImage = typeof create.systemImage === "string" ? create.systemImage : null;
        if (!systemImage) return { error: "missing-provider-metadata", missing: ["systemImage"] };
        const name = String(create.name || parsed.deviceId);
        const avdName = brokerAndroidAvdName(ownerId, create, name);
        if (!ownedAndroidAvdName(avdName, ownerId)) {
            return { error: "android-avd-name-not-owner-scoped", missing: ["owner-prefixed avdName"] };
        }
        const avdmanager = executableFor("avdmanager", normalized);
        const args = ["create", "avd", "--name", avdName, "--package", systemImage, "--force"];
        if (typeof create.deviceProfile === "string" && create.deviceProfile) {
            args.push("--device", create.deviceProfile);
        }
        return { mode: "exec", provider: "avdmanager", executable: avdmanager, args, input: "no\n" };
    }
    if (parsed.backend === "ios-simulator" && create.createSimulator === true) {
        const name = String(create.name || parsed.deviceId);
        const simulatorName = typeof create.simulatorName === "string" && create.simulatorName
            ? create.simulatorName
            : `${brokerIosSimulatorPrefix(ownerId)}${brokerSlug(name)}`;
        return iosSimulatorCreateCommand({ simulatorName, ownerPrefix: brokerIosSimulatorPrefix(ownerId), deviceType: create.deviceType, runtime: create.runtime, executable: executableFor("xcrun", normalized) });
    }
    if (isHyperVBackend(parsed.backend)) {
        const linuxGuest = parsed.backend === "linux-vm";
        const image = typeof create.image === "string" && create.image ? create.image : null;
        if (!image) return { error: "hyper-v-base-image-not-prepared", missing: ["prepared image or sourceImage VHDX"] };
        const baseImageSha256 = typeof create.baseImageSha256 === "string" ? create.baseImageSha256 : null;
        if (!baseImageSha256) return { error: "hyper-v-base-image-hash-missing", missing: ["verified base image SHA-256"] };
        const baseImageGeneration = create.baseImageGeneration === 1 || create.baseImageGeneration === 2 ? create.baseImageGeneration : null;
        if (!baseImageGeneration) return { error: "hyper-v-base-image-generation-missing", missing: ["verified base image generation"] };
        const powershell = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
        if (!powershell) return { error: "missing-provider-command", missing: ["powershell"] };
        const globalBaseImageRoot = hyperVImageRoot();
        const ownerBaseImageRoot = join(brokerPrivateRoot(), "owners", ownerId, "images", "hyper-v");
        let baseImageRoot: string | null = null;
        try {
            for (const candidate of [ownerBaseImageRoot, globalBaseImageRoot]) {
                try {
                    assertDeviceLabPathWithinRoot(candidate, image, "hyper-v-base-image");
                    baseImageRoot = candidate;
                    break;
                } catch {
                    // Continue until the image is fenced by an accepted cache root.
                }
            }
            if (!baseImageRoot) throw new Error("hyper-v-base-image-outside-cache");
            const imageStat = lstatSync(image);
            if (!imageStat.isFile() || imageStat.isSymbolicLink()) throw new Error("hyper-v-base-image-invalid");
        } catch {
            return { error: "hyper-v-base-image-invalid", missing: [`regular VHDX below ${ownerBaseImageRoot} or ${globalBaseImageRoot}`] };
        }
        const deviceRoot = hyperVDeviceRoot(ownerId, parsed.backend, parsed.deviceId);
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        try {
            return hyperVCreateCommand({
                executable: powershell,
                ownerId,
                deviceId: parsed.deviceId,
                incarnationId: validHyperVIncarnationId(create.incarnationId)
                    ? create.incarnationId
                    : parsed.dryRun
                        ? "0".repeat(32)
                        : (() => { throw new Error("hyper-v-incarnation-id-invalid"); })(),
                vmName: hyperVVmName(ownerId, parsed.deviceId, validHyperVIncarnationId(create.incarnationId)
                    ? create.incarnationId
                    : parsed.dryRun
                        ? "0".repeat(32)
                        : (() => { throw new Error("hyper-v-incarnation-id-invalid"); })()),
                baseImagePath: image,
                baseImageSha256,
                baseImageGeneration,
                baseImageRoot: baseImageRoot!,
                deviceRoot,
                diskPath,
                memoryMb: typeof create.memoryMb === "number" ? create.memoryMb : 4096,
                cpus: typeof create.cpus === "number" ? create.cpus : 2,
                diskMaxBytes: typeof create.diskMaxBytes === "number" ? create.diskMaxBytes : 0,
                switchName: typeof create.switchName === "string" ? create.switchName : null,
                macAddress: typeof create.macAddress === "string" ? create.macAddress : null,
                networking: create.networking !== false,
                bootstrapDhcp: linuxGuest,
                ...hyperVSecureBootConfiguration(parsed.backend),
            });
        } catch (error) {
            return { error: error instanceof Error ? error.message : "invalid-hyper-v-create-options", missing: [] };
        }
    }
    if (parsed.backend === "macos-vm") {
        const provider = create.provider === "auto" || !create.provider ? "tart" : String(create.provider);
        if (!DEVICE_BROKER_MACOS_PROVIDERS.has(provider)) {
            return { error: "unsupported-provider-command", missing: ["provider"] };
        }
        if (provider !== "tart") return { mode: "noop", provider: "host-broker-state", reason: "device_create writes owner-scoped broker metadata" };
        const image = typeof create.image === "string" && create.image ? create.image : null;
        if (!image) return { mode: "noop", provider: "host-broker-state", reason: "macOS VM device_create without image writes owner-scoped broker metadata" };
        const target = typeof create.providerInstance === "string" && create.providerInstance
            ? create.providerInstance
            : `ccc-${ownerId}-${brokerSlug(parsed.deviceId)}`;
        return { mode: "exec", provider: "tart", executable: executableFor("tart", normalized), args: ["clone", image, target] };
    }
    return { mode: "noop", provider: "host-broker-state", reason: "device_create writes owner-scoped broker metadata" };
}

function brokerIosSimulatorPrefix(ownerId: string): string {
    return `ccc-${ownerId}-`;
}

function resolveBrokerOwnedIosSimulatorTarget(ownerId: string, device: unknown, normalized: NormalizedBrokerOptions) {
    const simulatorName = field(device, "simulatorName");
    const recordedUdid = field(device, "udid");
    if (!simulatorName || !simulatorName.startsWith(brokerIosSimulatorPrefix(ownerId))) {
        return { ok: false as const, error: "ios-simulator-not-owner-scoped", missing: ["owner-prefixed simulatorName"] };
    }
    const executable = executableFor("xcrun", normalized);
    const inventory = normalized.commandRunner({
        mode: "exec",
        provider: "xcrun",
        executable,
        args: ["simctl", "list", "devices", "-j"],
    }, {
        timeoutMs: Math.min(normalized.commandTimeoutMs, 30000),
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(inventory)) {
        return { ok: false as const, error: "ios-simulator-owner-inventory-unavailable", missing: ["readable simctl device inventory"], inventory };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(inventory.stdout || "{}");
    } catch {
        return { ok: false as const, error: "ios-simulator-owner-inventory-invalid", missing: ["valid simctl JSON device inventory"], inventory };
    }
    const groups = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && (parsed as { devices?: unknown }).devices && typeof (parsed as { devices?: unknown }).devices === "object"
        && !Array.isArray((parsed as { devices?: unknown }).devices)
        ? Object.values((parsed as { devices: Record<string, unknown> }).devices)
        : [];
    const simulators = groups.flatMap((group) => Array.isArray(group) ? group : [])
        .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate)));
    const matches = recordedUdid
        ? simulators.filter((candidate) => field(candidate, "udid") === recordedUdid)
        : simulators.filter((candidate) => field(candidate, "name") === simulatorName);
    if (matches.length !== 1) {
        return { ok: false as const, error: "ios-simulator-owner-identity-unverified", missing: ["exactly one matching host simulator"], matchCount: matches.length, inventory };
    }
    const hostName = field(matches[0], "name");
    const hostUdid = field(matches[0], "udid");
    if (hostName !== simulatorName || !hostName.startsWith(brokerIosSimulatorPrefix(ownerId)) || !hostUdid) {
        return { ok: false as const, error: "ios-simulator-owner-identity-mismatch", missing: ["matching owner-prefixed host simulator name and UDID"], hostName, hostUdid, inventory };
    }
    return { ok: true as const, target: hostUdid, simulatorName: hostName, inventory };
}

function providerCommandFor(ownerId: string, parsed: CommandParamSuccess, device: unknown, normalized: NormalizedBrokerOptions): ProviderCommand | { error: string; missing: string[] } {
    if (parsed.backend === "android-emulator") {
        const adb = executableFor("adb", normalized);
        const emulator = executableFor("emulator", normalized);
        const serial = androidSerial(device);
        const avdName = field(device, "avdName");
        if (parsed.command === "device_status") {
            if (!serial) return { error: "missing-provider-metadata", missing: ["serial or port"] };
            return { mode: "exec", provider: "adb", executable: adb, args: ["-s", serial, "get-state"] };
        }
        if (parsed.command === "device_stop") {
            if (!serial) return { error: "missing-provider-metadata", missing: ["serial or port"] };
            return { mode: "exec", provider: "adb", executable: adb, args: ["-s", serial, "emu", "kill"] };
        }
        if (parsed.command === "device_delete") {
            if (parsed.deleteAvd === false) {
                return { mode: "noop", provider: "host-broker-state", reason: "Android emulator deleteAvd=false deletes only owner broker metadata" };
            }
            if (!avdName) return { error: "missing-provider-metadata", missing: ["avdName"] };
            if (!ownedAndroidAvdName(avdName, ownerId)) {
                return { error: "android-avd-name-not-owner-scoped", missing: ["owner-prefixed avdName"] };
            }
            return {
                mode: "noop",
                provider: "host-broker-state",
                reason: "Owner-scoped Android AVD artifacts are removed through identity-fenced storage cleanup",
            };
        }
        if (!avdName) return { error: "missing-provider-metadata", missing: ["avdName"] };
        const port = numberField(device, "port");
        return {
            mode: "detached",
            provider: "emulator",
            executable: emulator,
            args: ["-avd", avdName, ...(port ? ["-port", String(port)] : []), ...androidEmulatorStartArgs(parsed, device)],
            windowsHiddenLauncher: true,
        };
    }

    if (parsed.backend === "android-device") {
        const serial = field(device, "serial");
        if ((parsed.command === "device_status" || parsed.command === "device_start") && serial) {
            return { mode: "exec", provider: "adb", executable: executableFor("adb", normalized), args: ["-s", serial, "get-state"] };
        }
        if (parsed.command === "device_status" || parsed.command === "device_start") return { error: "missing-provider-metadata", missing: ["serial"] };
        return { mode: "noop", provider: "android-device", reason: "physical Android stop/delete does not power off or disconnect the real device" };
    }

    if (parsed.backend === "ios-simulator") {
        const ownedTarget = resolveBrokerOwnedIosSimulatorTarget(ownerId, device, normalized);
        if (!ownedTarget.ok) return { error: ownedTarget.error, missing: ownedTarget.missing };
        const target = ownedTarget.target;
        const xcrun = executableFor("xcrun", normalized);
        if (parsed.command === "device_status") return { mode: "exec", provider: "xcrun", executable: xcrun, args: ["simctl", "list", "devices", target] };
        if (parsed.command === "device_start") return { mode: "exec", provider: "xcrun", executable: xcrun, args: ["simctl", "boot", target] };
        if (parsed.command === "device_stop") return { mode: "exec", provider: "xcrun", executable: xcrun, args: ["simctl", "shutdown", target] };
        return { mode: "exec", provider: "xcrun", executable: xcrun, args: ["simctl", "delete", target] };
    }

    if (parsed.backend === "ios-device") {
        const udid = field(device, "udid");
        if (parsed.command === "device_status" || parsed.command === "device_start") {
            if (!udid) return { error: "missing-provider-metadata", missing: ["udid"] };
            return { mode: "exec", provider: "xcrun", executable: executableFor("xcrun", normalized), args: ["devicectl", "device", "info", "details", "--device", udid] };
        }
        return { mode: "noop", provider: "ios-device", reason: "physical iOS stop/delete does not power off, erase, or disconnect the real device" };
    }

    if (parsed.backend === "windows-sandbox") {
        if (parsed.command === "device_status") {
            return { mode: "noop", provider: "wsb", reason: "Windows Sandbox status/delete is represented by owner state in this broker layer" };
        }
        const wsb = executableFor("wsb", normalized);
        if (parsed.command === "device_stop" || (parsed.command === "device_delete" && shouldStopOwnerDevice(parsed.stateKey, (device as { status?: unknown })?.status))) {
            const sandboxId = brokerWindowsSandboxIdForStop(ownerId, device);
            if (!isGuid(sandboxId)) return { error: "missing-provider-metadata", missing: ["sandboxId GUID"] };
            return { mode: "exec", provider: "wsb", executable: wsb, args: ["stop", "--id", sandboxId], sandboxId };
        }
        if (parsed.command === "device_delete") {
            return { mode: "noop", provider: "wsb", reason: "Stopped Windows Sandbox delete is represented by owner state in this broker layer" };
        }
        const recordedConfigPath = field(device, "configPath") || field(device, "wsbConfigPath");
        const configPath = recordedConfigPath || brokerWindowsConfigPath(ownerId, parsed.deviceId);
        const windowsRoot = join(brokerRoot(), "owners", ownerId, "windows");
        if (!pathWithin(windowsRoot, configPath)) return { error: "invalid-provider-metadata", missing: ["owner-scoped configPath"] };
        if (!recordedConfigPath) {
            try {
                lstatSync(configPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    return { error: "missing-provider-metadata", missing: ["configPath"] };
                }
                return { error: "invalid-provider-metadata", missing: ["owner-scoped configPath readable"] };
            }
        }
        let config: string;
        try {
            assertDeviceLabPathWithinRoot(windowsRoot, configPath, "windows-sandbox-config");
            const content = readDeviceLabTextFile(configPath, "windows-sandbox-config", DEVICE_BROKER_WINDOWS_CONFIG_LIMIT_BYTES);
            if (content === null) throw new Error("windows-sandbox-config-missing");
            config = content;
        } catch {
            return { error: "invalid-provider-metadata", missing: ["owner-scoped configPath readable"] };
        }
        const existingSandboxId = field(device, "sandboxId");
        const sandboxId = isGuid(existingSandboxId) ? existingSandboxId : randomGuid();
        const minimized = typeof parsed.minimized === "boolean"
            ? parsed.minimized
            : booleanField(device, "minimized") !== false;
        return {
            mode: "exec",
            provider: "wsb",
            executable: wsb,
            args: ["start", "--id", sandboxId, "--config", config],
            sandboxId,
            waitForExit: false,
            ...(minimized ? { windowStyle: "minimized" } : {}),
        };
    }

    if (isHyperVBackend(parsed.backend)) {
        const powershell = providerExecutable("powershell.exe", normalized) || providerExecutable("pwsh", normalized) || providerExecutable("powershell", normalized);
        if (!powershell) return { error: "missing-provider-command", missing: ["powershell"] };
        const vmName = field(device, "vmName");
        const vmId = field(device, "vmId");
        const diskPath = field(device, "diskPath");
        const incarnationId = device && typeof device === "object" && !Array.isArray(device)
            ? hyperVDeviceIncarnationId(device as Record<string, unknown>)
            : null;
        if (!vmName || !vmId || !incarnationId) return { error: "missing-provider-metadata", missing: ["vmName", "vmId", "incarnationId"] };
        const expectedVmName = hyperVVmName(ownerId, parsed.deviceId, incarnationId);
        const expectedDeviceRoot = hyperVDeviceRoot(ownerId, parsed.backend, parsed.deviceId);
        const expectedDiskPath = join(expectedDeviceRoot, "disks", "root.vhdx");
        if (vmName !== expectedVmName || (diskPath && resolve(diskPath) !== resolve(expectedDiskPath))) {
            return { error: "invalid-provider-metadata", missing: ["canonical owner-scoped Hyper-V VM name and disk path"] };
        }
        const options = { executable: powershell, ownerId, deviceId: parsed.deviceId, incarnationId, vmName, vmId, diskPath };
        try {
            if (parsed.command === "device_status") return hyperVStatusCommand(options);
            if (parsed.command === "device_start") return hyperVStartCommand({
                ...options,
                memoryMb: numberField(device, "memoryMb") || 4096,
                cpus: numberField(device, "cpus") || 2,
            });
            if (parsed.command === "device_stop") return hyperVStopCommand(options, parsed.force);
            if (parsed.command === "device_reboot") return hyperVRebootCommand({
                ...options,
                force: parsed.force,
                startIfStopped: parsed.startIfStopped,
            });
            if (!diskPath) return { error: "missing-provider-metadata", missing: ["diskPath"] };
            return hyperVDeleteCommand({
                ...options,
                diskPath,
                auxiliaryMediaPaths: [join(expectedDeviceRoot, "disks", parsed.backend === "linux-vm" ? "cidata.iso" : "autounattend.iso")],
            });
        } catch (error) {
            return { error: error instanceof Error ? error.message : "invalid-hyper-v-lifecycle-options", missing: [] };
        }
    }

    if (parsed.backend === "macos-vm") {
        const provider = field(device, "provider") === "auto" || !field(device, "provider") ? "tart" : field(device, "provider") || "tart";
        if (!DEVICE_BROKER_MACOS_PROVIDERS.has(provider)) {
            return { error: "unsupported-provider-command", missing: ["provider"] };
        }
        const instance = field(device, "providerInstance");
        if (parsed.command === "device_delete" && !instance && !shouldStopOwnerDevice(parsed.stateKey, (device as { status?: unknown })?.status)) {
            return { mode: "noop", provider: "host-broker-state", reason: "Stopped macOS VM delete without providerInstance deletes only owner broker metadata" };
        }
        if (!instance) return { error: "missing-provider-metadata", missing: ["providerInstance"] };
        const executable = executableFor(provider, normalized);
        if (parsed.command === "device_status") return { mode: "exec", provider, executable, args: provider === "tart" ? ["get", instance] : ["status", instance] };
        if (parsed.command === "device_start") {
            if (provider === "tart") {
                const headless = typeof parsed.headless === "boolean"
                    ? parsed.headless
                    : booleanField(device, "headless") === true;
                return { mode: "detached", provider, executable, args: ["run", ...(headless ? ["--no-graphics"] : []), instance] };
            }
            return { mode: "exec", provider, executable, args: ["start", instance] };
        }
        if (parsed.command === "device_stop") return { mode: "exec", provider, executable, args: ["stop", instance] };
        return { mode: "exec", provider, executable, args: ["delete", instance] };
    }

    return { error: "unsupported-provider-command", missing: [] };
}

function truncateOutput(value: unknown, limit: number) {
    const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
    return text.length > limit ? text.slice(0, limit) : text;
}

function executableExtensions(executable: string): string[] {
    return process.platform === "win32" && !/\.[^\\/]+$/.test(executable)
        ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
        : [""];
}

function resolveExecutablePath(executable: string): string | null {
    if (executable.includes("/") || executable.includes("\\")) {
        try {
            accessSync(executable, fsConstants.X_OK);
            return executable;
        } catch {
            return null;
        }
    }
    for (const pathEntry of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
        for (const extension of executableExtensions(executable)) {
            try {
                const candidate = join(pathEntry, `${executable}${extension}`);
                accessSync(candidate, fsConstants.X_OK);
                return candidate;
            } catch {
                // Continue PATH lookup without invoking a shell.
            }
        }
    }
    return null;
}

function androidExecutableNames(name: string): string[] {
    if (/\.(exe|bat|cmd)$/i.test(name)) return [name];
    return process.platform === "win32" ? [name, `${name}.exe`, `${name}.bat`, `${name}.cmd`] : [name];
}

function androidToolSubdirs(sdk: string, name: string): string[] {
    if (name === "emulator") return [join(sdk, "emulator")];
    if (name === "avdmanager") {
        const subdirs = [join(sdk, "cmdline-tools", "latest", "bin"), join(sdk, "cmdline-tools", "bin"), join(sdk, "tools", "bin")];
        const cmdlineTools = join(sdk, "cmdline-tools");
        try {
            for (const entry of readdirSync(cmdlineTools, { withFileTypes: true })) {
                if (entry.isDirectory()) subdirs.push(join(cmdlineTools, entry.name, "bin"));
            }
        } catch {
            // Ignore absent SDK command-line tools directory.
        }
        return [...new Set(subdirs)];
    }
    return [join(sdk, "platform-tools")];
}

function androidSdkCandidates(): string[] {
    const candidates = [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : null,
        process.env.APPDATA ? join(process.env.APPDATA, "Android", "Sdk") : null,
        join(homedir(), "AppData", "Local", "Android", "Sdk"),
        join(homedir(), "Android", "Sdk"),
        join(homedir(), "Library", "Android", "sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
    ];
    return [...new Set(candidates.filter((candidate): candidate is string => Boolean(candidate)))];
}

function findMacosProvider(name: string): string | null {
    const fromPath = resolveExecutablePath(name);
    if (fromPath) return fromPath;
    for (const base of DEVICE_BROKER_MACOS_PROVIDER_PATHS) {
        const candidate = join(base, name);
        try {
            accessSync(candidate, fsConstants.X_OK);
            return candidate;
        } catch {
            // Continue Homebrew/system fallback lookup for launchd's minimal PATH.
        }
    }
    return null;
}

function findAndroidTool(name: string, normalized: NormalizedBrokerOptions): string | null {
    const injected = normalized.providerPaths[name];
    if (injected) return injected;
    const fromPath = resolveExecutablePath(name);
    if (fromPath) return fromPath;
    for (const sdk of androidSdkCandidates()) {
        for (const subdir of androidToolSubdirs(sdk, name)) {
            for (const executable of androidExecutableNames(name)) {
                const candidate = join(subdir, executable);
                try {
                    accessSync(candidate, fsConstants.X_OK);
                    return candidate;
                } catch {
                    // Continue SDK lookup.
                }
            }
        }
    }
    return null;
}

function executableExists(executable: string) {
    return Boolean(resolveExecutablePath(executable));
}

function quoteWindowsCommandArg(value: string): string {
    if (!/[ \t"&|<>^]/.test(value)) return value;
    return `"${value.replace(/(["^&|<>])/g, "^$1")}"`;
}

function assertSafeWindowsCommandArguments(values: string[]): void {
    for (const value of values) {
        if (/[\r\n]/.test(value)) throw new Error("windows-command-argument-newline-rejected");
        if (value.includes("%")) throw new Error("windows-command-argument-percent-expansion-rejected");
    }
}

function quotePowerShellSingleString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function powershellEncodedCommand(script: string): string {
    return Buffer.from(script, "utf16le").toString("base64");
}

function quoteWindowsProcessArgument(value: string): string {
    if (value.length === 0) return '""';
    if (!/[ \t\r\n"]/.test(value)) return value;
    let result = '"';
    let backslashes = 0;
    for (const char of value) {
        if (char === "\\") {
            backslashes += 1;
        } else if (char === '"') {
            result += "\\".repeat((backslashes * 2) + 1);
            result += '"';
            backslashes = 0;
        } else {
            result += "\\".repeat(backslashes);
            result += char;
            backslashes = 0;
        }
    }
    result += "\\".repeat(backslashes * 2);
    result += '"';
    return result;
}

export function windowsHiddenVbsLauncherScript(executable: string, args: string[]): string {
    assertSafeWindowsCommandArguments([executable, ...args]);
    const commandLine = [quoteWindowsCommandArg(executable), ...args.map(quoteWindowsCommandArg)].join(" ");
    const hiddenCommand = `%ComSpec% /d /s /c "${commandLine} >NUL 2>NUL"`;
    return [
        "Set Shell = CreateObject(\"WScript.Shell\")",
        `Shell.Run "${hiddenCommand.replace(/"/g, "\"\"")}", 0, False`,
        "",
    ].join("\r\n");
}

function windowsHiddenVbsLauncherPrefix(command: ProviderCommand): string {
    const digest = createHash("sha256")
        .update(JSON.stringify({ executable: command.executable || "", args: command.args || [] }))
        .digest("hex")
        .slice(0, 16);
    return digest;
}

function safeWindowsLauncherProvider(provider: string): string {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(provider)) throw new Error("windows-provider-launcher-provider-invalid");
    return provider;
}

export function windowsHiddenVbsLauncherInvocation(command: ProviderCommand): { executable?: string; args: string[]; cleanupPath?: string } {
    if (!command.executable) return { executable: command.executable, args: command.args || [] };
    const provider = safeWindowsLauncherProvider(command.provider || "provider");
    const launcherPath = createExclusiveBrokerLauncher(
        join(brokerRoot(), "launchers", provider),
        windowsHiddenVbsLauncherPrefix(command),
        "vbs",
        windowsHiddenVbsLauncherScript(command.executable, command.args || []),
    );
    return { executable: "wscript.exe", args: ["//B", launcherPath], cleanupPath: launcherPath };
}

function detachedProviderCommandSpawn(command: ProviderCommand): { executable?: string; args: string[]; cleanupPath?: string } {
    if (process.platform === "win32" && command.windowsHiddenLauncher) {
        return windowsHiddenVbsLauncherInvocation(command);
    }
    return providerCommandSpawn(command);
}

function removeWindowsLauncher(path: string | undefined): void {
    if (!path) return;
    try { unlinkSync(path); } catch { /* launcher cleanup is best-effort */ }
}

function scheduleWindowsLauncherCleanup(path: string | undefined, child: ReturnType<typeof spawn>): void {
    if (!path) return;
    const timer = setTimeout(() => removeWindowsLauncher(path), 60000);
    timer.unref();
    child.once("close", () => {
        clearTimeout(timer);
        removeWindowsLauncher(path);
    });
}

function windowsMinimizedStartProcessInvocation(command: ProviderCommand): { executable?: string; args: string[] } | null {
    if (!command.executable) return null;
    const waitForExit = command.waitForExit !== false;
    const waitFlags = waitForExit ? " -Wait" : "";
    const exitCheck = waitForExit ? "if ($null -ne $Process.ExitCode) { exit $Process.ExitCode }" : "";
    const argumentLine = (command.args || []).map(quoteWindowsProcessArgument).join(" ");
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$Executable = ${quotePowerShellSingleString(command.executable)}`,
        `$Arguments = ${quotePowerShellSingleString(argumentLine)}`,
        `$Process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Minimized${waitFlags} -PassThru`,
        exitCheck,
        "exit 0",
    ].filter(Boolean).join("\n");
    return {
        executable: "powershell.exe",
        args: ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)],
    };
}

export function windowsSandboxWindowHandleSnapshotArgs(): string[] {
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$Handles = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and (($_.ProcessName -match 'WindowsSandbox|wsb') -or ($_.MainWindowTitle -like '*Windows Sandbox*')) } | ForEach-Object { [Int64]$_.MainWindowHandle } | Select-Object -Unique)",
        "$Handles | ConvertTo-Json -Compress",
        "exit 0",
    ].join("\n");
    return ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)];
}

export function windowsSandboxWindowHandlesFromOutput(stdout: string): number[] | null {
    const trimmed = String(stdout || "").trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed);
        const values = Array.isArray(parsed) ? parsed : [parsed];
        return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
    } catch {
        return null;
    }
}

export function windowsSandboxMinimizeWatchdogArgs(timeoutMs = DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS, startedAfter = "", cancelPath = "", baselineHandles: number[] | null = null, resultPath = ""): string[] {
    const boundedTimeoutMs = Math.min(600000, Math.max(1000, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS));
    const boundedStartedAfter = Number.isNaN(Date.parse(startedAfter)) ? new Date().toISOString() : new Date(startedAfter).toISOString();
    const normalizedBaselineHandles = Array.isArray(baselineHandles)
        ? [...new Set(baselineHandles.filter((value) => Number.isSafeInteger(value) && value > 0))]
        : [];
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$Signature = @'",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public static class CccNativeWindow {",
        "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
        "}",
        "'@",
        "Add-Type -TypeDefinition $Signature -ErrorAction SilentlyContinue | Out-Null",
        `$StartedAfter = [DateTime]::Parse('${boundedStartedAfter.replace(/'/g, "''")}').ToUniversalTime()`,
        `$HasBaselineSnapshot = $${Array.isArray(baselineHandles) ? "true" : "false"}`,
        `$BaselineHandles = @(${normalizedBaselineHandles.join(",")})`,
        `$CancelPath = '${cancelPath.replace(/'/g, "''")}'`,
        `$ResultPath = '${resultPath.replace(/'/g, "''")}'`,
        `$Deadline = (Get-Date).AddMilliseconds(${boundedTimeoutMs})`,
        "$Minimized = $false",
        "while ((Get-Date) -lt $Deadline -and (-not $CancelPath -or -not (Test-Path -LiteralPath $CancelPath))) {",
        "  $Handles = @()",
        "  try {",
        "    $Handles = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {",
        "      $Handle = [Int64]$_.MainWindowHandle",
        "      $Candidate = $Handle -ne 0 -and (($_.ProcessName -match 'WindowsSandbox|wsb') -or ($_.MainWindowTitle -like '*Windows Sandbox*'))",
        "      $NewHandle = $HasBaselineSnapshot -and -not ($BaselineHandles -contains $Handle)",
        "      $NewProcess = (-not $HasBaselineSnapshot) -and $_.StartTime.ToUniversalTime() -ge $StartedAfter",
        "      $Candidate -and ($NewHandle -or $NewProcess)",
        "    } | ForEach-Object { [Int64]$_.MainWindowHandle } | Select-Object -Unique)",
        "  } catch {}",
        "  foreach ($Handle in $Handles) { if ([CccNativeWindow]::ShowWindowAsync([IntPtr]$Handle, 6)) { $Minimized = $true } }",
        "  if ($Minimized) {",
        "    if ($ResultPath) { Set-Content -LiteralPath $ResultPath -Value 'minimized' -NoNewline -Encoding Ascii }",
        "    break",
        "  }",
        "  Start-Sleep -Milliseconds 250",
        "}",
        "if (-not $Minimized -and $ResultPath -and -not (Test-Path -LiteralPath $ResultPath)) { Set-Content -LiteralPath $ResultPath -Value 'not-minimized' -NoNewline -Encoding Ascii }",
        "exit 0",
    ].join("\n");
    return ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-EncodedCommand", powershellEncodedCommand(script)];
}

export function providerCommandSpawn(command: ProviderCommand, platform: NodeJS.Platform = process.platform): { executable?: string; args: string[] } {
    const executable = command.executable;
    const args = platform === "win32"
        && executable
        && /^(?:powershell|pwsh)(?:\.exe)?$/i.test(win32.basename(executable))
        ? hiddenWindowsPowerShellArgs(command.args || [])
        : command.args || [];
    if (platform === "win32" && command.windowStyle === "minimized") {
        const invocation = windowsMinimizedStartProcessInvocation(command);
        if (invocation) return invocation;
    }
    if (platform === "win32" && executable && /\.(bat|cmd)$/i.test(executable)) {
        assertSafeWindowsCommandArguments([executable, ...args]);
        const commandLine = [quoteWindowsCommandArg(executable), ...args.map(quoteWindowsCommandArg)].join(" ");
        return { executable: "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
    }
    return { executable, args };
}

export function hiddenChildProcessOptions<T extends object>(options: T): T & { windowsHide: true } {
    return { ...options, windowsHide: true };
}

function packageRootForBroker(normalized: NormalizedBrokerOptions): string {
    const cliDir = dirname(normalized.cliPath);
    return basename(cliDir) === "dist" ? dirname(cliDir) : normalized.cwd;
}

type DeviceLabBackendInvocation = {
    modulePath: string;
    handlerName: string;
    supportedBackends: string[];
};

function deviceLabBackendInvocation(normalized: NormalizedBrokerOptions, backend: string | null): DeviceLabBackendInvocation | null {
    const backendRoot = join(packageRootForBroker(normalized), "device-lab-mcp", "src", "backends");
    if (backend === "windows-sandbox") {
        return {
            modulePath: join(backendRoot, "windows-sandbox.mjs"),
            handlerName: "handleWindowsTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "macos-vm") {
        return {
            modulePath: join(backendRoot, "macos-vm.mjs"),
            handlerName: "handleMacosTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "android-emulator") {
        return {
            modulePath: join(backendRoot, "android.mjs"),
            handlerName: "handleAndroidTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "android-device") {
        return {
            modulePath: join(backendRoot, "android-device.mjs"),
            handlerName: "handleAndroidRealTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "ios-simulator") {
        return {
            modulePath: join(backendRoot, "ios-simulator.mjs"),
            handlerName: "handleIosTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    if (backend === "ios-device") {
        return {
            modulePath: join(backendRoot, "ios-device.mjs"),
            handlerName: "handleIosRealTool",
            supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
        };
    }
    return null;
}

type BrokerBackendChildResult = {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    error?: Error;
    timedOut: boolean;
    cleanup?: BrokerProcessTreeCleanup;
};

export function runBrokerBackendChild(
    script: string,
    input: string,
    options: {
        cwd: string;
        timeoutMs: number;
        outputLimit: number;
        cleanupGraceMs?: number;
        terminateTree?: (pid: number | undefined) => BrokerProcessTreeCleanup;
    },
): Promise<BrokerBackendChildResult> {
    return new Promise((resolveResult) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], hiddenChildProcessOptions({
            cwd: options.cwd,
            detached: process.platform !== "win32",
        }));
        const spawnedProcessIdentity = readDeviceRuntimeProcessIdentity(child.pid);
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let outputBytes = 0;
        let settled = false;
        let timedOut = false;
        let childError: Error | undefined;
        let cleanup: BrokerProcessTreeCleanup | undefined;
        let timer: NodeJS.Timeout | undefined;
        let forceSettleTimer: NodeJS.Timeout | undefined;
        const cleanupGraceMs = Math.min(10000, Math.max(1, options.cleanupGraceMs ?? 1000));
        const cleanupFailureError = () => cleanup && !cleanup.ok
            ? `process-tree cleanup failed${cleanup.error ? `: ${cleanup.error}` : ""}`
            : null;
        const terminateTree = () => {
            if (!cleanup) cleanup = options.terminateTree
                ? options.terminateTree(child.pid)
                : terminateBrokerSpawnedProcessTree(child.pid, {
                    expectedIdentity: spawnedProcessIdentity,
                    requireIdentity: true,
                });
            const cleanupFailure = cleanupFailureError();
            if (cleanupFailure) {
                childError = new Error(childError ? `${childError.message}; ${cleanupFailure}` : cleanupFailure);
            }
            if (!forceSettleTimer) {
                forceSettleTimer = setTimeout(() => {
                    if (!childError) childError = new Error("device-lab backend child did not close after process-tree cleanup");
                    child.stdin?.destroy();
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                    child.unref();
                    finish(null, null);
                }, cleanupGraceMs);
                forceSettleTimer.unref();
            }
        };
        const finish = (status: number | null, signal: NodeJS.Signals | null) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (forceSettleTimer) clearTimeout(forceSettleTimer);
            resolveResult({
                status,
                signal,
                stdout: stdout.toString("utf8"),
                stderr: stderr.toString("utf8"),
                error: childError,
                timedOut,
                cleanup,
            });
        };
        const append = (target: "stdout" | "stderr", chunk: Buffer) => {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = Math.max(0, options.outputLimit - Math.min(outputBytes, options.outputLimit));
            if (remaining > 0) {
                if (target === "stdout") stdout = Buffer.concat([stdout, value.subarray(0, remaining)]);
                else stderr = Buffer.concat([stderr, value.subarray(0, remaining)]);
            }
            outputBytes += value.length;
            if (!childError && outputBytes > options.outputLimit) {
                childError = new Error("device-lab backend output exceeded limit");
                terminateTree();
            }
        };
        child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.once("error", (error) => {
            childError = error;
            finish(null, null);
        });
        child.once("close", finish);
        timer = setTimeout(() => {
            timedOut = true;
            childError = new Error(`device-lab backend tool timed out after ${options.timeoutMs}ms`);
            terminateTree();
        }, options.timeoutMs);
        child.stdin?.end(input);
    });
}

function deviceLabBackendToolArgs(parsed: DeviceToolParamSuccess): Record<string, unknown> {
    const allowed = new Set([
        "backend",
        "action",
        "serial",
        "host",
        "port",
        "pairHost",
        "pairPort",
        "pairingCode",
        "connect",
        "deviceId",
        "command",
        "localPath",
        "remotePath",
        "path",
        "replace",
        "packageName",
        "component",
        "bundleId",
        "containerType",
        "snapshotName",
        "snapshotId",
        "force",
        "eraseSimulator",
        "confirmDestructive",
        "x",
        "y",
        "x1",
        "y1",
        "x2",
        "y2",
        "button",
        "key",
        "keyCode",
        "text",
        "direction",
        "amount",
        "durationMs",
        "orientation",
        "url",
        "permission",
        "service",
        "latitude",
        "longitude",
        "altitude",
        "level",
        "charging",
        "status",
        "wifi",
        "data",
        "enabled",
        "timeoutMs",
        "intervalMs",
        "helperTimeoutMs",
        "maxDepth",
        "maxNodes",
        "minimized",
    ]);
    return Object.fromEntries(Object.entries(parsed.params).filter(([key]) => allowed.has(key)));
}

function boundedDeviceToolTimeoutMs(value: unknown, maximum: number, fallback: number): number {
    const requested = Number(value);
    if (!Number.isFinite(requested) || requested <= 0) return fallback;
    return Math.min(maximum, Math.max(1, Math.trunc(requested)));
}

export function deviceBrokerBackendToolTimeoutMs(tool: string, params: Record<string, unknown> = {}, commandTimeoutMs = DEVICE_BROKER_COMMAND_TIMEOUT_MS): number {
    const requestedHelperTimeoutMs = Number(params.helperTimeoutMs);
    const helperDeadlineMs = Number.isFinite(requestedHelperTimeoutMs) && requestedHelperTimeoutMs > 0
        ? boundedDeviceToolTimeoutMs(requestedHelperTimeoutMs, DEVICE_BROKER_MAX_HELPER_TIMEOUT_MS, DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS) + DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_BUFFER_MS
        : DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS;
    const requestedOperationTimeoutMs = Number(params.timeoutMs);
    const operationDeadlineMs = DEVICE_BROKER_BOUNDED_WAIT_TOOLS.has(tool) && Number.isFinite(requestedOperationTimeoutMs) && requestedOperationTimeoutMs > 0
        ? boundedDeviceToolTimeoutMs(requestedOperationTimeoutMs, DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS, DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS) + DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_BUFFER_MS
        : DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS;
    const boundedCommandTimeoutMs = boundedDeviceToolTimeoutMs(commandTimeoutMs, DEVICE_BROKER_MAX_OPERATION_TIMEOUT_MS, DEVICE_BROKER_COMMAND_TIMEOUT_MS);
    return Math.max(
        boundedCommandTimeoutMs,
        DEVICE_BROKER_DEVICE_TOOL_TIMEOUT_MS,
        helperDeadlineMs,
        operationDeadlineMs,
    );
}

async function defaultBrokerDeviceToolRunner(ownerId: string, parsed: DeviceToolParamSuccess, match: DeviceToolMatch, normalized: NormalizedBrokerOptions): Promise<BrokerRpcResult> {
    const invocation = deviceLabBackendInvocation(normalized, match.backend);
    if (!invocation) {
        return {
            status: 501,
            payload: {
                ok: false,
                error: "broker-device-tool-backend-not-supported",
                backend: match.backend,
                tool: parsed.tool,
                supportedBackends: DEVICE_BROKER_BACKEND_TOOL_RUNNER_BACKENDS,
            },
        };
    }
    const { modulePath, handlerName } = invocation;
    if (!existsSync(modulePath)) {
        return { status: 500, payload: { ok: false, error: "device-lab-backend-module-missing", modulePath, tool: parsed.tool } };
    }
    const expectedOwnerId = canonicalDeviceLabOwnerId(normalized.cwd, normalized.profile);
    if (ownerId !== expectedOwnerId) {
        return {
            status: 409,
            payload: {
                ok: false,
                error: "broker-owner-basis-unavailable",
                ownerId,
                expectedOwnerId,
                tool: parsed.tool,
                message: "This broker can proxy desktop device tools only for the cwd/profile owner it was launched for.",
            },
        };
    }
    const script = [
        "import { readFileSync } from 'fs';",
        "const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');",
        "const { moduleUrl, tool, args, handlerName } = payload;",
        "const backend = await import(moduleUrl);",
        "if (!handlerName || typeof backend[handlerName] !== 'function') throw new Error(`Missing backend handler: ${handlerName || '<empty>'}`);",
        "const result = await backend[handlerName](tool, args);",
        "process.stdout.write(JSON.stringify({ result: result || null }));",
    ].join("\n");
    const invocationPayload = {
        moduleUrl: pathToFileURL(modulePath).href,
        handlerName,
        tool: parsed.tool,
        args: deviceLabBackendToolArgs(parsed),
    };
    const outputLimit = Math.max(DEVICE_BROKER_COMMAND_OUTPUT_LIMIT, 12 * 1024 * 1024);
    const timeoutMs = deviceBrokerBackendToolTimeoutMs(parsed.tool, parsed.params, normalized.commandTimeoutMs);
    const result = await runBrokerBackendChild(script, JSON.stringify(invocationPayload), {
        cwd: normalized.cwd,
        timeoutMs,
        outputLimit,
    });
    if (result.status !== 0 || result.error) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "device-lab-backend-tool-failed",
                tool: parsed.tool,
                backend: match.backend,
                status: result.status,
                signal: result.signal,
                stdout: truncateOutput(result.stdout, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT),
                stderr: truncateOutput(result.stderr, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT),
                detail: result.error ? result.error.message : undefined,
                timedOut: result.timedOut,
                timeoutMs,
                ...(result.cleanup ? { cleanup: result.cleanup } : {}),
            },
        };
    }
    let parsedOutput: { result?: unknown } | null = null;
    try {
        parsedOutput = JSON.parse(result.stdout || "{}") as { result?: unknown };
    } catch {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "device-lab-backend-tool-invalid-json",
                tool: parsed.tool,
                backend: match.backend,
                stdout: truncateOutput(result.stdout, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT),
                stderr: truncateOutput(result.stderr, DEVICE_BROKER_COMMAND_OUTPUT_LIMIT),
            },
        };
    }
    if (!parsedOutput?.result) {
        return { status: 404, payload: { ok: false, error: "owner-device-not-found", deviceId: parsed.deviceId, backend: match.backend, tool: parsed.tool } };
    }
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                tool: parsed.tool,
                deviceId: parsed.deviceId,
                backend: match.backend,
                stateKey: match.stateKey,
                provider: "device-lab-backend-child",
                mcpResult: parsedOutput.result,
            },
        },
    };
}

export function boundedProviderCommandRunnerScript() {
    const windowsTerminationScript = JSON.stringify(windowsHandleBoundTerminationScript());
    return String.raw`
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");

const payload = workerData.payload;
const control = new Int32Array(workerData.shared, 0, 4);
const transport = new Uint8Array(workerData.shared, 16);
const identityTransport = new Uint8Array(workerData.identityShared);
const windowsTerminationScript = ${windowsTerminationScript};
const outputLimit = Math.max(1, Number(payload.outputLimit) || 1);
const cleanupGraceMs = Math.max(1, Number(payload.cleanupGraceMs) || 1000);
let stdout = Buffer.alloc(0);
let stderr = Buffer.alloc(0);
let outputBytes = 0;
let commandError;
let timedOut = false;
let cleanup;
let settled = false;
let timer;
let forceSettleTimer;

function boundedText(value, limit = 8192) {
    const input = String(value || "");
    return Buffer.byteLength(input) <= limit ? input : Buffer.from(input).subarray(0, limit).toString("utf8");
}

function append(current, chunk) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, outputLimit - outputBytes);
    outputBytes += value.length;
    if (remaining > 0) current = Buffer.concat([current, value.subarray(0, remaining)]);
    if (outputBytes > outputLimit && !commandError) commandError = "spawn ENOBUFS: device-lab provider output exceeded limit";
    return current;
}

function processIdentity(pid) {
    try {
        let startToken = "";
        let commandLine = "";
        if (process.platform === "linux") {
            const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
            const close = stat.lastIndexOf(")");
            const fields = close >= 0 ? stat.slice(close + 1).trim().split(/\s+/) : [];
            startToken = fields[19] ? "linux:" + fields[19] : "";
            commandLine = readFileSync("/proc/" + pid + "/cmdline").toString("utf8").split("\0").filter(Boolean).join(" ");
        } else if (process.platform === "win32") {
            if (typeof payload.windowsPowerShellPath !== "string" || !payload.windowsPowerShellPath) return null;
            const script = "$P = Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "' -ErrorAction SilentlyContinue; if ($P) { [pscustomobject]@{ startToken = $P.CreationDate.ToUniversalTime().ToString('o'); commandLine = [string]$P.CommandLine } | ConvertTo-Json -Compress }";
            const observed = spawnSync(payload.windowsPowerShellPath, ["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5000, windowsHide: true });
            const parsed = observed.status === 0 && observed.stdout && observed.stdout.trim() ? JSON.parse(observed.stdout) : null;
            startToken = parsed && typeof parsed.startToken === "string" ? "windows:" + parsed.startToken : "";
            commandLine = parsed && typeof parsed.commandLine === "string" ? parsed.commandLine : "";
        } else {
            const started = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000, windowsHide: true });
            const command = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000, windowsHide: true });
            startToken = started.status === 0 && started.stdout ? "ps:" + started.stdout.trim() : "";
            commandLine = command.status === 0 && command.stdout ? command.stdout.trim() : "";
        }
        if (!startToken || !commandLine) return null;
        return { pid, startToken, commandHash: createHash("sha256").update(commandLine).digest("hex") };
    } catch {
        return null;
    }
}

function publishIdentity(identity) {
    if (!identity) return;
    const encoded = Buffer.from(JSON.stringify(identity), "utf8");
    if (encoded.length > identityTransport.length) return;
    identityTransport.set(encoded);
    Atomics.store(control, 3, encoded.length);
    Atomics.notify(control, 3);
}

function terminateTree(pid, expectedIdentity) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return { attempted: false, ok: false, pid: 0, signal: "SIGKILL", platform: process.platform, error: "spawned-process-pid-missing" };
    }
    if (!expectedIdentity) {
        return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "spawned-process-identity-missing" };
    }
    const currentIdentity = processIdentity(pid);
    if (!currentIdentity) {
        if (child.exitCode !== null || child.signalCode !== null) {
            return { attempted: false, ok: true, stale: true, pid, signal: "SIGKILL", platform: process.platform };
        }
        return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "spawned-process-identity-unavailable" };
    }
    if (currentIdentity.pid !== expectedIdentity.pid
        || currentIdentity.startToken !== expectedIdentity.startToken
        || currentIdentity.commandHash !== expectedIdentity.commandHash) {
        return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "spawned-process-identity-mismatch" };
    }
    if (process.platform === "win32") {
        if (typeof payload.windowsPowerShellPath !== "string" || !payload.windowsPowerShellPath) {
            return { attempted: false, ok: false, pid, signal: "SIGKILL", platform: process.platform, error: "windows-system-powershell-unavailable" };
        }
        const result = spawnSync(payload.windowsPowerShellPath, ["-WindowStyle", "Hidden", "-NoProfile", "-NonInteractive", "-Command", windowsTerminationScript], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 11000,
            env: {
                ...process.env,
                CCC_WINDOWS_TERMINATE_PID: String(pid),
                CCC_WINDOWS_TERMINATE_START_TOKEN: expectedIdentity.startToken,
            },
        });
        const output = boundedText(String(result.stdout || "") + "\n" + String(result.stderr || ""));
        const ok = result.status === 0;
        return {
            attempted: true,
            ok,
            pid,
            signal: "SIGKILL",
            platform: process.platform,
            ...(ok ? {} : {
                error: result.status === 3
                    ? "spawned-process-identity-mismatch"
                    : output.trim() || (result.error && result.error.message) || "process handle termination failed",
            }),
        };
    }
    try {
        process.kill(-pid, "SIGKILL");
        return { attempted: true, ok: true, pid, signal: "SIGKILL", platform: process.platform };
    } catch (error) {
        const stale = error && error.code === "ESRCH";
        return {
            attempted: true,
            ok: stale,
            ...(stale ? { stale: true } : {}),
            pid,
            signal: "SIGKILL",
            platform: process.platform,
            ...(stale ? {} : { error: error instanceof Error ? error.message : String(error) }),
        };
    }
}

function publish(status, signal) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(forceSettleTimer);
    let encoded = Buffer.from(JSON.stringify({
        status,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        ...(commandError ? { error: commandError } : {}),
        timedOut,
        ...(cleanup ? { cleanup } : {}),
    }), "utf8");
    if (encoded.length > transport.length) {
        encoded = Buffer.from(JSON.stringify({
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
            error: "device-lab provider runner transport overflow",
            timedOut,
            ...(cleanup ? { cleanup } : {}),
        }), "utf8");
    }
    transport.set(encoded.subarray(0, transport.length));
    Atomics.store(control, 1, Math.min(encoded.length, transport.length));
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    if (parentPort) parentPort.postMessage({ done: true });
}

const child = spawn(payload.executable, payload.args, {
    cwd: payload.cwd || undefined,
    env: { ...process.env, ...(payload.env || {}) },
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
});
Atomics.store(control, 2, Number.isInteger(child.pid) ? child.pid : 0);
const spawnedIdentity = processIdentity(child.pid);
publishIdentity(spawnedIdentity);
Atomics.notify(control, 2);
if (parentPort) parentPort.postMessage({ spawned: true, pid: child.pid });
if (!spawnedIdentity) {
    setTimeout(() => {
        if (settled) return;
        commandError = "device-lab provider process identity could not be established";
        terminateForFailure();
    }, 100);
}

function terminateForFailure() {
    if (cleanup) return;
    cleanup = terminateTree(child.pid, spawnedIdentity);
    if (!cleanup.ok) {
        const detail = cleanup.error ? ": " + cleanup.error : "";
        commandError = boundedText((commandError ? commandError + "; " : "") + "process-tree cleanup failed" + detail);
    }
    forceSettleTimer = setTimeout(() => {
        if (!commandError) commandError = "device-lab provider child did not close after process-tree cleanup";
        publish(null, null);
    }, cleanupGraceMs);
}

child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
    if (outputBytes > outputLimit) terminateForFailure();
});
child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
    if (outputBytes > outputLimit) terminateForFailure();
});
child.once("error", (error) => {
    commandError = error instanceof Error ? error.message : String(error);
});
child.once("close", publish);
timer = setTimeout(() => {
    timedOut = true;
    commandError = "device-lab provider command timed out after " + payload.timeoutMs + "ms";
    terminateForFailure();
}, payload.timeoutMs);
child.stdin.end(payload.input === undefined ? undefined : payload.input);
`;
}

function providerProcessIdentityFromShared(control: Int32Array, identityTransport: Uint8Array): DeviceRuntimeProcessIdentity | null {
    const length = Atomics.load(control, 3);
    if (length <= 0 || length > identityTransport.length) return null;
    try {
        const parsed = JSON.parse(Buffer.from(identityTransport.subarray(0, length)).toString("utf8")) as Partial<DeviceRuntimeProcessIdentity>;
        return typeof parsed.pid === "number"
            && Number.isInteger(parsed.pid)
            && parsed.pid > 0
            && typeof parsed.startToken === "string"
            && parsed.startToken.length > 0
            && typeof parsed.commandHash === "string"
            && /^[a-f0-9]{64}$/.test(parsed.commandHash)
            ? parsed as DeviceRuntimeProcessIdentity
            : null;
    } catch {
        return null;
    }
}

export function defaultProviderCommandRunner(command: ProviderCommand, options: ProviderCommandRunnerOptions): ProviderCommandResult {
    if (command.mode === "noop") {
        return { mode: "noop", provider: command.provider, stdout: command.reason || "", stderr: "", status: 0 };
    }
    if (!command.executable) {
        return { mode: command.mode, provider: command.provider, error: "missing-executable", status: null };
    }
    const commandEnv = hiddenProviderCommandEnv(command.env);
    if (command.mode === "detached") {
        if (!executableExists(command.executable)) {
            return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: "executable-not-found" };
        }
        try {
            const invocation = detachedProviderCommandSpawn(command);
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(invocation.executable || command.executable, invocation.args, hiddenChildProcessOptions({
                    detached: true,
                    stdio: "ignore" as const,
                    ...(commandEnv ? { env: { ...process.env, ...commandEnv } } : {}),
                    ...(command.cwd ? { cwd: command.cwd } : {}),
                }));
            } catch (error) {
                removeWindowsLauncher(invocation.cleanupPath);
                throw error;
            }
            scheduleWindowsLauncherCleanup(invocation.cleanupPath, child);
            child.once("error", () => undefined);
            child.unref();
            return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], pid: child.pid, status: 0 };
        } catch (error) {
            return { mode: "detached", provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: error instanceof Error ? error.message : String(error) };
        }
    }
    let invocation: ReturnType<typeof providerCommandSpawn>;
    try {
        invocation = providerCommandSpawn(command);
    } catch (error) {
        return {
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            status: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const timeoutMs = Math.max(1, options.timeoutMs);
    const outputLimit = Math.max(1, Math.floor(options.outputLimit));
    const cleanupGraceMs = Math.min(10000, Math.max(1, options.cleanupGraceMs ?? 1000));
    // JSON can expand each raw control byte to a six-byte \\u00xx escape. The
    // fixed shared transport therefore reserves the exact bounded worst case.
    const transportCapacity = (outputLimit * 6) + (64 * 1024);
    const shared = new SharedArrayBuffer(16 + transportCapacity);
    const identityShared = new SharedArrayBuffer(4096);
    const control = new Int32Array(shared, 0, 4);
    const transport = new Uint8Array(shared, 16);
    const identityTransport = new Uint8Array(identityShared);
    let worker: Worker;
    try {
        worker = new Worker(boundedProviderCommandRunnerScript(), {
            eval: true,
            workerData: {
                shared,
                identityShared,
                payload: {
                    executable: invocation.executable || command.executable,
                    args: invocation.args,
                    input: command.input,
                    cwd: command.cwd,
                    env: commandEnv,
                    timeoutMs,
                    outputLimit,
                    cleanupGraceMs,
                    windowsPowerShellPath: process.platform === "win32"
                        ? canonicalWindowsPowerShellPath()
                        : null,
                },
            },
        });
        worker.on("error", () => undefined);
        worker.unref();
    } catch (error) {
        return {
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            status: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    const wrapperTimeoutMs = Math.max(1, options.wrapperTimeoutMs ?? (timeoutMs + cleanupGraceMs + 15000));
    const waitResult = Atomics.wait(control, 0, 0, wrapperTimeoutMs);
    if (waitResult === "timed-out") {
        const providerPid = Atomics.load(control, 2);
        const cleanup = terminateBrokerSpawnedProcessTree(providerPid, {
            expectedIdentity: providerProcessIdentityFromShared(control, identityTransport),
            requireIdentity: true,
        });
        void worker.terminate();
        return {
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            status: null,
            stdout: "",
            stderr: "",
            error: `device-lab provider wrapper timed out after ${wrapperTimeoutMs}ms`,
            timedOut: true,
            cleanup,
        };
    }
    const resultLength = Atomics.load(control, 1);
    let execution: Partial<ProviderCommandResult>;
    try {
        if (resultLength <= 0 || resultLength > transport.length) throw new Error("invalid transport length");
        execution = JSON.parse(Buffer.from(transport.subarray(0, resultLength)).toString("utf8")) as Partial<ProviderCommandResult>;
    } catch {
        execution = {
            status: null,
            stdout: "",
            stderr: "",
            error: "device-lab provider runner returned invalid output",
        };
    }
    void worker.terminate();
    return {
        mode: "exec",
        provider: command.provider,
        executable: command.executable,
        args: command.args || [],
        ...(command.input !== undefined ? { input: command.input } : {}),
        ...execution,
        stdout: truncateOutput(execution.stdout, options.outputLimit),
        stderr: truncateOutput(execution.stderr, options.outputLimit),
    };
}

export async function defaultProviderCommandRunnerAsync(command: ProviderCommand, options: ProviderCommandRunnerOptions): Promise<ProviderCommandResult> {
    if (command.mode !== "exec") return defaultProviderCommandRunner(command, options);
    if (!command.executable) return { mode: command.mode, provider: command.provider, error: "missing-executable", status: null };
    let invocation: ReturnType<typeof providerCommandSpawn>;
    try {
        invocation = providerCommandSpawn(command);
    } catch (error) {
        return { mode: "exec", provider: command.provider, executable: command.executable, args: command.args || [], status: null, error: error instanceof Error ? error.message : String(error) };
    }
    const timeoutMs = Math.max(1, options.timeoutMs);
    const outputLimit = Math.max(1, Math.floor(options.outputLimit));
    const cleanupGraceMs = Math.min(10000, Math.max(1, options.cleanupGraceMs ?? 1000));
    const wrapperTimeoutMs = Math.max(1, options.wrapperTimeoutMs ?? (timeoutMs + cleanupGraceMs + 15000));
    const transportCapacity = (outputLimit * 6) + (64 * 1024);
    const shared = new SharedArrayBuffer(16 + transportCapacity);
    const identityShared = new SharedArrayBuffer(4096);
    const control = new Int32Array(shared, 0, 4);
    const transport = new Uint8Array(shared, 16);
    const identityTransport = new Uint8Array(identityShared);
    const commandEnv = hiddenProviderCommandEnv(command.env);

    return await new Promise<ProviderCommandResult>((resolveResult) => {
        let worker: Worker;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const result = (execution: Partial<ProviderCommandResult>): ProviderCommandResult => ({
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            ...(command.input !== undefined ? { input: command.input } : {}),
            ...execution,
            stdout: truncateOutput(execution.stdout, outputLimit),
            stderr: truncateOutput(execution.stderr, outputLimit),
        });
        const finish = (execution: Partial<ProviderCommandResult>) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            void worker.terminate();
            resolveResult(result(execution));
        };
        const cleanupProvider = () => terminateBrokerSpawnedProcessTree(Atomics.load(control, 2), {
            expectedIdentity: providerProcessIdentityFromShared(control, identityTransport),
            requireIdentity: true,
        });
        const finishFromTransport = (cleanupOnInvalid = false) => {
            const resultLength = Atomics.load(control, 1);
            try {
                if (resultLength <= 0 || resultLength > transport.length) throw new Error("invalid transport length");
                finish(JSON.parse(Buffer.from(transport.subarray(0, resultLength)).toString("utf8")) as Partial<ProviderCommandResult>);
            } catch {
                const cleanup = cleanupOnInvalid ? cleanupProvider() : undefined;
                finish({ status: null, stdout: "", stderr: "", error: "device-lab provider runner returned invalid output", ...(cleanup ? { cleanup } : {}) });
            }
        };
        try {
            worker = new Worker(boundedProviderCommandRunnerScript(), {
                eval: true,
                workerData: {
                    shared,
                    identityShared,
                    payload: {
                        executable: invocation.executable || command.executable,
                        args: invocation.args,
                        input: command.input,
                        cwd: command.cwd,
                        env: commandEnv,
                        timeoutMs,
                        outputLimit,
                        cleanupGraceMs,
                        windowsPowerShellPath: process.platform === "win32"
                            ? canonicalWindowsPowerShellPath()
                            : null,
                    },
                },
            });
        } catch (error) {
            resolveResult(result({ status: null, error: error instanceof Error ? error.message : String(error) }));
            return;
        }
        worker.on("message", (message: unknown) => {
            if (message && typeof message === "object" && (message as { done?: unknown }).done === true) finishFromTransport();
        });
        worker.once("error", (error) => finish({ status: null, stdout: "", stderr: "", error: error.message, cleanup: cleanupProvider() }));
        worker.once("exit", () => {
            if (!settled) finishFromTransport(true);
        });
        worker.unref();
        timer = setTimeout(() => {
            const cleanup = cleanupProvider();
            finish({ status: null, stdout: "", stderr: "", error: `device-lab provider wrapper timed out after ${wrapperTimeoutMs}ms`, timedOut: true, cleanup });
        }, wrapperTimeoutMs);
        timer.unref();
    });
}

function hyperVProviderCommandRunner(normalized: NormalizedBrokerOptions, command: ProviderCommand, options: ProviderCommandRunnerOptions): Promise<ProviderCommandResult> {
    return normalized.usesDefaultCommandRunner
        ? defaultProviderCommandRunnerAsync(command, options)
        : Promise.resolve(normalized.commandRunner(command, options));
}

function commandSucceeded(result: ProviderCommandResult) {
    return result.status === 0 && !result.error;
}

function providerFailureDetail(result: ProviderCommandResult): string {
    const parts = [
        result.error ? `error: ${result.error}` : "",
        result.stderr ? `stderr: ${result.stderr}` : "",
        result.stdout ? `stdout: ${result.stdout}` : "",
    ].filter(Boolean);
    return truncateOutput(parts.join("\n") || `provider exited with status ${String(result.status)}`, 8192);
}

function hyperVGuestReadinessFailureCode(backend: "windows-vm" | "linux-vm", result: ProviderCommandResult): string {
    if (backend === "windows-vm") {
        const observation = parseHyperVGuestReadyFailureObservation(result.stdout || "");
        if (observation) return observation.reason;
        const error = String(result.error || "");
        if (error.length <= 128 && /^hyper-v-[a-z0-9-]+$/.test(error)) return error;
        return result.timedOut ? "powershell-direct-timeout" : "powershell-direct-unavailable";
    }
    const diagnostic = `${result.error || ""}\n${result.stderr || ""}`.toLowerCase();
    if (diagnostic.includes("connection refused")) return "ssh-connection-refused";
    if (diagnostic.includes("connection timed out") || diagnostic.includes("operation timed out") || result.timedOut) return "ssh-connection-timeout";
    if (diagnostic.includes("no route to host") || diagnostic.includes("host is down")) return "ssh-host-unreachable";
    if (diagnostic.includes("host key verification failed") || diagnostic.includes("remote host identification has changed")) return "ssh-host-key-rejected";
    if (diagnostic.includes("permission denied") || diagnostic.includes("authentication failed")) return "ssh-authentication-failed";
    const error = String(result.error || "");
    if (error.length <= 128 && /^hyper-v-[a-z0-9-]+$/.test(error)) return error;
    return "ssh-unavailable";
}

type HyperVLinuxGuestReadyTrace = {
    managedSshAttempts: number;
    bootstrapProbeAttempts: number;
    bootstrapProbeSuccesses: number;
    bootstrapProbeLastStatus?: number | null;
    bootstrapProbeLastError?: string | null;
    bootstrapAddressCount: number;
    bootstrapSshAttempts: number;
    bootstrapSshLastStatus?: number | null;
    bootstrapSshLastError?: string | null;
    bootstrapHostKeyObserved?: boolean | null;
    bootstrapHostKeyMatchesExpected?: boolean | null;
    bootstrapHostKeyAdopted?: boolean;
    networkFinalizeAttempts: number;
    networkFinalizeSucceeded: boolean;
    guestSignalObserved: boolean;
    elapsedMs: number;
};

export function hyperVLinuxGuestReadyTraceFailureCode(
    trace: HyperVLinuxGuestReadyTrace | null,
    fallback: string,
): string {
    if (!trace) return fallback;
    if (!fallback.startsWith("ssh-") && fallback !== "hyper-v-guest-boot-signal-timeout") {
        return fallback;
    }
    const bootstrapDiagnosticCodes = new Set([
        "hyper-v-bootstrap-address-selection-failed",
        "hyper-v-bootstrap-host-prefix-inspection-failed",
        "hyper-v-bootstrap-management-adapter-inspection-failed",
        "hyper-v-bootstrap-neighbor-inspection-failed",
        "hyper-v-bootstrap-network-adapter-ambiguous",
        "hyper-v-bootstrap-network-adapter-identity-mismatch",
        "hyper-v-bootstrap-network-command-failed",
        "hyper-v-bootstrap-network-probe-failed",
        "hyper-v-bootstrap-network-response-invalid",
        "hyper-v-bootstrap-vm-adapter-inspection-failed",
    ]);
    if (trace.bootstrapProbeLastError
        && bootstrapDiagnosticCodes.has(trace.bootstrapProbeLastError)) {
        return trace.bootstrapProbeLastError;
    }
    if (!trace.guestSignalObserved
        && trace.elapsedMs >= DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS) {
        return "hyper-v-guest-boot-signal-timeout";
    }
    if (trace.bootstrapProbeAttempts > 0 && trace.bootstrapProbeSuccesses === 0) {
        return "hyper-v-bootstrap-network-probe-failed";
    }
    if (trace.bootstrapProbeSuccesses > 0 && trace.bootstrapAddressCount === 0) {
        return "hyper-v-bootstrap-address-unavailable";
    }
    if (trace.bootstrapSshAttempts > 0 && trace.networkFinalizeAttempts === 0) {
        const bootstrapSshCodes = new Set([
            "ssh-authentication-failed",
            "ssh-host-key-client-verification-failed",
            "ssh-host-key-mismatch",
            "ssh-host-key-adoption-failed",
            "ssh-host-key-bootstrap-authentication-failed",
            "ssh-connection-refused",
            "ssh-connection-timeout",
            "ssh-host-key-rejected",
            "ssh-host-unreachable",
            "ssh-readiness-marker-missing",
            "ssh-unavailable",
        ]);
        return trace.bootstrapSshLastError && bootstrapSshCodes.has(trace.bootstrapSshLastError)
            ? trace.bootstrapSshLastError
            : "hyper-v-bootstrap-ssh-unavailable";
    }
    if (trace.networkFinalizeAttempts > 0 && !trace.networkFinalizeSucceeded) {
        return "hyper-v-bootstrap-network-finalize-failed";
    }
    return fallback;
}

export function compareHyperVLinuxEd25519HostKeyFingerprint(expectedFingerprint: string, sshDiagnostic: string): {
    observed: boolean;
    matchesExpected: boolean | null;
} {
    const expected = /^SHA256:[A-Za-z0-9+/]{43}$/.test(expectedFingerprint) ? expectedFingerprint : "";
    if (!expected) return { observed: false, matchesExpected: null };
    const observed = new Set<string>();
    const bounded = sshDiagnostic.slice(0, 64 * 1024);
    const patterns = [
        /server host key:\s+ssh-ed25519\s+(SHA256:[A-Za-z0-9+/]{43})=?/gi,
        /fingerprint for the ED25519 key sent by (?:the )?remote host is\s+(SHA256:[A-Za-z0-9+/]{43})=?/gi,
    ];
    for (const pattern of patterns) {
        for (const match of bounded.matchAll(pattern)) observed.add(match[1]);
    }
    if (observed.size === 0) return { observed: false, matchesExpected: null };
    return { observed: true, matchesExpected: observed.size === 1 && observed.has(expected) };
}

function commandToleratesMissingMacosVmDelete(parsed: CommandParamSuccess, result: ProviderCommandResult) {
    if (parsed.backend !== "macos-vm" || parsed.command !== "device_delete" || !parsed.force) return false;
    if (result.provider !== "tart") return false;
    const output = `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
    return output.includes("does not exist") || output.includes("not found");
}

function commandToleratesStoppedAndroidEmulatorStatus(parsed: CommandParamSuccess, device: unknown, result: ProviderCommandResult) {
    return parsed.backend === "android-emulator"
        && parsed.command === "device_status"
        && field(device, "status") === "stopped"
        && result.provider === "adb";
}

function collectGuids(value: unknown, output = new Set<string>()) {
    if (typeof value === "string") {
        for (const match of value.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
            output.add(match[0].toLowerCase());
        }
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectGuids(item, output);
        return output;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) collectGuids(item, output);
    }
    return output;
}

export function windowsSandboxSessionIdsFromBrokerListOutput(stdout: string) {
    try {
        return [...collectGuids(JSON.parse(stdout))];
    } catch {
        return [...collectGuids(stdout)];
    }
}

function sleepSync(ms: number) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

export function waitForBrokerWindowsMinimizeConfirmation(resultPath: string, timeoutMs = DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_CONFIRM_TIMEOUT_MS): ProviderCommandResult {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
        if (existsSync(resultPath)) {
            let result: string;
            try {
                const content = readDeviceLabTextFile(resultPath, "windows-sandbox-minimize-result", DEVICE_BROKER_WINDOWS_MINIMIZE_RESULT_LIMIT_BYTES);
                if (content === null) throw new Error("windows-sandbox-minimize-result-missing");
                result = content.trim();
            } catch (error) {
                return {
                    mode: "exec",
                    provider: "windows-sandbox-window",
                    status: 1,
                    stdout: "",
                    stderr: `Windows Sandbox window minimization result is invalid: ${deviceLabStateFileErrorCode(error) || (error instanceof Error ? error.message : String(error))}`,
                };
            }
            return {
                mode: "exec",
                provider: "windows-sandbox-window",
                status: result === "minimized" ? 0 : 1,
                stdout: result,
                stderr: result === "minimized" ? "" : `Windows Sandbox window minimization reported ${result || "an empty result"}`,
            };
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        sleepSync(Math.min(250, remainingMs));
    }
    return {
        mode: "exec",
        provider: "windows-sandbox-window",
        status: null,
        timedOut: true,
        stdout: "",
        stderr: "",
        error: `Windows Sandbox window was not minimized within ${timeoutMs}ms`,
    };
}

type WindowsSandboxRuntimeRegistration =
    | { ok: true; sandboxId: string; requestedSandboxId?: string; matchedRequested: boolean; result?: ProviderCommandResult }
    | { ok: false; error: ProviderCommandResult };

type WindowsSandboxRuntimeSnapshot =
    | { ok: true; sandboxIds: string[]; result?: ProviderCommandResult }
    | { ok: false; error: ProviderCommandResult };

type MacosVmBootRegistration =
    | { ok: true; ready: boolean; skipped?: boolean; sshHost?: string; result?: ProviderCommandResult; attempts?: ProviderCommandResult[] }
    | { ok: false; error: ProviderCommandResult; attempts?: ProviderCommandResult[] };

type AndroidEmulatorBootRegistration =
    | { ok: true; ready: boolean; skipped?: boolean; result?: ProviderCommandResult; attempts?: ProviderCommandResult[] }
    | { ok: false; ready: false; error: ProviderCommandResult; attempts?: ProviderCommandResult[] };

function brokerWindowsSandboxRuntimeSnapshot(command: ProviderCommand, normalized: NormalizedBrokerOptions): WindowsSandboxRuntimeSnapshot {
    if (normalized.platform !== "win32") {
        return { ok: true, sandboxIds: [] };
    }
    if (!command.executable || !command.sandboxId) {
        return { ok: false, error: {
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            status: null,
            error: "windows-sandbox-start-missing-registration-metadata",
        } };
    }
    const result = normalized.commandRunner({
        mode: "exec",
        provider: "wsb",
        executable: command.executable,
        args: ["list", "--raw"],
    }, {
        timeoutMs: DEVICE_BROKER_WINDOWS_SANDBOX_LIST_TIMEOUT_MS,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
    });
    if (!commandSucceeded(result)) {
        return { ok: false, error: {
            ...result,
            error: result.error || "windows-sandbox-runtime-snapshot-failed",
        } };
    }
    return {
        ok: true,
        sandboxIds: windowsSandboxSessionIdsFromBrokerListOutput(result.stdout || ""),
        result,
    };
}

function waitForBrokerWindowsSandboxRuntime(command: ProviderCommand, normalized: NormalizedBrokerOptions, baselineSandboxIds: string[]): WindowsSandboxRuntimeRegistration {
    if (normalized.platform !== "win32") {
        return { ok: true, sandboxId: command.sandboxId || "", matchedRequested: true };
    }
    if (!command.executable || !command.sandboxId) {
        return { ok: false, error: {
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: command.args || [],
            status: null,
            error: "windows-sandbox-start-missing-registration-metadata",
        } };
    }
    const expected = command.sandboxId.toLowerCase();
    const baseline = new Set(baselineSandboxIds.map((sandboxId) => sandboxId.toLowerCase()));
    const deadline = Date.now() + DEVICE_BROKER_WINDOWS_SANDBOX_REGISTRATION_TIMEOUT_MS;
    let last: ProviderCommandResult | null = null;
    while (Date.now() <= deadline) {
        last = normalized.commandRunner({
            mode: "exec",
            provider: "wsb",
            executable: command.executable,
            args: ["list", "--raw"],
        }, {
            timeoutMs: Math.min(DEVICE_BROKER_WINDOWS_SANDBOX_LIST_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
        if (commandSucceeded(last)) {
            const ids = windowsSandboxSessionIdsFromBrokerListOutput(last.stdout || "");
            const launchedIds = ids.filter((sandboxId) => !baseline.has(sandboxId));
            if (launchedIds.includes(expected)) {
                return { ok: true, sandboxId: expected, matchedRequested: true, result: last };
            }
            if (launchedIds.length === 1) {
                return { ok: true, sandboxId: launchedIds[0], requestedSandboxId: command.sandboxId, matchedRequested: false, result: last };
            }
            if (launchedIds.length > 1) {
                return { ok: false, error: {
                    ...last,
                    error: `Windows Sandbox launch produced ambiguous runtimes: ${launchedIds.join(", ")}`,
                } };
            }
            if (baseline.has(expected)) {
                return { ok: false, error: {
                    ...last,
                    error: `Windows Sandbox runtime ${command.sandboxId} existed before launch; no new owned runtime appeared`,
                } };
            }
        }
        sleepSync(500);
    }
    return { ok: false, error: {
        mode: "exec",
        provider: "wsb",
        executable: command.executable,
        args: ["list", "--raw"],
        status: last?.status ?? null,
        signal: last?.signal,
        stdout: last?.stdout,
        stderr: last?.stderr,
        timedOut: last?.timedOut,
        error: `No new Windows Sandbox runtime for ${command.sandboxId} appeared in wsb list within ${DEVICE_BROKER_WINDOWS_SANDBOX_REGISTRATION_TIMEOUT_MS}ms`,
    } };
}

function waitForBrokerMacosVmBoot(parsed: CommandParamSuccess, device: unknown, command: ProviderCommand, normalized: NormalizedBrokerOptions): MacosVmBootRegistration {
    if (parsed.backend !== "macos-vm" || parsed.command !== "device_start" || parsed.waitForBoot !== true) {
        return { ok: true, ready: false, skipped: true };
    }
    if (command.provider !== "tart" || !command.executable) {
        return { ok: true, ready: false, skipped: true };
    }
    const instance = field(device, "providerInstance");
    if (!instance) {
        return { ok: false, error: {
            mode: "exec",
            provider: command.provider,
            executable: command.executable,
            args: ["ip"],
            status: null,
            error: "missing-provider-metadata: providerInstance",
        } };
    }
    const timeout = Number.isFinite(parsed.bootTimeoutMs)
        ? Math.min(600000, Math.max(1000, Number(parsed.bootTimeoutMs)))
        : 300000;
    const deadline = Date.now() + timeout;
    const attempts: ProviderCommandResult[] = [];
    const ipAttempts = [
        ["ip", instance],
        ["ip", "--resolver=arp", instance],
    ];
    while (Date.now() < deadline) {
        for (const args of ipAttempts) {
            const result = normalized.commandRunner({
                mode: "exec",
                provider: "tart",
                executable: command.executable,
                args,
            }, {
                timeoutMs: Math.min(normalized.commandTimeoutMs, Math.max(1000, deadline - Date.now())),
                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
            });
            attempts.push(result);
            const address = String(result.stdout || "").trim();
            if (commandSucceeded(result) && address) {
                return { ok: true, ready: true, sshHost: address, result, attempts: attempts.slice(-4) };
            }
        }
        sleepSync(Math.min(5000, Math.max(0, deadline - Date.now())));
    }
    const last = attempts.at(-1);
    return { ok: false, error: {
        mode: "exec",
        provider: "tart",
        executable: command.executable,
        args: ["ip", instance],
        status: last?.status ?? null,
        signal: last?.signal,
        stdout: last?.stdout,
        stderr: last?.stderr,
        error: `Timed out waiting for Tart IP for ${instance}`,
    }, attempts: attempts.slice(-8) };
}

function waitForBrokerAndroidEmulatorBoot(parsed: CommandParamSuccess, device: unknown, normalized: NormalizedBrokerOptions): AndroidEmulatorBootRegistration {
    if (parsed.backend !== "android-emulator" || parsed.command !== "device_start" || parsed.waitForBoot !== true) {
        return { ok: true, ready: false, skipped: true };
    }
    const serial = androidSerial(device);
    const adb = executableFor("adb", normalized);
    if (!serial || !adb) {
        return {
            ok: false,
            ready: false,
            error: {
                mode: "exec",
                provider: "adb",
                executable: adb || undefined,
                args: serial ? ["-s", serial, "shell", "getprop", "sys.boot_completed"] : [],
                status: null,
                error: serial ? "missing-executable: adb" : "missing-provider-metadata: serial or port",
            },
        };
    }
    const timeout = Number.isFinite(parsed.bootTimeoutMs)
        ? Math.min(600000, Math.max(1000, Number(parsed.bootTimeoutMs)))
        : 60000;
    const deadline = Date.now() + timeout;
    const attempts: ProviderCommandResult[] = [];
    while (Date.now() < deadline) {
        const result = normalized.commandRunner({
            mode: "exec",
            provider: "adb",
            executable: adb,
            args: ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        }, {
            timeoutMs: Math.min(normalized.commandTimeoutMs, Math.max(1000, deadline - Date.now())),
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
        attempts.push(result);
        if (commandSucceeded(result) && String(result.stdout || "").trim() === "1") {
            return { ok: true, ready: true, result, attempts: attempts.slice(-4) };
        }
        sleepSync(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
    const last = attempts.at(-1);
    return {
        ok: false,
        ready: false,
        error: {
            mode: "exec",
            provider: "adb",
            executable: adb,
            args: ["-s", serial, "shell", "getprop", "sys.boot_completed"],
            status: last?.status ?? null,
            signal: last?.signal,
            stdout: last?.stdout,
            stderr: last?.stderr,
            error: `Timed out waiting for Android emulator ${serial} to boot`,
        },
        attempts: attempts.slice(-8),
    };
}

function mutateDeviceAfterCommand(ownerId: string, parsed: CommandParamSuccess, device: unknown, providerCommand?: ProviderCommand, macosBoot?: MacosVmBootRegistration | null, androidBoot?: AndroidEmulatorBootRegistration | null, windowsMinimizeWatchdog?: ProviderCommandResult | null, windowsMinimizeConfirmation?: ProviderCommandResult | null, execution?: ProviderCommandResult, hyperVGuestReady?: ReturnType<typeof parseHyperVGuestReadyObservation> | null) {
    if (parsed.command === "device_status") return device;
    if (parsed.command === "device_delete") {
        mutateOwnerDevices(ownerId, parsed.stateKey, (devices) => devices.filter((candidate) => {
            return !(candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
        }));
        return null;
    }
    const physical = parsed.stateKey === "android-device" || parsed.stateKey === "ios-device";
    const status = physical
        ? parsed.command === "device_start" ? "attached" : "detached"
        : parsed.command === "device_start" || parsed.command === "device_reboot" ? "running" : "stopped";
    let updated: unknown = null;
    mutateOwnerDevices(ownerId, parsed.stateKey, (devices) => devices.map((candidate) => {
        if (candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId) {
            updated = {
                ...(candidate as object),
                status,
                ...(isHyperVBackend(parsed.backend) && execution ? (() => {
                    const observation = parseHyperVVmObservation(execution.stdout || "");
                    return observation ? {
                        vmId: observation.vmId,
                        vmName: observation.vmName,
                        runtimeState: observation.state,
                        hyperVStatus: observation.status,
                    } : {};
                })() : {}),
                ...(isHyperVBackend(parsed.backend) && (parsed.command === "device_start" || parsed.command === "device_reboot") ? {
                    bootReady: Boolean(hyperVGuestReady),
                    lastBootCheck: hyperVGuestReady
                        ? { ready: true, provider: parsed.backend === "linux-vm" ? "hyper-v-ssh" : "hyper-v-powershell-direct", computerName: hyperVGuestReady.computerName, attempts: hyperVGuestReady.attempts }
                        : null,
                } : {}),
                ...(parsed.backend === "windows-sandbox" && parsed.command === "device_start" ? {
                    minimized: typeof parsed.minimized === "boolean"
                        ? parsed.minimized
                        : (candidate as Record<string, unknown>).minimized !== false,
                    minimizeConfirmed: providerCommand?.windowStyle === "minimized"
                        && Boolean(windowsMinimizeConfirmation && commandSucceeded(windowsMinimizeConfirmation)),
                    ...(providerCommand?.windowStyle === "minimized" && (!windowsMinimizeConfirmation || !commandSucceeded(windowsMinimizeConfirmation)) ? {
                        minimizeWarning: windowsMinimizeConfirmation?.error
                            || windowsMinimizeConfirmation?.stderr
                            || "Windows Sandbox started, but window minimization was not confirmed",
                    } : { minimizeWarning: null }),
                } : {}),
                ...(parsed.backend === "windows-sandbox" && parsed.command === "device_start" && providerCommand?.sandboxId ? { sandboxId: providerCommand.sandboxId } : {}),
                ...(parsed.backend === "windows-sandbox" && parsed.command === "device_start" && providerCommand?.requestedSandboxId ? { requestedSandboxId: providerCommand.requestedSandboxId } : {}),
                ...(physical && parsed.command === "device_stop" ? { leaseClaimId: null, leaseClaimNonce: null } : {}),
                ...(parsed.backend === "windows-sandbox" && parsed.command === "device_start" && typeof windowsMinimizeWatchdog?.pid === "number" ? {
                    minimizeWatchdog: {
                        pid: windowsMinimizeWatchdog.pid,
                        processOwner: "host-broker",
                        startedBy: "broker.windows-sandbox.minimize-watchdog",
                        timeoutMs: DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS,
                        cancelPath: brokerWindowsHelperPaths(ownerId, parsed.deviceId).minimizeWatchdogCancelPath,
                        startedAt: new Date().toISOString(),
                    },
                } : {}),
                ...(parsed.backend === "macos-vm" && parsed.command === "device_start" && macosBoot?.ok ? {
                    bootReady: macosBoot.ready,
                    lastBootCheck: {
                        ready: macosBoot.ready,
                        skipped: macosBoot.skipped === true,
                        provider: "tart",
                        ip: macosBoot.sshHost || null,
                        result: macosBoot.result || null,
                    },
                    ...(macosBoot.sshHost ? {
                        ssh: {
                            ...((candidate as { ssh?: object }).ssh || {}),
                            host: macosBoot.sshHost,
                        },
                    } : {}),
                } : {}),
                ...(parsed.backend === "android-emulator" && parsed.command === "device_start" && androidBoot?.ok ? {
                    bootReady: androidBoot.ready,
                    lastBootCheck: {
                        ready: androidBoot.ready,
                        skipped: androidBoot.skipped === true,
                        provider: "adb",
                        result: androidBoot.result || null,
                    },
                } : {}),
                ...(parsed.backend === "android-emulator" && parsed.command === "device_stop" ? {
                    bootReady: false,
                    lastBootCheck: null,
                } : {}),
                updatedAt: new Date().toISOString(),
            };
            return updated;
        }
        return candidate;
    }));
    return updated || device;
}

function observedDeviceAfterStatus(ownerId: string, parsed: CommandParamSuccess, device: unknown, execution: ProviderCommandResult) {
    if (!device || typeof device !== "object" || Array.isArray(device)) return device;
    if (isHyperVBackend(parsed.backend)) {
        const observation = parsed.command === "device_delete"
            ? parseHyperVDeleteObservation(execution.stdout || "")
            : parseHyperVVmObservation(execution.stdout || "");
        if (!observation) return device;
        const running = observation.state.toLowerCase() === "running";
        return {
            ...(device as Record<string, unknown>),
            vmId: observation.vmId,
            vmName: observation.vmName,
            status: running ? "running" : "stopped",
            runtimeState: observation.state,
            hyperVStatus: observation.status,
            liveSnapshots: (observation.snapshots || [])
                .filter((snapshot) => snapshot.snapshotName.startsWith(`ccc-${ownerId}-`))
                .map((snapshot) => ({ id: snapshot.snapshotId.toLowerCase(), providerName: snapshot.snapshotName, ...(snapshot.snapshotType ? { snapshotType: snapshot.snapshotType } : {}) })),
            ...(typeof observation.uptimeMs === "number" ? { uptimeMs: observation.uptimeMs } : {}),
            ...(observation.diskPath ? { diskPath: observation.diskPath } : {}),
            updatedAt: new Date().toISOString(),
        };
    }
    if (parsed.backend !== "android-emulator" && parsed.backend !== "android-device") return device;
    if (!commandSucceeded(execution) && parsed.backend === "android-emulator" && field(device, "status") === "stopped") {
        return {
            ...(device as Record<string, unknown>),
            runtimeState: "stopped",
            readiness: { state: "stopped", provider: "adb" },
        };
    }
    const adbState = String(execution.stdout || "").trim().toLowerCase();
    if (adbState !== "device") return { ...(device as Record<string, unknown>), runtimeState: adbState || "unknown" };
    return {
        ...(device as Record<string, unknown>),
        status: parsed.backend === "android-device" ? "attached" : "running",
        runtimeState: "running",
        readiness: { state: "ready", provider: "adb" },
    };
}

type LifecycleAuxiliaryCleanup = {
    ok: boolean;
    changed: boolean;
    stateConflict?: boolean;
    appium: Record<string, unknown>;
    recording: Record<string, unknown>;
    minimizeWatchdog: Record<string, unknown>;
};

function cancelBrokerWindowsMinimizeWatchdog(ownerId: string, deviceId: string) {
    const cancelPath = brokerWindowsHelperPaths(ownerId, deviceId).minimizeWatchdogCancelPath;
    try {
        mkdirSync(dirname(cancelPath), { recursive: true });
        writeFileSync(cancelPath, new Date().toISOString(), { mode: 0o600 });
        return { attempted: true, ok: true, cancelPath };
    } catch (error) {
        return {
            attempted: true,
            ok: false,
            cancelPath,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function cleanupLifecycleAuxiliaryRuntime(ownerId: string, parsed: CommandParamSuccess, normalized: NormalizedBrokerOptions): { result: LifecycleAuxiliaryCleanup; device: unknown } | null {
    const observed = readOwnerDevices(ownerId, parsed.stateKey).find((candidate) => {
        return candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as { id?: unknown }).id === parsed.deviceId;
    });
    if (!observed) return null;
    const record = observed as Record<string, unknown>;
    const hasAppium = record.appium !== undefined && record.appium !== null;
    const appiumSignal = hasAppium ? terminateBrokerOwnedAppium(record.appium, normalized) : null;
    const recording = record.recording && typeof record.recording === "object" ? record.recording as Record<string, unknown> : null;
    const recordingSignal = recording ? signalBrokerOwnedRecording(recording, normalized, "SIGINT") : null;
    const minimizeWatchdog = record.minimizeWatchdog && typeof record.minimizeWatchdog === "object" ? record.minimizeWatchdog as Record<string, unknown> : null;
    const minimizeWatchdogOwned = minimizeWatchdog?.processOwner === "host-broker"
        && minimizeWatchdog?.startedBy === "broker.windows-sandbox.minimize-watchdog";
    const minimizeWatchdogCancellation = minimizeWatchdogOwned ? cancelBrokerWindowsMinimizeWatchdog(ownerId, parsed.deviceId) : null;
    const appiumCleared = Boolean(appiumSignal?.ok);
    const recordingCleared = Boolean(recordingSignal?.ok);
    const minimizeWatchdogCleared = Boolean(minimizeWatchdogCancellation?.ok);
    const changed = appiumCleared || recordingCleared || minimizeWatchdogCleared;
    const updated = {
        ...record,
        ...(appiumCleared ? { appium: null } : {}),
        ...(recordingCleared ? { recording: null } : {}),
        ...(minimizeWatchdogCleared ? { minimizeWatchdog: null } : {}),
        ...(changed ? { updatedAt: new Date().toISOString() } : {}),
    };
    let stateConflict = false;
    let currentDevice: unknown = updated;
    if (changed) {
        mutateOwnerDevices(ownerId, parsed.stateKey, (devices) => devices.map((candidate) => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || (candidate as { id?: unknown }).id !== parsed.deviceId) return candidate;
            if (!isDeepStrictEqual(candidate, observed)) {
                stateConflict = true;
                currentDevice = candidate;
                return candidate;
            }
            return updated;
        }));
    }
    const cleanup: LifecycleAuxiliaryCleanup = {
        ok: (!appiumSignal || appiumCleared) && (!recordingSignal || recordingCleared) && (!minimizeWatchdogCancellation || minimizeWatchdogCleared) && !stateConflict,
        changed: changed && !stateConflict,
        ...(stateConflict ? { stateConflict: true } : {}),
        appium: appiumSignal ? { cleared: appiumCleared, signal: appiumSignal } : { cleared: false },
        recording: recordingSignal ? { cleared: recordingCleared, signal: recordingSignal } : { cleared: false },
        minimizeWatchdog: minimizeWatchdogCancellation
            ? { cleared: minimizeWatchdogCleared, cancellation: minimizeWatchdogCancellation }
            : { cleared: false, ...(minimizeWatchdog ? { skipped: true, reason: "not-broker-owned" } : {}) },
    };
    return { result: cleanup, device: currentDevice };
}

function redactBrokerDeviceSecrets(device: unknown) {
    if (!device || typeof device !== "object") return device;
    const record = device as Record<string, unknown>;
    const {
        avdRoot,
        privateRoot,
        sshPrivateKeyPath,
        sshHostPrivateKeyPath,
        guestCredentialPath,
        ...publicRecord
    } = record;
    const ssh = publicRecord.ssh;
    if (!ssh || typeof ssh !== "object") return publicRecord;
    const {
        password,
        privateRoot: sshPrivateRoot,
        sshPrivateKeyPath: nestedPrivateKeyPath,
        sshHostPrivateKeyPath: nestedHostPrivateKeyPath,
        guestCredentialPath: nestedCredentialPath,
        ...publicSsh
    } = ssh as Record<string, unknown>;
    return {
        ...publicRecord,
        ssh: {
            ...publicSsh,
            ...(password ? { passwordConfigured: true } : {}),
        },
    };
}

function redactBrokerCreateSecrets(create: unknown) {
    if (!create || typeof create !== "object" || !("sshPassword" in create)) return create;
    const { sshPassword, ...publicCreate } = create as Record<string, unknown>;
    return {
        ...publicCreate,
        ...(sshPassword ? { sshPasswordConfigured: true } : {}),
    };
}

function hyperVCreateConfigurationConflicts(device: Record<string, unknown>, parsed: CommandParamSuccess): string[] {
    const create = parsed.create || {};
    const linuxGuest = parsed.backend === "linux-vm";
    const expected: Record<string, unknown> = {
        name: String(create.name || parsed.deviceId),
        profile: typeof create.profile === "string" ? create.profile : linuxGuest ? "ubuntu-lts" : "windows-11",
        memoryMb: typeof create.memoryMb === "number" ? create.memoryMb : 4096,
        cpus: typeof create.cpus === "number" ? create.cpus : 2,
        networking: create.networking !== false,
        ...hyperVSecureBootConfiguration(parsed.backend),
    };
    if (typeof create.diskMaxBytes === "number") expected.diskMaxBytes = create.diskMaxBytes;
    if (typeof create.baseImageSha256 === "string") expected.baseImageSha256 = create.baseImageSha256.toLowerCase();
    if (typeof create.sourceImage === "string") expected.sourceImage = create.sourceImage;
    return Object.entries(expected)
        .filter(([key, value]) => device[key] !== value)
        .map(([key]) => key);
}

function lifecycleCommandPlan(ownerId: string, params: unknown, normalized?: NormalizedBrokerOptions, redactSecrets = true) {
    const parsed = validateCommandParams(params);
    if (!parsed.ok) return commandParamError(parsed);
    let devices: unknown[];
    try {
        devices = readOwnerDevices(ownerId, parsed.stateKey);
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    const device = devices.find((candidate) => {
        return candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId;
    });
    if (device && isHyperVBackend(parsed.backend) && parsed.command !== "device_create" && parsed.command !== "device_status") {
        if (!validHyperVIncarnationId(parsed.expectedIncarnationId)) {
            return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-required", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
        }
        const currentIncarnationId = device && typeof device === "object" && !Array.isArray(device)
            ? hyperVDeviceIncarnationId(device as Record<string, unknown>)
            : null;
        if (currentIncarnationId !== parsed.expectedIncarnationId) {
            return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-conflict", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
        }
    }
    if (parsed.command === "device_create") {
        if (device) {
            if (isHyperVBackend(parsed.backend)) {
                const record = device as Record<string, unknown>;
                const conflicts = hyperVCreateConfigurationConflicts(record, parsed);
                if (conflicts.length === 0) {
                    return {
                        status: 200,
                        payload: {
                            ok: true,
                            result: {
                                ownerId,
                                backend: parsed.backend,
                                stateKey: parsed.stateKey,
                                command: parsed.command,
                                deviceId: parsed.deviceId,
                                device: redactSecrets ? redactHyperVDeviceSecrets(record) : record,
                                idempotent: true,
                                providerCommand: null,
                                execution: { mode: "idempotent", providerExecution: "not-required", mutatesHost: false },
                            },
                        },
                    };
                }
                return {
                    status: 409,
                    payload: {
                        ok: false,
                        error: "hyper-v-create-configuration-conflict",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        conflicts,
                    },
                };
            }
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "owner-device-already-exists",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
        let effectiveParsed = parsed;
        if (parsed.backend === "android-emulator") {
            const allocation = resolveAndroidEmulatorCreatePort(ownerId, parsed);
            if (!allocation.ok) {
                return {
                    status: allocation.status,
                    payload: {
                        ok: false,
                        error: allocation.error,
                        ...(allocation.allowed ? { allowed: allocation.allowed } : {}),
                        ...(allocation.detail ? { detail: allocation.detail } : {}),
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                    },
                };
            }
            effectiveParsed = { ...parsed, create: { ...(parsed.create || {}), port: allocation.port } };
        }
        let plannedDevice: unknown;
        try {
            plannedDevice = createOwnerDeviceRecord(ownerId, effectiveParsed);
            assertOwnerDeviceStateWritable([...devices, plannedDevice], DEVICE_BROKER_INVENTORY_FILE_LIMIT);
        } catch (error) {
            return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId,
                    backend: parsed.backend,
                    stateKey: parsed.stateKey,
                    command: parsed.command,
                    deviceId: parsed.deviceId,
                    force: parsed.force,
                    dryRun: parsed.dryRun,
                    device: redactSecrets
                        ? redactBrokerDeviceSecrets(plannedDevice)
                        : plannedDevice,
                    create: redactSecrets && isHyperVBackend(parsed.backend)
                        ? publicHyperVCreateConfiguration({
                            ...(effectiveParsed.create || {}),
                            ...hyperVSecureBootConfiguration(parsed.backend),
                        })
                        : redactBrokerCreateSecrets(effectiveParsed.create),
                    providerCommand: normalized
                        ? redactSecrets && isHyperVBackend(parsed.backend)
                            ? { mode: "powershell", provider: "hyper-v" }
                            : providerCommandForCreate(ownerId, effectiveParsed, normalized)
                        : null,
                    execution: {
                        mode: "planned",
                        providerExecution: normalized ? "available" : "deferred",
                        mutatesHost: false,
                    },
                },
            },
        };
    }
    if (!device) {
        if (isHyperVBackend(parsed.backend) && parsed.command === "device_delete") {
            return {
                status: 200,
                payload: {
                    ok: true,
                    result: {
                        ownerId,
                        backend: parsed.backend,
                        stateKey: parsed.stateKey,
                        command: parsed.command,
                        deviceId: parsed.deviceId,
                        device: null,
                        idempotent: true,
                        alreadyMissing: true,
                        providerCommand: null,
                        execution: { mode: "idempotent", providerExecution: "not-required", mutatesHost: false },
                    },
                },
            };
        }
        return {
            status: 404,
            payload: {
                ok: false,
                error: "owner-device-not-found",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
            },
        };
    }
    if ((parsed.stateKey === "android-device" || parsed.stateKey === "ios-device") && parsed.command === "device_start") {
        const record = device as Record<string, unknown>;
        const leaseMatches = physicalDeviceLeaseMatches(ownerId, parsed.stateKey, parsed.deviceId, record);
        if (record.status !== "attached" || !leaseMatches) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "physical-device-not-attached",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    remedy: "attach the physical device before starting it",
                },
            };
        }
    }
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                command: parsed.command,
                deviceId: parsed.deviceId,
                force: parsed.force,
                dryRun: parsed.dryRun,
                device: redactSecrets && isHyperVBackend(parsed.backend)
                    ? redactHyperVDeviceSecrets(device)
                    : redactSecrets ? redactBrokerDeviceSecrets(device) : device,
                providerCommand: normalized
                    ? redactSecrets && isHyperVBackend(parsed.backend)
                        ? { mode: "powershell", provider: "hyper-v" }
                        : providerCommandFor(ownerId, parsed, device, normalized)
                    : null,
                execution: {
                    mode: "planned",
                    providerExecution: normalized ? "available" : "deferred",
                    mutatesHost: false,
                },
            },
        },
    };
}

async function lifecycleCommandInvokeUnlocked(
    ownerId: string,
    params: unknown,
    normalized: NormalizedBrokerOptions,
    physicalLeaseGuard?: PhysicalLeaseReleaseGuard,
    hyperVDeadlineAt = Number.POSITIVE_INFINITY,
    hyperVCleanupDeadlineAt = hyperVDeadlineAt,
): Promise<BrokerRpcResult> {
    const parsed = validateCommandParams(params);
    if (!parsed.ok) return commandParamError(parsed);
    const androidCreateAvdRoot = parsed.backend === "android-emulator"
        && parsed.command === "device_create"
        && parsed.create?.createAvd === true
        ? androidAvdHome()
        : null;
    const plan = lifecycleCommandPlan(ownerId, params, normalized, false);
    if (plan.status !== 200) return plan;
    const payload = plan.payload as { result?: { create?: unknown; device?: unknown; idempotent?: boolean; providerCommand?: ProviderCommand | { error: string; missing: string[] } } };
    if (parsed.dryRun) {
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ...(isHyperVBackend(parsed.backend)
                        ? redactHyperVResultSecrets(payload.result)
                        : payload.result || {}),
                    invoked: false,
                    dryRun: true,
                    execution: {
                        mode: "dry-run",
                        providerExecution: "available",
                        mutatesHost: false,
                    },
                },
            },
        };
    }
    if (payload.result?.idempotent) {
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ...(isHyperVBackend(parsed.backend)
                        ? redactHyperVResultSecrets(payload.result)
                        : payload.result),
                    invoked: false,
                    dryRun: false,
                    execution: { mode: "idempotent", providerExecution: "not-required", mutatesHost: false },
                },
            },
        };
    }
    if (parsed.command === "device_create") {
        const providerCommand = payload.result?.providerCommand;
        if (providerCommand && "error" in providerCommand) {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error: providerCommand.error,
                    missing: providerCommand.missing || [],
                    plan: isHyperVBackend(parsed.backend)
                        ? redactHyperVResultSecrets(payload.result)
                        : payload.result || null,
                },
            };
        }
        if (parsed.backend === "android-emulator" && parsed.create?.createAvd === true) {
            const avdName = field(payload.result?.device, "avdName");
            if (!avdName || !androidCreateAvdRoot || !ownedAndroidAvdName(avdName, ownerId)) {
                return {
                    status: 409,
                    payload: {
                        ok: false,
                        error: "android-avd-create-identity-unavailable",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                    },
                };
            }
            try {
                if (listOwnedAndroidAvdArtifacts(ownerId, { root: androidCreateAvdRoot })
                    .some((artifact) => artifact.name === avdName)) {
                    return {
                        status: 409,
                        payload: {
                            ok: false,
                            error: "android-avd-artifacts-already-exist",
                            ownerId,
                            backend: parsed.backend,
                            deviceId: parsed.deviceId,
                        },
                    };
                }
            } catch {
                return {
                    status: 409,
                    payload: {
                        ok: false,
                        error: "android-avd-storage-preflight-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                    },
                };
            }
        }
        let execution: ProviderCommandResult = { mode: "noop", provider: "host-broker-state", status: 0, stdout: "", stderr: "" };
        let hyperVProvisioningExecution: ReturnType<typeof redactProviderCommandInput> | null = null;
        if (providerCommand && providerCommand.mode !== "noop") {
            if (isHyperVBackend(parsed.backend)) {
                try {
                    ensureHyperVPrivateDeviceRoot(ownerId, parsed.backend, parsed.deviceId);
                } catch (error) {
                    return {
                        status: 409,
                        payload: {
                            ok: false,
                            error: "hyper-v-private-root-invalid",
                            ownerId,
                            backend: parsed.backend,
                            deviceId: parsed.deviceId,
                            detail: hyperVBoundedErrorCode(
                                error,
                                "hyper-v-private-root-invalid",
                            ),
                        },
                    };
                }
            }
            execution = isHyperVBackend(parsed.backend)
                ? await hyperVProviderCommandRunner(normalized, providerCommand, {
                    timeoutMs: hyperVRemainingTimeout(hyperVDeadlineAt, 120000),
                    outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                })
                : normalized.commandRunner(providerCommand, {
                timeoutMs: parsed.backend === "android-emulator" && parsed.create?.createAvd === true
                    ? 300000
                    : normalized.commandTimeoutMs,
                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                });
            if (isHyperVBackend(parsed.backend) && hyperVOperationDeadlineExpired(hyperVDeadlineAt)) {
                const rollback = await reconcileHyperVCreateResidue(ownerId, parsed.backend, parsed.deviceId, normalized, hyperVCleanupDeadlineAt, parsed.create?.incarnationId as string | undefined);
                return {
                    status: 504,
                    payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback },
                };
            }
            if (!commandSucceeded(execution)) {
                const rollback = isHyperVBackend(parsed.backend)
                    ? await reconcileHyperVCreateResidue(ownerId, parsed.backend, parsed.deviceId, normalized, hyperVCleanupDeadlineAt, parsed.create?.incarnationId as string | undefined)
                    : null;
                let androidRollback: Record<string, unknown> | null = null;
                if (parsed.backend === "android-emulator" && parsed.command === "device_create" && parsed.create?.createAvd === true) {
                    const avdName = field(payload.result?.device, "avdName");
                    if (avdName && androidCreateAvdRoot && ownedAndroidAvdName(avdName, ownerId)) {
                        try {
                            const cleanup = removeOwnedAndroidAvdArtifacts(avdName, ownerId, {
                                root: androidCreateAvdRoot,
                                verifyInactive: () => androidAvdIsInactiveForBroker(avdName, normalized),
                            });
                            androidRollback = { ok: true, artifactsRemoved: cleanup.removed };
                        } catch {
                            androidRollback = { ok: false, error: "android-avd-artifact-cleanup-failed" };
                        }
                    } else {
                        androidRollback = {
                            ok: false,
                            error: "android-avd-create-identity-unavailable",
                        };
                    }
                }
                const hyperVExecution = isHyperVBackend(parsed.backend)
                    ? redactProviderCommandInput(execution, true, "hyper-v-provider-command-failed")
                    : null;
                return {
                    status: 502,
                    payload: {
                        ok: false,
                        error: "provider-command-failed",
                        detail: hyperVExecution?.diagnosticCode || providerFailureDetail(execution),
                        ...(rollback ? { rollback } : {}),
                        ...(androidRollback ? { rollback: androidRollback } : {}),
                        result: {
                            ...(isHyperVBackend(parsed.backend)
                                ? redactHyperVResultSecrets(payload.result)
                                : payload.result
                                    ? {
                                        ...payload.result,
                                        device: redactBrokerDeviceSecrets(payload.result.device),
                                    }
                                    : {}),
                            invoked: true,
                            dryRun: false,
                            execution: {
                                mode: execution.mode,
                                providerExecution: "executed",
                                mutatesHost: false,
                                ...(!isHyperVBackend(parsed.backend) ? { command: execution } : {}),
                            },
                        },
                    },
                };
            }
        }
        let persistedParsed = parsed.backend === "android-emulator" && payload.result?.create && typeof payload.result.create === "object"
            ? { ...parsed, create: payload.result.create as Record<string, unknown> }
            : parsed;
        if (parsed.backend === "ios-simulator" && parsed.create?.createSimulator === true && execution.mode !== "noop") {
            const udid = iosSimulatorCreatedUdid(execution.stdout);
            if (!udid) {
                return {
                    status: 502,
                    payload: { ok: false, error: "ios-simulator-create-invalid-udid", ownerId, deviceId: parsed.deviceId },
                };
            }
            persistedParsed = { ...parsed, create: { ...(parsed.create || {}), udid } };
        }
        if (parsed.backend === "linux-vm" && execution.mode !== "noop") {
            const observation = parseHyperVVmObservation(execution.stdout || "");
            const expectedVmName = hyperVVmName(ownerId, parsed.deviceId, String(parsed.create?.incarnationId || ""));
            const deviceRoot = hyperVDeviceRoot(ownerId, "linux-vm", parsed.deviceId);
            const privateRoot = hyperVPrivateDeviceRoot(ownerId, "linux-vm", parsed.deviceId);
            const expectedDiskPath = join(deviceRoot, "disks", "root.vhdx");
            if (!observation
                || observation.vmName !== expectedVmName
                || resolve(observation.diskPath || "") !== resolve(expectedDiskPath)
                || observation.generation !== parsed.create?.baseImageGeneration) {
                const rollback = await reconcileHyperVCreateResidue(ownerId, parsed.backend, parsed.deviceId, normalized, hyperVCleanupDeadlineAt, parsed.create?.incarnationId as string | undefined);
                return { status: 502, payload: { ok: false, error: "hyper-v-create-invalid-result", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback } };
            }
            const guestUsername = `ccc${ownerId.slice(0, 8)}`;
            const seedDiskPath = join(deviceRoot, "disks", "cidata.iso");
            const sshPrivateKeyPath = join(privateRoot, "secrets", "id_ed25519");
            const sshPublicKeyPath = `${sshPrivateKeyPath}.pub`;
            const sshHostPrivateKeyPath = join(privateRoot, "secrets", "ssh_host_ed25519_key");
            const sshHostPublicKeyPath = `${sshHostPrivateKeyPath}.pub`;
            const knownHostsPath = join(privateRoot, "secrets", "known_hosts");
            const observedParsed = { ...parsed, create: { ...(parsed.create || {}), vmId: observation.vmId, guestUsername } };
            const rollbackDevice = createOwnerDeviceRecord(ownerId, observedParsed) as Record<string, unknown>;
            const rollbackProvisioning = () => {
                return rollbackProviderCreateAfterConflict(observedParsed, rollbackDevice, null, providerCommand && !("error" in providerCommand) ? providerCommand : null, normalized, hyperVCleanupDeadlineAt);
            };
            let seedCommand: ProviderCommand;
            try {
                assertHyperVPrivateDeviceRoot(ownerId, "linux-vm", parsed.deviceId, privateRoot);
                seedCommand = hyperVLinuxSeedCommand({
                    executable: providerCommand?.executable || "powershell.exe",
                    ownerId,
                    deviceId: parsed.deviceId,
                    incarnationId: String(parsed.create?.incarnationId || ""),
                    vmName: expectedVmName,
                    vmId: observation.vmId,
                    diskPath: expectedDiskPath,
                    deviceRoot,
                    privateRoot,
                    seedDiskPath,
                    sshPrivateKeyPath,
                    sshPublicKeyPath,
                    sshHostPrivateKeyPath,
                    sshHostPublicKeyPath,
                    knownHostsPath,
                    guestUsername,
                    networkAddress: String(parsed.create?.networkAddress || ""),
                    networkGateway: String(parsed.create?.networkGateway || ""),
                    networkPrefixLength: typeof parsed.create?.networkPrefix === "string" ? Number(parsed.create.networkPrefix.split("/")[1]) : 24,
                    macAddress: String(parsed.create?.macAddress || ""),
                });
            } catch (error) {
                const rollback = await rollbackProvisioning();
                return {
                    status: rollback.ok ? 500 : 502,
                    payload: {
                        ok: false,
                        error: "hyper-v-linux-seed-plan-failed",
                        ownerId,
                        deviceId: parsed.deviceId,
                        detail: hyperVBoundedErrorCode(
                            error,
                            "hyper-v-linux-seed-plan-failed",
                        ),
                        rollback,
                    },
                };
            }
            const seedExecution = await hyperVProviderCommandRunner(normalized, seedCommand, { timeoutMs: hyperVRemainingTimeout(hyperVDeadlineAt, 180000), outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
            hyperVProvisioningExecution = redactProviderCommandInput(
                seedExecution,
                true,
                "hyper-v-linux-seed-command-failed",
            );
            if (hyperVOperationDeadlineExpired(hyperVDeadlineAt)) {
                const rollback = await rollbackProvisioning();
                return { status: 504, payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback } };
            }
            if (!commandSucceeded(seedExecution)) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-linux-seed-failed", ownerId, deviceId: parsed.deviceId, provisioning: hyperVProvisioningExecution, rollback } };
            }
            let seedResult: Record<string, unknown> | null = null;
            try {
                const line = String(seedExecution.stdout || "").trim().split(/\r?\n/).at(-1) || "";
                const value = JSON.parse(line);
                seedResult = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
            } catch { seedResult = null; }
            const sshHostKeyFingerprint = String(seedResult?.sshHostKeyFingerprint || "");
            let seedFilesAvailable = false;
            try {
                seedFilesAvailable = Boolean(seedResult
                    && resolve(String(seedResult.sshHostPublicKeyPath || "")) === resolve(sshHostPublicKeyPath)
                    && resolve(String(seedResult.knownHostsPath || "")) === resolve(knownHostsPath)
                    && /^SHA256:[A-Za-z0-9+/]{43}$/.test(sshHostKeyFingerprint)
                    && validateHyperVLinuxSshHostIdentity(ownerId, parsed.deviceId, sshHostPublicKeyPath, knownHostsPath, String(parsed.create?.networkAddress || ""), sshHostKeyFingerprint));
            } catch { seedFilesAvailable = false; }
            if (!seedResult || seedResult.ok !== true || String(seedResult.vmId).toLowerCase() !== observation.vmId || resolve(String(seedResult.seedDiskPath || "")) !== resolve(seedDiskPath) || !seedFilesAvailable) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-linux-seed-invalid-result", ownerId, deviceId: parsed.deviceId, rollback } };
            }
            persistedParsed = { ...parsed, create: { ...(parsed.create || {}), vmId: observation.vmId, ...(observation.switchName ? { switchName: observation.switchName } : {}), guestUsername, guestProvisioned: true, sshHostKeyFingerprint } };
        }
        if (parsed.backend === "windows-vm" && execution.mode !== "noop") {
            const observation = parseHyperVVmObservation(execution.stdout || "");
            const expectedVmName = hyperVVmName(ownerId, parsed.deviceId, String(parsed.create?.incarnationId || ""));
            const expectedDiskPath = join(hyperVDeviceRoot(ownerId, "windows-vm", parsed.deviceId), "disks", "root.vhdx");
            if (!observation
                || observation.vmName !== expectedVmName
                || resolve(observation.diskPath || "") !== resolve(expectedDiskPath)
                || observation.generation !== parsed.create?.baseImageGeneration) {
                const rollback = await reconcileHyperVCreateResidue(ownerId, parsed.backend, parsed.deviceId, normalized, hyperVCleanupDeadlineAt, parsed.create?.incarnationId as string | undefined);
                return {
                    status: 502,
                    payload: { ok: false, error: "hyper-v-create-invalid-result", ownerId, deviceId: parsed.deviceId, rollback },
                };
            }
            const deviceRoot = hyperVDeviceRoot(ownerId, "windows-vm", parsed.deviceId);
            const privateRoot = hyperVPrivateDeviceRoot(ownerId, "windows-vm", parsed.deviceId);
            const credentialPath = join(privateRoot, "secrets", "guest.credential.xml");
            const provisioningMediaPath = join(deviceRoot, "disks", "autounattend.iso");
            const guestUsername = `ccc${ownerId.slice(0, 8)}`;
            const guestPassword = `Ccc!7${randomBytes(24).toString("base64url")}`;
            const observedParsed = { ...parsed, create: { ...(parsed.create || {}), vmId: observation.vmId } };
            const rollbackDevice = createOwnerDeviceRecord(ownerId, observedParsed) as Record<string, unknown>;
            const rollbackProvisioning = () => {
                return rollbackProviderCreateAfterConflict(observedParsed, rollbackDevice, null, providerCommand && !("error" in providerCommand) ? providerCommand : null, normalized, hyperVCleanupDeadlineAt);
            };
            let provisionCommand: ProviderCommand;
            try {
                assertHyperVPrivateDeviceRoot(ownerId, "windows-vm", parsed.deviceId, privateRoot);
                provisionCommand = hyperVGuestProvisionCommand({
                    executable: providerCommand?.executable || "powershell.exe",
                    ownerId,
                    deviceId: parsed.deviceId,
                    incarnationId: String(parsed.create?.incarnationId || ""),
                    vmName: expectedVmName,
                    vmId: observation.vmId,
                    diskPath: expectedDiskPath,
                    deviceRoot,
                    privateRoot,
                    credentialPath,
                    provisioningMediaPath,
                    guestUsername,
                    guestPassword,
                    networkAddress: typeof parsed.create?.networkAddress === "string" ? parsed.create.networkAddress : null,
                    networkGateway: typeof parsed.create?.networkGateway === "string" ? parsed.create.networkGateway : null,
                    networkPrefixLength: typeof parsed.create?.networkPrefix === "string"
                        ? Number(parsed.create.networkPrefix.split("/")[1])
                        : null,
                });
            } catch (error) {
                const rollback = await rollbackProvisioning();
                return {
                    status: rollback.ok ? 500 : 502,
                    payload: {
                        ok: false,
                        error: "hyper-v-guest-provision-plan-failed",
                        ownerId,
                        deviceId: parsed.deviceId,
                        detail: hyperVBoundedErrorCode(
                            error,
                            "hyper-v-guest-provision-plan-failed",
                        ),
                        rollback,
                    },
                };
            }
            const rawProvisioningExecution = await hyperVProviderCommandRunner(normalized, provisionCommand, { timeoutMs: hyperVRemainingTimeout(hyperVDeadlineAt, 180000), outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
            hyperVProvisioningExecution = redactProviderCommandInput(
                rawProvisioningExecution,
                true,
                "hyper-v-guest-provision-command-failed",
            );
            if (hyperVOperationDeadlineExpired(hyperVDeadlineAt)) {
                const rollback = await rollbackProvisioning();
                return { status: 504, payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback } };
            }
            if (!commandSucceeded(rawProvisioningExecution)) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-guest-provision-failed", ownerId, deviceId: parsed.deviceId, provisioning: hyperVProvisioningExecution, rollback } };
            }
            const provisioned = parseHyperVGuestProvisionObservation(rawProvisioningExecution.stdout || "");
            let credentialAvailable = false;
            try {
                credentialAvailable = withDeviceLabReadableFile(credentialPath, "hyper-v-guest-credential", 64 * 1024, () => true) === true;
            } catch {
                credentialAvailable = false;
            }
            if (!provisioned
                || provisioned.vmId !== observation.vmId
                || provisioned.vmName !== expectedVmName
                || provisioned.guestUsername !== guestUsername
                || resolve(provisioned.credentialPath) !== resolve(credentialPath)
                || resolve(provisioned.unattendPath) !== resolve(provisioningMediaPath)
                || !credentialAvailable) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-guest-provision-invalid-result", ownerId, deviceId: parsed.deviceId, provisioning: hyperVProvisioningExecution, rollback } };
            }
            persistedParsed = {
                ...parsed,
                create: {
                    ...(parsed.create || {}),
                    vmId: observation.vmId,
                    ...(observation.switchName ? { switchName: observation.switchName } : {}),
                    guestUsername,
                    guestProvisioned: true,
                    guestUnattendPath: provisioned.unattendPath,
                },
            };
        }
        const device = createOwnerDeviceRecord(ownerId, persistedParsed) as Record<string, unknown>;
        if (parsed.backend === "android-emulator" && parsed.create?.createAvd === true) {
            if (!androidCreateAvdRoot) {
                return {
                    status: 502,
                    payload: {
                        ok: false,
                        error: "android-avd-root-unavailable",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                    },
                };
            }
            device.avdRoot = androidCreateAvdRoot;
        }
        let claim;
        try {
            claim = claimOwnerDevice(ownerId, parsed.stateKey, device, createOwnerDeviceUniqueFields(persistedParsed));
        } catch (error) {
            const rollback = await rollbackProviderCreateAfterConflict(
                persistedParsed,
                device,
                null,
                providerCommand && !("error" in providerCommand) ? providerCommand : null,
                normalized,
                hyperVCleanupDeadlineAt,
            );
            if (!rollback.ok) {
                return {
                    status: 502,
                    payload: {
                        ok: false,
                        error: "owner-device-state-rollback-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        stateError: ownerDeviceStateErrorCode(error) || "owner-state-write-failed",
                        rollback,
                    },
                };
            }
            const failure = ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
            return {
                ...failure,
                payload: { ...(failure.payload as Record<string, unknown>), rollback },
            };
        }
        if (!claim.ok) {
            const rollback = await rollbackProviderCreateAfterConflict(
                persistedParsed,
                device,
                claim.existing,
                providerCommand && !("error" in providerCommand) ? providerCommand : null,
                normalized,
                hyperVCleanupDeadlineAt,
            );
            return {
                status: rollback.ok ? 409 : 502,
                payload: {
                    ok: false,
                    error: rollback.ok ? claim.error : "owner-device-conflict-rollback-failed",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    field: claim.field,
                    value: claim.value,
                    existing: isHyperVBackend(parsed.backend)
                        ? redactHyperVDeviceSecrets(claim.existing)
                        : redactBrokerDeviceSecrets(claim.existing),
                    rollback,
                },
            };
        }
        if (parsed.backend === "windows-sandbox") {
            try {
                writeBrokerWindowsConfig(ownerId, parsed.deviceId, persistedParsed.create || {}, normalized);
            } catch (error) {
                mutateOwnerDevices(ownerId, parsed.stateKey, (devices) => devices.filter((candidate) => {
                    if (!candidate || typeof candidate !== "object") return true;
                    const record = candidate as Record<string, unknown>;
                    return record.id !== device.id || record.createdAt !== device.createdAt;
                }));
                return {
                    status: 500,
                    payload: {
                        ok: false,
                        error: "windows-sandbox-config-write-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        detail: error instanceof Error ? error.message : String(error),
                    },
                };
            }
        }
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ...(isHyperVBackend(parsed.backend)
                        ? redactHyperVResultSecrets(payload.result)
                        : payload.result || {}),
                    device: isHyperVBackend(parsed.backend)
                        ? redactHyperVDeviceSecrets(device)
                        : redactBrokerDeviceSecrets(device),
                    invoked: true,
                    dryRun: false,
                    execution: isHyperVBackend(parsed.backend) ? {
                        mode: execution.mode === "noop" ? "state" : execution.mode,
                        providerExecution: execution.mode === "noop" ? "broker-state" : "executed",
                        mutatesHost: true,
                        ...(execution.provider ? { provider: execution.provider } : {}),
                        ...(typeof execution.status === "number" ? { status: execution.status } : {}),
                        ...(hyperVProvisioningExecution ? { provisioning: {
                            provider: hyperVProvisioningExecution.provider,
                            status: hyperVProvisioningExecution.status,
                        } } : {}),
                    } : {
                        mode: execution.mode === "noop" ? "state" : execution.mode,
                        providerExecution: execution.mode === "noop" ? "broker-state" : "executed",
                        mutatesHost: true,
                        ...(execution.mode === "noop" ? {} : { command: execution }),
                        ...(hyperVProvisioningExecution ? { provisioning: hyperVProvisioningExecution } : {}),
                    },
                },
            },
        };
    }
    const physicalTeardown = (parsed.stateKey === "android-device" || parsed.stateKey === "ios-device")
        && (parsed.command === "device_stop" || parsed.command === "device_delete");
    if (physicalTeardown && !physicalLeaseGuard) {
        const record = payload.result?.device as Record<string, unknown>;
        return withOwnerPhysicalLeaseReleaseGuard(ownerId, parsed.stateKey, record, (guard) => {
            if (guard.preflight && guard.preflight.status !== 404) {
                const physicalLeaseCleanup = cleanupOwnerPhysicalLease(ownerId, guard);
                return {
                    status: physicalLeaseCleanup.status === 409 ? 409 : 502,
                    payload: {
                        ok: false,
                        error: "physical-lease-cleanup-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        result: {
                            ...(payload.result || {}),
                            physicalLeaseCleanup,
                            invoked: false,
                            dryRun: false,
                        },
                    },
                };
            }
            return lifecycleCommandInvokeUnlocked(ownerId, params, normalized, guard);
        });
    }
    const physicalUse = (parsed.stateKey === "android-device" || parsed.stateKey === "ios-device")
        && (parsed.command === "device_status" || parsed.command === "device_start");
    if (physicalUse) {
        const device = payload.result?.device;
        if (!device || typeof device !== "object" || Array.isArray(device)) {
            return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
        }
        const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, {
            stateKey: parsed.stateKey,
            backend: parsed.backend,
            device: device as Record<string, unknown>,
        }, parsed.deviceId);
        if (leaseFailure) return leaseFailure;
    }
    let providerCommand = payload.result?.providerCommand;
    if (parsed.backend === "windows-sandbox" && parsed.command === "device_start" && !parsed.dryRun) {
        const device = payload.result?.device;
        const recordedConfigPath = field(device, "configPath") || field(device, "wsbConfigPath");
        const canonicalConfigPath = brokerWindowsConfigPath(ownerId, parsed.deviceId);
        if (recordedConfigPath && resolve(recordedConfigPath) === resolve(canonicalConfigPath)) {
            try {
                writeBrokerWindowsConfig(ownerId, parsed.deviceId, device as Record<string, unknown>, normalized);
                providerCommand = providerCommandFor(ownerId, parsed, device, normalized);
            } catch (error) {
                return {
                    status: 500,
                    payload: {
                        ok: false,
                        error: "windows-sandbox-config-refresh-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        detail: error instanceof Error ? error.message : String(error),
                    },
                };
            }
        }
    }
    if (!providerCommand || "error" in providerCommand) {
        return {
            status: 400,
            payload: {
                ok: false,
                error: providerCommand?.error || "missing-provider-command",
                missing: providerCommand?.missing || [],
                plan: isHyperVBackend(parsed.backend)
                    ? redactHyperVResultSecrets(payload.result)
                    : payload.result
                        ? {
                            ...payload.result,
                            device: redactBrokerDeviceSecrets(payload.result.device),
                        }
                        : null,
            },
        };
    }
    if (parsed.backend === "android-emulator" && parsed.command === "device_start") {
        const port = numberField(payload.result?.device, "port");
        if (validAndroidEmulatorPort(port)) {
            const live = liveAndroidEmulatorPortsForAllocation(normalized);
            if (!live.ok) {
                return {
                    status: live.status,
                    payload: {
                        ok: false,
                        error: live.error,
                        detail: live.detail,
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                    },
                };
            }
            if (live.ports.has(port)) {
                return {
                    status: 409,
                    payload: {
                        ok: false,
                        error: "android-emulator-port-conflict",
                        detail: `port-${port}-already-in-use`,
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                    },
                };
            }
        }
    }
    if (parsed.backend === "android-emulator" && parsed.command === "device_delete" && parsed.deleteAvd !== false) {
        const avdName = field(payload.result?.device, "avdName");
        const avdRoot = approvedAndroidAvdRoot(field(payload.result?.device, "avdRoot"), normalized.platform);
        if (!avdRoot || !avdName || !ownedAndroidAvdName(avdName, ownerId)) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: !avdRoot ? "android-avd-root-unavailable" : "android-avd-identity-unavailable",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
        const live = liveAndroidAvdNames(normalized);
        if (!live.ok) {
            return {
                status: live.status,
                payload: {
                    ok: false,
                    error: "android-avd-liveness-unverified",
                    detail: live.detail,
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
        if (live.names.has(avdName)) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "android-avd-active",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
        const processState = androidAvdProcessState(avdName, normalized);
        if (!processState.ok) {
            return {
                status: processState.status,
                payload: {
                    ok: false,
                    error: "android-avd-liveness-unverified",
                    detail: processState.detail,
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
        if (processState.active) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "android-avd-active",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
    }
    let effectiveProviderCommand = providerCommand;
    if (parsed.backend === "android-emulator" && parsed.command === "device_delete" && parsed.deleteAvd !== false) {
        effectiveProviderCommand = {
            mode: "noop",
            provider: "host-broker-state",
            reason: "Android AVD artifacts are removed by identity-fenced storage cleanup",
        };
    }
    if (parsed.backend === "windows-sandbox" && parsed.command === "device_start") {
        const lock = claimBrokerWindowsSandboxLock(ownerId, payload.result?.device, providerCommand.sandboxId);
        if (!lock.ok) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "windows-sandbox-host-busy",
                    detail: lock.error,
                    lock: lock.lock,
                    plan: payload.result || null,
                },
            };
        }
    }
    const auxiliaryCleanup = parsed.command === "device_stop" || parsed.command === "device_delete"
        ? cleanupLifecycleAuxiliaryRuntime(ownerId, parsed, normalized)
        : null;
    if (auxiliaryCleanup?.result.ok === false) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "auxiliary-runtime-cleanup-failed",
                result: {
                    ...(isHyperVBackend(parsed.backend)
                        ? redactHyperVResultSecrets(payload.result)
                        : payload.result || {}),
                    device: isHyperVBackend(parsed.backend)
                        ? redactHyperVDeviceSecrets(auxiliaryCleanup.device || payload.result?.device)
                        : redactBrokerDeviceSecrets(auxiliaryCleanup.device || payload.result?.device),
                    auxiliaryCleanup: auxiliaryCleanup.result,
                    invoked: false,
                    dryRun: false,
                    execution: {
                        mode: "preflight",
                        providerExecution: "blocked",
                        mutatesHost: auxiliaryCleanup.result.changed === true,
                    },
                },
            },
        };
    }
    let physicalLeaseCleanup: ReturnType<typeof cleanupOwnerPhysicalLease> | null = null;
    const windowsHelper = parsed.backend === "windows-sandbox" && parsed.command === "device_start"
        ? brokerWindowsHelperPaths(ownerId, parsed.deviceId)
        : null;
    if (windowsHelper) {
        rmSync(windowsHelper.minimizeWatchdogCancelPath, { force: true });
        rmSync(windowsHelper.minimizeWatchdogResultPath, { force: true });
    }
    const windowsSandboxRuntimeBaseline = windowsHelper && normalized.platform === "win32"
        ? brokerWindowsSandboxRuntimeSnapshot(providerCommand, normalized)
        : null;
    if (windowsSandboxRuntimeBaseline && !windowsSandboxRuntimeBaseline.ok) {
        releaseBrokerWindowsSandboxLock(ownerId, payload.result?.device, providerCommand.sandboxId);
        return {
            status: 502,
            payload: {
                ok: false,
                error: "windows-sandbox-runtime-snapshot-failed",
                detail: providerFailureDetail(windowsSandboxRuntimeBaseline.error),
                result: {
                    ...(payload.result || {}),
                    invoked: false,
                    dryRun: false,
                    execution: {
                        mode: "preflight",
                        providerExecution: "blocked",
                        mutatesHost: false,
                        command: windowsSandboxRuntimeBaseline.error,
                    },
                },
            },
        };
    }
    const windowsSandboxStartedAfter = windowsHelper ? new Date(Date.now() - 2000).toISOString() : null;
    const windowsSandboxWindowSnapshot = windowsHelper && providerCommand.windowStyle === "minimized" && normalized.platform === "win32"
        ? normalized.commandRunner({
            mode: "exec",
            provider: "powershell",
            executable: "powershell.exe",
            args: windowsSandboxWindowHandleSnapshotArgs(),
        }, {
            timeoutMs: normalized.commandTimeoutMs,
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        })
        : null;
    const windowsSandboxBaselineHandles = windowsSandboxWindowSnapshot && commandSucceeded(windowsSandboxWindowSnapshot)
        ? windowsSandboxWindowHandlesFromOutput(windowsSandboxWindowSnapshot.stdout || "")
        : null;
    let execution = isHyperVBackend(parsed.backend)
        ? await hyperVProviderCommandRunner(normalized, effectiveProviderCommand, {
            timeoutMs: hyperVRemainingTimeout(hyperVDeadlineAt, 120000),
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        })
        : normalized.commandRunner(effectiveProviderCommand, {
        timeoutMs: parsed.backend === "android-emulator" && parsed.command === "device_delete" && parsed.deleteAvd !== false
            ? 120000
            : normalized.commandTimeoutMs,
        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
    const hyperVProviderDeadlineExpired = isHyperVBackend(parsed.backend) && hyperVOperationDeadlineExpired(hyperVDeadlineAt);
    const linuxBootstrapMayNeedContainment = parsed.backend === "linux-vm"
        && (parsed.command === "device_start" || parsed.command === "device_reboot");
    if (hyperVProviderDeadlineExpired && !linuxBootstrapMayNeedContainment) {
        return {
            status: 504,
            payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId },
        };
    }
    let success = !hyperVProviderDeadlineExpired && (commandSucceeded(execution)
        || commandToleratesMissingMacosVmDelete(parsed, execution)
        || commandToleratesStoppedAndroidEmulatorStatus(parsed, payload.result?.device, execution));
    if (hyperVProviderDeadlineExpired && linuxBootstrapMayNeedContainment) {
        execution = { ...execution, error: "hyper-v-operation-deadline-exceeded" };
    }
    if (parsed.backend === "android-emulator" && parsed.command === "device_delete" && parsed.deleteAvd !== false) {
        const avdName = field(payload.result?.device, "avdName");
        const avdRoot = approvedAndroidAvdRoot(field(payload.result?.device, "avdRoot"), normalized.platform);
        try {
            if (!avdName || !avdRoot) throw new Error("missing-provider-metadata");
            removeOwnedAndroidAvdArtifacts(avdName, ownerId, {
                root: avdRoot,
                verifyInactive: () => androidAvdIsInactiveForBroker(avdName, normalized),
            });
            success = true;
        } catch {
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: "android-avd-artifact-cleanup-failed",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
    }
    if (success && isHyperVBackend(parsed.backend)) {
        const observation = parsed.command === "device_delete"
            ? parseHyperVDeleteObservation(execution.stdout || "")
            : parseHyperVVmObservation(execution.stdout || "");
        const expectedVmId = String(field(payload.result?.device, "vmId") || "").toLowerCase();
        const expectedVmName = field(payload.result?.device, "vmName");
        const expectedDiskPath = field(payload.result?.device, "diskPath");
        success = Boolean(observation
            && expectedVmId
            && observation.vmId === expectedVmId
            && observation.vmName === expectedVmName
            && (parsed.command !== "device_delete" || resolve(observation.diskPath || "") === resolve(expectedDiskPath || "")));
    }
    let registration: ProviderCommandResult | null = null;
    let macosBoot: MacosVmBootRegistration | null = null;
    let androidBoot: AndroidEmulatorBootRegistration | null = null;
    let hyperVGuestReadyExecution: ProviderCommandResult | null = null;
    let hyperVGuestReady: ReturnType<typeof parseHyperVGuestReadyObservation> | null = null;
    let hyperVGuestBootDiagnosticExecution: ProviderCommandResult | null = null;
    let hyperVGuestBootDiagnostic: ReturnType<typeof parseHyperVGuestBootDiagnosticObservation> | null = null;
    let hyperVGuestBootDiagnosticPublic: Record<string, unknown> | null = null;
    let hyperVGuestBootDiagnosticFailureCode: string | null = null;
    let hyperVGuestReadyFailureCode: string | null = null;
    let hyperVGuestReadyTrace: HyperVLinuxGuestReadyTrace | null = null;
    let hyperVContainedRuntimeState: "Off" | null = null;
    let windowsMinimizeWatchdog: ProviderCommandResult | null = null;
    let windowsMinimizeConfirmation: ProviderCommandResult | null = null;
    let windowsMinimizeWatchdogCleanup: ReturnType<typeof cancelBrokerWindowsMinimizeWatchdog> | null = null;
    if (success && parsed.backend === "windows-sandbox" && parsed.command === "device_start") {
        const runtime = success ? waitForBrokerWindowsSandboxRuntime(
            providerCommand,
            normalized,
            windowsSandboxRuntimeBaseline?.ok ? windowsSandboxRuntimeBaseline.sandboxIds : [],
        ) : null;
        if (runtime?.ok) {
            if (runtime.sandboxId && runtime.sandboxId !== providerCommand.sandboxId) {
                updateBrokerWindowsSandboxLockRuntimeId(ownerId, payload.result?.device, providerCommand.sandboxId, runtime.sandboxId);
                effectiveProviderCommand = {
                    ...providerCommand,
                    sandboxId: runtime.sandboxId,
                    requestedSandboxId: providerCommand.sandboxId,
                };
            }
            if (providerCommand.windowStyle === "minimized" && normalized.platform === "win32" && windowsHelper && windowsSandboxStartedAfter && windowsSandboxBaselineHandles !== null) {
                windowsMinimizeWatchdog = normalized.commandRunner({
                    mode: "detached",
                    provider: "powershell",
                    executable: "powershell.exe",
                    args: windowsSandboxMinimizeWatchdogArgs(
                        DEVICE_BROKER_WINDOWS_SANDBOX_MINIMIZE_WATCHDOG_MS,
                        windowsSandboxStartedAfter,
                        windowsHelper.minimizeWatchdogCancelPath,
                        windowsSandboxBaselineHandles,
                        windowsHelper.minimizeWatchdogResultPath,
                    ),
                }, {
                    timeoutMs: normalized.commandTimeoutMs,
                    outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                });
                if (!commandSucceeded(windowsMinimizeWatchdog)) {
                    windowsMinimizeConfirmation = windowsMinimizeWatchdog;
                }
            } else if (providerCommand.windowStyle === "minimized" && normalized.platform === "win32" && windowsHelper) {
                windowsMinimizeConfirmation = {
                    mode: "exec",
                    provider: "windows-sandbox-window",
                    status: null,
                    error: "windows-sandbox-window-baseline-unavailable",
                };
            }
            if (providerCommand.windowStyle === "minimized" && normalized.platform === "win32" && windowsHelper && windowsMinimizeWatchdog && commandSucceeded(windowsMinimizeWatchdog)) {
                windowsMinimizeConfirmation = waitForBrokerWindowsMinimizeConfirmation(windowsHelper.minimizeWatchdogResultPath);
            }
        } else if (runtime && !runtime.ok) {
            registration = runtime.error;
            success = false;
        }
    }
    if (success && parsed.backend === "macos-vm" && parsed.command === "device_start") {
        macosBoot = waitForBrokerMacosVmBoot(parsed, payload.result?.device, providerCommand, normalized);
        if (!macosBoot.ok) {
            success = false;
        }
    }
    if (success && parsed.backend === "android-emulator" && parsed.command === "device_start") {
        androidBoot = waitForBrokerAndroidEmulatorBoot(parsed, payload.result?.device, normalized);
        if (!androidBoot.ok) success = false;
    }
    if (success && parsed.backend === "windows-vm" && (parsed.command === "device_start" || parsed.command === "device_reboot") && parsed.waitForBoot !== false) {
        const device = payload.result?.device as Record<string, unknown>;
        const timeoutMs = Number.isFinite(parsed.bootTimeoutMs)
            ? Math.min(DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS, Math.max(1000, Number(parsed.bootTimeoutMs)))
            : 5 * 60 * 1000;
        try {
            const privateRoot = field(device, "privateRoot") || "";
            const expectedPrivateRoot = hyperVPrivateDeviceRoot(ownerId, "windows-vm", parsed.deviceId);
            const credentialPath = field(device, "guestCredentialPath") || "";
            const provisioningMediaPath = field(device, "guestUnattendPath") || "";
            const expectedProvisioningMediaPath = join(hyperVDeviceRoot(ownerId, "windows-vm", parsed.deviceId), "disks", "autounattend.iso");
            if (privateRoot !== expectedPrivateRoot
                || credentialPath !== join(expectedPrivateRoot, "secrets", "guest.credential.xml")
                || provisioningMediaPath !== expectedProvisioningMediaPath) {
                throw new Error("hyper-v-guest-metadata-invalid");
            }
            assertHyperVPrivateDeviceRoot(ownerId, "windows-vm", parsed.deviceId, privateRoot);
            const readyCommand = hyperVGuestReadyCommand({
                executable: providerCommand.executable || "powershell.exe",
                ownerId,
                deviceId: parsed.deviceId,
                incarnationId: hyperVDeviceIncarnationId(device) || "",
                vmName: field(device, "vmName") || "",
                vmId: field(device, "vmId"),
                deviceRoot: field(device, "deviceRoot") || "",
                privateRoot,
                credentialPath,
                provisioningMediaPath,
                timeoutMs,
                expectedNetworkAddress: field(device, "networkAddress"),
            });
            hyperVGuestReadyExecution = await hyperVProviderCommandRunner(normalized, readyCommand, {
                timeoutMs: hyperVRemainingTimeout(hyperVDeadlineAt, timeoutMs + 15000),
                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
            });
            assertHyperVOperationDeadline(hyperVDeadlineAt);
            hyperVGuestReady = commandSucceeded(hyperVGuestReadyExecution)
                ? parseHyperVGuestReadyObservation(hyperVGuestReadyExecution.stdout || "")
                : null;
            success = Boolean(hyperVGuestReady
                && hyperVGuestReady.vmId === String(field(device, "vmId") || "").toLowerCase()
                && hyperVGuestReady.vmName === field(device, "vmName")
                && (!field(device, "networkAddress") || hyperVGuestReady.networkAddress === field(device, "networkAddress")));
        } catch (error) {
            hyperVGuestReadyExecution = { mode: "exec", provider: "hyper-v", status: null, error: error instanceof Error ? error.message : String(error) };
            success = false;
        }
    }
    if (success && parsed.backend === "linux-vm" && (parsed.command === "device_start" || parsed.command === "device_reboot") && parsed.waitForBoot !== false) {
        const device = payload.result?.device as Record<string, unknown>;
        const timeoutMs = Number.isFinite(parsed.bootTimeoutMs)
            ? Math.min(DEVICE_BROKER_HYPER_V_MAX_BOOT_TIMEOUT_MS, Math.max(1000, Number(parsed.bootTimeoutMs)))
            : 5 * 60 * 1000;
        const ssh = providerExecutable("ssh.exe", normalized) || providerExecutable("ssh", normalized);
        if (!ssh) {
            hyperVGuestReadyExecution = { mode: "exec", provider: "hyper-v-ssh", status: null, error: "missing-provider-command:ssh" };
            success = false;
        } else {
            const readinessStartedAt = Date.now();
            const deadline = Math.min(Date.now() + timeoutMs, hyperVDeadlineAt);
            const guestSignalDeadline = hyperVLinuxGuestSignalDeadlineAt(readinessStartedAt);
            let attempts = 0;
            let bootstrapProbeAttempts = 0;
            let bootstrapProbeSuccesses = 0;
            let bootstrapProbeLastStatus: number | null = null;
            let bootstrapProbeLastError: string | null = null;
            let bootstrapAddressCount = 0;
            let bootstrapSshAttempts = 0;
            let bootstrapSshLastStatus: number | null = null;
            let bootstrapSshLastError: string | null = null;
            let bootstrapHostKeyObserved: boolean | null = null;
            let bootstrapHostKeyMatchesExpected: boolean | null = null;
            let bootstrapHostKeyAdopted = false;
            const probedBootstrapHostKeyAddresses = new Set<string>();
            const observedBootstrapHostKeyAddresses = new Set<string>();
            const matchingBootstrapHostKeyAddresses = new Set<string>();
            let networkFinalizeAttempts = 0;
            let networkFinalizeSucceeded = false;
            let guestSignalObserved = false;
            try {
                const privateRoot = field(device, "privateRoot") || "";
                const expectedPrivateRoot = hyperVPrivateDeviceRoot(ownerId, "linux-vm", parsed.deviceId);
                const hostPublicKeyPath = field(device, "sshHostPublicKeyPath") || "";
                const knownHostsPath = field(device, "sshKnownHostsPath") || "";
                const networkAddress = field(device, "networkAddress") || "";
                const managedMacAddress = field(device, "macAddress") || "";
                const networkGateway = field(device, "networkGateway") || "";
                const networkPrefix = field(device, "networkPrefix") || "";
                let fingerprint = field(device, "sshHostKeyFingerprint") || "";
                assertHyperVPrivateDeviceRoot(ownerId, "linux-vm", parsed.deviceId, privateRoot);
                const reconciledIdentity = privateRoot === expectedPrivateRoot
                    && hostPublicKeyPath === join(expectedPrivateRoot, "secrets", "ssh_host_ed25519_key.pub")
                    ? reconcileHyperVLinuxSshHostIdentity(
                        ownerId,
                        parsed.stateKey,
                        parsed.deviceId,
                        hostPublicKeyPath,
                        knownHostsPath,
                        networkAddress,
                    )
                    : null;
                if (reconciledIdentity) {
                    fingerprint = reconciledIdentity.fingerprint;
                    device.sshHostKeyFingerprint = reconciledIdentity.fingerprint;
                }
                if (privateRoot !== expectedPrivateRoot
                    || hostPublicKeyPath !== join(expectedPrivateRoot, "secrets", "ssh_host_ed25519_key.pub")
                    || !validateHyperVLinuxSshHostIdentity(ownerId, parsed.deviceId, hostPublicKeyPath, knownHostsPath, networkAddress, fingerprint)) {
                    throw new Error("hyper-v-linux-ssh-host-identity-invalid");
                }
                const sshOptions = {
                    executable: ssh,
                    deviceRoot: field(device, "deviceRoot") || "",
                    privateRoot,
                    sshPrivateKeyPath: field(device, "sshPrivateKeyPath") || "",
                    knownHostsPath,
                    guestUsername: field(device, "guestUsername") || "",
                };
                let bootstrapFinalizationAttempted = false;
                let definitiveHostKeyFailure = false;
                do {
                    attempts += 1;
                    const readyCommand = hyperVLinuxSshReadyCommand({
                        ...sshOptions,
                        networkAddress,
                        timeoutMs: Math.min(timeoutMs, 30000),
                    });
                    hyperVGuestReadyExecution = await hyperVProviderCommandRunner(normalized, readyCommand, { timeoutMs: hyperVRemainingTimeout(deadline, 35000), outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT });
                    if (commandSucceeded(hyperVGuestReadyExecution) && String(hyperVGuestReadyExecution.stdout || "").includes("ccc-hyper-v-linux-ready")) {
                        guestSignalObserved = true;
                        break;
                    }
                    if (!bootstrapFinalizationAttempted && Date.now() < deadline) {
                        bootstrapProbeAttempts += 1;
                        const bootstrapCommand = hyperVBootstrapNetworkCommand({
                            executable: providerCommand.executable || "powershell.exe",
                            ownerId,
                            deviceId: parsed.deviceId,
                            incarnationId: hyperVDeviceIncarnationId(device) || "",
                            vmName: field(device, "vmName") || "",
                            vmId: field(device, "vmId"),
                        });
                        const bootstrapExecution = await hyperVProviderCommandRunner(normalized, bootstrapCommand, {
                            timeoutMs: hyperVRemainingTimeout(deadline, 15000),
                            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                        });
                        bootstrapProbeLastStatus = typeof bootstrapExecution.status === "number"
                            ? bootstrapExecution.status
                            : null;
                        const bootstrap = commandSucceeded(bootstrapExecution)
                            ? parseHyperVBootstrapNetworkObservation(bootstrapExecution.stdout || "")
                            : null;
                        if (bootstrap && !bootstrap.diagnosticCode) {
                            bootstrapProbeSuccesses += 1;
                            bootstrapProbeLastError = null;
                        } else {
                            bootstrapProbeLastError = bootstrap?.diagnosticCode
                                || (commandSucceeded(bootstrapExecution)
                                    ? "hyper-v-bootstrap-network-response-invalid"
                                    : hyperVProviderDiagnosticCode(
                                        bootstrapExecution,
                                        "hyper-v-bootstrap-network-probe-failed",
                                    ) || "hyper-v-bootstrap-network-probe-failed");
                        }
                        bootstrapAddressCount = Math.max(bootstrapAddressCount, bootstrap?.addresses.length || 0);
                        if ((bootstrap?.addresses.length || 0) > 0) guestSignalObserved = true;
                        for (const bootstrapAddress of bootstrap?.addresses || []) {
                            bootstrapSshAttempts += 1;
                            const bootstrapReadyCommand = hyperVLinuxSshReadyCommand({
                                ...sshOptions,
                                networkAddress: bootstrapAddress,
                                hostKeyAlias: networkAddress,
                                verboseHostKeyDiagnostics: true,
                                timeoutMs: Math.min(10000, Math.max(1000, deadline - Date.now())),
                            });
                            const bootstrapReadyExecution = await hyperVProviderCommandRunner(normalized, bootstrapReadyCommand, {
                                timeoutMs: hyperVRemainingTimeout(deadline, 15000),
                                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                            });
                            bootstrapSshLastStatus = typeof bootstrapReadyExecution.status === "number"
                                ? bootstrapReadyExecution.status
                                : null;
                            let bootstrapAuthenticated = commandSucceeded(bootstrapReadyExecution)
                                && String(bootstrapReadyExecution.stdout || "").includes("ccc-hyper-v-linux-ready");
                            if (!bootstrapAuthenticated) {
                                bootstrapSshLastError = commandSucceeded(bootstrapReadyExecution)
                                    ? "ssh-readiness-marker-missing"
                                    : hyperVGuestReadinessFailureCode("linux-vm", bootstrapReadyExecution);
                                if (bootstrapSshLastError === "ssh-host-key-rejected"
                                    && !probedBootstrapHostKeyAddresses.has(bootstrapAddress)) {
                                    probedBootstrapHostKeyAddresses.add(bootstrapAddress);
                                    const comparison = compareHyperVLinuxEd25519HostKeyFingerprint(
                                        fingerprint,
                                        `${bootstrapReadyExecution.error || ""}\n${bootstrapReadyExecution.stderr || ""}`,
                                    );
                                    if (comparison.observed) {
                                        observedBootstrapHostKeyAddresses.add(bootstrapAddress);
                                        if (comparison.matchesExpected) matchingBootstrapHostKeyAddresses.add(bootstrapAddress);
                                    }
                                    bootstrapHostKeyObserved = observedBootstrapHostKeyAddresses.size > 0;
                                    bootstrapHostKeyMatchesExpected = bootstrapHostKeyObserved
                                        ? matchingBootstrapHostKeyAddresses.size > 0
                                        : null;
                                    if (comparison.observed && comparison.matchesExpected === false) {
                                        const observedKnownHostsPath = join(expectedPrivateRoot, "secrets", "bootstrap_known_hosts");
                                        try {
                                            unlinkSync(observedKnownHostsPath);
                                        } catch (error) {
                                            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                                        }
                                        try {
                                            const adoptionReadyCommand = hyperVLinuxSshReadyCommand({
                                                ...sshOptions,
                                                knownHostsPath: observedKnownHostsPath,
                                                networkAddress: bootstrapAddress,
                                                hostKeyAlias: networkAddress,
                                                strictHostKeyChecking: "accept-new",
                                                timeoutMs: Math.min(10000, Math.max(1000, deadline - Date.now())),
                                            });
                                            const adoptionExecution = await hyperVProviderCommandRunner(normalized, adoptionReadyCommand, {
                                                timeoutMs: hyperVRemainingTimeout(deadline, 15000),
                                                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                                            });
                                            bootstrapSshLastStatus = typeof adoptionExecution.status === "number"
                                                ? adoptionExecution.status
                                                : null;
                                            const adoptionAuthenticated = commandSucceeded(adoptionExecution)
                                                && String(adoptionExecution.stdout || "").includes("ccc-hyper-v-linux-ready");
                                            if (!adoptionAuthenticated) {
                                                bootstrapSshLastError = commandSucceeded(adoptionExecution)
                                                    ? "ssh-readiness-marker-missing"
                                                    : "ssh-host-key-bootstrap-authentication-failed";
                                            } else {
                                                const adopted = adoptHyperVLinuxSshHostIdentity(
                                                    ownerId,
                                                    parsed.deviceId,
                                                    observedKnownHostsPath,
                                                    hostPublicKeyPath,
                                                    knownHostsPath,
                                                    networkAddress,
                                                    (candidateFingerprint) => persistHyperVLinuxSshHostIdentity(
                                                        ownerId,
                                                        parsed.stateKey,
                                                        parsed.deviceId,
                                                        hostPublicKeyPath,
                                                        knownHostsPath,
                                                        networkAddress,
                                                        candidateFingerprint,
                                                    ),
                                                );
                                                if (!adopted) {
                                                    bootstrapSshLastError = "ssh-host-key-adoption-failed";
                                                } else {
                                                    fingerprint = adopted.fingerprint;
                                                    device.sshHostKeyFingerprint = adopted.fingerprint;
                                                    bootstrapHostKeyAdopted = true;
                                                    bootstrapHostKeyMatchesExpected = true;
                                                    matchingBootstrapHostKeyAddresses.add(bootstrapAddress);
                                                    bootstrapSshLastError = null;
                                                    bootstrapAuthenticated = true;
                                                }
                                            }
                                        } finally {
                                            rmSync(observedKnownHostsPath, { force: true });
                                        }
                                    }
                                }
                                if (!bootstrapAuthenticated) {
                                    continue;
                                }
                            }
                            bootstrapSshLastError = null;
                            const finalizeCommand = hyperVLinuxNetworkFinalizeCommand({
                                ...sshOptions,
                                networkAddress: bootstrapAddress,
                                hostKeyAlias: networkAddress,
                                timeoutMs: 10000,
                                managedMacAddress,
                                managedNetworkAddress: networkAddress,
                                networkGateway,
                                networkPrefixLength: Number(networkPrefix.split("/")[1]),
                            });
                            networkFinalizeAttempts += 1;
                            const finalizeExecution = await hyperVProviderCommandRunner(normalized, finalizeCommand, {
                                timeoutMs: hyperVRemainingTimeout(deadline, 15000),
                                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                            });
                            if (!commandSucceeded(finalizeExecution)) {
                                hyperVGuestReadyExecution = {
                                    ...finalizeExecution,
                                    error: "hyper-v-bootstrap-network-finalize-failed",
                                };
                                break;
                            }
                            bootstrapFinalizationAttempted = true;
                            networkFinalizeSucceeded = true;
                            break;
                        }
                        const bootstrapAddresses = bootstrap?.addresses || [];
                        if (!definitiveHostKeyFailure
                            && !networkFinalizeSucceeded
                            && bootstrapAddresses.length > 0
                            && bootstrapAddresses.every((address) => observedBootstrapHostKeyAddresses.has(address))) {
                            if (bootstrapSshLastError !== "ssh-host-key-bootstrap-authentication-failed"
                                && bootstrapSshLastError !== "ssh-host-key-adoption-failed") {
                                bootstrapSshLastError = bootstrapAddresses.some((address) => matchingBootstrapHostKeyAddresses.has(address))
                                    ? "ssh-host-key-client-verification-failed"
                                    : "ssh-host-key-mismatch";
                            }
                            definitiveHostKeyFailure = true;
                        }
                    }
                    if (definitiveHostKeyFailure) break;
                    if (Date.now() < deadline) await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
                } while (Date.now() < deadline && (guestSignalObserved || Date.now() < guestSignalDeadline));
                success = Boolean(hyperVGuestReadyExecution && commandSucceeded(hyperVGuestReadyExecution) && String(hyperVGuestReadyExecution.stdout || "").includes("ccc-hyper-v-linux-ready"));
                if (!success && hyperVLinuxGuestSignalTimedOut(readinessStartedAt, Date.now(), guestSignalObserved)) {
                    hyperVGuestReadyExecution = {
                        ...(hyperVGuestReadyExecution || { mode: "exec", provider: "hyper-v-ssh", status: null }),
                        error: "hyper-v-guest-boot-signal-timeout",
                        timedOut: false,
                    };
                }
                hyperVGuestReady = success ? {
                    ok: true,
                    vmId: String(field(device, "vmId") || "").toLowerCase(),
                    vmName: field(device, "vmName") || "",
                    computerName: field(device, "vmName") || "",
                    attempts,
                    networkAddress: field(device, "networkAddress") || undefined,
                } : null;
                if (success) {
                    const cleanupCommand = hyperVBootstrapNetworkCleanupCommand({
                        executable: providerCommand.executable || "powershell.exe",
                        ownerId,
                        deviceId: parsed.deviceId,
                        incarnationId: hyperVDeviceIncarnationId(device) || "",
                        vmName: field(device, "vmName") || "",
                        vmId: field(device, "vmId"),
                        managedMacAddress: field(device, "macAddress") || "",
                    });
                    const cleanupExecution = await hyperVProviderCommandRunner(normalized, cleanupCommand, {
                        timeoutMs: hyperVRemainingTimeout(hyperVDeadlineAt, 30000),
                        outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                    });
                    const cleanupObservation = commandSucceeded(cleanupExecution)
                        ? parseHyperVBootstrapNetworkCleanupObservation(cleanupExecution.stdout || "")
                        : null;
                    if (!cleanupObservation) {
                        hyperVGuestReadyExecution = {
                            ...cleanupExecution,
                            error: "hyper-v-bootstrap-network-cleanup-failed",
                        };
                        hyperVGuestReady = null;
                        success = false;
                    }
                }
            } catch (error) {
                const caughtError = error instanceof Error ? error.message : String(error);
                const readinessError = caughtError === "hyper-v-operation-deadline-exceeded"
                    ? bootstrapSshLastError || caughtError
                    : caughtError;
                hyperVGuestReadyExecution = { mode: "exec", provider: "hyper-v-ssh", status: null, error: readinessError };
                success = false;
            } finally {
                hyperVGuestReadyTrace = {
                    managedSshAttempts: attempts,
                    bootstrapProbeAttempts,
                    bootstrapProbeSuccesses,
                    bootstrapProbeLastStatus,
                    bootstrapProbeLastError,
                    bootstrapAddressCount,
                    bootstrapSshAttempts,
                    bootstrapSshLastStatus,
                    bootstrapSshLastError,
                    bootstrapHostKeyObserved,
                    bootstrapHostKeyMatchesExpected,
                    bootstrapHostKeyAdopted,
                    networkFinalizeAttempts,
                    networkFinalizeSucceeded,
                    guestSignalObserved,
                    elapsedMs: Math.max(0, Date.now() - readinessStartedAt),
                };
            }
        }
    }
    if (!success
        && parsed.backend === "linux-vm"
        && (parsed.command === "device_start" || parsed.command === "device_reboot")
        && parsed.waitForBoot !== false) {
        const device = payload.result?.device as Record<string, unknown>;
        let bootstrapContained = false;
        try {
            const cleanupCommand = hyperVBootstrapNetworkCleanupCommand({
                executable: providerCommand.executable || "powershell.exe",
                ownerId,
                deviceId: parsed.deviceId,
                incarnationId: hyperVDeviceIncarnationId(device) || "",
                vmName: field(device, "vmName") || "",
                vmId: field(device, "vmId"),
                managedMacAddress: field(device, "macAddress") || "",
            });
            const cleanupExecution = await hyperVProviderCommandRunner(normalized, cleanupCommand, {
                timeoutMs: hyperVRemainingTimeout(hyperVCleanupDeadlineAt, 30000),
                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
            });
            bootstrapContained = commandSucceeded(cleanupExecution)
                && Boolean(parseHyperVBootstrapNetworkCleanupObservation(cleanupExecution.stdout || ""));
        } catch {
            bootstrapContained = false;
        }
        if (!bootstrapContained) {
            try {
                const stopExecution = await hyperVProviderCommandRunner(normalized, hyperVStopCommand({
                    executable: providerCommand.executable || "powershell.exe",
                    ownerId,
                    deviceId: parsed.deviceId,
                    incarnationId: hyperVDeviceIncarnationId(device) || "",
                    vmName: field(device, "vmName") || "",
                    vmId: field(device, "vmId"),
                }, true), {
                    timeoutMs: hyperVRemainingTimeout(hyperVCleanupDeadlineAt, 30000),
                    outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
                });
                const stopObservation = commandSucceeded(stopExecution)
                    ? parseHyperVVmObservation(stopExecution.stdout || "")
                    : null;
                bootstrapContained = Boolean(stopObservation
                    && stopObservation.state === "Off"
                    && stopObservation.vmId === String(field(device, "vmId") || "").toLowerCase()
                    && stopObservation.vmName === field(device, "vmName"));
                if (bootstrapContained) hyperVContainedRuntimeState = "Off";
            } catch {
                bootstrapContained = false;
            }
        }
        if (!bootstrapContained) {
            hyperVGuestReadyExecution = {
                ...(hyperVGuestReadyExecution || { mode: "exec", provider: "hyper-v-ssh", status: null }),
                error: "hyper-v-bootstrap-network-containment-failed",
            };
        }
    }
    if (!success
        && hyperVGuestReadyExecution
        && isHyperVBackend(parsed.backend)
        && (parsed.command === "device_start" || parsed.command === "device_reboot")) {
        hyperVGuestReadyFailureCode = hyperVGuestReadinessFailureCode(parsed.backend === "linux-vm" ? "linux-vm" : "windows-vm", hyperVGuestReadyExecution);
        if (parsed.backend === "linux-vm") {
            hyperVGuestReadyFailureCode = hyperVLinuxGuestReadyTraceFailureCode(
                hyperVGuestReadyTrace,
                hyperVGuestReadyFailureCode,
            );
        }
        const device = payload.result?.device as Record<string, unknown>;
        try {
            const diagnosticCommand = hyperVGuestBootDiagnosticCommand({
                executable: providerCommand.executable || "powershell.exe",
                ownerId,
                deviceId: parsed.deviceId,
                incarnationId: hyperVDeviceIncarnationId(device) || "",
                vmName: field(device, "vmName") || "",
                vmId: field(device, "vmId"),
                diskPath: field(device, "diskPath"),
            });
            hyperVGuestBootDiagnosticExecution = await hyperVProviderCommandRunner(normalized, diagnosticCommand, {
                timeoutMs: hyperVRemainingTimeout(hyperVDeadlineAt, 15000),
                outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
            });
            hyperVGuestBootDiagnostic = commandSucceeded(hyperVGuestBootDiagnosticExecution)
                ? parseHyperVGuestBootDiagnosticObservation(hyperVGuestBootDiagnosticExecution.stdout || "")
                : null;
            if (!hyperVGuestBootDiagnostic) {
                hyperVGuestBootDiagnosticFailureCode = commandSucceeded(hyperVGuestBootDiagnosticExecution)
                    ? "hyper-v-guest-boot-diagnostic-invalid"
                    : hyperVProviderDiagnosticCode(
                        hyperVGuestBootDiagnosticExecution,
                        "hyper-v-guest-boot-diagnostic-failed",
                    ) || "hyper-v-guest-boot-diagnostic-failed";
            }
            if (hyperVGuestBootDiagnostic
                && (hyperVGuestBootDiagnostic.vmId !== String(field(device, "vmId") || "").toLowerCase()
                    || hyperVGuestBootDiagnostic.vmName !== field(device, "vmName"))) {
                hyperVGuestBootDiagnostic = null;
                hyperVGuestBootDiagnosticFailureCode = "hyper-v-guest-boot-diagnostic-identity-mismatch";
            }
            hyperVGuestBootDiagnosticPublic = hyperVGuestBootDiagnostic ? {
                state: hyperVGuestBootDiagnostic.state,
                uptimeMs: hyperVGuestBootDiagnostic.uptimeMs,
                generation: hyperVGuestBootDiagnostic.generation,
                secureBootEnabled: hyperVGuestBootDiagnostic.secureBootEnabled,
                heartbeatEnabled: hyperVGuestBootDiagnostic.heartbeatEnabled,
                heartbeatPrimaryStatus: hyperVGuestBootDiagnostic.heartbeatPrimaryStatus,
                heartbeatSecondaryStatus: hyperVGuestBootDiagnostic.heartbeatSecondaryStatus,
                integrationServices: hyperVGuestBootDiagnostic.integrationServices,
                hardDiskCount: hyperVGuestBootDiagnostic.hardDiskCount,
                dvdCount: hyperVGuestBootDiagnostic.dvdCount,
                hardDiskControllers: hyperVGuestBootDiagnostic.hardDiskControllers,
                bootDeviceTypes: hyperVGuestBootDiagnostic.bootDeviceTypes,
                bootEntries: hyperVGuestBootDiagnostic.bootEntries,
                hardDisks: hyperVGuestBootDiagnostic.hardDisks,
                dvdDrives: hyperVGuestBootDiagnostic.dvdDrives,
                diagnosticComplete: hyperVGuestBootDiagnostic.diagnosticComplete,
                diagnosticErrors: hyperVGuestBootDiagnostic.diagnosticErrors,
            } : null;
        } catch (error) {
            hyperVGuestBootDiagnosticFailureCode = hyperVBoundedErrorCode(
                error,
                "hyper-v-guest-boot-diagnostic-failed",
            );
            hyperVGuestBootDiagnostic = null;
        }
    }
    if (!success && windowsMinimizeWatchdog?.pid) {
        windowsMinimizeWatchdogCleanup = cancelBrokerWindowsMinimizeWatchdog(ownerId, parsed.deviceId);
    }
    if (parsed.backend === "windows-sandbox") {
        if (parsed.command === "device_start" && !success) {
            releaseBrokerWindowsSandboxLock(ownerId, payload.result?.device, effectiveProviderCommand.sandboxId);
        }
        if (success && (parsed.command === "device_stop" || parsed.command === "device_delete")) {
            releaseBrokerWindowsSandboxLock(ownerId, payload.result?.device, effectiveProviderCommand.sandboxId);
        }
    }
    if (success && physicalTeardown) {
        physicalLeaseCleanup = cleanupOwnerPhysicalLease(ownerId, physicalLeaseGuard!);
        if (!physicalLeaseCleanup.ok) {
            return {
                status: physicalLeaseCleanup.status === 409 ? 409 : 502,
                payload: {
                    ok: false,
                    error: "physical-lease-cleanup-failed",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    result: {
                        ...(payload.result || {}),
                        physicalLeaseCleanup,
                        invoked: true,
                        dryRun: false,
                        execution: {
                            mode: execution.mode,
                            providerExecution: "executed",
                            mutatesHost: auxiliaryCleanup?.result.changed === true,
                            command: execution,
                        },
                    },
                },
            };
        }
    }
    const windowsDeviceArtifactCleanup = success
        && parsed.backend === "windows-sandbox"
        && parsed.command === "device_delete"
        ? normalized.windowsDeviceArtifactCleaner(ownerId, parsed.deviceId)
        : null;
    if (windowsDeviceArtifactCleanup?.ok === false) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "windows-sandbox-device-artifact-cleanup-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                result: {
                    ...(payload.result || {}),
                    device: redactBrokerDeviceSecrets(auxiliaryCleanup?.device || payload.result?.device),
                    windowsDeviceArtifactCleanup,
                    invoked: true,
                    dryRun: false,
                    execution: {
                        mode: execution.mode,
                        providerExecution: "executed",
                        mutatesHost: true,
                        command: execution,
                    },
                },
            },
        };
    }
    const hyperVNetworkAllocationCleanup = success
        && isHyperVBackend(parsed.backend)
        && parsed.command === "device_delete"
        ? await releaseHyperVNetworkAllocationAndCleanup(ownerId, parsed.deviceId, hyperVDeviceIncarnationId((payload.result?.device || {}) as Record<string, unknown>), normalized, hyperVCleanupDeadlineAt)
        : null;
    const hyperVDeviceArtifactCleanup = success
        && isHyperVBackend(parsed.backend)
        && parsed.command === "device_delete"
        && hyperVNetworkAllocationCleanup?.ok === true
        ? cleanupHyperVDeviceArtifacts(ownerId, parsed.backend, parsed.deviceId)
        : null;
    if (hyperVDeviceArtifactCleanup?.ok === false || hyperVNetworkAllocationCleanup?.ok === false) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "hyper-v-device-cleanup-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                result: {
                    ...redactHyperVResultSecrets(payload.result),
                    device: redactHyperVDeviceSecrets(
                        payload.result?.device,
                    ),
                    hyperVDeviceArtifactCleanup: publicHyperVArtifactCleanup(hyperVDeviceArtifactCleanup),
                    hyperVNetworkAllocationCleanup: publicHyperVNetworkCleanup(hyperVNetworkAllocationCleanup),
                    invoked: true,
                    dryRun: false,
                    execution: {
                        mode: execution.mode,
                        providerExecution: "executed",
                        mutatesHost: true,
                        command: redactProviderCommandInput(
                            execution,
                            true,
                            "hyper-v-device-cleanup-failed",
                        ),
                    },
                },
            },
        };
    }
    let updatedDevice: unknown;
    try {
        if (!success
            && (hyperVGuestReadyExecution || hyperVContainedRuntimeState)
            && isHyperVBackend(parsed.backend)
            && (parsed.command === "device_start" || parsed.command === "device_reboot")) {
            mutateOwnerDevices(ownerId, parsed.stateKey, (devices) => devices.map((candidate) => {
                if (!candidate || typeof candidate !== "object" || (candidate as { id?: unknown }).id !== parsed.deviceId) return candidate;
                const observedRuntimeState = hyperVContainedRuntimeState || hyperVGuestBootDiagnostic?.state || "Running";
                updatedDevice = {
                    ...(candidate as Record<string, unknown>),
                    status: observedRuntimeState === "Running" ? "running" : "stopped",
                    runtimeState: observedRuntimeState,
                    bootReady: false,
                    lastBootCheck: {
                        ready: false,
                        provider: parsed.backend === "linux-vm" ? "hyper-v-ssh" : "hyper-v-powershell-direct",
                        error: hyperVGuestReadyFailureCode || "guest-not-ready",
                        ...(hyperVGuestReadyTrace ? { readiness: hyperVGuestReadyTrace } : {}),
                        ...(hyperVGuestBootDiagnosticPublic ? { diagnostic: hyperVGuestBootDiagnosticPublic } : {}),
                    },
                    updatedAt: new Date().toISOString(),
                };
                return updatedDevice;
            }));
        }
        updatedDevice = success
            ? parsed.command === "device_status"
                ? observedDeviceAfterStatus(ownerId, parsed, payload.result?.device, execution)
                : mutateDeviceAfterCommand(ownerId, parsed, payload.result?.device, effectiveProviderCommand, macosBoot, androidBoot, windowsMinimizeWatchdog, windowsMinimizeConfirmation, execution, hyperVGuestReady)
            : updatedDevice || payload.result?.device;
    } catch (error) {
        if (!physicalTeardown || !physicalLeaseGuard?.parsed || !physicalLeaseGuard.file || !physicalLeaseGuard.existing || physicalLeaseCleanup?.status !== 200) throw error;
        const leaseRollback = restorePhysicalBrokerLeaseRelease(ownerId, physicalLeaseGuard.parsed, physicalLeaseGuard.file, physicalLeaseGuard.existing);
        return {
            status: leaseRollback.ok ? 500 : 502,
            payload: {
                ok: false,
                error: leaseRollback.ok ? "owner-state-write-failed" : "physical-lease-rollback-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                detail: "physical-device-state-transition-failed",
                result: {
                    ...(payload.result || {}),
                    device: redactBrokerDeviceSecrets(auxiliaryCleanup?.device || payload.result?.device),
                    physicalLeaseCleanup,
                    leaseRollback,
                    invoked: true,
                    dryRun: false,
                    execution: {
                        mode: execution.mode,
                        providerExecution: "executed",
                        mutatesHost: auxiliaryCleanup?.result.changed === true,
                        command: execution,
                    },
                },
            },
        };
    }
    return {
        status: success ? 200 : 502,
        payload: {
            ok: success,
            ...(success ? {} : {
                error: hyperVGuestReadyExecution
                    ? "hyper-v-guest-not-ready"
                    : windowsMinimizeWatchdog && (registration === windowsMinimizeWatchdog || registration?.provider === "windows-sandbox-window")
                    ? "windows-sandbox-minimize-watchdog-failed"
                    : "provider-command-failed",
                detail: hyperVGuestReadyExecution
                    ? hyperVGuestReadyFailureCode || "guest-not-ready"
                    : isHyperVBackend(parsed.backend)
                    ? hyperVProviderDiagnosticCode(
                        execution,
                        "hyper-v-provider-command-failed",
                    ) || "hyper-v-provider-command-failed"
                    : providerFailureDetail(execution),
            }),
            result: {
                ...(isHyperVBackend(parsed.backend)
                    ? redactHyperVResultSecrets(payload.result)
                    : (payload.result || {})),
                providerCommand: isHyperVBackend(parsed.backend)
                    ? {
                        mode: effectiveProviderCommand.mode,
                        provider: effectiveProviderCommand.provider,
                    }
                    : hyperVGuestReadyExecution && !hyperVGuestReady
                    ? { mode: effectiveProviderCommand.mode, provider: effectiveProviderCommand.provider }
                    : effectiveProviderCommand,
                device: isHyperVBackend(parsed.backend)
                    ? redactHyperVDeviceSecrets(updatedDevice)
                    : redactBrokerDeviceSecrets(updatedDevice),
                ...(androidBoot ? {
                    boot: androidBoot.ok
                        ? { ready: androidBoot.ready, skipped: androidBoot.skipped === true, provider: "adb", result: androidBoot.result || null }
                        : { ready: false, skipped: false, provider: "adb", error: androidBoot.error },
                } : {}),
                ...(hyperVGuestReadyExecution ? {
                    boot: hyperVGuestReady
                        ? {
                            ready: true,
                            provider: parsed.backend === "linux-vm" ? "hyper-v-ssh" : "hyper-v-powershell-direct",
                            computerName: hyperVGuestReady.computerName,
                            attempts: hyperVGuestReady.attempts,
                            ...(hyperVGuestReadyTrace ? { readiness: hyperVGuestReadyTrace } : {}),
                        }
                        : {
                            ready: false,
                            provider: parsed.backend === "linux-vm" ? "hyper-v-ssh" : "hyper-v-powershell-direct",
                            error: hyperVGuestReadyFailureCode || "guest-not-ready",
                            ...(hyperVGuestReadyTrace ? { readiness: hyperVGuestReadyTrace } : {}),
                            ...(hyperVGuestBootDiagnosticPublic ? { diagnostic: hyperVGuestBootDiagnosticPublic } : {}),
                            diagnosticAvailable: Boolean(hyperVGuestBootDiagnosticPublic),
                            ...(hyperVGuestBootDiagnosticFailureCode ? { diagnosticError: hyperVGuestBootDiagnosticFailureCode } : {}),
                        },
                } : {}),
                ...(windowsMinimizeWatchdog ? { minimizeWatchdog: windowsMinimizeWatchdog } : {}),
                ...(windowsMinimizeConfirmation ? { minimizeConfirmation: windowsMinimizeConfirmation } : {}),
                ...(windowsMinimizeWatchdogCleanup ? { minimizeWatchdogCleanup: windowsMinimizeWatchdogCleanup } : {}),
                ...(auxiliaryCleanup ? { auxiliaryCleanup: auxiliaryCleanup.result } : {}),
                ...(physicalLeaseCleanup ? { physicalLeaseCleanup } : {}),
                ...(windowsDeviceArtifactCleanup ? { windowsDeviceArtifactCleanup } : {}),
                ...(hyperVDeviceArtifactCleanup ? {
                    hyperVDeviceArtifactCleanup: publicHyperVArtifactCleanup(
                        hyperVDeviceArtifactCleanup,
                    ),
                } : {}),
                invoked: true,
                dryRun: false,
                execution: {
                    mode: execution.mode,
                    providerExecution: "executed",
                    mutatesHost: success && parsed.command !== "device_status",
                    command: isHyperVBackend(parsed.backend)
                        ? {
                            ...redactProviderCommandInput(
                                execution,
                                true,
                                success
                                    ? undefined
                                    : "hyper-v-provider-command-failed",
                            ),
                            ...(hyperVGuestReadyExecution && !hyperVGuestReady ? {
                                guestReadiness: {
                                    provider: parsed.backend === "linux-vm"
                                        ? "hyper-v-ssh"
                                        : "hyper-v-powershell-direct",
                                    error: hyperVGuestReadyFailureCode
                                        || "guest-not-ready",
                                    ...(hyperVGuestReadyTrace ? { readiness: hyperVGuestReadyTrace } : {}),
                                    diagnosticAvailable: Boolean(
                                        hyperVGuestBootDiagnosticPublic,
                                    ),
                                    ...(hyperVGuestBootDiagnosticFailureCode ? { diagnosticError: hyperVGuestBootDiagnosticFailureCode } : {}),
                                },
                            } : {}),
                        }
                        : hyperVGuestReadyExecution && !hyperVGuestReady
                        ? {
                            mode: execution.mode,
                            provider: execution.provider,
                            status: execution.status,
                            signal: execution.signal,
                            guestReadiness: {
                                provider: parsed.backend === "linux-vm" ? "hyper-v-ssh" : "hyper-v-powershell-direct",
                                error: hyperVGuestReadyFailureCode || "guest-not-ready",
                                diagnosticAvailable: Boolean(hyperVGuestBootDiagnosticPublic),
                                ...(hyperVGuestBootDiagnosticFailureCode ? { diagnosticError: hyperVGuestBootDiagnosticFailureCode } : {}),
                            },
                        }
                        : registration || (macosBoot && !macosBoot.ok) || (androidBoot && !androidBoot.ok)
                        ? { ...execution, registration, macosBoot, androidBoot }
                        : execution,
                },
            },
        },
    };
}

type HyperVQuotaUsage = {
    definedVms: number;
    configuredMemoryMb: number;
    configuredCpus: number;
    configuredDiskBytes: number;
    runningVms: number;
    runningMemoryMb: number;
    runningCpus: number;
};

function hyperVQuotaResource(device: Record<string, unknown>, key: "memoryMb" | "cpus" | "diskMaxBytes"): number {
    const value = device[key];
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`hyper-v-owner-quota-${key}-invalid`);
    return Number(value);
}

function hyperVQuotaDiskBytes(device: Record<string, unknown>): number {
    const stored = device.diskMaxBytes;
    if (Number.isSafeInteger(stored) && Number(stored) > 0) return Number(stored);
    const profile = hyperVImageProfile(device.profile);
    if (!profile) throw new Error("hyper-v-owner-quota-diskMaxBytes-invalid");
    return readHyperVImageManifestMetadata(profile).virtualSizeBytes;
}

function hyperVQuotaUsage(devices: unknown[]): HyperVQuotaUsage {
    const usage: HyperVQuotaUsage = {
        definedVms: 0,
        configuredMemoryMb: 0,
        configuredCpus: 0,
        configuredDiskBytes: 0,
        runningVms: 0,
        runningMemoryMb: 0,
        runningCpus: 0,
    };
    for (const candidate of devices) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("hyper-v-owner-quota-device-invalid");
        const device = candidate as Record<string, unknown>;
        const memoryMb = hyperVQuotaResource(device, "memoryMb");
        const cpus = hyperVQuotaResource(device, "cpus");
        const diskMaxBytes = hyperVQuotaDiskBytes(device);
        usage.definedVms += 1;
        usage.configuredMemoryMb += memoryMb;
        usage.configuredCpus += cpus;
        usage.configuredDiskBytes += diskMaxBytes;
        const running = String(device.status || "").toLowerCase() === "running"
            || String(device.runtimeState || "").toLowerCase() === "running";
        if (running) {
            usage.runningVms += 1;
            usage.runningMemoryMb += memoryMb;
            usage.runningCpus += cpus;
        }
    }
    return usage;
}

function hyperVOwnerQuotaFailure(ownerId: string, parsed: CommandParamSuccess): BrokerRpcResult | null {
    if (parsed.command !== "device_create" && parsed.command !== "device_start" && parsed.command !== "device_reboot") return null;
    let devices: unknown[];
    let targetDevices: unknown[];
    let usage: HyperVQuotaUsage;
    try {
        targetDevices = readOwnerDevices(ownerId, parsed.stateKey);
        devices = [...readOwnerDevices(ownerId, "windows-vm"), ...readOwnerDevices(ownerId, "linux-vm")];
        usage = hyperVQuotaUsage(devices);
    } catch (error) {
        const stateCode = ownerDeviceStateErrorCode(error);
        if (stateCode) return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        return {
            status: 409,
            payload: {
                ok: false,
                error: "hyper-v-owner-quota-state-invalid",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                detail: hyperVBoundedErrorCode(
                    error,
                    "hyper-v-owner-quota-state-invalid",
                ),
            },
        };
    }

    const requested = { definedVms: 0, configuredMemoryMb: 0, configuredCpus: 0, configuredDiskBytes: 0, runningVms: 0, runningMemoryMb: 0, runningCpus: 0 };
    if (parsed.command === "device_create") {
        const memoryMb = typeof parsed.create?.memoryMb === "number" ? parsed.create.memoryMb : 4096;
        const cpus = typeof parsed.create?.cpus === "number" ? parsed.create.cpus : 2;
        const diskMaxBytes = typeof parsed.create?.diskMaxBytes === "number" ? parsed.create.diskMaxBytes : 0;
        if (!Number.isSafeInteger(memoryMb) || memoryMb < 1024 || memoryMb > 131072
            || !Number.isSafeInteger(cpus) || cpus < 1 || cpus > 64
            || !Number.isSafeInteger(diskMaxBytes) || diskMaxBytes < 0) return null;
        requested.definedVms = 1;
        requested.configuredMemoryMb = memoryMb;
        requested.configuredCpus = cpus;
        requested.configuredDiskBytes = diskMaxBytes;
    } else {
        const target = targetDevices.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === parsed.deviceId) as Record<string, unknown> | undefined;
        if (!target) return null;
        const alreadyRunning = String(target.status || "").toLowerCase() === "running"
            || String(target.runtimeState || "").toLowerCase() === "running";
        if (!alreadyRunning && (parsed.command !== "device_reboot" || parsed.startIfStopped === true)) {
            requested.runningVms = 1;
            requested.runningMemoryMb = hyperVQuotaResource(target, "memoryMb");
            requested.runningCpus = hyperVQuotaResource(target, "cpus");
        }
    }

    const projected = Object.fromEntries(Object.keys(usage).map((key) => [key, usage[key as keyof HyperVQuotaUsage] + requested[key as keyof HyperVQuotaUsage]])) as HyperVQuotaUsage;
    const quota = DEVICE_BROKER_HYPER_V_OWNER_QUOTA;
    const violations = [
        projected.definedVms > quota.maxDefinedVms ? "defined-vms" : null,
        projected.configuredMemoryMb > quota.maxConfiguredMemoryMb ? "configured-memory-mb" : null,
        projected.configuredCpus > quota.maxConfiguredCpus ? "configured-cpus" : null,
        projected.configuredDiskBytes > quota.maxConfiguredDiskBytes ? "configured-disk-bytes" : null,
        projected.runningVms > quota.maxRunningVms ? "running-vms" : null,
        projected.runningMemoryMb > quota.maxRunningMemoryMb ? "running-memory-mb" : null,
        projected.runningCpus > quota.maxRunningCpus ? "running-cpus" : null,
    ].filter((value): value is string => Boolean(value));
    if (violations.length === 0) return null;
    return {
        status: 409,
        payload: {
            ok: false,
            error: "hyper-v-owner-quota-exceeded",
            ownerId,
            backend: parsed.backend,
            deviceId: parsed.deviceId,
            violations,
            usage,
            requested,
            projected,
            quota,
        },
    };
}

async function lifecycleHyperVCommandInvokeLocked(
    ownerId: string,
    params: unknown,
    parsed: CommandParamSuccess,
    normalized: NormalizedBrokerOptions,
    deadlineAt = Number.POSITIVE_INFINITY,
    cleanupDeadlineAt = deadlineAt,
): Promise<BrokerRpcResult> {
    assertHyperVOperationDeadline(deadlineAt);
    if (parsed.command !== "device_create") {
        if (!parsed.dryRun && parsed.command !== "device_status") {
            let expectedIncarnationId: string | null = null;
            try {
                const current = readOwnerDevices(ownerId, parsed.stateKey).find((candidate) => candidate
                    && typeof candidate === "object"
                    && !Array.isArray(candidate)
                    && (candidate as Record<string, unknown>).id === parsed.deviceId) as Record<string, unknown> | undefined;
                expectedIncarnationId = current ? hyperVDeviceIncarnationId(current) : null;
                if (!expectedIncarnationId) expectedIncarnationId = readHyperVOperationJournal(ownerId, parsed.backend, parsed.deviceId)?.incarnationId || null;
            } catch (error) {
                const stateCode = ownerDeviceStateErrorCode(error);
                if (stateCode) return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
                return {
                    status: 409,
                    payload: {
                        ok: false,
                        error: "hyper-v-operation-journal-invalid",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        detail: hyperVBoundedErrorCode(
                            error,
                            "hyper-v-operation-journal-invalid",
                        ),
                    },
                };
            }
            if (expectedIncarnationId) {
                if (!validHyperVIncarnationId(parsed.expectedIncarnationId)) {
                    return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-required", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
                }
                if (parsed.expectedIncarnationId !== expectedIncarnationId) {
                    return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-conflict", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
                }
            }
        }
        const reconciliation = await reconcileHyperVOperation(ownerId, parsed.backend, parsed.deviceId, normalized, deadlineAt);
        if (!reconciliation.ok) return { status: reconciliation.status, payload: { ok: false, error: reconciliation.error, ownerId, backend: parsed.backend, deviceId: parsed.deviceId, ...(reconciliation.detail ? { detail: reconciliation.detail } : {}) } };
        if (reconciliation.reconciled && parsed.command === "device_delete"
            && !readOwnerDevices(ownerId, parsed.stateKey).some((candidate) => candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).id === parsed.deviceId)) {
            return { status: 200, payload: { ok: true, result: { ownerId, backend: parsed.backend, deviceId: parsed.deviceId, command: parsed.command, reconciled: true, device: null, invoked: true, dryRun: false } } };
        }
        const quotaFailure = hyperVOwnerQuotaFailure(ownerId, parsed);
        if (quotaFailure) return quotaFailure;
        if (parsed.dryRun || parsed.command === "device_status") return await lifecycleCommandInvokeUnlocked(ownerId, params, normalized, undefined, deadlineAt, cleanupDeadlineAt);
        const plan = lifecycleCommandPlan(ownerId, params, normalized, false);
        if (plan.status !== 200) return plan;
        if ((plan.payload as { result?: { idempotent?: boolean } }).result?.idempotent) {
            return await lifecycleCommandInvokeUnlocked(ownerId, params, normalized, undefined, deadlineAt, cleanupDeadlineAt);
        }
        const journal = writeHyperVOperationJournal(ownerId, parsed);
        if (!journal.ok) return { status: 409, payload: { ok: false, error: "hyper-v-operation-journal-write-failed", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, detail: journal.error } };
        const result = await lifecycleCommandInvokeUnlocked(ownerId, params, normalized, undefined, deadlineAt, cleanupDeadlineAt);
        if (result.status >= 200 && result.status < 300) {
            clearHyperVOperationJournal(ownerId, parsed.backend, parsed.deviceId);
        } else if (result.status < 500) {
            clearHyperVOperationJournal(ownerId, parsed.backend, parsed.deviceId);
        }
        return result;
    }
    const preImportQuotaFailure = hyperVOwnerQuotaFailure(ownerId, parsed);
    if (preImportQuotaFailure) return preImportQuotaFailure;
    let existing: unknown[];
    try {
        existing = readOwnerDevices(ownerId, parsed.stateKey);
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    if (existing.some((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId)) {
        return await lifecycleCommandInvokeUnlocked(ownerId, params, normalized, undefined, deadlineAt, cleanupDeadlineAt);
    }
    const siblingBackend = parsed.backend === "windows-vm" ? "linux-vm" : "windows-vm";
    if (readOwnerDevices(ownerId, siblingBackend).some((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId)) {
        return { status: 409, payload: { ok: false, error: "hyper-v-device-id-conflict", ownerId, backend: parsed.backend, conflictingBackend: siblingBackend, deviceId: parsed.deviceId } };
    }
    try {
        if (!parsed.dryRun) {
            const recovery = await reconcileHyperVCreateResidue(ownerId, parsed.backend, parsed.deviceId, normalized, deadlineAt);
            if (!recovery.ok) return { status: recovery.status, payload: { ok: false, error: recovery.error, ownerId, backend: parsed.backend, deviceId: parsed.deviceId, ...(recovery.detail ? { detail: recovery.detail } : {}) } };
        }
        const image = await resolveHyperVImageForCreate(ownerId, parsed, params, normalized, deadlineAt);
        if (!image.ok) {
            return {
                status: image.status,
                payload: {
                    ok: false,
                    error: image.error,
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    ...(image.detail ? { detail: image.detail } : {}),
                    ...(image.remedy ? { remedy: image.remedy } : {}),
                },
            };
        }
        const resolved = validateCommandParams(image.params);
        if (!resolved.ok) return commandParamError(resolved);
        const quotaFailure = hyperVOwnerQuotaFailure(ownerId, resolved);
        if (quotaFailure) return quotaFailure;
        if (resolved.dryRun) return await lifecycleCommandInvokeUnlocked(ownerId, image.params, normalized, undefined, deadlineAt, cleanupDeadlineAt);
        const incarnationId = randomBytes(16).toString("hex");
        const withIncarnation = (base: unknown) => ({
            ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
            incarnationId,
        });
        try {
            writeHyperVIncarnationRecord(ownerId, resolved.backend, resolved.deviceId, incarnationId);
        } catch (error) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "hyper-v-incarnation-record-write-failed",
                    ownerId,
                    backend: resolved.backend,
                    deviceId: resolved.deviceId,
                    detail: hyperVBoundedErrorCode(
                        error,
                        "hyper-v-incarnation-record-write-failed",
                    ),
                },
            };
        }
        if (resolved.create?.networking === false) {
            return await lifecycleCommandInvokeUnlocked(ownerId, withIncarnation(image.params), normalized, undefined, deadlineAt, cleanupDeadlineAt);
        }
        const allocation = await ensureHyperVNetworkAllocation(ownerId, resolved.deviceId, incarnationId, normalized, deadlineAt);
        if (!allocation.ok) {
            const artifactCleanup = allocation.preserveEvidence
                ? { ok: true, removed: false, preserved: true, reason: "hyper-v-network-state-indeterminate" }
                : cleanupHyperVDeviceArtifacts(ownerId, resolved.backend, resolved.deviceId);
            return {
                status: artifactCleanup.ok ? allocation.status : 502,
                payload: {
                    ok: false,
                    error: artifactCleanup.ok ? allocation.error : "hyper-v-allocation-failure-artifact-cleanup-failed",
                    ownerId,
                    backend: resolved.backend,
                    deviceId: resolved.deviceId,
                    ...(allocation.detail ? { detail: allocation.detail } : {}),
                    ...(allocation.execution ? { execution: allocation.execution } : {}),
                    artifactCleanup: publicHyperVArtifactCleanup(artifactCleanup),
                },
            };
        }
        const networkParams = {
            ...withIncarnation(image.params),
            switchName: allocation.switchName,
            networkAddress: allocation.address,
            macAddress: allocation.macAddress,
            networkGateway: allocation.gateway,
            networkPrefix: allocation.prefix,
            outboundPolicy: allocation.outboundPolicy,
        };
        const result = await lifecycleCommandInvokeUnlocked(ownerId, networkParams, normalized, undefined, deadlineAt, cleanupDeadlineAt);
        if (result.status < 200 || result.status >= 300) {
            const lifecyclePayload = result.payload && typeof result.payload === "object" && !Array.isArray(result.payload)
                ? result.payload as Record<string, unknown>
                : null;
            const lifecycleRollback = lifecyclePayload?.rollback
                && typeof lifecyclePayload.rollback === "object"
                && !Array.isArray(lifecyclePayload.rollback)
                ? lifecyclePayload.rollback as Record<string, unknown>
                : null;
            if (lifecycleRollback) return result;
            const reconciliation = await reconcileHyperVCreateResidue(ownerId, resolved.backend, resolved.deviceId, normalized, cleanupDeadlineAt, incarnationId);
            if (!reconciliation.ok) {
                return {
                    status: 502,
                    payload: {
                        ok: false,
                        error: "hyper-v-create-allocation-cleanup-failed",
                        ownerId,
                        backend: resolved.backend,
                        deviceId: resolved.deviceId,
                        detail: reconciliation.detail || reconciliation.error,
                        lifecycleFailure: result.payload,
                    },
                };
            }
        }
        return result;
    } catch (error) {
        if (!(error instanceof HyperVOperationDeadlineError)) throw error;
        const rollback = await reconcileHyperVCreateResidue(ownerId, parsed.backend, parsed.deviceId, normalized, cleanupDeadlineAt);
        if (!rollback.ok) {
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: "hyper-v-create-deadline-cleanup-failed",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    deadlineError: error.code,
                    rollback,
                },
            };
        }
        return {
            status: 504,
            payload: {
                ok: false,
                error: error.code,
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                rollback,
            },
        };
    }
}

async function lifecycleCommandInvoke(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateCommandParams(params);
    if (!parsed.ok) return commandParamError(parsed);
    const hyperVCleanupDeadlineAt = isHyperVBackend(parsed.backend) && !parsed.dryRun
        ? Date.now() + (parsed.command === "device_create"
            ? DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS
            : hyperVLifecycleCleanupTimeoutMs(parsed.backend, parsed.command, hyperVLifecycleOperationTimeoutMs(parsed)))
        : Number.POSITIVE_INFINITY;
    const hyperVDeadlineAt = hyperVProviderDeadlineAt(parsed.backend, parsed.command, hyperVCleanupDeadlineAt);
    if (isHyperVBackend(parsed.backend) && parsed.dryRun) {
        return parsed.command === "device_create"
            ? lifecycleHyperVCommandInvokeLocked(ownerId, params, parsed, normalized)
            : lifecycleCommandInvokeUnlocked(ownerId, params, normalized);
    }
    try {
        return await withOwnerDeviceOperation(ownerId, parsed.stateKey, parsed.deviceId, async () => {
            const hyperVJournalPending = isHyperVBackend(parsed.backend)
                && parsed.command === "device_status"
                && existsSync(hyperVOperationJournalPath(ownerId, parsed.backend, parsed.deviceId));
            if (isHyperVBackend(parsed.backend) && (parsed.command !== "device_status" || hyperVJournalPending)) {
                try {
                    return await withSharedMutationLockAsync(
                        brokerHyperVMutationLockPath(),
                        () => lifecycleHyperVCommandInvokeLocked(ownerId, params, parsed, normalized, hyperVDeadlineAt, hyperVCleanupDeadlineAt),
                        { waitMs: hyperVRemainingTimeout(hyperVDeadlineAt, DEVICE_BROKER_HYPER_V_HOST_LOCK_WAIT_MS), staleMs: DEVICE_BROKER_HYPER_V_HOST_LOCK_STALE_MS },
                    );
                } catch (error) {
                    if (!isDeviceOperationLockTimeout(error)) throw error;
                    return {
                        status: 409,
                        payload: {
                            ok: false,
                            error: "hyper-v-host-operation-lock-failed",
                            ownerId,
                            backend: parsed.backend,
                            deviceId: parsed.deviceId,
                            detail: hyperVBoundedErrorCode(
                                error,
                                "hyper-v-host-operation-lock-failed",
                            ),
                        },
                    };
                }
            }
            if (parsed.backend !== "android-emulator" || (parsed.command !== "device_create" && parsed.command !== "device_start")) {
                return await lifecycleCommandInvokeUnlocked(ownerId, params, normalized);
            }
            try {
                return await withSharedMutationLockAsync(
                    androidEmulatorPortAllocationLockFile(),
                    async () => {
                        const initialPlan = lifecycleCommandPlan(ownerId, params, normalized, false);
                        if (initialPlan.status !== 200) return initialPlan;
                        if (parsed.dryRun) return await lifecycleCommandInvokeUnlocked(ownerId, params, normalized);
                        if (parsed.command === "device_start") {
                            return await lifecycleCommandInvokeUnlocked(ownerId, params, normalized);
                        }
                        const allocation = resolveAndroidEmulatorCreatePortForInvoke(ownerId, parsed, normalized);
                        if (!allocation.ok) {
                            return {
                                status: allocation.status,
                                payload: {
                                    ok: false,
                                    error: allocation.error,
                                    ...(allocation.allowed ? { allowed: allocation.allowed } : {}),
                                    ...(allocation.detail ? { detail: allocation.detail } : {}),
                                    ownerId,
                                    backend: parsed.backend,
                                    deviceId: parsed.deviceId,
                                },
                            };
                        }
                        return await lifecycleCommandInvokeUnlocked(ownerId, {
                            ...(params as Record<string, unknown>),
                            port: allocation.port,
                        }, normalized);
                    },
                    { waitMs: DEVICE_BROKER_ANDROID_PORT_LOCK_WAIT_MS, staleMs: DEVICE_BROKER_ANDROID_PORT_LOCK_STALE_MS },
                );
            } catch (error) {
                if (!isDeviceOperationLockTimeout(error)) throw error;
                return {
                    status: 409,
                    payload: {
                        ok: false,
                        error: "android-emulator-port-allocation-lock-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        detail: error instanceof Error ? error.message : String(error),
                    },
                };
            }
        });
    } catch (error) {
        if (error instanceof HyperVOperationDeadlineError) {
            return {
                status: 504,
                payload: {
                    ok: false,
                    error: error.code,
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
        if (!isDeviceOperationLockTimeout(error)) throw error;
        return {
            status: 409,
            payload: {
                ok: false,
                error: "device-operation-lock-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                detail: error instanceof Error ? error.message : String(error),
            },
        };
    }
}

function ownerDeviceNotFound(ownerId: string, backend: string, deviceId: string) {
    return {
        status: 404,
        payload: {
            ok: false,
            error: "owner-device-not-found",
            ownerId,
            backend,
            deviceId,
        },
    };
}

function appiumSessionStatus(ownerId: string, params: unknown) {
    const parsed = validateAppiumParams(params, "status");
    if (!parsed.ok) return appiumParamError(parsed);
    let devices: unknown[];
    try {
        devices = readOwnerDevices(ownerId, parsed.stateKey);
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    const device = devices.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
    if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
    const appium = device && typeof device === "object" ? (device as { appium?: unknown }).appium ?? null : null;
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                device,
                appium,
                authority: "host-broker",
            },
        },
    };
}

function appiumSessionList(ownerId: string, params: unknown) {
    const parsed = validateAppiumListParams(params);
    if (!parsed.ok) return appiumParamError(parsed);
    let devices: unknown[];
    try {
        devices = readOwnerDevices(ownerId, parsed.stateKey);
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    const sessions = devices
        .filter((device) => device && typeof device === "object")
        .map((device) => {
            const record = device as Record<string, unknown>;
            return {
                deviceId: record.id,
                status: record.status ?? null,
                appium: record.appium ?? null,
            };
        })
        .filter((session) => typeof session.deviceId === "string");
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                authority: "host-broker",
                sessions,
            },
        },
    };
}

function appiumLiveRuntimeMetadataConflict(ownerId: string, parsed: AppiumParamSuccess, appium: unknown, normalized: NormalizedBrokerOptions): BrokerRpcResult | null {
    if (!liveBrokerOwnedAppiumRuntime(appium, normalized)) return null;
    return {
        status: 409,
        payload: {
            ok: false,
            error: "appium-runtime-active",
            ownerId,
            backend: parsed.backend,
            stateKey: parsed.stateKey,
            deviceId: parsed.deviceId,
            remedy: "stop the broker-owned Appium server before replacing or clearing its metadata",
        },
    };
}

function recordAppiumSession(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAppiumParams(params, "record");
    if (!parsed.ok) return appiumParamError(parsed);
    const metadata = appiumMetadata(params);
    if (!metadata.ok) return { status: metadata.status, payload: { ok: false, error: metadata.error } };
    let device: unknown;
    try {
        ({ device } = findOwnerAppiumDevice(ownerId, parsed));
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    if (!device || typeof device !== "object" || Array.isArray(device)) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
    const currentAppium = (device as Record<string, unknown>).appium ?? null;
    const liveConflict = appiumLiveRuntimeMetadataConflict(ownerId, parsed, currentAppium, normalized);
    if (liveConflict) return liveConflict;
    const transition = transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, currentAppium, metadata.appium);
    if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition);
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                device: transition.device,
                appium: metadata.appium,
                authority: "host-broker",
            },
        },
    };
}

function clearAppiumSession(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAppiumParams(params, "clear");
    if (!parsed.ok) return appiumParamError(parsed);
    let device: unknown;
    try {
        ({ device } = findOwnerAppiumDevice(ownerId, parsed));
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    if (!device || typeof device !== "object" || Array.isArray(device)) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
    const currentAppium = (device as Record<string, unknown>).appium ?? null;
    const liveConflict = appiumLiveRuntimeMetadataConflict(ownerId, parsed, currentAppium, normalized);
    if (liveConflict) return liveConflict;
    const transition = transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, currentAppium, null);
    if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition);
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                device: transition.device,
                cleared: true,
                authority: "host-broker",
            },
        },
    };
}

function appiumRuntimeMatches(expected: unknown, current: unknown): boolean {
    if (expected === null || expected === undefined) return current === null || current === undefined;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
        || !current || typeof current !== "object" || Array.isArray(current)) return false;
    const expectedRecord = expected as Record<string, unknown>;
    const currentRecord = current as Record<string, unknown>;
    const expectedRuntimeId = typeof expectedRecord.runtimeId === "string" ? expectedRecord.runtimeId : null;
    const currentRuntimeId = typeof currentRecord.runtimeId === "string" ? currentRecord.runtimeId : null;
    if (expectedRuntimeId || currentRuntimeId) return expectedRuntimeId !== null && expectedRuntimeId === currentRuntimeId;
    const identityFields = ["authority", "processOwner", "startedBy", "serverPid", "serverUrl", "updatedAt"];
    return identityFields.every((field) => expectedRecord[field] === currentRecord[field]);
}

function transitionOwnerAppiumRuntime(
    ownerId: string,
    stateKey: string,
    deviceId: string,
    expected: unknown,
    replacement: Record<string, unknown> | null,
) {
    let found = false;
    let matched = false;
    let currentAppium: unknown = null;
    let updatedDevice: Record<string, unknown> | null = null;
    mutateOwnerDevices(ownerId, stateKey, (devices) => devices.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || (candidate as { id?: unknown }).id !== deviceId) return candidate;
        found = true;
        const record = candidate as Record<string, unknown>;
        currentAppium = record.appium ?? null;
        if (!appiumRuntimeMatches(expected, currentAppium)) return candidate;
        matched = true;
        const updatedAt = typeof replacement?.updatedAt === "string" ? replacement.updatedAt : new Date().toISOString();
        updatedDevice = {
            ...record,
            appium: replacement,
            ...(typeof replacement?.port === "number" ? { appiumPort: replacement.port } : {}),
            updatedAt,
        };
        return updatedDevice;
    }));
    return { found, matched, currentAppium, device: updatedDevice };
}

async function startAppiumServerUnlocked(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAppiumParams(params, "start");
    if (!parsed.ok) return appiumParamError(parsed);
    let devices: unknown[];
    try {
        devices = readOwnerDevices(ownerId, parsed.stateKey);
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    const device = devices.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
    if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
    const existingAppium = device && typeof device === "object" ? (device as { appium?: unknown }).appium : null;
    const force = (params as { force?: unknown })?.force === true;
    const reusableRuntime = reusableBrokerOwnedAppium(existingAppium, normalized);
    const reusableListener = reusableRuntime ? verifyBrokerOwnedAppiumListener(existingAppium, normalized) : null;
    const reusable = reusableRuntime && reusableListener?.ok === true;
    if (existingAppium && typeof existingAppium === "object" && !force && reusable) {
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ownerId,
                    backend: parsed.backend,
                    stateKey: parsed.stateKey,
                    deviceId: parsed.deviceId,
                    device,
                    appium: existingAppium,
                    started: false,
                    reused: true,
                    authority: "host-broker",
                },
            },
        };
    }
    const replaced = force || (existingAppium && typeof existingAppium === "object" && !reusable)
        ? await terminateBrokerOwnedAppiumAndWait(existingAppium, normalized)
        : { attempted: false, ok: true };
    if (!replaced.ok) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "appium-existing-process-stop-failed",
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                appium: existingAppium,
                replaced,
            },
        };
    }
    const record = device as Record<string, unknown>;
    const portSelection = selectAvailableAppiumPort(ownerId, parsed.backend, parsed.deviceId, params, record, normalized);
    if (!portSelection.ok) {
        return {
            status: 409,
            payload: {
                ok: false,
                error: portSelection.error,
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                portSelection,
            },
        };
    }
    const port = portSelection.port;
    const serverUrl = `http://127.0.0.1:${port}`;
    const appiumArgs = ["server", "--port", String(port), "--base-path", "/"];
    if (parsed.backend.startsWith("android")) appiumArgs.push("--allow-insecure", "uiautomator2:adb_shell");
    const runtime = ensureBrokerAppiumRuntime(normalized);
    if (!runtime.ok) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: runtime.error,
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                runtime,
            },
        };
    }
    if (runtime.source === "provider-path") {
        try {
            ensureBrokerAppiumRuntimeDirectory();
        } catch (error) {
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: appiumRuntimeOperationError(error, "appium-runtime-directory-invalid"),
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
    }
    if (runtime.source === "broker-runtime") {
        try {
            if (!inspectBrokerAppiumRuntimeDirectory() || !brokerAppiumRuntimeEntryIsValid(runtime.argsPrefix[0] || "")) {
                throw new Error("appium-runtime-entry-invalid");
            }
        } catch (error) {
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: appiumRuntimeOperationError(error, "appium-runtime-entry-invalid"),
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
    }
    const portCleanup = terminateManagedAppiumPortListener(port, normalized);
    if (!portCleanup.ok) {
        return {
            status: 409,
            payload: {
                ok: false,
                error: portCleanup.error || "appium-port-cleanup-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                portCleanup,
            },
        };
    }
    const command: ProviderCommand = {
        mode: "detached",
        provider: "appium",
        executable: runtime.executable,
        args: [...runtime.argsPrefix, ...appiumArgs],
        env: appiumCommandEnv(parsed.backend, normalized),
        cwd: brokerAppiumRuntimeRoot(),
    };
    const execution = normalized.usesDefaultCommandRunner
        ? await startDetachedProviderCommand(command, normalized, "Appium server")
        : normalized.commandRunner(command, {
            timeoutMs: normalized.commandTimeoutMs,
            outputLimit: DEVICE_BROKER_COMMAND_OUTPUT_LIMIT,
        });
    if (!commandSucceeded(execution)) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "appium-server-start-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                execution,
            },
        };
    }
    const appium = {
        authority: "host-broker",
        processOwner: "host-broker",
        startedBy: "broker.appium.start",
        runtimeId: randomBytes(16).toString("hex"),
        launchPolicy: DEVICE_BROKER_APPIUM_LAUNCH_POLICY,
        serverUrl,
        serverPid: execution.pid ?? null,
        ...(execution.processIdentity ? { processIdentity: execution.processIdentity } : {}),
        port,
        automationName: appiumAutomationName(parsed.backend),
        provider: appiumProviderName(parsed.backend),
        physical: parsed.backend.endsWith("-device"),
        updatedAt: new Date().toISOString(),
    };
    const transition = transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, existingAppium, appium);
    if (!transition.matched) {
        const rollback = await terminateBrokerOwnedAppiumAndWait(appium, normalized);
        return {
            status: 409,
            payload: {
                ok: false,
                error: "appium-runtime-state-conflict",
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                found: transition.found,
                currentAppium: transition.currentAppium,
                rollback,
            },
        };
    }
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                appium,
                started: true,
                reused: false,
                replaced,
                authority: "host-broker",
                execution,
                portCleanup,
                portSelection,
                runtime: {
                    provisioned: runtime.provisioned,
                    source: runtime.source,
                },
                session: null,
            },
        },
    };
}

async function stopAppiumServerUnlocked(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAppiumParams(params, "stop");
    if (!parsed.ok) return appiumParamError(parsed);
    let devices: unknown[];
    try {
        devices = readOwnerDevices(ownerId, parsed.stateKey);
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    const device = devices.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
    if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
    const appium = device && typeof device === "object" ? (device as { appium?: unknown }).appium : null;
    const signal = await terminateBrokerOwnedAppiumAndWait(appium, normalized);
    if (!signal.ok) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "appium-stop-failed",
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                appium,
                signal,
                authority: "host-broker",
            },
        };
    }
    const transition = transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, appium, null);
    if (!transition.matched && transition.currentAppium !== null) {
        return {
            status: 409,
            payload: {
                ok: false,
                error: "appium-runtime-state-conflict",
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                currentAppium: transition.currentAppium,
                signal,
                authority: "host-broker",
            },
        };
    }
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                stopped: true,
                stalePid: "stale" in signal && signal.stale === true,
                signal,
                authority: "host-broker",
            },
        },
    };
}

function findOwnerAppiumDevice(ownerId: string, parsed: AppiumParamSuccess) {
    const devices = readOwnerDevices(ownerId, parsed.stateKey);
    const device = devices.find((candidate) => candidate && typeof candidate === "object" && (candidate as { id?: unknown }).id === parsed.deviceId);
    return { devices, device };
}

function writeUpdatedAppiumDevice(
    ownerId: string,
    parsed: AppiumParamSuccess,
    expected: unknown,
    appium: Record<string, unknown> | null,
) {
    return transitionOwnerAppiumRuntime(ownerId, parsed.stateKey, parsed.deviceId, expected, appium);
}

function appiumRuntimeStateConflict(ownerId: string, parsed: AppiumParamSuccess, transition: ReturnType<typeof transitionOwnerAppiumRuntime>, detail: Record<string, unknown> = {}) {
    return {
        status: 409,
        payload: {
            ok: false,
            error: "appium-runtime-state-conflict",
            ownerId,
            backend: parsed.backend,
            stateKey: parsed.stateKey,
            deviceId: parsed.deviceId,
            found: transition.found,
            currentAppium: transition.currentAppium,
            ...detail,
        },
    };
}

function appiumListenerOwnershipFailure(ownerId: string, parsed: AppiumParamSuccess, verification: ReturnType<typeof verifyBrokerOwnedAppiumListener>) {
    return {
        status: 409,
        payload: {
            ok: false,
            error: "appium-listener-ownership-unverified",
            ownerId,
            backend: parsed.backend,
            stateKey: parsed.stateKey,
            deviceId: parsed.deviceId,
            verification,
        },
    };
}

async function ensureAppiumWebDriverSessionUnlocked(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAppiumParams(params, "session");
    if (!parsed.ok) return appiumParamError(parsed);
    let device: unknown;
    try {
        ({ device } = findOwnerAppiumDevice(ownerId, parsed));
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
    if (parsed.backend === "ios-simulator") {
        const ownedTarget = resolveBrokerOwnedIosSimulatorTarget(ownerId, device, normalized);
        if (!ownedTarget.ok) {
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: ownedTarget.error,
                    missing: ownedTarget.missing,
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                },
            };
        }
        device = { ...(device as Record<string, unknown>), udid: ownedTarget.target };
    }

    let appium = device && typeof device === "object" && (device as { appium?: unknown }).appium && typeof (device as { appium?: unknown }).appium === "object"
        ? { ...((device as { appium: Record<string, unknown> }).appium) }
        : {};
    const force = params && typeof params === "object" && !Array.isArray(params) && (params as { force?: unknown }).force === true;
    const existingEndpoint = brokerOwnedAppiumEndpoint(appium);
    const existingVerification = (claimsBrokerOwnedAppiumRuntime(appium) || existingEndpoint.ok)
        ? verifyBrokerOwnedAppiumListener(appium, normalized)
        : null;
    if (existingVerification && !existingVerification.ok) {
        return appiumListenerOwnershipFailure(ownerId, parsed, existingVerification);
    }
    const existingServerUrl = existingVerification?.ok ? existingVerification.serverUrl : null;
    if (existingServerUrl && typeof appium.sessionId === "string" && force) {
        const deleteResponse = await fetchAppiumJson(`${existingServerUrl}/session/${encodeURIComponent(appium.sessionId)}`, { method: "DELETE", timeoutMs: normalized.commandTimeoutMs });
        if (!deleteResponse.ok) {
            return {
                status: 502,
                payload: {
                    ok: false,
                    error: "appium-session-delete-failed",
                    result: {
                        ownerId,
                        backend: parsed.backend,
                        stateKey: parsed.stateKey,
                        deviceId: parsed.deviceId,
                        appium,
                        created: false,
                        reused: false,
                        authority: "host-broker",
                        response: deleteResponse,
                    },
                },
            };
        }
        const previousAppium = appium;
        appium = { ...appium, sessionId: null, sessionCapabilities: null, updatedAt: new Date().toISOString() };
        const transition = writeUpdatedAppiumDevice(ownerId, parsed, previousAppium, appium);
        if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition, { response: deleteResponse });
    }
    if (existingServerUrl && typeof appium.sessionId === "string" && !force) {
        const status = await fetchAppiumJson(`${existingServerUrl}/status`, { method: "GET", timeoutMs: normalized.commandTimeoutMs });
        const session = status.ok ? await fetchAppiumJson(`${existingServerUrl}/session/${encodeURIComponent(appium.sessionId)}`, { method: "GET", timeoutMs: normalized.commandTimeoutMs }) : null;
        if (status.ok && session?.ok) {
            return {
                status: 200,
                payload: {
                    ok: true,
                    result: {
                        ownerId,
                        backend: parsed.backend,
                        stateKey: parsed.stateKey,
                        deviceId: parsed.deviceId,
                        appium,
                        reused: true,
                        created: false,
                        authority: "host-broker",
                    },
                },
            };
        }
        const previousAppium = appium;
        appium = { ...appium, sessionId: null, sessionCapabilities: null, updatedAt: new Date().toISOString() };
        const transition = writeUpdatedAppiumDevice(ownerId, parsed, previousAppium, appium);
        if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition, { status, session });
    }

    let startedServer = false;
    if (!brokerLaunchedAppiumServerUrl(appium)) {
        const started = await startAppiumServerUnlocked(ownerId, params, normalized);
        if (started.status !== 200) return started;
        startedServer = true;
        try {
            ({ device } = findOwnerAppiumDevice(ownerId, parsed));
        } catch (error) {
            return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        appium = device && typeof device === "object" && (device as { appium?: unknown }).appium && typeof (device as { appium?: unknown }).appium === "object"
            ? { ...((device as { appium: Record<string, unknown> }).appium) }
            : {};
    }

    const listenerVerification = startedServer
        ? await waitForBrokerOwnedAppiumListener(appium, normalized)
        : verifyBrokerOwnedAppiumListener(appium, normalized);
    if (!listenerVerification.ok) return appiumListenerOwnershipFailure(ownerId, parsed, listenerVerification);
    const serverUrl = listenerVerification.serverUrl;
    const readiness = await waitForAppiumServerReady(serverUrl);
    if (!readiness.ok) {
        const signal = await terminateBrokerOwnedAppiumAndWait(appium, normalized);
        const transition = signal.ok ? writeUpdatedAppiumDevice(ownerId, parsed, appium, null) : null;
        if (transition && !transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition, { readiness, signal });
        return {
            status: 502,
            payload: {
                ok: false,
                error: "appium-server-not-ready",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                readiness,
                signal,
            },
        };
    }
    const capabilities = appiumCapabilities(parsed.backend, device);
    let response = await fetchAppiumJson(`${serverUrl}/session`, {
        method: "POST",
        body: { capabilities: { alwaysMatch: capabilities } },
        timeoutMs: DEVICE_BROKER_APPIUM_SESSION_TIMEOUT_MS,
    });
    let instrumentationRecovery = null;
    if (!response.ok && parsed.backend.startsWith("android") && appiumInstrumentationInitializationFailed(response)) {
        instrumentationRecovery = resetAndroidAppiumInstrumentation(device, normalized);
        if (instrumentationRecovery.attempted) {
            response = await fetchAppiumJson(`${serverUrl}/session`, {
                method: "POST",
                body: { capabilities: { alwaysMatch: capabilities } },
                timeoutMs: DEVICE_BROKER_APPIUM_SESSION_TIMEOUT_MS,
            });
        }
    }
    if (!response.ok) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "appium-session-create-failed",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                response,
                ...(instrumentationRecovery ? { instrumentationRecovery } : {}),
            },
        };
    }
    const responseBody = response.body as { value?: { sessionId?: unknown }; sessionId?: unknown } | null;
    const sessionId = typeof responseBody?.value?.sessionId === "string"
        ? responseBody.value.sessionId
        : typeof responseBody?.sessionId === "string"
            ? responseBody.sessionId
            : null;
    if (!sessionId) {
        return { status: 502, payload: { ok: false, error: "appium-session-id-missing", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, response } };
    }
    const updatedAppium = {
        ...appium,
        authority: "host-broker",
        sessionId,
        sessionCapabilities: capabilities,
        ...(instrumentationRecovery ? { instrumentationRecovery: { attempted: true, recovered: true, updatedAt: new Date().toISOString() } } : {}),
        updatedAt: new Date().toISOString(),
    };
    const transition = writeUpdatedAppiumDevice(ownerId, parsed, appium, updatedAppium);
    if (!transition.matched) {
        const rollback = await fetchAppiumJson(`${serverUrl}/session/${encodeURIComponent(sessionId)}`, { method: "DELETE", timeoutMs: normalized.commandTimeoutMs });
        return appiumRuntimeStateConflict(ownerId, parsed, transition, { response, rollback });
    }
    const updatedDevice = transition.device;
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                device: updatedDevice,
                appium: updatedAppium,
                created: true,
                reused: false,
                authority: "host-broker",
                response,
            },
        },
    };
}

async function deleteAppiumWebDriverSessionUnlocked(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAppiumParams(params, "delete-session");
    if (!parsed.ok) return appiumParamError(parsed);
    let device: unknown;
    try {
        ({ device } = findOwnerAppiumDevice(ownerId, parsed));
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
    const appium = device && typeof device === "object" && (device as { appium?: unknown }).appium && typeof (device as { appium?: unknown }).appium === "object"
        ? { ...((device as { appium: Record<string, unknown> }).appium) }
        : null;
    if (!appium || typeof appium.sessionId !== "string") {
        return { status: 200, payload: { ok: true, result: { ownerId, backend: parsed.backend, stateKey: parsed.stateKey, deviceId: parsed.deviceId, deleted: false, authority: "host-broker" } } };
    }
    const listenerVerification = verifyBrokerOwnedAppiumListener(appium, normalized);
    if (!listenerVerification.ok) return appiumListenerOwnershipFailure(ownerId, parsed, listenerVerification);
    const serverUrl = listenerVerification.serverUrl;
    const response = await fetchAppiumJson(`${serverUrl}/session/${encodeURIComponent(appium.sessionId)}`, { method: "DELETE", timeoutMs: normalized.commandTimeoutMs });
    if (!response.ok) {
        return {
            status: 502,
            payload: {
                ok: false,
                error: "appium-session-delete-failed",
                result: {
                    ownerId,
                    backend: parsed.backend,
                    stateKey: parsed.stateKey,
                    deviceId: parsed.deviceId,
                    appium,
                    deleted: false,
                    authority: "host-broker",
                    response,
                },
            },
        };
    }
    const { sessionId: _sessionId, sessionCapabilities: _sessionCapabilities, ...remainingAppium } = appium;
    const updatedAppium = { ...remainingAppium, updatedAt: new Date().toISOString() };
    const transition = writeUpdatedAppiumDevice(ownerId, parsed, appium, updatedAppium);
    if (!transition.matched) return appiumRuntimeStateConflict(ownerId, parsed, transition, { response });
    const updatedDevice = transition.device;
    return {
        status: 200,
        payload: {
            ok: true,
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                device: updatedDevice,
                appium: updatedAppium,
                deleted: response.ok,
                authority: "host-broker",
                response,
            },
        },
    };
}

async function proxyAppiumWebDriverRequest(ownerId: string, params: unknown, normalized: NormalizedBrokerOptions) {
    const parsed = validateAppiumRequestParams(params);
    if (!parsed.ok) return appiumParamError(parsed);
    let device: unknown;
    try {
        ({ device } = findOwnerAppiumDevice(ownerId, parsed));
    } catch (error) {
        return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
    }
    if (!device) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
    const appium = device && typeof device === "object" && (device as { appium?: unknown }).appium && typeof (device as { appium?: unknown }).appium === "object"
        ? (device as { appium: Record<string, unknown> }).appium
        : null;
    if (!appium || typeof appium.sessionId !== "string") {
        return { status: 400, payload: { ok: false, error: "missing-appium-session", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
    }
    const listenerVerification = verifyBrokerOwnedAppiumListener(appium, normalized);
    if (!listenerVerification.ok) return appiumListenerOwnershipFailure(ownerId, parsed, listenerVerification);
    const serverUrl = listenerVerification.serverUrl;
    const response = await fetchAppiumJson(`${serverUrl}/session/${encodeURIComponent(appium.sessionId)}${parsed.path}`, {
        method: parsed.method,
        body: parsed.method === "GET" ? undefined : parsed.body,
        timeoutMs: appiumWebDriverRequestTimeoutMs(normalized.commandTimeoutMs),
    });
    return {
        status: response.ok ? 200 : 502,
        payload: {
            ok: response.ok,
            ...(response.ok ? {} : { error: "appium-request-failed" }),
            result: {
                ownerId,
                backend: parsed.backend,
                stateKey: parsed.stateKey,
                deviceId: parsed.deviceId,
                method: parsed.method,
                path: parsed.path,
                authority: "host-broker",
                response,
            },
        },
    };
}

async function withAppiumDeviceOperation(
    ownerId: string,
    params: unknown,
    action: "record" | "clear" | "start" | "stop" | "session" | "delete-session" | "request",
    operation: () => Promise<BrokerRpcResult> | BrokerRpcResult,
): Promise<BrokerRpcResult> {
    const parsed = action === "request" ? validateAppiumRequestParams(params) : validateAppiumParams(params, action);
    if (!parsed.ok) return appiumParamError(parsed);
    try {
        return await withOwnerDeviceOperation(ownerId, parsed.stateKey, parsed.deviceId, () => {
            if (DEVICE_BROKER_PHYSICAL_BACKENDS.has(parsed.stateKey)
                && (action === "session" || action === "delete-session" || action === "request")) {
                let device: unknown;
                try {
                    ({ device } = findOwnerAppiumDevice(ownerId, parsed));
                } catch (error) {
                    return ownerDeviceStateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
                }
                if (!device || typeof device !== "object" || Array.isArray(device)) return ownerDeviceNotFound(ownerId, parsed.backend, parsed.deviceId);
                const leaseFailure = refreshPhysicalDeviceLeaseForOperation(ownerId, {
                    stateKey: parsed.stateKey,
                    backend: parsed.backend,
                    device: device as Record<string, unknown>,
                }, parsed.deviceId);
                if (leaseFailure) return leaseFailure;
            }
            return operation();
        });
    } catch (error) {
        if (!isDeviceOperationLockTimeout(error)) throw error;
        return deviceOperationLockFailure(ownerId, parsed.backend, parsed.deviceId, error);
    }
}

async function handleBrokerRpcUnsafe(ownerId: string, body: unknown, normalized: NormalizedBrokerOptions, startedAt: string): Promise<BrokerRpcResult> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return { status: 400, payload: { ok: false, error: "invalid-rpc-body" } };
    }
    const rpc = body as { method?: unknown; params?: unknown; ownerId?: unknown };
    const method = typeof rpc.method === "string" ? rpc.method : "";
    if (rpc.ownerId !== undefined && rpc.ownerId !== ownerId) {
        return { status: 403, payload: { ok: false, error: "owner-mismatch", ownerId } };
    }
    if (!method) return { status: 400, payload: { ok: false, error: "missing-method" } };
    if (LIFECYCLE_METHOD_RE.test(method)) {
        return {
            status: 501,
            payload: {
                ok: false,
                error: "method-not-implemented",
                method,
                deferred: "mutating backend command proxy is intentionally not implemented in this broker transport slice",
            },
        };
    }
    if (method === "broker.status") {
        return { status: 200, payload: { ok: true, result: deviceBrokerStatus({ ...normalized, startedAt, ownerId }) } };
    }
    if (method === "broker.service.manager") {
        const params = rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params) ? rpc.params as { action?: unknown; dryRun?: unknown; host?: unknown; port?: unknown } : {};
        const action = typeof params.action === "string" ? params.action : "status";
        const result = deviceBrokerService(action, {
            ...normalized,
            host: typeof params.host === "string" ? params.host : normalized.host,
            port: typeof params.port === "number" ? params.port : normalized.port,
            dryRun: params.dryRun === true,
            ownerId,
        });
        const error = "error" in result ? result.error : "";
        const status = result.ok
            ? 200
            : error === "service-manager-unsupported"
                ? 501
                : 400;
        return { status, payload: { ok: result.ok, ...(result.ok ? {} : { error: "service-manager-failed" }), result } };
    }
    if (method === "broker.inventory") {
        return { status: 200, payload: { ok: true, result: ownerInventory(ownerId, true) } };
    }
    if (method === "broker.backends") {
        return { status: 200, payload: { ok: true, result: await hostBackends(ownerId, normalized) } };
    }
    if (method === "broker.echo") {
        return { status: 200, payload: { ok: true, result: { ownerId, params: rpc.params ?? null } } };
    }
    if (method === "broker.cleanup.owner") return cleanupOwnerRuntime(ownerId, rpc.params, normalized);
    if (method === "broker.lease.claim") return claimPhysicalLease(ownerId, rpc.params);
    if (method === "broker.lease.list") return listPhysicalBrokerLeases(ownerId, rpc.params);
    if (method === "broker.lease.heartbeat") return heartbeatPhysicalBrokerLease(ownerId, rpc.params);
    if (method === "broker.lease.prune") return prunePhysicalBrokerLeases(ownerId, rpc.params);
    if (method === "broker.lease.release") return releasePhysicalBrokerLease(ownerId, rpc.params);
    if (method === "broker.physical.attach") return withPhysicalDeviceOperation(ownerId, rpc.params, () => attachPhysicalDevice(ownerId, rpc.params, normalized));
    if (method === "broker.physical.detach") return withPhysicalDeviceOperation(ownerId, rpc.params, () => detachPhysicalDevice(ownerId, rpc.params, normalized));
    if (method === "broker.physical.list") return listAttachedPhysicalDevices(ownerId, rpc.params, normalized);
    if (method === "broker.apple.trust") return appleTrustStatus(ownerId, rpc.params, normalized);
    if (method === "broker.command.plan") return lifecycleCommandPlan(ownerId, rpc.params, normalized);
    if (method === "broker.command.invoke") return lifecycleCommandInvoke(ownerId, rpc.params, normalized);
    if (method === "broker.device.tool.invoke") return invokeDeviceTool(ownerId, rpc.params, normalized);
    if (method === "broker.appium.status") return appiumSessionStatus(ownerId, rpc.params);
    if (method === "broker.appium.list") return appiumSessionList(ownerId, rpc.params);
    if (method === "broker.appium.record") return withAppiumDeviceOperation(ownerId, rpc.params, "record", () => recordAppiumSession(ownerId, rpc.params, normalized));
    if (method === "broker.appium.clear") return withAppiumDeviceOperation(ownerId, rpc.params, "clear", () => clearAppiumSession(ownerId, rpc.params, normalized));
    if (method === "broker.appium.start") return withAppiumDeviceOperation(ownerId, rpc.params, "start", () => startAppiumServerUnlocked(ownerId, rpc.params, normalized));
    if (method === "broker.appium.stop") return withAppiumDeviceOperation(ownerId, rpc.params, "stop", () => stopAppiumServerUnlocked(ownerId, rpc.params, normalized));
    if (method === "broker.appium.session.ensure") return withAppiumDeviceOperation(ownerId, rpc.params, "session", () => ensureAppiumWebDriverSessionUnlocked(ownerId, rpc.params, normalized));
    if (method === "broker.appium.session.delete") return withAppiumDeviceOperation(ownerId, rpc.params, "delete-session", () => deleteAppiumWebDriverSessionUnlocked(ownerId, rpc.params, normalized));
    if (method === "broker.appium.request") return withAppiumDeviceOperation(ownerId, rpc.params, "request", () => proxyAppiumWebDriverRequest(ownerId, rpc.params, normalized));
    return { status: 404, payload: { ok: false, error: "unknown-method", method } };
}

async function handleBrokerRpc(ownerId: string, body: unknown, normalized: NormalizedBrokerOptions, startedAt: string): Promise<BrokerRpcResult> {
    try {
        return await handleBrokerRpcUnsafe(ownerId, body, normalized, startedAt);
    } catch (error) {
        if (ownerDeviceStateErrorCode(error)) return ownerDeviceStateFailure(error);
        const stateError = deviceLabStateFileErrorCode(error);
        if (stateError) {
            return {
                status: stateError.endsWith("-file-too-large") ? 413 : stateError.endsWith("-state-read-failed") ? 503 : 409,
                payload: { ok: false, error: stateError },
            };
        }
        throw error;
    }
}

function authorizeBrokerRpc(
    req: IncomingMessage,
    ownerId: string,
    body: unknown,
    startedAt: string,
): { ok: true } | { ok: false; status: number; error: string } {
    const token = req.headers["x-ccc-device-token"];
    const expected = existingDeviceBrokerOwnerToken(ownerId);
    if (!expected) {
        return { ok: false, status: 401, error: "invalid-owner-token" };
    }
    if (typeof token === "string") {
        const actualBytes = Buffer.from(token);
        const expectedBytes = Buffer.from(expected);
        if (actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)) {
            return { ok: true };
        }
    }
    const signature = req.headers["x-ccc-device-auth"];
    const timestamp = req.headers["x-ccc-device-auth-timestamp"];
    const nonce = req.headers["x-ccc-device-auth-nonce"];
    const claimedStartedAt = req.headers["x-ccc-device-broker-started-at"];
    const claimedStartToken = req.headers["x-ccc-device-broker-start-token"];
    const processStartToken = readDeviceRuntimeProcessStartToken(process.pid);
    const timestampMs = typeof timestamp === "string" ? Number(timestamp) : Number.NaN;
    if (typeof signature !== "string"
        || !/^[a-f0-9]{64}$/.test(signature)
        || !Number.isFinite(timestampMs)
        || Math.abs(Date.now() - timestampMs) > 60_000
        || typeof nonce !== "string"
        || !/^[a-f0-9]{32}$/.test(nonce)
        || claimedStartedAt !== startedAt
        || typeof claimedStartToken !== "string"
        || !processStartToken
        || claimedStartToken !== processStartToken) {
        return { ok: false, status: 401, error: "invalid-owner-token" };
    }
    const bodyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const payload = ["v1", ownerId, String(timestamp), nonce, startedAt, processStartToken, bodyHash].join("\n");
    const expectedSignature = createHmac("sha256", expected).update(payload).digest("hex");
    const actualBytes = Buffer.from(signature, "hex");
    const expectedBytes = Buffer.from(expectedSignature, "hex");
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
        return { ok: false, status: 401, error: "invalid-owner-token" };
    }
    const now = Date.now();
    for (const [key, acceptedAt] of brokerAuthNonces) {
        if (now - acceptedAt > 60_000) brokerAuthNonces.delete(key);
    }
    const nonceKey = `${ownerId}:${nonce}`;
    if (brokerAuthNonces.has(nonceKey)) return { ok: false, status: 409, error: "broker-auth-replay" };
    brokerAuthNonces.set(nonceKey, now);
    return { ok: true };
}

function brokerRpcMutatesOwnerState(body: unknown): boolean {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const rpc = body as { method?: unknown; params?: unknown };
    if (typeof rpc.method !== "string") return false;
    if (DEVICE_BROKER_MUTATING_RPC_METHODS.has(rpc.method)) return true;
    if (rpc.method !== "broker.device.tool.invoke") return false;
    const params = rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params)
        ? rpc.params as { tool?: unknown }
        : {};
    return typeof params.tool !== "string" || !DEVICE_BROKER_READ_ONLY_TOOL_METHODS.has(params.tool);
}

async function serializeBrokerOwnerMutation(ownerId: string, task: () => Promise<BrokerRpcResult>): Promise<BrokerRpcResult> {
    const previous = brokerOwnerMutationTails.get(ownerId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    brokerOwnerMutationTails.set(ownerId, current);
    await previous;
    try {
        return await task();
    } finally {
        release();
        if (brokerOwnerMutationTails.get(ownerId) === current) brokerOwnerMutationTails.delete(ownerId);
    }
}

export function createDeviceBrokerServer(options: DeviceBrokerOptions = {}): Server {
    const normalized = normalizeBrokerOptions(options);
    const startedAt = normalized.startedAt;
    const launchOwner = registerDeviceBrokerOwner(normalized.cwd, normalized.profile, options.ownerId);
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        try {
            const url = new URL(req.url || "/", `http://${req.headers.host || `${normalized.host}:${normalized.port}`}`);
            if (url.pathname === "/health") {
                if (req.method !== "GET") {
                    writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
                    return;
                }
                writeJson(res, 200, {
                    ok: true,
                    name: DEVICE_BROKER_NAME,
                    mode: "host-broker-daemon",
                    uptimeMs: Date.now() - Date.parse(startedAt),
                });
                return;
            }
            if (url.pathname === "/status") {
                if (req.method !== "GET") {
                    writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
                    return;
                }
                const address = server.address();
                const activePort = address && typeof address === "object" ? address.port : normalized.port;
                writeJson(res, 200, {
                    ok: true,
                    broker: deviceBrokerStatus({ ...normalized, port: activePort, startedAt }),
                });
                return;
            }
            if (url.pathname === "/v1/owner/resolve") {
                if (req.method !== "POST") {
                    writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
                    return;
                }
                const body = await readRequestJson(req, DEVICE_BROKER_RPC_BODY_LIMIT, normalized.requestBodyTimeoutMs);
                if (!body.ok) {
                    writeJson(res, body.status, { ok: false, error: body.error }, body.error === "request-body-timeout" ? { connection: "close" } : {});
                    return;
                }
                const requestPayload = body.body as { projectMountPath?: unknown; profile?: unknown };
                const requestedProjectMountPath = typeof requestPayload.projectMountPath === "string" ? requestPayload.projectMountPath : "";
                const requestedProfile = requestPayload.profile === null || requestPayload.profile === undefined
                    ? undefined
                    : typeof requestPayload.profile === "string" ? requestPayload.profile : null;
                const resolvedOwner = requestedProfile === null
                    ? null
                    : deviceLabOwnerFromProjectMountPath(requestedProjectMountPath, requestedProfile);
                if (!resolvedOwner) {
                    writeJson(res, 400, {
                        ok: false,
                        error: "invalid-project-owner-request",
                        projectMountPath: requestedProjectMountPath,
                        profile: requestPayload.profile ?? null,
                    });
                    return;
                }
                const resolvedOwnerId = resolvedOwner.ownerId;
                let registration: DeviceBrokerOwnerRegistration | null;
                try {
                    registration = readDeviceBrokerOwnerRegistration(resolvedOwnerId);
                } catch {
                    writeJson(res, 409, { ok: false, error: "project-owner-registration-invalid" });
                    return;
                }
                if (!registration
                    || registration.ownerBasis !== resolvedOwner.ownerBasis
                    || registration.projectMountPath !== resolvedOwner.projectMountPath
                    || registration.profile !== (resolvedOwner.profile ?? null)) {
                    writeJson(res, 404, { ok: false, error: "project-owner-unavailable" });
                    return;
                }
                try {
                    deviceBrokerOwnerSecret(resolvedOwnerId);
                } catch {
                    writeJson(res, 503, { ok: false, error: "owner-auth-provisioning-failed" });
                    return;
                }
                writeJson(res, 200, {
                    ok: true,
                    result: {
                        ownerId: resolvedOwnerId,
                        ownerBasis: resolvedOwner.ownerBasis,
                        projectMountPath: resolvedOwner.projectMountPath,
                        profile: resolvedOwner.profile ?? null,
                    },
                });
                return;
            }
            const ownerRpcMatch = /^\/v1\/owners\/([^/]+)\/rpc$/.exec(url.pathname);
            if (ownerRpcMatch) {
                if (req.method !== "POST") {
                    writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
                    return;
                }
                const ownerId = decodeURIComponent(ownerRpcMatch[1]);
                if (!/^[a-f0-9]{16}$/.test(ownerId)) {
                    writeJson(res, 400, { ok: false, error: "invalid-owner-id" });
                    return;
                }
                if (!existingDeviceBrokerOwnerToken(ownerId)) {
                    writeJson(res, 401, { ok: false, error: "invalid-owner-token" });
                    return;
                }
                let ownerRegistration: DeviceBrokerOwnerRegistration | null;
                try {
                    ownerRegistration = ownerId === launchOwner.ownerId
                        ? launchOwner
                        : readDeviceBrokerOwnerRegistration(ownerId);
                } catch {
                    writeJson(res, 409, { ok: false, error: "project-owner-registration-invalid" });
                    return;
                }
                if (!ownerRegistration) {
                    writeJson(res, 404, { ok: false, error: "project-owner-unavailable" });
                    return;
                }
                const ownerNormalized: NormalizedBrokerOptions = {
                    ...normalized,
                    cwd: ownerRegistration.hostProjectPath,
                    profile: ownerRegistration.profile ?? undefined,
                };
                const body = await readRequestJson(req, DEVICE_BROKER_RPC_BODY_LIMIT, normalized.requestBodyTimeoutMs);
                if (!body.ok) {
                    writeJson(res, body.status, { ok: false, error: body.error }, body.error === "request-body-timeout" ? { connection: "close" } : {});
                    return;
                }
                const auth = authorizeBrokerRpc(req, ownerId, body.body, startedAt);
                if (!auth.ok) {
                    writeJson(res, auth.status, { ok: false, error: auth.error });
                    return;
                }
                const result = brokerRpcMutatesOwnerState(body.body)
                    ? await serializeBrokerOwnerMutation(ownerId, () => handleBrokerRpc(ownerId, body.body, ownerNormalized, startedAt))
                    : await handleBrokerRpc(ownerId, body.body, ownerNormalized, startedAt);
                writeJson(res, result.status, result.payload);
                return;
            }
            if (req.method !== "GET") {
                writeJson(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
                return;
            }
            writeJson(res, 404, { ok: false, error: "not-found", path: url.pathname });
        } catch {
            if (!res.headersSent) {
                writeJson(res, 500, { ok: false, error: "broker-internal-error" });
            } else if (!res.writableEnded) {
                res.destroy();
            }
        }
    });
    server.once("close", stopAllBrokerPhysicalLeaseHeartbeats);
    return server;
}

export function formatDeviceBrokerStatus(options: DeviceBrokerOptions = {}): string {
    const status = deviceBrokerStatus(options);
    const containerContext = process.env.container === "docker";
    const wiringIncomplete = containerContext
        ? status.state.rootExists !== true
            || status.containerContract.deviceStateMounted !== true
        : status.state.rootExists !== true
            || status.containerContract.deviceStateMounted !== true;
    const lines = [
        "=== CCC Device Broker ===",
        "",
        `name: ${status.name}`,
        `mode: ${status.mode}`,
        `host: ${status.host}`,
        `port: ${status.port}`,
        `url: ${status.url}`,
        `owner: ${status.ownerId}`,
        `cliProcessPid: ${status.process.pid}`,
        `state: ${status.state.root}`,
        `stateExists: ${status.state.rootExists}`,
        `runtimeFile: ${status.runtime.file}`,
        `runtimePresent: ${status.runtime.present}`,
        `ownerResolution: ${status.containerContract.ownerResolution}`,
        `environmentRequired: ${status.containerContract.environmentRequired}`,
        `deviceStateMounted: ${status.containerContract.deviceStateMounted}`,
        `startup: ${status.startupPolicy}`,
        `hostSupervision: status-only ${status.serviceManager.manager} diagnostics (${status.serviceManager.supported ? "available" : "unavailable"})`,
        `implemented: ${status.implemented.join(", ")}`,
        `deferred: ${status.deferred.join(", ")}`,
    ];
    if (wiringIncomplete) {
        lines.push(
            "warning: device-lab container wiring is incomplete; the host-backed device state mount is unavailable from this container.",
            "remedy: restart or recreate ccc from the host so the project container has /home/ccc/.ccc/devices mounted.",
        );
    }
    return `${lines.join("\n")}\n`;
}

export function parseBrokerServeArgs(args: string[]): { host: string; port: number } {
    let host = DEVICE_BROKER_DEFAULT_HOST;
    let port = DEVICE_BROKER_DEFAULT_PORT;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--host" && args[i + 1]) {
            host = args[i + 1];
            i += 1;
        } else if (args[i] === "--port" && args[i + 1]) {
            port = Number(args[i + 1]);
            i += 1;
        }
    }
    return { host, port: Number.isInteger(port) ? port : DEVICE_BROKER_DEFAULT_PORT };
}

export function parseBrokerServiceArgs(args: string[]): { action: string; host: string; port: number; dryRun: boolean } {
    let action = "status";
    let host = DEVICE_BROKER_DEFAULT_HOST;
    let port = DEVICE_BROKER_DEFAULT_PORT;
    let dryRun = false;
    let actionSeen = false;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--dry-run" || args[i] === "--plan") {
            dryRun = true;
        } else if (args[i] === "--host" && args[i + 1]) {
            host = args[i + 1];
            i += 1;
        } else if (args[i] === "--port" && args[i + 1]) {
            port = Number(args[i + 1]);
            i += 1;
        } else if (!args[i].startsWith("--") && !actionSeen) {
            action = args[i];
            actionSeen = true;
        }
    }
    return { action, host, port: Number.isInteger(port) ? port : DEVICE_BROKER_DEFAULT_PORT, dryRun };
}

export function formatDeviceBrokerService(result: ReturnType<typeof deviceBrokerService>): string {
    const service = "service" in result ? result.service : null;
    const lines = [
        "=== CCC Device Broker Service ===",
        "",
        `action: ${"action" in result ? result.action : "unknown"}`,
        `ok: ${result.ok}`,
    ];
    if ("error" in result && result.error) lines.push(`error: ${result.error}`);
    if (service) {
        lines.push(`platform: ${service.platform}`);
        lines.push(`manager: ${service.manager}`);
        lines.push(`supported: ${service.supported}`);
        lines.push(`service: ${service.serviceName}`);
        lines.push(`definition: ${service.definitionPath || "(manager-owned)"}`);
        lines.push(`command: ${service.command.join(" ")}`);
    }
    if ("serviceOwner" in result) lines.push(`owner: ${result.serviceOwner?.ownerId || "(none)"}`);
    if ("ownedByCurrentOwner" in result) lines.push(`ownedByCurrentOwner: ${result.ownedByCurrentOwner}`);
    if ("dryRun" in result) lines.push(`dryRun: ${result.dryRun}`);
    if ("installed" in result) lines.push(`installed: ${result.installed ?? "unknown"}`);
    if ("running" in result) lines.push(`running: ${result.running ?? "unknown"}`);
    const diagnostics = "diagnostics" in result && Array.isArray(result.diagnostics) ? result.diagnostics : [];
    for (const diagnostic of diagnostics) lines.push(`diagnostic: ${diagnostic}`);
    const commands = service?.commands || [];
    if (commands.length > 0) {
        lines.push("commands:");
        for (const command of commands) lines.push(`  ${command.provider}: ${command.executable || "(missing)"} ${(command.args || []).join(" ")}`.trimEnd());
    }
    const results = "results" in result && Array.isArray(result.results) ? result.results : [];
    if (results.length > 0) {
        lines.push("results:");
        for (const command of results) lines.push(`  ${command.provider}: status=${command.status ?? "null"}${command.error ? ` error=${command.error}` : ""}`);
    }
    return `${lines.join("\n")}\n`;
}

export function startDeviceBrokerServe(
    args: string[],
    cwd = process.cwd(),
    profileOrFactory: string | typeof createDeviceBrokerServer | undefined = undefined,
    serverFactory: typeof createDeviceBrokerServer = createDeviceBrokerServer,
): number {
    const profile = typeof profileOrFactory === "string" ? profileOrFactory : undefined;
    const factory = typeof profileOrFactory === "function" ? profileOrFactory : serverFactory;
    const { host, port } = parseBrokerServeArgs(args);
    const startedAt = new Date().toISOString();
    const ownerId = deviceBrokerOwnerId(cwd, profile);
    const server = factory({ cwd, profile, host, port, startedAt });
    deviceBrokerOwnerToken(ownerId);
    server.listen(port, host, () => {
        writeHostBrokerRuntime({
            name: DEVICE_BROKER_NAME,
            managedBy: "ccc-host",
            ownerId,
            pid: process.pid,
            host,
            probeHost: DEVICE_BROKER_DEFAULT_HOST,
            hostCandidates: hostBrokerProbeCandidates(host, DEVICE_BROKER_DEFAULT_HOST),
            port,
            command: process.execPath,
            args: [process.argv[1] || "ccc", "devices", "broker", "serve", "--host", host, "--port", String(port)],
            cwd,
            profile: profile || null,
            startedAt,
        });
        console.log(`ccc-device-broker listening on http://${host}:${port}`);
    });
    return 0;
}

export function deviceBrokerCli(args: string[], cwd = process.cwd(), profile?: string): number {
    const command = args[0] || "status";
    if (command === "status") {
        console.log(formatDeviceBrokerStatus({ cwd, profile }));
        return 0;
    }
    if (command === "serve") {
        return startDeviceBrokerServe(args.slice(1), cwd, profile);
    }
    if (command === "service") {
        console.error([
            "Usage: ccc devices broker status",
            "Broker service repair is automatic; manual service verbs are internal diagnostics.",
        ].join("\n"));
        return 1;
    }
    console.error("Usage: ccc devices broker status");
    return 1;
}

export async function deviceBrokerCliAsync(
    args: string[],
    cwd = process.cwd(),
    profile?: string,
    hooks: { ensureHostBroker?: typeof ensureHostDeviceBroker } = {},
): Promise<number> {
    const command = args[0] || "status";
    if (command !== "status") return deviceBrokerCli(args, cwd, profile);

    const ensure = hooks.ensureHostBroker || ensureHostDeviceBroker;
    const readiness = await ensure({ cwd, profile });
    const readinessRecord = readiness as Record<string, unknown>;
    console.log(formatDeviceBrokerStatus({
        cwd,
        profile,
        ...(typeof readinessRecord.host === "string" ? { host: readinessRecord.host } : {}),
        ...(Number.isInteger(readinessRecord.port) ? { port: Number(readinessRecord.port) } : {}),
        ...(typeof readinessRecord.ownerId === "string" ? { ownerId: readinessRecord.ownerId } : {}),
    }));
    if (!readiness.ok) {
        console.error(`brokerReady: false`);
        console.error(`brokerRepairError: ${"error" in readiness ? readiness.error : readiness.reason || "unknown"}`);
        if ("diagnostics" in readiness && Array.isArray(readiness.diagnostics)) {
            for (const diagnostic of readiness.diagnostics) {
                console.error(`brokerRepairDiagnostic: ${diagnostic}`);
            }
        }
        return 1;
    }
    console.log(`brokerReady: true`);
    console.log(`brokerReused: ${readiness.reused === true}`);
    console.log(`brokerLaunched: ${readiness.launched === true}`);
    if (Array.isArray(readinessRecord.verifiedCapabilities)) {
        console.log(`brokerVerifiedCapabilities: ${readinessRecord.verifiedCapabilities.map(String).join(", ")}`);
    }
    if (Number.isInteger(readinessRecord.verifiedBrokerPid)) {
        console.log(`brokerVerifiedPid: ${Number(readinessRecord.verifiedBrokerPid)}`);
    }
    if (typeof readinessRecord.verifiedBrokerStartedAt === "string") {
        console.log(`brokerVerifiedStartedAt: ${readinessRecord.verifiedBrokerStartedAt}`);
    }
    return 0;
}
