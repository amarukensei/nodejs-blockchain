const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Use the real node-persist, but store the chains in a temporary directory
const mockStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blockchain-test-'));
jest.mock('node-persist', () => {
  const nodePersist = jest.requireActual('node-persist');
  const path = require('path');
  return {
    create: (options) => nodePersist.create({ ...options, dir: path.join(mockStorageRoot, path.basename(options.dir)) }),
  };
});
jest.mock('../nodes');

const Blockchain = require('../blockchain');
const Block = require('../block');
const Transaction = require('../transaction');
const Transactions = require('../transactions');
// A chain saved by the previous version of the app (js-sha256 and node-persist 3)
const legacyDatum = require('./fixtures/node-persist-3-blocks.json');

const GENESIS_HASH = '00002818703517bab21046d807a3fc0284b8a05979ce48baa40ed2eeeadd3b92';
const hashOf = (algorithm, data) => crypto.createHash(algorithm).update(data).digest('hex');
const roundTrip = (value) => JSON.parse(JSON.stringify(value));

let lastPort = 0;
const blockchains = [];

function newBlockchain(port = ++lastPort) {
  const blockchain = new Blockchain('test-host', port);
  blockchains.push(blockchain);
  return blockchain;
}

// Every port gets its own storage directory, so tests don't share chains
async function createBlockchain(port) {
  const blockchain = newBlockchain(port);
  await blockchain.init();
  return blockchain;
}

