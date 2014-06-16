var crypto = require("crypto");
var fs = require("fs");

var maxSampleSize = 0x100000;

module.exports = function(filePath, fileStat, callback) {
    
    var sampleSize = Math.min(maxSampleSize, fileStat.size);
    if (sampleSize === 0) {
        callback(null, "");
        return;
    }
    
    fs.open(filePath, "r", function(err, fileHandle) {
        if (err) {
            callback(err, null);
        } else {
            function close(err, val) {
                try {
                    fs.closeSync(fileHandle);
                } catch (x) { }
                callback(err, val);
            }
            function success(handler) {
                return function(err, val) {
                    if (err) {
                        close(err, null);
                    } else {
                        handler(val);
                    }
                };
            }
            
            var sampleBuffer = new Buffer(sampleSize);
            fs.read(fileHandle, sampleBuffer, 0, sampleSize, fileStat.size - sampleSize, success(function(data) {

                var hash = crypto.createHash("sha512");
                hash.update(sampleBuffer);

                if (fileStat.size > sampleSize * 2) {
                    fs.read(fileHandle, sampleBuffer, 0, sampleSize, 0, success(function(data) {
                        hash.update(sampleBuffer);
                        close(null, hash.digest("base64"));
                    }));
                } else {
                    close(null, hash.digest("base64"));
                }
            }));
        }
    });
};
