const fetch = require('node-fetch');
const Blockchain = require('./blockchain');

class Nodes {
    constructor(url, port) {
        const nodes = require(process.env.NODE_ENV=='production' ? '../../config/nodes.prod.json' : '../../config/nodes.json');
        const currentURL = url + ':' + port;
        this.list = [];

        for(let i in nodes)
            if (nodes[i].indexOf(currentURL) == -1)
                this.list.push(nodes[i]);
    }

    resolve(res, blockchain) {
        let completed = 0;
        let nNodes = this.list.length;
        let response = [];
        let errorCount = 0;

        this.list.forEach(function(node) {
            fetch(node + '/blockchain')
                .then(function(resp) {
                    return resp.json();
                })
                .then(function(respBlockchain) {
                    if (blockchain.blocks.length < respBlockchain.length) {
                        blockchain.updateBlocks(respBlockchain);
                        response.push({synced: node});
                    } else {
                        response.push({noaction: node});
                    }
                    
                    if (++completed == nNodes) {
                        if (errorCount == nNodes)
                            res.status(500);
                        res.send(response);
                    }
                })
                .catch(function(error) { 
                    ++errorCount;
                    //response.push({error: 'Failed to reach node at ' + node})
                    response.push({error: error.message})
                    if (++completed == nNodes) {
                        if (errorCount == nNodes)
                            res.status(500);
                        res.send(response);
                    }
                });
        });
    }

    broadcast() {
        this.list.forEach(function(node) {
            fetch(node + '/resolve')
                .then(function(resp) {
                    return resp.json();
                })
                .then(function(resp) {
                    console.log(node, resp)
                })
                .catch(function(error) { 
                    console.log(node, error);
                });
        });
    }
}

module.exports = Nodes;