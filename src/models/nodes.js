const PEER_TIMEOUT_MS = 10 * 1000;
const MAX_PEER_RESPONSE_BYTES = 50 * 1024 * 1024;

// Requests JSON from another node. Redirects are not followed and the request is
// aborted if it takes too long or the response grows beyond MAX_PEER_RESPONSE_BYTES.
async function fetchJson(url) {
    const resp = await fetch(url, {signal: AbortSignal.timeout(PEER_TIMEOUT_MS), redirect: 'error'});
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

class Nodes {
    constructor(url, port) {
        const nodes = require(process.env.NODE_ENV=='production' ? '../../config/nodes.prod.json' : '../../config/nodes.json');
        const currentURL = url + ':' + port;
        this.list = [];

        for(let i in nodes)
            if (nodes[i].indexOf(currentURL) == -1)
                this.list.push(nodes[i]);
    }

    async resolve(res, blockchain) {
        const response = await Promise.all(this.list.map(async function(node) {
            let respBlockchain;
            try {
                respBlockchain = await fetchJson(node + '/blockchain');
            } catch(error) {
                console.error('Failed to reach node at ' + node + ':', (error.cause || error).message);
                return {error: 'Failed to reach node at ' + node};
            }

            if (Array.isArray(respBlockchain) && blockchain.blocks.length >= respBlockchain.length) {
                return {noaction: node};
            }
            if (!blockchain.updateBlocks(respBlockchain)) {
                console.error('Rejected invalid blockchain from node at ' + node);
                return {error: 'Invalid blockchain received from node at ' + node};
            }
            return {synced: node};
        }));

        if (response.length > 0 && response.every(result => result.error))
            res.status(500);
        res.send(response);
    }

    broadcast() {
        return Promise.all(this.list.map(function(node) {
            return fetchJson(node + '/resolve')
                .then(function(resp) {
                    console.log(node, resp)
                })
                .catch(function(error) { 
                    console.log(node, error);
                });
        }));
    }
}

module.exports = Nodes;
