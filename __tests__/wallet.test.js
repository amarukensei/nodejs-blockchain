const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Transaction = require('../src/models/transaction');

const walletScript = path.join(__dirname, '../wallet.js');

function wallet(...args) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [walletScript, ...args], { cwd: dir, encoding: 'utf8' });
  return { status, output: stdout.trim(), error: stderr.trim() };
}

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('wallet', () => {
  test('create saves a new private key, only readable by its owner, and prints its address', () => {
    const { status, output } = wallet('create');

    expect(status).toBe(0);
    expect(output).toMatch(/^[0-9a-f]{64}$/);
    const file = path.join(dir, 'wallet.pem');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(Transaction.address(crypto.createPrivateKey(fs.readFileSync(file)))).toBe(output);
  });

  test('create never overwrites an existing wallet', () => {
    wallet('create', '--file', 'alice.pem');
    const key = fs.readFileSync(path.join(dir, 'alice.pem'), 'utf8');

    const { status, error } = wallet('create', '--file', 'alice.pem');

    expect(status).toBe(1);
    expect(error).toMatch('already exists');
    expect(fs.readFileSync(path.join(dir, 'alice.pem'), 'utf8')).toBe(key);
  });

  test('address prints the address of the wallet', () => {
    const address = wallet('create', '--file', 'alice.pem').output;

    expect(wallet('address', '--file', 'alice.pem')).toEqual({ status: 0, output: address, error: '' });
  });

  test('sign prints a valid transaction from the wallet', () => {
    const alice = wallet('create', '--file', 'alice.pem').output;
    const bob = wallet('create', '--file', 'bob.pem').output;

    const { status, output } = wallet('sign', '--file', 'alice.pem', bob, '2.5');

    expect(status).toBe(0);
    const tx = JSON.parse(output);
    expect(tx).toMatchObject({ from: alice, to: bob, amount: 2.5 });
    expect(Transaction.isValid(tx)).toBe(true);
  });

  test.each([
    ['the recipient is not an address', ['bob', '1'], 'Transaction "to" must be an address'],
    ['the amount is not a number', ['0'.repeat(64), 'ten'], 'Transaction "amount" is mandatory and must be a number'],
  ])('sign fails if %s', (description, args, message) => {
    wallet('create');

    const { status, error } = wallet('sign', ...args);

    expect(status).toBe(1);
    expect(error).toMatch(message);
  });

  test('sign fails if the file is not an Ed25519 private key', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(path.join(dir, 'rsa.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));

    const { status, error } = wallet('sign', '--file', 'rsa.pem', '0'.repeat(64), '1');

    expect(status).toBe(1);
    expect(error).toBe('rsa.pem does not contain an Ed25519 private key');
  });

  test('prints the usage for unknown commands', () => {
    const { status, error } = wallet('send');

    expect(status).toBe(1);
    expect(error).toMatch(/^Usage:/);
  });
});
