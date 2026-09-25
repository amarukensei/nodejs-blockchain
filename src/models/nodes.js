const PEER_TIMEOUT_MS = 10 * 1000;
const MAX_PEER_RESPONSE_BYTES = 50 * 1024 * 1024;
// How many of the last blocks of its chain a node asks the others for: chains usually fork near
// their end, so the blocks before are the same
const RECENT_BLOCKS = 10;

// Requests JSON from another node. Redirects are not followed and the request is
// aborted if it takes too long or the response grows beyond MAX_PEER_RESPONSE_BYTES.
async function fetchJson(url, options = {}) {
    const resp = await fetch(url, {...options, signal: AbortSignal.timeout(PEER_TIMEOUT_MS), redirect: 'error'});
    if (!resp.ok) {
        await resp.body?.cancel();
        throw new Error('Unexpected response status ' + resp.status);
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of resp.body) {
        size += chunk.length;
        if (size > MAX_PEER_RESPONSE_BYTES) {
            throw new Error('Response larger than ' + MAX_PEER_RESPONSE_BYTES + ' bytes');
        }
        chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString());
}

// Gets the chain of another node. Only its last blocks are requested, and joined to the blocks
// before them in ours, unless its chain forks from ours before them.
async function fetchChain(node, blockchain) {
    const from = Math.max(0, blockchain.blocks.length - RECENT_BLOCKS);
    if (from > 0) {
        const blocks = await fetchJson(node + '/blockchain?from=' + from);
        if (!Array.isArray(blocks)) {
            return blocks;
        }
        // Read after the request, since the chain may have changed meanwhile
        const previousBlock = blockchain.blocks[from - 1];
        if (previousBlock && blocks[0]?.previousHash === previousBlock.hash) {
            return blockchain.blocks.slice(0, from).concat(blocks);
        }
    }
    return fetchJson(node + '/blockchain');
}

function isLoopback(host) {
    return host == 'localhost' || host == '[::1]' || host == '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

class Nodes {
    constructor(url, port) {
        const nodes = require(process.env.NODE_ENV=='production' ? '../../config/nodes.prod.json' : '../../config/nodes.json');
        // All of them but this one
        this.list = nodes.filter(node => new URL(node).host != url + ':' + port);
    }

    static isLoopback(host) {
        return isLoopback(host);
    }

    // Nodes reached over plain HTTP on another machine, where the traffic can be read and changed
    insecure() {
        return this.list.filter(node => {
            const url = new URL(node);
            return url.protocol == 'http:' && !isLoopback(url.hostname);
        });
    }

    // Gets the chains of the other nodes and takes the one with the most work, if it has more than
    // ours and is valid. Returns what happened with each node.
    sync(blockchain) {
        return Promise.all(this.list.map(async function(node) {
            let respBlockchain;
            try {
                respBlockchain = await fetchChain(node, blockchain);
            } catch(error) {
                console.error('Failed to reach node at ' + node + ':', (error.cause || error).message);
                return {error: 'Failed to reach node at ' + node};
            }

            if (Array.isArray(respBlockchain) && !blockchain.hasLessWorkThan(respBlockchain)) {
                return {noaction: node};
            }
            if (!blockchain.updateBlocks(respBlockchain)) {
                console.error('Rejected invalid blockchain from node at ' + node);
                return {error: 'Invalid blockchain received from node at ' + node};
            }
            return {synced: node};
        }));
    }

    async resolve(res, blockchain) {
        const response = await this.sync(blockchain);

        if (response.length > 0 && response.every(result => result.error))
            res.status(500);
        res.send(response);
    }

    broadcast() {
        return Promise.all(this.list.map(function(node) {
            return fetchJson(node + '/resolve')
                .then(function(resp) {
                    console.log(node, JSON.stringify(resp))
                })
                .catch(function(error) { 
                    console.log(node, (error.cause || error).message);
                });
        }));
    }

    // Sends a new transaction to the other nodes, so that any of them can mine it
    shareTransaction(tx) {
        return Promise.all(this.list.map(function(node) {
            return fetchJson(node + '/transaction', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(tx)})
                .catch(function(error) {
                    // Nodes that already had it answer with an error too
                    console.log(node, (error.cause || error).message);
                });
        }));
    }
}

module.exports = Nodes;
