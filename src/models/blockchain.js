const crypto = require('crypto');
const path = require('path');
const { setImmediate } = require('timers/promises');
const nodePersist = require('node-persist');
const Block = require('./block');
const keys = require('./keys');
const Ledger = require('./ledger');
const Transaction = require('./transaction');
const Transactions = require('./transactions');
const Nodes = require('./nodes');

const GENESIS_PREVIOUS_HASH = '0000000000000000';
// The timestamp is part of the hash, and every node must have the same genesis block
const GENESIS_TIMESTAMP = 1790294400;
// Proof of work: the hash of a block must start with as many zero bits as its difficulty, which
// changes so that the network mines a block every TARGET_BLOCK_TIME seconds on average
const MIN_DIFFICULTY = 12;
const TARGET_BLOCK_TIME = 10;
// How many of the last blocks decide the difficulty of the next one
const DIFFICULTY_WINDOW = 4;
// How many seconds after the clock of the node checking it a block can be dated
const MAX_FUTURE_TIME = 2 * 60;
// Attempts to find the proof of work between pauses to let the node answer requests
const MINING_BATCH = 10000;

// Whether a hash (in hexadecimal) starts with at least `bits` zero bits
function meetsDifficulty(hash, bits) {
    const zeroDigits = Math.floor(bits / 4);
    for (let i = 0; i < zeroDigits; i++) {
        if (hash[i] !== '0') {
            return false;
        }
    }
    return bits % 4 == 0 || parseInt(hash[zeroDigits], 16) < (16 >> (bits % 4));
}

// The work behind some blocks: how many hashes it takes, on average, to find their proofs of work
function work(blocks) {
    return blocks.reduce((total, block) => {
        const difficulty = block?.difficulty;
        return total + (Number.isSafeInteger(difficulty) && difficulty >= 0 && difficulty <= 256 ? 2n ** BigInt(difficulty) : 0n);
    }, 0n);
}

class Blockchain {
    // `miner` is the private key that signs the blocks this node mines, whose address gets their
    // rewards: without it the node doesn't mine. When `authorizedMiners` has addresses, only them
    // can mine blocks. `now` returns the current time in seconds.
    constructor(url, port, {miner = null, authorizedMiners = [], now = () => Math.floor(Date.now() / 1000)} = {}) {
        this.blocks = [];
        // Balances and transactions of the chain
        this.ledger = new Ledger();
        // Transactions waiting to be mined
        this.transactions = new Transactions();
        this.minerKey = miner;
        this.minerAddress = miner && keys.addressOf(miner);
        this.authorizedMiners = authorizedMiners;
        this.now = now;
        this.mining = false;
        this.nodes = new Nodes(url, port);
        this.storageDir = path.join(__dirname, '../../storage', crypto.createHash('md5').update(url+port).digest("hex"));
        // The write queue of node-persist can skip a write that starts while another one of the same
        // key is in progress, so save() writes one at a time instead
        this.storage = nodePersist.create({
            dir: this.storageDir,
            writeQueue: false
        });
        this.lastSave = Promise.resolve();
    }

