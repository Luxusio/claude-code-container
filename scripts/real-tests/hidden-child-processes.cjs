"use strict";

const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const marker = Symbol.for("ccc.windowsHiddenChildProcesses");

function installHiddenWindowsChildProcesses(target = childProcess, platform = process.platform) {
    if (platform !== "win32" || target[marker]) return false;

    const hidden = (options) => ({
        ...(options && typeof options === "object" ? options : {}),
        windowsHide: true,
    });
    const spawn = target.spawn;
    target.spawn = function(command, args, options) {
        return Array.isArray(args)
            ? spawn.call(this, command, args, hidden(options))
            : spawn.call(this, command, hidden(args));
    };
    const spawnSync = target.spawnSync;
    target.spawnSync = function(command, args, options) {
        return Array.isArray(args)
            ? spawnSync.call(this, command, args, hidden(options))
            : spawnSync.call(this, command, hidden(args));
    };
    const exec = target.exec;
    target.exec = function(command, options, callback) {
        return typeof options === "function"
            ? exec.call(this, command, hidden(), options)
            : exec.call(this, command, hidden(options), callback);
    };
    const execSync = target.execSync;
    target.execSync = function(command, options) {
        return execSync.call(this, command, hidden(options));
    };
    const execFile = target.execFile;
    target.execFile = function(file, args, options, callback) {
        if (!Array.isArray(args)) {
            return typeof args === "function"
                ? execFile.call(this, file, hidden(), args)
                : execFile.call(this, file, [], hidden(args), options);
        }
        return typeof options === "function"
            ? execFile.call(this, file, args, hidden(), options)
            : execFile.call(this, file, args, hidden(options), callback);
    };
    const execFileSync = target.execFileSync;
    target.execFileSync = function(file, args, options) {
        return Array.isArray(args)
            ? execFileSync.call(this, file, args, hidden(options))
            : execFileSync.call(this, file, [], hidden(args));
    };
    const fork = target.fork;
    target.fork = function(modulePath, args, options) {
        return Array.isArray(args)
            ? fork.call(this, modulePath, args, hidden(options))
            : fork.call(this, modulePath, [], hidden(args));
    };
    Object.defineProperty(target, marker, { value: true });
    if (target === childProcess) syncBuiltinESMExports();
    return true;
}

module.exports = { installHiddenWindowsChildProcesses };
installHiddenWindowsChildProcesses();
