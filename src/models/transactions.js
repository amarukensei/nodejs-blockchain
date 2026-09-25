const Transaction = require('./transaction');

const MAX_PENDING_TRANSACTIONS = 1000;

class Transactions {
    constructor() {
        this.list = [];
    }

    add(req, res) {
        if (this.list.length >= MAX_PENDING_TRANSACTIONS) {
            res.status(503);
            return res.json({'error': 'Too many pending transactions, mine them before adding more'});
        }

        let response = '';

        try {
            // req.body is undefined when the request has no JSON body
            const body = req.body || {};
            let tx = new Transaction(body.from, body.to, body.amount);
            this.list.push(tx);
            response = {'success': 1};

        } catch(ex) {
            res.status(406);
            response = {'error': ex.message};
        }

        res.json(response);
    }

    get() {
        return this.list;
    }

    reset() {
        this.list = [];
    }
}

module.exports = Transactions;
