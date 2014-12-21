/**
 * Copyright (c) 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * https://raw.github.com/facebook/regenerator/master/LICENSE file. An
 * additional grant of patent rights can be found in the PATENTS file in
 * the same directory.
 */

!(function() {
  var hasOwn = Object.prototype.hasOwnProperty;
  var undefined; // More compressible than void 0.
  var iteratorSymbol =
    typeof Symbol === "function" && Symbol.iterator || "@@iterator";

  if (typeof regeneratorRuntime === "object") {
    return;
  }

  var runtime = regeneratorRuntime =
    typeof exports === "undefined" ? {} : exports;

  function wrap(innerFn, outerFn, self, tryList) {
    return new Generator(innerFn, outerFn, self || null, tryList || []);
  }
  runtime.wrap = wrap;

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}

  var Gp = GeneratorFunctionPrototype.prototype = Generator.prototype;
  GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
  GeneratorFunctionPrototype.constructor = GeneratorFunction;
  GeneratorFunction.displayName = "GeneratorFunction";

  runtime.isGeneratorFunction = function(genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor
      ? ctor === GeneratorFunction ||
        // For the native GeneratorFunction constructor, the best we can
        // do is to check its .name property.
        (ctor.displayName || ctor.name) === "GeneratorFunction"
      : false;
  };

  runtime.mark = function(genFun) {
    genFun.__proto__ = GeneratorFunctionPrototype;
    genFun.prototype = Object.create(Gp);
    return genFun;
  };

  runtime.async = function(innerFn, outerFn, self, tryList) {
    return new Promise(function(resolve, reject) {
      var generator = wrap(innerFn, outerFn, self, tryList);
      var callNext = step.bind(generator.next);
      var callThrow = step.bind(generator["throw"]);

      function step(arg) {
        try {
          var info = this(arg);
          var value = info.value;
        } catch (error) {
          return reject(error);
        }

        if (info.done) {
          resolve(value);
        } else {
          Promise.resolve(value).then(callNext, callThrow);
        }
      }

      callNext();
    });
  };

  function Generator(innerFn, outerFn, self, tryList) {
    var generator = outerFn ? Object.create(outerFn.prototype) : this;
    var context = new Context(tryList);
    var state = GenStateSuspendedStart;

    function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        // Be forgiving, per 25.3.3.3.3 of the spec:
        // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume
        return doneResult();
      }

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          try {
            var info = delegate.iterator[method](arg);

            // Delegate generator ran and handled its own exceptions so
            // regardless of what the method was, we continue as if it is
            // "next" with an undefined arg.
            method = "next";
            arg = undefined;

          } catch (uncaught) {
            context.delegate = null;

            // Like returning generator.throw(uncaught), but without the
            // overhead of an extra function call.
            method = "throw";
            arg = uncaught;

            continue;
          }

          if (info.done) {
            context[delegate.resultName] = info.value;
            context.next = delegate.nextLoc;
          } else {
            state = GenStateSuspendedYield;
            return info;
          }

          context.delegate = null;
        }

        if (method === "next") {
          if (state === GenStateSuspendedStart &&
              typeof arg !== "undefined") {
            // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume
            throw new TypeError(
              "attempt to send " + JSON.stringify(arg) + " to newborn generator"
            );
          }

          if (state === GenStateSuspendedYield) {
            context.sent = arg;
          } else {
            delete context.sent;
          }

        } else if (method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw arg;
          }

          if (context.dispatchException(arg)) {
            // If the dispatched exception was caught by a catch block,
            // then let that catch block handle the exception normally.
            method = "next";
            arg = undefined;
          }

        } else if (method === "return") {
          context.abrupt("return", arg);
        }

        state = GenStateExecuting;

        try {
          var value = innerFn.call(self, context);

          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done
            ? GenStateCompleted
            : GenStateSuspendedYield;

          var info = {
            value: value,
            done: context.done
          };

          if (value === ContinueSentinel) {
            if (context.delegate && method === "next") {
              // Deliberately forget the last sent value so that we don't
              // accidentally pass it on to the delegate.
              arg = undefined;
            }
          } else {
            return info;
          }

        } catch (thrown) {
          state = GenStateCompleted;

          if (method === "next") {
            context.dispatchException(thrown);
          } else {
            arg = thrown;
          }
        }
      }
    }

    generator.next = invoke.bind(generator, "next");
    generator["throw"] = invoke.bind(generator, "throw");
    generator["return"] = invoke.bind(generator, "return");

    return generator;
  }

  Gp[iteratorSymbol] = function() {
    return this;
  };

  Gp.toString = function() {
    return "[object Generator]";
  };

  function pushTryEntry(triple) {
    var entry = { tryLoc: triple[0] };

    if (1 in triple) {
      entry.catchLoc = triple[1];
    }

    if (2 in triple) {
      entry.finallyLoc = triple[2];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry, i) {
    var record = entry.completion || {};
    record.type = i === 0 ? "normal" : "return";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryList.forEach(pushTryEntry, this);
    this.reset();
  }

  runtime.keys = function(object) {
    var keys = [];
    for (var key in object) {
      keys.push(key);
    }
    keys.reverse();

    // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.
    return function next() {
      while (keys.length) {
        var key = keys.pop();
        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      }

      // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.
      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1;

        function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;

          return next;
        }

        return next.next = next;
      }
    }

    // Return an iterator with no values.
    return { next: doneResult };
  }
  runtime.values = values;

  function doneResult() {
    return { value: undefined, done: true };
  }

  Context.prototype = {
    constructor: Context,

    reset: function() {
      this.prev = 0;
      this.next = 0;
      this.sent = undefined;
      this.done = false;
      this.delegate = null;

      this.tryEntries.forEach(resetTryEntry);

      // Pre-initialize at least 20 temporary variables to enable hidden
      // class optimizations for simple generators.
      for (var tempIndex = 0, tempName;
           hasOwn.call(this, tempName = "t" + tempIndex) || tempIndex < 20;
           ++tempIndex) {
        this[tempName] = null;
      }
    },

    stop: function() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    dispatchException: function(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;
        return !!caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }

          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    _findFinallyEntry: function(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev &&
            hasOwn.call(entry, "finallyLoc") && (
              (entry.finallyLoc === finallyLoc || this.prev < entry.finallyLoc))) {
          return entry;
        }
      }
    },

    abrupt: function(type, arg) {
      var entry = this._findFinallyEntry();
      var record = entry ? entry.completion : {};

      record.type = type;
      record.arg = arg;

      if (entry) {
        this.next = entry.finallyLoc;
      } else {
        this.complete(record);
      }

      return ContinueSentinel;
    },

    complete: function(record) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" ||
          record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = record.arg;
        this.next = "end";
      }

      return ContinueSentinel;
    },

    finish: function(finallyLoc) {
      var entry = this._findFinallyEntry(finallyLoc);
      return this.complete(entry.completion);
    },

    "catch": function(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry, i);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      return ContinueSentinel;
    }
  };
})();

