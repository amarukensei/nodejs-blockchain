const crypto = require('crypto');
const fs = require('fs');
const { parseArgs } = require('util');
const Transaction = require('./src/models/transaction');

const usage = `Usage:
  node wallet create                Creates a wallet and prints its address
  node wallet address               Prints the address of the wallet
  node wallet sign <to> <amount>    Prints a transaction from the wallet, signed and ready for POST /transaction

Options:
  --file <path>    File with the private key of the wallet (default: wallet.pem)`;

function loadPrivateKey(file) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(file));
    if (privateKey.asymmetricKeyType != 'ed25519') {
        throw new Error(file + ' does not contain an Ed25519 private key');
    }
    return privateKey;
}

try {
    const { values, positionals } = parseArgs({
        options: { file: { type: 'string', default: 'wallet.pem' } },
        allowPositionals: true,
    });
    const [command, ...args] = positionals;

    if (command == 'create' && args.length == 0) {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        // Only readable by its owner, and never overwrite an existing wallet
        fs.writeFileSync(values.file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
        console.log(Transaction.address(privateKey));
    } else if (command == 'address' && args.length == 0) {
        console.log(Transaction.address(loadPrivateKey(values.file)));
    } else if (command == 'sign' && args.length == 2) {
        const [to, amount] = args;
        console.log(JSON.stringify(Transaction.sign(loadPrivateKey(values.file), to, Number(amount))));
    } else {
        console.error(usage);
        process.exitCode = 1;
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
