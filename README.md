# Simple Blockchain in Node.js

This is a very simple blockchain implementation in Node.js.

It is just a proof of concept so as to understand how a blockchain may be created, including decentralized and distributed ledger concept.


## Getting Started

### Prerequisites

You need node.js and npm package manager to be installed. I developed this code using node v12.10.0, but should work with previous versions.

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


###  Running multiple nodes

Use this if you want to have multiple instances in the same machine. Nodes defined in the config file above will be accessed and keep updated.

This is a convinient way for playing around with distributed ledger quickly.

```sh
$ node multiple
```

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

The body of the request should contain a json string with these keys: `from`, `to` and `amount`.

```sh
$ curl --header "Content-Type: application/json" \
  --request POST \
  --data '{"from":"bd748a5a5479649cfd83132d3be99d0c1a2ebadc1e4c405e","to":"3be24b8dccf3c0a171c76b092e2a95f6e9d387eac6b647f1","amount": 1}' \
  curl http://0.0.0.0:4000/transaction
```

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
        "from": "bd748a5a5479649cfd83132d3be99d0c1a2ebadc1e4c405e",
        "to": "3be24b8dccf3c0a171c76b092e2a95f6e9d387eac6b647f1",
        "amount": 1,
        "timestamp": 1569590821
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
    "hash": "000089aef2e4516c72ef4c29f9490471cf20b7fcc7819bb000dc2d8b27281268",
    "timestamp": 1569590961,
    "nonce": 279,
    "transactions": [
        {
            "from": "bd748a5a5479649cfd83132d3be99d0c1a2ebadc1e4c405e",
            "to": "3be24b8dccf3c0a171c76b092e2a95f6e9d387eac6b647f1",
            "amount": 1,
            "timestamp": 1569590821
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
        "timestamp": 1568323235,
        "nonce": 4190,
        "transactions": []
    },
    {
        "index": 1,
        "previousHash": "00002818703517bab21046d807a3fc0284b8a05979ce48baa40ed2eeeadd3b92",
        "hash": "000089aef2e4516c72ef4c29f9490471cf20b7fcc7819bb000dc2d8b27281268",
        "timestamp": 1569590961,
        "nonce": 279,
        "transactions": [
            {
                "from": "bd748a5a5479649cfd83132d3be99d0c1a2ebadc1e4c405e",
                "to": "3be24b8dccf3c0a171c76b092e2a95f6e9d387eac6b647f1",
                "amount": 1,
                "timestamp": 1569590821
            }
        ]
    }
]
```

Note the genesis block. That is the very first block created which gets added by default when the blockchains is initialized.


### GET /blockchain/1

Returns a block specified by index id.

```sh
$ http://0.0.0.0:4000/blockchain/1
```

Response:

```
{
    "index": 1,
    "previousHash": "00002818703517bab21046d807a3fc0284b8a05979ce48baa40ed2eeeadd3b92",
    "hash": "000089aef2e4516c72ef4c29f9490471cf20b7fcc7819bb000dc2d8b27281268",
    "timestamp": 1569590961,
    "nonce": 279,
    "transactions": [
        {
            "from": "bd748a5a5479649cfd83132d3be99d0c1a2ebadc1e4c405e",
            "to": "3be24b8dccf3c0a171c76b092e2a95f6e9d387eac6b647f1",
            "amount": 1,
            "timestamp": 1569590821
        }
    ]
}
```

### GET /blockchain/last-index

Returns the index of the last inseted block in the blockchain.

```sh
$ http://0.0.0.0:4000/blockchain/last-index
```

Response:

```
1
```

## Author

Bernardino Todolí López - [Taula Consulting](http://www.taula-consulting.com/en/)

## License

This project is licensed under the MIT License.
