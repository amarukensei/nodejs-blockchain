// In-memory node-persist: every node gets its own empty storage
jest.mock('node-persist', () => ({
  create: () => {
    const data = {};
    return {
      init: async () => {},
      getItem: async (key) => data[key],
      setItem: async (key, value) => {
        data[key] = JSON.parse(JSON.stringify(value));
      },
      data: async () => Object.keys(data).map((key) => ({ key, value: data[key] })),
    };
  },
}));
// The nodes of a production network, which only exist where one is set up
jest.mock('../../../config/nodes.prod.json', () => ['https://node1.example.com', 'https://node2.example.com'], { virtual: true });

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const request = require('supertest');
const { createApp, startServer } = require('../../app');
const Blockchain = require('../../models/blockchain');
const keys = require('../../models/keys');
const Nodes = require('../../models/nodes');
const Transaction = require('../../models/transaction');
const nodesConfig = require('../../../config/nodes.json');

const GENESIS_HASH = '000df523e6d840db7ba3645a8fac03019068ba80271be87534a76829d354c5bc';

const aliceKey = crypto.generateKeyPairSync('ed25519').privateKey;
const malloryKey = crypto.generateKeyPairSync('ed25519').privateKey;
const alice = keys.addressOf(aliceKey);
const mallory = keys.addressOf(malloryKey);
const randomAddress = () => crypto.randomBytes(32).toString('hex');

// Body of a request with a payment from alice, as `node wallet sign` prints it
const signedTransaction = (amount = 1) => JSON.parse(JSON.stringify(Transaction.sign(aliceKey, randomAddress(), amount)));

let lastPort = 0;
const initialEnv = { ...process.env };

// A chain two blocks longer than a new node's, with a payment from alice, as another node would send it
async function peerChain(minerKey = aliceKey) {
  const peer = new Blockchain('peer-host', ++lastPort, { miner: minerKey });
  await peer.init();
  await peer.mineBlock();
  peer.transactions.restore([Transaction.sign(aliceKey, randomAddress(), 1)], peer);
  await peer.mineBlock();
  return JSON.parse(JSON.stringify(peer.blocks));
}

// Makes config/<name> (the list of authorized miners) have `content`
function mockMinersFile(name, content) {
  const file = path.join(__dirname, '../../../config', name);
  const { existsSync, readFileSync } = fs;
  jest.spyOn(fs, 'existsSync').mockImplementation((p) => p == file || existsSync(p));
  jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => (p == file ? content : readFileSync(p, ...args)));
}

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...initialEnv };
});

