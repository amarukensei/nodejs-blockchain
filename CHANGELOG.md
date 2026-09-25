# Changelog

## 3.0.0 - 2026-09-25

This version removes the limitations that 2.0.0 had: mining is a real proof of work that the nodes do on their own, it can be limited to some miners, nodes are not reachable from other machines by default, and pending transactions are kept and shared. Chains created by earlier versions are not valid anymore, and `MINER_ADDRESS` and `GET /mine` are gone, see [Upgrading from previous versions](https://github.com/amarukensei/nodejs-blockchain#upgrading-from-previous-versions).

### Added

- A proof of work whose difficulty adjusts itself so that the network mines a block about every 10 seconds. Blocks have a `difficulty`, in bits.
- Nodes with a miner mine on their own, in the background, as soon as they start and after getting the chains of the other nodes. `MINER_WALLET` is the wallet file of the miner (with `MINER_WALLET_PASSWORD` if it is encrypted), whose private key signs the blocks.
- An optional list of authorized miners, in `config/miners.json` (`config/miners.prod.json` in production). With it, only those addresses can mine.
- `GET /blockchain?from=<index>` returns the blocks from that index on.
- Pending transactions are saved on disk and shared with the other nodes, so that any of them can mine them.
- Ctrl+C lets a node stop mining and finish saving its chain before it ends.

### Changed

- The chain with the most work wins, instead of the longest one, however old the blocks it replaces are. The limit of 10 blocks of 2.0.0 could leave nodes that mined apart on different chains for good.
- Nodes only ask each other for their last 10 blocks, and for the whole chain when their chains fork before them.
- The transactions of the blocks that another chain replaces are pending again.
- Nodes listen on `127.0.0.1` by default instead of `0.0.0.0`, and `config/nodes.json` lists `127.0.0.1`. They warn when other machines can reach them without HTTPS, and when they talk over plain HTTP with nodes on other machines.
- Blocks are signed by their miner, and the genesis block changed.

### Removed

- `GET /mine`: anyone could make a node mine, and nodes with a miner now do it on their own.
- `MINER_ADDRESS`, replaced by `MINER_WALLET`.

### Fixed

- Saving the chain could skip a write, which lost the last blocks if the node stopped before the next one.
- A node left out of its node list the nodes whose address contained its own, such as the ones at ports 4000 to 4002 when it listened on port 400.

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
