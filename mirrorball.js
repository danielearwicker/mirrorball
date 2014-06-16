var fs = require("fs");
var path = require("path");
var http = require("http");
var url = require("url");

var express = require("express");

var scan = require("./scan.js");
var hash = require("./hash.js");
var worker = require("./worker.js");

var config = require("./config.json");

var profileName = process.argv[2] || "default";

if (profileName) {
    config = config[profileName];
    if (!config) {
        throw new Error("Invalid profile name: " + profileName);
    }
}

if (!config.media) {
    throw new Error("Must specify media");
}
if (!config.peer) {
    throw new Error("Must specify peer");
}

var mediaPath = config.media;
if (mediaPath[mediaPath.length - 1] != path.sep) {
    mediaPath += path.sep;
}

function makePathTo(fileOrDir) {
    var dirName = path.dirname(fileOrDir);
    try {
        if (fs.statSync(dirName).isDirectory()) {
            return;
        }
    } catch (x) {
        makePathTo(dirName);
        fs.mkdirSync(dirName);
    }
};

function removeEmptyFolders(folder) {
    try {
        if (fs.readdirSync(folder).length) {
            return;
        }
        fs.rmdirSync(folder);
        removeEmptyFolders(path.dirname(folder));
    } catch (x) {}  
}

function aspect(obj, wrap, key, parent) {    
    if (typeof obj === "function") {    
        return function() {
            var args = arguments;
            return wrap(function() {
                obj.apply(parent || null, args);
            }, key);
        }
    }
    var wrapped = {};
    Object.keys(obj).forEach(function(key) {
        wrapped[key] = aspect(obj[key], wrap, key, obj);        
    });
    return wrapped;
}

var stateFileName = ".mirrorball";
var stateFilePath = path.join(mediaPath, stateFileName);
var localState;

var events = {
    next: 1, // events have a sequence number
    pages: [[]], // array of arrays of events
    clients: []
}

function subscribe(adding, list) {
    if (adding) {
        events.clients.push(list);
    } else {
        for (var n = 0; n < events.clients.length; n++) {
            if (events.clients[n] === list) {
                events.clients.splice(n, 1);
                return;
            }
        }
    }
}

function collect(after, list) {
    events.pages.forEach(function(page) {
        if (page[page.length - 1].index > after) {
            page.forEach(function (event) {
                if (event.index > after) {
                    list.push(event);
                }
            });
        }
    });
}

var maxLiveEvents = 100;
var maxArchived = 100;

function event(kind, message) {
    var rest = Array.prototype.slice.call(arguments, 2);

    var now = new Date();
    console.log(now, kind, message, rest);
    
    var evt = {
        index: events.next++,
        time: now.getTime(),
        kind: kind,
        message: message,
        rest: rest
    };
    
    events.clients.forEach(function(client) {
        client.push(evt);
    });
    
    var lastPage = events.pages[events.pages.length - 1];
    if (lastPage.length >= maxLiveEvents) {
        lastPage = [];
        while (events.pages.length > maxArchived) {
            events.pages.shift();
        }
        events.pages.push(lastPage);
    }
    lastPage.push(evt);
}