describe('Blockchain API Integration Tests', () => {
  let app;
  let blockchain;

  beforeEach(async () => {
    // Other nodes are unreachable unless a test says otherwise
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Every test gets a node with a new chain, whose blocks alice mines
    app = await createApp('127.0.0.1', ++lastPort, { miner: aliceKey, authorizedMiners: [] });
    blockchain = app.locals.blockchain;
  });

  // Mines a block like the node does in the background, whose reward gives alice 50 coins
  const mine = () => blockchain.mineBlock();

  describe('GET /nodes', () => {
    test('should return 200 and the other nodes from config/nodes.json', async () => {
      const response = await request(app).get('/nodes');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(nodesConfig);
    });
  });

  describe('POST /transaction', () => {
    test('Success: should add a signed transaction, return success and share it with the other nodes', async () => {
      await mine();
      const transactionData = signedTransaction();
      const response = await request(app)
        .post('/transaction')
        .send(transactionData);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: 1 });

      // Verify by getting transactions
      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toEqual([transactionData]);

      for (const node of nodesConfig) {
        expect(fetch).toHaveBeenCalledWith(node + '/transaction', expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(transactionData),
        }));
      }
    });

    test.each([
      ['missing "from"', ({ from, ...tx }) => tx, 'Transaction "from" is mandatory'],
      ['"from" is not an address', (tx) => ({ ...tx, from: { $gt: '' } }), 'Transaction "from" must be an address (a public key of 64 hexadecimal characters)'],
      ['a negative amount', (tx) => ({ ...tx, amount: -100 }), 'Transaction "amount" must be a positive integer'],
      ['a decimal amount', (tx) => ({ ...tx, amount: 2.5 }), 'Transaction "amount" must be a positive integer'],
      ['a changed amount', (tx) => ({ ...tx, amount: 2 }), 'Transaction "signature" is not valid'],
      ['no signature', ({ signature, ...tx }) => tx, 'Transaction "signature" is mandatory'],
      ['the format of old versions', () => ({ from: 'wallet1', to: 'wallet2', amount: 100 }), 'Transaction "from" must be an address (a public key of 64 hexadecimal characters)'],
    ])('Failure (invalid data): should return 406 for %s', async (description, build, error) => {
      await mine();
      fetch.mockClear();
      const response = await request(app)
        .post('/transaction')
        .send(build(signedTransaction()));
      expect(response.status).toBe(406);
      expect(response.body).toEqual({ error });

      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    test('Failure (insufficient balance): should return 406', async () => {
      await mine();
      const response = await request(app)
        .post('/transaction')
        .send(signedTransaction(51));
      expect(response.status).toBe(406);
      expect(response.body).toEqual({ error: 'Insufficient balance' });
    });

    test('Failure (not JSON): should return 406', async () => {
      const response = await request(app)
        .post('/transaction')
        .type('form')
        .send(signedTransaction());
      expect(response.status).toBe(406);
      expect(response.body).toEqual({ error: 'Transaction "from" is mandatory' });
    });

    test('Failure (malformed JSON): should return 400 without a stack trace', async () => {
      const response = await request(app)
        .post('/transaction')
        .set('Content-Type', 'application/json')
        .send('{"from":');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: expect.any(String) });
      expect(response.text).not.toMatch(/node_modules|\.js:\d+/);
    });

    test('Failure (body too large): should return 413', async () => {
      const response = await request(app)
        .post('/transaction')
        .send({ ...signedTransaction(), from: 'a'.repeat(20 * 1024) });
      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: 'request entity too large' });
    });

    test('Failure (replay): should not accept the same transaction twice, before or after mining it', async () => {
      await mine();
      const transactionData = signedTransaction();
      await request(app).post('/transaction').send(transactionData);

      let response = await request(app).post('/transaction').send(transactionData);
      expect(response.status).toBe(406);
      expect(response.body).toEqual({ error: 'Transaction already received' });

      await mine();
      response = await request(app).post('/transaction').send(transactionData);
      expect(response.status).toBe(406);
      expect(response.body).toEqual({ error: 'Transaction already received' });

      const blockchainResponse = await request(app).get('/blockchain');
      expect(blockchainResponse.body[2].transactions).toEqual([transactionData]);
    });
  });

  describe('GET /transactions', () => {
    test('should initially return an empty array', async () => {
      const response = await request(app).get('/transactions');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe('Mining', () => {
    test('should not be possible through the API anymore', async () => {
      const response = await request(app).get('/mine');
      expect(response.status).toBe(404);
      expect(blockchain.blocks).toHaveLength(1);
    });

    test('should put the pending transactions in a block signed by the miner and notify the other nodes', async () => {
      await mine();
      const tx1 = signedTransaction();
      await request(app).post('/transaction').send(tx1);
      fetch.mockClear();

      await mine();

      // Verify transactions are cleared
      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toEqual([]);

      // Verify blockchain includes the new block
      const blockchainResponse = await request(app).get('/blockchain');
      expect(blockchainResponse.body).toHaveLength(3);
      const block = blockchainResponse.body[2];
      expect(block).toMatchObject({ index: 2, previousHash: blockchainResponse.body[1].hash, difficulty: 12, miner: alice, transactions: [tx1] });
      expect(block.hash).toMatch(/^000[0-9a-f]{61}$/);
      expect(keys.verify(alice, block.hash, block.signature)).toBe(true);

      expect(fetch).toHaveBeenCalledTimes(nodesConfig.length);
      for (const node of nodesConfig) {
        expect(fetch).toHaveBeenCalledWith(node + '/resolve', expect.objectContaining({ redirect: 'error' }));
      }
    });

    test('should give the miner the reward even without pending transactions', async () => {
      await mine();

      const response = await request(app).get('/blockchain/1');
      expect(response.body).toMatchObject({ index: 1, previousHash: GENESIS_HASH, miner: alice, transactions: [] });
      const balanceResponse = await request(app).get('/balance/' + alice);
      expect(balanceResponse.body).toEqual({ address: alice, balance: 50 });
    });
  });

  describe('GET /balance/:address', () => {
    test('should return the balance of an address', async () => {
      await mine();
      const tx = signedTransaction(20);
      await request(app).post('/transaction').send(tx);
      await mine();

      let response = await request(app).get('/balance/' + alice);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ address: alice, balance: 50 - 20 + 50 });

      response = await request(app).get('/balance/' + tx.to);
      expect(response.body).toEqual({ address: tx.to, balance: 20 });
    });

    test('should return 0 for addresses without transactions', async () => {
      const address = randomAddress();
      const response = await request(app).get('/balance/' + address);
      expect(response.body).toEqual({ address, balance: 0 });
    });

    test('should return 400 for something that is not an address', async () => {
      const response = await request(app).get('/balance/alice');
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid address' });
    });
  });

  describe('GET /blockchain', () => {
    test('should return the blockchain (initially genesis block)', async () => {
      const response = await request(app).get('/blockchain');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([{
        index: 0,
        previousHash: '0000000000000000',
        hash: GENESIS_HASH,
        timestamp: 1790294400,
        nonce: 1287,
        difficulty: 12,
        miner: null,
        signature: null,
        transactions: [],
      }]);
    });

    test('should return the blocks from index "from" on', async () => {
      await mine();
      await mine();
      const chain = (await request(app).get('/blockchain')).body;

      let response = await request(app).get('/blockchain?from=1');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(chain.slice(1));

      response = await request(app).get('/blockchain?from=0');
      expect(response.body).toEqual(chain);

      response = await request(app).get('/blockchain?from=3');
      expect(response.body).toEqual([]);
    });

    test.each(['abc', '-1', '1.5', '', '1&from=2'])('should return 400 when "from" is not the index of a block (%s)', async (from) => {
      const response = await request(app).get('/blockchain?from=' + from);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: '"from" must be the index of a block' });
    });
  });

  describe('GET /blockchain/:idx', () => {
    test('Valid index: should return the correct block', async () => {
      await mine();
      const tx = signedTransaction();
      await request(app).post('/transaction').send(tx);
      await mine();

      let response = await request(app).get('/blockchain/0');
      expect(response.status).toBe(200);
      expect(response.body.index).toBe(0);

      response = await request(app).get('/blockchain/2');
      expect(response.status).toBe(200);
      expect(response.body.index).toBe(2);
      expect(response.body.transactions).toEqual([tx]);
    });

    test.each(['999', 'abc'])('Invalid index (%s): should return 200 and empty array', async (idx) => {
      const response = await request(app).get('/blockchain/' + idx);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe('GET /blockchain/last-index', () => {
    test('should return the index of the last block', async () => {
      let response = await request(app).get('/blockchain/last-index');
      expect(response.status).toBe(200);
      expect(response.body).toBe(0);

      await mine();

      response = await request(app).get('/blockchain/last-index');
      expect(response.body).toBe(1);
    });
  });

  describe('GET /resolve', () => {
    test('should adopt a valid chain with more work from another node, with its balances', async () => {
      const chain = await peerChain();
      fetch.mockImplementation(async (url) => {
        if (url == nodesConfig[0] + '/blockchain') {
          return Response.json(chain);
        }
        throw new TypeError('fetch failed');
      });

      const response = await request(app).get('/resolve');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { synced: nodesConfig[0] },
        { error: 'Failed to reach node at ' + nodesConfig[1] },
        { error: 'Failed to reach node at ' + nodesConfig[2] },
      ]);

      const blockchainResponse = await request(app).get('/blockchain');
      expect(blockchainResponse.body).toEqual(chain);
      const balanceResponse = await request(app).get('/balance/' + alice);
      expect(balanceResponse.body.balance).toBe(2 * 50 - 1);
    });

    test('should keep its chain when another node sends a tampered one', async () => {
      const chain = await peerChain();
      chain[2].transactions[0].amount = 50;
      fetch.mockImplementation(async () => Response.json(chain));

      const response = await request(app).get('/resolve');
      expect(response.status).toBe(500);
      expect(response.body).toEqual(nodesConfig.map((node) => ({ error: 'Invalid blockchain received from node at ' + node })));

      const blockchainResponse = await request(app).get('/blockchain');
      expect(blockchainResponse.body).toHaveLength(1);
    });

    test.each([null, { error: 'Not found' }, 'blocks'])('should keep its chain when another node answers %j instead of a chain', async (answer) => {
      fetch.mockImplementation(async () => Response.json(answer));

      const response = await request(app).get('/resolve');
      expect(response.status).toBe(500);
      expect(response.body).toEqual(nodesConfig.map((node) => ({ error: 'Invalid blockchain received from node at ' + node })));
      expect(blockchain.blocks).toHaveLength(1);
    });

    test('should return 500 when no node can be reached', async () => {
      const response = await request(app).get('/resolve');
      expect(response.status).toBe(500);
      expect(response.body).toEqual(nodesConfig.map((node) => ({ error: 'Failed to reach node at ' + node })));
    });
  });

  describe('Hardening', () => {
    test('should answer unknown routes with a JSON 404', async () => {
      const response = await request(app).get('/block/0');
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not found' });
    });

    test('should send security headers and not reveal the framework', async () => {
      const response = await request(app).get('/nodes');
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBeDefined();
    });

    test('should rate limit each client', async () => {
      process.env.RATE_LIMIT_MAX = '3';
      const limitedApp = await createApp('127.0.0.1', ++lastPort, { miner: null, authorizedMiners: [] });

      for (let i = 0; i < 3; i++) {
        expect((await request(limitedApp).get('/nodes')).status).toBe(200);
      }
      const response = await request(limitedApp).get('/nodes');
      expect(response.status).toBe(429);
      expect(response.body).toEqual({ error: 'Too many requests, please try again later' });
    });
  });
});

