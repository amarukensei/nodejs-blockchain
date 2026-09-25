const crypto = require('crypto');
const Transactions = require('../transactions');
const Transaction = require('../transaction');

const aliceKey = crypto.generateKeyPairSync('ed25519').privateKey;
const bob = Transaction.address(crypto.generateKeyPairSync('ed25519').privateKey);

// Body of a request with a transaction from alice to bob
function signedBody(amount = 100) {
  return JSON.parse(JSON.stringify(Transaction.sign(aliceKey, bob, amount)));
}

describe('Transactions', () => {
  let transactions;
  let mockReq;
  let mockRes;
  let mockBlockchain;

  beforeEach(() => {
    transactions = new Transactions();

    mockReq = {
      body: {},
    };
    mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(), // Ensure status can be chained (though not strictly needed here)
    };
    mockBlockchain = {
      hasTransaction: jest.fn().mockReturnValue(false),
      balanceOf: jest.fn().mockReturnValue(1000), // Balance of alice
    };
  });

  describe('constructor', () => {
    test('should initialize an empty list of transactions', () => {
      expect(transactions.list).toEqual([]);
    });
  });

  describe('add(req, res, blockchain)', () => {
    describe('Success case', () => {
      test('should create a new Transaction, add it to the list, and send success response', () => {
        mockReq.body = signedBody();

        transactions.add(mockReq, mockRes, mockBlockchain);

        expect(transactions.list).toHaveLength(1);
        expect(transactions.list[0]).toBeInstanceOf(Transaction);
        expect(transactions.list[0]).toEqual(mockReq.body);
        expect(mockBlockchain.hasTransaction).toHaveBeenCalledWith(transactions.list[0]);
        expect(mockBlockchain.balanceOf).toHaveBeenCalledWith(transactions.list[0].from);
        expect(mockRes.json).toHaveBeenCalledWith({ success: 1 });
        expect(mockRes.status).not.toHaveBeenCalled();
      });
    });

    describe('Failure case (invalid transaction)', () => {
      test('should not add to list, set status to 406, and send error response', () => {
        mockReq.body = { ...signedBody(), amount: 5000 }; // Changed after signing

        transactions.add(mockReq, mockRes, mockBlockchain);

        expect(transactions.list).toHaveLength(0);
        expect(mockRes.status).toHaveBeenCalledWith(406);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Transaction "signature" is not valid' });
      });

      test('should reject requests without a JSON body', () => {
        mockReq.body = undefined; // Express 5 leaves req.body undefined without a JSON body

        transactions.add(mockReq, mockRes, mockBlockchain);

        expect(transactions.list).toHaveLength(0);
        expect(mockRes.status).toHaveBeenCalledWith(406);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Transaction "from" is mandatory' });
      });
    });

    describe('Failure case (transaction already received)', () => {
      test('should reject a transaction that is already pending', () => {
        mockReq.body = signedBody();
        transactions.add(mockReq, mockRes, mockBlockchain);

        transactions.add(mockReq, mockRes, mockBlockchain);

        expect(transactions.list).toHaveLength(1);
        expect(mockRes.status).toHaveBeenCalledWith(406);
        expect(mockRes.json).toHaveBeenLastCalledWith({ error: 'Transaction already received' });
      });

      test('should reject a transaction that is already in the blockchain', () => {
        mockReq.body = signedBody();
        mockBlockchain.hasTransaction.mockReturnValue(true);

        transactions.add(mockReq, mockRes, mockBlockchain);

        expect(transactions.list).toHaveLength(0);
        expect(mockRes.status).toHaveBeenCalledWith(406);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Transaction already received' });
      });
    });

    describe('Failure case (insufficient balance)', () => {
      test('should reject a transaction its sender cannot afford', () => {
        mockBlockchain.balanceOf.mockReturnValue(99);
        mockReq.body = signedBody(100);

        transactions.add(mockReq, mockRes, mockBlockchain);

        expect(transactions.list).toHaveLength(0);
        expect(mockRes.status).toHaveBeenCalledWith(406);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Insufficient balance' });
      });

      test('should take into account what the pending transactions of the sender already spend', () => {
        mockBlockchain.balanceOf.mockReturnValue(150);
        mockReq.body = signedBody(100);
        transactions.add(mockReq, mockRes, mockBlockchain);
        mockReq.body = signedBody(50);
        transactions.add(mockReq, mockRes, mockBlockchain);

        mockReq.body = signedBody(1);
        transactions.add(mockReq, mockRes, mockBlockchain);

        expect(transactions.list.map((tx) => tx.amount)).toEqual([100, 50]);
        expect(mockRes.json).toHaveBeenLastCalledWith({ error: 'Insufficient balance' });
      });
    });

    describe('Failure case (too many pending transactions)', () => {
      test('should reject the transaction with status 503 once 1000 are pending', () => {
        transactions.list = new Array(1000).fill({ id: 'tx' });
        mockReq.body = signedBody();

        transactions.add(mockReq, mockRes, mockBlockchain);

        expect(transactions.list).toHaveLength(1000);
        expect(mockRes.status).toHaveBeenCalledWith(503);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Too many pending transactions, mine them before adding more' });
      });
    });
  });

  describe('has(tx)', () => {
    test('should tell whether the same transaction is pending, whatever object holds it', () => {
      const body = signedBody();
      mockReq.body = body;
      transactions.add(mockReq, mockRes, mockBlockchain);

      expect(transactions.has({ ...body })).toBe(true);
      expect(transactions.has(signedBody(1))).toBe(false);
    });
  });

  describe('pendingAmount(address)', () => {
    test('should add up the amounts that an address sends in pending transactions', () => {
      transactions.list = [{ from: 'alice', amount: 10 }, { from: 'bob', amount: 5 }, { from: 'alice', amount: 7 }];

      expect(transactions.pendingAmount('alice')).toBe(17);
      expect(transactions.pendingAmount('carol')).toBe(0);
    });
  });

  describe('get()', () => {
    test('should return the current list of transactions', () => {
      const mockTx1 = { id: 'tx1' };
      const mockTx2 = { id: 'tx2' };
      transactions.list = [mockTx1, mockTx2];

      const result = transactions.get();
      expect(result).toEqual([mockTx1, mockTx2]);
    });

    test('should return an empty list if no transactions exist', () => {
      const result = transactions.get();
      expect(result).toEqual([]);
    });
  });

  describe('reset()', () => {
    test('should clear the list of transactions', () => {
      transactions.list = [{ id: 'tx1' }, { id: 'tx2' }]; // Add some dummy transactions
      transactions.reset();
      expect(transactions.list).toEqual([]);
    });

    test('should not throw an error if the list is already empty', () => {
      expect(() => transactions.reset()).not.toThrow();
      expect(transactions.list).toEqual([]);
    });
  });
});
