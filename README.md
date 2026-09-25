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

### Running one instance

Use this for starting one single instance (a node).

```sh
$ node app
```

It listens on `0.0.0.0:4000` by default. These environment variables change its behaviour:

- `URL` and `PORT`: address and port to listen on.
- `NODE_ENV=production`: read the node list from `config/nodes.prod.json` instead of `config/nodes.json`.
- `RATE_LIMIT_MAX`: requests each client may send per minute (100 by default).


###  Running multiple nodes

Use this if you want to have multiple instances in the same machine. Nodes defined in the config file above will be accessed and keep updated.

This is a convinient way for playing around with distributed ledger quickly.

```sh
$ node multiple
```

### Wallets

Transactions are signed, so to send them you need a wallet: a key pair whose public key is your address. Use `wallet.js` to create one:

```sh
$ node wallet create --file alice.pem
317bb5d96def9cf22892b2f8a11b8b42257a35d2f3cb0bebd3c1058dc46662de
```

It saves the private key in `alice.pem`, readable only by your user, and prints the address of the wallet. `node wallet address --file alice.pem` prints the address again. Without `--file` the file is `wallet.pem`, and an existing file is never overwritten.

Anyone who gets that file can send transactions from your address, so keep it private (`*.pem` files are ignored by git). Don't lose it either, because it can't be recovered.

Addresses are Ed25519 public keys written in hexadecimal (64 characters). To receive transactions you only need to give yours.

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
$ node wallet sign --file alice.pem cfd550910f04f1f3613c0b35cf61e3489facc0e617a2325cc5cddb5766a8e545 1
{"from":"317bb5d96def9cf22892b2f8a11b8b42257a35d2f3cb0bebd3c1058dc46662de","to":"cfd550910f04f1f3613c0b35cf61e3489facc0e617a2325cc5cddb5766a8e545","amount":1,"timestamp":1790308118,"signature":"fd14c1d054abe44fc248253c73072a36442335dd59320b6b002b5e539419d75f9d2df9e7e3097c61da9a1fba0f6aa496756e1868b143abab73202ec451d45a05"}
```

So a transaction can be sent like this:

```sh
$ curl --header "Content-Type: application/json" \
  --request POST \
  --data "$(node wallet sign --file alice.pem cfd550910f04f1f3613c0b35cf61e3489facc0e617a2325cc5cddb5766a8e545 1)" \
  http://0.0.0.0:4000/transaction
```

A transaction is only accepted if:

- `from` and `to` are addresses (see [Wallets](#wallets)) and `amount` is a positive number.
- `timestamp` is the time it was signed, in seconds since 1970 (Unix time).
- `signature` is the Ed25519 signature made with the private key of `from`, in hexadecimal. What gets signed is the JSON text `{"from":"...","to":"...","amount":...,"timestamp":...}`: those keys in that order, without spaces, and the numbers written as JavaScript's `JSON.stringify` writes them. You only need this to sign transactions without `wallet.js`.
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
        "from": "317bb5d96def9cf22892b2f8a11b8b42257a35d2f3cb0bebd3c1058dc46662de",
        "to": "cfd550910f04f1f3613c0b35cf61e3489facc0e617a2325cc5cddb5766a8e545",
        "amount": 1,
        "timestamp": 1790308118,
        "signature": "fd14c1d054abe44fc248253c73072a36442335dd59320b6b002b5e539419d75f9d2df9e7e3097c61da9a1fba0f6aa496756e1868b143abab73202ec451d45a05"
    }
]
```

### GET /mine

This will mine (process) all the pending transactions and add the result into a block and then to the blockchain itself.

In this version, once the mining process is done, the blockchain data will be broadcasted instanly to other registered nodes (if any).

This is a decentralized and distributed ledger, so data should remain the same everywhere.

```sh
$ curl http://0.0.0.0:4000/mine
```

Returns the mined block with all its data and related transactions.

