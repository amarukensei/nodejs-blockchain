const { startServer } = require('./src/app');
const nodes = require('./config/nodes.json');

// Create an instance per node in the list to mimic distributed and decentralized nodes
nodes.forEach( node => {
    let idx = node.lastIndexOf('//');
    let idx2 = node.lastIndexOf(':');
    let url = node.substring(idx+2, idx2);
    let port = node.substring(idx2+1);

    startServer(url, port)
        .then(function(listener) {
            console.log('Server started at ' + listener.address().address + ':' + listener.address().port);
        })
        .catch(function(error) {
            console.error('Failed to start the node at ' + node, error);
            process.exit(1);
        });
});
