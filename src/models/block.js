class Block {
    constructor() {
        this.index = 0;
        this.previousHash = '';
        this.hash = '';
        this.timestamp = Math.floor(+new Date() / 1000);
        this.nonce = 0;
        this.transactions = [];
    }

    get key() {
        return Block.keyPrefix(this) + this.nonce;
    }

    // Everything the hash of a block covers except the nonce. Static so it also works
    // with plain objects, like blocks read from disk or received from other nodes.
    static keyPrefix(block) {
        return JSON.stringify(block.transactions) + block.index + block.previousHash;
    }

    addTransactions(transactions) {
        transactions.list.forEach(transaction => {
            this.transactions.push(transaction);
        });
        transactions.reset();
    }

}

module.exports = Block;
