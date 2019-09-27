const sha256 = require('js-sha256');
const Block = require('./block');
const nodePersist = require('node-persist');
const crypto = require('crypto');
const Nodes = require('./nodes');

class Blockchain {
    constructor(url, port) {
        this.blocks = [];
        this.nodes = new Nodes(url, port);

        (async () => {
            this.storage = nodePersist.create({
                dir: __dirname + '/../../storage/' + crypto.createHash('md5').update(url+port).digest("hex")
            });
            await this.storage.init();

            let blocks = await this.storage.getItem('blocks');
            this.blocks = typeof blocks != 'undefined' ? blocks : [];

            if (this.blocks.length == 0) {
                let genesisBlock = new Block(); // initial block
                this.addBlock(genesisBlock);
            }
        })();
    }

    addBlock(block) {
        if (this.blocks.length == 0) {
            block.previousHash = "0000000000000000";
            block.hash = this.generateHash(block);
        }

        this.blocks.push(block);
        
        (async () => {
            await this.storage.setItem('blocks', this.blocks);
        })();
    }

    getNextBlock(transactions) {
        let block = new Block();        
        let previousBlock = this.getPreviousBlock();

        block.addTransactions(transactions);
        block.index = previousBlock.index + 1;
        block.previousHash = previousBlock.hash;
        block.hash = this.generateHash(block);

        return block;
    }

    getPreviousBlock() {
        return this.blocks[this.blocks.length - 1];
    }

    generateHash(block) {
        let hash = sha256(block.key);

        while (!hash.startsWith('000')) {
            block.nonce++;
            hash = sha256(block.key);
        }

        return hash;
    }

    mine(transactions, res) {
        if (transactions.list.length == 0) {
            res.status(500);
            return {error: 'No transactions to be mined'};
        }

        let block = this.getNextBlock(transactions);
        this.addBlock(block);
        this.nodes.broadcast();

        return block;
    }

    updateBlocks(blocks) {
        this.blocks = blocks;

        (async () => {
            await this.storage.setItem('blocks', this.blocks);
        })();
    }

    getBlockByIndex(idx) {
        let foundBlock = [];

        if (idx<=this.blocks.length) {
            this.blocks.forEach( (block) => {
                if (idx == block.index) {
                    foundBlock = block;
                    return;
                }
            });
        }

        return foundBlock;
    }

    getBlockLastIndex() {
        return this.blocks.length-1;
    }
}

module.exports = Blockchain;