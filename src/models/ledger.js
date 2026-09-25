const Transaction = require('./transaction');

const MINING_REWARD = 50;

// Balance of every address and the transactions recorded so far, built block by block
class Ledger {
    constructor() {
        this.balances = new Map();
        this.messages = new Set();
    }

    copy() {
        const ledger = new Ledger();
        ledger.balances = new Map(this.balances);
        ledger.messages = new Set(this.messages);
        return ledger;
    }

    balanceOf(address) {
        return this.balances.get(address) || 0;
    }

    has(tx) {
        return this.messages.has(Transaction.message(tx));
    }

    // Records a transaction, as long as it wasn't recorded before and its sender has
    // enough balance for it. Returns whether it was recorded.
    add(tx) {
        if (this.has(tx) || this.balanceOf(tx.from) < tx.amount) {
            return false;
        }

        this.messages.add(Transaction.message(tx));
        this.balances.set(tx.from, this.balanceOf(tx.from) - tx.amount);
        this.balances.set(tx.to, this.balanceOf(tx.to) + tx.amount);
        return true;
    }

    // Mining a block is what creates coins
    reward(miner) {
        if (miner) {
            this.balances.set(miner, this.balanceOf(miner) + MINING_REWARD);
        }
    }
}

Ledger.MINING_REWARD = MINING_REWARD;

module.exports = Ledger;
