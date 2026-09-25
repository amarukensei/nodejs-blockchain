# Simple Blockchain in Node.js

This is a very simple blockchain implementation in Node.js.

It is just a proof of concept so as to understand how a blockchain may be created, including decentralized and distributed ledger concept.


## Getting Started

### Prerequisites

You need node.js and npm package manager to be installed. Node.js 22 or newer is required; use a version that still receives security updates.

### Installation

Go into the code root and install all the packages.

```sh
$ npm install
```

### Node list

Not mandatory, but it is recommended to have a list of nodes for having the distributed ledger mode.

There is already a default list of nodes set in `config/nodes.json`, three nodes on this machine, but you may change it as you wish. With `NODE_ENV=production` the list is read from `config/nodes.prod.json` instead.

```
[
    "http://127.0.0.1:4000",
    "http://127.0.0.1:4001",
    "http://127.0.0.1:4002"
]
```

Each node leaves itself out of the list: the entry with the address and port it listens on.

### Wallets

Coins belong to addresses, and only the owner of an address can send its coins. To have one you need a wallet: a key pair whose public key is your address. Use `wallet.js` to create one:

```sh
$ node wallet create --file alice.pem
Password to encrypt the wallet (empty for none):
Repeat the password:
51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b
```

It saves the private key in `alice.pem`, readable only by your user, and prints the address of the wallet. `node wallet address --file alice.pem` prints the address again. Without `--file` the file is `wallet.pem`, and an existing file is never overwritten.

Anyone who gets that file can send the coins of your address, so keep it private (`*.pem` files are ignored by git) and give it a password: the private key is then saved encrypted, and the password is asked every time the wallet is used. Don't lose the file or forget its password, because they can't be recovered.

Addresses are Ed25519 public keys written in hexadecimal (64 characters). To receive coins you only need to give yours.

### Running one instance

Use this for starting one single instance (a node). `MINER_WALLET` is the wallet file of its miner: the node signs the blocks it mines with that private key, and their rewards go to its address.

```sh
$ MINER_WALLET=alice.pem node app
Mining at 127.0.0.1:4000 for 51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b
Server started at 127.0.0.1:4000
```