var hash = regeneratorRuntime.mark(function hash(filePath, fileStat) {
    var sampleSize, fileHandle, sampleBuffer, hash;

    return regeneratorRuntime.wrap(function hash$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            sampleSize = Math.min(maxSampleSize, fileStat.size);

            if (!(sampleSize === 0)) {
                context$1$0.next = 3;
                break;
            }

            return context$1$0.abrupt("return", '');
        case 3:
            context$1$0.next = 5;
            return fs.open(filePath, "r");
        case 5:
            fileHandle = context$1$0.sent;
            context$1$0.prev = 6;
            sampleBuffer = new Buffer(sampleSize);
            context$1$0.next = 10;
            return fs.read(fileHandle, sampleBuffer, 0, sampleSize, fileStat.size - sampleSize);
        case 10:
            hash = crypto.createHash("sha512");
            hash.update(sampleBuffer);

            if (!(fileStat.size > sampleSize * 2)) {
                context$1$0.next = 16;
                break;
            }

            context$1$0.next = 15;
            return fs.read(fileHandle, sampleBuffer, 0, sampleSize, 0);
        case 15:
            hash.update(sampleBuffer);
        case 16:
            return context$1$0.abrupt("return", hash.digest("base64"));
        case 17:
            context$1$0.prev = 17;
            context$1$0.next = 20;
            return fs.close(fileHandle);
        case 20:
            context$1$0.finish(17);
        case 21:
        case "end":
            return context$1$0.stop();
        }
    }, hash, this, [[6,, 17]]);
});

