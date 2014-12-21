var funkify = require("funkify");
var fs = funkify(require("fs"));
var path = require("path");
var co = require("co");
var crypto = require("crypto");

var maxSampleSize = 0x100000;

function *hash(filePath, fileStat) {
    var sampleSize = Math.min(maxSampleSize, fileStat.size);
    if (sampleSize === 0) {
        return '';
    }
    var fileHandle = yield fs.open(filePath, "r");
    try {
        var sampleBuffer = new Buffer(sampleSize);
        yield fs.read(fileHandle, sampleBuffer, 0, sampleSize, fileStat.size - sampleSize);
                
        var hash = crypto.createHash("sha512");
        hash.update(sampleBuffer);

        if (fileStat.size > sampleSize * 2) {
            yield fs.read(fileHandle, sampleBuffer, 0, sampleSize, 0);
            hash.update(sampleBuffer);
        }

        return hash.digest("base64");

    } finally {
        yield fs.close(fileHandle);
    }
};

function *makePathTo(fileOrDir) {
    var dirName = path.dirname(fileOrDir);
    try {
        yield fs.stat(dirName);
    } catch (x) {
        yield *makePathTo(dirName);
        console.log("Creating folder: " + dirName);
        yield fs.mkdir(dirName);
    }
};

function *removeEmptyFolders(folder) {
    try {
        if (yield fs.readdir(folder).length) {
            return;
        }
        console.log("Removing empty folder: " + folder);
        yield fs.rmdir(folder);
        yield *removeEmptyFolders(path.dirname(folder));
    } catch (x) {}
}

function *deleteFile(filePath) {
    console.log('Deleting file: ' + filePath);
    yield fs.unlink(filePath);
    yield removeEmptyFolders(path.dirname(filePath));
}

function *renameFile(oldName, newName) {
    yield *makePathTo(newName);
    yield fs.rename(oldName, newName);
    yield *removeEmptyFolders(path.dirname(oldName));
}

function *scanFolder(p, each) {
    try {
        var s = yield fs.stat(p);
        if (s.isDirectory()) {
            var ar = yield fs.readdir(p);
            for (var n = 0; n < ar.length; n++) {
                var child = ar[n];
                if (child[0] !== ".") {
                    yield *scanFolder(path.join(p, child), each);
                }
            }
        } else {
            yield *each(p, s);
        }
    } catch(x) {
        console.error(x);
    }
}

var readInput = funkify(function() {    
    var callback, listening;
    return function(cb) {
        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        callback = cb;
        if (!listening) {
            process.stdin.on("data", function(text) {
                process.stdin.pause();
                callback(null, text.trim());
            });
            listening = true;
        }
    };
}());

var stateFileName = ".mirrorball";

function *fetchState(folderPath) {
    
    console.log("Reading state of " + folderPath);
    
    var stateFilePath = path.join(folderPath, stateFileName),        
        state = {}, byPath = {}, newState = {};

    try {
        state = JSON.parse(yield fs.readFile(stateFilePath, { encoding: "utf8" }));
    } catch (x) { }

    Object.keys(state).forEach(function (hash) {
        var rec = Object.create(state[hash]);
        rec.hash = hash;
        byPath[rec.path] = rec;
    });

    yield *scanFolder(folderPath, function *(filePath, fileStat) {
        var fileSuffix = filePath.substr(folderPath.length),
            rec = byPath[fileSuffix],
            fileTime = fileStat.mtime.getTime();
        if (!rec || (fileTime != rec.time)) {
            console.log('Computing hash for: ' + filePath);
            var fileHash = yield *hash(filePath, fileStat);
            var clash = newState[fileHash];
            if (clash) {
                console.log("Identical hashes: '" + fileSuffix + "' and '" + clash.path + "'");
            } else {
                newState[fileHash] = {
                    path: fileSuffix,
                    time: fileTime,
                    size: fileStat.size
                };
            }
        } else {
            newState[rec.hash] = {
                path: fileSuffix,
                time: rec.time,
                size: fileStat.size
            };
        }
    });
    
    yield fs.writeFile(stateFilePath, JSON.stringify(newState));
    return newState;
}

