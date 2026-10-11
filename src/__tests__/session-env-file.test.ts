import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSymlinkOrSkip, directorySymlink } from './helpers/file-symlink-fixture.js';

const native = vi.hoisted(() => ({
    fs: {} as typeof import('node:fs'),
    open: vi.fn<typeof import('node:fs').openSync>(),
    stat: vi.fn<typeof import('node:fs').fstatSync>(),
    write: vi.fn<typeof import('node:fs').writeFileSync>(),
    report: vi.fn<typeof import('node:fs').writeSync>(),
    close: vi.fn<typeof import('node:fs').closeSync>(),
    lstat: vi.fn<typeof import('node:fs').lstatSync>(),
    unlink: vi.fn<typeof import('node:fs').unlinkSync>(),
}));
vi.mock('fs', async () => {
    native.fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    return { ...native.fs, openSync: native.open, fstatSync: native.stat,
        writeFileSync: native.write, closeSync: native.close,
        lstatSync: native.lstat, unlinkSync: native.unlink, writeSync: native.report };
});
vi.mock('crypto', async () => ({
    ...await vi.importActual<typeof import('node:crypto')>('node:crypto'),
    randomBytes: () => Buffer.from('a1b2c3d4e5f6', 'hex'),
}));
import { writeEnvFile, writeOwnedEnvFile } from '../utils.js';

