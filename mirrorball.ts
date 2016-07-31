import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const maxSampleSize = 0x100000;

interface Callback<T> {
    (err: Error, result: T): void;
}

function p<T>(impl: (c: Callback<T>) => void) {
    return new Promise<T>((resolve, reject) => {
        impl((err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

function read(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
    return p<number>(cb => fs.read(fd, buffer, offset, length, position, (e, g, b) => cb(e, g)));
}

async function hash(filePath: string, fileStat: fs.Stats) {
    const sampleSize = Math.min(maxSampleSize, fileStat.size);
    if (sampleSize === 0) {
        return '';
    }
    const fileHandle = fs.openSync(filePath, "r");
    try {
        const sampleBuffer = new Buffer(sampleSize);
        const got1 = await read(fileHandle, sampleBuffer, 0, sampleSize, fileStat.size - sampleSize);

        const hash = crypto.createHash("sha512");
        hash.update(sampleBuffer);

        if (fileStat.size > sampleSize * 2) {
            const got2 = await read(fileHandle, sampleBuffer, 0, sampleSize, 0);
            hash.update(sampleBuffer);
        }

        return hash.digest("base64");

    } finally {
        await fs.close(fileHandle);
    }
};

function makePathTo(fileOrDir: string) {
    const dirName = path.dirname(fileOrDir);
    try {
        fs.statSync(dirName);
    } catch (x) {
        makePathTo(dirName);
        console.log("Creating folder: " + dirName);
        fs.mkdirSync(dirName);
    }
};

function removeEmptyFolders(folder: string) {
    try {
        if (fs.readdirSync(folder).length) {
            return;
        }
        console.log("Removing empty folder: " + folder);
        fs.rmdirSync(folder);
        removeEmptyFolders(path.dirname(folder));
    } catch (x) {}
}

function deleteFile(filePath: string) {
    console.log('Deleting file: ' + filePath);
    fs.unlinkSync(filePath);
    removeEmptyFolders(path.dirname(filePath));
}

function renameFile(oldName: string, newName: string) {
    makePathTo(newName);
    fs.renameSync(oldName, newName);
    removeEmptyFolders(path.dirname(oldName));
}

async function scanFolder(p: string, each: (p: string, s: fs.Stats) => Promise<void>) {
    try {
        const s = fs.statSync(p);
        if (s.isDirectory()) {
            console.log(p);

            const ar = fs.readdirSync(p);
            for (const child of ar) {
                if (child[0] !== ".") {
                    await scanFolder(path.join(p, child), each);
                }
            }
        } else {
            await each(p, s);
        }
    } catch(x) {
        console.error(x);
    }
}

function readInput() {

    return new Promise<string>(resolve => {
        function listener(text: string) {
            process.stdin.pause();
            process.stdin.removeListener("data", listener);
            resolve(text.trim());
        }

        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", listener);
    });
}

const stateFileName = ".mirrorball";

interface FileState {
    path: string;
    time: number;
    size: number;
}

interface FileStateWithHash extends FileState {
    hash: string;
}

async function fetchState(folderPath: string) {

    console.log("Reading state of " + folderPath);

    const stateFilePath = path.join(folderPath, stateFileName);

    let state: { [hash: string]: FileStateWithHash } = {};

    const byPath: { [path: string]: FileStateWithHash } = {},
        newState: { [hash: string]: FileState } = {};

    try {
        state = JSON.parse(fs.readFileSync(stateFilePath, { encoding: "utf8" }));
    } catch (x) { }

    const previousHashes = Object.keys(state);
    const previousCount = previousHashes.length;
    previousHashes.forEach(hash => {
        const rec = Object.create(state[hash]);
        rec.hash = hash;
        byPath[rec.path] = rec;
    });

    await scanFolder(folderPath, async (filePath, fileStat) => {

        const fileSuffix = filePath.substr(folderPath.length),
            rec = byPath[fileSuffix],
            fileTime = fileStat.mtime.getTime();
        if (!rec || (fileTime != rec.time)) {
            const fileHash = await hash(filePath, fileStat);
            const clash = newState[fileHash];
            if (clash) {
                console.log("Identical hashes: '" + fileSuffix + "' and '" + clash.path + "'");
                process.exit(1);
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

    //console.log('Saving updated state:' + stateFilePath);
    fs.writeFileSync(stateFilePath, JSON.stringify(newState, null, 2));
    return newState;
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

function makeProgressBar(fraction: number) {
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

function makeProgress(totalBytes: number) {
    const throttle = makeThrottle();
    let totalProgress = 0;

    return (progressBytes: number | null) => {
        if (progressBytes === null) {
            process.stdout.write(padding + padding + "\r");
            return;
        }

        totalProgress += progressBytes;
        if (!throttle.ready()) {
            return;
        }

        const elapsed = throttle.elapsed();
        const bps = Math.round(((totalProgress/1000000) * 800) / elapsed) / 100;
        const text = "\r" + makeProgressBar(totalProgress / totalBytes) + " " + bps + "mbps" + padding;
        process.stdout.write(text.substr(0, 50));
    };
}

function copyFile(fromPath: string, toPath: string) {

    console.log("Copying from '" + fromPath + "' to '" + toPath);
    makePathTo(toPath);

    const fileSize = (fs.statSync(fromPath)).size,
        bufferSize = Math.min(0x10000, fileSize),
        buffer = new Buffer(bufferSize),
        progress = makeProgress(fileSize),
        handleFrom = fs.openSync(fromPath, "r"),
        handleTo = fs.openSync(toPath, "w");

    try {
        for (;;) {
            const got = fs.readSync(handleFrom, buffer, 0, bufferSize, null);
            if (got <= 0) break;
            fs.writeSync(handleTo, buffer, 0, got);
            progress(got);
        }
        progress(null);
    } finally {
        fs.closeSync(handleFrom);
        fs.closeSync(handleTo);
    }
}

function formatFileSize(size: number) {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let unit = 0;
    while (size > 1024) {
        unit++;
        size /= 1024;
    }
    return (Math.round(size * 100) / 100) + " " + units[unit];
}

interface Option<T> {
    caption: string;
    value: T
}

async function pickOne<T>(prompt: string, options: Option<T>[]) {

    options.forEach((option, i) => console.log("[" + (i + 1) + "] " + option.caption));

    for (;;) {
        const line = await readInput();

        const o = options[parseInt(line, 10) - 1];
        if (o) {
            return o.value;
        }
    }
}

function makeStateProgresses() {
    const fractions = [0, 0], throttle = makeThrottle();

    function updateProgress() {
        if (throttle.ready()) {
            process.stdout.write("\r" + fractions.map(makeProgressBar).join(" "));
        }
    }

    return [0, 1].map(index => (fraction: number) => {
        fractions[index] = fraction;
        updateProgress();
    });
}

interface Extra {
    from: string, to: string, path: string, size: number, kill?: boolean
}

async function mirror(folderPaths: string[]) {

    // var progresses = makeStateProgresses();

    const states = await Promise.all(folderPaths.map((p, i) => fetchState(p))),
        extras: Extra[] = [];

    const sameFileDifferentPaths: { first: FileState, second: FileState }[] = [];

    for (const hash in states[0]) {
        const first = states[0][hash], second = states[1][hash];
        if (!second) {
            extras.push({
                from: folderPaths[0],
                to: folderPaths[1],
                path: first.path,
                size: first.size
            });
        } else if (first.path != second.path) {
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
        const choice = await pickOne("Which name is correct?", [ {
            caption: pair.first.path,
            value: () => renameFile(folderPaths[1] + pair.second.path, folderPaths[1] + pair.first.path)
        }, {
            caption: pair.second.path,
            value: () => renameFile(folderPaths[0] + pair.first.path, folderPaths[0] + pair.second.path)
        } ]);
        choice();
    }

    const byPath: { [path: string]: Extra } = {};
    for (const extra of extras) {
        const clash = byPath[extra.path];
        if (clash) {
            console.log("Same path, different contents: " + extra.path);
            const choice = await pickOne("Which one should be marked for deletion?", [ {
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
        extras.forEach((extra, i) =>
            console.log(i + ". " + (extra.kill ? "[DELETING] " : "") + extra.from + extra.path));
        console.log("Enter file number(s) to toggle deletion, or S to start:");

        const i = await readInput();
        console.log(`Input was ${i}`);

        if (i.toLowerCase() === "s") {
            break;
        }
        i.split(' ').forEach(number => {
            let first: number, last: number;
            const dash = number.indexOf('-');
            if (dash !== -1) {
                first = parseInt(number.substr(0, dash));
                last = parseInt(number.substr(dash + 1));
            } else {
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
        } else {
            copyFile(extra.from + extra.path, extra.to + extra.path);
        }
    }
}

async function main(args: string[]) {
    if (args.length != 2) {
        console.log('Specify two folder paths to compare');
    } else {
        if (args[0] == "-s") {
            console.log("Refreshing state only");

            await fetchState(args[1]);

        } else {
            await mirror(args.map(path =>
                path[path.length - 1] !== '/' ? path + '/' : path
            ));
        }
    }
}

main(process.argv.slice(2)).catch(err => {
    if (err) {
        console.log(err);
        if (err.stack) {
            console.log(err.stack);
        }
    }
});
