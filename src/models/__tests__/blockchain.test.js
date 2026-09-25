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
const keys = require('../keys');
const Transaction = require('../transaction');
// A chain saved by the first version of the app (node-persist 3 and unsigned transactions)
const legacyDatum = require('./fixtures/node-persist-3-blocks.json');

const GENESIS_TIMESTAMP = 1790294400;
const GENESIS_HASH = '000df523e6d840db7ba3645a8fac03019068ba80271be87534a76829d354c5bc';
const hashOf = (algorithm, data) => crypto.createHash(algorithm).update(data).digest('hex');
const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const randomAddress = () => crypto.randomBytes(32).toString('hex');
const leadingZeroBits = (hash) => 256 - BigInt('0x' + hash).toString(2).length;

const aliceKey = crypto.generateKeyPairSync('ed25519').privateKey;
const malloryKey = crypto.generateKeyPairSync('ed25519').privateKey;
const alice = keys.addressOf(aliceKey);
const mallory = keys.addressOf(malloryKey);
// The keys the tests can sign blocks with, by address
const keyOf = { [alice]: aliceKey, [mallory]: malloryKey };

// The clock of the nodes, in seconds, which the tests move forward
let clock = GENESIS_TIMESTAMP + 60;
const now = () => clock;

// A payment of 1 from alice to a new address, so that no two transactions are the same
const newTransaction = () => Transaction.sign(aliceKey, randomAddress(), 1);

let lastPort = 0;
const blockchains = [];

// Every port gets its own storage directory, so tests don't share chains. Alice mines unless the
// options give another miner.
function newBlockchain(port = ++lastPort, options = {}) {
  const blockchain = new Blockchain('test-host', port, { miner: aliceKey, now, ...options });
  blockchains.push(blockchain);
  return blockchain;
}

async function createBlockchain(port, options) {
  const blockchain = newBlockchain(port, options);
  await blockchain.init();
  return blockchain;
}

function storageDirOf(blockchain) {
  const dir = path.join(mockStorageRoot, path.basename(blockchain.storageDir));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Mines blocks 10 seconds apart, so that the difficulty stays at its minimum, with a payment from
// alice in each of them once she has coins
async function mineBlocks(blockchain, count) {
  for (let i = 0; i < count; i++) {
    if (blockchain.balanceOf(alice) > blockchain.transactions.pendingAmount(alice)) {
      blockchain.transactions.restore([newTransaction()], blockchain);
    }
    clock += 10;
    expect(await blockchain.mineBlock()).not.toBeNull();
  }
  return roundTrip(blockchain.blocks);
}

// A chain with the first `kept` blocks of `chain` followed by `count` blocks mined by mallory
async function fork(chain, kept, count) {
  const peer = await createBlockchain(undefined, { miner: malloryKey });
  if (kept > 1) {
    expect(peer.updateBlocks(roundTrip(chain.slice(0, kept)))).toBe(true);
  }
  return mineBlocks(peer, count);
}

// Redoes the proof of work of the blocks from fromIdx on, and signs them again when their miner is
// alice or mallory, as if they had mined them like that
function remine(blockchain, chain, fromIdx) {
  for (let idx = fromIdx; idx < chain.length; idx++) {
    const block = chain[idx];
    if (idx > 0) block.previousHash = chain[idx - 1].hash;
    block.nonce = 0;
    block.hash = blockchain.generateHash(block);
    if (keyOf[block.miner]) block.signature = keys.sign(keyOf[block.miner], block.hash);
  }
  return chain;
}

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  // Wait for the writes node-persist still has queued before deleting their directory
  await Promise.all(blockchains.flatMap((blockchain) => [blockchain.save(), blockchain.transactions.save()]));
  fs.rmSync(mockStorageRoot, { recursive: true, force: true });
});

