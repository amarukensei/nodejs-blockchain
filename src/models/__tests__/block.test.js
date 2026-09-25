const Block = require('../block');

describe('Block', () => {
  let block;

  beforeEach(() => {
    block = new Block();
  });

  test('constructor initializes an empty block', () => {
    expect(block.index).toBe(0);
    expect(block.previousHash).toBe('');
    expect(block.hash).toBe('');
    expect(block.nonce).toBe(0);
    expect(block.transactions).toEqual([]);
    expect(Number.isInteger(block.timestamp)).toBe(true);
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

    test('is the transactions, index, previous hash and nonce', () => {
      block.transactions = [{ id: 'tx1' }];
      block.index = 3;
      block.previousHash = 'abc';
      block.nonce = 42;
      expect(block.key).toBe('[{"id":"tx1"}]3abc42');
      expect(block.key).toBe(Block.keyPrefix(block) + 42);
    });
  });

  describe('keyPrefix', () => {
    test('works with plain objects', () => {
      expect(Block.keyPrefix({ index: 1, previousHash: 'prev', transactions: [] })).toBe('[]1prev');
    });
  });

  describe('addTransactions', () => {
    test('adds transactions from input and calls reset', () => {
      const transactions = {
        list: [{ id: 'tx3' }, { id: 'tx4' }],
        reset: jest.fn(),
      };
      block.addTransactions(transactions);
      expect(block.transactions).toEqual([{ id: 'tx3' }, { id: 'tx4' }]);
      expect(transactions.reset).toHaveBeenCalledTimes(1);
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
