const Transaction = require('./transaction');

class Transactions {
    constructor() {
        this.list = [];
    }

    add(req, res) {
        let response = '';

        try {
            let tx = new Transaction(req.body.from, req.body.to, req.body.amount);
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