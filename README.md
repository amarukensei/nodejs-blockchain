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

There is already a default list of nodes set in `config/nodes.json`, but you may change it as you wish.

```
[
    "http://0.0.0.0:4000",
    "http://0.0.0.0:4001",
    "http://0.0.0.0:4002"
]
```

### Wallets

Coins belong to addresses, and only the owner of an address can send its coins. To have one you need a wallet: a key pair whose public key is your address. Use `wallet.js` to create one:

```sh
$ node wallet create --file alice.pem
Password to encrypt the wallet (empty for none):
Repeat the password:
366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62
```

It saves the private key in `alice.pem`, readable only by your user, and prints the address of the wallet. `node wallet address --file alice.pem` prints the address again. Without `--file` the file is `wallet.pem`, and an existing file is never overwritten.

Anyone who gets that file can send the coins of your address, so keep it private (`*.pem` files are ignored by git) and give it a password: the private key is then saved encrypted, and the password is asked every time the wallet is used. Don't lose the file or forget its password, because they can't be recovered.

Addresses are Ed25519 public keys written in hexadecimal (64 characters). To receive coins you only need to give yours.

### Running one instance

Use this for starting one single instance (a node). `MINER_ADDRESS` is the address that gets the rewards for the blocks this node mines, so use one of your wallets:

```sh
$ MINER_ADDRESS=366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62 node app
```

It listens on `0.0.0.0:4000` by default. These environment variables change its behaviour:

- `MINER_ADDRESS`: address that gets the rewards for mining. Without it the node doesn't mine.
- `URL` and `PORT`: address and port to listen on.
- `NODE_ENV=production`: read the node list from `config/nodes.prod.json` instead of `config/nodes.json`.
- `RATE_LIMIT_MAX`: requests each client may send per minute (100 by default).
- `TLS_CERT` and `TLS_KEY`: files with the certificate and the private key to use HTTPS (see [HTTPS](#https)).


###  Running multiple nodes

Use this if you want to have multiple instances in the same machine. Nodes defined in the config file above will be accessed and keep updated.

This is a convinient way for playing around with distributed ledger quickly.

```sh
$ MINER_ADDRESS=366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62 node multiple
```

### HTTPS

Nodes use plain HTTP unless `TLS_CERT` and `TLS_KEY` are set. With them they use HTTPS, so the URLs in the node list must start with `https://`, and the other nodes and clients must trust the certificate: either one from a certificate authority or your own. For example, this tries it on one machine with a self-signed certificate, with `https://localhost:4000`, `https://localhost:4001` and `https://localhost:4002` in `config/nodes.json`:

```sh
$ openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 365 \
  -keyout tls-key.pem -out tls-cert.pem \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
$ TLS_CERT=tls-cert.pem TLS_KEY=tls-key.pem NODE_EXTRA_CA_CERTS=tls-cert.pem \
  MINER_ADDRESS=366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62 node multiple
$ curl --cacert tls-cert.pem https://localhost:4000/nodes
```

`NODE_EXTRA_CA_CERTS` makes the nodes trust the certificate when they talk to each other.

## API

POST requests need to have `Content-Type` as `application/json`

### GET /nodes

Returns a list of registered nodes.

```sh
$ curl http://0.0.0.0:4000/nodes
```

Response:

```
[
    "http://0.0.0.0:4000",
    "http://0.0.0.0:4001",
    "http://0.0.0.0:4002"
]
```

### POST /transaction

Add a transaction to the blockchain transaction queue. This needs to be mined afterwards so as to be added to the blockchain.

The body of the request should contain a json string with these keys: `from`, `to`, `amount`, `timestamp` and `signature`. The wallet of the sender creates it, given the address of the recipient and the amount:

```sh
$ node wallet sign --file alice.pem ffbc8837cfbfd6fc79c4ff9b6b2e99810e3453fecb0f707872b89ff3db988517 10
{"from":"366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62","to":"ffbc8837cfbfd6fc79c4ff9b6b2e99810e3453fecb0f707872b89ff3db988517","amount":10,"timestamp":1790310263,"signature":"0d768d4d05de2e322db7f97a0bde6bfc3e0348e761c050d1bdfd96ee5756f47eb71b344ba1a069590699cb07fa4108be9545184dcc2369f895011c8e3ccbfc04"}
```

So a transaction can be sent like this:

```sh
$ curl --header "Content-Type: application/json" \
  --request POST \
  --data "$(node wallet sign --file alice.pem ffbc8837cfbfd6fc79c4ff9b6b2e99810e3453fecb0f707872b89ff3db988517 10)" \
  http://0.0.0.0:4000/transaction
```

A transaction is only accepted if:

- `from` and `to` are addresses (see [Wallets](#wallets)) and `amount` is a positive integer.
- `timestamp` is the time it was signed, in seconds since 1970 (Unix time).
- `signature` is the Ed25519 signature made with the private key of `from`, in hexadecimal. What gets signed is the JSON text `{"from":"...","to":"...","amount":...,"timestamp":...}`: those keys in that order and without spaces. You only need this to sign transactions without `wallet.js`.
- The sender has enough coins: its [balance](#get-balanceaddress) minus what its pending transactions already send.
- It was not received before. The same transaction (same `from`, `to`, `amount` and `timestamp`) is accepted only once, so nobody can send it again to repeat the payment. Signing it again, a second later or more, gives a new transaction.

Invalid transactions are rejected with status 406, and once 1000 transactions are waiting to be mined new ones are rejected with status 503.

I all went fine you should be getting a response like:

```
{
    "success": 1
}
```

### GET /transactions

Returns all pending transactions waiting to be mined.

```sh
$ curl http://0.0.0.0:4000/transactions
```

Response:

```
[
    {
        "from": "366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62",
        "to": "ffbc8837cfbfd6fc79c4ff9b6b2e99810e3453fecb0f707872b89ff3db988517",
        "amount": 10,
        "timestamp": 1790310263,
        "signature": "0d768d4d05de2e322db7f97a0bde6bfc3e0348e761c050d1bdfd96ee5756f47eb71b344ba1a069590699cb07fa4108be9545184dcc2369f895011c8e3ccbfc04"
    }
]
```

### GET /mine

This will mine (process) all the pending transactions and add the result into a block and then to the blockchain itself. The block also gives a reward of 50 coins to its miner, the `MINER_ADDRESS` of the node: that is how coins are created, so a block can be mined even without pending transactions. A node without `MINER_ADDRESS` doesn't mine, and answers with status 503.

In this version, once the mining process is done, the blockchain data will be broadcasted instanly to other registered nodes (if any).

This is a decentralized and distributed ledger, so data should remain the same everywhere.

```sh
$ curl http://0.0.0.0:4000/mine
```

Returns the mined block with all its data and related transactions.

```
{
    "index": 2,
    "previousHash": "000e91e4e6ec0b5a6d4bc8b8fe4997a8711b8fb9f30ac33c43d142c4e77c011b",
    "hash": "00095fc5d4a7af5b0fe8f9a12d2a78d5baf8a03da9cc6c4a38988006000cc0b3",
    "timestamp": 1790310263,
    "nonce": 629,
    "miner": "366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62",
    "transactions": [
        {
            "from": "366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62",
            "to": "ffbc8837cfbfd6fc79c4ff9b6b2e99810e3453fecb0f707872b89ff3db988517",
            "amount": 10,
            "timestamp": 1790310263,
            "signature": "0d768d4d05de2e322db7f97a0bde6bfc3e0348e761c050d1bdfd96ee5756f47eb71b344ba1a069590699cb07fa4108be9545184dcc2369f895011c8e3ccbfc04"
        }
    ]
}
```

### GET /blockchain

Returns the whole data of the blockchain. (Note that for a small blockchain this is doable, but not for a big one.)


```sh
$ curl http://0.0.0.0:4000/blockchain
```

Response:

```
[
    {
        "index": 0,
        "previousHash": "0000000000000000",
        "hash": "00021b0673ecfef60a2e414ec216fcd57d4abb7314b30e35c7e13b205b84743e",
        "timestamp": 1790294400,
        "nonce": 10,
        "miner": null,
        "transactions": []
    },
    {
        "index": 1,
        "previousHash": "00021b0673ecfef60a2e414ec216fcd57d4abb7314b30e35c7e13b205b84743e",
        "hash": "000e91e4e6ec0b5a6d4bc8b8fe4997a8711b8fb9f30ac33c43d142c4e77c011b",
        "timestamp": 1790310262,
        "nonce": 8004,
        "miner": "366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62",
        "transactions": []
    },
    {
        "index": 2,
        "previousHash": "000e91e4e6ec0b5a6d4bc8b8fe4997a8711b8fb9f30ac33c43d142c4e77c011b",
        "hash": "00095fc5d4a7af5b0fe8f9a12d2a78d5baf8a03da9cc6c4a38988006000cc0b3",
        "timestamp": 1790310263,
        "nonce": 629,
        "miner": "366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62",
        "transactions": [
            {
                "from": "366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62",
                "to": "ffbc8837cfbfd6fc79c4ff9b6b2e99810e3453fecb0f707872b89ff3db988517",
                "amount": 10,
                "timestamp": 1790310263,
                "signature": "0d768d4d05de2e322db7f97a0bde6bfc3e0348e761c050d1bdfd96ee5756f47eb71b344ba1a069590699cb07fa4108be9545184dcc2369f895011c8e3ccbfc04"
            }
        ]
    }
]
```

Note the genesis block. That is the very first block created which gets added by default when the blockchains is initialized. It is the same on every node.


### GET /blockchain/2

Returns a block specified by index id.

```sh
$ curl http://0.0.0.0:4000/blockchain/2
```

Response:

```
{
    "index": 2,
    "previousHash": "000e91e4e6ec0b5a6d4bc8b8fe4997a8711b8fb9f30ac33c43d142c4e77c011b",
    "hash": "00095fc5d4a7af5b0fe8f9a12d2a78d5baf8a03da9cc6c4a38988006000cc0b3",
    "timestamp": 1790310263,
    "nonce": 629,
    "miner": "366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62",
    "transactions": [
        {
            "from": "366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62",
            "to": "ffbc8837cfbfd6fc79c4ff9b6b2e99810e3453fecb0f707872b89ff3db988517",
            "amount": 10,
            "timestamp": 1790310263,
            "signature": "0d768d4d05de2e322db7f97a0bde6bfc3e0348e761c050d1bdfd96ee5756f47eb71b344ba1a069590699cb07fa4108be9545184dcc2369f895011c8e3ccbfc04"
        }
    ]
}
```

### GET /blockchain/last-index

Returns the index of the last inseted block in the blockchain.

```sh
$ curl http://0.0.0.0:4000/blockchain/last-index
```

Response:

```
2
```

### GET /balance/:address

Returns the balance of an address: the coins it got as rewards or in transactions, minus the ones it sent. Only mined transactions count.

```sh
$ curl http://0.0.0.0:4000/balance/366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62
```

Response:

```
{
    "address": "366232ea8fde310f1afd9dc0da77993a8ff34c4c52ab0af82c717994657f3a62",
    "balance": 90
}
```

### GET /resolve

Asks the other nodes for their blockchain and keeps the longest valid one (see [Security](#security)). Nodes call it on each other after mining a block.

```sh
$ curl http://0.0.0.0:4000/resolve
```

Response:

```
[
    {
        "noaction": "http://0.0.0.0:4001"
    },
    {
        "synced": "http://0.0.0.0:4002"
    }
]
```

`synced` means that the chain of that node replaced ours, `noaction` that ours was as long or longer, and `error` that the node could not be reached or its chain was not valid.

## Security

- Transactions are signed with the private key of the sender, so only the owner of an address can send its coins, and nobody can change a transaction once it is signed. Nobody can send more coins than they have, and each transaction is accepted only once, so a signed transaction can't be sent again to repeat a payment.
- A chain received from another node only replaces the local one if it is longer and valid: every block must be well formed, linked to the previous one and have a correct hash that meets the proof of work difficulty (the hash covers every field of the block), and every transaction must follow the rules above, signature and balance included, and appear only once. The chain stored on disk is checked the same way on start up, and the node refuses to start if it is not valid.
- A longer chain can only replace the last 10 blocks of a node. Once a transaction has 10 blocks after it, nobody can undo it on that node by building a longer chain, however fast they mine.
- Requests to other nodes time out after 10 seconds, don't follow redirects and are aborted if the response grows beyond 50 MB. Nodes can talk to each other over [HTTPS](#https).
- Request bodies are limited to 10 KB, each client is rate limited (see `RATE_LIMIT_MAX`) and responses include the usual security headers (set with [Helmet](https://helmet.js.org/)). Errors are answered with JSON, without stack traces.
- Wallets can be encrypted with a password.

Keep in mind that this is a proof of concept, not something to run in production:

- The proof of work difficulty is very low, so anyone can quickly build a longer valid chain. Nodes only let it replace their last 10 blocks, so wait for 10 more blocks before trusting a payment. And nodes that don't have those blocks yet, like new ones, take the longest valid chain they get.
- Anyone who can reach a node can make it mine blocks, and every block creates 50 coins for the miner of the node.
- HTTPS is off unless you set it up.
- Pending transactions are only kept in memory: they are lost if the node stops, and only the node that received them mines them.

## Upgrading from previous versions

Version 2.0 changed how blocks and transactions are made (transactions are signed, blocks reward their miner and their hash covers every field), so chains created by earlier versions are not valid anymore: a node that has one refuses to start, and the error says which folder of `storage/` holds it. Move that folder away (or delete it) and the node starts a new chain. The API changed as well; the [changelog](CHANGELOG.md) has the details.

## Author

Bernardino Todolí López - [Taula Consulting](http://www.taula-consulting.com/en/)

## License

This project is licensed under the MIT License.