function makeProgress(totalBytes) {
    var started = new Date().getTime(),
        totalProgress = 0, 
        barLength = 20,
        padding = "                              ",
        updated = started;
        
    return function(progressBytes) {
        if (progressBytes === null) {
            process.stdout.write(padding + padding + "\r");
            return;
        }
        
        totalProgress += progressBytes;

        var now = new Date().getTime();
        if ((updated + 1000) > now) {
            return;
        }
        updated = now;

        var elapsed = (now - started) / 1000;
        var bps = Math.round(((totalProgress/1000000) * 800) / elapsed) / 100;
        var units = Math.round(barLength * totalProgress / totalBytes);
        var progStr = "\r[";
        for (var n = 0; n < units; n++) {
            progStr += "*";
        }
        progStr += "|";
        for (var n = units + 1; n < barLength; n++) {
            progStr += "_";
        }
        progStr += "] " + bps + "mbps" + padding;
        process.stdout.write(progStr.substr(0, 50));
    };
}

function *copyFile(fromPath, toPath) {
    
    console.log("Copying from '" + fromPath + "' to '" + toPath);
    yield *makePathTo(toPath);
    
    var fileSize = (yield fs.stat(fromPath)).size,
        bufferSize = Math.min(0x10000, fileSize), 
        buffer = new Buffer(bufferSize), 
        progress = makeProgress(fileSize);
        h = [ fs.open(fromPath, "r"), 
              fs.open(toPath, "w") ];
    try {
        h = yield h;
        for (;;) {
            var got = (yield fs.read(h[0], buffer, 0, bufferSize, null))[0];
            if (got <= 0) break;
            yield fs.write(h[1], buffer, 0, got, null);
            progress(got);
        }
        progress(null);
    } finally {
        yield h.map(function(handle) { 
            fs.close(handle);
        });
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

function *pickOne(prompt, options) {
    
    options.forEach(function (option, i) {
        console.log("[" + (i + 1) + "] " + option.caption);
    });

    for(;;) {    
        console.log(prompt);
        var o = options[parseInt(yield readInput(), 10) - 1];
        if (o) {
            return o.value;
        }
    }
}

function *mirror(folderPaths) {
    
    var states = yield folderPaths.map(fetchState), extras = [];

    for (var hash in states[0]) {
        var first = states[0][hash], second = states[1][hash];
        if (!second) {
            extras.push({
                from: folderPaths[0],
                to: folderPaths[1],
                path: first.path,
                size: first.size
            });
        } else if (first.path != second.path) {
            console.log("Same file, different paths:");
            var choice = yield *pickOne("Which name is correct?", [ {
                caption: first.path,
                value: function *() {
                    yield *renameFile(folderPaths[1] + second.path, folderPaths[1] + first.path);
                }
            }, {
                caption: second.path,
                value: function *() {
                    yield *renameFile(folderPaths[0] + first.path, folderPaths[0] + second.path);
                }
            } ]);
            yield *choice();
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
            var choice = yield *pickOne("Which one should be marked for deletion?", [ {
                caption: clash.from + " - size: " + formatFileSize(clash.size),
                value: clash
            }, {
                caption: extra.from + " - size: " + formatFileSize(extra.size),
                value: extra
            } ]);
            choice.kill = true;                     
        } else {
            byPath[extra.path] = extra;
        }
    }

    for (;;) {
        console.log("Extra files:");
        extras.forEach(function(extra, i) {            
            console.log(i + ". " + (extra.kill ? "[DELETING] " : "") + extra.from + extra.path);
        });
        console.log("Enter file number(s) to toggle deletion, or S to start:");
        
        var i = yield readInput();    
        if (i.toLowerCase() === 's') {
            break;
        }
        i.split(' ').forEach(function(number) {
            var extra = extras[number];
            if (extra) {
                extra.kill = !extra.kill;
            }    
        });
    }
    
    for (var c = 0; c < extras.length; c++) {
        var extra = extras[c];
        if (extra.kill) {
            yield *deleteFile(extra.from + extra.path);
        } else {
            yield *copyFile(extra.from + extra.path, extra.to + extra.path);
        }
    }
}

if (process.argv.length != 4) {
    console.log('Specify two folder paths to compare');
} else {
    co(mirror(process.argv.slice(2).map(function(path) {
        return path[path.length - 1] !== '/' ? path + '/' : path;
    })))(function(err) {
        if (err) {
            console.log(err);
            if (err.stack) {
                console.log(err.stack);
            }
        }
    });
}
