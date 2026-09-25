jest.mock('../../../config/nodes.json', () => [
  'http://localhost:3000', // Current node
  'http://localhost:3001',
  'http://localhost:3002',
]);

const Nodes = require('../nodes');

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
      blocks: [{ index: 0, hash: 'genesis' }],
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
  });

  describe('resolve(res, blockchain)', () => {
    test('should respond with an empty list when there are no other nodes', async () => {
      nodesInstance.list = [];

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(fetch).not.toHaveBeenCalled();
      expect(mockRes.send).toHaveBeenCalledWith([]);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('should sync with a node that has a longer chain', async () => {
      const longerChain = [{ index: 0 }, { index: 1, hash: 'new_block' }];
      fetch.mockImplementation(async (url) => (
        url == 'http://localhost:3001/blockchain' ? Response.json(longerChain) : Response.json([{ index: 0 }])
      ));

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

    test('should report nodes that send an invalid chain', async () => {
      mockBlockchain.updateBlocks.mockReturnValue(false);
      fetch.mockImplementation(async (url) => (
        url == 'http://localhost:3001/blockchain' ? Response.json({ length: 99 }) : Response.json([{ index: 0 }])
      ));

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(mockBlockchain.updateBlocks).toHaveBeenCalledWith({ length: 99 });
      expect(mockRes.send).toHaveBeenCalledWith([
        { error: 'Invalid blockchain received from node at http://localhost:3001' },
        { noaction: 'http://localhost:3002' },
      ]);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('should report unreachable nodes without exposing the error details', async () => {
      fetch.mockImplementation(async (url) => {
        if (url == 'http://localhost:3001/blockchain') {
          throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:3001') });
        }
        return Response.json([{ index: 0 }]);
      });

      await nodesInstance.resolve(mockRes, mockBlockchain);

      expect(mockBlockchain.updateBlocks).not.toHaveBeenCalled();
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

  describe('broadcast()', () => {
    test('should ask every node to resolve and log their responses', async () => {
      fetch.mockImplementation(async (url) => Response.json({ node: url }));

      await nodesInstance.broadcast();

      expect(fetch).toHaveBeenCalledTimes(nodesInstance.list.length);
      expect(fetch).toHaveBeenCalledWith('http://localhost:3001/resolve', { signal: expect.any(AbortSignal), redirect: 'error' });
      expect(fetch).toHaveBeenCalledWith('http://localhost:3002/resolve', { signal: expect.any(AbortSignal), redirect: 'error' });
      expect(console.log).toHaveBeenCalledWith('http://localhost:3001', { node: 'http://localhost:3001/resolve' });
      expect(console.log).toHaveBeenCalledWith('http://localhost:3002', { node: 'http://localhost:3002/resolve' });
    });

    test('should log errors if a node cannot be reached', async () => {
      const error = new Error('Node2 network error');
      fetch.mockImplementation(async (url) => {
        if (url == 'http://localhost:3002/resolve') {
          throw error;
        }
        return Response.json({ node: 'node1 success' });
      });

      await nodesInstance.broadcast();

      expect(console.log).toHaveBeenCalledWith('http://localhost:3001', { node: 'node1 success' });
      expect(console.log).toHaveBeenCalledWith('http://localhost:3002', error);
    });
  });
});
