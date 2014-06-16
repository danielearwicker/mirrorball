
var viewModel = {
    logged: ko.observableArray(),
    downloading: ko.observableArray(),
    deletable: ko.observableArray(),
    mode: ko.observable("stopped")
};

viewModel.downloadingSummary = ko.computed(function() {
    var real = viewModel.downloading();
    var summary = real.slice(0, 10);
    if (real.length > summary.length) {
        summary.push({
            path: "And " + (real.length - summary.length) + " more",
            time: "",
            info: "",
            percent: "0%"
        })
    }
    return summary;
});

function createLogEntry(evt) {
    
    var time = new Date(evt.time);
    time = time.getFullYear() + "-" + 
             (time.getMonth() + 1) + "-" + 
              time.getDate() + " " + 
              time.getHours() + ":" + 
              time.getMinutes() + ":" + 
              time.getSeconds();

    if (evt.kind === "mode") {
        viewModel.mode(evt.message);
        return;
    }
    
    if (evt.kind === "download") {
        var existing;
        viewModel.downloading().some(function(d) {
            return existing = (d.path === evt.message) && d;
        });
        var info = evt.rest[0], percent = evt.rest[1];
        if (info === null) {
            viewModel.downloading.remove(existing);
        } else {
            if (existing) {
                existing.info(info);
                existing.percent(percent);
            } else {
                viewModel.downloading.push({
                    path: evt.message,
                    time: time,
                    info: ko.observable(info),
                    percent: ko.observable(percent)
                });
            }
        }
        return;
    }
    
    if (evt.kind === "deletable") {
        var existing;
        viewModel.deletable().some(function(d) {
            return existing = (d.path === evt.message) && d;
        });
        if (evt.rest[0]) {
            if (!existing) {
                viewModel.deletable.push({
                    path: evt.message,
                    time: time,
                    selected: ko.observable(true)
                });
            }
        } else {
            viewModel.deletable.remove(existing);
        }
        return;
    }
    
    evt.info = evt.rest.join(" ");
    evt.time = time;
    while (viewModel.logged().length > 500) {
        viewModel.logged.pop();
    }
    viewModel.logged.unshift(evt);
};

viewModel.canDelete = ko.computed(function() {
    return viewModel.deletable().some(function(d) {
        return d.selected();
    });
});

viewModel.deleteSelected = function() {
    viewModel.deletable().slice().forEach(function(d) {
        if (d.selected()) {
            $.post('meta/delete/' + d.path);
        }
    });
};

viewModel.compareNow = function() {
    $.post('meta/compare');
};

var lastEventIndex = 0;

function getEvents() {
    $.get('meta/events/' + lastEventIndex).done(function(events) {
        
        events.forEach(function(evt) {
            lastEventIndex = evt.index;
            createLogEntry(evt);            
        });

        getEvents();
    });
}

$(function() {
    ko.applyBindings(viewModel);
    getEvents();
});
