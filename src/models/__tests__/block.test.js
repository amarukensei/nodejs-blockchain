const Block = require('../block');

describe('Block', () => {
  let timestamp;
  let previousHash;
  let transactions;
  let nonce;
  let hash;
  let block;

  beforeEach(() => {
    timestamp = Date.now();
    previousHash = 'previous-hash';
    transactions = {
      list: [{ id: 'tx1' }, { id: 'tx2' }],
      reset: jest.fn(),
    };
    nonce = 0;
    hash = 'test-hash'; // Assuming hash is calculated or passed externally
    block = new Block(timestamp, previousHash, transactions, nonce, hash);
  });

  test('constructor initializes properties correctly', () => {
    expect(block.timestamp).toBe(timestamp);
    expect(block.previousHash).toBe(previousHash);
    expect(block.transactions).toEqual([{ id: 'tx1' }, { id: 'tx2' }]);
    expect(block.nonce).toBe(nonce);
    expect(block.hash).toBe(hash);
    expect(transactions.reset).toHaveBeenCalledTimes(1);
  });

  describe('key getter', () => {
    test('produces a string', () => {
      expect(typeof block.key).toBe('string');
    });

    test('changes when nonce changes', () => {
      const initialKey = block.key;
      block.nonce = 1;
      expect(block.key).not.toBe(initialKey);
    });

    test('changes when transactions change', () => {
      const initialKey = block.key;
      block.transactions = [{ id: 'tx3' }];
      expect(block.key).not.toBe(initialKey);
    });
  });

  describe('addTransactions', () => {
    let newTransactions;

    beforeEach(() => {
      newTransactions = {
        list: [{ id: 'tx3' }, { id: 'tx4' }],
        reset: jest.fn(),
      };
      // Reset the transactions in the block for a clean test
      block.transactions = [];
      // Reset the mock for the initial transactions object
      transactions.reset.mockClear();
    });

    test('adds transactions from input and calls reset', () => {
      block.addTransactions(newTransactions);
      expect(block.transactions).toEqual([{ id: 'tx3' }, { id: 'tx4' }]);
      expect(newTransactions.reset).toHaveBeenCalledTimes(1);
      // Ensure the original transactions.reset was not called again
      expect(transactions.reset).not.toHaveBeenCalled();
    });

    test('does not add transactions if input list is empty', () => {
      const emptyTransactions = {
        list: [],
        reset: jest.fn(),
      };
      block.addTransactions(emptyTransactions);
      expect(block.transactions).toEqual([]);
      expect(emptyTransactions.reset).toHaveBeenCalledTimes(1);
    });
  });
});
