# Changelog

## 2.0.0 - 2026-09-25

This version fixes the security problems of the first one and makes transactions work like in a cryptocurrency: signed by their sender and backed by balances. Chains created by 1.0.0 are not valid anymore, see [Upgrading from previous versions](https://github.com/amarukensei/nodejs-blockchain#upgrading-from-previous-versions).

### Added

- Signed transactions: addresses are Ed25519 public keys and every transaction must be signed by its sender.
- `wallet.js` creates wallets, optionally encrypted with a password, and signs transactions.
- Balances and mining rewards: every mined block gives 50 coins to the `MINER_ADDRESS` of the node, and nobody can send more coins than they have. `GET /balance/:address` returns the balance of an address.
- Optional HTTPS, with `TLS_CERT` and `TLS_KEY`.
- Rate limiting per client (`RATE_LIMIT_MAX`), security headers and errors answered with JSON, without stack traces.

### Changed

- `POST /transaction` needs `timestamp` and `signature`, `amount` must be a positive integer and the sender must have enough balance. The same transaction is only accepted once.
- `GET /mine` needs `MINER_ADDRESS` (it answers with 503 without it) and also mines when there are no pending transactions.
- Blocks have a `miner`, their hash covers all their fields and the genesis block is the same on every node.
- A node never lets a longer chain replace more than its last 10 blocks.
- Express 5, node-persist 4 and Jest 30. `body-parser`, `node-fetch` and `js-sha256` were replaced by what Express and Node.js already include. Node.js 22 or newer is required.

### Security

- Chains received from other nodes, and the one stored on disk, are fully validated before being used. Before, any node could replace the ledger of the others or break it for good.
- Requests to other nodes time out, have a size limit and don't follow redirects. Request bodies are limited to 10 KB and there can be at most 1000 pending transactions.
- `GET /resolve` no longer hangs when there are no other nodes, and storage or startup errors no longer crash the process.
- Mining a block with many transactions no longer blocks the node.
- The 11 known vulnerabilities of the dependencies (`npm audit`) are fixed.

## 1.0.0

First version.