function storageDirOf(blockchain) {
  const dir = path.join(mockStorageRoot, path.basename(blockchain.storageDir));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mineBlocks(blockchain, count) {
  for (let i = 0; i < count; i++) {
    const transactions = new Transactions();
    transactions.list.push(new Transaction('alice', 'bob', i + 1));
    blockchain.mine(transactions, { status: jest.fn() });
  }
  return roundTrip(blockchain.blocks);
}

// Redoes the proof of work from a block onwards, like an attacker rewriting the chain would
function remine(blockchain, chain, fromIdx) {
  for (let idx = fromIdx; idx < chain.length; idx++) {
    if (idx > 0) chain[idx].previousHash = chain[idx - 1].hash;
    chain[idx].nonce = 0;
    chain[idx].hash = blockchain.generateHash(chain[idx]);
  }
  return chain;
}

afterAll(async () => {
  // Wait for the writes node-persist still has queued before deleting their directory
  await Promise.all(blockchains.map((blockchain) => blockchain.save()));
  fs.rmSync(mockStorageRoot, { recursive: true, force: true });
});

describe('Blockchain', () => {
  describe('init()', () => {
    test('creates and saves the genesis block when nothing is stored', async () => {
      const blockchain = await createBlockchain();

      expect(blockchain.blocks).toHaveLength(1);
      expect(blockchain.blocks[0]).toMatchObject({
        index: 0,
        previousHash: '0000000000000000',
        hash: GENESIS_HASH,
        nonce: 4190,
        transactions: [],
      });

      await blockchain.save();
      const reloaded = await createBlockchain(lastPort);
      expect(reloaded.blocks).toEqual(roundTrip(blockchain.blocks));
    });

    test('loads the chain saved by a previous run', async () => {
      const blockchain = await createBlockchain();
      const chain = mineBlocks(blockchain, 2);
      await blockchain.save();

      const reloaded = await createBlockchain(lastPort);

      expect(reloaded.blocks).toEqual(chain);
    });

    test('migrates a chain saved by node-persist 3, which named files after the MD5 of the key', async () => {
      const blockchain = newBlockchain();
      const dir = storageDirOf(blockchain);
      fs.writeFileSync(path.join(dir, hashOf('md5', 'blocks')), JSON.stringify(legacyDatum));

      await blockchain.init();

      expect(blockchain.blocks).toEqual(legacyDatum.value);
      const migrated = JSON.parse(fs.readFileSync(path.join(dir, hashOf('sha256', 'blocks')), 'utf8'));
      expect(migrated.value).toEqual(legacyDatum.value);
    });

    test('refuses to load a stored chain that is not valid', async () => {
      const blockchain = newBlockchain();
      const tampered = roundTrip(legacyDatum.value);
      tampered[1].transactions[0].amount = 1000000;
      fs.writeFileSync(path.join(storageDirOf(blockchain), hashOf('sha256', 'blocks')), JSON.stringify({ key: 'blocks', value: tampered }));

      await expect(blockchain.init()).rejects.toThrow('is not valid');
    });
  });

  describe('generateHash(block)', () => {
    test('finds a nonce whose hash meets the difficulty and matches the block key', async () => {
      const blockchain = await createBlockchain();
      const block = new Block();
      block.index = 1;
      block.previousHash = GENESIS_HASH;
      block.transactions = [new Transaction('alice', 'bob', 5)];

      const hash = blockchain.generateHash(block);

      expect(hash.startsWith('000')).toBe(true);
      expect(hash).toBe(hashOf('sha256', block.key));
      expect(blockchain.calculateHash(roundTrip(block))).toBe(hash);
    });
  });

  describe('mine(transactions, res)', () => {
    test('mines the pending transactions into a new block and broadcasts it', async () => {
      const blockchain = await createBlockchain();
      const transactions = new Transactions();
      transactions.list.push(new Transaction('alice', 'bob', 5));
      const mockRes = { status: jest.fn() };

      const block = blockchain.mine(transactions, mockRes);

      expect(block).toMatchObject({ index: 1, previousHash: GENESIS_HASH });
      expect(block.transactions).toEqual([expect.objectContaining({ from: 'alice', to: 'bob', amount: 5 })]);
      expect(transactions.list).toEqual([]);
      expect(blockchain.blocks).toHaveLength(2);
      expect(blockchain.isValidChain(roundTrip(blockchain.blocks))).toBe(true);
      expect(blockchain.nodes.broadcast).toHaveBeenCalledTimes(1);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('returns an error when there are no pending transactions', async () => {
      const blockchain = await createBlockchain();
      const mockRes = { status: jest.fn() };

      const result = blockchain.mine(new Transactions(), mockRes);

      expect(result).toEqual({ error: 'No transactions to be mined' });
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(blockchain.blocks).toHaveLength(1);
      expect(blockchain.nodes.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('isValidChain(blocks)', () => {
    let blockchain;
    let chain;

    beforeAll(async () => {
      blockchain = await createBlockchain();
      chain = mineBlocks(blockchain, 3);
    });

    test('accepts a chain built by this node', () => {
      expect(blockchain.isValidChain(chain)).toBe(true);
    });

    test('accepts a chain saved by the previous version of the app', () => {
      expect(blockchain.isValidChain(legacyDatum.value)).toBe(true);
    });

    test.each([
      ['is not an array', () => ({ length: 99 })],
      ['is empty', () => []],
      ['contains something that is not a block', (c) => { c[2] = null; return c; }],
      ['has a tampered transaction', (c) => { c[1].transactions[0].amount = 1000; return c; }],
      ['has a tampered hash', (c) => { c[1].hash = '000' + 'f'.repeat(61); return c; }],
      ['has a broken link', (c) => { c[2].previousHash = c[0].hash; return c; }],
      ['has blocks out of order', (c) => [c[0], c[2], c[1], c[3]]],
      ['has a block with an unexpected field', (c) => { c[1].evil = 'x'; return c; }],
      ['has a block with an invalid timestamp', (c) => { c[1].timestamp = 'yesterday'; return c; }],
    ])('rejects a chain that %s', (description, tamper) => {
      expect(blockchain.isValidChain(tamper(roundTrip(chain)))).toBe(false);
    });

    test('rejects invalid transactions even when the proof of work is redone', () => {
      const tampered = roundTrip(chain);
      tampered[1].transactions[0].amount = -1000;

      expect(blockchain.isValidChain(remine(blockchain, tampered, 1))).toBe(false);
    });

    test('rejects a genesis block with transactions even when the proof of work is redone', () => {
      const tampered = roundTrip(chain);
      tampered[0].transactions = [roundTrip(new Transaction('mallory', 'mallory', 1000))];

      expect(blockchain.isValidChain(remine(blockchain, tampered, 0))).toBe(false);
    });

    test('rejects hashes that do not meet the difficulty', () => {
      const tampered = roundTrip(chain);
      do {
        tampered[3].nonce++;
        tampered[3].hash = blockchain.calculateHash(tampered[3]);
      } while (tampered[3].hash.startsWith('000'));

      expect(blockchain.isValidChain(tampered)).toBe(false);
    });
  });

  describe('updateBlocks(blocks)', () => {
    test('replaces the chain with a valid one from another node and saves it', async () => {
      const port = ++lastPort;
      const blockchain = await createBlockchain(port);
      const peerChain = mineBlocks(await createBlockchain(), 2);

      expect(blockchain.updateBlocks(peerChain)).toBe(true);
      expect(blockchain.blocks).toEqual(peerChain);

      await blockchain.save();
      expect((await createBlockchain(port)).blocks).toEqual(peerChain);
    });

    test('keeps the current chain when the new one is not valid', async () => {
      const blockchain = await createBlockchain();
      const current = roundTrip(blockchain.blocks);
      const peerChain = mineBlocks(await createBlockchain(), 2);
      peerChain[2].transactions[0].to = 'mallory';

      expect(blockchain.updateBlocks(peerChain)).toBe(false);
      expect(blockchain.updateBlocks({ length: 99 })).toBe(false);
      expect(roundTrip(blockchain.blocks)).toEqual(current);
    });

    test('keeps the current chain when the new one starts with another genesis block', async () => {
      const blockchain = await createBlockchain();
      const peerChain = mineBlocks(await createBlockchain(), 2);
      // Another nonce that also meets the difficulty gives a different, valid, genesis block
      do {
        peerChain[0].nonce++;
      } while (!blockchain.calculateHash(peerChain[0]).startsWith('000'));
      peerChain[0].hash = blockchain.calculateHash(peerChain[0]);
      remine(blockchain, peerChain, 1);

      expect(blockchain.isValidChain(peerChain)).toBe(true);
      expect(blockchain.updateBlocks(peerChain)).toBe(false);
      expect(blockchain.blocks).toHaveLength(1);
    });
  });

  describe('getBlockByIndex(idx)', () => {
    let blockchain;

    beforeEach(async () => {
      blockchain = await createBlockchain();
      blockchain.blocks = [
        { index: 0, data: 'genesis' },
        { index: 1, data: 'block1' },
        { index: 2, data: 'block2' },
      ];
    });

    test('should return the block at a valid index', () => {
      expect(blockchain.getBlockByIndex(1)).toEqual({ index: 1, data: 'block1' });
    });

    test('should return empty array for an index too high', () => {
      expect(blockchain.getBlockByIndex(5)).toEqual([]);
    });

    test('should return empty array for a negative index', () => {
      expect(blockchain.getBlockByIndex(-1)).toEqual([]);
    });

    test('should return empty array for non-numeric index', () => {
      expect(blockchain.getBlockByIndex('abc')).toEqual([]);
    });
  });

  describe('getBlockLastIndex()', () => {
    test('should return the last index when blocks exist', async () => {
      const blockchain = await createBlockchain();
      blockchain.blocks = [{ index: 0 }, { index: 1 }, { index: 2 }];
      expect(blockchain.getBlockLastIndex()).toBe(2);
    });

    test('should return -1 when no blocks exist', async () => {
      const blockchain = await createBlockchain();
      blockchain.blocks = [];
      expect(blockchain.getBlockLastIndex()).toBe(-1);
    });
  });
});
