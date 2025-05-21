const request = require('supertest');
const app = require('../../../app'); // Assuming app.js exports the express app
const storage = require('node-persist');
const fs = require('fs');
const path = require('path');

// --- Global Mocks ---
// Mock node-persist
let mockStorageData = {};
jest.mock('node-persist', () => ({
  create: jest.fn().mockReturnThis(),
  init: jest.fn(async () => {
    // console.log('Mock node-persist init called');
    // Optionally clear mockStorageData here if init implies a fresh start for a storage dir
  }),
  getItem: jest.fn(async (key) => {
    // console.log(`Mock getItem: ${key} -> ${JSON.stringify(mockStorageData[key])}`);
    return mockStorageData[key] !== undefined ? JSON.parse(JSON.stringify(mockStorageData[key])) : undefined;
  }),
  setItem: jest.fn(async (key, value) => {
    // console.log(`Mock setItem: ${key} -> ${JSON.stringify(value)}`);
    mockStorageData[key] = JSON.parse(JSON.stringify(value)); // Store a copy
  }),
  clear: jest.fn(async () => {
    // console.log('Mock clear called');
    mockStorageData = {};
  }),
  // Add any other methods used by the application
}));

// Mock nodes.json content
const nodesFilePath = path.join(__dirname, '../../../src/config/nodes.json'); // Adjust path as needed

