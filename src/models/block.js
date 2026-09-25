class Block {
    constructor() {
        this.index = 0;
        this.previousHash = '';
        this.hash = '';
        this.timestamp = Math.floor(+new Date() / 1000);
        this.nonce = 0;
        // Zero bits the hash has to start with
        this.difficulty = 0;
        this.miner = null;
        // Signature of the hash, made by the miner
        this.signature = null;
        this.transactions = [];
    }

    get key() {
        return Block.keyPrefix(this) + this.nonce;
    }

    // Everything the hash of a block covers except the nonce (the signature signs the hash). It is
    // a JSON array so that no two different blocks give the same text. Static so it also works
    // with plain objects, like blocks read from disk or received from other nodes.
    static keyPrefix(block) {
        return JSON.stringify([block.index, block.previousHash, block.timestamp, block.difficulty, block.miner, block.transactions]);
    }
}

module.exports = Block;
