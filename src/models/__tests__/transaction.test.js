const crypto = require('crypto');
const Transaction = require('../transaction');

const aliceKey = crypto.generateKeyPairSync('ed25519').privateKey;
const bobKey = crypto.generateKeyPairSync('ed25519').privateKey;
const alice = Transaction.address(aliceKey);
const bob = Transaction.address(bobKey);

const roundTrip = (value) => JSON.parse(JSON.stringify(value));

// Fields of a transaction from alice to bob, as a client would send them
function signedFields(amount = 100, timestamp = 1790000000) {
  return roundTrip(Transaction.sign(aliceKey, bob, amount, timestamp));
}

function create({ from, to, amount, timestamp, signature }) {
  return new Transaction(from, to, amount, timestamp, signature);
}

describe('Transaction', () => {
  describe('address', () => {
    test('is the public key in hexadecimal, from the private or the public key', () => {
      expect(alice).toMatch(/^[0-9a-f]{64}$/);
      expect(Transaction.address(crypto.createPublicKey(aliceKey))).toBe(alice);
    });
  });

  describe('sign', () => {
    test('creates a transaction from the owner of the key, signed with it', () => {
      const transaction = Transaction.sign(aliceKey, bob, 2.5, 1790000000);

      expect(transaction).toBeInstanceOf(Transaction);
      expect(transaction).toMatchObject({ from: alice, to: bob, amount: 2.5, timestamp: 1790000000 });
      expect(transaction.signature).toMatch(/^[0-9a-f]{128}$/);
      const message = Buffer.from(JSON.stringify({ from: alice, to: bob, amount: 2.5, timestamp: 1790000000 }));
      expect(crypto.verify(null, message, crypto.createPublicKey(aliceKey), Buffer.from(transaction.signature, 'hex'))).toBe(true);
    });

    test('uses the current time by default', () => {
      const transaction = Transaction.sign(aliceKey, bob, 1);
      expect(Math.abs(transaction.timestamp - Date.now() / 1000)).toBeLessThan(5);
    });
  });

  describe('constructor', () => {
    test('should create a transaction with a valid signature', () => {
      const fields = signedFields();
      const transaction = create(fields);

      expect(transaction.from).toBe(alice);
      expect(transaction.to).toBe(bob);
      expect(transaction.amount).toBe(100);
      expect(transaction.timestamp).toBe(fields.timestamp);
      expect(transaction.signature).toBe(fields.signature);
    });

    test('should throw an error if "from" is missing', () => {
      expect(() => create({ ...signedFields(), from: undefined })).toThrow('Transaction "from" is mandatory');
    });

    test('should throw an error if "to" is missing', () => {
      expect(() => create({ ...signedFields(), to: undefined })).toThrow('Transaction "to" is mandatory');
    });

    test.each([
      ['a name', 'alice'],
      ['an object', { evil: true }],
      ['a number', 12345],
      ['uppercase hexadecimal', 'A'.repeat(64)],
      ['too long', 'a'.repeat(66)],
    ])('should throw an error if an address is %s', (description, address) => {
      expect(() => create({ ...signedFields(), from: address })).toThrow('Transaction "from" must be an address (a public key of 64 hexadecimal characters)');
      expect(() => create({ ...signedFields(), to: address })).toThrow('Transaction "to" must be an address (a public key of 64 hexadecimal characters)');
    });

    test('should throw an error if "amount" is missing', () => {
      expect(() => create({ ...signedFields(), amount: undefined })).toThrow('Transaction "amount" is mandatory and must be a number');
    });

    test('should throw an error if "amount" is not a number', () => {
      expect(() => create({ ...signedFields(), amount: 'not-a-number' })).toThrow('Transaction "amount" is mandatory and must be a number');
    });

    test.each([0, -5, Infinity, -Infinity])('should throw an error if "amount" is %p', (amount) => {
      expect(() => create({ ...signedFields(), amount })).toThrow('Transaction "amount" must be a positive number');
    });

    test.each([undefined, 'now', 1.5, -1])('should throw an error if "timestamp" is %p', (timestamp) => {
      expect(() => create({ ...signedFields(), timestamp })).toThrow('Transaction "timestamp" is mandatory and must be a Unix time in seconds');
    });

    test('should throw an error if "signature" is missing', () => {
      expect(() => create({ ...signedFields(), signature: undefined })).toThrow('Transaction "signature" is mandatory');
    });

    test.each([
      ['the amount changed', (fields) => ({ ...fields, amount: 5000 })],
      ['the recipient changed', (fields) => ({ ...fields, to: alice })],
      ['the timestamp changed', (fields) => ({ ...fields, timestamp: fields.timestamp + 1 })],
      ['somebody else as the sender', (fields) => ({ ...fields, from: bob })],
      ['a signature of other data', (fields) => ({ ...fields, signature: signedFields(1).signature })],
      ['a malformed signature', (fields) => ({ ...fields, signature: 'abc' })],
      ['an uppercase signature', (fields) => ({ ...fields, signature: fields.signature.toUpperCase() })],
    ])('should throw an error for a transaction with %s', (description, tamper) => {
      expect(() => create(tamper(signedFields()))).toThrow('Transaction "signature" is not valid');
    });

    test('should throw an error if the sender is not a valid public key', () => {
      expect(() => create({ ...signedFields(), from: '0'.repeat(64) })).toThrow('Transaction "signature" is not valid');
    });
  });

  describe('message', () => {
    test('is the JSON of every field but the signature', () => {
      const fields = signedFields(2.5, 1790000000);
      expect(Transaction.message(fields)).toBe(`{"from":"${alice}","to":"${bob}","amount":2.5,"timestamp":1790000000}`);
    });
  });

  describe('isValid', () => {
    test('accepts a signed transaction once serialized', () => {
      expect(Transaction.isValid(signedFields())).toBe(true);
    });

    test.each([
      ['null', () => null],
      ['an array', () => []],
      ['a string', () => 'tx'],
      ['a transaction without signature', ({ signature, ...fields }) => fields],
      ['a transaction with an extra field', (fields) => ({ ...fields, evil: 'x' })],
      ['a tampered transaction', (fields) => ({ ...fields, amount: 5000 })],
      ['a transaction from an old version', () => ({ from: 'alice', to: 'bob', amount: 1, timestamp: 1 })],
    ])('rejects %s', (description, build) => {
      expect(Transaction.isValid(build(signedFields()))).toBe(false);
    });
  });
});
