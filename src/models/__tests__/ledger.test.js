const crypto = require('crypto');
const Ledger = require('../ledger');
const Transaction = require('../transaction');

const aliceKey = crypto.generateKeyPairSync('ed25519').privateKey;
const alice = Transaction.address(aliceKey);
const bob = Transaction.address(crypto.generateKeyPairSync('ed25519').privateKey);

describe('Ledger', () => {
  let ledger;

  beforeEach(() => {
    ledger = new Ledger();
  });

  test('every address starts with no balance', () => {
    expect(ledger.balanceOf(alice)).toBe(0);
  });

  describe('reward(miner)', () => {
    test('gives the miner the reward for mining', () => {
      ledger.reward(alice);
      ledger.reward(alice);

      expect(Ledger.MINING_REWARD).toBe(50);
      expect(ledger.balanceOf(alice)).toBe(100);
    });

    test('does nothing without a miner, as in the genesis block', () => {
      ledger.reward(null);
      expect(ledger.balances.size).toBe(0);
    });
  });

  describe('add(tx)', () => {
    test('moves the amount from the sender to the recipient', () => {
      ledger.reward(alice);
      const tx = Transaction.sign(aliceKey, bob, 20);

      expect(ledger.add(tx)).toBe(true);
      expect(ledger.balanceOf(alice)).toBe(30);
      expect(ledger.balanceOf(bob)).toBe(20);
      expect(ledger.has(tx)).toBe(true);
    });

    test('lets the sender spend all it has', () => {
      ledger.reward(alice);
      expect(ledger.add(Transaction.sign(aliceKey, bob, 50))).toBe(true);
      expect(ledger.balanceOf(alice)).toBe(0);
    });

    test('rejects a transaction the sender cannot afford', () => {
      ledger.reward(alice);
      const tx = Transaction.sign(aliceKey, bob, 51);

      expect(ledger.add(tx)).toBe(false);
      expect(ledger.balanceOf(alice)).toBe(50);
      expect(ledger.balanceOf(bob)).toBe(0);
      expect(ledger.has(tx)).toBe(false);
    });

    test('rejects a transaction that was already added, whatever object holds it', () => {
      ledger.reward(alice);
      const tx = Transaction.sign(aliceKey, bob, 10);
      ledger.add(tx);

      expect(ledger.add(JSON.parse(JSON.stringify(tx)))).toBe(false);
      expect(ledger.balanceOf(alice)).toBe(40);
      expect(ledger.balanceOf(bob)).toBe(10);
    });
  });

  describe('copy()', () => {
    test('can be changed without changing the original', () => {
      ledger.reward(alice);
      const copy = ledger.copy();
      const tx = Transaction.sign(aliceKey, bob, 10);

      copy.add(tx);

      expect(copy.balanceOf(alice)).toBe(40);
      expect(ledger.balanceOf(alice)).toBe(50);
      expect(ledger.has(tx)).toBe(false);
    });
  });
});
