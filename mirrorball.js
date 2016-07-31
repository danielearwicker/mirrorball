"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator.throw(value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments)).next());
    });
};
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const maxSampleSize = 0x100000;
function p(impl) {
    return new Promise((resolve, reject) => {
        impl((err, result) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(result);
            }
        });
    });
}
function read(fd, buffer, offset, length, position) {
    return p(cb => fs.read(fd, buffer, offset, length, position, (e, g, b) => cb(e, g)));
}
function hash(filePath, fileStat) {
    return __awaiter(this, void 0, void 0, function* () {
        const sampleSize = Math.min(maxSampleSize, fileStat.size);
        if (sampleSize === 0) {
            return '';
        }
        const fileHandle = fs.openSync(filePath, "r");
        try {
            const sampleBuffer = new Buffer(sampleSize);
            const got1 = yield read(fileHandle, sampleBuffer, 0, sampleSize, fileStat.size - sampleSize);
            const hash = crypto.createHash("sha512");
            hash.update(sampleBuffer);
            if (fileStat.size > sampleSize * 2) {
                const got2 = yield read(fileHandle, sampleBuffer, 0, sampleSize, 0);
                hash.update(sampleBuffer);
            }
            return hash.digest("base64");
        }
        finally {
            yield fs.close(fileHandle);
        }
    });
}
;
function makePathTo(fileOrDir) {
    const dirName = path.dirname(fileOrDir);
    try {
        fs.statSync(dirName);
    }
    catch (x) {
        makePathTo(dirName);
        console.log("Creating folder: " + dirName);
        fs.mkdirSync(dirName);
    }
}
;
function removeEmptyFolders(folder) {
    try {
        if (fs.readdirSync(folder).length) {
            return;
        }
        console.log("Removing empty folder: " + folder);
        fs.rmdirSync(folder);
        removeEmptyFolders(path.dirname(folder));
    }
    catch (x) { }
}
function deleteFile(filePath) {
    console.log('Deleting file: ' + filePath);
    fs.unlinkSync(filePath);
    removeEmptyFolders(path.dirname(filePath));
}
function renameFile(oldName, newName) {
    makePathTo(newName);
    fs.renameSync(oldName, newName);
    removeEmptyFolders(path.dirname(oldName));
}
function scanFolder(p, each) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const s = fs.statSync(p);
            if (s.isDirectory()) {
                console.log(p);
                const ar = fs.readdirSync(p);
                for (const child of ar) {
                    if (child[0] !== ".") {
                        yield scanFolder(path.join(p, child), each);
                    }
                }
            }
            else {
                yield each(p, s);
            }
        }
        catch (x) {
            console.error(x);
        }
    });
}
function readInput() {
    return new Promise(resolve => {
        function listener(text) {
            process.stdin.pause();
            process.stdin.removeListener("data", listener);
            resolve(text);
        }
        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", listener);
    });
}
const stateFileName = ".mirrorball";
function fetchState(folderPath) {
    return __awaiter(this, void 0, void 0, function* () {
        console.log("Reading state of " + folderPath);
        const stateFilePath = path.join(folderPath, stateFileName);
        let state = {};
        const byPath = {}, newState = {};
        try {
            state = JSON.parse(fs.readFileSync(stateFilePath, { encoding: "utf8" }));
        }
        catch (x) { }
        const previousHashes = Object.keys(state);
        const previousCount = previousHashes.length;
        previousHashes.forEach(hash => {
            const rec = Object.create(state[hash]);
            rec.hash = hash;
            byPath[rec.path] = rec;
        });
        yield scanFolder(folderPath, (filePath, fileStat) => __awaiter(this, void 0, void 0, function* () {
            const fileSuffix = filePath.substr(folderPath.length), rec = byPath[fileSuffix], fileTime = fileStat.mtime.getTime();
            if (!rec || (fileTime != rec.time)) {
                const fileHash = yield hash(filePath, fileStat);
                const clash = newState[fileHash];
                if (clash) {
                    console.log("Identical hashes: '" + fileSuffix + "' and '" + clash.path + "'");
                    process.exit(1);
                }
                else {
                    newState[fileHash] = {
                        path: fileSuffix,
                        time: fileTime,
                        size: fileStat.size
                    };
                }
            }
            else {
                newState[rec.hash] = {
                    path: fileSuffix,
                    time: rec.time,
                    size: fileStat.size
                };
            }
        }));
        fs.writeFileSync(stateFilePath, JSON.stringify(newState, null, 2));
        return newState;
    });
}
function makeThrottle() {
    const started = new Date().getTime();
    let updated = 0;
    return {
        elapsed() {
            const now = new Date().getTime();
            return (now - started) / 1000;
        },
        ready() {
            const now = new Date().getTime();
            if ((updated + 1000) > now) {
                return false;
            }
            updated = now;
            return true;
        }
    };
}
function makeProgressBar(fraction) {
    const barLength = 35;
    const units = Math.round(barLength * Math.min(1, Math.max(0, fraction)));
    let progStr = "[";
    for (let n = 0; n < units; n++) {
        progStr += "*";
    }
    if (units < barLength) {
        progStr += "|";
    }
    for (let n = units + 1; n < barLength; n++) {
        progStr += "_";
    }
    progStr += "]";
    return progStr;
}
const padding = "                              ";
function makeProgress(totalBytes) {
    const throttle = makeThrottle();
    let totalProgress = 0;
    return (progressBytes) => {
        if (progressBytes === null) {
            process.stdout.write(padding + padding + "\r");
            return;
        }
        totalProgress += progressBytes;
        if (!throttle.ready()) {
            return;
        }
        const elapsed = throttle.elapsed();
        const bps = Math.round(((totalProgress / 1000000) * 800) / elapsed) / 100;
        const text = "\r" + makeProgressBar(totalProgress / totalBytes) + " " + bps + "mbps" + padding;
        process.stdout.write(text.substr(0, 50));
    };
}
function copyFile(fromPath, toPath) {
    console.log("Copying from '" + fromPath + "' to '" + toPath);
    makePathTo(toPath);
    const fileSize = (fs.statSync(fromPath)).size, bufferSize = Math.min(0x10000, fileSize), buffer = new Buffer(bufferSize), progress = makeProgress(fileSize), handleFrom = fs.openSync(fromPath, "r"), handleTo = fs.openSync(toPath, "w");
    try {
        for (;;) {
            const got = fs.readSync(handleFrom, buffer, 0, bufferSize, null);
            if (got <= 0)
                break;
            fs.writeSync(handleTo, buffer, 0, got);
            progress(got);
        }
        progress(null);
    }
    finally {
        fs.closeSync(handleFrom);
        fs.closeSync(handleTo);
    }
}
function formatFileSize(size) {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let unit = 0;
    while (size > 1024) {
        unit++;
        size /= 1024;
    }
    return (Math.round(size * 100) / 100) + " " + units[unit];
}
function pickOne(prompt, options) {
    return __awaiter(this, void 0, void 0, function* () {
        options.forEach((option, i) => console.log("[" + (i + 1) + "] " + option.caption));
        for (;;) {
            const line = yield readInput();
            const o = options[parseInt(line, 10) - 1];
            if (o) {
                return o.value;
            }
        }
    });
}
function makeStateProgresses() {
    const fractions = [0, 0], throttle = makeThrottle();
    function updateProgress() {
        if (throttle.ready()) {
            process.stdout.write("\r" + fractions.map(makeProgressBar).join(" "));
        }
    }
    return [0, 1].map(index => (fraction) => {
        fractions[index] = fraction;
        updateProgress();
    });
}
function mirror(folderPaths) {
    return __awaiter(this, void 0, void 0, function* () {
        const states = yield Promise.all(folderPaths.map((p, i) => fetchState(p))), extras = [];
        const sameFileDifferentPaths = [];
        for (const hash in states[0]) {
            const first = states[0][hash], second = states[1][hash];
            if (!second) {
                extras.push({
                    from: folderPaths[0],
                    to: folderPaths[1],
                    path: first.path,
                    size: first.size
                });
            }
            else if (first.path != second.path) {
                sameFileDifferentPaths.push({ first, second });
            }
        }
        for (const hash in states[1]) {
            const first = states[0][hash], second = states[1][hash];
            if (!first) {
                extras.push({
                    from: folderPaths[1],
                    to: folderPaths[0],
                    path: second.path,
                    size: second.size
                });
            }
        }
        if (extras.length === 0 && sameFileDifferentPaths.length === 0) {
            console.log("All good.");
            return;
        }
        if (extras.length) {
            console.log(`Same path, different contents: ${extras.length}`);
        }
        if (sameFileDifferentPaths.length) {
            console.log(`Same file, different paths: ${sameFileDifferentPaths}`);
        }
        for (const pair of sameFileDifferentPaths) {
            console.log("Same file, different paths:");
            const choice = yield pickOne("Which name is correct?", [{
                    caption: pair.first.path,
                    value: () => renameFile(folderPaths[1] + pair.second.path, folderPaths[1] + pair.first.path)
                }, {
                    caption: pair.second.path,
                    value: () => renameFile(folderPaths[0] + pair.first.path, folderPaths[0] + pair.second.path)
                }]);
            choice();
        }
        const byPath = {};
        for (const extra of extras) {
            const clash = byPath[extra.path];
            if (clash) {
                console.log("Same path, different contents: " + extra.path);
                const choice = yield pickOne("Which one should be marked for deletion?", [{
                        caption: clash.from + " - size: " + formatFileSize(clash.size),
                        value: clash
                    }, {
                        caption: extra.from + " - size: " + formatFileSize(extra.size),
                        value: extra
                    }]);
                choice.kill = true;
            }
            else {
                byPath[extra.path] = extra;
            }
        }
        for (;;) {
            console.log("Extra files:");
            extras.forEach((extra, i) => console.log(i + ". " + (extra.kill ? "[DELETING] " : "") + extra.from + extra.path));
            console.log("Enter file number(s) to toggle deletion, or S to start:");
            const i = yield readInput();
            if (i.toLowerCase() === 's') {
                break;
            }
            i.split(' ').forEach(number => {
                let first, last;
                const dash = number.indexOf('-');
                if (dash !== -1) {
                    first = parseInt(number.substr(0, dash));
                    last = parseInt(number.substr(dash + 1));
                }
                else {
                    first = last = parseInt(number);
                }
                for (let n = first; n <= last; n++) {
                    const extra = extras[n];
                    if (extra) {
                        extra.kill = !extra.kill;
                    }
                }
            });
        }
        for (const extra of extras) {
            if (extra.kill) {
                deleteFile(extra.from + extra.path);
            }
            else {
                copyFile(extra.from + extra.path, extra.to + extra.path);
            }
        }
    });
}
function main(args) {
    return __awaiter(this, void 0, void 0, function* () {
        if (args.length != 2) {
            console.log('Specify two folder paths to compare');
        }
        else {
            if (args[0] == "-s") {
                console.log("Refreshing state only");
                yield fetchState(args[1]);
            }
            else {
                yield mirror(args.map(path => path[path.length - 1] !== '/' ? path + '/' : path));
            }
        }
    });
}
main(process.argv.slice(2)).catch(err => {
    if (err) {
        console.log(err);
        if (err.stack) {
            console.log(err.stack);
        }
    }
});
