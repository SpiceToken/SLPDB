import * as assert from "assert";
import { Slp, LocalValidator, TransactionHelpers, Utils, SlpAddressUtxoResult, SlpTransactionType } from 'slpjs';
import * as zmq from 'zeromq';
import { BITBOX } from 'bitbox-sdk';
import BigNumber from 'bignumber.js';
import { step } from 'mocha-steps';

import { Config } from "../config";
import { Db } from '../db';
import { TNATxn, TNATxnSlpDetails } from "../tna";
import { TokenBatonStatus } from "../interfaces";
import { GraphTxnDbo, AddressBalancesDbo, UtxoDbo, TokenDBObject } from "../interfaces";

const bitbox = new BITBOX();
const slp = new Slp(bitbox);
const txnHelpers = new TransactionHelpers(slp);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const TOKEN_DECIMALS = 1;
const TOKEN_GENESIS_QTY = 100;
const TOKEN_SEND_QTY = 1;

// connect to bitcoin regtest network JSON-RPC
const rpcClient = require('bitcoin-rpc-promise-retry');
const connectionStringNode1_miner = 'http://bitcoin:password@0.0.0.0:18443';  // (optional) connect to a miner's rpc on 18444 that is not connected to SLPDB
const rpcNode1_miner = new rpcClient(connectionStringNode1_miner, { maxRetries: 0 });

// setup a new local SLP validator instance
const validator = new LocalValidator(bitbox, async (txids) => { 
    let txn;
    try {
        txn = <string>await rpcNode1_miner.getRawTransaction(txids[0]);
    } catch(err) {
        throw Error(`[ERROR] Could not get transaction ${txids[0]} in local validator: ${err}`)
    }
    return [ txn ];
}, console);

// connect to SLPDB ZMQ notifications
let slpdbTxnNotifications: TNATxn[] = [];
let slpdbBlockNotifications: { txns: { slp: TNATxnSlpDetails, txid: string }[], hash: string }[] = [];
const sock: any = zmq.socket('sub');
sock.connect('tcp://0.0.0.0:27339');
sock.subscribe('mempool');
sock.subscribe('block');
sock.on('message', async function(topic: string, message: Buffer) {
    if (topic.toString() === 'mempool') {
        let obj = JSON.parse(message.toString('utf8'));
        slpdbTxnNotifications.unshift(obj);
    } else if (topic.toString() === 'block') {
        let obj = JSON.parse(message.toString('utf8'));
        slpdbBlockNotifications.unshift(obj);    
    }
});

// connect to the regtest mongoDB
let db = new Db({ dbUrl: "mongodb://0.0.0.0:26017", dbName: "slpdb_test", config: Config.db });

// produced and shared between tests.
let receiverRegtest: string;
let receiverSlptest: string; // this is same address as receiverRegtest, converted to slptest format
let txnInputs: SlpAddressUtxoResult[];
let tokenId: string;
let sendTxid: string;
let lastBlockHash: string;
let lastBlockIndex: number;

