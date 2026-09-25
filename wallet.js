const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');
const { Writable } = require('stream');
const { parseArgs } = require('util');
const Transaction = require('./src/models/transaction');

const usage = `Usage:
  node wallet create                Creates a wallet and prints its address
  node wallet address               Prints the address of the wallet
  node wallet sign <to> <amount>    Prints a transaction from the wallet, signed and ready for POST /transaction

Options:
  --file <path>    File with the private key of the wallet (default: wallet.pem)`;

let rl;
let lines;

// Asks for a password without showing what is typed. When stdin is not a terminal,
// each password is read from one of its lines.
async function askPassword(question) {
    if (!rl) {
        const hidden = new Writable({ write: (chunk, encoding, callback) => callback() });
        rl = readline.createInterface({ input: process.stdin, output: hidden, terminal: Boolean(process.stdin.isTTY) });
        rl.on('SIGINT', () => process.exit(130));
        lines = rl[Symbol.asyncIterator]();
    }

    process.stderr.write(question);
    const { value = '' } = await lines.next();
    if (process.stdin.isTTY) {
        process.stderr.write('\n');
    }
    return value;
}

async function createWallet(file) {
    if (fs.existsSync(file)) {
        throw new Error(file + ' already exists');
    }

    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const password = await askPassword('Password to encrypt the wallet (empty for none): ');
    if (password && password !== await askPassword('Repeat the password: ')) {
        throw new Error('The passwords do not match');
    }

    const encryption = password ? { cipher: 'aes-256-cbc', passphrase: password } : {};
    // Only readable by its owner, and never overwrite an existing wallet
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem', ...encryption }), { mode: 0o600, flag: 'wx' });
    return Transaction.address(privateKey);
}

async function loadPrivateKey(file) {
    const pem = fs.readFileSync(file, 'utf8');
    let privateKey;

    if (pem.includes('ENCRYPTED PRIVATE KEY')) {
        const passphrase = await askPassword('Password of ' + file + ': ');
        try {
            privateKey = crypto.createPrivateKey({ key: pem, passphrase });
        } catch (error) {
            throw new Error('Wrong password for ' + file);
        }
    } else {
        privateKey = crypto.createPrivateKey(pem);
    }

    if (privateKey.asymmetricKeyType != 'ed25519') {
        throw new Error(file + ' does not contain an Ed25519 private key');
    }
    return privateKey;
}

async function main() {
    const { values, positionals } = parseArgs({
        options: { file: { type: 'string', default: 'wallet.pem' } },
        allowPositionals: true,
    });
    const [command, ...args] = positionals;

    if (command == 'create' && args.length == 0) {
        console.log(await createWallet(values.file));
    } else if (command == 'address' && args.length == 0) {
        console.log(Transaction.address(await loadPrivateKey(values.file)));
    } else if (command == 'sign' && args.length == 2) {
        const [to, amount] = args;
        console.log(JSON.stringify(Transaction.sign(await loadPrivateKey(values.file), to, Number(amount))));
    } else {
        console.error(usage);
        process.exitCode = 1;
    }
}

main()
    .catch(function(error) {
        console.error(error.message);
        process.exitCode = 1;
    })
    .finally(function() {
        rl?.close();
    });
