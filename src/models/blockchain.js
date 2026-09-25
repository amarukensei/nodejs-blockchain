const crypto = require('crypto');
const path = require('path');
const nodePersist = require('node-persist');
const Block = require('./block');
const Transaction = require('./transaction');
const Nodes = require('./nodes');

const DIFFICULTY = '000';
const GENESIS_PREVIOUS_HASH = '0000000000000000';

class Blockchain {
    constructor(url, port) {
        this.blocks = [];
        // Messages of the transactions in the chain, so that none can be added twice
        this.transactionMessages = new Set();
        this.nodes = new Nodes(url, port);
        this.storageDir = path.join(__dirname, '../../storage', crypto.createHash('md5').update(url+port).digest("hex"));
        this.storage = nodePersist.create({
            dir: this.storageDir
        });
    }

    // Loads the chain saved on disk, or creates the genesis block the first time.
    async init() {
        await this.storage.init();

        let blocks = await this.storage.getItem('blocks');
        let migrated = false;

        if (typeof blocks == 'undefined') {
            // node-persist 3 named its files after the MD5 of the key and version 4 uses
            // SHA-256, so a chain saved before upgrading can only be found by its content.
            const datum = (await this.storage.data()).find(datum => datum.key == 'blocks');
            if (datum) {
                blocks = datum.value;
                migrated = true;
            }
        }

        if (typeof blocks == 'undefined' || (Array.isArray(blocks) && blocks.length == 0)) {
            let genesisBlock = new Block(); // initial block
            this.addBlock(genesisBlock);
            return;
        }

        if (!this.isValidChain(blocks)) {
            throw new Error('The blockchain stored in ' + this.storageDir + ' is not valid (chains created before ' +
                'transactions were signed are not valid anymore), move it away to start a new one');
        }

        this.blocks = blocks;
        this.indexTransactions();
        if (migrated) {
            await this.save();
        }
    }

    // Saves the chain to disk. Failures are logged so they don't crash the node.
    save() {
        return this.storage.setItem('blocks', this.blocks).catch(error => {
            console.error('Failed to save the blockchain:', error);
        });
    }

    addBlock(block) {
        if (this.blocks.length == 0) {
            block.previousHash = GENESIS_PREVIOUS_HASH;
            block.hash = this.generateHash(block);
        }

        this.blocks.push(block);
        block.transactions.forEach(tx => this.transactionMessages.add(Transaction.message(tx)));
        this.save();
    }

    indexTransactions() {
        this.transactionMessages = new Set();
        this.blocks.forEach(block => {
            block.transactions.forEach(tx => this.transactionMessages.add(Transaction.message(tx)));
        });
    }

    hasTransaction(tx) {
        return this.transactionMessages.has(Transaction.message(tx));
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

    calculateHash(block) {
        return crypto.createHash('sha256').update(Block.keyPrefix(block) + block.nonce).digest('hex');
    }

    generateHash(block) {
        // Only the nonce changes between attempts, so the rest of the key is hashed once:
        // otherwise mining a block with many transactions would block the node for long.
        const prefix = crypto.createHash('sha256').update(Block.keyPrefix(block));
        const hashWithNonce = () => prefix.copy().update(String(block.nonce)).digest('hex');
        let hash = hashWithNonce();

        while (!hash.startsWith(DIFFICULTY)) {
            block.nonce++;
            hash = hashWithNonce();
        }

        return hash;
    }

    mine(transactions, res) {
        // Another node may have added some of them to the chain since they were received
        transactions.list = transactions.list.filter(tx => !this.hasTransaction(tx));

        if (transactions.list.length == 0) {
            res.status(500);
            return {error: 'No transactions to be mined'};
        }

        let block = this.getNextBlock(transactions);
        this.addBlock(block);
        this.nodes.broadcast();

        return block;
    }

    // Checks a chain that comes from outside this node (another node or the disk): blocks
    // must be well formed, properly linked and carry a valid proof of work, and transactions
    // must be signed by their sender and appear only once. Signatures are only verified for
    // blocks that are not in knownBlocks, as those were verified when they were added.
    isValidChain(blocks, knownBlocks = []) {
        if (!Array.isArray(blocks) || blocks.length == 0) {
            return false;
        }

        const seenMessages = new Set();
        const isFirstSeen = tx => {
            const message = Transaction.message(tx);
            if (seenMessages.has(message)) {
                return false;
            }
            seenMessages.add(message);
            return true;
        };

        return blocks.every((block, idx) =>
            block !== null && typeof block === 'object' &&
            Object.keys(block).length == 6 && // no fields besides the ones checked below
            block.index === idx &&
            block.previousHash === (idx == 0 ? GENESIS_PREVIOUS_HASH : blocks[idx - 1].hash) &&
            Number.isSafeInteger(block.timestamp) && block.timestamp >= 0 &&
            Number.isSafeInteger(block.nonce) && block.nonce >= 0 &&
            Array.isArray(block.transactions) &&
            (idx > 0 || block.transactions.length == 0) &&
            typeof block.hash === 'string' && block.hash.startsWith(DIFFICULTY) &&
            this.calculateHash(block) === block.hash &&
            // With the hash verified, a block with the same hash as a known one has the same content
            block.transactions.every(tx =>
                (knownBlocks[idx]?.hash === block.hash || Transaction.isValid(tx)) && isFirstSeen(tx)
            )
        );
    }

    // Replaces the chain with one received from another node, as long as it is valid
    // and starts with the same genesis block. Returns whether the chain was replaced.
    updateBlocks(blocks) {
        if (!this.isValidChain(blocks, this.blocks) || blocks[0].hash !== this.blocks[0].hash) {
            return false;
        }

        this.blocks = blocks;
        this.indexTransactions();
        this.save();
        return true;
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