var makePathTo = regeneratorRuntime.mark(function makePathTo(fileOrDir) {
    var dirName;

    return regeneratorRuntime.wrap(function makePathTo$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            dirName = path.dirname(fileOrDir);
            context$1$0.prev = 1;
            context$1$0.next = 4;
            return fs.stat(dirName);
        case 4:
            context$1$0.next = 12;
            break;
        case 6:
            context$1$0.prev = 6;
            context$1$0.t3 = context$1$0["catch"](1);
            return context$1$0.delegateYield(makePathTo(dirName), "t4", 9);
        case 9:
            console.log("Creating folder: " + dirName);
            context$1$0.next = 12;
            return fs.mkdir(dirName);
        case 12:
        case "end":
            return context$1$0.stop();
        }
    }, makePathTo, this, [[1, 6]]);
});

var removeEmptyFolders = regeneratorRuntime.mark(function removeEmptyFolders(folder) {
    return regeneratorRuntime.wrap(function removeEmptyFolders$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            context$1$0.prev = 0;
            context$1$0.next = 3;
            return fs.readdir(folder).length;
        case 3:
            if (!context$1$0.sent) {
                context$1$0.next = 5;
                break;
            }

            return context$1$0.abrupt("return");
        case 5:
            console.log("Removing empty folder: " + folder);
            context$1$0.next = 8;
            return fs.rmdir(folder);
        case 8:
            return context$1$0.delegateYield(removeEmptyFolders(path.dirname(folder)), "t5", 9);
        case 9:
            context$1$0.next = 13;
            break;
        case 11:
            context$1$0.prev = 11;
            context$1$0.t6 = context$1$0["catch"](0);
        case 13:
        case "end":
            return context$1$0.stop();
        }
    }, removeEmptyFolders, this, [[0, 11]]);
});

var deleteFile = regeneratorRuntime.mark(function deleteFile(filePath) {
    return regeneratorRuntime.wrap(function deleteFile$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            console.log('Deleting file: ' + filePath);
            context$1$0.next = 3;
            return fs.unlink(filePath);
        case 3:
            context$1$0.next = 5;
            return removeEmptyFolders(path.dirname(filePath));
        case 5:
        case "end":
            return context$1$0.stop();
        }
    }, deleteFile, this);
});

var renameFile = regeneratorRuntime.mark(function renameFile(oldName, newName) {
    return regeneratorRuntime.wrap(function renameFile$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            return context$1$0.delegateYield(makePathTo(newName), "t7", 1);
        case 1:
            context$1$0.next = 3;
            return fs.rename(oldName, newName);
        case 3:
            return context$1$0.delegateYield(removeEmptyFolders(path.dirname(oldName)), "t8", 4);
        case 4:
        case "end":
            return context$1$0.stop();
        }
    }, renameFile, this);
});

var scanFolder = regeneratorRuntime.mark(function scanFolder(p, each) {
    var s, ar, n, child;

    return regeneratorRuntime.wrap(function scanFolder$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            context$1$0.prev = 0;
            context$1$0.next = 3;
            return fs.stat(p);
        case 3:
            s = context$1$0.sent;

            if (!s.isDirectory()) {
                context$1$0.next = 18;
                break;
            }

            context$1$0.next = 7;
            return fs.readdir(p);
        case 7:
            ar = context$1$0.sent;
            n = 0;
        case 9:
            if (!(n < ar.length)) {
                context$1$0.next = 16;
                break;
            }

            child = ar[n];

            if (!(child[0] !== ".")) {
                context$1$0.next = 13;
                break;
            }

            return context$1$0.delegateYield(scanFolder(path.join(p, child), each), "t9", 13);
        case 13:
            n++;
            context$1$0.next = 9;
            break;
        case 16:
            context$1$0.next = 19;
            break;
        case 18:
            return context$1$0.delegateYield(each(p, s), "t10", 19);
        case 19:
            context$1$0.next = 24;
            break;
        case 21:
            context$1$0.prev = 21;
            context$1$0.t11 = context$1$0["catch"](0);
            console.error(context$1$0.t11);
        case 24:
        case "end":
            return context$1$0.stop();
        }
    }, scanFolder, this, [[0, 21]]);
});

