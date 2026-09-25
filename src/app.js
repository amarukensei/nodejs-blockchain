const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const blockchainController = require('./controllers/blockchain');

// Builds the Express app of a node once its blockchain has been loaded.
async function createApp(url, port) {
    let controller = new blockchainController(url, port);
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

// Creates a node and starts listening on url:port. Resolves with the HTTP server.
async function startServer(url, port) {
    const app = await createApp(url, port);

    return new Promise(function(resolve, reject) {
        let listener = app.listen(port, url, function(error) {
            if (error)
                reject(error);
            else
                resolve(listener);
        });
    });
}

module.exports = { createApp, startServer };
