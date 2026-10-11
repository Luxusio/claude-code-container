import type { SetupRequest, SetupResult } from "../domain/device-admin-setup.js";
import type { DeviceAdminSetupPorts } from "../ports/device-admin-setup.js";
export function createDeviceAdminSetup<Evidence>(ports: DeviceAdminSetupPorts<Evidence>) {
    async function setup(confirm: boolean, options: SetupRequest = {}): Promise<SetupResult<Evidence>> {
        const context = ports.prepareContext(confirm);
        if (!context.ok) return context;
        const licenseAccepted = Boolean(ports.readEvaluationReceipt());
        if (!confirm) {
            const diagnostic = ports.diagnose(30_000);
            if (diagnostic.state !== "available") return { ok: false, reason: "diagnostic-failed", evidence: diagnostic.evidence };
            return { ok: true, mode: "diagnostic", readiness: diagnostic.value,
                linuxImage: ports.linuxImage(options.ownerId || "", diagnostic.value), licenseAccepted, evidence: diagnostic.evidence };
        }
        const mutation = ports.prepareMutation();
        if (!mutation.ok) return mutation;
        let prepared: Awaited<ReturnType<typeof prepare>>;
        async function prepare() {
            const feature = ports.enableFeature(15 * 60_000);
            if (feature.state !== "available" || !feature.value.ok) return { feature, network: null };
            const network = await ports.ensureHostNetwork(ports.now() + 15 * 60_000);
            return { feature, network };
        }
        try {
            prepared = await ports.withMutationLock(prepare, { waitMs: 10 * 60_000, staleMs: 20 * 60_000 });
        } catch (error) {
            return { ok: false, reason: "mutation-failed", evidence: ports.mutationFailure(error) };
        }
        const { feature, network } = prepared;
        if (feature.state !== "available" || !feature.value.ok) return { ok: false, reason: "feature-failed", evidence: feature.evidence };
        if (!network) return { ok: false, reason: "network-invalid" };
        if (!network.ok) return { ok: false, reason: "network-failed", evidence: network.evidence };
        const receipt = options.acceptWindowsEvaluationLicense ? ports.acceptEvaluationLicense() : ports.readEvaluationReceipt();
        return { ok: true, mode: "confirmed", observation: feature.value, network, receipt, evidence: feature.evidence };
    }
    return { setup };
}
