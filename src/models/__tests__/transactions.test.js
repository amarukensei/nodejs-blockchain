const Transactions = require('../transactions');
const Transaction = require('../transaction');

// Mock the Transaction class to control its behavior
jest.mock('../transaction');

describe('Transactions', () => {
  let transactions;
  let mockReq;
  let mockRes;

  beforeEach(() => {
    transactions = new Transactions();
    // Reset the mock before each test to clear previous calls and instances
    Transaction.mockClear();

    mockReq = {
      body: {},
    };
    mockRes = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(), // Ensure status can be chained (though not strictly needed here)
    };
  });

  describe('constructor', () => {
    test('should initialize an empty list of transactions', () => {
      expect(transactions.list).toEqual([]);
    });
  });

  describe('add(req, res)', () => {
    describe('Success case', () => {
      test('should create a new Transaction, add it to the list, and send success response', () => {
        mockReq.body = { from: 'address1', to: 'address2', amount: 100 };
        const mockTransactionInstance = {
          from: 'address1',
          to: 'address2',
          amount: 100,
          timestamp: Date.now(),
        };
        // Configure the mock Transaction constructor to return our mock instance
        Transaction.mockImplementation(() => mockTransactionInstance);

        transactions.add(mockReq, mockRes);

        expect(Transaction).toHaveBeenCalledTimes(1);
        expect(Transaction).toHaveBeenCalledWith('address1', 'address2', 100);
        expect(transactions.list).toHaveLength(1);
        expect(transactions.list[0]).toBe(mockTransactionInstance);
        expect(mockRes.json).toHaveBeenCalledWith({ success: 1 });
        expect(mockRes.status).not.toHaveBeenCalled();
      });
    });

    describe('Failure case (Transaction creation throws error)', () => {
      test('should not add to list, set status to 406, and send error response', () => {
        mockReq.body = { from: 'address1', amount: 100 }; // Missing 'to'
        const errorMessage = 'Transaction "to" is mandatory';
        // Configure the mock Transaction constructor to throw an error
        Transaction.mockImplementation(() => {
          throw new Error(errorMessage);
        });

        transactions.add(mockReq, mockRes);

        expect(Transaction).toHaveBeenCalledTimes(1);
        expect(Transaction).toHaveBeenCalledWith('address1', undefined, 100);
        expect(transactions.list).toHaveLength(0);
        expect(mockRes.status).toHaveBeenCalledWith(406);
        expect(mockRes.json).toHaveBeenCalledWith({ error: errorMessage });
      });

      test('should validate an empty transaction when the request has no JSON body', () => {
        mockReq.body = undefined; // Express 5 leaves req.body undefined without a JSON body

        transactions.add(mockReq, mockRes);

        expect(Transaction).toHaveBeenCalledWith(undefined, undefined, undefined);
      });
    });

    describe('Failure case (too many pending transactions)', () => {
      test('should reject the transaction with status 503 once 1000 are pending', () => {
        transactions.list = new Array(1000).fill({ id: 'tx' });
        mockReq.body = { from: 'address1', to: 'address2', amount: 100 };

        transactions.add(mockReq, mockRes);

        expect(Transaction).not.toHaveBeenCalled();
        expect(transactions.list).toHaveLength(1000);
        expect(mockRes.status).toHaveBeenCalledWith(503);
        expect(mockRes.json).toHaveBeenCalledWith({ error: 'Too many pending transactions, mine them before adding more' });
      });
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
