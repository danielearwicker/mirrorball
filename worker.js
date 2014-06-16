module.exports = function(handlers) {

    if (typeof handlers === "function") {
        handlers = { each: handlers };
    }

    var waiting = [], idle = true, end = {};

    var next = function() {
        setImmediate(function() {
            if (waiting.length === 0) {
                idle = true;
                if (handlers.idle) {
                    handlers.idle();
                }
            } else {
                idle = false;
                var item = waiting.pop();
                var handler = handlers[item.kind];
                if (handler) {
                    handler(item.val, next);
                } else {
                    var other = handlers.other;
                    if (other) {
                        other(item.kind, item.val, next);
                    } else {
                        throw new Error("No handler for: " + item.kind);
                    }
                }
            }   
        });
    };

    return function(kind, val, otherQueueNext) {
        if (arguments.length === 1) {
            val = kind;
            kind = "each";
        }
        if (kind === "other" || kind === "idle") {
            throw new Error("'other' and 'idle' are reserved");
        }
        
        if (!handlers[kind] && !handlers.other) {
            throw new Error("No handler for: " + kind);
        }
        
        waiting.unshift({ kind: kind, val: val });
        if (idle) {
            next();
        }
        if (otherQueueNext) {
            otherQueueNext();
        }
    }
};