describe('Blockchain', () => {
  describe('init()', () => {
    test('creates and saves the genesis block, the same on every node, when nothing is stored', async () => {
      const port = ++lastPort;
      const blockchain = await createBlockchain(port);

      expect(blockchain.blocks).toHaveLength(1);
      expect(roundTrip(blockchain.blocks[0])).toEqual({
        index: 0,
        previousHash: '0000000000000000',
        hash: GENESIS_HASH,
        timestamp: GENESIS_TIMESTAMP,
        nonce: 1287,
        difficulty: 12,
        miner: null,
        signature: null,
        transactions: [],
      });

      await blockchain.save();
      const reloaded = await createBlockchain(port);
      expect(reloaded.blocks).toEqual(roundTrip(blockchain.blocks));
    });

    test('loads the chain and the pending transactions saved by a previous run, with its balances', async () => {
      const port = ++lastPort;
      const blockchain = await createBlockchain(port);
      const chain = await mineBlocks(blockchain, 3);
      const pending = newTransaction();
      blockchain.transactions.restore([pending], blockchain);
      await blockchain.save();
      await blockchain.transactions.save();

      const reloaded = await createBlockchain(port);

      expect(reloaded.blocks).toEqual(chain);
      expect(reloaded.balanceOf(alice)).toBe(3 * 50 - 2);
      expect(reloaded.hasTransaction(chain[3].transactions[0])).toBe(true);
      expect(reloaded.transactions.get()).toEqual([pending]);
    });

    test('leaves out the saved pending transactions that are not valid anymore', async () => {
      const port = ++lastPort;
      const blockchain = await createBlockchain(port);
      const chain = await mineBlocks(blockchain, 2);
      const valid = newTransaction();
      blockchain.transactions.list = [
        valid,
        chain[2].transactions[0],
        { ...roundTrip(newTransaction()), amount: 2 },
        Transaction.sign(aliceKey, randomAddress(), 1000),
      ];
      await blockchain.transactions.save();
      await blockchain.save();

      const reloaded = await createBlockchain(port);

      expect(reloaded.transactions.get()).toEqual([valid]);
    });

    test('finds chains saved with node-persist 3, which named files after the MD5 of the key', async () => {
      const chain = await mineBlocks(await createBlockchain(), 2);
      const blockchain = newBlockchain();
      fs.writeFileSync(path.join(storageDirOf(blockchain), hashOf('md5', 'blocks')), JSON.stringify({ key: 'blocks', value: chain }));

      await blockchain.init();

      expect(blockchain.blocks).toEqual(chain);
    });

    test('refuses to load a chain created by the first version, with unsigned transactions', async () => {
      const blockchain = newBlockchain();
      fs.writeFileSync(path.join(storageDirOf(blockchain), hashOf('md5', 'blocks')), JSON.stringify(legacyDatum));

      await expect(blockchain.init()).rejects.toThrow('is not valid (chains created by versions before 3.0 are not valid anymore)');
    });

    test('refuses to load a chain created by version 2, without difficulty nor signatures', async () => {
      const genesisOfVersion2 = {
        index: 0,
        previousHash: '0000000000000000',
        hash: '00021b0673ecfef60a2e414ec216fcd57d4abb7314b30e35c7e13b205b84743e',
        timestamp: GENESIS_TIMESTAMP,
        nonce: 10,
        miner: null,
        transactions: [],
      };
      const blockchain = newBlockchain();
      fs.writeFileSync(path.join(storageDirOf(blockchain), hashOf('sha256', 'blocks')), JSON.stringify({ key: 'blocks', value: [genesisOfVersion2] }));

      await expect(blockchain.init()).rejects.toThrow('is not valid');
    });

    test('refuses to load a stored chain that is not valid', async () => {
      const tampered = await mineBlocks(await createBlockchain(), 2);
      tampered[2].transactions[0].amount = 2;
      const blockchain = newBlockchain();
      fs.writeFileSync(path.join(storageDirOf(blockchain), hashOf('sha256', 'blocks')), JSON.stringify({ key: 'blocks', value: tampered }));

      await expect(blockchain.init()).rejects.toThrow('is not valid');
    });
  });

  describe('save()', () => {
    test('writes the chain once the previous save has finished, as it is then', async () => {
      const blockchain = await createBlockchain();
      await blockchain.save();
      const finishWrites = [];
      const setItem = jest.spyOn(blockchain.storage, 'setItem').mockImplementation(() => new Promise((resolve) => finishWrites.push(resolve)));
      const nextTask = () => new Promise((resolve) => setImmediate(resolve));

      const first = blockchain.save();
      await nextTask();
      blockchain.blocks = [...blockchain.blocks, { index: 1 }];
      const second = blockchain.save();
      await nextTask();

      expect(setItem).toHaveBeenCalledTimes(1);
      expect(setItem.mock.calls[0][1]).toHaveLength(1);
      finishWrites[0]();
      await first;
      await nextTask();
      expect(setItem).toHaveBeenCalledTimes(2);
      expect(setItem).toHaveBeenLastCalledWith('blocks', blockchain.blocks);
      finishWrites[1]();
      await second;
    });

    test('logs the failures to save instead of throwing, and keeps saving', async () => {
      const blockchain = await createBlockchain();
      const error = new Error('disk full');
      const setItem = jest.spyOn(blockchain.storage, 'setItem').mockRejectedValueOnce(error);
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(blockchain.save()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith('Failed to save the blockchain:', error);

      await blockchain.save();
      expect(setItem).toHaveBeenCalledTimes(2);
    });
  });

  describe('generateHash(block)', () => {
    let blockchain;

    beforeAll(async () => {
      blockchain = await createBlockchain();
    });

    test.each([1, 3, 4, 6, 13])('finds the first nonce whose hash starts with %i zero bits', (bits) => {
      const block = Object.assign(new Block(), { index: 1, previousHash: GENESIS_HASH, difficulty: bits, miner: alice, transactions: [newTransaction()] });

      const hash = blockchain.generateHash(block);

      expect(leadingZeroBits(hash)).toBeGreaterThanOrEqual(bits);
      expect(hash).toBe(hashOf('sha256', block.key));
      expect(blockchain.calculateHash(roundTrip(block))).toBe(hash);
      for (let nonce = 0; nonce < block.nonce; nonce++) {
        expect(leadingZeroBits(blockchain.calculateHash({ ...block, nonce }))).toBeLessThan(bits);
      }
    });
  });

  describe('expectedDifficulty(blocks, idx)', () => {
    let blockchain;

    beforeAll(async () => {
      blockchain = await createBlockchain();
    });

    // The genesis block and then blocks of difficulty 20, the first one dated long after the
    // genesis block and the rest `intervals` seconds after the previous one
    function datedChain(intervals, difficulty = 20) {
      let timestamp = GENESIS_TIMESTAMP + 100000;
      const blocks = [{ timestamp: GENESIS_TIMESTAMP, difficulty: 12 }, { timestamp, difficulty }];
      for (const interval of intervals) {
        timestamp += interval;
        blocks.push({ timestamp, difficulty });
      }
      return blocks;
    }

    const nextDifficulty = (blocks) => blockchain.expectedDifficulty(blocks, blocks.length);

    test('is the minimum, 12 bits, for the genesis block and the first one after it', () => {
      expect(blockchain.expectedDifficulty([], 0)).toBe(12);
      expect(blockchain.expectedDifficulty(datedChain([]), 1)).toBe(12);
    });

    test('stays the same until there are two blocks after the genesis one to measure the time between them', () => {
      expect(nextDifficulty(datedChain([]))).toBe(20);
    });

    test.each([
      ['faster than 5 seconds on average', [4, 4, 4, 4], 21],
      ['just faster than 5 seconds on average', [0, 0, 0, 19], 21],
      ['5 seconds apart on average', [1, 9, 1, 9], 20],
      ['10 seconds apart', [10, 10, 10, 10], 20],
      ['20 seconds apart on average', [2, 2, 2, 74], 20],
      ['slower than 20 seconds on average', [21, 21, 21, 21], 19],
      ['just slower than 20 seconds on average', [30, 30, 30, 1], 19],
      ['faster than 5 seconds, but only two of them', [1], 21],
    ])('changes by one bit at most, depending on how long the last blocks took: %s', (description, intervals, difficulty) => {
      expect(nextDifficulty(datedChain(intervals))).toBe(difficulty);
    });

    test('only takes into account the last 4 intervals', () => {
      expect(nextDifficulty(datedChain([100, 100, 100, 10, 10, 10, 10]))).toBe(20);
      expect(nextDifficulty(datedChain([1, 1, 1, 30, 30, 30, 30]))).toBe(19);
    });

    test('never goes below 12 bits', () => {
      expect(nextDifficulty(datedChain([100, 100], 12))).toBe(12);
    });
  });

  describe('mineBlock(keepMining)', () => {
    test('mines the pending transactions and the reward for its miner into a new block signed by the miner, saves it and broadcasts it', async () => {
      const blockchain = await createBlockchain();
      await mineBlocks(blockchain, 1);
      const tx = newTransaction();
      blockchain.transactions.restore([tx], blockchain);
      const save = jest.spyOn(blockchain, 'save');
      clock += 10;

      const block = await blockchain.mineBlock();

      expect(roundTrip(block)).toEqual({
        index: 2,
        previousHash: blockchain.blocks[1].hash,
        hash: expect.stringMatching(/^000/),
        timestamp: clock,
        nonce: expect.any(Number),
        difficulty: 12,
        miner: alice,
        signature: expect.stringMatching(/^[0-9a-f]{128}$/),
        transactions: [roundTrip(tx)],
      });
      expect(block.hash).toBe(blockchain.calculateHash(block));
      expect(keys.verify(alice, block.hash, block.signature)).toBe(true);
      expect(blockchain.blocks[2]).toBe(block);
      expect(blockchain.transactions.get()).toEqual([]);
      expect(blockchain.balanceOf(alice)).toBe(50 - 1 + 50);
      expect(blockchain.balanceOf(tx.to)).toBe(1);
      expect(blockchain.hasTransaction(roundTrip(tx))).toBe(true);
      expect(blockchain.validateChain(roundTrip(blockchain.blocks))).not.toBeNull();
      expect(save).toHaveBeenCalledTimes(1);
      expect(blockchain.nodes.broadcast).toHaveBeenCalledTimes(2);
    });

    test('mines a block with just the reward when there are no pending transactions', async () => {
      const blockchain = await createBlockchain();

      const block = await blockchain.mineBlock();

      expect(block).toMatchObject({ index: 1, previousHash: GENESIS_HASH, miner: alice, transactions: [] });
      expect(blockchain.balanceOf(alice)).toBe(50);
    });

    test('leaves out the pending transactions that the chain already has', async () => {
      const blockchain = await createBlockchain();
      const mined = (await mineBlocks(blockchain, 2))[2].transactions[0];
      const pending = newTransaction();
      blockchain.transactions.list.push(new Transaction(mined.from, mined.to, mined.amount, mined.timestamp, mined.signature), pending);
      clock += 10;

      const block = await blockchain.mineBlock();

      expect(block.transactions).toEqual([pending]);
      expect(blockchain.validateChain(roundTrip(blockchain.blocks))).not.toBeNull();
    });

    test('leaves out and drops the pending transactions whose sender does not have the balance anymore', async () => {
      const blockchain = await createBlockchain();
      await mineBlocks(blockchain, 1);
      const affordable = Transaction.sign(aliceKey, randomAddress(), 30);
      blockchain.transactions.list.push(affordable, Transaction.sign(aliceKey, randomAddress(), 30));
      clock += 10;

      const block = await blockchain.mineBlock();

      expect(block.transactions).toEqual([affordable]);
      expect(blockchain.balanceOf(alice)).toBe(50 - 30 + 50);
      expect(blockchain.transactions.get()).toEqual([]);
    });

    test('dates the block with the clock of the node, but never before the previous block', async () => {
      const blockchain = await createBlockchain();
      const previousBlock = await blockchain.mineBlock();
      const time = clock;
      clock -= 100;

      try {
        expect((await blockchain.mineBlock()).timestamp).toBe(previousBlock.timestamp);
      } finally {
        clock = time;
      }
      clock += 10;
      expect((await blockchain.mineBlock()).timestamp).toBe(clock);
    });

    test('mines with the difficulty that the chain requires', async () => {
      const blockchain = await createBlockchain();

      // Blocks mined in the same second make it go up
      for (let i = 0; i < 4; i++) {
        await blockchain.mineBlock();
      }

      expect(blockchain.blocks.map((block) => block.difficulty)).toEqual([12, 12, 12, 13, 14]);
      expect(blockchain.blocks.every((block) => leadingZeroBits(block.hash) >= block.difficulty)).toBe(true);
      expect(blockchain.validateChain(roundTrip(blockchain.blocks))).not.toBeNull();
    });

    test('gives up, returning null, when keepMining() is false', async () => {
      const blockchain = await createBlockchain();
      // A proof of work that it won't find
      jest.spyOn(blockchain, 'expectedDifficulty').mockReturnValue(256);
      const keepMining = jest.fn().mockReturnValue(false);

      await expect(blockchain.mineBlock(keepMining)).resolves.toBeNull();

      expect(keepMining).toHaveBeenCalledTimes(1);
      expect(blockchain.blocks).toHaveLength(1);
      expect(blockchain.nodes.broadcast).not.toHaveBeenCalled();
    });

    test('lets the node do other things between attempts, and gives up when the chain changes meanwhile', async () => {
      const blockchain = await createBlockchain();
      const peerChain = await fork(blockchain.blocks, 1, 2);
      jest.spyOn(blockchain, 'expectedDifficulty').mockReturnValueOnce(256);

      const mining = blockchain.mineBlock();
      expect(blockchain.updateBlocks(peerChain)).toBe(true);

      await expect(mining).resolves.toBeNull();
      expect(blockchain.blocks).toEqual(peerChain);
      expect(blockchain.nodes.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('startMining() and stopMining()', () => {
    test('gets the chains of the other nodes first, and then mines one block after another until stopped', async () => {
      const blockchain = await createBlockchain();
      let blocksWhenSynced;
      blockchain.nodes.sync.mockImplementation(async () => {
        blocksWhenSynced = blockchain.blocks.length;
        return [];
      });
      blockchain.nodes.broadcast.mockImplementation(() => {
        clock += 10;
        if (blockchain.blocks.length == 4) {
          blockchain.stopMining();
        }
      });

      await blockchain.startMining();

      expect(blockchain.nodes.sync).toHaveBeenCalledWith(blockchain);
      expect(blocksWhenSynced).toBe(1);
      expect(blockchain.blocks).toHaveLength(4);
      expect(blockchain.mining).toBe(false);
      expect(blockchain.balanceOf(alice)).toBe(3 * 50);
      expect(blockchain.validateChain(roundTrip(blockchain.blocks))).not.toBeNull();
    });

    test('does not mine when stopped while it gets the chains of the other nodes', async () => {
      const blockchain = await createBlockchain();
      blockchain.nodes.sync.mockImplementation(async () => blockchain.stopMining());

      await blockchain.startMining();

      expect(blockchain.blocks).toHaveLength(1);
    });

    test('stops in the middle of a block', async () => {
      const blockchain = await createBlockchain();
      const expectedDifficulty = jest.spyOn(blockchain, 'expectedDifficulty').mockReturnValue(256);

      const mining = blockchain.startMining();
      while (expectedDifficulty.mock.calls.length == 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      blockchain.stopMining();

      await mining;
      expect(blockchain.blocks).toHaveLength(1);
    });
  });

  describe('hasTransaction(tx)', () => {
    test('tells whether the chain has the same transaction, whatever object holds it', async () => {
      const blockchain = await createBlockchain();
      const chain = await mineBlocks(blockchain, 2);

      expect(blockchain.hasTransaction({ ...chain[2].transactions[0] })).toBe(true);
      expect(blockchain.hasTransaction(newTransaction())).toBe(false);
    });
  });

  describe('validateChain(blocks)', () => {
    let blockchain;
    let chain;

    beforeAll(async () => {
      blockchain = await createBlockchain();
      chain = await mineBlocks(blockchain, 4);
    });

    test('returns the ledger of a chain built by this node', () => {
      const ledger = blockchain.validateChain(chain);

      expect(ledger.balanceOf(alice)).toBe(blockchain.balanceOf(alice));
      expect(ledger.has(chain[3].transactions[0])).toBe(true);
    });

    test('accepts the chain with its blocks mined and signed again, so the tests below only fail for what they change', () => {
      expect(blockchain.validateChain(remine(blockchain, roundTrip(chain), 0))).not.toBeNull();
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
      ['has a tampered difficulty', (c) => { c[2].difficulty = 11; return c; }],
      ['has a tampered miner', (c) => { c[2].miner = mallory; return c; }],
      ['has a tampered hash', (c) => { c[2].hash = '000' + 'f'.repeat(61); return c; }],
      ['has a broken link', (c) => { c[3].previousHash = c[1].hash; return c; }],
      ['has blocks out of order', (c) => [c[0], c[2], c[1], c[3], c[4]]],
      ['has a block with an unexpected field', (c) => { c[2].evil = 'x'; return c; }],
      ['has a block with an invalid timestamp', (c) => { c[2].timestamp = 'yesterday'; return c; }],
      ['has a block without signature', (c) => { c[2].signature = null; return c; }],
      ['has a block signed by someone who is not its miner', (c) => { c[2].signature = keys.sign(malloryKey, c[2].hash); return c; }],
      ['has a block with the signature of another block', (c) => { c[2].signature = c[3].signature; return c; }],
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
      ['a block dated before the previous one', (c) => { c[4].timestamp = c[3].timestamp - 1; }],
      ['a block dated more than 2 minutes after the clock of the node', (c) => { c[4].timestamp = clock + 121; }],
      ['a block with less difficulty than the chain requires', (c) => { c[4].difficulty = 11; }],
      ['a block with more difficulty than the chain requires', (c) => { c[4].difficulty = 13; }],
    ])('rejects %s even when the blocks are mined and signed again', (description, tamper) => {
      const tampered = roundTrip(chain);
      tamper(tampered);

      expect(blockchain.validateChain(remine(blockchain, tampered, 1))).toBeNull();
    });

    test('accepts a block dated up to 2 minutes after the clock of the node', () => {
      const tampered = roundTrip(chain);
      tampered[4].timestamp = clock + 120;

      expect(blockchain.validateChain(remine(blockchain, tampered, 4))).not.toBeNull();
    });

    test.each([
      ['transactions', (c) => { c[0].transactions = [roundTrip(Transaction.sign(malloryKey, mallory, 1000))]; }],
      ['a miner', (c) => { c[0].miner = mallory; }],
      ['a signature', (c) => { c[0].signature = keys.sign(malloryKey, c[0].hash); }],
      ['another date', (c) => { c[0].timestamp++; }],
      ['another previous hash', (c) => { c[0].previousHash = '1'.repeat(16); }],
      ['another difficulty', (c) => { c[0].difficulty = 13; }],
    ])('rejects a genesis block with %s even when the proof of work is redone', (description, tamper) => {
      const tampered = roundTrip(chain);
      tamper(tampered);

      expect(blockchain.validateChain(remine(blockchain, tampered, 0))).toBeNull();
    });

    test('rejects hashes that do not meet the difficulty', () => {
      const tampered = roundTrip(chain);
      const block = tampered[4];
      do {
        block.nonce++;
        block.hash = blockchain.calculateHash(block);
      } while (block.hash.startsWith('000'));
      block.signature = keys.sign(aliceKey, block.hash);

      expect(blockchain.validateChain(tampered)).toBeNull();
    });

    test('lets anyone mine when there is no list of authorized miners', () => {
      const minedByMallory = roundTrip(chain);
      minedByMallory[3].miner = mallory;

      expect(blockchain.isAuthorizedMiner(mallory)).toBe(true);
      expect(blockchain.validateChain(remine(blockchain, minedByMallory, 3))).not.toBeNull();
    });

    test('only accepts blocks mined by the authorized miners when there is a list of them', async () => {
      const node = await createBlockchain(undefined, { authorizedMiners: [alice] });
      const minedByMallory = roundTrip(chain);
      minedByMallory[3].miner = mallory;
      remine(node, minedByMallory, 3);

      expect(node.isAuthorizedMiner(alice)).toBe(true);
      expect(node.isAuthorizedMiner(mallory)).toBe(false);
      expect(node.validateChain(chain)).not.toBeNull();
      expect(node.validateChain(minedByMallory)).toBeNull();
    });
  });

  describe('updateBlocks(blocks)', () => {
    test('replaces the chain with a valid one from another node that has more work, and saves it', async () => {
      const port = ++lastPort;
      const blockchain = await createBlockchain(port);
      const peerChain = await mineBlocks(await createBlockchain(), 3);

      expect(blockchain.updateBlocks(peerChain)).toBe(true);
      expect(blockchain.blocks).toEqual(peerChain);
      expect(blockchain.hasTransaction(peerChain[2].transactions[0])).toBe(true);
      expect(blockchain.balanceOf(alice)).toBe(3 * 50 - 2);

      await blockchain.save();
      expect((await createBlockchain(port)).blocks).toEqual(peerChain);
    });

    test('keeps the chain, its balances and its pending transactions when the new one is not valid', async () => {
      const blockchain = await createBlockchain();
      const chain = await mineBlocks(blockchain, 3);
      const pending = newTransaction();
      blockchain.transactions.restore([pending], blockchain);
      const longer = await fork(chain, 2, 3);
      longer[4].timestamp++;

      expect(blockchain.updateBlocks(longer)).toBe(false);
      expect(blockchain.updateBlocks({ length: 99 })).toBe(false);
      expect(blockchain.blocks).toEqual(chain);
      expect(blockchain.balanceOf(alice)).toBe(3 * 50 - 2);
      expect(blockchain.hasTransaction(chain[3].transactions[0])).toBe(true);
      expect(blockchain.transactions.get()).toEqual([pending]);
    });

    test('keeps the chain when the new one starts with another genesis block', async () => {
      const blockchain = await createBlockchain();
      const peerChain = await mineBlocks(await createBlockchain(), 2);
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

    test('keeps the chain when the new one has the same work', async () => {
      const blockchain = await createBlockchain();
      const chain = await mineBlocks(blockchain, 2);

      expect(blockchain.updateBlocks(await fork(chain, 1, 2))).toBe(false);
      expect(blockchain.blocks).toEqual(chain);
    });

    test('takes the chain with the most work, which is not always the longest one', async () => {
      // Blocks mined in the same second make the difficulty go up: 12, 12, 13 and 14 bits
      const heavy = await createBlockchain(undefined, { miner: malloryKey });
      for (let i = 0; i < 4; i++) {
        await heavy.mineBlock();
      }
      const heavyChain = roundTrip(heavy.blocks);
      const long = await createBlockchain();
      const longChain = await mineBlocks(long, 6);

      expect(heavy.updateBlocks(longChain)).toBe(false);
      expect(long.updateBlocks(heavyChain)).toBe(true);
      expect(long.blocks).toEqual(heavyChain);
      expect(long.balanceOf(alice)).toBe(0);
    });

    test('replaces the blocks after the fork, however deep it is', async () => {
      const blockchain = await createBlockchain();
      const chain = await mineBlocks(blockchain, 12);
      const deepFork = await fork(chain, 2, 12);

      expect(blockchain.updateBlocks(deepFork)).toBe(true);

      expect(blockchain.blocks).toEqual(deepFork);
      expect(blockchain.balanceOf(mallory)).toBe(12 * 50);
      // The payments of the replaced blocks are pending again
      expect(blockchain.balanceOf(alice)).toBe(50 - 12);
      expect(roundTrip(blockchain.transactions.get())).toEqual(chain.slice(2).flatMap((block) => block.transactions));
      expect(blockchain.validateChain(roundTrip(blockchain.blocks)).balanceOf(alice)).toBe(50 - 12);
    });

    test('only puts back in the pending list the transactions of the replaced blocks that the new chain does not have', async () => {
      const blockchain = await createBlockchain();
      await mineBlocks(blockchain, 2);
      const shared = newTransaction();
      const orphaned = newTransaction();
      blockchain.transactions.restore([shared, orphaned], blockchain);
      clock += 10;
      await blockchain.mineBlock();
      const chain = roundTrip(blockchain.blocks);
      // Another node mines `shared` in a chain with more work from block 2 on
      const peer = await createBlockchain(undefined, { miner: malloryKey });
      peer.updateBlocks(chain.slice(0, 3));
      peer.transactions.restore([shared], peer);

      expect(blockchain.updateBlocks(await mineBlocks(peer, 2))).toBe(true);

      expect(blockchain.transactions.get()).toEqual([orphaned]);
      expect(blockchain.hasTransaction(shared)).toBe(true);
      expect(blockchain.hasTransaction(orphaned)).toBe(false);
    });

    test('removes from the pending list the transactions that the new chain has', async () => {
      const blockchain = await createBlockchain();
      const chain = await mineBlocks(blockchain, 2);
      const peer = await createBlockchain();
      peer.updateBlocks(chain);
      const tx = newTransaction();
      blockchain.transactions.restore([tx], blockchain);
      peer.transactions.restore([tx], peer);

      expect(blockchain.updateBlocks(await mineBlocks(peer, 1))).toBe(true);

      expect(blockchain.transactions.get()).toEqual([]);
      expect(blockchain.hasTransaction(tx)).toBe(true);
    });

    test('only checks the blocks after the fork', async () => {
      const blockchain = await createBlockchain();
      const longer = await fork(await mineBlocks(blockchain, 5), 4, 3);
      const isValidBlock = jest.spyOn(blockchain, 'isValidBlock');

      expect(blockchain.updateBlocks(longer)).toBe(true);
      expect(isValidBlock.mock.calls.map(([, idx]) => idx)).toEqual([4, 5, 6]);
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
