var fs = require('fs');

var libs = {
    'darwin': 'node-mac',
    'win32': 'node-windows',
    'linux': 'node-linux'
};

var Service = require(libs[process.platform]).Service;

var port = 8888;

module.exports = function(args, log) {

    function sudo(action) {
        try {
            action();
        } catch (x) {
            log('Did you forget sudo?');
        }
    }

    var command = args[0];

    if (command !== 'start' && command != 'stop') {
        
        log('Usage:');
        log('    sudo mirrorball start <dir> <hostname>');
        log('    sudo mirrorball stop');

    } else {

        var svc = new Service({
            name: 'Mirrorball',
            description: 'The fun way to do something boring!',
            script: __dirname + '/mirrorball.js'
        });

        if (command === 'start') {

            if (args.length < 3) {
                log('Specify <dir> <hostname>');
            } else {

                sudo(function() {
                    fs.writeFileSync(
                        __dirname + '/config.json', 
                        JSON.stringify({
                            'default': {
                                port: port,
                                media: args[1],
                                peer: {
                                    'host': port
                                }
                            }
                        }, null, 4)
                    );

                    svc.on('install', function(){
                        log("Installed successfully");
                        svc.start();
                    });

                    svc.on('start', function(){
                        log("Started successfully");
                    });

                    svc.install();
                });
            }

        } else {
    
            if (!svc.exists) {
                log("Service does not exist");
            } else {   
                svc.on('uninstall', function(){
                    log("Removed successfully");
                });
                
                sudo(function() {
                    svc.uninstall();
                });
            }
        }
    }    
}
