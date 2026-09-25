const MAX_ADDRESS_LENGTH = 256;

function validateAddress(name, address) {
    if (!address) {
        throw new Error('Transaction "' + name + '" is mandatory');
    }
    if (typeof address !== 'string' || address.length > MAX_ADDRESS_LENGTH) {
        throw new Error('Transaction "' + name + '" must be a string of up to ' + MAX_ADDRESS_LENGTH + ' characters');
    }
}

class Transaction {
    constructor(from, to, amount) {
        Transaction.validate(from, to, amount);

        this.from = from;
        this.to = to;
        this.amount = amount;
        this.timestamp = Math.floor(+new Date() / 1000);
    }

    static validate(from, to, amount) {
        validateAddress('from', from);
        validateAddress('to', to);
        if (amount === undefined || typeof amount !== 'number' || isNaN(amount)) {
            throw new Error('Transaction "amount" is mandatory and must be a number');
        }
        if (amount <= 0 || !Number.isFinite(amount)) {
            throw new Error('Transaction "amount" must be a positive number');
        }
    }

    // Checks a transaction inside a block that comes from another node or from disk:
    // same rules as new transactions and no fields besides the ones set by the constructor.
    static isValid(tx) {
        if (tx === null || typeof tx !== 'object' || Object.keys(tx).length != 4 ||
            !Number.isSafeInteger(tx.timestamp) || tx.timestamp < 0) {
            return false;
        }

        try {
            Transaction.validate(tx.from, tx.to, tx.amount);
            return true;
        } catch(ex) {
            return false;
        }
    }
}

module.exports = Transaction;