function updateLocalState(callback) {

    fs.readFile(stateFilePath, { encoding: "utf8" }, function(err, stateJson) {
        var state = {};
        if (!err) {
            try {
                state = JSON.parse(stateJson);
            } catch (x) {
                event("warn", "Starting with empty state", x.message);
            }
        } else {
            event("warn", "Starting with empty state", err.message);
        }

        var byPath = {}, newState = {};

        Object.keys(state).forEach(function(hash) {
            var rec = Object.create(state[hash]);
            rec.hash = hash;
            byPath[rec.path] = rec;
        });

        var hashes = worker({
            each: function(file, next) {
                var knownByHash = state[file.hash];
                var touch = false;
                if (knownByHash) {
                    if (file.path !== knownByHash.path) {
                        if (!knownByHash.path) {
                            var ft = file.stat.mtime.getTime();
                            if (file.stat.mtime.getTime() <= knownByHash.time) {
                                touch = true;
                            }
                            event("local", "Resurrected", file.path);
                        } else {
                            event("local", "Moved", knownByHash.path, file.path);
                            touch = true;
                        }
                    }
                } else {
                    event("local", "Added", file.path);
                }
                
                var duplicate = newState[file.hash];
                if (duplicate) {
                    event("warn", "Duplicates", duplicate.path, file.path);
                } else {
                    
                    var time = file.stat.mtime.getTime();
                    if (touch) {
                        time = new Date();
                        time.setMilliseconds(0);
                        fs.utimesSync(path.join(mediaPath, file.path), time, time);
                    }
                    
                    newState[file.hash] = {
                        path: file.path,
                        size: file.stat.size,
                        time: time
                    };
                }
                next();
            },
            end: function() {
                
                Object.keys(state).forEach(function(hash) {
                    var oldRecord = state[hash];
                    if (!oldRecord.path) {                          
                        var newRecord = newState[hash];
                        if (!newRecord || newRecord.time <= oldRecord.time) {
                            newState[hash] = oldRecord;
                        }
                    }
                    if (!newState[hash]) {
                        if (oldRecord.path) {
                            event("local", "Deleted", oldRecord.path);
                            newState[hash] = {
                                path: null,
                                time: new Date().getTime()
                            };
                        }
                    }
                });
                
                fs.writeFile(stateFilePath, JSON.stringify(newState, null, 4), function(err) {
                    if (err) {
                        event("error", err.message);                           
                    } else {
                        localState = newState;                          
                    }
                    callback();
                });                   
            }
        });

        var ageLimit = new Date();
        ageLimit.setSeconds(ageLimit.getSeconds() - 300);
        ageLimit = ageLimit.getTime();

        scan(mediaPath, worker({
            directory: function(dir, next) {
                next();
            },
            each: function(file, next) {
                if (file.path === stateFilePath) {
                    next();
                    return;
                }

                var relPath = file.path.substr(mediaPath.length), 
                    knownByPath = byPath[relPath], 
                    exisingHash = (knownByPath && knownByPath.time === file.stat.mtime.getTime() && 
                                  knownByPath.size === file.stat.size) && knownByPath.hash;

                if (exisingHash) {
                    hashes({
                        path: relPath,
                        stat: file.stat,
                        hash: exisingHash
                    });
                    next();
                } else {
                    if (file.stat.mtime > ageLimit) {
                        event("local", "File is too new", relPath);
                        next();
                    } else {                    
                        hash(file.path, file.stat, function(err, newHash) {
                            if (err) {
                                event("error", err.message, file.path);
                            } else {
                                hashes({
                                    path: relPath,
                                    stat: file.stat,
                                    hash: newHash
                                });
                            }
                            next();
                        });
                    }
                }   
            },
            end: function(ignored, next) {
                hashes("end", null);
                next();
            }
        }));
    });
}

function getRemoteState(callback) {
    http.get(url.format({
        protocol: "http",
        hostname: config.peer.host,
        port: config.peer.port,
        pathname: "meta/state"
    }), function(res) {
        var chunks = [];
        res.on("data", function(data) {
            chunks.push(data);
        });
        res.on("end", function() {
            callback(null, JSON.parse(Buffer.concat(chunks).toString()));
        });
        res.on("error", function(e) {
            callback(e, null);
        });
    }).on("error", function(e) {
        callback(e, null);
    });
}

function download(file) {
    activity("download", file.remote);
    event("download", file.remote.path, "Queued", 0);
    event("remote", "Scheduled download", file.remote.path);
}

var busy = false, currentMode;

function logModes(obj) {
    return aspect(obj, function(invoke, name) {
        if (currentMode !== name) {
            currentMode = name;
            event("mode", name);
        }   
        invoke();
    });
}

