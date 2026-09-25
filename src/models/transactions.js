const Transaction = require('./transaction');

const MAX_PENDING_TRANSACTIONS = 1000;

// Transactions waiting to be mined, saved on disk so that they survive restarts
class Transactions {
    constructor() {
        this.list = [];
        this.storage = null;
        this.lastSave = Promise.resolve();
    }

    // Loads the transactions saved on disk that are still valid
    async load(storage, blockchain) {
        this.storage = storage;
        const saved = await storage.getItem('transactions');
        this.restore(Array.isArray(saved) ? saved : [], blockchain);
    }

    // Saves the list to disk once the previous save has finished, so that writes don't mix. Failures
    // are logged so they don't crash the node.
    save() {
        if (!this.storage) {
            return this.lastSave;
        }
        this.lastSave = this.lastSave.then(() => this.storage.setItem('transactions', this.list)).catch(error => {
            console.error('Failed to save the pending transactions:', error);
        });
        return this.lastSave;
    }

    // Adds the transaction in the body of the request and answers it. Returns the transaction,
    // or undefined if it was not added.
    add(req, res, blockchain) {
        if (this.list.length >= MAX_PENDING_TRANSACTIONS) {
            res.status(503);
            res.json({'error': 'Too many pending transactions, try again later'});
            return undefined;
        }

        let response = '';
        let tx;

        try {
            // req.body is undefined when the request has no JSON body
            const body = req.body || {};
            tx = new Transaction(body.from, body.to, body.amount, body.timestamp, body.signature);
            this.check(tx, blockchain);
            this.list.push(tx);
            this.save();
            response = {'success': 1};

        } catch(ex) {
            tx = undefined;
            res.status(406);
            response = {'error': ex.message};
        }

        res.json(response);
        return tx;
    }

    // Throws if the transaction can't be added
    check(tx, blockchain) {
        // Otherwise anyone could send a signed transaction again to repeat the payment
        if (this.has(tx) || blockchain.hasTransaction(tx)) {
            throw new Error('Transaction already received');
        }
        // What the sender has, minus what its pending transactions already spend
        if (blockchain.balanceOf(tx.from) - this.pendingAmount(tx.from) < tx.amount) {
            throw new Error('Insufficient balance');
        }
    }

    // Adds back transactions that are not in the chain anymore (or were saved on disk),
    // leaving out the ones that are not valid now
    restore(transactions, blockchain) {
        const count = this.list.length;
        for (const data of transactions) {
            try {
                const tx = new Transaction(data.from, data.to, data.amount, data.timestamp, data.signature);
                this.check(tx, blockchain);
                if (this.list.length < MAX_PENDING_TRANSACTIONS) {
                    this.list.push(tx);
                }
            } catch(ex) {
                // Not valid anymore
            }
        }
        if (this.list.length != count) {
            this.save();
        }
    }

    // Leaves only the transactions for which keep(tx) is true, and returns them
    select(keep) {
        const pending = this.list.filter(keep);
        if (pending.length != this.list.length) {
            this.list = pending;
            this.save();
        }
        return pending.slice();
    }

    // Removes the transactions that the chain already has
    prune(blockchain) {
        this.select(tx => !blockchain.hasTransaction(tx));
    }

    has(tx) {
        const message = Transaction.message(tx);
        return this.list.some(pending => Transaction.message(pending) == message);
    }

    pendingAmount(address) {
        return this.list.filter(pending => pending.from == address).reduce((total, pending) => total + pending.amount, 0);
    }

    get() {
        return this.list;
    }
}

module.exports = Transactions;
