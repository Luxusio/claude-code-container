import {describe, expect, it, vi} from "vitest";
import {createMiseConfigSetup} from "../../application/tooling/mise-config.js";
import type {MiseConfigSetupPorts} from "../../ports/tooling/mise-config.js";

const project = "/project";
const primary = "/project/mise.toml", alternate = "/project/.mise.toml", marker = "/private/project-skip";
function fixture() {
    const existing = new Set<string>();
    const ports = {
        configPath: vi.fn<MiseConfigSetupPorts["configPath"]>((_project, kind) => kind === "primary" ? primary : alternate),
        skipMarkerPath: vi.fn<MiseConfigSetupPorts["skipMarkerPath"]>(() => marker),
        exists: vi.fn<MiseConfigSetupPorts["exists"]>(path => existing.has(path)),
        scanVersionFiles: vi.fn<MiseConfigSetupPorts["scanVersionFiles"]>(() => new Map([["package.json", "{}"]])),
        chooseCreation: vi.fn<MiseConfigSetupPorts["chooseCreation"]>(async () => "create"),
        runToolDetection: vi.fn<MiseConfigSetupPorts["runToolDetection"]>(() => undefined),
        writeDefaultConfig: vi.fn<MiseConfigSetupPorts["writeDefaultConfig"]>(() => undefined),
        rememberSkip: vi.fn<MiseConfigSetupPorts["rememberSkip"]>(() => undefined),
        report: vi.fn<MiseConfigSetupPorts["report"]>(() => undefined),
    };
    return {existing, ports, app: createMiseConfigSetup(ports)};
}

describe("mise config setup decisions", () => {
    it.each([primary, alternate, marker])("leaves existing config or remembered preference %s alone", async path => {
        const f = fixture(); f.existing.add(path);
        await expect(f.app.ensure(project)).resolves.toBeUndefined();
        expect(f.ports.scanVersionFiles).not.toHaveBeenCalled();
        expect(f.ports.chooseCreation).not.toHaveBeenCalled();
        expect(f.ports.runToolDetection).not.toHaveBeenCalled();
        expect(f.ports.report).not.toHaveBeenCalled();
        if (path !== marker) expect(f.ports.skipMarkerPath).not.toHaveBeenCalled();
    });

    it("does not prompt or persist a skip when the first scan is empty", async () => {
        const f = fixture(); f.ports.scanVersionFiles.mockReturnValue(new Map());
        await f.app.ensure(project);
        expect(f.ports.chooseCreation).not.toHaveBeenCalled();
        expect(f.ports.rememberSkip).not.toHaveBeenCalled();
        expect(f.ports.report).not.toHaveBeenCalled();
    });

    it("awaits confirmation then passes the fresh second scan even if it is now empty", async () => {
        const f = fixture(), second = new Map<string, string>();
        let choose!: (choice: "create") => void;
        f.ports.chooseCreation.mockReturnValue(new Promise(resolve => { choose = resolve; }));
        f.ports.scanVersionFiles.mockReturnValueOnce(new Map([["old", "old bytes"]])).mockReturnValueOnce(second);
        const pending = f.app.ensure(project);
        expect(f.ports.scanVersionFiles).toHaveBeenCalledExactlyOnceWith(project);
        expect(f.ports.runToolDetection).not.toHaveBeenCalled();
        choose("create");
        await expect(pending).resolves.toBeUndefined();
        expect(f.ports.scanVersionFiles).toHaveBeenCalledTimes(2);
        expect(f.ports.runToolDetection).toHaveBeenCalledExactlyOnceWith(project, primary, second);
        expect(f.ports.runToolDetection.mock.calls[0][2]).toBe(second);
        expect(f.ports.writeDefaultConfig).toHaveBeenCalledExactlyOnceWith(primary);
        expect(f.ports.report.mock.calls.map(([event]) => event)).toEqual([
            {kind: "missing-config"}, {kind: "scanning"}, {kind: "created", path: primary},
        ]);
    });

    it("keeps a generated primary file instead of writing the default", async () => {
        const f = fixture();
        f.ports.runToolDetection.mockImplementation(() => { f.existing.add(primary); return undefined; });
        await f.app.ensure(project);
        expect(f.ports.writeDefaultConfig).not.toHaveBeenCalled();
        expect(f.ports.report).toHaveBeenLastCalledWith({kind: "created", path: primary});
    });

    it.each(["skip-once", "remember-skip"] as const)("preserves %s without a second scan or detection", async choice => {
        const f = fixture(); f.ports.chooseCreation.mockResolvedValue(choice);
        await f.app.ensure(project);
        expect(f.ports.scanVersionFiles).toHaveBeenCalledOnce();
        expect(f.ports.runToolDetection).not.toHaveBeenCalled();
        expect(f.ports.writeDefaultConfig).not.toHaveBeenCalled();
        if (choice === "remember-skip") {
            expect(f.ports.rememberSkip).toHaveBeenCalledExactlyOnceWith(marker);
            expect(f.ports.report).toHaveBeenLastCalledWith({kind: "remembered", path: marker});
        } else {
            expect(f.ports.rememberSkip).not.toHaveBeenCalled();
            expect(f.ports.report).toHaveBeenLastCalledWith({kind: "skipping"});
        }
    });
});

