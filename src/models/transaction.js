class Transaction {
    constructor(from, to, amount) {
        if (!from || !to || isNaN(amount))
            throw new Error('Invalid data');

        this.from = from;
        this.to = to;
        this.amount = amount;
        this.timestamp = Math.floor(+new Date() / 1000);
    }
}

module.exports = Transaction;