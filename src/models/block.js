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
        return JSON.stringify(this.transactions) + this.index + this.previousHash + this.nonce;
    }

    addTransactions(transactions) {
        transactions.list.forEach(transaction => {
            this.transactions.push(transaction);
        });
        transactions.reset();
    }

}

module.exports = Block;