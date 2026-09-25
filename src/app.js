const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const blockchainController = require('./controllers/blockchain');
const Transaction = require('./models/transaction');

// Builds the Express app of a node once its blockchain has been loaded.
async function createApp(url, port) {
    // Where the rewards for mining go. Without it the node doesn't mine
    const minerAddress = process.env.MINER_ADDRESS || null;
    if (minerAddress && !Transaction.isAddress(minerAddress)) {
        throw new Error('MINER_ADDRESS must be an address (a public key of 64 hexadecimal characters)');
    }

    let controller = new blockchainController(url, port, minerAddress);
    await controller.init();

    // Init express
    let app = express();
    app.use(helmet());

    // Every endpoint is public and some are expensive (mining, syncing with other nodes).
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
    app.get('/mine', controller.mine.bind(controller));
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

// Creates a node and starts listening on url:port, with HTTPS if TLS_CERT and TLS_KEY give
// the files of its certificate and private key. Resolves with the server.
async function startServer(url, port) {
    const { TLS_CERT, TLS_KEY } = process.env;
    if (!TLS_CERT != !TLS_KEY) {
        throw new Error('Set both TLS_CERT and TLS_KEY to use HTTPS');
    }
    const tls = TLS_CERT && {cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY)};

    const app = await createApp(url, port);
    const server = tls ? https.createServer(tls, app) : http.createServer(app);

    return new Promise(function(resolve, reject) {
        server.once('error', reject);
        server.listen(port, url, function() {
            resolve(server);
        });
    });
}

module.exports = { createApp, startServer };
