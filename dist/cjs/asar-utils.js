"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeASARs = exports.generateAsarIntegrity = exports.detectAsarMode = exports.AsarMode = void 0;
const asar = require("asar");
const child_process_1 = require("child_process");
const crypto = require("crypto");
const fs = require("fs-extra");
const path = require("path");
const minimatch = require("minimatch");
const os = require("os");
const debug_1 = require("./debug");
const LIPO = 'lipo';
var AsarMode;
(function (AsarMode) {
    AsarMode[AsarMode["NO_ASAR"] = 0] = "NO_ASAR";
    AsarMode[AsarMode["HAS_ASAR"] = 1] = "HAS_ASAR";
})(AsarMode = exports.AsarMode || (exports.AsarMode = {}));
// See: https://github.com/apple-opensource-mirror/llvmCore/blob/0c60489d96c87140db9a6a14c6e82b15f5e5d252/include/llvm/Object/MachOFormat.h#L108-L112
const MACHO_MAGIC = new Set([
    // 32-bit Mach-O
    0xfeedface,
    0xcefaedfe,
    // 64-bit Mach-O
    0xfeedfacf,
    0xcffaedfe,
]);
exports.detectAsarMode = async (appPath) => {
    debug_1.d('checking asar mode of', appPath);
    const asarPath = path.resolve(appPath, 'Contents', 'Resources', 'app.asar');
    if (!(await fs.pathExists(asarPath))) {
        debug_1.d('determined no asar');
        return AsarMode.NO_ASAR;
    }
    debug_1.d('determined has asar');
    return AsarMode.HAS_ASAR;
};
exports.generateAsarIntegrity = (asarPath) => {
    return {
        algorithm: 'SHA256',
        hash: crypto
            .createHash('SHA256')
            .update(asar.getRawHeader(asarPath).headerString)
            .digest('hex'),
    };
};
function toRelativePath(file) {
    return file.replace(/^\//, '');
}
function isDirectory(a, file) {
    return Boolean('files' in asar.statFile(a, file));
}
function checkSingleArch(archive, file, allowList) {
    if (allowList === undefined || !minimatch(file, allowList, { matchBase: true })) {
        throw new Error(`Detected unique file "${file}" in "${archive}" not covered by ` +
            `allowList rule: "${allowList}"`);
    }
}
exports.mergeASARs = async ({ x64AsarPath, arm64AsarPath, outputAsarPath, singleArchFiles, }) => {
    debug_1.d(`merging ${x64AsarPath} and ${arm64AsarPath}`);
    const x64Files = new Set(asar.listPackage(x64AsarPath).map(toRelativePath));
    const arm64Files = new Set(asar.listPackage(arm64AsarPath).map(toRelativePath));
    //
    // Build set of unpacked directories and files
    //
    const unpackedFiles = new Set();
    function buildUnpacked(a, fileList) {
        for (const file of fileList) {
            const stat = asar.statFile(a, file);
            if (!('unpacked' in stat) || !stat.unpacked) {
                continue;
            }
            if ('files' in stat) {
                continue;
            }
            unpackedFiles.add(file);
        }
    }
    buildUnpacked(x64AsarPath, x64Files);
    buildUnpacked(arm64AsarPath, arm64Files);
    //
    // Build list of files/directories unique to each asar
    //
    for (const file of x64Files) {
        if (!arm64Files.has(file)) {
            checkSingleArch(x64AsarPath, file, singleArchFiles);
        }
    }
    const arm64Unique = [];
    for (const file of arm64Files) {
        if (!x64Files.has(file)) {
            checkSingleArch(arm64AsarPath, file, singleArchFiles);
            arm64Unique.push(file);
        }
    }
    //
    // Find common bindings with different content
    //
    const commonBindings = [];
    for (const file of x64Files) {
        if (!arm64Files.has(file)) {
            continue;
        }
        // Skip directories
        if (isDirectory(x64AsarPath, file)) {
            continue;
        }
        const x64Content = asar.extractFile(x64AsarPath, file);
        const arm64Content = asar.extractFile(arm64AsarPath, file);
        if (x64Content.compare(arm64Content) === 0) {
            continue;
        }
        if (!MACHO_MAGIC.has(x64Content.readUInt32LE(0))) {
            throw new Error(`Can't reconcile two non-macho files ${file}`);
        }
        commonBindings.push(file);
    }
    //
    // Extract both
    //
    const x64Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'x64-'));
    const arm64Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arm64-'));
    try {
        debug_1.d(`extracting ${x64AsarPath} to ${x64Dir}`);
        asar.extractAll(x64AsarPath, x64Dir);
        debug_1.d(`extracting ${arm64AsarPath} to ${arm64Dir}`);
        asar.extractAll(arm64AsarPath, arm64Dir);
        for (const file of arm64Unique) {
            const source = path.resolve(arm64Dir, file);
            const destination = path.resolve(x64Dir, file);
            if (isDirectory(arm64AsarPath, file)) {
                debug_1.d(`creating unique directory: ${file}`);
                await fs.mkdirp(destination);
                continue;
            }
            debug_1.d(`xopying unique file: ${file}`);
            await fs.mkdirp(path.dirname(destination));
            await fs.copy(source, destination);
        }
        for (const binding of commonBindings) {
            const source = await fs.realpath(path.resolve(arm64Dir, binding));
            const destination = await fs.realpath(path.resolve(x64Dir, binding));
            debug_1.d(`merging binding: ${binding}`);
            child_process_1.execFileSync(LIPO, [source, destination, '-create', '-output', destination]);
        }
        debug_1.d(`creating archive at ${outputAsarPath}`);
        const resolvedUnpack = Array.from(unpackedFiles).map((file) => path.join(x64Dir, file));
        await asar.createPackageWithOptions(x64Dir, outputAsarPath, {
            unpack: `{${resolvedUnpack.join(',')}}`,
        });
        debug_1.d('done merging');
    }
    finally {
        await Promise.all([fs.remove(x64Dir), fs.remove(arm64Dir)]);
    }
};
//# sourceMappingURL=asar-utils.js.map