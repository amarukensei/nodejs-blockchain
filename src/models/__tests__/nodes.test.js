const Nodes = require('../nodes');
const fetch = require('node-fetch');
const fs = require('fs');
const Blockchain = require('../blockchain'); // Though we mock it, it's good to have the actual path

// Mock external dependencies
jest.mock('node-fetch');
jest.mock('fs');
jest.mock('../blockchain'); // Mock the Blockchain class

// No need to mock a global config file for Nodes.js, as url and port are passed to constructor.

describe('Nodes', () => {
  let nodesInstance;
  let mockRes;

  beforeEach(() => {
    // Reset mocks before each test
    fetch.mockReset();
    fs.readFileSync.mockReset();
    Blockchain.mockClear(); // Clear all instances and calls to constructor and all methods.
                           // We will also mock specific Blockchain instances' methods as needed.

    mockRes = {
      send: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(), // Added for completeness, though not directly in Nodes
    };
  });

  describe('constructor', () => {
    test('should populate this.list correctly, excluding the current node URL', () => {
      const nodesJsonContent = JSON.stringify([
        'http://localhost:3000', // Current node
        'http://localhost:3001',
        'http://localhost:3002',
      ]);
      fs.readFileSync.mockReturnValue(nodesJsonContent);

      // Provide URL and port to the constructor as Nodes.js expects
      nodesInstance = new Nodes('http://localhost', '3000');

      // Verify that Nodes.js tries to read the correct nodes.json path
      // process.env.NODE_ENV is usually 'test' in Jest environment
      const expectedNodesPath = require('path').resolve(__dirname, '../../config/nodes.json');
      expect(fs.readFileSync).toHaveBeenCalledWith(expectedNodesPath, 'utf8');
      expect(nodesInstance.list).toEqual([
        'http://localhost:3001',
        'http://localhost:3002',
      ]);
    });

    test('should result in an empty list if nodes.json is empty', () => {
      fs.readFileSync.mockReturnValue(JSON.stringify([]));
      nodesInstance = new Nodes('http://localhost', '3000');
      expect(nodesInstance.list).toEqual([]);
    });

    test('should result in an empty list if nodes.json only contains the current node URL', () => {
      fs.readFileSync.mockReturnValue(JSON.stringify(['http://localhost:3000']));
      nodesInstance = new Nodes('http://localhost', '3000');
      expect(nodesInstance.list).toEqual([]);
    });

    test('should handle errors when nodes.json is not found (though fs mock makes this tricky)', () => {
      fs.readFileSync.mockImplementation(() => {
        throw new Error('File not found');
      });
      // Expect constructor to not throw but initialize with empty list or handle gracefully
      expect(() => {
        nodesInstance = new Nodes('http://localhost', '3000');
      }).not.toThrow();
      expect(nodesInstance.list).toEqual([]);
    });
  });

  describe('resolve(res, blockchain)', () => {
    let mockBlockchain;

    beforeEach(() => {
      // Setup a default nodesInstance for resolve tests
      fs.readFileSync.mockReturnValue(JSON.stringify(['http://localhost:3001', 'http://localhost:3002']));
      // Provide URL and port to the constructor
      nodesInstance = new Nodes('http://localhost', '3000');

      // Create a mock Blockchain instance for each test
      mockBlockchain = new Blockchain(); // Blockchain is mocked, this creates a mocked instance
      mockBlockchain.updateBlocks = jest.fn();
      // Mock the blocks getter. We need to use jest.spyOn for getters/setters on mocked objects
      // or define it directly if the mock is simple.
      // Here, we'll assume 'blocks' is a property that can be set for simplicity with jest.mock.
      // If it were a getter, it'd be: jest.spyOn(mockBlockchain, 'blocks', 'get').mockReturnValue([...]);
      mockBlockchain.blocks = [{ index: 0, hash: 'genesis' }]; // Current chain
    });

    test('Scenario 1: Current chain is shorter, should sync and send status', async () => {
      const longerChain = [{ index: 0 }, { index: 1, hash: 'new_block' }];
      fetch.mockResolvedValueOnce({ // Mock response for first node in list (node1)
        ok: true,
        json: async () => ({ blocks: longerChain, transactions: [] }),
      });
      fetch.mockResolvedValueOnce({ // Mock response for second node (node2) - shorter chain
        ok: true,
        json: async () => ({ blocks: [{ index: 0 }], transactions: [] }),
      });


      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).toHaveBeenCalledWith('http://localhost:3001/blockchain');
      expect(fetch).toHaveBeenCalledWith('http://localhost:3002/blockchain');
      expect(mockBlockchain.updateBlocks).toHaveBeenCalledTimes(1);
      expect(mockBlockchain.updateBlocks).toHaveBeenCalledWith(longerChain, []); // Ensure transactions are also passed
      expect(mockRes.send).toHaveBeenCalledWith(expect.arrayContaining([
        { synced: 'http://localhost:3001' },
        { noaction: 'http://localhost:3002' }
      ]));
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('Scenario 2: Current chain is longer or same length, no sync, send status', async () => {
      const shorterChain = [{ index: 0 }]; // Same as current mockBlockchain.blocks
      fetch.mockResolvedValue({ // Mock response for all nodes
        ok: true,
        json: async () => ({ blocks: shorterChain, transactions: [] }),
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).toHaveBeenCalledTimes(nodesInstance.list.length);
      expect(mockBlockchain.updateBlocks).not.toHaveBeenCalled();
      expect(mockRes.send).toHaveBeenCalledWith(expect.arrayContaining([
        { noaction: 'http://localhost:3001' },
        { noaction: 'http://localhost:3002' }
      ]));
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('Scenario 3: Node fetch error, send error status for that node', async () => {
      fetch.mockRejectedValueOnce(new Error('Network error')); // node1 fails
      fetch.mockResolvedValueOnce({ // node2 is fine, shorter chain
        ok: true,
        json: async () => ({ blocks: [{ index: 0 }], transactions: [] }),
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).toHaveBeenCalledTimes(nodesInstance.list.length);
      expect(mockBlockchain.updateBlocks).not.toHaveBeenCalled();
      expect(mockRes.send).toHaveBeenCalledWith(expect.arrayContaining([
        { error: 'Failed to reach node http://localhost:3001 or node is not responding correctly.' },
        { noaction: 'http://localhost:3002' }
      ]));
      expect(mockRes.status).not.toHaveBeenCalledWith(500); // Not all nodes failed
    });
    
    test('Scenario 3b: Node returns non-ok response, send error status', async () => {
      fetch.mockResolvedValueOnce({ ok: false, status: 500 }); // node1 returns server error
      fetch.mockResolvedValueOnce({ // node2 is fine, shorter chain
        ok: true,
        json: async () => ({ blocks: [{ index: 0 }], transactions: [] }),
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);
      expect(mockRes.send).toHaveBeenCalledWith(expect.arrayContaining([
        { error: 'Failed to reach node http://localhost:3001 or node is not responding correctly.' },
        { noaction: 'http://localhost:3002' }
      ]));
       expect(mockRes.status).not.toHaveBeenCalledWith(500);
    });


    test('Scenario 3c: All nodes fail, set status to 500 and send errors', async () => {
      fetch.mockRejectedValue(new Error('Network error for all')); // All nodes fail

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).toHaveBeenCalledTimes(nodesInstance.list.length);
      expect(mockBlockchain.updateBlocks).not.toHaveBeenCalled();
      expect(mockRes.send).toHaveBeenCalledWith(expect.arrayContaining([
        { error: 'Failed to reach node http://localhost:3001 or node is not responding correctly.' },
        { error: 'Failed to reach node http://localhost:3002 or node is not responding correctly.' }
      ]));
      expect(mockRes.status).toHaveBeenCalledWith(500);
    });

    test('Scenario 4: Multiple nodes with mixed responses', async () => {
      const longerChain = [{ index: 0 }, { index: 1, hash: 'new_block_node1' }];
      const muchLongerChain = [{ index: 0 }, { index: 1 }, {index: 2, hash: 'new_block_node3'}];
      fs.readFileSync.mockReturnValue(JSON.stringify([
        'http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003', 'http://localhost:3004'
      ]));
      // Provide URL and port to the constructor
      nodesInstance = new Nodes('http://localhost', '3000'); // Re-initialize with more nodes

      fetch.mockResolvedValueOnce({ // node1: longer chain
        ok: true,
        json: async () => ({ blocks: longerChain, transactions: ['tx1'] }),
      });
      fetch.mockRejectedValueOnce(new Error('Network error for node2')); // node2: fails
      fetch.mockResolvedValueOnce({ // node3: much longer chain
        ok: true,
        json: async () => ({ blocks: muchLongerChain, transactions: ['tx2', 'tx3'] }),
      });
      fetch.mockResolvedValueOnce({ // node4: shorter chain
        ok: true,
        json: async () => ({ blocks: [{ index: 0 }], transactions: [] }),
      });
      
      mockBlockchain.blocks = [{ index: 0, hash: 'initial_genesis' }];


      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch.mock.calls[0][0]).toBe('http://localhost:3001/blockchain');
      expect(fetch.mock.calls[1][0]).toBe('http://localhost:3002/blockchain');
      expect(fetch.mock.calls[2][0]).toBe('http://localhost:3003/blockchain');
      expect(fetch.mock.calls[3][0]).toBe('http://localhost:3004/blockchain');

      // The longest chain (from node3) should be used for update
      expect(mockBlockchain.updateBlocks).toHaveBeenCalledTimes(1);
      expect(mockBlockchain.updateBlocks).toHaveBeenCalledWith(muchLongerChain, ['tx2', 'tx3']);
      
      expect(mockRes.send).toHaveBeenCalledWith(expect.arrayContaining([
        { synced: 'http://localhost:3001' }, // This is technically true, it was longer than original
        { error: 'Failed to reach node http://localhost:3002 or node is not responding correctly.' },
        { synced: 'http://localhost:3003' }, // This is the one that provided the final longest chain
        { noaction: 'http://localhost:3004' }
      ]));
      expect(mockRes.status).not.toHaveBeenCalledWith(500);
    });
  });

  describe('broadcast()', () => {
    beforeEach(() => {
      // Setup a default nodesInstance for broadcast tests
      fs.readFileSync.mockReturnValue(JSON.stringify(['http://localhost:3001', 'http://localhost:3002']));
      // Provide URL and port to the constructor
      nodesInstance = new Nodes('http://localhost', '3000');
      global.console = { log: jest.fn() }; // Mock console.log
    });

    afterEach(() => {
      // Restore console.log
      global.console = require('console');
    });

    test('should call fetch for each node in this.list with /resolve endpoint', async () => {
      fetch.mockResolvedValue({ // Mock a generic successful response for /resolve
        ok: true,
        json: async () => ({ message: 'Resolved' }),
      });

      await nodesInstance.broadcast();

      expect(fetch).toHaveBeenCalledTimes(nodesInstance.list.length);
      expect(fetch).toHaveBeenCalledWith('http://localhost:3001/resolve', { method: 'POST' });
      expect(fetch).toHaveBeenCalledWith('http://localhost:3002/resolve', { method: 'POST' });
    });

    test('should log responses from each node', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ node: 'node1 response' }),
      });
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ node: 'node2 response' }),
      });

      await nodesInstance.broadcast();

      expect(console.log).toHaveBeenCalledWith({ node: 'node1 response' });
      expect(console.log).toHaveBeenCalledWith({ node: 'node2 response' });
    });

    test('should log errors if fetch fails for a node', async () => {
      fetch.mockResolvedValueOnce({ // Successful for node1
        ok: true,
        json: async () => ({ node: 'node1 success' }),
      });
      fetch.mockRejectedValueOnce(new Error('Node2 network error')); // Fails for node2

      await nodesInstance.broadcast();

      expect(console.log).toHaveBeenCalledWith({ node: 'node1 success' });
      expect(console.log).toHaveBeenCalledWith(new Error('Node2 network error'));
    });

     test('should log errors if fetch response is not ok', async () => {
      fetch.mockResolvedValueOnce({ // node1 ok
        ok: true,
        json: async () => ({ node: 'node1 success' }),
      });
      fetch.mockResolvedValueOnce({ // node2 not ok
        ok: false,
        status: 500,
        json: async () => ({ error: 'node2 server error' })
      });

      await nodesInstance.broadcast();

      expect(console.log).toHaveBeenCalledWith({ node: 'node1 success' });
      // The actual code logs the response object, not a custom error string here.
      expect(console.log).toHaveBeenCalledWith(expect.objectContaining({ ok: false, status: 500}));
    });
  });
});
