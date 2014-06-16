var fs = require("fs");
var path = require("path");
var worker = require("./worker.js");

module.exports = function(dir, output) {

    var paths = worker({
        each: function(p, next) {
            fs.lstat(p, function(err, s) {
                if (s) {
                    if (s.isDirectory) {
                        if (s.isDirectory()) {
                            output("directory", p);
                            fs.readdir(p, function(err, contents) {
                                if (contents) {
                                    contents.forEach(function(child) {
                                        if (child[0] !== ".") {
                                            paths(path.join(p, child));
                                        }
                                    });
                                }
                                next();
                            });
                        } else {
                            output({ path: p, stat: s });
                            next();
                        }
                    }
                } else {
                    console.error(s);
                }
            });
        },
        idle: function() {
            output('end', null);
        }
    });

    paths(dir);
};