    // Loads the chain and the pending transactions saved on disk, or creates the genesis block the first time.
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
            genesisBlock.previousHash = GENESIS_PREVIOUS_HASH;
            genesisBlock.timestamp = GENESIS_TIMESTAMP;
            genesisBlock.difficulty = MIN_DIFFICULTY;
            genesisBlock.hash = this.generateHash(genesisBlock);
            this.addBlock(genesisBlock);
        } else {
            const ledger = this.validateChain(blocks);
            if (!ledger) {
                throw new Error('The blockchain stored in ' + this.storageDir + ' is not valid (chains created by versions ' +
                    'before 3.0 are not valid anymore), move it away to start a new one');
            }

            this.blocks = blocks;
            this.ledger = ledger;
        }

        await this.transactions.load(this.storage, this);
    }

    // Saves the chain to disk once the previous save has finished, so that writes don't mix. Failures
    // are logged so they don't crash the node.
    save() {
        this.lastSave = this.lastSave.then(() => this.storage.setItem('blocks', this.blocks)).catch(error => {
            console.error('Failed to save the blockchain:', error);
        });
        return this.lastSave;
    }

    addBlock(block) {
        this.blocks.push(block);
        block.transactions.forEach(tx => this.ledger.add(tx));
        this.ledger.reward(block.miner);
        this.transactions.prune(this);
        this.save();
    }

    hasTransaction(tx) {
        return this.ledger.has(tx);
    }

    balanceOf(address) {
        return this.ledger.balanceOf(address);
    }

    isAuthorizedMiner(address) {
        return this.authorizedMiners.length == 0 || this.authorizedMiners.includes(address);
    }

    getPreviousBlock() {
        return this.blocks[this.blocks.length - 1];
    }

    calculateHash(block) {
        return crypto.createHash('sha256').update(Block.keyPrefix(block) + block.nonce).digest('hex');
    }

    // Finds the proof of work of a block at once (the genesis one, which is easy)
    generateHash(block) {
        let hash = this.calculateHash(block);

        while (!meetsDifficulty(hash, block.difficulty)) {
            block.nonce++;
            hash = this.calculateHash(block);
        }

        return hash;
    }

    // Difficulty the block at idx must have, which depends on how long the previous blocks took:
    // one bit more when they came faster than half TARGET_BLOCK_TIME on average, and one bit less
    // when they took more than twice it.
    expectedDifficulty(blocks, idx) {
        if (idx < 2) {
            return MIN_DIFFICULTY;
        }

        const previousBlock = blocks[idx - 1];
        // The date of the genesis block is fixed, so it doesn't count
        const firstIdx = Math.max(1, idx - 1 - DIFFICULTY_WINDOW);
        const intervals = idx - 1 - firstIdx;
        if (intervals == 0) {
            return previousBlock.difficulty;
        }

        const averageTime = (previousBlock.timestamp - blocks[firstIdx].timestamp) / intervals;
        if (averageTime < TARGET_BLOCK_TIME / 2) {
            return previousBlock.difficulty + 1;
        }
        if (averageTime > TARGET_BLOCK_TIME * 2) {
            return Math.max(MIN_DIFFICULTY, previousBlock.difficulty - 1);
        }
        return previousBlock.difficulty;
    }

    // Mines the next block, with the pending transactions that can go in it and the reward for this
    // node. It makes MINING_BATCH attempts at a time, so that the node keeps answering requests, and
    // gives up (returning null) when keepMining() is false or the chain changes meanwhile.
    async mineBlock(keepMining = () => true) {
        const previousBlock = this.getPreviousBlock();
        const ledger = this.ledger.copy();
        const block = new Block();
        block.index = previousBlock.index + 1;
        block.previousHash = previousBlock.hash;
        block.timestamp = Math.max(this.now(), previousBlock.timestamp);
        block.difficulty = this.expectedDifficulty(this.blocks, block.index);
        block.miner = this.minerAddress;
        // The other pending transactions can't go in any block: since they were received, another
        // node may have added them to the chain or spent the balance they need
        block.transactions = this.transactions.select(tx => ledger.add(tx));

        // Only the nonce changes between attempts, so the rest of the key is hashed once
        const prefix = crypto.createHash('sha256').update(Block.keyPrefix(block));
        for (;;) {
            for (let attempt = 0; attempt < MINING_BATCH; attempt++) {
                const hash = prefix.copy().update(String(block.nonce)).digest('hex');
                if (meetsDifficulty(hash, block.difficulty)) {
                    block.hash = hash;
                    block.signature = keys.sign(this.minerKey, hash);
                    this.addBlock(block);
                    this.nodes.broadcast();
                    return block;
                }
                block.nonce++;
            }

            await setImmediate();
            if (!keepMining() || this.getPreviousBlock() !== previousBlock) {
                return null;
            }
        }
    }

    // Gets the chains of the other nodes, so as not to mine on top of an old one, and then mines
    // blocks one after another until stopMining() is called
    async startMining() {
        this.mining = true;
        await this.nodes.sync(this);
        while (this.mining) {
            await this.mineBlock(() => this.mining);
        }
    }

    stopMining() {
        this.mining = false;
    }

    // Checks a whole chain (read from disk, for example) and returns its ledger, or null if it is not valid
    validateChain(blocks) {
        const ledger = new Ledger();
        return Array.isArray(blocks) && blocks.length > 0 && this.validateBlocks(blocks, 0, ledger) ? ledger : null;
    }

    // Checks the blocks of a chain from index `from` on, adding their transactions and rewards to the
    // ledger of the blocks before. Their transactions must be signed by their senders, appear only
    // once and not spend more than their senders have. Returns whether the blocks are valid.
    validateBlocks(blocks, from, ledger) {
        for (let idx = from; idx < blocks.length; idx++) {
            const block = blocks[idx];
            if (!this.isValidBlock(block, idx, blocks) ||
                !block.transactions.every(tx => Transaction.isValid(tx) && ledger.add(tx))) {
                return false;
            }
            ledger.reward(block.miner);
        }
        return true;
    }

    // Checks that a block is well formed, linked to the previous one, not dated before it nor in the
    // future, and that it has the proof of work its position requires. The genesis block is always the
    // same, and the others must be signed by their miner, which must be authorized when there is a list.
    isValidBlock(block, idx, blocks) {
        const previousBlock = blocks[idx - 1];
        return block !== null && typeof block === 'object' &&
            Object.keys(block).length == 9 && // no fields besides the ones checked below
            block.index === idx &&
            Number.isSafeInteger(block.timestamp) &&
            Number.isSafeInteger(block.nonce) && block.nonce >= 0 &&
            Array.isArray(block.transactions) &&
            block.difficulty === this.expectedDifficulty(blocks, idx) &&
            typeof block.hash === 'string' && meetsDifficulty(block.hash, block.difficulty) &&
            this.calculateHash(block) === block.hash &&
            (idx == 0 ?
                block.previousHash === GENESIS_PREVIOUS_HASH && block.timestamp === GENESIS_TIMESTAMP &&
                block.miner === null && block.signature === null && block.transactions.length == 0 :
                block.previousHash === previousBlock.hash &&
                block.timestamp >= previousBlock.timestamp && block.timestamp <= this.now() + MAX_FUTURE_TIME &&
                this.isAuthorizedMiner(block.miner) && keys.verify(block.miner, block.hash, block.signature));
    }

    // Index of the first block of a chain that is not the same as ours
    forkIndex(blocks) {
        let idx = 0;
        while (idx < blocks.length && idx < this.blocks.length && blocks[idx]?.hash === this.blocks[idx].hash) {
            idx++;
        }
        return idx;
    }

    // Whether a chain has more work than ours, according to the difficulty of its blocks
    hasLessWorkThan(blocks) {
        const fork = this.forkIndex(blocks);
        return work(blocks.slice(fork)) > work(this.blocks.slice(fork));
    }

    // Replaces the chain with one received from another node, if it has more work and is valid. The
    // deeper a block is, the more work it takes to replace it. The transactions of the replaced
    // blocks that the new chain doesn't have are pending again. Returns whether the chain was replaced.
    updateBlocks(blocks) {
        if (!Array.isArray(blocks)) {
            return false;
        }

        const fork = this.forkIndex(blocks);
        // A chain that starts with another genesis block is another blockchain
        if (fork == 0 || !this.hasLessWorkThan(blocks)) {
            return false;
        }

        // The blocks before the fork are ours, so only the new ones need to be checked
        const replaced = this.blocks.slice(fork);
        const chain = this.blocks.slice(0, fork).concat(blocks.slice(fork));
        const ledger = this.ledger.copy();
        replaced.forEach(block => ledger.removeBlock(block));
        if (!this.validateBlocks(chain, fork, ledger)) {
            return false;
        }

        this.blocks = chain;
        this.ledger = ledger;
        this.transactions.restore(replaced.flatMap(block => block.transactions), this);
        this.transactions.prune(this);
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