```
{
    "index": 1,
    "previousHash": "00002818703517bab21046d807a3fc0284b8a05979ce48baa40ed2eeeadd3b92",
    "hash": "0001cca94dbf7a3d58f4c71ab8d764256bdd06e764231dae51d95233c7ce2913",
    "timestamp": 1790308118,
    "nonce": 4835,
    "transactions": [
        {
            "from": "317bb5d96def9cf22892b2f8a11b8b42257a35d2f3cb0bebd3c1058dc46662de",
            "to": "cfd550910f04f1f3613c0b35cf61e3489facc0e617a2325cc5cddb5766a8e545",
            "amount": 1,
            "timestamp": 1790308118,
            "signature": "fd14c1d054abe44fc248253c73072a36442335dd59320b6b002b5e539419d75f9d2df9e7e3097c61da9a1fba0f6aa496756e1868b143abab73202ec451d45a05"
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
        "hash": "00002818703517bab21046d807a3fc0284b8a05979ce48baa40ed2eeeadd3b92",
        "timestamp": 1790308116,
        "nonce": 4190,
        "transactions": []
    },
    {
        "index": 1,
        "previousHash": "00002818703517bab21046d807a3fc0284b8a05979ce48baa40ed2eeeadd3b92",
        "hash": "0001cca94dbf7a3d58f4c71ab8d764256bdd06e764231dae51d95233c7ce2913",
        "timestamp": 1790308118,
        "nonce": 4835,
        "transactions": [
            {
                "from": "317bb5d96def9cf22892b2f8a11b8b42257a35d2f3cb0bebd3c1058dc46662de",
                "to": "cfd550910f04f1f3613c0b35cf61e3489facc0e617a2325cc5cddb5766a8e545",
                "amount": 1,
                "timestamp": 1790308118,
                "signature": "fd14c1d054abe44fc248253c73072a36442335dd59320b6b002b5e539419d75f9d2df9e7e3097c61da9a1fba0f6aa496756e1868b143abab73202ec451d45a05"
            }
        ]
    }
]
```

Note the genesis block. That is the very first block created which gets added by default when the blockchains is initialized.


### GET /blockchain/1

Returns a block specified by index id.

```sh
$ curl http://0.0.0.0:4000/blockchain/1
```

Response:

```
{
    "index": 1,
    "previousHash": "00002818703517bab21046d807a3fc0284b8a05979ce48baa40ed2eeeadd3b92",
    "hash": "0001cca94dbf7a3d58f4c71ab8d764256bdd06e764231dae51d95233c7ce2913",
    "timestamp": 1790308118,
    "nonce": 4835,
    "transactions": [
        {
            "from": "317bb5d96def9cf22892b2f8a11b8b42257a35d2f3cb0bebd3c1058dc46662de",
            "to": "cfd550910f04f1f3613c0b35cf61e3489facc0e617a2325cc5cddb5766a8e545",
            "amount": 1,
            "timestamp": 1790308118,
            "signature": "fd14c1d054abe44fc248253c73072a36442335dd59320b6b002b5e539419d75f9d2df9e7e3097c61da9a1fba0f6aa496756e1868b143abab73202ec451d45a05"
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
1
```

## Security

- Transactions are signed with the private key of the sender, so only the owner of an address can send transactions from it, and nobody can change a transaction once it is signed. Each transaction is accepted only once, so a signed transaction can't be sent again to repeat a payment.
- A chain received from another node only replaces the local one if it is longer, starts with the same genesis block and is valid: every block must be well formed, linked to the previous one and have a correct hash that meets the proof of work difficulty, and every transaction must follow the rules above (signature included) and appear only once. The chain stored on disk is checked the same way on start up, and the node refuses to start if it is not valid.
- Requests to other nodes time out after 10 seconds, don't follow redirects and are aborted if the response grows beyond 50 MB.
- Request bodies are limited to 10 KB, each client is rate limited (see `RATE_LIMIT_MAX`) and responses include the usual security headers (set with [Helmet](https://helmet.js.org/)). Errors are answered with JSON, without stack traces.

Keep in mind that this is a proof of concept, not something to run in production:

- Balances are not checked: an address can send more than it has received. Nothing creates coins (there are no mining rewards) and nothing keeps track of what each address owns.
- The proof of work difficulty is very low, so anyone can quickly build a longer valid chain and make the other nodes adopt it. That chain can only have transactions signed by their senders, but it can leave out any of the existing ones.
- The timestamp of a block is not part of its hash, so it can be changed without it being noticed.
- Nodes talk to each other over plain HTTP. Put them behind HTTPS if they are not on a trusted network.
- Wallet files are not protected with a password.

## Upgrading from previous versions

Chains created by previous versions have unsigned transactions, so they are not valid anymore: a node that has one refuses to start, and the error says which folder of `storage/` holds it. Move that folder away (or delete it) and the node starts a new chain. Chains without transactions keep working, even the ones saved with node-persist 3 by older versions, which are moved to the current storage format.

## Author

Bernardino Todolí López - [Taula Consulting](http://www.taula-consulting.com/en/)

## License

This project is licensed under the MIT License.