describe("mise config failure boundaries", () => {
    it.each(["first scan", "confirmation", "second scan"] as const)("propagates raw %s failure before detection", async stage => {
        const f = fixture(), failure = {stage};
        if (stage === "confirmation") f.ports.chooseCreation.mockRejectedValue(failure);
        else if (stage === "first scan") f.ports.scanVersionFiles.mockImplementation(() => { throw failure; });
        else f.ports.scanVersionFiles.mockReturnValueOnce(new Map([["version", "1"]])).mockImplementationOnce(() => { throw failure; });
        await expect(f.app.ensure(project)).rejects.toBe(failure);
        expect(f.ports.runToolDetection).not.toHaveBeenCalled();
        expect(f.ports.writeDefaultConfig).not.toHaveBeenCalled();
        expect(f.ports.rememberSkip).not.toHaveBeenCalled();
    });

    it.each(["detection", "default write"] as const)("does not turn %s failure into a preference warning", async stage => {
        const f = fixture(), failure = new Error(stage);
        if (stage === "detection") f.ports.runToolDetection.mockImplementation(() => { throw failure; });
        else f.ports.writeDefaultConfig.mockImplementation(() => { throw failure; });
        await expect(f.app.ensure(project)).rejects.toBe(failure);
        expect(f.ports.report).not.toHaveBeenCalledWith({kind: "preference-save-failed"});
        if (stage === "detection") expect(f.ports.writeDefaultConfig).not.toHaveBeenCalled();
        expect(f.ports.report).not.toHaveBeenCalledWith({kind: "created", path: primary});
    });

    it("warns when saving a remembered preference fails", async () => {
        const f = fixture(); f.ports.chooseCreation.mockResolvedValue("remember-skip");
        f.ports.rememberSkip.mockImplementation(() => { throw new Error("preference write failed"); });
        await expect(f.app.ensure(project)).resolves.toBeUndefined();
        expect(f.ports.report).toHaveBeenLastCalledWith({kind: "preference-save-failed"});
        expect(f.ports.runToolDetection).not.toHaveBeenCalled();
    });

});

function consumedContracts(ports: MiseConfigSetupPorts) {
    const pending: Promise<undefined> = createMiseConfigSetup(ports).ensure(project);
    const {runToolDetection, ...withoutDetection} = ports;
    // @ts-expect-error Native tool detection is required.
    createMiseConfigSetup(withoutDetection);
    // @ts-expect-error Scanning completes synchronously before confirmation or detection.
    createMiseConfigSetup({...ports, scanVersionFiles: async () => new Map<string, string>()});
    // @ts-expect-error Tool detection must finish before primary config observation.
    createMiseConfigSetup({...ports, runToolDetection: async () => undefined});
    // @ts-expect-error Default writing must finish before reporting creation.
    createMiseConfigSetup({...ports, writeDefaultConfig: async () => undefined});
    // @ts-expect-error Preference writing completes within the existing narrow catch.
    createMiseConfigSetup({...ports, rememberSkip: async () => undefined});
    // @ts-expect-error Reporting completes at its existing failure boundary.
    createMiseConfigSetup({...ports, report: async () => undefined});
    // @ts-expect-error Confirmation uses only the finite decoded choices.
    createMiseConfigSetup({...ports, chooseCreation: async () => "always"});
    void [pending, runToolDetection];
}
void consumedContracts;
