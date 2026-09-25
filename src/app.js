const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const blockchainController = require('./controllers/blockchain');
const keys = require('./models/keys');
const Nodes = require('./models/nodes');

// Private key of the wallet in MINER_WALLET, which signs the blocks the node mines and gets their
// rewards. Without it the node doesn't mine.
function loadMinerKey() {
    if (process.env.MINER_ADDRESS) {
        throw new Error('MINER_ADDRESS was replaced by MINER_WALLET, the wallet file of the miner');
    }
    const file = process.env.MINER_WALLET;
    if (!file) {
        return null;
    }

    const pem = fs.readFileSync(file, 'utf8');
    if (keys.isEncrypted(pem) && !process.env.MINER_WALLET_PASSWORD) {
        throw new Error(file + ' is encrypted: set MINER_WALLET_PASSWORD');
    }
    try {
        return keys.readPrivateKey(pem, process.env.MINER_WALLET_PASSWORD);
    } catch(error) {
        throw new Error('MINER_WALLET: ' + error.message);
    }
}

// Addresses allowed to mine blocks, in config/miners.json (config/miners.prod.json in production).
// Without that file anyone can mine.
function loadAuthorizedMiners() {
    const file = path.join(__dirname, '../config', process.env.NODE_ENV == 'production' ? 'miners.prod.json' : 'miners.json');
    if (!fs.existsSync(file)) {
        return [];
    }

    const miners = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(miners) || !miners.every(miner => keys.isAddress(miner))) {
        throw new Error(file + ' must be a list of addresses');
    }
    return miners;
}

// Builds the Express app of a node once its blockchain has been loaded. Its blockchain is in
// app.locals.blockchain.
async function createApp(url, port, {miner = loadMinerKey(), authorizedMiners = loadAuthorizedMiners()} = {}) {
    if (miner && authorizedMiners.length > 0 && !authorizedMiners.includes(keys.addressOf(miner))) {
        throw new Error('The address of MINER_WALLET is not in the list of authorized miners');
    }

    let controller = new blockchainController(url, port, {miner, authorizedMiners});
    await controller.init();

    // Init express
    let app = express();
    app.locals.blockchain = controller.blockchain;
    app.use(helmet());

    // Every endpoint is public and some are expensive (syncing with other nodes, for example).
    const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX, 10);
    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: rateLimitMax > 0 ? rateLimitMax : 100,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: {error: 'Too many requests, please try again later'},
    }));

    app.use(express.json({limit: '10kb'}));

    // API
    app.get('/resolve', controller.resolve.bind(controller));
    app.get('/nodes', controller.getNodes.bind(controller));
    app.post('/transaction', controller.postTransaction.bind(controller));
    app.get('/transactions', controller.getTransactions.bind(controller));
    app.get('/blockchain/last-index', controller.getBlockLastIndex.bind(controller));
    app.get('/blockchain/:idx', controller.getBlockByIndex.bind(controller));
    app.get('/blockchain', controller.getBlockchain.bind(controller));
    app.get('/balance/:address', controller.getBalance.bind(controller));

    app.use(function(req, res) {
        res.status(404).json({error: 'Not found'});
    });

    // Reply to errors (malformed JSON, body too large...) with JSON and no stack traces
    app.use(function(err, req, res, next) {
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
        if (status >= 500)
            console.error(err);
        res.status(status).json({error: status < 500 && err.expose ? err.message : 'Internal server error'});
    });

    return app;
}

// Creates a node, starts listening on url:port and, if it has a miner, starts mining. It uses HTTPS
// if TLS_CERT and TLS_KEY give the files of its certificate and private key. Resolves with the server.
async function startServer(url, port) {
    const { TLS_CERT, TLS_KEY } = process.env;
    if (!TLS_CERT != !TLS_KEY) {
        throw new Error('Set both TLS_CERT and TLS_KEY to use HTTPS');
    }
    const tls = TLS_CERT && {cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY)};

    const app = await createApp(url, port);
    const blockchain = app.locals.blockchain;
    const server = tls ? https.createServer(tls, app) : http.createServer(app);

    await new Promise(function(resolve, reject) {
        server.once('error', reject);
        server.listen(port, url, resolve);
    });

    // Over plain HTTP, others on the network can read and change what is sent
    if (!tls && !Nodes.isLoopback(url)) {
        console.warn('Warning: ' + url + ':' + port + ' can be reached from the network without HTTPS (see TLS_CERT and TLS_KEY)');
    }
    for (const node of blockchain.nodes.insecure()) {
        console.warn('Warning: the node at ' + node + ' is on another machine and is reached without HTTPS');
    }

    if (blockchain.minerKey) {
        console.log('Mining at ' + url + ':' + port + ' for ' + blockchain.minerAddress);
        server.on('close', () => blockchain.stopMining());
        blockchain.startMining().catch(function(error) {
            console.error('Mining stopped at ' + url + ':' + port + ':', error);
        });
    }

    return server;
}

module.exports = { createApp, startServer };