var fetchState = regeneratorRuntime.mark(function fetchState(folderPath) {
    var stateFilePath, state, byPath, newState;

    return regeneratorRuntime.wrap(function fetchState$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            console.log("Reading state of " + folderPath);

            stateFilePath = path.join(folderPath, stateFileName), state = {}, byPath = {}, newState = {};
            context$1$0.prev = 2;
            context$1$0.next = 5;
            return fs.readFile(stateFilePath, { encoding: "utf8" });
        case 5:
            context$1$0.t13 = context$1$0.sent;
            state = JSON.parse(context$1$0.t13);
            context$1$0.next = 11;
            break;
        case 9:
            context$1$0.prev = 9;
            context$1$0.t14 = context$1$0["catch"](2);
        case 11:
            Object.keys(state).forEach(function (hash) {
                var rec = Object.create(state[hash]);
                rec.hash = hash;
                byPath[rec.path] = rec;
            });

            return context$1$0.delegateYield(
                scanFolder(folderPath, regeneratorRuntime.mark(function callee$1$0(filePath, fileStat) {
                    var fileSuffix, rec, fileTime, fileHash, clash;

                    return regeneratorRuntime.wrap(function callee$1$0$(context$2$0) {
                        while (1) switch (context$2$0.prev = context$2$0.next) {
                        case 0:
                            fileSuffix = filePath.substr(folderPath.length), rec = byPath[fileSuffix], fileTime = fileStat.mtime.getTime();

                            if (!(!rec || fileTime != rec.time)) {
                                context$2$0.next = 9;
                                break;
                            }

                            console.log('Computing hash for: ' + filePath);
                            return context$2$0.delegateYield(hash(filePath, fileStat), "t12", 4);
                        case 4:
                            fileHash = context$2$0.t12;
                            clash = newState[fileHash];
                            if (clash) {
                                console.log("Identical hashes: '" + fileSuffix + "' and '" + clash.path + "'");
                            } else {
                                newState[fileHash] = {
                                    path: fileSuffix,
                                    time: fileTime,
                                    size: fileStat.size
                                };
                            }
                            context$2$0.next = 10;
                            break;
                        case 9:
                            newState[rec.hash] = {
                                path: fileSuffix,
                                time: rec.time,
                                size: fileStat.size
                            };
                        case 10:
                        case "end":
                            return context$2$0.stop();
                        }
                    }, callee$1$0, this);
                })),
                "t15",
                13
            );
        case 13:
            context$1$0.next = 15;
            return fs.writeFile(stateFilePath, JSON.stringify(newState));
        case 15:
            return context$1$0.abrupt("return", newState);
        case 16:
        case "end":
            return context$1$0.stop();
        }
    }, fetchState, this, [[2, 9]]);
});

var copyFile = regeneratorRuntime.mark(function copyFile(fromPath, toPath) {
    var fileSize, bufferSize, buffer, progress, got;

    return regeneratorRuntime.wrap(function copyFile$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            console.log("Copying from '" + fromPath + "' to '" + toPath);
            return context$1$0.delegateYield(makePathTo(toPath), "t16", 2);
        case 2:
            context$1$0.next = 4;
            return fs.stat(fromPath);
        case 4:
            fileSize = context$1$0.sent.size;
            bufferSize = Math.min(0x10000, fileSize);
            buffer = new Buffer(bufferSize);
            progress = makeProgress(fileSize);
            h = [ fs.open(fromPath, "r"), 
                  fs.open(toPath, "w") ];
            context$1$0.prev = 9;
            context$1$0.next = 12;
            return h;
        case 12:
            h = context$1$0.sent;
        case 13:
            context$1$0.next = 15;
            return fs.read(h[0], buffer, 0, bufferSize, null);
        case 15:
            got = context$1$0.sent[0];

            if (!(got <= 0)) {
                context$1$0.next = 18;
                break;
            }

            return context$1$0.abrupt("break", 23);
        case 18:
            context$1$0.next = 20;
            return fs.write(h[1], buffer, 0, got, null);
        case 20:
            progress(got);
        case 21:
            context$1$0.next = 13;
            break;
        case 23:
            progress(null);
        case 24:
            context$1$0.prev = 24;
            context$1$0.next = 27;

            return ay(h).forEach(regeneratorRuntime.mark(function callee$1$0(handle) {
                return regeneratorRuntime.wrap(function callee$1$0$(context$2$0) {
                    while (1) switch (context$2$0.prev = context$2$0.next) {
                    case 0:
                        context$2$0.next = 2;
                        return fs.close(handle);
                    case 2:
                    case "end":
                        return context$2$0.stop();
                    }
                }, callee$1$0, this);
            }));
        case 27:
            context$1$0.finish(24);
        case 28:
        case "end":
            return context$1$0.stop();
        }
    }, copyFile, this, [[9,, 24]]);
});

