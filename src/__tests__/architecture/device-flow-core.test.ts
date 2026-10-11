import { describe, expect, it } from 'vitest';
import { runDeviceFlow } from '../../../packages/device-lab/providers/application/device-flow.mjs';
import { sharedFlowTarget } from '../../../packages/device-lab/providers/domain/device-flow.mjs';
import type { DeviceFlowPorts } from '../../../packages/device-lab/providers/ports/device-flow.mjs';
import type { FlowObservation } from '../../../packages/device-lab/providers/domain/device-flow.mjs';
const options = { toolName: 'run_flow', toolAllowed: (tool: string) => tool !== 'forbidden' };
function fixture(observations: FlowObservation<string>[] = []) {
    const dispatched: string[] = [];
    const ports: DeviceFlowPorts<string> = {
        toolInputError: (_tool, args) => args?.deny ? 'delete requires confirmDestructive:true' : null,
        flowOperationAllowed: () => true,
        toolOperation: tool => tool,
        flowStepArguments: (_tool, _flow, step) => step || {},
        normalizePublicToolArgs: (_tool, args) => args,
        withBrokerOperation: operation => operation(),
        dispatchTool: async operation => { dispatched.push(operation); return observations.shift() || { transportFailed: false, values: [{ ok: true }], payload: operation }; },
        destructiveDenial: () => ({ transportFailed: true, values: [{ ok: false }], payload: 'denied' }),
        dispatchFailure: () => ({ transportFailed: true, values: [], payload: 'native-error' }),
    };
    return { ports, dispatched };
}
describe('semantic ordered flow', () => {
    it('rejects missing, empty and oversized steps before dispatch', async () => {
        const f = fixture();
        for (const steps of [undefined, [], Array.from({ length: 51 }, () => ({ tool: 'click' }))]) expect((await runDeviceFlow({ steps }, options, f.ports)).kind).toBe('invalid');
        expect(f.dispatched).toEqual([]);
    });
    it('refuses malformed and forbidden steps and continues only when requested', async () => {
        const f = fixture();
        const result = await runDeviceFlow({ stopOnError: false, steps: [{ tool: 'forbidden' }, { tool: 'click', arguments: null }, { tool: 'home' }] }, options, f.ports);
        expect(result).toMatchObject({ kind: 'complete', ok: false });
        expect(f.dispatched).toEqual(['home']);
    });
    it('keeps the destructive denial payload without dispatch', async () => {
        const f = fixture();
        expect(await runDeviceFlow({ steps: [{ tool: 'delete', arguments: { deny: true } }, { tool: 'home' }] }, options, f.ports)).toMatchObject({ ok: false, stoppedAt: 0, results: [{ failed: true, payload: 'denied' }] });
        expect(f.dispatched).toEqual([]);
    });
    it('owns transport, tool and unmet-wait failure decisions', async () => {
        for (const observation of [{ transportFailed: true, values: [] }, { transportFailed: false, values: [{ ok: false }] }, { transportFailed: false, values: [{ matched: false }] }]) {
            const f = fixture([{ ...observation, payload: 'first-artifact' }]);
            const result = await runDeviceFlow({ steps: [{ tool: 'mobile_wait_for_text' }, { tool: 'home' }] }, options, f.ports);
            expect(result).toMatchObject({ ok: false, stoppedAt: 0, results: [{ failed: true, payload: 'first-artifact' }] });
            expect(f.dispatched).toEqual(['mobile_wait_for_text']);
        }
    });
    it('preserves prior artifacts and continues after failure', async () => {
        const f = fixture([{ transportFailed: true, values: [], payload: 'failed-artifact' }]);
        expect(await runDeviceFlow({ stopOnError: false, steps: [{ tool: 'screenshot' }, { tool: 'home' }] }, options, f.ports)).toMatchObject({ ok: false, results: [{ payload: 'failed-artifact' }, { payload: 'home', failed: false }] });
    });
    it('routes later steps against state changed by an earlier dispatch', async () => {
        const f = fixture(); let state = 'before';
        f.ports.toolOperation = tool => `${tool}-${state}`;
        f.ports.dispatchTool = async operation => { f.dispatched.push(operation); state = 'after'; return { transportFailed: false, values: [], payload: operation }; };
        await runDeviceFlow({ steps: [{ tool: 'start' }, { tool: 'status' }] }, options, f.ports);
        expect(f.dispatched).toEqual(['start-before', 'status-after']);
    });
    it('inherits only eligible target fields and respects an explicit target change', () => {
        expect(sharedFlowTarget({ deviceId: 'a', incarnationId: 'generation' }, {}, { deviceId: {}, incarnationId: {} })).toEqual({ deviceId: 'a', incarnationId: 'generation' });
        expect(sharedFlowTarget({ deviceId: 'a', incarnationId: 'generation' }, { deviceId: 'b' }, { deviceId: {}, incarnationId: {} })).toEqual({});
    });
});
