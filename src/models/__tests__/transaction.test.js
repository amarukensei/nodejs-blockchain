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
  });
});