describe('Miners', () => {
  let dir;

  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockchain-wallet-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Saves the private key of alice in a wallet file, as `node wallet create` does
  function aliceWallet(options = {}) {
    const file = path.join(dir, 'wallet.pem');
    fs.writeFileSync(file, aliceKey.export({ type: 'pkcs8', format: 'pem', ...options }));
    return file;
  }

  const minerOf = async (options) => (await createApp('127.0.0.1', ++lastPort, { authorizedMiners: [], ...options })).locals.blockchain;

  describe('MINER_WALLET', () => {
    test('should make the node mine for the address of the wallet', async () => {
      process.env.MINER_WALLET = aliceWallet();

      const blockchain = await minerOf();

      expect(blockchain.minerAddress).toBe(alice);
      expect(keys.addressOf(blockchain.minerKey)).toBe(alice);
    });

    test('should read an encrypted wallet with MINER_WALLET_PASSWORD', async () => {
      process.env.MINER_WALLET = aliceWallet({ cipher: 'aes-256-cbc', passphrase: 's3cret' });
      process.env.MINER_WALLET_PASSWORD = 's3cret';

      expect((await minerOf()).minerAddress).toBe(alice);
    });

    test('should not mine without it', async () => {
      const blockchain = await minerOf();

      expect(blockchain.minerKey).toBeNull();
      expect(blockchain.minerAddress).toBeNull();
    });

    test.each([
      ['is encrypted and there is no MINER_WALLET_PASSWORD', () => {
        process.env.MINER_WALLET = aliceWallet({ cipher: 'aes-256-cbc', passphrase: 's3cret' });
      }, ' is encrypted: set MINER_WALLET_PASSWORD'],
      ['has another password', () => {
        process.env.MINER_WALLET = aliceWallet({ cipher: 'aes-256-cbc', passphrase: 's3cret' });
        process.env.MINER_WALLET_PASSWORD = 'secret';
      }, 'MINER_WALLET: Wrong password'],
      ['does not have a private key', () => {
        process.env.MINER_WALLET = path.join(dir, 'address.txt');
        fs.writeFileSync(process.env.MINER_WALLET, alice);
      }, 'MINER_WALLET: Not a private key'],
      ['does not exist', () => {
        process.env.MINER_WALLET = path.join(dir, 'missing.pem');
      }, 'ENOENT'],
    ])('should refuse to start when the wallet %s', async (description, setUp, error) => {
      setUp();
      await expect(minerOf()).rejects.toThrow(error);
    });

    test('should refuse to start with MINER_ADDRESS, which MINER_WALLET replaced', async () => {
      process.env.MINER_ADDRESS = alice;
      await expect(minerOf()).rejects.toThrow('MINER_ADDRESS was replaced by MINER_WALLET, the wallet file of the miner');
    });
  });

  describe('config/miners.json', () => {
    test('should let anyone mine when it does not exist', async () => {
      const blockchain = (await createApp('127.0.0.1', ++lastPort, { miner: malloryKey })).locals.blockchain;

      expect(blockchain.authorizedMiners).toEqual([]);
      expect(blockchain.isAuthorizedMiner(mallory)).toBe(true);
    });

    test('should only let the addresses in it mine', async () => {
      mockMinersFile('miners.json', JSON.stringify([alice]));

      const blockchain = (await createApp('127.0.0.1', ++lastPort, { miner: aliceKey })).locals.blockchain;

      expect(blockchain.authorizedMiners).toEqual([alice]);
      expect(blockchain.isAuthorizedMiner(mallory)).toBe(false);
    });

    test('should be config/miners.prod.json in production', async () => {
      process.env.NODE_ENV = 'production';
      mockMinersFile('miners.prod.json', JSON.stringify([alice]));

      const blockchain = (await createApp('127.0.0.1', ++lastPort, { miner: aliceKey })).locals.blockchain;

      expect(blockchain.authorizedMiners).toEqual([alice]);
      expect(blockchain.nodes.list).toEqual(['https://node1.example.com', 'https://node2.example.com']);
    });

    test.each([
      ['an address', JSON.stringify(alice)],
      ['a list with something that is not an address', JSON.stringify([alice, 'bob'])],
    ])('should refuse to start when it has %s instead of a list of addresses', async (description, content) => {
      mockMinersFile('miners.json', content);

      await expect(createApp('127.0.0.1', ++lastPort, { miner: aliceKey })).rejects.toThrow('miners.json must be a list of addresses');
    });

    test('should refuse to start when the miner of the node is not in it', async () => {
      await expect(createApp('127.0.0.1', ++lastPort, { miner: malloryKey, authorizedMiners: [alice] }))
        .rejects.toThrow('The address of MINER_WALLET is not in the list of authorized miners');
    });

    test('should make the node reject the chains with blocks of other miners', async () => {
      const app = await createApp('127.0.0.1', ++lastPort, { miner: null, authorizedMiners: [alice] });
      const chain = await peerChain(malloryKey);
      fetch.mockImplementation(async () => Response.json(chain));

      const response = await request(app).get('/resolve');

      expect(response.body).toEqual(nodesConfig.map((node) => ({ error: 'Invalid blockchain received from node at ' + node })));
      expect(app.locals.blockchain.blocks).toHaveLength(1);
    });
  });
});

