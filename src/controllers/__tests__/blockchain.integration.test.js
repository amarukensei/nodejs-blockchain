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

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const request = require('supertest');
const { createApp, startServer } = require('../../app');
const Blockchain = require('../../models/blockchain');
const Transaction = require('../../models/transaction');
const Transactions = require('../../models/transactions');
const nodesConfig = require('../../../config/nodes.json');

const GENESIS_HASH = '00021b0673ecfef60a2e414ec216fcd57d4abb7314b30e35c7e13b205b84743e';

const aliceKey = crypto.generateKeyPairSync('ed25519').privateKey;
const alice = Transaction.address(aliceKey);
const randomAddress = () => crypto.randomBytes(32).toString('hex');

// Body of a request with a payment from alice, as `node wallet sign` prints it
const signedTransaction = (amount = 1) => JSON.parse(JSON.stringify(Transaction.sign(aliceKey, randomAddress(), amount)));

let lastPort = 0;

// A chain two blocks longer than a new node's, as another node would send it
async function peerChain() {
  const peer = new Blockchain('peer-host', ++lastPort, alice);
  await peer.init();
  peer.mine(new Transactions(), { status: jest.fn() });
  const transactions = new Transactions();
  transactions.list.push(Transaction.sign(aliceKey, randomAddress(), 1));
  peer.mine(transactions, { status: jest.fn() });
  return JSON.parse(JSON.stringify(peer.blocks));
}

describe('Blockchain API Integration Tests', () => {
  let app;

  beforeEach(async () => {
    // Other nodes are unreachable unless a test says otherwise
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Every test gets a node with a new chain, whose rewards go to alice
    process.env.MINER_ADDRESS = alice;
    app = await createApp('127.0.0.1', ++lastPort);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.MINER_ADDRESS;
    delete process.env.RATE_LIMIT_MAX;
  });

  // Mines a block, whose reward gives alice 50 coins
  const fundAlice = () => request(app).get('/mine');

  describe('GET /nodes', () => {
    test('should return 200 and the other nodes from config/nodes.json', async () => {
      const response = await request(app).get('/nodes');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(nodesConfig);
    });
  });

  describe('POST /transaction', () => {
    test('Success: should add a signed transaction and return success', async () => {
      await fundAlice();
      const transactionData = signedTransaction();
      const response = await request(app)
        .post('/transaction')
        .send(transactionData);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: 1 });

      // Verify by getting transactions
      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toEqual([transactionData]);
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
      await fundAlice();
      const response = await request(app)
        .post('/transaction')
        .send(build(signedTransaction()));
      expect(response.status).toBe(406);
      expect(response.body).toEqual({ error });

      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toEqual([]);
    });

    test('Failure (insufficient balance): should return 406', async () => {
      await fundAlice();
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
      await fundAlice();
      const transactionData = signedTransaction();
      await request(app).post('/transaction').send(transactionData);

      let response = await request(app).post('/transaction').send(transactionData);
      expect(response.status).toBe(406);
      expect(response.body).toEqual({ error: 'Transaction already received' });

      await request(app).get('/mine');
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

  describe('GET /mine', () => {
    test('With pending transactions: should mine a block, return it and notify the other nodes', async () => {
      await fundAlice();
      const tx1 = signedTransaction();
      await request(app).post('/transaction').send(tx1);

      const mineResponse = await request(app).get('/mine');
      expect(mineResponse.status).toBe(200);
      expect(mineResponse.body).toMatchObject({ index: 2, miner: alice });
      expect(mineResponse.body.hash).toMatch(/^000[0-9a-f]{61}$/);
      expect(mineResponse.body.transactions).toEqual([tx1]);

      // Verify transactions are cleared
      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toEqual([]);

      // Verify blockchain includes the new block
      const blockchainResponse = await request(app).get('/blockchain');
      expect(blockchainResponse.body).toHaveLength(3);
      expect(blockchainResponse.body[2]).toEqual(mineResponse.body);
      expect(mineResponse.body.previousHash).toBe(blockchainResponse.body[1].hash);

      for (const node of nodesConfig) {
        expect(fetch).toHaveBeenCalledWith(node + '/resolve', expect.objectContaining({ redirect: 'error' }));
      }
    });

    test('Without pending transactions: should mine a block with just the reward', async () => {
      const mineResponse = await request(app).get('/mine');
      expect(mineResponse.status).toBe(200);
      expect(mineResponse.body).toMatchObject({ index: 1, previousHash: GENESIS_HASH, miner: alice, transactions: [] });

      const balanceResponse = await request(app).get('/balance/' + alice);
      expect(balanceResponse.body).toEqual({ address: alice, balance: 50 });
    });

    test('Without MINER_ADDRESS: should return 503 error', async () => {
      delete process.env.MINER_ADDRESS;
      const nodeWithoutMiner = await createApp('127.0.0.1', ++lastPort);

      const mineResponse = await request(nodeWithoutMiner).get('/mine');
      expect(mineResponse.status).toBe(503);
      expect(mineResponse.body).toEqual({ error: 'This node does not mine, as MINER_ADDRESS is not set' });
    });
  });

  describe('GET /balance/:address', () => {
    test('should return the balance of an address', async () => {
      await fundAlice();
      const tx = signedTransaction(20);
      await request(app).post('/transaction').send(tx);
      await request(app).get('/mine');

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
      expect(response.body).toHaveLength(1); // Only genesis block
      expect(response.body[0]).toMatchObject({ index: 0, previousHash: '0000000000000000', hash: GENESIS_HASH, miner: null });
    });
  });

  describe('GET /blockchain/:idx', () => {
    test('Valid index: should return the correct block', async () => {
      await fundAlice();
      const tx = signedTransaction();
      await request(app).post('/transaction').send(tx);
      await request(app).get('/mine');

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

      await request(app).get('/mine');

      response = await request(app).get('/blockchain/last-index');
      expect(response.body).toBe(1);
    });
  });

  describe('GET /resolve', () => {
    test('should adopt a longer valid chain from another node, with its balances', async () => {
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
      const limitedApp = await createApp('127.0.0.1', ++lastPort);

      for (let i = 0; i < 3; i++) {
        expect((await request(limitedApp).get('/nodes')).status).toBe(200);
      }
      const response = await request(limitedApp).get('/nodes');
      expect(response.status).toBe(429);
      expect(response.body).toEqual({ error: 'Too many requests, please try again later' });
    });

    test('should refuse to start with a MINER_ADDRESS that is not an address', async () => {
      process.env.MINER_ADDRESS = 'alice';
      await expect(createApp('127.0.0.1', ++lastPort)).rejects.toThrow('MINER_ADDRESS must be an address');
    });
  });
});

describe('startServer', () => {
  // Creating a certificate for the tests needs the openssl command
  const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
  let dir;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockchain-tls-test-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.TLS_CERT;
    delete process.env.TLS_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });

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
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('refuses to start with only one of TLS_CERT and TLS_KEY', async () => {
    process.env.TLS_CERT = path.join(dir, 'cert.pem');

    await expect(startServer('127.0.0.1', 0)).rejects.toThrow('Set both TLS_CERT and TLS_KEY to use HTTPS');
  });
});
