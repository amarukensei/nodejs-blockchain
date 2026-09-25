const Transaction = require('../models/transaction');
const Transactions = require('../models/transactions');
const Blockchain = require('../models/blockchain');
const Nodes = require('../models/nodes');

class BlockchainController {
    constructor(url, port, minerAddress) {
        this.blockchain = new Blockchain(url, port, minerAddress);
        this.nodes = new Nodes(url, port);
        this.transactions = new Transactions();
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
        this.transactions.add(req, res, this.blockchain);
    }

    getTransactions(req, res) {
        res.json(this.transactions.get());
    }

    mine(req, res) {
        res.json(this.blockchain.mine(this.transactions, res));
    }

    getBlockchain(req, res) {
        res.json(this.blockchain.blocks);
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