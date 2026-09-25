const Transaction = require('../transaction');

describe('Transaction', () => {
  describe('constructor', () => {
    test('should create a transaction with valid arguments', () => {
      const from = 'address1';
      const to = 'address2';
      const amount = 100;
      const transaction = new Transaction(from, to, amount);

      expect(transaction.from).toBe(from);
      expect(transaction.to).toBe(to);
      expect(transaction.amount).toBe(amount);
      expect(typeof transaction.timestamp).toBe('number');
    });

    test('should throw an error if "from" is missing', () => {
      expect(() => new Transaction(undefined, 'address2', 100)).toThrow('Transaction "from" is mandatory');
    });

    test('should throw an error if "to" is missing', () => {
      expect(() => new Transaction('address1', undefined, 100)).toThrow('Transaction "to" is mandatory');
    });

    test('should throw an error if "amount" is missing', () => {
      expect(() => new Transaction('address1', 'address2', undefined)).toThrow('Transaction "amount" is mandatory and must be a number');
    });

    test('should throw an error if "amount" is not a number', () => {
      expect(() => new Transaction('address1', 'address2', 'not-a-number')).toThrow('Transaction "amount" is mandatory and must be a number');
    });

    test.each([
      ['an object', { evil: true }],
      ['an array', ['address1']],
      ['a number', 12345],
      ['longer than 256 characters', 'a'.repeat(257)],
    ])('should throw an error if an address is %s', (description, address) => {
      expect(() => new Transaction(address, 'address2', 100)).toThrow('Transaction "from" must be a string of up to 256 characters');
      expect(() => new Transaction('address1', address, 100)).toThrow('Transaction "to" must be a string of up to 256 characters');
    });

    test('should accept addresses of 256 characters', () => {
      expect(() => new Transaction('a'.repeat(256), 'b'.repeat(256), 1)).not.toThrow();
    });

    test.each([0, -5, Infinity, -Infinity])('should throw an error if "amount" is %p', (amount) => {
      expect(() => new Transaction('address1', 'address2', amount)).toThrow('Transaction "amount" must be a positive number');
    });
  });

  describe('isValid', () => {
    const roundTrip = (value) => JSON.parse(JSON.stringify(value));

    test('accepts a transaction created by the constructor once serialized', () => {
      expect(Transaction.isValid(roundTrip(new Transaction('address1', 'address2', 2.5)))).toBe(true);
    });

    test.each([
      ['null', null],
      ['an array', []],
      ['a string', 'tx'],
      ['missing the timestamp', { from: 'a', to: 'b', amount: 1 }],
      ['with an extra field', { from: 'a', to: 'b', amount: 1, timestamp: 1, evil: 'x' }],
      ['with a non integer timestamp', { from: 'a', to: 'b', amount: 1, timestamp: 'now' }],
      ['with a negative amount', { from: 'a', to: 'b', amount: -1, timestamp: 1 }],
      ['with an object address', { from: {}, to: 'b', amount: 1, timestamp: 1 }],
    ])('rejects %s', (description, tx) => {
      expect(Transaction.isValid(tx)).toBe(false);
    });
  });
});
