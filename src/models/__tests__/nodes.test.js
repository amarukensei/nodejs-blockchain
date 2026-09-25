jest.mock('../../../config/nodes.json', () => [
  'http://localhost:3000', // Current node
  'http://localhost:3001',
  'http://localhost:3002',
]);

const Nodes = require('../nodes');

// A chain of blocks linked by their hashes, which start with `prefix`
function makeChain(length, prefix = 'h') {
  return Array.from({ length }, (_, index) => ({ index, hash: prefix + index, previousHash: index > 0 ? prefix + (index - 1) : '0' }));
}

// Makes fetch answer each URL in `routes` with its JSON, and fail for any other
function mockRoutes(routes) {
  fetch.mockImplementation(async (url) => {
    if (!(url in routes)) {
      throw new Error('Unexpected request to ' + url);
    }
    return Response.json(routes[url]);
  });
}

describe('Nodes', () => {
  let nodesInstance;
  let mockRes;
  let mockBlockchain;

  beforeEach(() => {
    jest.spyOn(global, 'fetch');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    nodesInstance = new Nodes('localhost', '3000');
    mockRes = {
      send: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
    mockBlockchain = {
      blocks: makeChain(1),
      // In these tests, a longer chain has more work
      hasLessWorkThan: jest.fn(function(blocks) {
        return blocks.length > this.blocks.length;
      }),
      updateBlocks: jest.fn().mockReturnValue(true),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('constructor', () => {
    test('should populate this.list correctly, excluding the current node URL', () => {
      expect(nodesInstance.list).toEqual([
        'http://localhost:3001',
        'http://localhost:3002',
      ]);
    });

    test('should only exclude the node with the same host and port', () => {
      expect(new Nodes('localhost', 300).list).toEqual([
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
      ]);
      expect(new Nodes('127.0.0.1', 3000).list).toHaveLength(3);
    });
  });

  describe('isLoopback(host)', () => {
    test.each(['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]'])('should be true for %s', (host) => {
      expect(Nodes.isLoopback(host)).toBe(true);
    });

    test.each(['0.0.0.0', '192.168.1.10', 'example.com', '127.0.0.1.example.com', '::'])('should be false for %s', (host) => {
      expect(Nodes.isLoopback(host)).toBe(false);
    });
  });

  describe('insecure()', () => {
    test('should list the nodes on other machines reached over plain HTTP', () => {
      nodesInstance.list = [
        'http://192.168.1.10:4000',
        'https://192.168.1.11:4000',
        'http://localhost:4001',
        'http://127.0.0.1:4002',
        'http://[::1]:4003',
        'http://node.example.com',
      ];

      expect(nodesInstance.insecure()).toEqual(['http://192.168.1.10:4000', 'http://node.example.com']);
    });
  });

  describe('resolve(res, blockchain)', () => {
    test('should respond with an empty list when there are no other nodes', async () => {
      nodesInstance.list = [];

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).not.toHaveBeenCalled();
      expect(mockRes.send).toHaveBeenCalledWith([]);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('should get the whole chain of every node while its own is short, and sync with the one with more work', async () => {
      const longerChain = makeChain(3);
      mockRoutes({
        'http://localhost:3001/blockchain': longerChain,
        'http://localhost:3002/blockchain': makeChain(1),
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).toHaveBeenCalledWith('http://localhost:3001/blockchain', { signal: expect.any(AbortSignal), redirect: 'error' });
      expect(fetch).toHaveBeenCalledWith('http://localhost:3002/blockchain', { signal: expect.any(AbortSignal), redirect: 'error' });
      expect(mockBlockchain.updateBlocks).toHaveBeenCalledTimes(1);
      expect(mockBlockchain.updateBlocks).toHaveBeenCalledWith(longerChain);
      expect(mockRes.send).toHaveBeenCalledWith([
        { synced: 'http://localhost:3001' },
        { noaction: 'http://localhost:3002' },
      ]);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('should only get the last 10 blocks of the other chains, and join them to the blocks before them in its own', async () => {
      mockBlockchain.blocks = makeChain(15);
      const otherChain = makeChain(17);
      mockRoutes({
        'http://localhost:3001/blockchain?from=5': otherChain.slice(5),
        'http://localhost:3002/blockchain?from=5': mockBlockchain.blocks.slice(5),
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(mockBlockchain.updateBlocks).toHaveBeenCalledTimes(1);
      const received = mockBlockchain.updateBlocks.mock.calls[0][0];
      expect(received).toEqual(otherChain);
      // The first blocks are the ones it already had
      expect(received[4]).toBe(mockBlockchain.blocks[4]);
      expect(mockRes.send).toHaveBeenCalledWith([
        { synced: 'http://localhost:3001' },
        { noaction: 'http://localhost:3002' },
      ]);
    });

    test('should get the whole chain of a node whose chain forks before its last 10 blocks', async () => {
      mockBlockchain.blocks = makeChain(15);
      const otherChain = makeChain(1).concat(makeChain(17, 'x').slice(1));
      otherChain[1].previousHash = 'h0';
      mockRoutes({
        'http://localhost:3001/blockchain?from=5': otherChain.slice(5),
        'http://localhost:3001/blockchain': otherChain,
        'http://localhost:3002/blockchain?from=5': mockBlockchain.blocks.slice(5),
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(mockBlockchain.updateBlocks).toHaveBeenCalledWith(otherChain);
      expect(mockRes.send).toHaveBeenCalledWith([
        { synced: 'http://localhost:3001' },
        { noaction: 'http://localhost:3002' },
      ]);
    });

    test('should get the whole chain of a node whose chain does not reach its last 10 blocks', async () => {
      mockBlockchain.blocks = makeChain(15);
      mockRoutes({
        'http://localhost:3001/blockchain?from=5': [],
        'http://localhost:3001/blockchain': makeChain(3),
        'http://localhost:3002/blockchain?from=5': mockBlockchain.blocks.slice(5),
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).toHaveBeenCalledWith('http://localhost:3001/blockchain', { signal: expect.any(AbortSignal), redirect: 'error' });
      expect(mockBlockchain.hasLessWorkThan).toHaveBeenCalledWith(makeChain(3));
      expect(mockBlockchain.updateBlocks).not.toHaveBeenCalled();
      expect(mockRes.send).toHaveBeenCalledWith([
        { noaction: 'http://localhost:3001' },
        { noaction: 'http://localhost:3002' },
      ]);
    });

    test('should report nodes that send an invalid chain', async () => {
      mockBlockchain.updateBlocks.mockReturnValue(false);
      mockRoutes({
        'http://localhost:3001/blockchain': { length: 99 },
        'http://localhost:3002/blockchain': makeChain(1),
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(mockBlockchain.updateBlocks).toHaveBeenCalledWith({ length: 99 });
      expect(console.error).toHaveBeenCalledWith('Rejected invalid blockchain from node at http://localhost:3001');
      expect(mockRes.send).toHaveBeenCalledWith([
        { error: 'Invalid blockchain received from node at http://localhost:3001' },
        { noaction: 'http://localhost:3002' },
      ]);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('should pass on anything but a list of blocks when it asked for the last ones', async () => {
      mockBlockchain.blocks = makeChain(15);
      mockBlockchain.updateBlocks.mockReturnValue(false);
      mockRoutes({
        'http://localhost:3001/blockchain?from=5': { length: 99 },
        'http://localhost:3002/blockchain?from=5': mockBlockchain.blocks.slice(5),
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(mockBlockchain.updateBlocks).toHaveBeenCalledWith({ length: 99 });
      expect(mockRes.send).toHaveBeenCalledWith([
        { error: 'Invalid blockchain received from node at http://localhost:3001' },
        { noaction: 'http://localhost:3002' },
      ]);
    });

    test('should report unreachable nodes without exposing the error details', async () => {
      fetch.mockImplementation(async (url) => {
        if (url == 'http://localhost:3001/blockchain') {
          throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3001') });
        }
        return Response.json(makeChain(1));
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(mockBlockchain.updateBlocks).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith('Failed to reach node at http://localhost:3001:', 'connect ECONNREFUSED 127.0.0.1:3001');
      expect(mockRes.send).toHaveBeenCalledWith([
        { error: 'Failed to reach node at http://localhost:3001' },
        { noaction: 'http://localhost:3002' },
      ]);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('should treat error responses and invalid JSON as failures, with status 500 when all nodes fail', async () => {
      fetch.mockImplementation(async (url) => (
        url == 'http://localhost:3001/blockchain' ? new Response('oops', { status: 500 }) : new Response('not json')
      ));

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(mockBlockchain.updateBlocks).not.toHaveBeenCalled();
      expect(mockRes.send).toHaveBeenCalledWith([
        { error: 'Failed to reach node at http://localhost:3001' },
        { error: 'Failed to reach node at http://localhost:3002' },
      ]);
      expect(mockRes.status).toHaveBeenCalledWith(500);
    });

    test('should stop reading responses larger than 50MB', async () => {
      const chunk = new Uint8Array(1024 * 1024);
      let chunksSent = 0;
      fetch.mockImplementation(async () => new Response(new ReadableStream({
        pull(controller) {
          chunksSent++;
          controller.enqueue(chunk);
        },
      })));

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(mockBlockchain.updateBlocks).not.toHaveBeenCalled();
      expect(mockRes.send).toHaveBeenCalledWith([
        { error: 'Failed to reach node at http://localhost:3001' },
        { error: 'Failed to reach node at http://localhost:3002' },
      ]);
      expect(chunksSent).toBeLessThan(2 * 60);
    });
  });

  describe('sync(blockchain)', () => {
    test('should return what happened with each node', async () => {
      mockRoutes({
        'http://localhost:3001/blockchain': makeChain(2),
        'http://localhost:3002/blockchain': makeChain(1),
      });

      await expect(nodesInstance.sync(mockBlockchain)).resolves.toEqual([
        { synced: 'http://localhost:3001' },
        { noaction: 'http://localhost:3002' },
      ]);
    });
  });

  describe('broadcast()', () => {
    test('should ask every node to resolve and log their responses in one line', async () => {
      fetch.mockImplementation(async (url) => Response.json([{ synced: url }]));

      await nodesInstance.broadcast();

      expect(fetch).toHaveBeenCalledTimes(nodesInstance.list.length);
      expect(fetch).toHaveBeenCalledWith('http://localhost:3001/resolve', { signal: expect.any(AbortSignal), redirect: 'error' });
      expect(fetch).toHaveBeenCalledWith('http://localhost:3002/resolve', { signal: expect.any(AbortSignal), redirect: 'error' });
      expect(console.log).toHaveBeenCalledWith('http://localhost:3001', '[{"synced":"http://localhost:3001/resolve"}]');
      expect(console.log).toHaveBeenCalledWith('http://localhost:3002', '[{"synced":"http://localhost:3002/resolve"}]');
    });

    test('should log only the message of the errors', async () => {
      fetch.mockImplementation(async (url) => {
        if (url == 'http://localhost:3002/resolve') {
          throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3002') });
        }
        return new Response('oops', { status: 500 });
      });

      await nodesInstance.broadcast();

      expect(console.log).toHaveBeenCalledWith('http://localhost:3001', 'Unexpected response status 500');
      expect(console.log).toHaveBeenCalledWith('http://localhost:3002', 'connect ECONNREFUSED 127.0.0.1:3002');
    });
  });

  describe('shareTransaction(tx)', () => {
    test('should send the transaction to every node', async () => {
      const tx = { from: 'alice', to: 'bob', amount: 1 };
      fetch.mockImplementation(async () => Response.json({ success: 1 }));

      await nodesInstance.shareTransaction(tx);

      for (const node of ['http://localhost:3001', 'http://localhost:3002']) {
        expect(fetch).toHaveBeenCalledWith(node + '/transaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(tx),
          signal: expect.any(AbortSignal),
          redirect: 'error',
        });
      }
      expect(console.log).not.toHaveBeenCalled();
    });

    test('should log the nodes that do not take it, such as the ones that already had it', async () => {
      fetch.mockImplementation(async (url) => (
        url == 'http://localhost:3001/transaction' ? Response.json({ error: 'Transaction already received' }, { status: 406 }) : Response.json({ success: 1 })
      ));

      await nodesInstance.shareTransaction({ from: 'alice' });

      expect(console.log).toHaveBeenCalledTimes(1);
      expect(console.log).toHaveBeenCalledWith('http://localhost:3001', 'Unexpected response status 406');
    });
  });
});