describe('native owned env-file authority', () => {
    let root: string;
    let baseline: ReturnType<typeof process.listeners>;
    const resources: Array<ReturnType<typeof writeOwnedEnvFile>> = [];
    const marker = 'generated-test-marker-never-a-host-secret';
    const create = () => {
        const resource = writeOwnedEnvFile([['FIXTURE', marker]]);
        resources.push(resource);
        return resource;
    };
    beforeEach(() => {
        native.open.mockReset().mockImplementation(native.fs.openSync);
        native.stat.mockReset().mockImplementation(native.fs.fstatSync);
        native.write.mockReset().mockImplementation(native.fs.writeFileSync);
        native.report.mockReset().mockReturnValue(0);
        native.close.mockReset().mockImplementation(native.fs.closeSync);
        native.lstat.mockReset().mockImplementation(native.fs.lstatSync);
        native.unlink.mockReset().mockImplementation(native.fs.unlinkSync);
        baseline = process.listeners('exit');
        root = native.fs.mkdtempSync(join(tmpdir(), 'ccc-owned-env-'));
        vi.stubEnv('TMPDIR', root);
        vi.stubEnv('TMP', root);
        vi.stubEnv('TEMP', root);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        native.lstat.mockImplementation(native.fs.lstatSync);
        native.unlink.mockImplementation(native.fs.unlinkSync);
        for (const resource of resources.splice(0)) resource.dispose();
        // A failed assertion must not leave this suite's process exit hooks alive.
        for (const listener of process.listeners('exit')) {
            if (!baseline.includes(listener)) process.off('exit', listener);
        }
        vi.unstubAllEnvs();
        native.fs.rmSync(root, { recursive: true, force: true });
    });

    it('uses the exclusive creating FD and captures its identity before any secret write', () => {
        const resource = create();
        const fd = native.open.mock.results[0].value;
        expect(native.open).toHaveBeenCalledWith(resource.path, 'wx', 0o600);
        expect(native.stat.mock.calls[0][0]).toBe(fd);
        expect(native.write.mock.calls[0][0]).toBe(fd);
        expect(native.close).toHaveBeenCalledWith(fd);
        expect(native.open).toHaveBeenCalledTimes(1);
        expect(native.stat.mock.invocationCallOrder[0]).toBeLessThan(native.write.mock.invocationCallOrder[0]);
        expect(native.write.mock.invocationCallOrder[0]).toBeLessThan(native.close.mock.invocationCallOrder[0]);
        expect(native.fs.readFileSync(resource.path, 'utf8')).toBe(`FIXTURE=${marker}\n`);
        expect(JSON.stringify(resource)).not.toContain(marker);
    });

    it.each(['legacy', 'owned'])('preserves an existing filename on %s collision', api => {
        const path = join(root, 'ccc-env-a1b2c3d4e5f6');
        native.fs.writeFileSync(path, 'successor');
        let failure: unknown;
        try { api === 'legacy' ? writeEnvFile([['FIXTURE', marker]]) : create(); }
        catch (error) { failure = error; }
        expect((failure as NodeJS.ErrnoException).code).toBe('EEXIST');
        expect(native.fs.readFileSync(path, 'utf8')).toBe('successor');
        expect(native.write).not.toHaveBeenCalled();
        expect(native.unlink).not.toHaveBeenCalled();
    });

    it('serializes ordered duplicate environment entries into its owned file', () => {
        const resource = writeOwnedEnvFile([
            ['LANG', 'host-lang'], ['TZ', 'Host/Zone'], ['MISE_NODE_VERSION', 'host-node'],
            ['CCC_CLIPBOARD_TOKEN', 'token:with:colon'], ['MISE_NODE_VERSION', '22'],
            ['LANG', 'session-lang'], ['TZ', 'Session/Zone'], ['MISE_NODE_VERSION', '23'],
        ]);
        resources.push(resource);
        expect(native.fs.readFileSync(resource.path, 'utf8')).toBe(
            'LANG=host-lang\nTZ=Host/Zone\nMISE_NODE_VERSION=host-node\nCCC_CLIPBOARD_TOKEN=token:with:colon\nMISE_NODE_VERSION=22\nLANG=session-lang\nTZ=Session/Zone\nMISE_NODE_VERSION=23\n',
        );
        resource.dispose();
        expect(native.fs.existsSync(resource.path)).toBe(false);
    });

    it('does not truncate a selected filename symlink target', context => {
        const target = join(root, 'external');
        native.fs.writeFileSync(target, 'keep target');
        fileSymlinkOrSkip(context, target, join(root, 'ccc-env-a1b2c3d4e5f6'));
        expect(() => create()).toThrow();
        expect(native.fs.readFileSync(target, 'utf8')).toBe('keep target');
        expect(native.write).not.toHaveBeenCalled();
        expect(native.unlink).not.toHaveBeenCalled();
    });

    it('failed creating-FD identity capture writes no secrets and authorizes no unlink', () => {
        const primary = new Error(`${marker} private-path`);
        native.stat.mockImplementationOnce(() => { throw primary; });
        let caught: unknown;
        try { create(); } catch (error) { caught = error; }
        expect(caught).toBe(primary);
        expect(native.write).not.toHaveBeenCalled();
        expect(native.unlink).not.toHaveBeenCalled();
        expect(native.close).toHaveBeenCalledTimes(1);
        expect(native.fs.readFileSync(join(root, 'ccc-env-a1b2c3d4e5f6'), 'utf8')).toBe('');
        expect(process.listeners('exit')).toEqual(baseline);
    });

    it.each(['write', 'close', 'listener'])('preserves original %s failure and cleans only its owned file', stage => {
        const primary = { fixtureFailure: stage, privateMessage: marker };
        if (stage === 'write') native.write.mockImplementationOnce(() => { throw primary; });
        if (stage === 'close') native.close.mockImplementationOnce(fd => {
            native.fs.closeSync(fd); throw primary;
        });
        if (stage === 'listener') vi.spyOn(process, 'on').mockImplementationOnce(() => { throw primary; });
        let caught: unknown;
        try { create(); } catch (error) { caught = error; }
        expect(caught).toBe(primary);
        expect(native.fs.existsSync(join(root, 'ccc-env-a1b2c3d4e5f6'))).toBe(false);
        expect(process.listeners('exit')).toEqual(baseline);
    });

    it('does not delete a successor during failed write cleanup', () => {
        const primary = new Error('write fixture failure');
        const path = join(root, 'ccc-env-a1b2c3d4e5f6');
        native.write.mockImplementationOnce(() => {
            native.fs.renameSync(path, join(root, 'retired'));
            native.fs.writeFileSync(path, 'successor');
            throw primary;
        });
        expect(() => create()).toThrow(primary);
        expect(native.fs.readFileSync(path, 'utf8')).toBe('successor');
        expect(native.unlink).not.toHaveBeenCalled();
    });

    it('explicit disposal removes the matching file and its exact listener once without changing exitCode', () => {
        const initialCode = process.exitCode;
        const resource = create();
        const added = process.listeners('exit').filter(listener => !baseline.includes(listener));
        expect(added).toHaveLength(1);
        const off = vi.spyOn(process, 'off');
        resource.dispose();
        resource.dispose();
        expect(native.fs.existsSync(resource.path)).toBe(false);
        expect(native.unlink).toHaveBeenCalledTimes(1);
        expect(off).toHaveBeenCalledWith('exit', added[0]);
        expect(process.listeners('exit')).toEqual(baseline);
        expect(process.exitCode).toBe(initialCode);
    });

    it('missing entries are terminal success', () => {
        const resource = create();
        native.fs.unlinkSync(resource.path);
        const diagnostic = native.report;
        resource.dispose(); resource.dispose();
        expect(native.unlink).not.toHaveBeenCalled();
        expect(diagnostic).not.toHaveBeenCalled();
        expect(process.listeners('exit')).toEqual(baseline);
    });

    it('its native exit listener disposes synchronously without modifying the chosen status', () => {
        const initialCode = process.exitCode;
        const resource = create();
        const added = process.listeners('exit').filter(listener => !baseline.includes(listener));
        expect(added).toHaveLength(1);
        added[0](23);
        expect(native.fs.existsSync(resource.path)).toBe(false);
        expect(process.listeners('exit')).toEqual(baseline);
        expect(process.exitCode).toBe(initialCode);
        resource.dispose();
        expect(native.unlink).toHaveBeenCalledTimes(1);
    });

    it.each(['same-bytes', 'directory', 'directory-link'])('preserves a %s replacement', kind => {
        const resource = create();
        // Retain the original inode so this test cannot pass accidentally through inode reuse.
        native.fs.renameSync(resource.path, join(root, 'retired'));
        if (kind === 'same-bytes') native.fs.writeFileSync(resource.path, `FIXTURE=${marker}\n`);
        if (kind === 'directory') native.fs.mkdirSync(resource.path);
        if (kind === 'directory-link') {
            const target = join(root, 'directory-target');
            native.fs.mkdirSync(target); directorySymlink(target, resource.path);
        }
        resource.dispose(); resource.dispose();
        expect(native.fs.lstatSync(resource.path)).toBeDefined();
        expect(native.unlink).not.toHaveBeenCalled();
        expect(process.listeners('exit')).toEqual(baseline);
    });

    it('preserves a file symlink replacement and its target', context => {
        const resource = create();
        native.fs.renameSync(resource.path, join(root, 'retired'));
        const target = join(root, 'target'); native.fs.writeFileSync(target, 'keep');
        fileSymlinkOrSkip(context, target, resource.path);
        resource.dispose();
        expect(native.fs.lstatSync(resource.path).isSymbolicLink()).toBe(true);
        expect(native.fs.readFileSync(target, 'utf8')).toBe('keep');
        expect(native.unlink).not.toHaveBeenCalled();
    });

    it.each(['lstat', 'unlink'])('contains %s failures, emits one redacted diagnostic, and retires its listener', operation => {
        const resource = create();
        const initialCode = process.exitCode;
        const failure = Object.assign(new Error(`${resource.path} ${marker}`), { code: 'EACCES' });
        const diagnostic = native.report;
        const effect = operation === 'lstat' ? native.lstat : native.unlink;
        effect.mockImplementationOnce(() => { throw failure; });
        expect(() => resource.dispose()).not.toThrow();
        resource.dispose();
        expect(native.fs.existsSync(resource.path)).toBe(true);
        expect(diagnostic).toHaveBeenCalledTimes(1);
        expect(diagnostic.mock.calls[0][0]).toBe(2);
        const output = diagnostic.mock.calls.flat().join(' ');
        expect(output).not.toContain(resource.path);
        expect(output).not.toContain(marker);
        expect(output.length).toBeLessThan(256);
        expect(process.listeners('exit')).toEqual(baseline);
        expect(process.exitCode).toBe(initialCode);
    });

    it('redacts malicious errno and contains throwing diagnostics', () => {
        const first = create();
        const diagnostic = native.report;
        native.lstat.mockImplementationOnce(() => { throw { code: marker, message: root }; });
        first.dispose();
        const output = diagnostic.mock.calls.flat().join(' ');
        expect(output).not.toContain(marker); expect(output).not.toContain(root);
        native.fs.unlinkSync(first.path);
        const second = create();
        native.lstat.mockImplementationOnce(() => { throw { code: 'EIO' }; });
        diagnostic.mockImplementation(() => {
            throw Object.assign(new Error(marker), { code: 'EPIPE' });
        });
        expect(() => second.dispose()).not.toThrow();
        expect(process.listeners('exit')).toEqual(baseline);
    });

    it('unknown creating-FD metadata cannot authorize writing or cleanup', () => {
        native.stat.mockImplementationOnce(fd => {
            const actual = native.fs.fstatSync(fd, { bigint: true });
            return Object.assign(actual, { ino: 0n });
        });
        expect(() => create()).toThrow();
        expect(native.write).not.toHaveBeenCalled();
        expect(native.unlink).not.toHaveBeenCalled();
        expect(native.fs.readFileSync(join(root, 'ccc-env-a1b2c3d4e5f6'), 'utf8')).toBe('');
    });

    it('uncertain disposal identity is retained and its warning is terminal', () => {
        const resource = create();
        native.lstat.mockImplementationOnce(path => {
            const actual = native.fs.lstatSync(path, { bigint: true });
            return Object.assign(actual, { ino: 0n });
        });
        const diagnostic = native.report;
        expect(() => resource.dispose()).not.toThrow(); resource.dispose();
        expect(native.unlink).not.toHaveBeenCalled();
        expect(native.fs.existsSync(resource.path)).toBe(true);
        expect(diagnostic).toHaveBeenCalledTimes(1);
        expect(process.listeners('exit')).toEqual(baseline);
    });

    it('keeps a primary write error when owned cleanup and diagnostics both fail', () => {
        const primary = { primary: marker };
        native.write.mockImplementationOnce(() => { throw primary; });
        native.unlink.mockImplementationOnce(() => { throw new Error(`${root} ${marker}`); });
        native.report.mockImplementation(() => { throw new Error('report failure'); });
        let caught: unknown;
        try { create(); } catch (error) { caught = error; }
        expect(caught).toBe(primary);
        expect(native.fs.existsSync(join(root, 'ccc-env-a1b2c3d4e5f6'))).toBe(true);
        expect(process.listeners('exit')).toEqual(baseline);
    });

    it('uses fixed redacted diagnostics for invalid errno', () => {
        const diagnostic = native.report;
        const messages: string[] = [];
        for (const code of [marker, 'E'.repeat(300), undefined]) {
            const resource = create();
            const failure = { code, message: `${marker} ${root}` };
            native.lstat.mockImplementationOnce(() => { throw failure; });
            expect(() => resource.dispose()).not.toThrow();
            messages.push(String(diagnostic.mock.calls.at(-1)?.[1]));
            native.fs.unlinkSync(resource.path);
        }
        expect(new Set(messages).size).toBe(1);
        expect(messages[0]).not.toContain(marker);
        expect(messages[0]).not.toContain(root);
    });

    it('preserves a primary write failure and reports recovery close failure once after owned cleanup', () => {
        const primary = { primary: marker };
        const cleanupFailure = Object.assign(new Error(`${root} ${marker}`), { code: 'EIO' });
        native.write.mockImplementationOnce(() => { throw primary; });
        native.close.mockImplementationOnce(fd => {
            // Close the real fixture descriptor before injecting the reported close failure.
            native.fs.closeSync(fd);
            throw cleanupFailure;
        });
        let caught: unknown;
        try { create(); } catch (error) { caught = error; }
        expect(caught).toBe(primary);
        expect(native.close).toHaveBeenCalledTimes(1);
        expect(native.unlink).toHaveBeenCalledTimes(1);
        expect(native.fs.existsSync(join(root, 'ccc-env-a1b2c3d4e5f6'))).toBe(false);
        expect(native.report).toHaveBeenCalledTimes(1);
        expect(native.report.mock.calls[0][0]).toBe(2);
        const output = String(native.report.mock.calls[0][1]);
        expect(output).toContain('EIO');
        expect(output).not.toContain(root);
        expect(output).not.toContain(marker);
        expect(output.length).toBeLessThan(256);
        expect(process.listeners('exit')).toEqual(baseline);
    });
});
