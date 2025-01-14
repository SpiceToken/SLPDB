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
const connectionStringNode2_miner = 'http://bitcoin:password@0.0.0.0:18444';  // (optional) connect to a miner's rpc on 18444 that is not connected to SLPDB
const rpcNode2_miner = new rpcClient(connectionStringNode2_miner, { maxRetries: 0 });

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
let tokenId1: string;
let tokenId2: string;

let lastBlockHash: string;
let lastBlockIndex: number;

describe("2-Double-Spend-Genesis", () => {

    step("Initial setup for all tests", async () => {

        // generate block to clear the mempool (may be dirty from previous tests)
        await rpcNode1_miner.generate(1);

        // connect miner node to a full node that is connected to slpdb
        try {
            await rpcNode1_miner.addNode("bitcoin1", "onetry");
        } catch(err) { }

        // make sure we have coins to use in tests
        let balance = await rpcNode1_miner.getBalance();
        while (balance < 1) {
            await rpcNode1_miner.generate(1);
            balance = await rpcNode1_miner.getBalance();
        }

        // put all the funds on the receiver's address
        receiverRegtest = await rpcNode1_miner.getNewAddress("0");
        await rpcNode1_miner.sendToAddress(receiverRegtest, 1, "", "", true);
        await rpcNode1_miner.generate(1);

        // check both nodes are on the same block
        let node1Hash = await rpcNode1_miner.getbestblockhash();
        let node2Hash = await rpcNode2_miner.getbestblockhash();

        while(node1Hash !== node2Hash) {
            await sleep(50);
            node2Hash = await rpcNode2_miner.getbestblockhash();
        }
        assert.equal(node1Hash, node2Hash);

        let unspent = await rpcNode1_miner.listUnspent(0);
        unspent = unspent.filter((txo: any) => txo.address === receiverRegtest);
        if (unspent.length === 0) throw Error("No unspent outputs.");
        unspent.map((txo: any) => txo.cashAddress = txo.address);
        unspent.map((txo: any) => txo.satoshis = txo.amount*10**8);
        await Promise.all(unspent.map(async (txo: any) => txo.wif = await rpcNode1_miner.dumpPrivKey(txo.address)));

        // validate and categorize unspent TXOs
        let utxos = await slp.processUtxosForSlpAbstract([unspent[0]], validator);
        txnInputs = utxos.nonSlpUtxos;

        // disconnect nodes now
        let peerInfo: any[] = await rpcNode1_miner.getPeerInfo();
        await rpcNode1_miner.disconnectNode("bitcoin1");
        while(peerInfo.length > 0) {
            await sleep(100);
            peerInfo = await rpcNode1_miner.getPeerInfo();
        }
        assert.equal(peerInfo.length === 0, true);
    });

    step("DS-G: Create two different genesis transactions", async () => {
        // create and broadcast SLP genesis transaction
        receiverSlptest = Utils.toSlpAddress(receiverRegtest);
        let genesisTxnHex1 = txnHelpers.simpleTokenGenesis(
                                "unit-test-2a", "ut2a", new BigNumber(TOKEN_GENESIS_QTY).times(10**TOKEN_DECIMALS), null, null, 
                                TOKEN_DECIMALS, receiverSlptest, receiverSlptest, receiverSlptest, txnInputs);

        let genesisTxnHex2 = txnHelpers.simpleTokenGenesis(
            "unit-test-2b", "ut2b", new BigNumber(TOKEN_GENESIS_QTY).times(10**TOKEN_DECIMALS), null, null, 
            TOKEN_DECIMALS, receiverSlptest, receiverSlptest, receiverSlptest, txnInputs);
    
        tokenId1 = await rpcNode1_miner.sendRawTransaction(genesisTxnHex1, true);
        tokenId2 = await rpcNode2_miner.sendRawTransaction(genesisTxnHex2, true);

        assert.equal(tokenId1.length === 64, true);
        assert.equal(tokenId2.length === 64, true);
        assert.equal(tokenId1 !== tokenId2, true);
    });

    step("DS-G: Check SLPDB has pre-double spent transaction as unconfirmed", async () => {
        let txn = await db.unconfirmedFetch(tokenId1);
        while (!txn || !txn!.slp) { // NOTE: This is a problem where the unconfirmed item is first saved without the slp property (but ZMQ should happen only after slp is added)
            await sleep(50);
            txn = await db.unconfirmedFetch(tokenId1);
        }
        let unconfirmed = await db.db.collection("unconfirmed").find({}).toArray();
        assert.equal(txn!.slp!.valid, true);
        assert.equal(txn!.slp!.detail!.name, "unit-test-2a");
        assert.equal(txn!.slp!.detail!.symbol, "ut2a");     
        assert.equal(txn!.slp!.detail!.tokenIdHex, txn!.tx.h);
        assert.equal(unconfirmed.length, 1);
    });

    step("DS-G: Check SLPDB has pre-double spent transaction in graphs", async () => {
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId1 });
        while(!g || !g.graphTxn) {
            await sleep(50);
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId1 });
        }
        assert.equal(g!.graphTxn.txid, tokenId1);
        assert.equal(g!.tokenDetails.tokenIdHex, tokenId1);
        assert.equal(g!.graphTxn.blockHash, null);

        // TODO: Check unspent outputs.
    });

    step("DS-G: Check SLPDB has pre-double spent transaction in addresses", async () => {
        let a: AddressBalancesDbo[] = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId1 }).toArray();
        while(a.length === 0) {
            await sleep(50);
            a = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId1 }).toArray();
        }
        assert.equal(a.length, 1);
        assert.equal(a[0].address, receiverSlptest);
        assert.equal(a[0].satoshis_balance, 546);
        // @ts-ignore
        assert.equal(a[0].token_balance.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("DS-G: Check SLPDB has pre-double spent transaction in UTXOs", async () => {
        let x: UtxoDbo[] = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId1 }).toArray();
        while(x.length === 0) {
            await sleep(50);
            x = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId1 }).toArray();
        }
        assert.equal(x.length, 1);
        assert.equal(x[0].address, receiverSlptest);
        assert.equal(x[0].bchSatoshis, 546);
        // @ts-ignore
        assert.equal(x[0].slpAmount.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("DS-G: Check SLPDB has pre-double spent transaction in tokens", async () => {
        let t: TokenDBObject | null = await db.tokenFetch(tokenId1);
        assert.equal(t!.tokenDetails.tokenIdHex, tokenId1);
        assert.equal(t!.mintBatonUtxo, tokenId1 + ":2");
        assert.equal(t!.tokenStats!.block_created, null);
        assert.equal(t!.tokenStats!.block_last_active_mint, null);
        assert.equal(t!.tokenStats!.block_last_active_send, null);
        assert.equal(t!.tokenStats!.qty_token_burned.toString(), "0");
        assert.equal(t!.tokenStats!.qty_token_circulating_supply.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.qty_token_minted.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.minting_baton_status, TokenBatonStatus.ALIVE);
    });

    step("DS-G: Generate block on node 2 and reconnect the two nodes", async () => {
        // clear ZMQ cache
        slpdbTxnNotifications = [];
        slpdbBlockNotifications = [];

        // use 2nd (non-SLPDB connected node) to generate a block, reconnect to cause double spend
        lastBlockHash = (await rpcNode2_miner.generate(1))[0];
        lastBlockIndex = (await rpcNode2_miner.getBlock(lastBlockHash, true)).height;

        // connect miner node to a full node that is connected to slpdb
        try {
            await rpcNode1_miner.addNode("bitcoin1", "onetry");
        } catch(err) { }

        // reconnect nodes
        let peerInfo: any[] = await rpcNode1_miner.getPeerInfo();
        while(peerInfo.length < 1) {
            await sleep(100);
            peerInfo = await rpcNode1_miner.getPeerInfo();
        }
        assert.equal(peerInfo.length, 1);

        let lastBlockHash2 = await rpcNode1_miner.getbestblockhash();
        while(lastBlockHash !== lastBlockHash2) {
            await sleep(50);
            lastBlockHash2 = await rpcNode1_miner.getbestblockhash();
        }
        assert.equal(lastBlockHash, lastBlockHash2);
    });

    step("DS-G: produces ZMQ output for the transaction", async () => {
        // give slpdb time to process
        while(slpdbTxnNotifications.filter(txn => txn.tx.h === tokenId2).length === 0) {
            await sleep(50);
        }

        let txn = slpdbTxnNotifications.filter(txn => txn.tx.h === tokenId2)[0];
        // check that SLPDB made proper outgoing ZMQ messages for 
        assert.equal(slpdbTxnNotifications.length > 0, true);
        assert.equal(txn.slp!.valid, true);
        assert.equal(txn.slp!.detail!.name, "unit-test-2b");
        assert.equal(txn.slp!.detail!.symbol, "ut2b");
        assert.equal(txn.slp!.detail!.tokenIdHex, tokenId2);
        assert.equal(txn.slp!.detail!.outputs![0].address, receiverSlptest);
        assert.equal(txn.slp!.detail!.transactionType, SlpTransactionType.GENESIS);
        // @ts-ignore
        assert.equal(txn.slp!.detail!.outputs![0].amount!["$numberDecimal"], TOKEN_GENESIS_QTY.toFixed());
        assert.equal(txn.blk!.h, lastBlockHash);
        assert.equal(txn.blk!.i, lastBlockIndex);
        assert.equal(typeof txn.in, "object");
        assert.equal(typeof txn.out, "object");
        assert.equal(typeof txn.tx, "object");
    });

    step("DS-G: produces ZMQ output for the block", async () => {
        while(slpdbBlockNotifications.length === 0) {
            await sleep(50);
        }
        assert.equal(slpdbBlockNotifications.length, 1);
        assert.equal(slpdbBlockNotifications[0].txns.length, 1);
        assert.equal(slpdbBlockNotifications[0].txns[0]!.txid, tokenId2);
        assert.equal(slpdbBlockNotifications[0].txns[0]!.slp.detail!.tokenIdHex, tokenId2);
        assert.equal(slpdbBlockNotifications[0].txns[0]!.slp.detail!.name, "unit-test-2b");
        assert.equal(slpdbBlockNotifications[0].txns[0]!.slp.detail!.symbol, "ut2b");
        // @ts-ignore
        assert.equal(slpdbBlockNotifications[0]!.txns[0]!.slp!.detail!.outputs![0].amount!, TOKEN_GENESIS_QTY.toFixed());  // this type is not consistent with txn notification
        // TODO: There is not block hash with block zmq notification!
        // assert.equal(typeof slpdbBlockNotifications[0]!.hash, "string");
        // assert.equal(slpdbBlockNotifications[0]!.hash.length, 64);
    });

    step("DS-G: Check that the double spent token is removed everywhere from SLPDB", async () => {
        let t: TokenDBObject | null = await db.tokenFetch(tokenId1);
        let x: UtxoDbo[] = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId1 }).toArray();
        let a: AddressBalancesDbo[] = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId1 }).toArray();
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId1 });
        let txn_u = await db.unconfirmedFetch(tokenId1);
        let txn_c = await db.confirmedFetch(tokenId1);
        while(t || x.length > 0 || a.length > 0 || g || txn_u || txn_c) {
            await sleep(50);
            t = await db.tokenFetch(tokenId1);
            x = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId1 }).toArray();
            a = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId1 }).toArray();
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId1 });
            txn_u = await db.unconfirmedFetch(tokenId1);
            txn_c = await db.confirmedFetch(tokenId1);
        }
        assert.equal(t, null);
        assert.equal(x.length === 0, true);
        assert.equal(a.length === 0, true);
        assert.equal(g, null);
        assert.equal(txn_c, null);
        assert.equal(txn_u, null);
    });

    step("DS-G: store double spend token2 in confirmed", async () => {
        let txn = await db.confirmedFetch(tokenId2);
        while (!txn || !txn!.slp) { // NOTE: This is a problem where the unconfirmed item is first saved without the slp property (but ZMQ should happen only after slp is added)
            await sleep(50);
            txn = await db.confirmedFetch(tokenId2);
        }
        let confirmed = await db.db.collection("confirmed").find({ "tx.h": tokenId2 }).toArray();
        assert.equal(txn!.slp!.valid, true);
        assert.equal(txn!.slp!.detail!.name, "unit-test-2b");
        assert.equal(txn!.slp!.detail!.symbol, "ut2b");     
        assert.equal(txn!.slp!.detail!.tokenIdHex, txn!.tx.h);
        assert.equal(confirmed.length, 1);

        // make sure it is not in unconfirmed
        let txn_u = await db.unconfirmedFetch(tokenId2);
        assert.equal(txn_u, null);
    });

    step("DS-G: stores double spend token2 in tokens", async () => {
        let t: TokenDBObject | null = await db.tokenFetch(tokenId2);
        assert.equal(t!.tokenDetails.tokenIdHex, tokenId2);
        assert.equal(t!.mintBatonUtxo, tokenId2 + ":2");
        assert.equal(t!.tokenStats!.block_created, lastBlockIndex);
        assert.equal(t!.tokenStats!.block_last_active_mint, null);
        assert.equal(t!.tokenStats!.block_last_active_send, null);
        assert.equal(t!.tokenStats!.qty_token_burned.toString(), "0");
        assert.equal(t!.tokenStats!.qty_token_circulating_supply.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.qty_token_minted.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.minting_baton_status, TokenBatonStatus.ALIVE);
    });

    step("DS-G: stores double spend token2 in utxos", async () => {
        let x: UtxoDbo[] = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId2 }).toArray();
        while(x.length === 0) {
            await sleep(50);
            x = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId2 }).toArray();
        }
        assert.equal(x.length, 1);
        assert.equal(x[0].address, receiverSlptest);
        assert.equal(x[0].bchSatoshis, 546);
        // @ts-ignore
        assert.equal(x[0].slpAmount.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("DS-G: stores double spend token2 in addresses", async () => {
        let a: AddressBalancesDbo[] = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId2 }).toArray();
        while(a.length === 0) {
            await sleep(50);
            a = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId2 }).toArray();
        }
        assert.equal(a.length, 1);
        assert.equal(a[0].address, receiverSlptest);
        assert.equal(a[0].satoshis_balance, 546);
        // @ts-ignore
        assert.equal(a[0].token_balance.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("DS-G: stores double spend token2 in graphs", async () => {
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId2 });
        while(!g || !g.graphTxn) {
            await sleep(50);
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": tokenId2 });
        }
        assert.equal(g!.graphTxn.txid, tokenId2);
        assert.equal(g!.tokenDetails.tokenIdHex, tokenId2);
        assert.equal(g!.graphTxn.blockHash!.toString("hex"), lastBlockHash);

        // TODO: Check unspent outputs.
    });

    step("Cleanup after tests", async () => {
        // generate block to clear the mempool (may be dirty from previous tests)
        await rpcNode1_miner.generate(1);
        sock.disconnect('tcp://0.0.0.0:27339');
    });
});
