const Transaction = require('../models/transaction');
const Blockchain = require('../models/blockchain');

class BlockchainController {
    constructor(url, port, options) {
        this.blockchain = new Blockchain(url, port, options);
        this.nodes = this.blockchain.nodes;
        this.transactions = this.blockchain.transactions;
    }

    init() {
        return this.blockchain.init();
    }

    resolve(req, res) {
        return this.nodes.resolve(res, this.blockchain);
    }

    getNodes(req, res) {
        res.json(this.nodes.list);
    }

    postTransaction(req, res) {
        const tx = this.transactions.add(req, res, this.blockchain);
        // So that any node can mine it
        if (tx) {
            this.nodes.shareTransaction(tx);
        }
    }

    getTransactions(req, res) {
        res.json(this.transactions.get());
    }

    // The whole chain, or only its blocks from index `from` on
    getBlockchain(req, res) {
        const from = req.query.from;
        if (from === undefined) {
            return res.json(this.blockchain.blocks);
        }
        if (typeof from !== 'string' || !/^\d+$/.test(from)) {
            res.status(400);
            return res.json({error: '"from" must be the index of a block'});
        }

        res.json(this.blockchain.blocks.slice(Number(from)));
    }

    getBlockByIndex(req, res) {
        res.json(this.blockchain.getBlockByIndex(req.params.idx));
    }

    getBlockLastIndex(req, res) {
        res.json(this.blockchain.getBlockLastIndex());
    }

    getBalance(req, res) {
        const address = req.params.address;
        if (!Transaction.isAddress(address)) {
            res.status(400);
            return res.json({error: 'Invalid address'});
        }

        res.json({address: address, balance: this.blockchain.balanceOf(address)});
    }
}

module.exports = BlockchainController;