describe("1-Token-Type-1", () => {

    step("Initial setup for all tests", async () => {
        // TODO: burn any existing wallet funds, in order to prevent "Transaction too large".

        // generate block to clear the mempool (may be dirty from previous tests)
        await rpcNode1_miner.generate(1);

        // (optional) connect miner node to a full node that is connected to slpdb
        // try {
        //     await rpcNode1_miner.addNode("bitcoin2", "onetry");
        // } catch(err) { }
        
        // make sure we have coins to use in tests
        let balance = await rpcNode1_miner.getBalance();
        while (balance < 1) {
            await rpcNode1_miner.generate(1);
            balance = await rpcNode1_miner.getBalance();
        }

        // put all the funds on the receiver's address
        receiverRegtest = await rpcNode1_miner.getNewAddress("0");
        await rpcNode1_miner.sendToAddress(receiverRegtest, 1, "", "", true);
    });

    step("GENESIS: setup for the txn tests", async () => {
        let unspent = await rpcNode1_miner.listUnspent(0);
        unspent = unspent.filter((txo: any) => txo.address === receiverRegtest);
        if (unspent.length === 0) throw Error("No unspent outputs.");
        unspent.map((txo: any) => txo.cashAddress = txo.address);
        unspent.map((txo: any) => txo.satoshis = txo.amount*10**8);
        await Promise.all(unspent.map(async (txo: any) => txo.wif = await rpcNode1_miner.dumpPrivKey(txo.address)));

        // validate and categorize unspent TXOs
        let utxos = await slp.processUtxosForSlpAbstract([unspent[0]], validator);
        txnInputs = utxos.nonSlpUtxos;

        assert.equal(txnInputs.length > 0, true);
    });

    step("GENESIS: produces ZMQ output for the transaction", async () => {
        // create and broadcast SLP genesis transaction
        receiverSlptest = Utils.toSlpAddress(receiverRegtest);
        let genesisTxnHex = txnHelpers.simpleTokenGenesis(
                                "unit-test-1", "ut1", new BigNumber(TOKEN_GENESIS_QTY).times(10**TOKEN_DECIMALS), null, null, 
                                TOKEN_DECIMALS, receiverSlptest, receiverSlptest, receiverSlptest, txnInputs);

        tokenId = await rpcNode1_miner.sendRawTransaction(genesisTxnHex, true);

        // give slpdb time to process
        while(slpdbTxnNotifications.length === 0) {
            await sleep(50);
        }

        // check that SLPDB made proper outgoing ZMQ messages for 
        assert.equal(slpdbTxnNotifications.length, 1);
        assert.equal(slpdbTxnNotifications[0]!.slp!.valid, true);
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.name, "unit-test-1");
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.symbol, "ut1");
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.tokenIdHex, tokenId);
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.outputs![0].address, receiverSlptest);
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.transactionType, SlpTransactionType.GENESIS);
        // @ts-ignore
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.outputs![0].amount!["$numberDecimal"], TOKEN_GENESIS_QTY.toFixed());
        assert.equal(slpdbTxnNotifications[0]!.blk === undefined, true);
        assert.equal(typeof slpdbTxnNotifications[0]!.in, "object");
        assert.equal(typeof slpdbTxnNotifications[0]!.out, "object");
        assert.equal(typeof slpdbTxnNotifications[0]!.tx, "object");
    });

    step("GENESIS: stores in unconfirmed collection", async () => {
        let txn = await db.unconfirmedFetch(tokenId);
        let unconfirmed = await db.db.collection("unconfirmed").find({}).toArray();
        assert.equal(txn!.slp!.valid, true);
        assert.equal(txn!.slp!.detail!.name, "unit-test-1");
        assert.equal(txn!.slp!.detail!.symbol, "ut1");
        // @ts-ignore
        assert.equal(txn!.slp!.detail!.outputs![0].amount!.toString(), TOKEN_GENESIS_QTY.toFixed());        
        assert.equal(txn!.slp!.detail!.tokenIdHex, txn!.tx.h);
        assert.equal(unconfirmed.length, 1);
    });

    step("GENESIS: stores in tokens collection (before block)", async () => {
        let t: TokenDBObject | null = await db.tokenFetch(tokenId);
        assert.equal(t!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(t!.mintBatonUtxo, tokenId + ":2");
        assert.equal(t!.tokenStats!.block_created, null);
        assert.equal(t!.tokenStats!.block_last_active_mint, null);
        assert.equal(t!.tokenStats!.block_last_active_send, null);
        assert.equal(t!.tokenStats!.qty_token_burned.toString(), "0");
        assert.equal(t!.tokenStats!.qty_token_circulating_supply.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.qty_token_minted.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.minting_baton_status, TokenBatonStatus.ALIVE);
    });

    step("GENESIS: stores in graphs collection (before block)", async () => {
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId });
        while(!g || !g.graphTxn) {
            await sleep(50);
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId });
        }
        assert.equal(g!.graphTxn.txid, tokenId);
        assert.equal(g!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(g!.graphTxn.blockHash, null);

        // TODO: Check unspent outputs.
    });

    step("GENESIS: stores in addresses collection (before block)", async () => {
        let a: AddressBalancesDbo[] = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(a.length === 0) {
            await sleep(50);
            a = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(a.length, 1);
        assert.equal(a[0].address, receiverSlptest);
        assert.equal(a[0].satoshis_balance, 546);
        // @ts-ignore
        assert.equal(a[0].token_balance.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("GENESIS: stores in utxos collection (before block)", async () => {
        let x: UtxoDbo[] = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(x.length === 0) {
            await sleep(50);
            x = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(x.length, 1);
        assert.equal(x[0].address, receiverSlptest);
        assert.equal(x[0].bchSatoshis, 546);
        // @ts-ignore
        assert.equal(x[0].slpAmount.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("GENESIS: produces ZMQ output at block", async () => {
        // clear ZMQ cache
        slpdbTxnNotifications = [];
        slpdbBlockNotifications = [];

        lastBlockHash = (await rpcNode1_miner.generate(1))[0];
        while(slpdbBlockNotifications.length === 0) {
            await sleep(50);
        }
        lastBlockIndex = (await rpcNode1_miner.getBlock(lastBlockHash, true)).height;
        assert.equal(slpdbBlockNotifications.length, 1);
        assert.equal(slpdbBlockNotifications[0].txns.length, 1);
        assert.equal(slpdbBlockNotifications[0].txns[0]!.txid, tokenId);
        assert.equal(slpdbBlockNotifications[0].txns[0]!.slp.detail!.tokenIdHex, tokenId);
        assert.equal(slpdbBlockNotifications[0].txns[0]!.slp.detail!.name, "unit-test-1");
        assert.equal(slpdbBlockNotifications[0].txns[0]!.slp.detail!.symbol, "ut1");
        // @ts-ignore
        assert.equal(slpdbBlockNotifications[0]!.txns[0]!.slp!.detail!.outputs![0].amount!, TOKEN_GENESIS_QTY.toFixed());  // this type is not consistent with txn notification
        // TODO: There is not block hash with block zmq notification!
        // assert.equal(typeof slpdbBlockNotifications[0]!.hash, "string");
        // assert.equal(slpdbBlockNotifications[0]!.hash.length, 64);
    });

    step("GENESIS: updates graphs collection (after block)", async () => {
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId });
        while(!g || g!.graphTxn.blockHash === null) {
            await sleep(50);
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId });
        }
        assert.equal(g!.graphTxn.txid, tokenId);
        assert.equal(g!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(g!.graphTxn.blockHash.toString('hex'), lastBlockHash);

        // TODO: Check unspent outputs.
    });

    step("GENESIS: unconfirmed collction is empty (after block)", async () => {
        let txn = await db.unconfirmedFetch(tokenId);
        let unconfirmed = await db.db.collection("unconfirmed").find({}).toArray();
        assert.equal(txn, null);
        assert.equal(unconfirmed.length, 0);
    });

    step("GENESIS: stores in confirmed collection (after block)", async () => {
        let txn = await db.confirmedFetch(tokenId);
        assert.equal(txn!.slp!.valid, true);
        assert.equal(txn!.slp!.detail!.name, "unit-test-1");
        assert.equal(txn!.slp!.detail!.symbol, "ut1");
        // @ts-ignore
        assert.equal(txn!.slp!.detail!.outputs![0].amount!.toString(), TOKEN_GENESIS_QTY.toFixed());        
        assert.equal(txn!.slp!.detail!.tokenIdHex, txn!.tx.h);
    });

    step("GENESIS: stores in tokens collection (after block)", async () => {
        let t: TokenDBObject | null = await db.tokenFetch(tokenId);
        while(!t || t!.tokenStats!.block_created === null) {
            await sleep(50);
            t = await db.tokenFetch(tokenId);
        }
        assert.equal(typeof t!.tokenDetails.timestamp, "string");
        assert.equal(t!.tokenDetails.timestamp_unix! > 0, true);
        assert.equal(t!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(t!.mintBatonUtxo, tokenId + ":2");
        assert.equal(t!.tokenStats!.block_created!, lastBlockIndex);
        assert.equal(t!.tokenStats!.block_last_active_mint, null);
        assert.equal(t!.tokenStats!.block_last_active_send, null);
        assert.equal(t!.tokenStats!.qty_token_burned.toString() === "0", true);
        assert.equal(t!.tokenStats!.qty_token_circulating_supply.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.qty_token_minted.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.minting_baton_status, TokenBatonStatus.ALIVE);
    });

    step("GENESIS: updates graphs collection (after block)", async () => {
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId });
        while(!g || g!.graphTxn.blockHash === null) {
            await sleep(50);
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId });
        }
        assert.equal(g!.graphTxn.txid, tokenId);
        assert.equal(g!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(g!.graphTxn.blockHash.toString('hex'), lastBlockHash);

        // TODO: Check unspent outputs.
    });

    step("GENESIS: stores in addresses collection (after block)", async () => {
        let a: AddressBalancesDbo[] = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(a.length === 0) {
            await sleep(50);
            a = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(a.length, 1);
        assert.equal(a[0].address, receiverSlptest);
        assert.equal(a[0].satoshis_balance, 546);
        // @ts-ignore
        assert.equal(a[0].token_balance.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("GENESIS: stores in utxos collection (after block)", async () => {
        let x: UtxoDbo[] = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(x.length === 0) {
            await sleep(50);
            x = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(x.length, 1);
        assert.equal(x[0].address, receiverSlptest);
        assert.equal(x[0].bchSatoshis, 546);
        // @ts-ignore
        assert.equal(x[0].slpAmount.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("SEND: setup for the txn tests", async () => {
        // get current address UTXOs
        let unspent = await rpcNode1_miner.listUnspent(0);
        unspent = unspent.filter((txo: any) => txo.address === receiverRegtest);
        if (unspent.length === 0) throw Error("No unspent outputs.");
        unspent.map((txo: any) => txo.cashAddress = txo.address);
        unspent.map((txo: any) => txo.satoshis = txo.amount*10**8);
        await Promise.all(unspent.map(async (txo: any) => txo.wif = await rpcNode1_miner.dumpPrivKey(txo.address)));

        // process raw UTXOs
        let utxos = await slp.processUtxosForSlpAbstract(unspent, validator);

        // select the inputs for transaction
        txnInputs = [ ...utxos.nonSlpUtxos, ...utxos.slpTokenUtxos[tokenId] ];

        assert.equal(txnInputs.length > 1, true);
    });

    step("SEND: produces ZMQ output for the transaction", async () => {
        // clear ZMQ cache
        slpdbTxnNotifications = [];
        slpdbBlockNotifications = [];

        // create a SEND Transaction
        let sendTxnHex = txnHelpers.simpleTokenSend(tokenId, new BigNumber(TOKEN_SEND_QTY).times(10**TOKEN_DECIMALS), txnInputs, receiverSlptest, receiverSlptest);

        sendTxid = await rpcNode1_miner.sendRawTransaction(sendTxnHex, true);

        while(slpdbTxnNotifications.length === 0) {
            await sleep(50);
        }

        // check that SLPDB made proper outgoing ZMQ messages for 
        assert.equal(slpdbTxnNotifications.length, 1);
        assert.equal(slpdbTxnNotifications[0]!.slp!.valid, true);
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.name, "unit-test-1");
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.symbol, "ut1");
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.tokenIdHex, tokenId);
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.outputs![0].address, receiverSlptest);
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.transactionType, SlpTransactionType.SEND);
        // @ts-ignore
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.outputs![0].amount!["$numberDecimal"], (new BigNumber(TOKEN_SEND_QTY)).toFixed());
        let change = (new BigNumber(TOKEN_GENESIS_QTY)).minus(TOKEN_SEND_QTY).toFixed();
        // @ts-ignore
        assert.equal(slpdbTxnNotifications[0]!.slp!.detail!.outputs![1].amount!["$numberDecimal"], change);
        assert.equal(slpdbTxnNotifications[0]!.blk === undefined, true);
        assert.equal(typeof slpdbTxnNotifications[0]!.in, "object");
        assert.equal(typeof slpdbTxnNotifications[0]!.out, "object");
        assert.equal(typeof slpdbTxnNotifications[0]!.tx, "object");
    });

    step("SEND: stores in unconfirmed collection", async () => {
        let txn = await db.unconfirmedFetch(sendTxid);
        let unconfirmed = await db.db.collection("unconfirmed").find({}).toArray();
        assert.equal(txn!.slp!.valid, true);
        assert.equal(txn!.slp!.detail!.name, "unit-test-1");
        assert.equal(txn!.slp!.detail!.symbol, "ut1");
        // @ts-ignore
        assert.equal(txn!.slp!.detail!.outputs![0].amount!.toString(), TOKEN_SEND_QTY.toFixed());
        // @ts-ignore
        assert.equal(txn!.slp!.detail!.outputs![1].amount!.toString(), (TOKEN_GENESIS_QTY - TOKEN_SEND_QTY).toFixed());       
        assert.equal(txn!.slp!.detail!.tokenIdHex, tokenId);
        assert.equal(unconfirmed.length, 1);
    });

    step("SEND: stores in graphs collection (before block)", async () => {
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": sendTxid });
        while(!g || !g.graphTxn) {
            await sleep(50);
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": sendTxid });
        }
        assert.equal(g!.graphTxn.txid, sendTxid);
        assert.equal(g!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(g!.graphTxn.blockHash, null);

        // TODO: Check unspent outputs.

        // TODO: Check... for genesis
        // "spendTxid": "7a19684d7eca289ff34faae06a3de7117852e445adb9bf147a5cbd3e420c5f05",
        // "status": "SPENT_SAME_TOKEN",
        // "invalidReason": null
    });

    step("SEND: stores in addresses collection (before block)", async () => {
        let a: AddressBalancesDbo[] = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(a.length === 0) {
            await sleep(50);
            a = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(a.length, 1);
        assert.equal(a[0].address, receiverSlptest);
        assert.equal(a[0].satoshis_balance, 1092);
        // @ts-ignore
        assert.equal(a[0].token_balance.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("SEND: stores in utxos collection (before block)", async () => {
        let x: UtxoDbo[] = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(x.length < 1) {
            await sleep(50);
            x = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        let amounts = [ TOKEN_SEND_QTY.toFixed(), (TOKEN_GENESIS_QTY-TOKEN_SEND_QTY).toFixed()];
        assert.equal(x.length, 2);
        assert.equal(x[0].address, receiverSlptest);
        assert.equal(x[0].bchSatoshis, 546);
        // @ts-ignore
        assert.equal(amounts.includes(x[0].slpAmount.toString()), true);
        
        // remove item and check the next amount
        amounts = amounts.filter(a => a !== x[0].slpAmount.toString());

        assert.equal(x[1].address, receiverSlptest);
        assert.equal(x[1].bchSatoshis, 546);
        // @ts-ignore
        assert.equal(amounts.includes(x[1].slpAmount.toString()), true);
    });

    step("SEND: stores in tokens collection (before block)", async () => {
        let t: TokenDBObject | null = await db.tokenFetch(tokenId);
        assert.equal(t!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(t!.mintBatonUtxo, tokenId + ":2");  // TODO
        assert.equal(t!.tokenStats!.block_created! > 0, true);
        assert.equal(t!.tokenStats!.block_last_active_mint, null);  // TODO
        assert.equal(t!.tokenStats!.block_last_active_send, null);  // TODO
        assert.equal(t!.tokenStats!.qty_token_burned.toString(), "0"); // TODO
        assert.equal(t!.tokenStats!.qty_token_circulating_supply.toString(), TOKEN_GENESIS_QTY.toFixed());  // TODO
        assert.equal(t!.tokenStats!.qty_token_minted.toString(), TOKEN_GENESIS_QTY.toFixed());  // TODO
        assert.equal(t!.tokenStats!.minting_baton_status, TokenBatonStatus.ALIVE); // TODO
    });

    step("SEND: produces ZMQ output at block", async () => {
        // clear ZMQ cache
        slpdbTxnNotifications = [];
        slpdbBlockNotifications = [];

        lastBlockHash = (await rpcNode1_miner.generate(1))[0];
        while(slpdbBlockNotifications.length === 0) {
            await sleep(50);
        }
        lastBlockIndex = (await rpcNode1_miner.getBlock(lastBlockHash, true)).height;
        assert.equal(slpdbBlockNotifications.length, 1);
        assert.equal(slpdbBlockNotifications[0].txns.length, 1);
        assert.equal(slpdbBlockNotifications[0].txns[0]!.txid, sendTxid);
        assert.equal(slpdbBlockNotifications[0].txns[0]!.slp.detail!.tokenIdHex, tokenId);
        assert.equal(slpdbBlockNotifications[0].txns[0]!.slp.detail!.name, "unit-test-1");
        assert.equal(slpdbBlockNotifications[0].txns[0]!.slp.detail!.symbol, "ut1");
        // @ts-ignore
        assert.equal(slpdbBlockNotifications[0]!.txns[0]!.slp!.detail!.outputs![0].amount!, TOKEN_SEND_QTY.toFixed());  // this type is not consistent with txn notification
        // @ts-ignore
        assert.equal(slpdbBlockNotifications[0]!.txns[0]!.slp!.detail!.outputs![1].amount!, (TOKEN_GENESIS_QTY-TOKEN_SEND_QTY).toFixed());  // this type is not consistent with txn notification
        // TODO: There is not block hash with block zmq notification!
        // assert.equal(typeof slpdbBlockNotifications[0]!.hash, "string");
        // assert.equal(slpdbBlockNotifications[0]!.hash.length, 64);
    });

    step("SEND: unconfirmed collction is empty (after block)", async () => {
        let txn = await db.unconfirmedFetch(sendTxid);
        let unconfirmed = await db.db.collection("unconfirmed").find({}).toArray();
        assert.equal(txn, null);
        assert.equal(unconfirmed.length, 0);
    });

    step("SEND: stores in confirmed collection (after block)", async () => {
        let txn = await db.confirmedFetch(sendTxid);
        assert.equal(txn!.slp!.valid, true);
        assert.equal(txn!.slp!.detail!.name, "unit-test-1");
        assert.equal(txn!.slp!.detail!.symbol, "ut1");
        // @ts-ignore
        assert.equal(txn!.slp!.detail!.outputs![0].amount!.toString(), TOKEN_SEND_QTY.toFixed());    
        // @ts-ignore
        assert.equal(txn!.slp!.detail!.outputs![1].amount!.toString(), (TOKEN_GENESIS_QTY-TOKEN_SEND_QTY).toFixed());     
        assert.equal(txn!.slp!.detail!.tokenIdHex, tokenId);
        assert.equal(txn!.tx.h, sendTxid);
    });

    step("SEND: stores in tokens collection (after block)", async () => {
        let t: TokenDBObject | null = await db.tokenFetch(tokenId);
        while(!t || t!.tokenStats!.block_created === null || t!.tokenStats!.block_last_active_send === null) {
            await sleep(50);
            t = await db.tokenFetch(tokenId);
        }
        assert.equal(typeof t!.tokenDetails.timestamp, "string");
        assert.equal(t!.tokenDetails.timestamp_unix! > 0, true);
        assert.equal(t!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(t!.mintBatonUtxo, tokenId + ":2");
        assert.equal(t!.tokenStats!.block_created!, lastBlockIndex-1);
        assert.equal(t!.tokenStats!.block_last_active_mint, null);
        assert.equal(t!.tokenStats!.block_last_active_send, lastBlockIndex);
        assert.equal(t!.tokenStats!.qty_token_burned.toString() === "0", true);
        assert.equal(t!.tokenStats!.qty_token_circulating_supply.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.qty_token_minted.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.minting_baton_status, TokenBatonStatus.ALIVE);
    });

    step("SEND: updates graphs collection (after block)", async () => {
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": sendTxid });
        while(!g || g!.graphTxn.blockHash === null) {
            await sleep(50);
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": sendTxid });
        }
        assert.equal(g!.graphTxn.txid, sendTxid);
        assert.equal(g!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(g!.graphTxn.blockHash.toString('hex'), lastBlockHash);

        // TODO: Check unspent outputs.

        // TODO: Check... for genesis
        // "spendTxid": "7a19684d7eca289ff34faae06a3de7117852e445adb9bf147a5cbd3e420c5f05",
        // "status": "SPENT_SAME_TOKEN",
        // "invalidReason": null
    });

    step("SEND: stores in addresses collection (after block)", async () => {
        let a: AddressBalancesDbo[] = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(a.length === 0) {
            await sleep(50);
            a = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(a.length, 1);
        assert.equal(a[0].address, receiverSlptest);
        assert.equal(a[0].satoshis_balance, 1092);
        // @ts-ignore
        assert.equal(a[0].token_balance.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("SEND: stores in utxos collection (after block)", async () => {
        let x: UtxoDbo[] = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(x.length < 1) {
            await sleep(50);
            x = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        let amounts = [ TOKEN_SEND_QTY.toFixed(), (TOKEN_GENESIS_QTY-TOKEN_SEND_QTY).toFixed()];
        assert.equal(x.length, 2);
        assert.equal(x[0].address, receiverSlptest);
        assert.equal(x[0].bchSatoshis, 546);
        // @ts-ignore
        assert.equal(amounts.includes(x[0].slpAmount.toString()), true);
        
        // remove item and check the next amount
        amounts = amounts.filter(a => a !== x[0].slpAmount.toString());

        assert.equal(x[1].address, receiverSlptest);
        assert.equal(x[1].bchSatoshis, 546);
        // @ts-ignore
        assert.equal(amounts.includes(x[1].slpAmount.toString()), true);
    });

    step("Cleanup after tests", async () => {
        // generate block to clear the mempool (may be dirty from previous tests)
        await rpcNode1_miner.generate(1);
        sock.disconnect('tcp://0.0.0.0:27339');
    });
});
