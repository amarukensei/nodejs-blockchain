const Blockchain = require('../blockchain');
const Block = require('../block');
const Nodes = require('../nodes');
const storage = require('node-persist');
const sha256 = require('js-sha256');

// Mock dependencies
jest.mock('../block');
jest.mock('../nodes');
jest.mock('js-sha256');

// Improved mock for node-persist
const mockStorage = {
  init: jest.fn().mockResolvedValue(undefined),
  getItem: jest.fn().mockResolvedValue(undefined), // Default to resolve with undefined
  setItem: jest.fn().mockResolvedValue(undefined),
  clear: jest.fn().mockResolvedValue(undefined), // if used
  // Add other methods if Blockchain uses them, e.g., length, key, etc.
};
jest.mock('node-persist', () => ({
  create: jest.fn().mockReturnValue(mockStorage), // create() returns our mockStorage object
  // Static methods like `რედაქტირება` or `რედაქტირებაSync` would be mocked here if used directly,
  // but Blockchain seems to use an instance via create().config().
}));

// Actual storage instance used by Blockchain class will be our mockStorage.
// We can refer to `mockStorage.init`, `mockStorage.getItem` etc. in tests.

describe('Blockchain', () => {
  let blockchain; // Will hold Blockchain instance
  let mockTransactions;
  let mockRes;

  beforeEach(async () => { // Made beforeEach async to handle async blockchain instantiation
    // Reset all general mocks
    Block.mockClear();
    Nodes.mockClear(); // Assuming Nodes has been mocked and its methods are jest.fn()
    sha256.mockClear();

    // Clear mocks on our mockStorage object
    mockStorage.init.mockClear();
    mockStorage.getItem.mockClear();
    mockStorage.setItem.mockClear();
    mockStorage.clear.mockClear();

    // Set default behaviors for storage methods for each test
    // (can be overridden in specific tests if needed)
    mockStorage.getItem.mockImplementation(async (key) => {
      if (key === 'blocks') return undefined; // Default: no blocks
      if (key === 'transactions') return undefined; // Default: no pending transactions
      return undefined;
    });
    
    // Initialize blockchain here. Constructor calls async loadBlocks().
    // The Blockchain constructor itself isn't async, but it triggers async operations.
    blockchain = new Blockchain();
    // Ensure async operations triggered by constructor (like loadBlocks) complete.
    // Blockchain.js needs to expose a promise for this, or tests need to account for it.
    // For now, we assume `loadBlocksPromise` or similar exists, or that subsequent awaits in tests handle it.
    // If Blockchain class has a promise like `this.loadBlocksPromise = this.loadBlocks();`
    // then we can do: await blockchain.loadBlocksPromise;
    // Based on the original test, it seems `await blockchain.loadBlocks()` was called manually.
    // Let's assume the constructor handles loadBlocks internally and we might need to wait if structure changed.
    // If Blockchain constructor now internally awaits loadBlocks, then `new Blockchain()` might return a promise implicitly.
    // However, standard JS constructors don't return promises.
    // We will rely on the fact that storage calls are awaited inside Blockchain methods.

    // Common mock objects
    mockTransactions = {
      list: [{ id: 'tx1' }],
      reset: jest.fn(), // Assuming Transactions has a reset method
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(), // Used by some methods
    };
  });

  describe('constructor', () => {
    test('Scenario 1: No existing blocks in storage', async () => {
      // getItem is configured in beforeEach to return undefined for 'blocks' and 'transactions'
      // Re-initialize blockchain to ensure constructor logic with these mocks is tested.
      blockchain = new Blockchain();
      // The constructor should call loadBlocks, which in turn might call addBlock for genesis.
      // We need to await the completion of these async operations.
      // A common pattern is for the class to expose a promise that resolves when init is done.
      // If not, we might need a small delay or rely on internal awaits in Blockchain.
      // For now, assume Blockchain's constructor internally handles this,
      // and its methods correctly await storage operations.
      
      // Let's use a small delay to allow async operations in constructor to complete.
      // This is not ideal, a dedicated promise from Blockchain would be better.
      await new Promise(resolve => setTimeout(resolve, 0));


      expect(mockStorage.init).toHaveBeenCalledTimes(1);
      // getItem would be called for 'blocks' and 'transactions' by loadBlocks
      expect(mockStorage.getItem).toHaveBeenCalledWith('blocks');
      expect(mockStorage.getItem).toHaveBeenCalledWith('transactions');
      
      // A genesis block should be created if mockStorage.getItem('blocks') was undefined
      expect(Block).toHaveBeenCalledTimes(1); // For the genesis block
      expect(blockchain.blocks).toHaveLength(1);
      expect(blockchain.blocks[0]).toBeInstanceOf(Block);
      // setItem is called by addBlock (which is called for genesis)
      expect(mockStorage.setItem).toHaveBeenCalledWith('blocks', blockchain.blocks);
      // setItem might also be called for transactions if they are initialized
      // expect(mockStorage.setItem).toHaveBeenCalledWith('transactions', []);
    });

    test('Scenario 2: Existing blocks in storage', async () => {
      const existingBlocksData = [
        { index: 0, previousHash: '0', timestamp: Date.now(), transactions: [], nonce: 0, hash: 'hash0' },
        { index: 1, previousHash: 'hash0', timestamp: Date.now(), transactions: [], nonce: 1, hash: 'hash1' },
      ];
      mockStorage.getItem.mockImplementation(async (key) => {
        if (key === 'blocks') return existingBlocksData;
        if (key === 'transactions') return []; // Or some existing transactions
        return undefined;
      });

      Block.mockClear(); // Clear any calls from previous tests or beforeEach setup

      blockchain = new Blockchain(); // Re-initialize with the new mock for getItem
      await new Promise(resolve => setTimeout(resolve, 0)); // Allow async loadBlocks to complete

      expect(mockStorage.init).toHaveBeenCalledTimes(1);
      expect(mockStorage.getItem).toHaveBeenCalledWith('blocks');
      
      expect(blockchain.blocks).toEqual(existingBlocksData); // Blocks should be loaded
      expect(Block).not.toHaveBeenCalled(); // No NEW Block instances should be made if loaded from storage
      // setItem should not be called for 'blocks' if they were just loaded and not changed
      expect(mockStorage.setItem).not.toHaveBeenCalledWith('blocks', expect.any(Array));
    });
  });

  describe('addBlock(block)', () => {
    let mockBlockInstance;

    beforeEach(() => {
      // Create a fresh mock Block instance for each addBlock test
      // This represents the block *to be added*
      mockBlockInstance = new Block(); // This is a mock Block instance
      mockBlockInstance.key = 'test-key'; // Mock key for hash generation
      mockBlockInstance.nonce = 0;    // Mock nonce for hash generation
      // Mock methods or properties on this specific instance if needed
      // e.g., mockBlockInstance.addTransactions = jest.fn();

      // Ensure blockchain.blocks is clean for specific scenarios
      blockchain.blocks = [];
      sha256.mockReturnValue('dummy-hash'); // Ensure generateHash works
    });

    test('Scenario 1: Adding the first block (genesis)', async () => {
      // The block passed to addBlock is assumed to be a new block, possibly genesis
      // For genesis, previousHash and hash are set by addBlock.
      
      await blockchain.addBlock(mockBlockInstance);

      expect(mockBlockInstance.previousHash).toBe("0000000000000000");
      // Verify hash generation was called
      expect(sha256).toHaveBeenCalled(); // generateHash was called
      expect(mockBlockInstance.hash).toBe('dummy-hash'); // generateHash assigned the hash
      expect(blockchain.blocks).toHaveLength(1);
      expect(blockchain.blocks[0]).toBe(mockBlockInstance);
      expect(mockStorage.setItem).toHaveBeenCalledWith('blocks', blockchain.blocks);
    });

    test('Scenario 2: Adding a subsequent block', async () => {
      const previousBlock = new Block(); // Mock existing block
      previousBlock.hash = 'previous-block-hash';
      blockchain.blocks = [previousBlock]; // Setup existing chain
      
      await blockchain.addBlock(mockBlockInstance);

      expect(mockBlockInstance.previousHash).toBe(previousBlock.hash);
      expect(sha256).toHaveBeenCalled(); 
      expect(mockBlockInstance.hash).toBe('dummy-hash');
      expect(blockchain.blocks).toHaveLength(2);
      expect(blockchain.blocks[1]).toBe(mockBlockInstance);
      expect(mockStorage.setItem).toHaveBeenCalledWith('blocks', blockchain.blocks);
    });
  });

  describe('getNextBlock(transactions)', () => {
    let mockPreviousBlock;
    let mockNewBlockInstance;

    beforeEach(() => {
      mockPreviousBlock = new Block(); // Mock instance of Block
      mockPreviousBlock.index = 0;
      mockPreviousBlock.hash = 'prev-hash';
      
      // Mock getPreviousBlock to return our controlled block
      blockchain.getPreviousBlock = jest.fn().mockReturnValue(mockPreviousBlock);

      // Mock generateHash to return a predictable hash
      blockchain.generateHash = jest.fn().mockReturnValue('next-block-hash');
      
      // When `new Block(...)` is called inside getNextBlock, it should return our mock instance
      mockNewBlockInstance = new Block(); // This is the block getNextBlock will "create"
      mockNewBlockInstance.addTransactions = jest.fn(); // Mock its methods
      Block.mockImplementation(() => mockNewBlockInstance);


    });

    test('should create and return a new block with correct properties', () => {
      const resultBlock = blockchain.getNextBlock(mockTransactions);

      expect(Block).toHaveBeenCalledTimes(1); // A new Block was instantiated
      // Check constructor arguments for the new block if necessary, e.g.
      // expect(Block).toHaveBeenCalledWith(expect.any(Number), mockPreviousBlock.hash, ???); 
      // This depends on how Block is constructed and what getNextBlock passes.
      // Based on typical blockchain logic:
      // new Block(timestamp, previousHash, transactions (handled by addTransactions), nonce, hash)
      // Nonce and hash are set by generateHash.
      // The actual Block constructor in the code takes: timestamp, previousHash, transactions (raw), nonce, hash

      expect(resultBlock).toBe(mockNewBlockInstance); // Returns the created mock instance
      expect(resultBlock.addTransactions).toHaveBeenCalledWith(mockTransactions);
      expect(resultBlock.index).toBe(mockPreviousBlock.index + 1);
      expect(resultBlock.previousHash).toBe(mockPreviousBlock.hash);
      expect(blockchain.generateHash).toHaveBeenCalledWith(resultBlock);
      expect(resultBlock.hash).toBe('next-block-hash');
    });
  });

  describe('getPreviousBlock()', () => {
    test('should return the last block in the chain', () => {
      const block1 = { index: 0 };
      const block2 = { index: 1 };
      blockchain.blocks = [block1, block2];
      expect(blockchain.getPreviousBlock()).toBe(block2);
    });

    test('should return undefined if chain is empty (though constructor adds genesis)', () => {
      blockchain.blocks = []; // Force empty
      expect(blockchain.getPreviousBlock()).toBeUndefined();
    });
  });

  describe('generateHash(block)', () => {
    let mockBlockForKey;

    beforeEach(() => {
      mockBlockForKey = { // Not a Block instance, just an object with key and nonce
        key: 'test_data_for_hashing',
        nonce: 0,
      };
      // Reset sha256 mock for specific call counting per test
      sha256.mockClear();
    });

    test('should call js-sha256 until hash starts with "000"', () => {
      sha256
        .mockReturnValueOnce('123hash')
        .mockReturnValueOnce('012hash')
        .mockReturnValueOnce('000hash_success');

      const hash = blockchain.generateHash(mockBlockForKey);

      expect(sha256).toHaveBeenCalledTimes(3);
      expect(sha256).toHaveBeenNthCalledWith(1, mockBlockForKey.key + 0);
      expect(sha256).toHaveBeenNthCalledWith(2, mockBlockForKey.key + 1);
      expect(sha256).toHaveBeenNthCalledWith(3, mockBlockForKey.key + 2);
      expect(mockBlockForKey.nonce).toBe(2); // Nonce incremented until success
      expect(hash).toBe('000hash_success');
    });

    test('should handle block without a key property gracefully (or throw error)', () => {
        // Based on current implementation, it would be `undefined + nonce` leading to `NaN` in string context
        // then sha256 would hash "NaN0", "NaN1" etc. This is probably not intended.
        // For now, let's test current behavior.
        const blockWithoutKey = { nonce: 0 };
        sha256.mockReturnValueOnce('000_hash_for_nan');
        
        const hash = blockchain.generateHash(blockWithoutKey);
        
        expect(sha256).toHaveBeenCalledWith('undefined0'); // Or "NaN0" depending on JS coercion
        expect(blockWithoutKey.nonce).toBe(0);
        expect(hash).toBe('000_hash_for_nan');
    });
  });

  describe('mine(transactions, res)', () => {
    let mockNewBlock;

    beforeEach(() => {
      mockNewBlock = new Block(); // A mock block that getNextBlock will return
      mockNewBlock.hash = 'mined-block-hash'; // Give it some identifiable property

      blockchain.getNextBlock = jest.fn().mockReturnValue(mockNewBlock);
      blockchain.addBlock = jest.fn().mockResolvedValue(undefined); // Simulate async addBlock

      // Mock Nodes instance and its broadcast method
      // blockchain.nodes is an instance of the mocked Nodes class.
      // So we need to ensure its broadcast method is a mock.
      // The Nodes mock should handle this if its methods are jest.fn()
      // If blockchain.nodes was instantiated with `new Nodes()`, and Nodes is jest.mocked:
      // then blockchain.nodes.broadcast should already be a jest.fn().
      // Let's verify by ensuring Nodes.mock.instances[0].broadcast exists if an instance was made.
      if (Nodes.mock.instances.length > 0) {
        Nodes.mock.instances[0].broadcast = jest.fn();
        blockchain.nodes = Nodes.mock.instances[0]; // ensure our blockchain uses this instance
      } else {
        // If constructor didn't make one, create a manual one for the test
        const mockNodesInstance = new Nodes();
        mockNodesInstance.broadcast = jest.fn();
        blockchain.nodes = mockNodesInstance;
      }
    });

    test('Success case: should mine block and broadcast', async () => {
      mockTransactions.list = [{ id: 'tx1' }]; // Ensure transactions exist

      const result = await blockchain.mine(mockTransactions, mockRes);

      expect(blockchain.getNextBlock).toHaveBeenCalledWith(mockTransactions);
      expect(blockchain.addBlock).toHaveBeenCalledWith(mockNewBlock);
      expect(blockchain.nodes.broadcast).toHaveBeenCalledTimes(1);
      expect(result).toBe(mockNewBlock);
      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockRes.json).not.toHaveBeenCalled(); // Or check for specific success response if any
    });

    test('Failure case: no transactions to be mined', async () => {
      mockTransactions.list = []; // No transactions

      const result = await blockchain.mine(mockTransactions, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      // The actual implementation sends {error: ...} via res.send, not res.json
      // And it doesn't return the error object from the function itself, but undefined.
      // Let's adjust based on the actual code's behavior for mine:
      // It calls `res.send({error: ...})` and returns nothing in case of error.
      // If successful, it returns the block.

      // The original code does: `return res.status(500).send({error: ...})`
      // which means the function would return the result of `res.send(...)`
      // Let's assume `res.send` returns `res` for chaining or `undefined`.
      // For testing, we care that `res.send` was called with the error.
      expect(mockRes.send).toHaveBeenCalledWith({ error: 'No transactions to be mined' });

      // The function should effectively return undefined or what res.send returns
      // If it returns the res object: expect(result).toBe(mockRes);
      // If it returns what res.send returns (e.g. undefined): expect(result).toBeUndefined();
      // Given `return res.status(500).send(...)`, it returns the result of `send`.
      // We'll assume `send` returns `res` for now. If not, the test for `result` might need adjustment.
      // Let's check if `res.send` was called, which is more robust.

      expect(blockchain.getNextBlock).not.toHaveBeenCalled();
      expect(blockchain.addBlock).not.toHaveBeenCalled();
      expect(blockchain.nodes.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('updateBlocks(blocks, transactions)', () => { // Added transactions based on impl.
    test('should replace this.blocks and this.transactions, and save blocks', async () => {
      const newBlocksArray = [{ index: 0, hash: 'new_genesis' }];
      const newTransactionsArray = [{id: 'new_tx'}];
      
      // Mock blockchain's current transactions if the method also updates them
      blockchain.transactions = { list: [], reset: jest.fn() };


      await blockchain.updateBlocks(newBlocksArray, newTransactionsArray);

      expect(blockchain.blocks).toBe(newBlocksArray);
      expect(blockchain.transactions.list).toBe(newTransactionsArray); 

      expect(mockStorage.setItem).toHaveBeenCalledWith('blocks', newBlocksArray);
      expect(mockStorage.setItem).toHaveBeenCalledWith('transactions', newTransactionsArray);
    });
  });
  
  describe('getBlockByIndex(idx)', () => {
    beforeEach(() => {
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
      expect(blockchain.getBlockByIndex(5)).toEqual([]); // As per current code snippet
    });

    test('should return empty array for a negative index', () => {
      expect(blockchain.getBlockByIndex(-1)).toEqual([]); // As per current code snippet
    });
     test('should return empty array for non-numeric index', () => {
      expect(blockchain.getBlockByIndex("abc")).toEqual([]);
    });
  });

  describe('getBlockLastIndex()', () => {
    test('should return the last index when blocks exist', () => {
      blockchain.blocks = [{ index: 0 }, { index: 1 }, { index: 2 }];
      expect(blockchain.getBlockLastIndex()).toBe(2);
    });

    test('should return -1 when no blocks exist', () => {
      blockchain.blocks = [];
      expect(blockchain.getBlockLastIndex()).toBe(-1);
    });
  });
});
