const crypto = require('crypto');
const Transactions = require('../transactions');
const Transaction = require('../transaction');

const aliceKey = crypto.generateKeyPairSync('ed25519').privateKey;
const bob = Transaction.address(crypto.generateKeyPairSync('ed25519').privateKey);

// Body of a request with a transaction from alice to bob
function signedBody(amount = 100) {
  return JSON.parse(JSON.stringify(Transaction.sign(aliceKey, bob, amount)));
}

// A node-persist storage with the given pending transactions saved
function mockStorage(saved) {
  return {
    getItem: jest.fn().mockResolvedValue(saved),
    setItem: jest.fn().mockResolvedValue(undefined),
  };
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
    test('should initialize an empty list of transactions, not saved anywhere yet', () => {
      expect(transactions.list).toEqual([]);
      expect(transactions.storage).toBeNull();
    });
  });

  describe('add(req, res, blockchain)', () => {
    describe('Success case', () => {
      test('should create a new Transaction, add it to the list, and send success response', () => {
        mockReq.body = signedBody();

        const tx = transactions.add(mockReq, mockRes, mockBlockchain);

        expect(transactions.list).toEqual([tx]);
        expect(tx).toBeInstanceOf(Transaction);
        expect(tx).toEqual(mockReq.body);
        expect(mockBlockchain.hasTransaction).toHaveBeenCalledWith(tx);
        expect(mockBlockchain.balanceOf).toHaveBeenCalledWith(tx.from);
        expect(mockRes.json).toHaveBeenCalledWith({ success: 1 });
        expect(mockRes.status).not.toHaveBeenCalled();
      });

      test('should save the pending transactions', async () => {
        const storage = mockStorage();
        transactions.storage = storage;
        mockReq.body = signedBody();

        transactions.add(mockReq, mockRes, mockBlockchain);

        await transactions.lastSave;
        expect(storage.setItem).toHaveBeenCalledWith('transactions', transactions.list);
      });
    });

    describe('Failure case (invalid transaction)', () => {
      test('should not add to list, set status to 406, and send error response', () => {
        mockReq.body = { ...signedBody(), amount: 5000 }; // Changed after signing

        expect(transactions.add(mockReq, mockRes, mockBlockchain)).toBeUndefined();

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

        expect(transactions.add(mockReq, mockRes, mockBlockchain)).toBeUndefined();

        expect(transactions.list).toHaveLength(1000);
        expect(mockRes.status).toHaveBeenCalledWith(503);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Too many pending transactions, try again later' });
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

  describe('load(storage, blockchain)', () => {
    test('should restore the saved transactions that are still valid, and keep saving to the storage', async () => {
      const valid = signedBody(10);
      const mined = signedBody(20);
      const tampered = { ...signedBody(30), amount: 31 };
      mockBlockchain.hasTransaction.mockImplementation((tx) => tx.amount == 20);
      const storage = mockStorage([valid, mined, tampered]);

      await transactions.load(storage, mockBlockchain);

      expect(storage.getItem).toHaveBeenCalledWith('transactions');
      expect(transactions.storage).toBe(storage);
      expect(transactions.list).toEqual([valid]);
      expect(transactions.list[0]).toBeInstanceOf(Transaction);
      expect(storage.setItem).toHaveBeenLastCalledWith('transactions', [valid]);
    });

    test('should start with no transactions when none were saved or the saved data is not a list', async () => {
      await transactions.load(mockStorage(undefined), mockBlockchain);
      expect(transactions.list).toEqual([]);

      await transactions.load(mockStorage({ from: 'x' }), mockBlockchain);
      expect(transactions.list).toEqual([]);
    });
  });

  describe('save()', () => {
    test('should do nothing until there is a storage', async () => {
      await expect(transactions.save()).resolves.toBeUndefined();
    });

    test('should write once the previous save has finished, the list as it is then', async () => {
      const finishWrites = [];
      const storage = mockStorage();
      storage.setItem.mockImplementation(() => new Promise((resolve) => finishWrites.push(resolve)));
      transactions.storage = storage;
      const nextTask = () => new Promise((resolve) => setImmediate(resolve));

      transactions.list = [{ amount: 1 }];
      const first = transactions.save();
      await nextTask();
      transactions.list = [{ amount: 1 }, { amount: 2 }];
      const second = transactions.save();
      await nextTask();

      expect(storage.setItem).toHaveBeenCalledTimes(1);
      expect(storage.setItem).toHaveBeenCalledWith('transactions', [{ amount: 1 }]);
      finishWrites[0]();
      await first;
      await nextTask();
      expect(storage.setItem).toHaveBeenCalledTimes(2);
      expect(storage.setItem).toHaveBeenLastCalledWith('transactions', [{ amount: 1 }, { amount: 2 }]);
      finishWrites[1]();
      await second;
    });

    test('should log the failures to save instead of throwing', async () => {
      const error = new Error('disk full');
      const storage = mockStorage();
      storage.setItem.mockRejectedValue(error);
      transactions.storage = storage;
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await expect(transactions.save()).resolves.toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith('Failed to save the pending transactions:', error);
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  describe('restore(transactions, blockchain)', () => {
    test('should add back the transactions that are still valid, in their order', async () => {
      transactions.storage = mockStorage();
      const pending = signedBody(1);
      transactions.list = [new Transaction(pending.from, pending.to, pending.amount, pending.timestamp, pending.signature)];
      mockBlockchain.balanceOf.mockReturnValue(10);
      const first = signedBody(2);
      const second = signedBody(3);

      transactions.restore([first, pending, signedBody(100), { ...signedBody(4), to: 'mallory' }, null, second], mockBlockchain);

      // The one already pending, the one alice can't afford and the ones that are not valid are left out
      expect(transactions.list.map((tx) => tx.amount)).toEqual([1, 2, 3]);
      expect(transactions.list[1]).toEqual(first);
      await transactions.lastSave;
      expect(transactions.storage.setItem).toHaveBeenCalledTimes(1);
    });

    test('should not save when it adds nothing', async () => {
      transactions.storage = mockStorage();
      mockBlockchain.hasTransaction.mockReturnValue(true);

      transactions.restore([signedBody()], mockBlockchain);

      expect(transactions.list).toEqual([]);
      await transactions.lastSave;
      expect(transactions.storage.setItem).not.toHaveBeenCalled();
    });

    test('should not go over 1000 pending transactions', () => {
      transactions.list = new Array(999).fill({ from: 'someone', amount: 1 });

      transactions.restore([signedBody(1), signedBody(2)], mockBlockchain);

      expect(transactions.list).toHaveLength(1000);
      expect(transactions.list[999].amount).toBe(1);
    });
  });

  describe('select(keep)', () => {
    test('should leave only the transactions to keep, and return a copy of them', async () => {
      transactions.storage = mockStorage();
      transactions.list = [{ amount: 1 }, { amount: 2 }, { amount: 3 }];

      const selected = transactions.select((tx) => tx.amount != 2);
      selected.push({ amount: 4 });

      expect(transactions.list).toEqual([{ amount: 1 }, { amount: 3 }]);
      await transactions.lastSave;
      expect(transactions.storage.setItem).toHaveBeenCalledWith('transactions', transactions.list);
    });

    test('should not save when it keeps them all', async () => {
      transactions.storage = mockStorage();
      transactions.list = [{ amount: 1 }];

      expect(transactions.select(() => true)).toEqual([{ amount: 1 }]);
      await transactions.lastSave;
      expect(transactions.storage.setItem).not.toHaveBeenCalled();
    });
  });

  describe('prune(blockchain)', () => {
    test('should remove the transactions that the chain already has', () => {
      transactions.list = [{ amount: 1 }, { amount: 2 }];
      mockBlockchain.hasTransaction.mockImplementation((tx) => tx.amount == 1);

      transactions.prune(mockBlockchain);

      expect(transactions.list).toEqual([{ amount: 2 }]);
    });
  });
});
