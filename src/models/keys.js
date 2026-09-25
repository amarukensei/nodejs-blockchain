const crypto = require('crypto');

// Addresses are Ed25519 public keys and signatures are Ed25519 signatures, both hex encoded
const ADDRESS_FORMAT = /^[0-9a-f]{64}$/;
const SIGNATURE_FORMAT = /^[0-9a-f]{128}$/;

function isAddress(address) {
    return typeof address === 'string' && ADDRESS_FORMAT.test(address);
}

// Address of a key pair, given its private or its public key (as KeyObjects)
function addressOf(key) {
    const publicKey = key.type == 'private' ? crypto.createPublicKey(key) : key;
    return Buffer.from(publicKey.export({format: 'jwk'}).x, 'base64url').toString('hex');
}

function sign(privateKey, data) {
    return crypto.sign(null, Buffer.from(data), privateKey).toString('hex');
}

// Whether signature is the signature of data made with the private key of address
function verify(address, data, signature) {
    if (!isAddress(address) || typeof signature !== 'string' || !SIGNATURE_FORMAT.test(signature)) {
        return false;
    }

    const publicKey = crypto.createPublicKey({
        key: {kty: 'OKP', crv: 'Ed25519', x: Buffer.from(address, 'hex').toString('base64url')},
        format: 'jwk'
    });
    return crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(signature, 'hex'));
}

// Reads the private key of a wallet file, decrypting it with the password if it is encrypted
function readPrivateKey(pem, password) {
    let privateKey;
    try {
        privateKey = crypto.createPrivateKey(isEncrypted(pem) ? {key: pem, passphrase: password} : pem);
    } catch(error) {
        throw new Error(isEncrypted(pem) ? 'Wrong password' : 'Not a private key');
    }

    if (privateKey.asymmetricKeyType != 'ed25519') {
        throw new Error('Not an Ed25519 private key');
    }
    return privateKey;
}

function isEncrypted(pem) {
    return pem.includes('ENCRYPTED PRIVATE KEY');
}

module.exports = { isAddress, addressOf, sign, verify, readPrivateKey, isEncrypted };
