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
var maxSampleSize = 0x100000;
function hash(filePath, fileStat) {
    var sampleSize = Math.min(maxSampleSize, fileStat.size);
    if (sampleSize === 0) {
        return '';
    }
    var fileHandle = fs.openSync(filePath, "r");
    try {
        var sampleBuffer = new Buffer(sampleSize);
        fs.readSync(fileHandle, sampleBuffer, 0, sampleSize, fileStat.size - sampleSize);
        var hash = crypto.createHash("sha512");
        hash.update(sampleBuffer);
        if (fileStat.size > sampleSize * 2) {
            fs.readSync(fileHandle, sampleBuffer, 0, sampleSize, 0);
            hash.update(sampleBuffer);
        }
        return hash.digest("base64");
    }
    finally {
        fs.closeSync(fileHandle);
    }
}
;
function makePathTo(fileOrDir) {
    var dirName = path.dirname(fileOrDir);
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
    try {
        var s = fs.statSync(p);
        if (s.isDirectory()) {
            var ar = fs.readdirSync(p);
            for (var n = 0; n < ar.length; n++) {
                var child = ar[n];
                if (child[0] !== ".") {
                    scanFolder(path.join(p, child), each);
                }
            }
        }
        else {
            each(p, s);
        }
    }
    catch (x) {
        console.error(x);
    }
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
var stateFileName = ".mirrorball";
function fetchState(folderPath, progress) {
    console.log("Reading state of " + folderPath);
    var stateFilePath = path.join(folderPath, stateFileName), state = {}, byPath = {}, newState = {};
    try {
        state = JSON.parse(fs.readFileSync(stateFilePath, { encoding: "utf8" }));
    }
    catch (x) { }
    var previousHashes = Object.keys(state);
    var previousCount = previousHashes.length;
    previousHashes.forEach(hash => {
        var rec = Object.create(state[hash]);
        rec.hash = hash;
        byPath[rec.path] = rec;
    });
    var index = 0;
    scanFolder(folderPath, function (filePath, fileStat) {
        progress((index++) / previousCount);
        var fileSuffix = filePath.substr(folderPath.length), rec = byPath[fileSuffix], fileTime = fileStat.mtime.getTime();
        if (!rec || (fileTime != rec.time)) {
            var fileHash = hash(filePath, fileStat);
            var clash = newState[fileHash];
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
    });
    fs.writeFileSync(stateFilePath, JSON.stringify(newState));
    return newState;
}
function makeThrottle() {
    var started = new Date().getTime(), updated = 0;
    return {
        elapsed() {
            var now = new Date().getTime();
            return (now - started) / 1000;
        },
        ready() {
            var now = new Date().getTime();
            if ((updated + 1000) > now) {
                return false;
            }
            updated = now;
            return true;
        }
    };
}
function makeProgressBar(fraction) {
    var barLength = 35;
    var units = Math.round(barLength * fraction);
    var progStr = "[";
    for (var n = 0; n < units; n++) {
        progStr += "*";
    }
    if (units < barLength) {
        progStr += "|";
    }
    for (var n = units + 1; n < barLength; n++) {
        progStr += "_";
    }
    progStr += "]";
    return progStr;
}
var padding = "                              ";
function makeProgress(totalBytes) {
    var throttle = makeThrottle(), totalProgress = 0;
    return (progressBytes) => {
        if (progressBytes === null) {
            process.stdout.write(padding + padding + "\r");
            return;
        }
        totalProgress += progressBytes;
        if (!throttle.ready()) {
            return;
        }
        var elapsed = throttle.elapsed();
        var bps = Math.round(((totalProgress / 1000000) * 800) / elapsed) / 100;
        var text = "\r" + makeProgressBar(totalProgress / totalBytes) + " " + bps + "mbps" + padding;
        process.stdout.write(text.substr(0, 50));
    };
}
function copyFile(fromPath, toPath) {
    console.log("Copying from '" + fromPath + "' to '" + toPath);
    makePathTo(toPath);
    var fileSize = (fs.statSync(fromPath)).size, bufferSize = Math.min(0x10000, fileSize), buffer = new Buffer(bufferSize), progress = makeProgress(fileSize), handleFrom = fs.openSync(fromPath, "r"), handleTo = fs.openSync(toPath, "w");
    try {
        for (;;) {
            var got = fs.readSync(handleFrom, buffer, 0, bufferSize, null);
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
    var units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    var unit = 0;
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
            var line = yield readInput();
            var o = options[parseInt(line, 10) - 1];
            if (o) {
                return o.value;
            }
        }
    });
}
function makeStateProgresses() {
    var fractions = [0, 0], throttle = makeThrottle();
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
        var progresses = makeStateProgresses();
        var states = folderPaths.map((p, i) => fetchState(p, progresses[i])), extras = [];
        for (var hash in states[0]) {
            var first = states[0][hash], second = states[1][hash];
            if (!second) {
                extras.push({
                    from: folderPaths[0],
                    to: folderPaths[1],
                    path: first.path,
                    size: first.size
                });
            }
            else if (first.path != second.path) {
                console.log("Same file, different paths:");
                let choice = yield pickOne("Which name is correct?", [{
                        caption: first.path,
                        value: () => renameFile(folderPaths[1] + second.path, folderPaths[1] + first.path)
                    }, {
                        caption: second.path,
                        value: () => renameFile(folderPaths[0] + first.path, folderPaths[0] + second.path)
                    }]);
                choice();
            }
        }
        for (var hash in states[1]) {
            var first = states[0][hash], second = states[1][hash];
            if (!first) {
                extras.push({
                    from: folderPaths[1],
                    to: folderPaths[0],
                    path: second.path,
                    size: second.size
                });
            }
        }
        if (extras.length === 0) {
            console.log("All good.");
            return;
        }
        var byPath = {};
        for (var c = 0; c < extras.length; c++) {
            var extra = extras[c], clash = byPath[extra.path];
            if (clash) {
                console.log("Same path, different contents: " + extra.path);
                let choice = yield pickOne("Which one should be marked for deletion?", [{
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
            var i = yield readInput();
            if (i.toLowerCase() === 's') {
                break;
            }
            i.split(' ').forEach(number => {
                var first, last, dash = number.indexOf('-');
                if (dash !== -1) {
                    first = parseInt(number.substr(0, dash));
                    last = parseInt(number.substr(dash + 1));
                }
                else {
                    first = last = parseInt(number);
                }
                for (var n = first; n <= last; n++) {
                    var extra = extras[n];
                    if (extra) {
                        extra.kill = !extra.kill;
                    }
                }
            });
        }
        for (var c = 0; c < extras.length; c++) {
            var extra = extras[c];
            if (extra.kill) {
                deleteFile(extra.from + extra.path);
            }
            else {
                copyFile(extra.from + extra.path, extra.to + extra.path);
            }
        }
    });
}
if (process.argv.length != 4) {
    console.log('Specify two folder paths to compare');
}
else {
    mirror(process.argv.slice(2).map(path => path[path.length - 1] !== '/' ? path + '/' : path)).catch(err => {
        if (err) {
            console.log(err);
            if (err.stack) {
                console.log(err.stack);
            }
        }
    });
}
