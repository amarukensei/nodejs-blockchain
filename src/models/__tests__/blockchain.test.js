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
// A chain saved by the first version of the app (node-persist 3 and unsigned transactions)
const legacyDatum = require('./fixtures/node-persist-3-blocks.json');

const GENESIS_HASH = '00021b0673ecfef60a2e414ec216fcd57d4abb7314b30e35c7e13b205b84743e';
const hashOf = (algorithm, data) => crypto.createHash(algorithm).update(data).digest('hex');
const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const randomAddress = () => crypto.randomBytes(32).toString('hex');

const aliceKey = crypto.generateKeyPairSync('ed25519').privateKey;
const malloryKey = crypto.generateKeyPairSync('ed25519').privateKey;
const alice = Transaction.address(aliceKey);
const mallory = Transaction.address(malloryKey);

// A payment of 1 from alice to a new address, so that no two transactions are the same
const newTransaction = () => Transaction.sign(aliceKey, randomAddress(), 1);

let lastPort = 0;
const blockchains = [];

// Every port gets its own storage directory, so tests don't share chains
function newBlockchain(port = ++lastPort, minerAddress = alice) {
  const blockchain = new Blockchain('test-host', port, minerAddress);
  blockchains.push(blockchain);
  return blockchain;
}

async function createBlockchain(port, minerAddress) {
  const blockchain = newBlockchain(port, minerAddress);
  await blockchain.init();
  return blockchain;
}

function storageDirOf(blockchain) {
  const dir = path.join(mockStorageRoot, path.basename(blockchain.storageDir));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Mines blocks with a payment from alice in each of them, once she has coins
function mineBlocks(blockchain, count) {
  for (let i = 0; i < count; i++) {
    const transactions = new Transactions();
    if (blockchain.balanceOf(alice) > 0) {
      transactions.list.push(newTransaction());
    }
    blockchain.mine(transactions, { status: jest.fn() });
  }
  return roundTrip(blockchain.blocks);
}

// A chain that shares its first `kept` blocks with `chain` and then has `count` blocks mined by mallory
async function fork(chain, kept, count) {
  const peer = await createBlockchain(++lastPort, mallory);
  expect(peer.updateBlocks(roundTrip(chain.slice(0, kept)))).toBe(true);
  return mineBlocks(peer, count);
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

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  // Wait for the writes node-persist still has queued before deleting their directory
  await Promise.all(blockchains.map((blockchain) => blockchain.save()));
  fs.rmSync(mockStorageRoot, { recursive: true, force: true });
});