var pickOne = regeneratorRuntime.mark(function pickOne(prompt, options) {
    var o;

    return regeneratorRuntime.wrap(function pickOne$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            options.forEach(function (option, i) {
                console.log("[" + (i + 1) + "] " + option.caption);
            });
        case 1:
            console.log(prompt);
            context$1$0.next = 4;
            return readInput();
        case 4:
            context$1$0.t17 = context$1$0.sent;
            context$1$0.t18 = parseInt(context$1$0.t17, 10);
            context$1$0.t19 = context$1$0.t18 - 1;
            o = options[context$1$0.t19];

            if (!o) {
                context$1$0.next = 10;
                break;
            }

            return context$1$0.abrupt("return", o.value);
        case 10:
            context$1$0.next = 1;
            break;
        case 12:
        case "end":
            return context$1$0.stop();
        }
    }, pickOne, this);
});

var mirror = regeneratorRuntime.mark(function mirror(folderPaths) {
    var states, extras, hash, first, second, choice, byPath, c, extra, clash, i;

    return regeneratorRuntime.wrap(function mirror$(context$1$0) {
        while (1) switch (context$1$0.prev = context$1$0.next) {
        case 0:
            context$1$0.next = 2;
            return folderPaths.map(fetchState);
        case 2:
            states = context$1$0.sent;
            extras = [];
            context$1$0.t22 = regeneratorRuntime.keys(states[0]);
        case 5:
            if ((context$1$0.t23 = context$1$0.t22()).done) {
                context$1$0.next = 19;
                break;
            }

            hash = context$1$0.t23.value;
            first = states[0][hash], second = states[1][hash];

            if (second) {
                context$1$0.next = 12;
                break;
            }

            extras.push({
                from: folderPaths[0],
                to: folderPaths[1],
                path: first.path,
                size: first.size
            });
            context$1$0.next = 17;
            break;
        case 12:
            if (!(first.path != second.path)) {
                context$1$0.next = 17;
                break;
            }

            console.log("Same file, different paths:");

            return context$1$0.delegateYield(pickOne("Which name is correct?", [ {
                caption: first.path,
                value: regeneratorRuntime.mark(function callee$1$0() {
                    return regeneratorRuntime.wrap(function callee$1$0$(context$2$0) {
                        while (1) switch (context$2$0.prev = context$2$0.next) {
                        case 0:
                            return context$2$0.delegateYield(
                                renameFile(folderPaths[1] + second.path, folderPaths[1] + first.path),
                                "t20",
                                1
                            );
                        case 1:
                        case "end":
                            return context$2$0.stop();
                        }
                    }, callee$1$0, this);
                })
            }, {
                caption: second.path,
                value: regeneratorRuntime.mark(function callee$1$1() {
                    return regeneratorRuntime.wrap(function callee$1$1$(context$2$0) {
                        while (1) switch (context$2$0.prev = context$2$0.next) {
                        case 0:
                            return context$2$0.delegateYield(
                                renameFile(folderPaths[0] + first.path, folderPaths[0] + second.path),
                                "t21",
                                1
                            );
                        case 1:
                        case "end":
                            return context$2$0.stop();
                        }
                    }, callee$1$1, this);
                })
            } ]), "t24", 15);
        case 15:
            choice = context$1$0.t24;
            return context$1$0.delegateYield(choice(), "t25", 17);
        case 17:
            context$1$0.next = 5;
            break;
        case 19:
            for (hash in states[1]) {
                first = states[0][hash], second = states[1][hash];
                if (!first) {
                    extras.push({
                        from: folderPaths[1],
                        to: folderPaths[0],
                        path: second.path,
                        size: second.size
                    });
                }
            }

            if (!(extras.length === 0)) {
                context$1$0.next = 23;
                break;
            }

            console.log("All good.");
            return context$1$0.abrupt("return");
        case 23:
            byPath = {};
            c = 0;
        case 25:
            if (!(c < extras.length)) {
                context$1$0.next = 38;
                break;
            }

            extra = extras[c], clash = byPath[extra.path];

            if (!clash) {
                context$1$0.next = 34;
                break;
            }

            console.log("Same path, different contents: " + extra.path);

            return context$1$0.delegateYield(pickOne("Which one should be marked for deletion?", [ {
                caption: clash.from + " - size: " + formatFileSize(clash.size),
                value: clash
            }, {
                caption: extra.from + " - size: " + formatFileSize(extra.size),
                value: extra
            } ]), "t26", 30);
        case 30:
            choice = context$1$0.t26;
            choice.kill = true;
            context$1$0.next = 35;
            break;
        case 34:
            byPath[extra.path] = extra;
        case 35:
            c++;
            context$1$0.next = 25;
            break;
        case 38:
            console.log("Extra files:");
            extras.forEach(function(extra, i) {            
                console.log(i + ". " + (extra.kill ? "[DELETING] " : "") + extra.from + extra.path);
            });
            console.log("Enter file number(s) to toggle deletion, or S to start:");

            context$1$0.next = 43;
            return readInput();
        case 43:
            i = context$1$0.sent;

            if (!(i.toLowerCase() === 's')) {
                context$1$0.next = 46;
                break;
            }

            return context$1$0.abrupt("break", 49);
        case 46:
            i.split(' ').forEach(function(number) {
                var extra = extras[number];
                if (extra) {
                    extra.kill = !extra.kill;
                }    
            });
        case 47:
            context$1$0.next = 38;
            break;
        case 49:
            c = 0;
        case 50:
            if (!(c < extras.length)) {
                context$1$0.next = 60;
                break;
            }

            extra = extras[c];

            if (!extra.kill) {
                context$1$0.next = 56;
                break;
            }

            return context$1$0.delegateYield(deleteFile(extra.from + extra.path), "t27", 54);
        case 54:
            context$1$0.next = 57;
            break;
        case 56:
            return context$1$0.delegateYield(copyFile(extra.from + extra.path, extra.to + extra.path), "t28", 57);
        case 57:
            c++;
            context$1$0.next = 50;
            break;
        case 60:
        case "end":
            return context$1$0.stop();
        }
    }, mirror, this);
});

