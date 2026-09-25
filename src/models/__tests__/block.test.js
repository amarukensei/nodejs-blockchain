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
    expect(block.miner).toBeNull();
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

    test.each([
      ['timestamp', 1790000001],
      ['miner', 'ab'.repeat(32)],
    ])('changes when the %s changes', (field, value) => {
      const initialKey = block.key;
      block[field] = value;
      expect(block.key).not.toBe(initialKey);
    });

    test('is the index, previous hash, timestamp, miner and transactions, followed by the nonce', () => {
      block.index = 3;
      block.previousHash = 'abc';
      block.timestamp = 1790000000;
      block.miner = 'ab'.repeat(32);
      block.transactions = [{ id: 'tx1' }];
      block.nonce = 42;
      expect(block.key).toBe(`[3,"abc",1790000000,"${'ab'.repeat(32)}",[{"id":"tx1"}]]42`);
      expect(block.key).toBe(Block.keyPrefix(block) + 42);
    });
  });

  describe('keyPrefix', () => {
    test('works with plain objects', () => {
      expect(Block.keyPrefix({ index: 1, previousHash: 'prev', timestamp: 5, miner: null, transactions: [] })).toBe('[1,"prev",5,null,[]]');
    });

    test('is different for blocks whose fields only differ in where one ends and the next begins', () => {
      const miner = '3'.repeat(64);
      const a = Object.assign(new Block(), { index: 1, previousHash: 'p', timestamp: 12, miner, nonce: 5 });
      const b = Object.assign(new Block(), { index: 1, previousHash: 'p', timestamp: 1, miner: '2' + miner.slice(1), nonce: 35 });

      // Just concatenating the fields, both blocks would have the same key and so the same hash
      expect('' + a.timestamp + a.miner + a.nonce).toBe('' + b.timestamp + b.miner + b.nonce);
      expect(a.key).not.toBe(b.key);
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
