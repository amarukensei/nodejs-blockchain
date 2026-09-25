const crypto = require('crypto');
const path = require('path');
const nodePersist = require('node-persist');
const Block = require('./block');
const Ledger = require('./ledger');
const Transaction = require('./transaction');
const Nodes = require('./nodes');

const DIFFICULTY = '000';
const GENESIS_PREVIOUS_HASH = '0000000000000000';
// The timestamp is part of the hash, and every node must have the same genesis block
const GENESIS_TIMESTAMP = 1790294400;
// How many of its last blocks a node lets a longer chain replace: older blocks are final
const MAX_REORG_DEPTH = 10;

class Blockchain {
    constructor(url, port, minerAddress = null) {
        this.blocks = [];
        // Balances and transactions of the chain
        this.ledger = new Ledger();
        // Where the rewards for mining go. Without it the node doesn't mine
        this.minerAddress = minerAddress;
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

        if (typeof blocks == 'undefined') {
            // Versions before 2.0 used node-persist 3, which named its files after the MD5 of the
            // key instead of SHA-256, so their chains can only be found by content (to reject them)
            const datum = (await this.storage.data()).find(datum => datum.key == 'blocks');
            blocks = datum ? datum.value : undefined;
        }

        if (typeof blocks == 'undefined' || (Array.isArray(blocks) && blocks.length == 0)) {
            let genesisBlock = new Block(); // initial block
            genesisBlock.timestamp = GENESIS_TIMESTAMP;
            this.addBlock(genesisBlock);
            return;
        }

        const ledger = this.validateChain(blocks);
        if (!ledger) {
            throw new Error('The blockchain stored in ' + this.storageDir + ' is not valid (chains created by versions ' +
                'before 2.0 are not valid anymore), move it away to start a new one');
        }

        this.blocks = blocks;
        this.ledger = ledger;
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
        block.transactions.forEach(tx => this.ledger.add(tx));
        this.ledger.reward(block.miner);
        this.save();
    }

    hasTransaction(tx) {
        return this.ledger.has(tx);
    }

    balanceOf(address) {
        return this.ledger.balanceOf(address);
    }

    getNextBlock(transactions) {
        let block = new Block();        
        let previousBlock = this.getPreviousBlock();

        block.addTransactions(transactions);
        block.index = previousBlock.index + 1;
        block.previousHash = previousBlock.hash;
        block.miner = this.minerAddress;
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

    // Mines a block with the pending transactions (if any) and the reward for mining it.
    mine(transactions, res) {
        if (!this.minerAddress) {
            res.status(503);
            return {error: 'This node does not mine, as MINER_ADDRESS is not set'};
        }

        // Leave out the pending transactions that can't go in the block anymore: since they were
        // received, another node may have added them to the chain or spent the balance they need
        const ledger = this.ledger.copy();
        transactions.list = transactions.list.filter(tx => ledger.add(tx));

        let block = this.getNextBlock(transactions);
        this.addBlock(block);
        this.nodes.broadcast();

        return block;
    }

    // Checks a chain that comes from outside this node (another node or the disk) and returns
    // its ledger, or null if it is not valid. Its transactions must be signed by their senders,
    // appear only once and not spend more than their senders have. Signatures are only
    // verified for blocks that are not in knownBlocks, as those were verified when added.
    validateChain(blocks, knownBlocks = []) {
        if (!Array.isArray(blocks) || blocks.length == 0) {
            return null;
        }

        const ledger = new Ledger();
        for (const [idx, block] of blocks.entries()) {
            if (!this.isValidBlock(block, idx, blocks[idx - 1])) {
                return null;
            }

            // With the hash verified, a block with the same hash as a known one has the same content
            const known = knownBlocks[idx]?.hash === block.hash;
            if (!block.transactions.every(tx => (known || Transaction.isValid(tx)) && ledger.add(tx))) {
                return null;
            }
            ledger.reward(block.miner);
        }

        return ledger;
    }

    // Checks that a block is well formed, linked to the previous one and has a valid proof of
    // work. Only the genesis block has no miner, and it has no transactions either.
    isValidBlock(block, idx, previousBlock) {
        return block !== null && typeof block === 'object' &&
            Object.keys(block).length == 7 && // no fields besides the ones checked below
            block.index === idx &&
            block.previousHash === (idx == 0 ? GENESIS_PREVIOUS_HASH : previousBlock.hash) &&
            Number.isSafeInteger(block.timestamp) && block.timestamp >= 0 &&
            Number.isSafeInteger(block.nonce) && block.nonce >= 0 &&
            (idx == 0 ? block.miner === null : Transaction.isAddress(block.miner)) &&
            Array.isArray(block.transactions) &&
            (idx > 0 || block.transactions.length == 0) &&
            typeof block.hash === 'string' && block.hash.startsWith(DIFFICULTY) &&
            this.calculateHash(block) === block.hash;
    }

    // Replaces the chain with one received from another node, as long as it is valid and only
    // replaces the last MAX_REORG_DEPTH blocks of ours (or fewer), so that transactions buried
    // deeper can't be undone by building a longer chain. Returns whether the chain was replaced.
    updateBlocks(blocks) {
        const lastKept = Math.max(0, this.blocks.length - MAX_REORG_DEPTH - 1);
        if (!Array.isArray(blocks) || blocks[lastKept]?.hash !== this.blocks[lastKept].hash) {
            return false;
        }

        const ledger = this.validateChain(blocks, this.blocks);
        if (!ledger) {
            return false;
        }

        this.blocks = blocks;
        this.ledger = ledger;
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