var funkify = require("funkify");
var fs = funkify(require("fs"));
var path = require("path");
var co = require("co");

// var ay = require("ay");

var ay = (function() {
    
    var co = require('co');

    var prototype = {
        map: function(gen, thisArg ) {
            var self = this;
            return ay(regeneratorRuntime.mark(function callee$2$0() {
                var ar, len, result, i;

                return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
                    while (1) switch (context$3$0.prev = context$3$0.next) {
                    case 0:
                        context$3$0.next = 2;
                        return self.generate();
                    case 2:
                        ar = context$3$0.sent;
                        len = ar.length >>> 0;
                        result = new Array(len);
                        i = 0;
                    case 6:
                        if (!(i < len)) {
                            context$3$0.next = 14;
                            break;
                        }

                        if (!(i in ar)) {
                            context$3$0.next = 11;
                            break;
                        }

                        context$3$0.next = 10;
                        return gen.call(thisArg, ar[i], i, ar);
                    case 10:
                        result[i] = context$3$0.sent;
                    case 11:
                        i++;
                        context$3$0.next = 6;
                        break;
                    case 14:
                        return context$3$0.abrupt("return", result);
                    case 15:
                    case "end":
                        return context$3$0.stop();
                    }
                }, callee$2$0, this);
            }));
        },
        filter: function(gen, thisArg) {
            var self = this;
            return ay(regeneratorRuntime.mark(function callee$2$0() {
                var ar, len, result, i;

                return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
                    while (1) switch (context$3$0.prev = context$3$0.next) {
                    case 0:
                        context$3$0.next = 2;
                        return self.generate();
                    case 2:
                        ar = context$3$0.sent;
                        len = ar.length >>> 0;
                        result = [];
                        i = 0;
                    case 6:
                        if (!(i < len)) {
                            context$3$0.next = 17;
                            break;
                        }

                        context$3$0.t0 = i in ar;

                        if (!context$3$0.t0) {
                            context$3$0.next = 12;
                            break;
                        }

                        context$3$0.next = 11;
                        return gen.call(thisArg, ar[i], i, ar);
                    case 11:
                        context$3$0.t0 = context$3$0.sent;
                    case 12:
                        if (!context$3$0.t0) {
                            context$3$0.next = 14;
                            break;
                        }

                        result.push(ar[i]);
                    case 14:
                        i++;
                        context$3$0.next = 6;
                        break;
                    case 17:
                        return context$3$0.abrupt("return", result);
                    case 18:
                    case "end":
                        return context$3$0.stop();
                    }
                }, callee$2$0, this);
            }));
        },
        reduce: function(gen, init) {
            var self = this;
            return ay(regeneratorRuntime.mark(function callee$2$0() {
                var ar, len, k, value;

                return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
                    while (1) switch (context$3$0.prev = context$3$0.next) {
                    case 0:
                        context$3$0.next = 2;
                        return self.generate();
                    case 2:
                        ar = context$3$0.sent;
                        len = ar.length >>> 0;
                        k = 0;

                        if (!(init !== undefined)) {
                            context$3$0.next = 9;
                            break;
                        }

                        value = init;
                        context$3$0.next = 13;
                        break;
                    case 9:
                        while (k < len && !(k in ar)) k++;

                        if (!(k >= len)) {
                            context$3$0.next = 12;
                            break;
                        }

                        throw new TypeError('Reduce of empty array with no initial value');
                    case 12:
                        value = ar[k++];
                    case 13:
                        if (!(k < len)) {
                            context$3$0.next = 21;
                            break;
                        }

                        if (!(k in ar)) {
                            context$3$0.next = 18;
                            break;
                        }

                        context$3$0.next = 17;
                        return gen(value, ar[k], k, ar);
                    case 17:
                        value = context$3$0.sent;
                    case 18:
                        k++;
                        context$3$0.next = 13;
                        break;
                    case 21:
                        return context$3$0.abrupt("return", value);
                    case 22:
                    case "end":
                        return context$3$0.stop();
                    }
                }, callee$2$0, this);
            }));
        },
        reduceRight: function(gen, init) {
            var self = this;
            return ay(regeneratorRuntime.mark(function callee$2$0() {
                var ar, len, k, value;

                return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
                    while (1) switch (context$3$0.prev = context$3$0.next) {
                    case 0:
                        context$3$0.next = 2;
                        return self.generate();
                    case 2:
                        ar = context$3$0.sent;
                        len = ar.length >>> 0;
                        k = len - 1;

                        if (!(init !== undefined)) {
                            context$3$0.next = 9;
                            break;
                        }

                        value = init;
                        context$3$0.next = 13;
                        break;
                    case 9:
                        while (k >= 0 && !(k in ar )) k--;

                        if (!(k < 0)) {
                            context$3$0.next = 12;
                            break;
                        }

                        throw new TypeError('Reduce of empty array with no initial value');
                    case 12:
                        value = ar[k--];
                    case 13:
                        if (!(k >= 0)) {
                            context$3$0.next = 21;
                            break;
                        }

                        if (!(k in ar)) {
                            context$3$0.next = 18;
                            break;
                        }

                        context$3$0.next = 17;
                        return gen(value, ar[k], k, ar);
                    case 17:
                        value = context$3$0.sent;
                    case 18:
                        k--;
                        context$3$0.next = 13;
                        break;
                    case 21:
                        return context$3$0.abrupt("return", value);
                    case 22:
                    case "end":
                        return context$3$0.stop();
                    }
                }, callee$2$0, this);
            }));
        },
        every: function(gen, thisArg) {
            var self = this;
            return ay(regeneratorRuntime.mark(function callee$2$0() {
                var ar, len, i;

                return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
                    while (1) switch (context$3$0.prev = context$3$0.next) {
                    case 0:
                        context$3$0.next = 2;
                        return self.generate();
                    case 2:
                        ar = context$3$0.sent;
                        len = ar.length >>> 0;
                        i = 0;
                    case 5:
                        if (!(i < len)) {
                            context$3$0.next = 16;
                            break;
                        }

                        context$3$0.t1 = i in ar;

                        if (!context$3$0.t1) {
                            context$3$0.next = 11;
                            break;
                        }

                        context$3$0.next = 10;
                        return gen.call(thisArg, ar[i], i, ar);
                    case 10:
                        context$3$0.t1 = !context$3$0.sent;
                    case 11:
                        if (!context$3$0.t1) {
                            context$3$0.next = 13;
                            break;
                        }

                        return context$3$0.abrupt("return", false);
                    case 13:
                        i++;
                        context$3$0.next = 5;
                        break;
                    case 16:
                        return context$3$0.abrupt("return", true);
                    case 17:
                    case "end":
                        return context$3$0.stop();
                    }
                }, callee$2$0, this);
            }));
        },
        some: function(gen, thisArg) {
            var self = this;
            return ay(regeneratorRuntime.mark(function callee$2$0() {
                var ar, len, i;

                return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
                    while (1) switch (context$3$0.prev = context$3$0.next) {
                    case 0:
                        context$3$0.next = 2;
                        return self.generate();
                    case 2:
                        ar = context$3$0.sent;
                        len = ar.length >>> 0;
                        i = 0;
                    case 5:
                        if (!(i < len)) {
                            context$3$0.next = 16;
                            break;
                        }

                        context$3$0.t2 = i in ar;

                        if (!context$3$0.t2) {
                            context$3$0.next = 11;
                            break;
                        }

                        context$3$0.next = 10;
                        return gen.call(thisArg, ar[i], i, ar);
                    case 10:
                        context$3$0.t2 = context$3$0.sent;
                    case 11:
                        if (!context$3$0.t2) {
                            context$3$0.next = 13;
                            break;
                        }

                        return context$3$0.abrupt("return", true);
                    case 13:
                        i++;
                        context$3$0.next = 5;
                        break;
                    case 16:
                        return context$3$0.abrupt("return", false);
                    case 17:
                    case "end":
                        return context$3$0.stop();
                    }
                }, callee$2$0, this);
            }));
        },
        forEach: function(gen, thisArg) {
            var self = this;
            return ay(regeneratorRuntime.mark(function callee$2$0() {
                var ar, len, i;

                return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
                    while (1) switch (context$3$0.prev = context$3$0.next) {
                    case 0:
                        context$3$0.next = 2;
                        return self.generate();
                    case 2:
                        ar = context$3$0.sent;
                        len = ar.length >>> 0;
                        i = 0;
                    case 5:
                        if (!(i < len)) {
                            context$3$0.next = 12;
                            break;
                        }

                        if (!(i in ar)) {
                            context$3$0.next = 9;
                            break;
                        }

                        context$3$0.next = 9;
                        return gen.call(thisArg, ar[i], i, ar);
                    case 9:
                        i++;
                        context$3$0.next = 5;
                        break;
                    case 12:
                    case "end":
                        return context$3$0.stop();
                    }
                }, callee$2$0, this);
            }));
        },
        then: function(done, fail) {
            co(this.generate())(function(err, val) {
                if (err) {
                    fail(err);
                } else {
                    done(val);
                }
            });
        }
    };

    return function(g) {
        if (typeof g !== 'function') {
            g = g === void 0 ? [] : Array.isArray(g) ? g : [g];
            return ay(regeneratorRuntime.mark(function callee$2$0() {
                return regeneratorRuntime.wrap(function callee$2$0$(context$3$0) {
                    while (1) switch (context$3$0.prev = context$3$0.next) {
                    case 0:
                        return context$3$0.abrupt("return", g);
                    case 1:
                    case "end":
                        return context$3$0.stop();
                    }
                }, callee$2$0, this);
            }));
        }
        return Object.create(prototype, {
            generate: { value: g }
        });
    };
    
})();


var crypto = require("crypto");

var maxSampleSize = 0x100000;

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

function formatFileSize(size) {
    var units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    var unit = 0;
    while (size > 1024) {
        unit++;
        size /= 1024;
    }
    return (Math.round(size * 100) / 100) + " " + units[unit];
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
