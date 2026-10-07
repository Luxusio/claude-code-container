import { describe, expect, it } from "vitest";
import { createOrderedCodexConfigPreparation } from "../../application/credentials/codex-config-preparation.js";
import type { CodexPreparationPorts, CodexPreparationParent, CodexPreparationConfig, CodexPreparationObservation } from "../../ports/credentials/codex-config-preparation.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Names = "resolveConfig" | "hasHostIdentity" | "inspectParent" | "inspectConfig" | "currentHostUid" | "mappedContainerUid" | "probeDirectory" | "repairDirectory" | "verifyDirectory" | "probeConfig" | "repairConfig" | "verifyConfig";
type ExactPorts = Assert<Equal<keyof CodexPreparationPorts, Names>>;
type RequiredPorts = Assert<Equal<CodexPreparationPorts, Required<CodexPreparationPorts>>>;
type SynchronousPorts = Assert<Equal<Extract<ReturnType<CodexPreparationPorts[Names]>, PromiseLike<unknown>>, never>>;
type ParentShape = Assert<Equal<keyof CodexPreparationParent, "uid" | "isDirectory">>;
type ConfigShape = Assert<Equal<keyof CodexPreparationConfig, "nlink" | "isFile">>;
type ObservationShape = Assert<Equal<keyof CodexPreparationObservation, "status" | "error">>;
function contracts(ports: CodexPreparationPorts, parent: CodexPreparationParent, config: CodexPreparationConfig, observation: CodexPreparationObservation) {
    const result: undefined = createOrderedCodexConfigPreparation(ports).prepare("target", "profile");
    const publicCompatible: void = result;
    // @ts-expect-error Target is required.
    createOrderedCodexConfigPreparation(ports).prepare();
    // @ts-expect-error Profile is a string.
    createOrderedCodexConfigPreparation(ports).prepare("target", 1);
    // @ts-expect-error Core completion is synchronous.
    const promise: Promise<void> = result;
    // @ts-expect-error Capability is readonly.
    ports.resolveConfig = () => "path";
    // @ts-expect-error Metadata is readonly.
    parent.uid = 1;
    // @ts-expect-error Methods are readonly.
    parent.isDirectory = () => true;
    // @ts-expect-error Link count is readonly.
    config.nlink = 1;
    // @ts-expect-error File method is readonly.
    config.isFile = () => true;
    // @ts-expect-error Observation status is readonly.
    observation.status = 0;
    // @ts-expect-error Observation error is readonly.
    observation.error = null;
    // @ts-expect-error resolveConfig is required.
    createOrderedCodexConfigPreparation({ ...ports, resolveConfig: undefined });
    // @ts-expect-error resolveConfig is readonly.
    ports.resolveConfig = ports.resolveConfig;
    // @ts-expect-error hasHostIdentity is required.
    createOrderedCodexConfigPreparation({ ...ports, hasHostIdentity: undefined });
    // @ts-expect-error hasHostIdentity is readonly.
    ports.hasHostIdentity = ports.hasHostIdentity;
    // @ts-expect-error inspectParent is required.
    createOrderedCodexConfigPreparation({ ...ports, inspectParent: undefined });
    // @ts-expect-error inspectParent is readonly.
    ports.inspectParent = ports.inspectParent;
    // @ts-expect-error inspectConfig is required.
    createOrderedCodexConfigPreparation({ ...ports, inspectConfig: undefined });
    // @ts-expect-error inspectConfig is readonly.
    ports.inspectConfig = ports.inspectConfig;
    // @ts-expect-error currentHostUid is required.
    createOrderedCodexConfigPreparation({ ...ports, currentHostUid: undefined });
    // @ts-expect-error currentHostUid is readonly.
    ports.currentHostUid = ports.currentHostUid;
    // @ts-expect-error mappedContainerUid is required.
    createOrderedCodexConfigPreparation({ ...ports, mappedContainerUid: undefined });
    // @ts-expect-error mappedContainerUid is readonly.
    ports.mappedContainerUid = ports.mappedContainerUid;
    // @ts-expect-error probeDirectory is required.
    createOrderedCodexConfigPreparation({ ...ports, probeDirectory: undefined });
    // @ts-expect-error probeDirectory is readonly.
    ports.probeDirectory = ports.probeDirectory;
    // @ts-expect-error repairDirectory is required.
    createOrderedCodexConfigPreparation({ ...ports, repairDirectory: undefined });
    // @ts-expect-error repairDirectory is readonly.
    ports.repairDirectory = ports.repairDirectory;
    // @ts-expect-error verifyDirectory is required.
    createOrderedCodexConfigPreparation({ ...ports, verifyDirectory: undefined });
    // @ts-expect-error verifyDirectory is readonly.
    ports.verifyDirectory = ports.verifyDirectory;
    // @ts-expect-error probeConfig is required.
    createOrderedCodexConfigPreparation({ ...ports, probeConfig: undefined });
    // @ts-expect-error probeConfig is readonly.
    ports.probeConfig = ports.probeConfig;
    // @ts-expect-error repairConfig is required.
    createOrderedCodexConfigPreparation({ ...ports, repairConfig: undefined });
    // @ts-expect-error repairConfig is readonly.
    ports.repairConfig = ports.repairConfig;
    // @ts-expect-error verifyConfig is required.
    createOrderedCodexConfigPreparation({ ...ports, verifyConfig: undefined });
    // @ts-expect-error verifyConfig is readonly.
    ports.verifyConfig = ports.verifyConfig;
    // @ts-expect-error Required capability cannot be omitted.
    createOrderedCodexConfigPreparation({ ...ports, inspectParent: undefined });
    // @ts-expect-error Async metadata is forbidden.
    createOrderedCodexConfigPreparation({ ...ports, inspectConfig: async () => config });
    // @ts-expect-error Async identity is forbidden.
    createOrderedCodexConfigPreparation({ ...ports, mappedContainerUid: async () => "1" });
    // @ts-expect-error Async stage observations are forbidden.
    createOrderedCodexConfigPreparation({ ...ports, repairDirectory: async () => ({ status: 0 }) });
    // @ts-expect-error Status is required.
    createOrderedCodexConfigPreparation({ ...ports, probeConfig: () => ({ error: undefined }) });
    // @ts-expect-error Repairs require target, path, and UID.
    ports.repairConfig("target", "path");
    // @ts-expect-error Verify requires the config path.
    ports.verifyDirectory("target");
    void [result, publicCompatible, promise];
}
void contracts;
const proof: [ExactPorts, RequiredPorts, SynchronousPorts, ParentShape, ConfigShape, ObservationShape] = [true, true, true, true, true, true];
describe("ordered preparation type boundary", () => {
    it("exposes exactly twelve required synchronous capabilities and structural metadata", () => expect(proof.every(Boolean)).toBe(true));
});
