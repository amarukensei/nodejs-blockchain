const keys = require('./keys');

function validateAddress(name, address) {
    if (!address) {
        throw new Error('Transaction "' + name + '" is mandatory');
    }
    if (!keys.isAddress(address)) {
        throw new Error('Transaction "' + name + '" must be an address (a public key of 64 hexadecimal characters)');
    }
}

class Transaction {
    constructor(from, to, amount, timestamp, signature) {
        Transaction.validate(from, to, amount, timestamp, signature);

        this.from = from;
        this.to = to;
        this.amount = amount;
        this.timestamp = timestamp;
        this.signature = signature;
    }

    // Creates a transaction from the owner of privateKey, signed with it
    static sign(privateKey, to, amount, timestamp = Math.floor(+new Date() / 1000)) {
        const from = keys.addressOf(privateKey);
        const signature = keys.sign(privateKey, Transaction.message({from, to, amount, timestamp}));

        return new Transaction(from, to, amount, timestamp, signature);
    }

    static isAddress(address) {
        return keys.isAddress(address);
    }

    // Address of a key pair, given its private or its public key (as KeyObjects)
    static address(key) {
        return keys.addressOf(key);
    }

    // What the sender signs: every field but the signature, in this order
    static message(tx) {
        return JSON.stringify({from: tx.from, to: tx.to, amount: tx.amount, timestamp: tx.timestamp});
    }

    static validate(from, to, amount, timestamp, signature) {
        validateAddress('from', from);
        validateAddress('to', to);
        if (amount === undefined || typeof amount !== 'number' || isNaN(amount)) {
            throw new Error('Transaction "amount" is mandatory and must be a number');
        }
        // Whole units only, so that balances add up exactly
        if (amount <= 0 || !Number.isSafeInteger(amount)) {
            throw new Error('Transaction "amount" must be a positive integer');
        }
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
            throw new Error('Transaction "timestamp" is mandatory and must be a Unix time in seconds');
        }
        if (!signature) {
            throw new Error('Transaction "signature" is mandatory');
        }
        if (!keys.verify(from, Transaction.message({from, to, amount, timestamp}), signature)) {
            throw new Error('Transaction "signature" is not valid');
        }
    }

    // Checks a transaction inside a block that comes from another node or from disk:
    // same rules as new transactions and no fields besides the ones set by the constructor.
    static isValid(tx) {
        if (tx === null || typeof tx !== 'object' || Object.keys(tx).length != 5) {
            return false;
        }

        try {
            Transaction.validate(tx.from, tx.to, tx.amount, tx.timestamp, tx.signature);
            return true;
        } catch(ex) {
            return false;
        }
    }
}

module.exports = Transaction;
