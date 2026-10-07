/** Node provider program; prepended with a fixture tool name by the MCP fixture. */
export const fakeAndroidProviderScript = String.raw`
const fs = require('node:fs'), path = require('node:path');
const home = process.env.HOME, allArgs = process.argv.slice(2);
const marker = (name) => path.join(home, name);
const active = (serial) => marker('fake-adb-active-' + encodeURIComponent(serial));
const has = (name) => fs.existsSync(marker(name));
const read = (name) => fs.readFileSync(marker(name), 'utf8');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
fs.appendFileSync(process.env.FAKE_ANDROID_LOG, tool + ' ' + allArgs.join(' ') + '\n');
function replaceState(prefix, exitCode) {
    if (!has(prefix + '-path')) return;
    try { fs.copyFileSync(marker(prefix + '.json'), read(prefix + '-path')); fs.rmSync(marker(prefix + '-path')); }
    catch (error) { console.error(error.message); process.exit(exitCode); }
}
async function main() {
    if (tool === 'emulator') {
        if (allArgs[0] === '-list-avds') { console.log('host_pixel\nccc-external-other'); return; }
        replaceState('fake-android-start-conflict-state', 92);
        const portIndex = allArgs.indexOf('-port');
        if (portIndex >= 0 && allArgs[portIndex + 1]) fs.writeFileSync(active('emulator-' + allArgs[portIndex + 1]), '');
        await sleep(20000); return;
    }
    if (tool === 'avdmanager') {
        if (allArgs[0] === 'list' && allArgs[1] === 'device') { console.log('id: 0 or "pixel_6"'); return; }
        if (allArgs[0] === 'create' && allArgs[1] === 'avd' && allArgs[2] === '--name' && allArgs[3]) {
            const directory = path.join(home, '.android', 'avd', allArgs[3] + '.avd');
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(home, '.android', 'avd', allArgs[3] + '.ini'), 'path=' + directory + '\n');
            if (has('fake-android-avdmanager-create-fail')) { console.error('injected partial AVD creation failure'); process.exit(17); }
        }
        if (allArgs[0] === 'create') replaceState('fake-android-create-conflict-state', 91);
        return;
    }
    let args = allArgs, serial = '';
    if (args[0] === '-s') { serial = args[1]; args = args.slice(2); }
    if (args[0] === 'devices' && args[1] === '-l') {
        if (has('fake-adb-devices-fail')) { console.error('adb server unavailable'); process.exit(12); }
        console.log('List of devices attached\nR5CREAL123 device usb:1-1 product:oriole model:Pixel_6 device:oriole transport_id:7\n192.168.1.50:5555 device product:oriole model:Pixel_6 device:oriole transport_id:9\n192.168.1.60:5555 device product:oriole model:Pixel_6 device:oriole transport_id:10\nR5LEASED999 device usb:1-4 product:oriole model:Pixel_6 device:oriole transport_id:8\nUNAUTHORIZED unauthorized usb:1-2 model:Pixel_5\nOFFLINE offline usb:1-3 model:Pixel_4\nemulator-5554 device product:sdk_gphone');
        for (const file of fs.readdirSync(home).filter(name => name.startsWith('fake-adb-active-emulator-'))) {
            const port = file.split('-').at(-1);
            if (port !== '5554') console.log('emulator-' + port + ' device product:sdk_gphone');
        }
        if (has('fake-adb-extra-emulator')) console.log('emulator-' + read('fake-adb-extra-emulator').trim() + ' device product:sdk_gphone');
        return;
    }
    if (args[0] === 'connect') { if (args[1] === '192.168.1.50:5555') { console.log('connected to ' + args[1]); return; } console.error('failed to connect to ' + args[1]); process.exit(1); }
    if (args[0] === 'tcpip') { if (args[1] === '5555') { console.log('restarting in TCP mode port: ' + args[1]); return; } console.error('failed to restart tcpip on ' + args[1]); process.exit(1); }
    if (args[0] === 'pair') { if (args[1] === '192.168.1.70:37099' && args[2] === '123456') { console.log('Successfully paired to ' + args[1]); return; } console.error('Failed to pair to ' + args[1]); process.exit(1); }
    if (args[0] === 'get-state') { if (!serial || !fs.existsSync(active(serial))) { console.error('device not found'); process.exit(1); } console.log('device'); return; }
    if (args[0] === 'emu' && args[1] === 'avd' && args[2] === 'name') {
        console.log(has('fake-adb-avd-name-' + encodeURIComponent(serial)) ? read('fake-adb-avd-name-' + encodeURIComponent(serial)).trimEnd() : 'host_pixel'); console.log('OK'); return;
    }
    if (args[0] === 'emu' && args[1] === 'kill') { fs.rmSync(active(serial), { force: true }); return; }
    if (args[0] === 'shell' && args[1] === 'getprop' && args[2] === 'sys.boot_completed') {
        for (let i = 0; has('fake-android-start-conflict-state-path') && i < 200; i++) await sleep(10);
        console.log('1'); return;
    }
    if (args[0] === 'shell' && args[1] === 'uiautomator' && args[2] === 'dump') { console.log('UI hierchary dumped to: ' + args[3]); return; }
    if ((args[0] === 'exec-out' || args[0] === 'shell') && args[1] === 'cat') { console.log('<hierarchy><node text="Hello" resource-id="com.example:id/title"/></hierarchy>'); return; }
    if (args[0] === 'exec-out' && args[1] === 'screencap' && args[2] === '-p') {
        process.stdout.write(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('FAKEPNG')]));
        if (has('fake-screencap-large')) process.stdout.write(Buffer.alloc(2 * 1048576));
        process.exitCode = has('fake-screencap-exit-1') ? 1 : 0; return;
    }
    if (args[0] === 'shell' && args[1] === 'screenrecord') {
        if (args[4]?.includes('fail-immediate')) process.exit(9);
        if (args[4]?.includes('natural-exit')) {
            // The test releases only after start has captured and committed identity.
            const deadline = Date.now() + 30000;
            while (!has('fake-adb-release-natural-recording')) {
                if (!fs.existsSync(home)) return;
                if (Date.now() >= deadline) throw new Error('natural recording fixture release timed out');
                await sleep(20);
            }
            return;
        }
        await sleep(20000); return;
    }
    if (args[0] === 'shell' && args[1] === 'pkill') replaceState('fake-android-real-state-conflict', 93);
    if (args[0] === 'pull') {
        if (args[1]?.includes('fail-pull')) process.exit(8);
        if (args[1]?.includes('fail-once-pull') && !has('fake-adb-pull-retried')) { fs.writeFileSync(marker('fake-adb-pull-retried'), ''); process.exit(8); }
        fs.writeFileSync(args[2], 'downloaded'); return;
    }
    if (args[0] === 'push' && args[2]?.includes('fail-push')) process.exit(8);
    if (args[0] === 'shell') console.log('ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;

/** Exercise Windows launcher creation while substituting only this fixture's fake emulator. */
export function fakeAndroidLauncherPreloadSource(binDir: string): string {
    return String.raw`