var activity = worker(logModes({
    idle: function() {
        busy = false;
    },
    compare: function(ignored, next) {
        getRemoteState(function(err, remoteState) {
            if (err) {
                event("error", "Failed to get remote state", err.message);
                next();
            } else {
                updateLocalState(function() {
                    Object.keys(remoteState).forEach(function(hash) {   
                        activity({
                            local: localState[hash],
                            remote: remoteState[hash]
                        });
                    });
                    next();
                });
            }
        });
    },
    each: function(file, next) {
        if (!file.local) {
            if (file.remote.path) {
                download(file);
            }
        } else if ((file.remote.path !== file.local.path) && 
                   (file.remote.time > file.local.time)) {
            if (!file.remote.path) {
                event("deletable", file.local.path, true);
            } else if (file.local.path) {                   
                activity("move", { from: file.local.path, to: file.remote.path });                  
            } else {
                download(file);
            }
        }
        next();
    },
    move: function(files, next) {
        try {
            event("remote", "Moved", files.from, files.to);

            var oldPath = path.join(mediaPath, files.from);
            var newPath = path.join(mediaPath, files.to);

            event("deletable", files.to, false);

            makePathTo(newPath);
            fs.renameSync(oldPath, newPath);
            removeEmptyFolders(path.dirname(oldPath));
            
            next();

        } catch(x) {
            event("error", x.message);
        }
    },
    download: function(file, next) {
        var got = 0, lastLog = 0, seconds;
        var started = new Date().getTime();
        var log = function() {
            var percent = (Math.floor((got/file.size)*10000)/100) + "%";
            var info = percent + " " + (Math.floor((got/seconds)/1024)) + "KB/s";
            event("download", file.path, info, percent);
        };
        
        var fullPath = path.join(mediaPath, file.path);
        event("deletable", file.path, false);

        http.get(url.format({
            protocol: "http",
            hostname: config.peer.host,
            port: config.peer.port,
            pathname: "media/" + file.path
        }), function(response) {
            response.on("data", function(data) {
                got += data.length;
                seconds = (new Date().getTime() - started) / 1000;
                var nextLog = Math.floor(seconds);
                if (nextLog != lastLog) {
                    lastLog = nextLog;
                    log();
                }
            });
            
            makePathTo(fullPath);
            response.pipe(fs.createWriteStream(fullPath)).on("finish", function() {
                log();
                event("download", file.path, null);
                event("remote", "Download succeeded", file.path);
                var time = new Date(file.time);
                fs.utimesSync(fullPath, time, time);
                next();
            });
            response.on("error", function(err) {
                event("error", "Will retry download", file.path, err.message);
                activity("download", file);
                next();
            });
        }).on("error", function(err) {
            event("error", "Will retry download", file.path, err.message);
            activity("download", file);
            next();
        });
    }
}));

function matchSchedule(value, pattern) {
    pattern = pattern.trim().split("/").map(function(s) { return s.trim(); });
    
    if (pattern.length === 1) {
        return pattern[0] === "*" || pattern[0] == value;
    }

    if (pattern.length === 2) {
        var divisor = parseInt(pattern[1]);
        return (value / divisor) % 1 === 0;
    }
    
    return false;
}

function compare() {
    if (busy) {
        event("warning", "Still busy, not starting next comparison");
    } else {
        busy = true;        
        activity("compare", null);  
    }
}
    
/*
var scheduleTime = new Date();

function checkSchedule() {
        
    var now = new Date();
    now.setMilliseconds(0);

    while (scheduleTime < now) {
        scheduleTime.setSeconds(scheduleTime.getSeconds() + 1);
        
        if (matchSchedule(scheduleTime.getHours(), config.peer.hour) && 
            matchSchedule(scheduleTime.getMinutes(), config.peer.minute) && 
            matchSchedule(scheduleTime.getSeconds(), config.peer.second)) {

            scheduleTime = now;

            compare();
            break;
        }
    }

    setTimeout(checkSchedule, 1000);
}
*/

event("info", "Reading local state");
updateLocalState(function() {
    event("local", "Ready");
    event("mode", "idle");
});

var app = express();

app.use("/media", express.static(config.media));
app.use(express.static(__dirname + "/static"));

app.post("/meta/compare", function(req, res) {
    compare();
    res.send({});
});

app.post("/meta/delete/*", function(req, res) {
    var fullPath = path.join(mediaPath, req.params[0]);
    fs.unlink(fullPath, function(err) {
        if (err) {
            event("error", "Could not delete file", fullPath, err.message);
            res.send(500, "Could not delete file " + fullPath + " - " + err.message);
        } else {
            event("deletable", req.params[0], false);
            event("user", "Deleted file", fullPath);
            removeEmptyFolders(path.dirname(fullPath));
            res.send({});
        }
    });
});

app.get("/meta/state", function(req, res) {
    if (!localState) {
        res.send(500, "Please wait, scanning media");
    } else {
        res.send(localState);
    }
});

app.get("/meta/events/:after", function(req, res) {
    
    var list = [], count = 0;
    subscribe(true, list);
    collect(req.params.after, list);

    var poll = function() {
        if ((list.length !== 0) || (count >= 10)) {
            subscribe(false, list);
            res.send(list);
            return;
        }
        count++;
        setTimeout(poll, 500);
    };
    poll();
});

app.listen(config.port);
console.log("Listening on port " + config.port);
