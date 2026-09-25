const crypto = require('crypto');
const keys = require('../keys');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const address = keys.addressOf(privateKey);

describe('keys', () => {
  test('the address of a key pair is its public key in hexadecimal', () => {
    expect(address).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.addressOf(publicKey)).toBe(address);
    expect(keys.isAddress(address)).toBe(true);
    expect(keys.isAddress(address.toUpperCase())).toBe(false);
  });

  test('verifies signatures made with the private key of an address', () => {
    const signature = keys.sign(privateKey, 'some data');

    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(keys.verify(address, 'some data', signature)).toBe(true);
    expect(keys.verify(address, 'other data', signature)).toBe(false);
    expect(keys.verify(keys.addressOf(crypto.generateKeyPairSync('ed25519').publicKey), 'some data', signature)).toBe(false);
    expect(keys.verify(address, 'some data', signature.toUpperCase())).toBe(false);
    expect(keys.verify(address, 'some data', null)).toBe(false);
    expect(keys.verify('mallory', 'some data', signature)).toBe(false);
  });

  describe('readPrivateKey', () => {
    test('reads a wallet file', () => {
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

      expect(keys.isEncrypted(pem)).toBe(false);
      expect(keys.addressOf(keys.readPrivateKey(pem))).toBe(address);
    });

    test('decrypts a wallet file with its password', () => {
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 's3cret' });

      expect(keys.isEncrypted(pem)).toBe(true);
      expect(keys.addressOf(keys.readPrivateKey(pem, 's3cret'))).toBe(address);
      expect(() => keys.readPrivateKey(pem, 'secret')).toThrow('Wrong password');
      expect(() => keys.readPrivateKey(pem)).toThrow('Wrong password');
    });

    test('rejects keys that are not Ed25519 private keys', () => {
      const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

      expect(() => keys.readPrivateKey(rsa)).toThrow('Not an Ed25519 private key');
      expect(() => keys.readPrivateKey('not a key')).toThrow('Not a private key');
    });
  });
});
