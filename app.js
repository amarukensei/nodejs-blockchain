const { startServer } = require('./src/app');

// Load env vars
const url = process.env.URL || '0.0.0.0';
const port = process.env.PORT || 4000;

startServer(url, port)
    .then(function(listener) {
        console.log('Server started at ' + listener.address().address + ':' + listener.address().port);
    })
    .catch(function(error) {
        console.error('Failed to start the node at ' + url + ':' + port, error);
        process.exit(1);
    });
