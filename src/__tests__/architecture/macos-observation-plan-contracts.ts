import { createDeviceObservation } from "../../../packages/device-lab/providers/application/device-observation.mjs";
import { observationMacosSelection } from "../../../packages/device-lab/providers/domain/device-observation.mjs";
import { materializeMacosObservationPlan, observationMacosPlan, observationMacosStartArgs } from "../../../packages/device-lab/providers/adapters/macos-observation-plan.mjs";
import type { MacosFacts, MacosHelperPaths, MacosObservationPorts } from "../../../packages/device-lab/providers/ports/device-observation.mjs";
import type { MacosVmDevice, MacosVmNativePlan, MacosVmProviderPlan } from "../../../packages/device-lab/providers/ports/lifecycle/macos-vm-lifecycle.mjs";

function contracts(ports: MacosObservationPorts, device: MacosVmDevice, facts: MacosFacts, paths: MacosHelperPaths) {
    const selected = observationMacosSelection(device, {
        hostSupported: facts.hostSupported, missing: facts.missing,
        providers: facts.providers.map(provider => ({ name: provider.name, available: Boolean(provider.command) })),
    }, "owner");
    const implemented: boolean = selected.implemented;
    const instance: string = selected.providerInstance;
    const native: MacosVmNativePlan = ports.materializePlan(device, selected, facts, paths);
    const materialized: MacosVmNativePlan = materializeMacosObservationPlan(device, selected, facts, paths);
    const publicPlan: MacosVmProviderPlan = createDeviceObservation(ports).plan(device, facts);
    const compatibilityPlan: MacosVmProviderPlan = observationMacosPlan(device, facts, "owner", paths);
    const compatibilityArgs: string[] = observationMacosStartArgs("tart", instance, { softnet: true, headless: true });
    // @ts-expect-error Semantic selection does not expose executable paths.
    selected.providerCommand;
    // @ts-expect-error Semantic selection does not expose native command recipes.
    selected.startCommand;
    // @ts-expect-error Missing native materialization is an invalid factory port set.
    createDeviceObservation({ ...ports, materializePlan: undefined });
    // @ts-expect-error Native materialization remains synchronous.
    createDeviceObservation({ ...ports, materializePlan: async () => native });
    // @ts-expect-error A raw public plan lacks the normalized native envelope.
    const raw: ReturnType<typeof ports.materializePlan> = publicPlan;
    // @ts-expect-error Provider selection requires semantic availability rather than a raw executable path.
    observationMacosSelection(device, { hostSupported: true, missing: [], providers: [{ name: "tart", command: "/tart" }] }, "owner");
    void [implemented, instance, native, materialized, publicPlan, compatibilityPlan, compatibilityArgs, raw];
}
void contracts;