describe('Blockchain', () => {
  describe('init()', () => {
    test('creates and saves the genesis block, the same on every node, when nothing is stored', async () => {
      const blockchain = await createBlockchain();

      expect(blockchain.blocks).toHaveLength(1);
      expect(roundTrip(blockchain.blocks[0])).toEqual({
        index: 0,
        previousHash: '0000000000000000',
        hash: GENESIS_HASH,
        timestamp: 1790294400,
        nonce: 10,
        miner: null,
        transactions: [],
      });

      await blockchain.save();
      const reloaded = await createBlockchain(lastPort);
      expect(reloaded.blocks).toEqual(roundTrip(blockchain.blocks));
    });

    test('loads the chain saved by a previous run, with its balances', async () => {
      const blockchain = await createBlockchain();
      const chain = mineBlocks(blockchain, 3);
      await blockchain.save();

      const reloaded = await createBlockchain(lastPort);

      expect(reloaded.blocks).toEqual(chain);
      expect(reloaded.balanceOf(alice)).toBe(3 * 50 - 2);
      expect(reloaded.hasTransaction(chain[2].transactions[0])).toBe(true);
    });

    test('finds chains saved with node-persist 3, which named files after the MD5 of the key', async () => {
      const chain = mineBlocks(await createBlockchain(), 2);
      const blockchain = newBlockchain();
      fs.writeFileSync(path.join(storageDirOf(blockchain), hashOf('md5', 'blocks')), JSON.stringify({ key: 'blocks', value: chain }));

      await blockchain.init();

      expect(blockchain.blocks).toEqual(chain);
    });

    test('refuses to load a chain created by the first version, with unsigned transactions', async () => {
      const blockchain = newBlockchain();
      fs.writeFileSync(path.join(storageDirOf(blockchain), hashOf('md5', 'blocks')), JSON.stringify(legacyDatum));

      await expect(blockchain.init()).rejects.toThrow('is not valid');
    });

    test('refuses to load a stored chain that is not valid', async () => {
      const tampered = mineBlocks(await createBlockchain(), 2);
      tampered[1].miner = mallory;
      const blockchain = newBlockchain();
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
      block.miner = alice;
      block.transactions = [newTransaction()];

      const hash = blockchain.generateHash(block);

      expect(hash.startsWith('000')).toBe(true);
      expect(hash).toBe(hashOf('sha256', block.key));
      expect(blockchain.calculateHash(roundTrip(block))).toBe(hash);
    });
  });

  describe('mine(transactions, res)', () => {
    test('mines the pending transactions and the reward for the miner into a new block and broadcasts it', async () => {
      const blockchain = await createBlockchain();
      mineBlocks(blockchain, 1);
      const transactions = new Transactions();
      const tx = newTransaction();
      transactions.list.push(tx);
      const mockRes = { status: jest.fn() };

      const block = blockchain.mine(transactions, mockRes);

      expect(block).toMatchObject({ index: 2, previousHash: blockchain.blocks[1].hash, miner: alice });
      expect(block.transactions).toEqual([tx]);
      expect(transactions.list).toEqual([]);
      expect(blockchain.blocks).toHaveLength(3);
      expect(blockchain.balanceOf(alice)).toBe(50 - 1 + 50);
      expect(blockchain.balanceOf(tx.to)).toBe(1);
      expect(blockchain.hasTransaction(roundTrip(tx))).toBe(true);
      expect(blockchain.validateChain(roundTrip(blockchain.blocks))).not.toBeNull();
      expect(blockchain.nodes.broadcast).toHaveBeenCalledTimes(2);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('mines a block with just the reward when there are no pending transactions', async () => {
      const blockchain = await createBlockchain();

      const block = blockchain.mine(new Transactions(), { status: jest.fn() });

      expect(block).toMatchObject({ index: 1, previousHash: GENESIS_HASH, miner: alice, transactions: [] });
      expect(blockchain.balanceOf(alice)).toBe(50);
    });

    test('does not mine without an address for the rewards', async () => {
      const blockchain = await createBlockchain(++lastPort, null);
      const mockRes = { status: jest.fn() };

      const result = blockchain.mine(new Transactions(), mockRes);

      expect(result).toEqual({ error: 'This node does not mine, as MINER_ADDRESS is not set' });
      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(blockchain.blocks).toHaveLength(1);
      expect(blockchain.nodes.broadcast).not.toHaveBeenCalled();
    });

    test('leaves out pending transactions that another node already added to the chain', async () => {
      const peer = await createBlockchain();
      const minedByPeer = mineBlocks(peer, 2)[2].transactions[0];
      const blockchain = await createBlockchain();
      blockchain.updateBlocks(roundTrip(peer.blocks));
      const transactions = new Transactions();
      const pending = newTransaction();
      transactions.list.push(new Transaction(minedByPeer.from, minedByPeer.to, minedByPeer.amount, minedByPeer.timestamp, minedByPeer.signature), pending);

      const block = blockchain.mine(transactions, { status: jest.fn() });

      expect(block.transactions).toEqual([pending]);
      expect(blockchain.validateChain(roundTrip(blockchain.blocks))).not.toBeNull();
    });

    test('leaves out pending transactions whose sender does not have the balance anymore', async () => {
      const blockchain = await createBlockchain();
      mineBlocks(blockchain, 1);
      const transactions = new Transactions();
      const affordable = Transaction.sign(aliceKey, randomAddress(), 30);
      transactions.list.push(affordable, Transaction.sign(aliceKey, randomAddress(), 30));

      const block = blockchain.mine(transactions, { status: jest.fn() });

      expect(block.transactions).toEqual([affordable]);
      expect(blockchain.balanceOf(alice)).toBe(50 - 30 + 50);
    });
  });

  describe('hasTransaction(tx)', () => {
    test('tells whether the chain has the same transaction, whatever object holds it', async () => {
      const blockchain = await createBlockchain();
      const chain = mineBlocks(blockchain, 2);

      expect(blockchain.hasTransaction({ ...chain[2].transactions[0] })).toBe(true);
      expect(blockchain.hasTransaction(newTransaction())).toBe(false);
    });
  });

  describe('validateChain(blocks, knownBlocks)', () => {
    let blockchain;
    let chain;

    beforeAll(async () => {
      blockchain = await createBlockchain();
      chain = mineBlocks(blockchain, 4);
    });

    test('returns the ledger of a chain built by this node', () => {
      const ledger = blockchain.validateChain(chain);

      expect(ledger.balanceOf(alice)).toBe(blockchain.balanceOf(alice));
      expect(ledger.has(chain[3].transactions[0])).toBe(true);
    });

    test('rejects a chain created by the first version, with unsigned transactions', () => {
      expect(blockchain.validateChain(legacyDatum.value)).toBeNull();
    });

    test.each([
      ['is not an array', () => ({ length: 99 })],
      ['is empty', () => []],
      ['contains something that is not a block', (c) => { c[2] = null; return c; }],
      ['has a tampered transaction', (c) => { c[2].transactions[0].amount = 2; return c; }],
      ['has a tampered timestamp', (c) => { c[2].timestamp++; return c; }],
      ['has a tampered miner', (c) => { c[2].miner = mallory; return c; }],
      ['has a tampered hash', (c) => { c[2].hash = '000' + 'f'.repeat(61); return c; }],
      ['has a broken link', (c) => { c[3].previousHash = c[1].hash; return c; }],
      ['has blocks out of order', (c) => [c[0], c[2], c[1], c[3], c[4]]],
      ['has a block with an unexpected field', (c) => { c[2].evil = 'x'; return c; }],
      ['has a block with an invalid timestamp', (c) => { c[2].timestamp = 'yesterday'; return c; }],
    ])('rejects a chain that %s', (description, tamper) => {
      expect(blockchain.validateChain(tamper(roundTrip(chain)))).toBeNull();
    });

    test.each([
      ['a transaction whose recipient was changed', (c) => { c[2].transactions[0].to = mallory; }],
      ['a transaction from alice signed by mallory', (c) => {
        c[4].transactions.push({ ...roundTrip(Transaction.sign(malloryKey, mallory, 10)), from: alice });
      }],
      ['a transaction that spends more than its sender has', (c) => {
        c[4].transactions.push(roundTrip(Transaction.sign(malloryKey, randomAddress(), 1000)));
      }],
      ['the same transaction twice', (c) => { c[4].transactions.push(c[2].transactions[0]); }],
      ['a block without miner', (c) => { c[3].miner = null; }],
      ['a miner that is not an address', (c) => { c[3].miner = 'mallory'; }],
    ])('rejects %s even when the proof of work is redone', (description, tamper) => {
      const tampered = roundTrip(chain);
      tamper(tampered);

      expect(blockchain.validateChain(remine(blockchain, tampered, 1))).toBeNull();
    });

    test.each([
      ['transactions', (c) => { c[0].transactions = [roundTrip(Transaction.sign(malloryKey, mallory, 1000))]; }],
      ['a miner', (c) => { c[0].miner = mallory; }],
    ])('rejects a genesis block with %s even when the proof of work is redone', (description, tamper) => {
      const tampered = roundTrip(chain);
      tamper(tampered);

      expect(blockchain.validateChain(remine(blockchain, tampered, 0))).toBeNull();
    });

    test('rejects hashes that do not meet the difficulty', () => {
      const tampered = roundTrip(chain);
      do {
        tampered[4].nonce++;
        tampered[4].hash = blockchain.calculateHash(tampered[4]);
      } while (tampered[4].hash.startsWith('000'));

      expect(blockchain.validateChain(tampered)).toBeNull();
    });

    test('only verifies the signatures of the blocks that are not known', async () => {
      const local = await createBlockchain();
      const knownBlocks = mineBlocks(local, 3);
      const longerChain = mineBlocks(local, 1);
      const isValid = jest.spyOn(Transaction, 'isValid');

      expect(local.validateChain(longerChain, knownBlocks)).not.toBeNull();
      expect(isValid).toHaveBeenCalledTimes(1);
      expect(isValid).toHaveBeenCalledWith(longerChain[4].transactions[0]);

      // Known blocks still need the right content for their hash
      const tampered = roundTrip(longerChain);
      tampered[2].transactions[0].amount = 2;
      expect(local.validateChain(tampered, knownBlocks)).toBeNull();
    });

    test('verifies the signatures of the blocks that replace known ones', async () => {
      const local = await createBlockchain();
      const knownBlocks = mineBlocks(local, 3);
      // A longer fork where mallory changed the recipient of a known transaction
      const tampered = roundTrip(knownBlocks);
      tampered[2].transactions[0].to = mallory;
      tampered.push({ index: 4, previousHash: '', hash: '', timestamp: 1, nonce: 0, miner: mallory, transactions: [] });

      expect(local.validateChain(remine(local, tampered, 1), knownBlocks)).toBeNull();
    });
  });

  describe('updateBlocks(blocks)', () => {
    test('replaces the chain with a valid one from another node and saves it', async () => {
      const port = ++lastPort;
      const blockchain = await createBlockchain(port);
      const peerChain = mineBlocks(await createBlockchain(), 3);

      expect(blockchain.updateBlocks(peerChain)).toBe(true);
      expect(blockchain.blocks).toEqual(peerChain);
      expect(blockchain.hasTransaction(peerChain[2].transactions[0])).toBe(true);
      expect(blockchain.balanceOf(alice)).toBe(3 * 50 - 2);

      await blockchain.save();
      expect((await createBlockchain(port)).blocks).toEqual(peerChain);
    });

    test('keeps the current chain when the new one is not valid', async () => {
      const blockchain = await createBlockchain();
      const current = roundTrip(blockchain.blocks);
      const peerChain = mineBlocks(await createBlockchain(), 3);
      peerChain[3].transactions[0].to = mallory;

      expect(blockchain.updateBlocks(peerChain)).toBe(false);
      expect(blockchain.updateBlocks({ length: 99 })).toBe(false);
      expect(roundTrip(blockchain.blocks)).toEqual(current);
      expect(blockchain.hasTransaction(peerChain[2].transactions[0])).toBe(false);
      expect(blockchain.balanceOf(alice)).toBe(0);
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

      expect(blockchain.validateChain(peerChain)).not.toBeNull();
      expect(blockchain.updateBlocks(peerChain)).toBe(false);
      expect(blockchain.blocks).toHaveLength(1);
    });

    test('lets a longer chain replace up to its last 10 blocks, but no more', async () => {
      const blockchain = await createBlockchain();
      const chain = mineBlocks(blockchain, 12);

      // Replaces blocks 3 to 12
      const shallowFork = await fork(chain, 3, 11);
      // Replaces blocks 2 to 12
      const deepFork = await fork(chain, 2, 12);

      expect(blockchain.updateBlocks(deepFork)).toBe(false);
      expect(blockchain.blocks).toEqual(chain);
      expect(blockchain.updateBlocks(shallowFork)).toBe(true);
      expect(blockchain.blocks).toEqual(shallowFork);
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