describe('startServer', () => {
  // Creating a certificate for the tests needs the openssl command
  const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
  let dir;

  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockchain-tls-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const close = (server) => new Promise((resolve) => server.close(resolve));

  (hasOpenssl ? test : test.skip)('serves HTTPS when TLS_CERT and TLS_KEY are set', async () => {
    process.env.TLS_CERT = path.join(dir, 'cert.pem');
    process.env.TLS_KEY = path.join(dir, 'key.pem');
    spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-keyout', process.env.TLS_KEY, '-out', process.env.TLS_CERT, '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1']);

    const server = await startServer('127.0.0.1', 0);
    try {
      const response = await new Promise((resolve, reject) => {
        https.get({ host: '127.0.0.1', port: server.address().port, path: '/nodes', ca: fs.readFileSync(process.env.TLS_CERT), agent: false }, (res) => {
          let body = '';
          res.on('data', (chunk) => body += chunk);
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
      });

      expect(response).toEqual({ status: 200, body: nodesConfig });
    } finally {
      await close(server);
    }
  });

  test('refuses to start with only one of TLS_CERT and TLS_KEY', async () => {
    process.env.TLS_CERT = path.join(dir, 'cert.pem');

    await expect(startServer('127.0.0.1', 0)).rejects.toThrow('Set both TLS_CERT and TLS_KEY to use HTTPS');
  });

  test('does not warn about anything by default, as it only listens on this machine', async () => {
    const server = await startServer('127.0.0.1', 0);
    await close(server);

    expect(console.warn).not.toHaveBeenCalled();
  });

  test('warns when it can be reached from the network without HTTPS', async () => {
    const server = await startServer('0.0.0.0', 0);
    await close(server);

    expect(console.warn).toHaveBeenCalledWith('Warning: 0.0.0.0:0 can be reached from the network without HTTPS (see TLS_CERT and TLS_KEY)');
  });

  test('warns about the other nodes on other machines that it reaches without HTTPS', async () => {
    jest.spyOn(Nodes.prototype, 'insecure').mockReturnValue(['http://192.168.1.10:4000']);

    const server = await startServer('127.0.0.1', 0);
    await close(server);

    expect(console.warn).toHaveBeenCalledWith('Warning: the node at http://192.168.1.10:4000 is on another machine and is reached without HTTPS');
  });

  test('does not mine without MINER_WALLET', async () => {
    const startMining = jest.spyOn(Blockchain.prototype, 'startMining');

    const server = await startServer('127.0.0.1', 0);
    await close(server);

    expect(startMining).not.toHaveBeenCalled();
  });

  test('mines in the background with MINER_WALLET, after getting the chains of the other nodes, until it is closed', async () => {
    process.env.MINER_WALLET = path.join(dir, 'wallet.pem');
    fs.writeFileSync(process.env.MINER_WALLET, aliceKey.export({ type: 'pkcs8', format: 'pem' }));
    const startMining = jest.spyOn(Blockchain.prototype, 'startMining');

    const server = await startServer('127.0.0.1', 0);
    const url = 'http://127.0.0.1:' + server.address().port;
    try {
      // It keeps answering requests while it mines
      let lastIndex = 0;
      while (lastIndex < 2) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        lastIndex = (await request(url).get('/blockchain/last-index')).body;
      }

      expect(console.log).toHaveBeenCalledWith('Mining at 127.0.0.1:0 for ' + alice);
      expect((await request(url).get('/balance/' + alice)).body.balance).toBeGreaterThanOrEqual(2 * 50);
      expect(fetch).toHaveBeenCalledWith(nodesConfig[0] + '/blockchain', expect.anything());
    } finally {
      await close(server);
    }

    await startMining.mock.results[0].value;
    const blockchain = startMining.mock.contexts[0];
    expect(blockchain.mining).toBe(false);
    const blocks = blockchain.blocks.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(blockchain.blocks).toHaveLength(blocks);
  });
});
