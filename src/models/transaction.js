class Transaction {
    constructor(from, to, amount) {
        if (!from) {
            throw new Error('Transaction "from" is mandatory');
        }
        if (!to) {
            throw new Error('Transaction "to" is mandatory');
        }
        if (amount === undefined || typeof amount !== 'number' || isNaN(amount)) {
            throw new Error('Transaction "amount" is mandatory and must be a number');
        }

        this.from = from;
        this.to = to;
        this.amount = amount;
        this.timestamp = Math.floor(+new Date() / 1000);
    }
}

module.exports = Transaction;