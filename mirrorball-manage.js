var Service = require('node-mac').Service;

module.exports = function(args, log) {
    var command = args[0];

    if (command !== 'start' && command != 'stop') {
        
        log('Specify start or stop');
        
    } else {

        var svc = new Service({
            name: 'Mirrorball',
            description: 'The fun way to do something boring!',
            script: __dirname + '/mirrorball.js'
        });

        if (command === 'start') {
            svc.on('install', function(){
                log("Installed successfully");
                svc.start();
            });
    
            svc.on('start', function(){
                log("Started successfully");
            });

            svc.install();
    
        } else {
    
            if (!svc.exists) {
                log("Service does not exist");
            } else {   
                svc.on('uninstall', function(){
                    log("Removed successfully");
                });
                svc.uninstall();
            }
        }
    }    
}
