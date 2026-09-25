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
const request = require('supertest');
const { createApp } = require('../../app');
const Blockchain = require('../../models/blockchain');
const Transaction = require('../../models/transaction');
const Transactions = require('../../models/transactions');
const nodesConfig = require('../../../config/nodes.json');

const GENESIS_HASH = '00002818703517bab21046d807a3fc0284b8a05979ce48baa40ed2eeeadd3b92';

const aliceKey = crypto.generateKeyPairSync('ed25519').privateKey;
const alice = Transaction.address(aliceKey);
const bob = Transaction.address(crypto.generateKeyPairSync('ed25519').privateKey);

// Body of a request with a transaction signed by alice, as `node wallet sign` prints it
let lastAmount = 0;
const signedTransaction = (to = bob, amount = ++lastAmount) => JSON.parse(JSON.stringify(Transaction.sign(aliceKey, to, amount)));

let lastPort = 0;

// A chain one block longer than a new node's, as another node would send it
async function peerChain() {
  const peer = new Blockchain('peer-host', ++lastPort);
  await peer.init();
  const transactions = new Transactions();
  transactions.list.push(Transaction.sign(aliceKey, bob, ++lastAmount));
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

    // Every test gets a node with a new chain
    app = await createApp('127.0.0.1', ++lastPort);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.RATE_LIMIT_MAX;
  });

  describe('GET /nodes', () => {
    test('should return 200 and the other nodes from config/nodes.json', async () => {
      const response = await request(app).get('/nodes');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(nodesConfig);
    });
  });

  describe('POST /transaction', () => {
    test('Success: should add a signed transaction and return success', async () => {
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
      ['a negative amount', (tx) => ({ ...tx, amount: -100 }), 'Transaction "amount" must be a positive number'],
      ['a changed amount', (tx) => ({ ...tx, amount: 1000000 }), 'Transaction "signature" is not valid'],
      ['no signature', ({ signature, ...tx }) => tx, 'Transaction "signature" is mandatory'],
      ['the format of old versions', () => ({ from: 'wallet1', to: 'wallet2', amount: 100 }), 'Transaction "from" must be an address (a public key of 64 hexadecimal characters)'],
    ])('Failure (invalid data): should return 406 for %s', async (description, build, error) => {
      const response = await request(app)
        .post('/transaction')
        .send(build(signedTransaction()));
      expect(response.status).toBe(406);
      expect(response.body).toEqual({ error });

      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toEqual([]);
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
      expect(blockchainResponse.body[1].transactions).toEqual([transactionData]);
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
      const tx1 = signedTransaction();
      await request(app).post('/transaction').send(tx1);

      const mineResponse = await request(app).get('/mine');
      expect(mineResponse.status).toBe(200);
      expect(mineResponse.body).toMatchObject({ index: 1, previousHash: GENESIS_HASH });
      expect(mineResponse.body.hash).toMatch(/^000[0-9a-f]{61}$/);
      expect(mineResponse.body.transactions).toEqual([tx1]);

      // Verify transactions are cleared
      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toEqual([]);

      // Verify blockchain includes the new block
      const blockchainResponse = await request(app).get('/blockchain');
      expect(blockchainResponse.body).toHaveLength(2);
      expect(blockchainResponse.body[1]).toEqual(mineResponse.body);

      for (const node of nodesConfig) {
        expect(fetch).toHaveBeenCalledWith(node + '/resolve', expect.objectContaining({ redirect: 'error' }));
      }
    });

    test('Without pending transactions: should return 500 error', async () => {
      const mineResponse = await request(app).get('/mine');
      expect(mineResponse.status).toBe(500);
      expect(mineResponse.body).toEqual({ error: 'No transactions to be mined' });
    });
  });

  describe('GET /blockchain', () => {
    test('should return the blockchain (initially genesis block)', async () => {
      const response = await request(app).get('/blockchain');
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1); // Only genesis block
      expect(response.body[0]).toMatchObject({ index: 0, previousHash: '0000000000000000', hash: GENESIS_HASH });
    });
  });

  describe('GET /blockchain/:idx', () => {
    test('Valid index: should return the correct block', async () => {
      const tx = signedTransaction();
      await request(app).post('/transaction').send(tx);
      await request(app).get('/mine');

      let response = await request(app).get('/blockchain/0');
      expect(response.status).toBe(200);
      expect(response.body.index).toBe(0);

      response = await request(app).get('/blockchain/1');
      expect(response.status).toBe(200);
      expect(response.body.index).toBe(1);
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

      await request(app).post('/transaction').send(signedTransaction());
      await request(app).get('/mine');

      response = await request(app).get('/blockchain/last-index');
      expect(response.body).toBe(1);
    });
  });

  describe('GET /resolve', () => {
    test('should adopt a longer valid chain from another node', async () => {
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
    });

    test('should keep its chain when another node sends a tampered one', async () => {
      const chain = await peerChain();
      chain[1].transactions[0].amount = 1000000;
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
  });
});