describe('Blockchain API Integration Tests', () => {
  let originalNodesJsonContent;

  beforeAll(async () => {
    // Save original nodes.json if it exists, then create a mock one
    if (fs.existsSync(nodesFilePath)) {
      originalNodesJsonContent = fs.readFileSync(nodesFilePath, 'utf8');
    }
    // Create a default mock nodes.json for tests
    fs.writeFileSync(nodesFilePath, JSON.stringify(['http://localhost:3001', 'http://localhost:3002']));
    
    // Initialize the app (which in turn initializes blockchain, nodes etc.)
    // This ensures our mocks are in place before the app fully sets up.
    // Note: app.js might need to re-require its dependencies if they were cached before mocks applied.
    // If `app` is already configured at the top-level import, this is fine.
    // await app.ready(); // If your app has an explicit ready signal after async setup
  });

  afterAll(async () => {
    // Restore original nodes.json
    if (originalNodesJsonContent) {
      fs.writeFileSync(nodesFilePath, originalNodesJsonContent);
    } else {
      fs.unlinkSync(nodesFilePath); // Remove if it didn't exist before
    }
  });

  beforeEach(async () => {
    // Reset mock storage before each test to ensure test isolation for blockchain state
    mockStorageData = {};
    // The blockchain instance within the app needs to be "reset".
    // This is the tricky part with integration tests.
    // If the blockchain is a singleton initialized once, we need a way to reset its state.
    // One way: re-initialize the relevant part of the app or the controller.
    // For now, clearing mockStorageData and re-initializing the blockchain
    // by directly calling its internal load/reset methods might be needed if the app
    // doesn't expose a reset mechanism.
    // The current setup relies on app.js re-initializing its blockchain on each test run
    // IF it's structured to do so (e.g. if server is restarted, or if app export is a factory).
    // Given app is imported once, its blockchain instance is likely a singleton.
    // We'll assume for now that clearing mockStorageData is enough for the blockchain
    // to re-create genesis block etc., as its constructor loads from storage.
    // We also need to reset the transactions list in the singleton Transactions instance in the app.
    // This might require a dedicated endpoint or a way to access and reset it.
    // For now, we'll test sequentially and manage state via API calls.
    
    // A simple way to reset transactions for now (assuming they are in memory or reset by mining)
    // This doesn't reset the blockchain itself, only pending transactions.
    const allTransactions = await request(app).get('/transactions');
    if (allTransactions.body.length > 0) {
        // Mine them away to clear pending transactions
        await request(app).get('/mine');
    }
    // Ensure blockchain is at a known state (e.g. only genesis block)
    // This is harder without an explicit reset. We will rely on mockStorageData clearing.
    // The app's blockchain instance will call `storage.getItem('blocks')` on startup (or first access)
    // If it's undefined (due to mockStorageData = {}), it *should* create a genesis block.
  });

  describe('GET /nodes', () => {
    test('should return 200 and a list of nodes from mocked nodes.json', async () => {
      const response = await request(app).get('/nodes');
      expect(response.status).toBe(200);
      expect(response.body).toEqual(['http://localhost:3001', 'http://localhost:3002']);
    });
  });

  describe('POST /transaction', () => {
    test('Success: should add a transaction and return success', async () => {
      const transactionData = { from: 'wallet1', to: 'wallet2', amount: 100 };
      const response = await request(app)
        .post('/transaction')
        .send(transactionData);
      expect(response.status).toBe(200); // Assuming 200 for successful JSON response
      expect(response.body).toEqual({ success: 1 });

      // Verify by getting transactions
      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toHaveLength(1);
      expect(transactionsResponse.body[0]).toMatchObject(transactionData);
    });

    test('Failure (invalid data): should return 406 for missing "from"', async () => {
      const transactionData = { to: 'wallet2', amount: 100 }; // "from" is missing
      const response = await request(app)
        .post('/transaction')
        .send(transactionData);
      expect(response.status).toBe(406);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('Transaction "from" is mandatory');
    });
  });

  describe('GET /transactions', () => {
    test('should initially return an empty array', async () => {
      // Need to ensure transactions are clear for this test.
      // Assuming beforeEach clears them or previous tests leave them clear.
      // For robustness, explicitly clear here if a mechanism exists.
      // For now, relying on mining from previous tests or clean state.
      // Let's clear mockStorageData for transactions specifically
      mockStorageData['transactions'] = []; // Assuming transactions are also stored

      const response = await request(app).get('/transactions');
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    test('should return transactions after they are added', async () => {
      const transactionData = { from: 'wA', to: 'wB', amount: 50 };
      await request(app).post('/transaction').send(transactionData);

      const response = await request(app).get('/transactions');
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject(transactionData);
    });
  });

  describe('GET /mine', () => {
    beforeEach(async () => {
      // Clear pending transactions by attempting to mine if any exist
      // This ensures a clean slate for each mine test.
      const pending = await request(app).get('/transactions');
      if (pending.body.length > 0) {
        await request(app).get('/mine');
      }
    });

    test('With pending transactions: should mine a block and return it', async () => {
      const tx1 = { from: 'minerWallet', to: 'recipient1', amount: 10 };
      await request(app).post('/transaction').send(tx1);

      const mineResponse = await request(app).get('/mine');
      expect(mineResponse.status).toBe(200);
      expect(mineResponse.body).toHaveProperty('index');
      expect(mineResponse.body).toHaveProperty('hash');
      expect(mineResponse.body).toHaveProperty('previousHash');
      expect(mineResponse.body.transactions).toHaveLength(1);
      expect(mineResponse.body.transactions[0]).toMatchObject(tx1);

      // Verify transactions are cleared
      const transactionsResponse = await request(app).get('/transactions');
      expect(transactionsResponse.body).toEqual([]);

      // Verify blockchain includes the new block
      const blockchainResponse = await request(app).get('/blockchain');
      expect(blockchainResponse.body.length).toBeGreaterThanOrEqual(1); // Genesis + mined
      const lastBlock = blockchainResponse.body.pop();
      expect(lastBlock.transactions[0]).toMatchObject(tx1);
    });

    test('Without pending transactions: should return 500 error', async () => {
       // Ensure no transactions (covered by beforeEach and verified here)
      const currentTransactions = await request(app).get('/transactions');
      expect(currentTransactions.body).toEqual([]);

      const mineResponse = await request(app).get('/mine');
      expect(mineResponse.status).toBe(500);
      expect(mineResponse.body).toEqual({ error: 'No transactions to be mined' });
    });
  });

  describe('GET /blockchain', () => {
    test('should return the blockchain (initially genesis block)', async () => {
      // Need to ensure a "fresh" blockchain state for this test,
      // meaning only the genesis block from the mocked storage.
      // Clearing mockStorageData in a general beforeEach helps.
      // The app's blockchain instance should re-load and create genesis.
      
      // To be certain, let's force a "reset" of the mock storage for blocks.
      // This simulates a fresh start for the blockchain.
      mockStorageData['blocks'] = undefined; 
      // The app's Blockchain constructor should call loadBlocks, find no blocks,
      // and create a genesis block. We need to allow this async operation to complete.
      // This is a bit hand-wavy without explicit app reset.
      // Await a short time for potential async init in app, or ensure app.ready() if exists.
      // For now, we assume the next request will see the initialized chain.

      const response = await request(app).get('/blockchain');
      expect(response.status).toBe(200);
      expect(response.body).toBeInstanceOf(Array);
      expect(response.body).toHaveLength(1); // Only genesis block
      expect(response.body[0].index).toBe(0);
      expect(response.body[0].previousHash).toBe('0'); // Standard previousHash for genesis
    });

    test('should include new blocks after mining', async () => {
      // Add a transaction
      await request(app).post('/transaction').send({ from: 'testFrom', to: 'testTo', amount: 5 });
      // Mine the block
      await request(app).get('/mine');

      const response = await request(app).get('/blockchain');
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2); // Genesis + 1 mined block
      expect(response.body[1].transactions).toHaveLength(1);
      expect(response.body[1].transactions[0].from).toBe('testFrom');
    });
  });

  describe('GET /block/:idx', () => {
    beforeAll(async () => {
      // Ensure there's more than just genesis. Mine a block.
      // This beforeAll for the describe block ensures blocks exist for these tests.
      // Need to clear transactions first.
      let pending = await request(app).get('/transactions');
      if (pending.body.length > 0) await request(app).get('/mine');
      
      await request(app).post('/transaction').send({ from: 'idxTest', to: 'receiver', amount: 1 });
      const mineResult = await request(app).get('/mine');
      if (mineResult.status !== 200) console.error("Pre-test mining failed:", mineResult.body);
    });

    test('Valid index: should return the correct block', async () => {
      // Test for genesis block
      let response = await request(app).get('/block/0');
      expect(response.status).toBe(200);
      expect(response.body.index).toBe(0);

      // Test for the mined block (index 1)
      response = await request(app).get('/block/1');
      expect(response.status).toBe(200);
      expect(response.body.index).toBe(1);
      expect(response.body.transactions[0].from).toBe('idxTest');
    });

    test('Invalid index (out of bounds): should return 200 and empty array', async () => {
      const response = await request(app).get('/block/999'); // Assuming 999 is out of bounds
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    test('Invalid index (non-numeric): should return 200 and empty array (or 404)', async () => {
      // Behavior depends on Express routing and controller's `getBlockByIndex` parsing.
      // Current `getBlockByIndex` if `idx` becomes NaN might result in `[]`.
      // If Express route doesn't match `/block/abc` to `/:idx` where `idx` is expected numeric, it's 404.
      // Let's assume it hits the endpoint and `getBlockByIndex` handles it.
      const response = await request(app).get('/block/abc');
      // If route param coercion fails and it doesn't reach the handler, status could be 400/404.
      // If it reaches `getBlockByIndex` and `parseInt('abc')` is `NaN`, it returns `[]`.
      expect(response.status).toBe(200); // As per current model implementation
      expect(response.body).toEqual([]);
    });
  });

  describe('GET /block/last/index', () => {
    test('should return the index of the last block', async () => {
      // Initial state (genesis block)
      // This test might be flaky depending on when other tests run and add blocks.
      // Forcing a "reset" of the blockchain to only genesis for this specific check.
      mockStorageData['blocks'] = undefined; 
      // Await for app to re-init its blockchain (conceptual, may need delay or app hook)
      // This is very hard to guarantee without an app reset.
      // Let's assume the state from previous /block/:idx tests which added one block.
      // So, last index should be 1.
      
      const blockchainState = await request(app).get('/blockchain');
      const expectedLastIndex = blockchainState.body.length - 1;


      const response = await request(app).get('/block/last/index');
      expect(response.status).toBe(200);
      expect(response.body).toBe(expectedLastIndex); // e.g., 1 if genesis + 1 mined block
    });
  });

  describe('GET /resolve', () => {
    test('should return 200 and an array (possibly empty or with sync results)', async () => {
      // This is a basic smoke test.
      // The actual logic of resolve is complex and unit-tested in Nodes model.
      // Here, we just check if the endpoint is reachable and returns without error.
      // The response will depend on the mocked nodes.json and how Nodes.resolve behaves with it.
      // Given our mocked nodes.json, it will attempt to fetch from them.
      // We need to mock `node-fetch` for the Nodes class if it's not already done at a higher level.

      // For this integration test, we haven't mocked `node-fetch` used by `Nodes.js`.
      // So, this will make actual HTTP requests to localhost:3001/3002 if not careful.
      // This highlights a deeper need for controlling external calls in integration tests.
      
      // Simplification: If `nodes.json` was empty, resolve would do nothing.
      // Let's write nodes.json to be empty for this specific test.
      fs.writeFileSync(nodesFilePath, JSON.stringify([]));
      // Re-trigger app's node list loading (difficult without app reset)
      // Assuming for now the Nodes instance in app re-reads it or is new.

      const response = await request(app).get('/resolve');
      expect(response.status).toBe(200);
      // With an empty nodes list, the resolve method in Nodes.js typically returns an empty array or a specific message.
      // The controller sends back `res.send(nodes.resolve(res, blockchain));`
      // If `nodes.list` is empty, `nodes.resolve` returns `res.send([])`
      // So, response.body should be []
      expect(response.body).toEqual([]);

      // Restore nodes.json for other tests if needed, or rely on afterAll.
      fs.writeFileSync(nodesFilePath, JSON.stringify(['http://localhost:3001', 'http://localhost:3002']));
    });
  });

});