const androidSpawn = cp.spawn;
const androidSpawnSync = cp.spawnSync;
cp.spawnSync = function(command, args = [], options = {}) {
    // This SDK fixture owns no native emulator.exe/qemu processes. Model only
    // the exact AVD liveness probe; process identity probes remain native.
    const avdProbe = "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(emulator|qemu-system-.*)\\.exe$' } | ForEach-Object { [string]$_.CommandLine }";
    const probeArgs = args[0] === '-WindowStyle' && args[1] === 'Hidden' ? args.slice(2) : args;
    if (command === 'powershell.exe' && probeArgs.length === 4 && probeArgs[0] === '-NoProfile' && probeArgs[1] === '-NonInteractive' && probeArgs[2] === '-Command' && probeArgs[3] === avdProbe) {
        return { status: 0, signal: null, pid: 0, stdout: '', stderr: '', output: [null, '', ''] };
    }
    return androidSpawnSync(command, args, options);
};
cp.spawn = function(command, args = [], options = {}) {
    const emulator = path.join(${JSON.stringify(binDir)}, 'emulator');
    if ((command === emulator || command === 'wscript.exe') && process.env.HOME && fs.existsSync(path.join(process.env.HOME, 'fake-android-spawn-failure'))) {
        return originalSpawn(path.join(${JSON.stringify(binDir)}, 'missing-emulator'), args, options);
    }
    if (command === path.join(${JSON.stringify(binDir)}, 'adb')
        && args[0] === '-s' && args[2] === 'shell' && args[3] === 'screenrecord'
        && args[4] === '--time-limit' && args[5] === '5'
        && args[6] === '/sdcard/fail-immediate-recording.mp4' && args.length === 7) {
        // Model an immediately exiting provider explicitly. Starting the Node fixture
        // itself can exceed the real recorder's 150ms startup observation window.
        fs.appendFileSync(process.env.FAKE_ANDROID_LOG, 'adb ' + args.join(' ') + '\n');
        const child = new (require('node:events').EventEmitter)();
        queueMicrotask(() => child.emit('exit', 9, null));
        return child;
    }
    if (command !== 'wscript.exe' || args[0] !== '//B') return androidSpawn(command, args, options);
    const script = fs.readFileSync(args[1], 'utf8');
    const run = script.match(/^Shell\.Run "(.*)", 0, True\r?$/m);
    if (!run) throw new Error('invalid fake Android launcher');
    const line = run[1].replace(/""/g, '"');
    const prefix = '%ComSpec% /d /s /c "', suffix = ' >NUL 2>NUL"';
    if (!line.startsWith(prefix) || !line.endsWith(suffix)) throw new Error('invalid fake Android launcher command');
    const words = [...line.slice(prefix.length, -suffix.length).matchAll(/"((?:\^.|[^"])*)"|(\S+)/g)]
        .map(match => (match[1] ?? match[2]).replace(/\^(.)/g, '$1'));
    if (words.shift() !== path.join(${JSON.stringify(binDir)}, 'emulator')) throw new Error('foreign fake Android launcher');
    return androidSpawn(path.join(${JSON.stringify(binDir)}, 'emulator'), words, options);
};
require('node:module').syncBuiltinESMExports();
`;
}
