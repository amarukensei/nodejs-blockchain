const { startServer } = require('./src/app');

// Load env vars
const url = process.env.URL || '127.0.0.1';
const port = process.env.PORT || 4000;

startServer(url, port)
    .then(function(listener) {
        console.log('Server started at ' + listener.address().address + ':' + listener.address().port);

        // Ctrl+C stops mining and the server, and the node ends once it has saved its chain. A second
        // Ctrl+C ends it at once.
        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.once(signal, function() {
                console.log('Stopping the node at ' + url + ':' + port);
                listener.close();
            });
        }
    })
    .catch(function(error) {
        console.error('Failed to start the node at ' + url + ':' + port, error);
        process.exit(1);
    });