The node mines in the background, one block after another, as soon as it starts: first it gets the chains of the other nodes, so as not to mine on top of an old one (see [Mining](#mining)). It logs the nodes of the list that it can't reach, like the ones that are not running. If the wallet has a password, set it in `MINER_WALLET_PASSWORD` as well, since the node can't ask for it. Without `MINER_WALLET` the node doesn't mine, but it keeps the chain, takes transactions and answers requests all the same.

Press Ctrl+C to stop the node: it stops mining and ends once it has saved its chain. Press it again to end it at once.

It listens on `127.0.0.1:4000` by default, so only this machine can reach it. These environment variables change its behaviour:

- `MINER_WALLET`: wallet file of the miner (see [Wallets](#wallets)). Without it the node doesn't mine.
- `MINER_WALLET_PASSWORD`: password of `MINER_WALLET`, if it has one.
- `URL` and `PORT`: address and port to listen on. Use `URL=0.0.0.0` to let other machines reach the node, preferably over [HTTPS](#https).
- `NODE_ENV=production`: read the node list and the [authorized miners](#authorized-miners) from `config/nodes.prod.json` and `config/miners.prod.json` instead of `config/nodes.json` and `config/miners.json`.
- `RATE_LIMIT_MAX`: requests each client may send per minute (100 by default).
- `TLS_CERT` and `TLS_KEY`: files with the certificate and the private key to use HTTPS (see [HTTPS](#https)).

The node saves its chain and its pending transactions in `storage/`, in a folder for its address and port.


###  Running multiple nodes

Use this if you want to have multiple instances in the same machine. It starts a node for each entry of the node list above, and they keep each other updated.

This is a convenient way for playing around with distributed ledger quickly.

```sh
$ MINER_WALLET=alice.pem node multiple
```

As they run in one process, the three nodes mine for the same wallet and share one CPU core. To have nodes with different miners, start each one on its own, for example in three terminals:

```sh
$ PORT=4000 MINER_WALLET=alice.pem node app
$ PORT=4001 MINER_WALLET=bob.pem node app
$ PORT=4002 node app
```

### Mining

A block is only valid if its hash (SHA-256, in hexadecimal) starts with as many zero bits as its `difficulty`. The hash depends on every field of the block but its signature, and the miner changes the `nonce` until the hash meets the difficulty: that takes 2^difficulty attempts on average, and it is the proof of work.

The difficulty adjusts itself so that the network mines a block about every 10 seconds, however many miners there are. It goes up one bit when the last 4 blocks came faster than 5 seconds on average, and down one bit, never below 12, when they took longer than 20 seconds. So it starts at 12 bits, climbs quickly during the first blocks and then follows the computing power of the miners: one node mining alone on a laptop settles around 23 or 24 bits.

Each block gives a reward of 50 coins to its `miner`, which signs it: that is how coins are created, so nodes mine blocks even without pending transactions. The node that mines a block puts in it all the pending transactions that are still valid.

When a node mines a block, it asks the other nodes to [resolve](#get-resolve), so that they get it. If they have different chains, the one with the most work wins: the one whose blocks after the point where both chains fork took more attempts to mine (the sum of 2^difficulty of those blocks), which is not always the longest one. That is how nodes end up with the same chain, even after mining apart for a while. The transactions of the blocks that the winning chain replaces go back to the pending transactions, unless it has them too, so they are mined again.

### Authorized miners

Anyone can run a node and mine unless there is a list of authorized miners. To let only some addresses mine, list them in `config/miners.json` (`config/miners.prod.json` with `NODE_ENV=production`):

```
[
    "51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b",
    "cbb43e99904e318d708df755c5447f0cb9e7a6e5fae43bc173f1ed366d69db8e"
]
```

With that file, a node rejects the blocks that someone else mined, since every block is signed by its miner, and it refuses to start if its `MINER_WALLET` is not in the list.

The list is part of the rules of the network, so every node needs the same one. Add addresses to it, but don't remove them: that makes the blocks they already mined invalid, and the nodes that have them refuse to start (see [Upgrading from previous versions](#upgrading-from-previous-versions) for what to do then).

### HTTPS

Nodes use plain HTTP unless `TLS_CERT` and `TLS_KEY` are set. With them they use HTTPS, so the URLs in the node list must start with `https://`, and the other nodes and clients must trust the certificate: either one from a certificate authority or your own. For example, this tries it on one machine with a self-signed certificate, with `https://localhost:4000`, `https://localhost:4001` and `https://localhost:4002` in `config/nodes.json`:

```sh
$ openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 \
  -keyout tls-key.pem -out tls-cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
$ TLS_CERT=tls-cert.pem TLS_KEY=tls-key.pem NODE_EXTRA_CA_CERTS=tls-cert.pem \
  MINER_WALLET=alice.pem node multiple
$ curl --cacert tls-cert.pem https://localhost:4000/nodes
```

`NODE_EXTRA_CA_CERTS` makes the nodes trust the certificate when they talk to each other.

## API

POST requests need to have `Content-Type` as `application/json`

### GET /nodes

Returns the list of the other nodes.

```sh
$ curl http://127.0.0.1:4000/nodes
```

Response:

```
[
    "http://127.0.0.1:4001",
    "http://127.0.0.1:4002"
]
```

### POST /transaction

Adds a transaction to the pending transactions, which wait to be mined into a block, and shares it with the other nodes, so that any of them can mine it. Pending transactions are saved on disk, so they are not lost when the node stops.

The body of the request should contain a json string with these keys: `from`, `to`, `amount`, `timestamp` and `signature`. The wallet of the sender creates it, given the address of the recipient and the amount:

```sh
$ node wallet sign --file alice.pem cbb43e99904e318d708df755c5447f0cb9e7a6e5fae43bc173f1ed366d69db8e 10
{"from":"51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b","to":"cbb43e99904e318d708df755c5447f0cb9e7a6e5fae43bc173f1ed366d69db8e","amount":10,"timestamp":1790316873,"signature":"0686a0aa759fd3a722df879da8807e36a8670e6fb672d1a836e0e48e0c0a94fe8c398cffa17138c1fd540de698bd99fadc70b8647354f6b9ae2f82fd9789e107"}
```

So a transaction can be sent like this:

```sh
$ curl --header "Content-Type: application/json" \
  --request POST \
  --data "$(node wallet sign --file alice.pem cbb43e99904e318d708df755c5447f0cb9e7a6e5fae43bc173f1ed366d69db8e 10)" \
  http://127.0.0.1:4000/transaction
```

A transaction is only accepted if:

- `from` and `to` are addresses (see [Wallets](#wallets)) and `amount` is a positive integer.
- `timestamp` is the time it was signed, in seconds since 1970 (Unix time).
- `signature` is the Ed25519 signature made with the private key of `from`, in hexadecimal. What gets signed is the JSON text `{"from":"...","to":"...","amount":...,"timestamp":...}`: those keys in that order and without spaces. You only need this to sign transactions without `wallet.js`.
- The sender has enough coins: its [balance](#get-balanceaddress) minus what its pending transactions already send.
- It was not received before. The same transaction (same `from`, `to`, `amount` and `timestamp`) is accepted only once, so nobody can send it again to repeat the payment. Signing it again, a second later or more, gives a new transaction.

Invalid transactions are rejected with status 406, and once 1000 transactions are waiting to be mined new ones are rejected with status 503. The other nodes also reject the transactions they already have, so each one gets them once.

If all went fine you should be getting a response like:

```
{
    "success": 1
}
```

### GET /transactions

Returns all pending transactions waiting to be mined.

```sh
$ curl http://127.0.0.1:4000/transactions
```

Response:

```
[
    {
        "from": "51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b",
        "to": "cbb43e99904e318d708df755c5447f0cb9e7a6e5fae43bc173f1ed366d69db8e",
        "amount": 10,
        "timestamp": 1790316873,
        "signature": "0686a0aa759fd3a722df879da8807e36a8670e6fb672d1a836e0e48e0c0a94fe8c398cffa17138c1fd540de698bd99fadc70b8647354f6b9ae2f82fd9789e107"
    }
]
```

### GET /blockchain

Returns the whole data of the blockchain. (Note that for a small blockchain this is doable, but not for a big one.)


```sh
$ curl http://127.0.0.1:4000/blockchain
```

Response, where only the first two blocks are shown:

```
[
    {
        "index": 0,
        "previousHash": "0000000000000000",
        "hash": "000df523e6d840db7ba3645a8fac03019068ba80271be87534a76829d354c5bc",
        "timestamp": 1790294400,
        "nonce": 1287,
        "difficulty": 12,
        "miner": null,
        "signature": null,
        "transactions": []
    },
    {
        "index": 1,
        "previousHash": "000df523e6d840db7ba3645a8fac03019068ba80271be87534a76829d354c5bc",
        "hash": "000fda5150d1b8d0c3d2a30955156cdae99eba8437028cad66e67fffea739dfc",
        "timestamp": 1790316870,
        "nonce": 25467,
        "difficulty": 12,
        "miner": "51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b",
        "signature": "3444314a1c738422043de612a44b1095c47c5a79d97fbea0399240a42e9f2d3571ff4c1983ff29dc20bfc26b3abfdb4c994b50dbd5696e210317630ec5eaa804",
        "transactions": []
    },
    ...
]
```

Note the genesis block. That is the very first block created which gets added by default when the blockchain is initialized. It is the same on every node, and it is the only block without a miner. The fields of the rest are explained in [Mining](#mining).

With `from`, it only returns the blocks from that index on, which is what nodes ask each other for when they [resolve](#get-resolve):

```sh
$ curl http://127.0.0.1:4000/blockchain?from=14
```

It answers with status 400 if `from` is not the index of a block.

### GET /blockchain/14

Returns a block specified by index id.

```sh
$ curl http://127.0.0.1:4000/blockchain/14
```

Response:

```
{
    "index": 14,
    "previousHash": "0000014c9cf6794b6f29cacab60be1c2ebe87790b090b54c9f2b8d3ddd03705d",
    "hash": "000000b352691355d6e33ef40ac061ba314d817423e6374ac87468fb0b8d6317",
    "timestamp": 1790316879,
    "nonce": 1905352,
    "difficulty": 24,
    "miner": "51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b",
    "signature": "188a08f03b26f7cf231cd0b3f23509566cc1378c2cc55e933d4acfa45e3dcf1e00bfbe6956b67834bdb5eb2604484f1b1840cf847df2b60c39d40e2c8f005908",
    "transactions": [
        {
            "from": "51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b",
            "to": "cbb43e99904e318d708df755c5447f0cb9e7a6e5fae43bc173f1ed366d69db8e",
            "amount": 10,
            "timestamp": 1790316873,
            "signature": "0686a0aa759fd3a722df879da8807e36a8670e6fb672d1a836e0e48e0c0a94fe8c398cffa17138c1fd540de698bd99fadc70b8647354f6b9ae2f82fd9789e107"
        }
    ]
}
```

### GET /blockchain/last-index

Returns the index of the last inserted block in the blockchain.

```sh
$ curl http://127.0.0.1:4000/blockchain/last-index
```

Response:

```
14
```

### GET /balance/:address

Returns the balance of an address: the coins it got as rewards or in transactions, minus the ones it sent. Only mined transactions count.

```sh
$ curl http://127.0.0.1:4000/balance/51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b
```

Response, after mining 14 blocks and sending 10 coins:

```
{
    "address": "51c82be2593e7f93a9d7382e26eabbb7c85de3aa635348b6a39666300131512b",
    "balance": 690
}
```

### GET /resolve

Asks the other nodes for their chains and keeps the one with the most work, if it has more than ours and is valid (see [Mining](#mining) and [Security](#security)). It only asks for their last 10 blocks, unless their chain forks from ours before them. Nodes call it on each other after mining a block.

```sh
$ curl http://127.0.0.1:4002/resolve
```

Response:

```
[
    {
        "synced": "http://127.0.0.1:4000"
    },
    {
        "noaction": "http://127.0.0.1:4001"
    }
]
```

`synced` means that the chain of that node replaced ours, `noaction` that ours had as much work or more, and `error` that the node could not be reached or its chain was not valid.

## Security

- Transactions are signed with the private key of the sender, so only the owner of an address can send its coins, and nobody can change a transaction once it is signed. Nobody can send more coins than they have, and each transaction is accepted only once, so a signed transaction can't be sent again to repeat a payment.
- Blocks are signed by their miners, and with a list of [authorized miners](#authorized-miners) only those addresses can mine.
- A chain received from another node only replaces the local one if it has more work and is valid: every block must be well formed, linked to the previous one, dated no earlier than it and at most 2 minutes after the clock of the node, have the difficulty that the dates of the blocks before require and a correct hash that meets it, and be signed by its miner; and every transaction must follow the rules above, signature and balance included, and appear only once. The chain stored on disk is checked the same way on start up, and the node refuses to start if it is not valid.
- Nodes listen on `127.0.0.1` by default, so only the machine they run on can reach them. A node warns when it starts if other machines can reach it without HTTPS, or if it talks over plain HTTP with nodes on other machines.
- Requests to other nodes time out after 10 seconds, don't follow redirects and are aborted if the response grows beyond 50 MB. Nodes can talk to each other over [HTTPS](#https).
- Request bodies are limited to 10 KB, each client is rate limited (see `RATE_LIMIT_MAX`) and responses include the usual security headers (set with [Helmet](https://helmet.js.org/)). Errors are answered with JSON, without stack traces.
- Wallets can be encrypted with a password.

Keep in mind that this is a proof of concept, not something to run in production:

- Proof of work only protects the chain as long as nobody has more computing power than all the other miners together. Whoever has more can mine a chain with more work and replace the last blocks of the others, undoing the payments in them (replacing older blocks takes more work the older they are). With a few computers mining, that is within the reach of anyone with a few more. So wait for some blocks after a payment before trusting it, and use a list of [authorized miners](#authorized-miners) on networks where not everyone who can mine is trusted.
- Mining keeps a CPU core busy all the time (the nodes of `multiple.js` share one).
- Nodes keep the whole chain in memory, save it to one file after every block and send it to new nodes in one response, which can't be larger than 50 MB: around 100,000 blocks, or 12 days of mining. So it only works with small chains.
- HTTPS is off unless you set it up.
- The rate limit counts requests per IP address, so the nodes of `multiple.js` and the clients on the same machine share it.

## Upgrading from previous versions

Version 3.0 changed the blocks again: they have a `difficulty` and the `signature` of their miner, and the genesis block is a different one. So chains created by earlier versions are not valid anymore: a node that has one refuses to start, and the error says which folder of `storage/` holds it. Move that folder away (or delete it) and the node starts a new chain, or takes the one of the other nodes. Version 2.0 did the same with the chains of version 1.

It also changed how nodes are run:

- `MINER_WALLET`, the wallet file of the miner, replaced `MINER_ADDRESS`, since the node needs the private key to sign its blocks. A node refuses to start if `MINER_ADDRESS` is set.
- `GET /mine` is gone: nodes with a miner mine on their own.
- Nodes listen on `127.0.0.1` by default instead of `0.0.0.0`, and the addresses in `config/nodes.json` changed accordingly. Set `URL=0.0.0.0` to let other machines reach a node.

The [changelog](CHANGELOG.md) has the details.

## Author

Bernardino Todolí López - [btodoli.net](https://btodoli.net)

## License

This project is licensed under the MIT License.
