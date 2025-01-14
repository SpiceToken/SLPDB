import * as assert from "assert";
import { Slp, LocalValidator, TransactionHelpers, Utils, SlpAddressUtxoResult, SlpTransactionType } from 'slpjs';
import * as zmq from 'zeromq';
import { BITBOX } from 'bitbox-sdk';
import BigNumber from 'bignumber.js';
import { step } from 'mocha-steps';

import { Config } from "../config";
import { Db } from '../db';
import { TNATxn, TNATxnSlpDetails } from "../tna";
import { CacheMap } from "../cache";
import { TokenDBObject, TokenBatonStatus, GraphTxnDbo, UtxoDbo, AddressBalancesDbo } from "../interfaces";

const bitbox = new BITBOX();
const slp = new Slp(bitbox);
const txnHelpers = new TransactionHelpers(slp);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const TOKEN_DECIMALS = 9;
const TOKEN_GENESIS_QTY = 1000000;

const rawTxnCache = new CacheMap<string, string>(10000);

// connect to bitcoin regtest network JSON-RPC
const rpcClient = require('bitcoin-rpc-promise-retry');
const connectionStringNode1_miner = 'http://bitcoin:password@0.0.0.0:18443';  // (optional) connect to a miner's rpc on 18444 that is not connected to SLPDB
const rpcNode1_miner = new rpcClient(connectionStringNode1_miner, { maxRetries: 0 });
const connectionStringNode2_miner = 'http://bitcoin:password@0.0.0.0:18444';  // (optional) connect to a miner's rpc on 18444 that is not connected to SLPDB
const rpcNode2_miner = new rpcClient(connectionStringNode2_miner, { maxRetries: 0 });

// setup a new local SLP validator instance
const validator = new LocalValidator(bitbox, async (txids: string[]) => { 
    let txn;
    if (rawTxnCache.has(txids[0])) {
        return [ rawTxnCache.get(txids[0]) as string ];
    }
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
let txid1: string;
let txid2: string;

let lastBlockHash: string;
let lastBlockIndex: number;
let perInputAmount: BigNumber;
let actualInputsCreated: number;
let fiTxid: string;
let privKey: string;
let inputTxnCount: number;

describe("4-Fan-out-Fan-in", () => {

    step("Initial setup for all tests", async () => {

        // generate block to clear the mempool (may be dirty from previous tests)
        lastBlockHash = (await rpcNode1_miner.generate(1))[0];

        // connect miner node to a full node that is connected to slpdb
        try {
            await rpcNode1_miner.addNode("bitcoin1", "onetry");
        } catch(err) { }

        // make sure we have coins to use in tests
        let balance = await rpcNode1_miner.getBalance();
        while (balance < 1) {
            lastBlockHash = (await rpcNode1_miner.generate(1))[0];
            balance = await rpcNode1_miner.getBalance();
        }

        // put all the funds on the receiver's address
        receiverRegtest = await rpcNode1_miner.getNewAddress("0");
        await rpcNode1_miner.sendToAddress(receiverRegtest, 1, "", "", true);
        lastBlockHash = (await rpcNode1_miner.generate(1))[0];

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

        // create a new token
        receiverSlptest = Utils.toSlpAddress(receiverRegtest);
        let genesisTxnHex = txnHelpers.simpleTokenGenesis(
                                                        "unit-test-4", "ut4", 
                                                        new BigNumber(TOKEN_GENESIS_QTY).times(10**TOKEN_DECIMALS), 
                                                        null, null, 
                                                        TOKEN_DECIMALS, receiverSlptest, receiverSlptest, 
                                                        receiverSlptest, txnInputs
                                                        );
        tokenId = await rpcNode1_miner.sendRawTransaction(genesisTxnHex, true);
        lastBlockHash = (await rpcNode1_miner.generate(1))[0];
        lastBlockIndex = (await rpcNode1_miner.getBlock(lastBlockHash, true)).height;
        let lastBlockHash2 = await rpcNode2_miner.getbestblockhash();
        assert.equal(lastBlockHash, lastBlockHash2);

        // disconnect nodes now
        let peerInfo: any[] = await rpcNode1_miner.getPeerInfo();
        await rpcNode1_miner.disconnectNode("bitcoin1");
        while(peerInfo.length > 0) {
            await sleep(100);
            peerInfo = await rpcNode1_miner.getPeerInfo();
        }
        assert.equal(peerInfo.length === 0, true);
    });

    step("FOFI-1: Check the new token has been added", async () => {  // NOTE: This takes longer than normal since we're not waiting for ZMQ msg
        let txn = await db.confirmedFetch(tokenId);
        while (!txn || !txn!.slp || !txn.slp.valid) { // NOTE: This is a problem where the unconfirmed item is first saved without the slp property (but ZMQ should happen only after slp is added)
            await sleep(50);
            txn = await db.confirmedFetch(tokenId);
        }
        let confirmed = await db.db.collection("confirmed").find({ "tx.h": tokenId }).toArray();
        assert.equal(txn!.slp!.valid, true);
        assert.equal(txn!.slp!.detail!.name, "unit-test-4");
        assert.equal(txn!.slp!.detail!.symbol, "ut4");     
        assert.equal(txn!.slp!.detail!.tokenIdHex, txn!.tx.h);
        assert.equal(confirmed.length, 1);

        // make sure it is not in unconfirmed
        let txn_u = await db.unconfirmedFetch(tokenId);
        assert.equal(txn_u, null);
    });

    step("FOFI-1: Process transaction inputs", async () => {
        let inputCount = 100;
        let outputCount = 18;
        inputTxnCount = Math.ceil(inputCount / outputCount);
        actualInputsCreated = inputTxnCount * outputCount;
        perInputAmount = (new BigNumber(TOKEN_GENESIS_QTY)).div(actualInputsCreated).decimalPlaces(0, BigNumber.ROUND_FLOOR);
        if (!perInputAmount.modulo(1).isEqualTo(0)) {
            throw Error("Cannot have output less than 1.")
        }
        if (perInputAmount.times(10**TOKEN_DECIMALS).lt(1/10**TOKEN_DECIMALS)) {
            throw Error("Fan out receiver amount is too small.");
        }

        console.log(perInputAmount.times(actualInputsCreated).toFixed());
        console.log(TOKEN_GENESIS_QTY);
        if (perInputAmount.times(actualInputsCreated).gt(TOKEN_GENESIS_QTY)) {
            throw Error("Cannot have more inputs than available token.");
        }

        for (let i = 0; i < inputTxnCount; i++) {
            if(i > 0 && i % 25 === 0) {
                await rpcNode1_miner.generate(1); // prevent 25 txn chain restriction
            }
            // get current address UTXOs
            let unspent = await rpcNode1_miner.listUnspent(0);
            unspent = unspent.filter((txo: any) => txo.address === receiverRegtest);
            if (unspent.length === 0) throw Error("No unspent outputs.");
            unspent.map((txo: any) => txo.cashAddress = txo.address);
            unspent.map((txo: any) => txo.satoshis = txo.amount*10**8);

            await Promise.all(unspent.map(async (txo: any) => { 
                if(!privKey) {
                    privKey = await rpcNode1_miner.dumpPrivKey(txo.address)
                }
                txo.wif = privKey;
            }));

            // process raw UTXOs
            let utxos = await slp.processUtxosForSlpAbstract(unspent, validator);
            let tokenUtxos = utxos.slpTokenUtxos[tokenId].sort((a, b) => { return b.slpUtxoJudgementAmount.comparedTo(a.slpUtxoJudgementAmount) })

            // select the largest available token input as the input to the transaction
            txnInputs = [ tokenUtxos[0], ...utxos.nonSlpUtxos, ];
            console.log(`Preparing ${outputCount} outputs with transaction #${i}.`);
            // console.log(tokenUtxos.length);
            // console.log(tokenUtxos[0].slpUtxoJudgementAmount.toFixed());
            // if(i>1) {
            //     console.log(tokenUtxos[1].slpUtxoJudgementAmount.toFixed());
            //     console.log(tokenUtxos[tokenUtxos.length-1].slpUtxoJudgementAmount.toFixed());
            // }

            assert.equal(txnInputs.length > 1, true);

            let txnHex = txnHelpers.simpleTokenSend(tokenId, 
                                                    Array(18).fill(new BigNumber(perInputAmount).times(10**TOKEN_DECIMALS)),
                                                    txnInputs, 
                                                    Array(18).fill(receiverSlptest), 
                                                    receiverSlptest
                                                    );

            let txid = await rpcNode1_miner.sendRawTransaction(txnHex, true);
            rawTxnCache.set(txid, txnHex);
        }

        lastBlockHash = (await rpcNode1_miner.generate(1))[0]; // prevent 25 txn chain restriction
        while(slpdbBlockNotifications.filter(b => b.hash === lastBlockHash).length === 0) {
            await sleep(50);
        }
        lastBlockIndex = (await rpcNode1_miner.getBlock(lastBlockHash, true)).height;
    });

    step("FOFI-1: Make/Sign inputs for Fan-In transaction", async () => {
        slpdbTxnNotifications = [];
        slpdbBlockNotifications = [];

        // get current address UTXOs
        let unspent = await rpcNode1_miner.listUnspent(0);
        unspent = unspent.filter((txo: any) => txo.address === receiverRegtest);
        if (unspent.length === 0) throw Error("No unspent outputs.");
        unspent.map((txo: any) => txo.cashAddress = txo.address);
        unspent.map((txo: any) => txo.satoshis = txo.amount*10**8);
        await Promise.all(unspent.map(async (txo: any) => {
            if(!privKey) {
                privKey = await rpcNode1_miner.dumpPrivKey(txo.address);
            }
            txo.wif = privKey; 
        }));
        let utxos = await slp.processUtxosForSlpAbstract(unspent, validator);
        let tokenUtxos = utxos.slpTokenUtxos[tokenId].sort((a, b) => { return a.slpUtxoJudgementAmount.comparedTo(b.slpUtxoJudgementAmount) })

        // select the largest available token input as the input to the transaction
        txnInputs = [ ...tokenUtxos.slice(0, actualInputsCreated+1), ...utxos.nonSlpUtxos, ]; // +1 handles the SLP change

        assert.equal(txnInputs.length, actualInputsCreated+2);  // +1 for SLP change, +1 for nonSlpUtxo
        console.log(`Please wait, signing ${txnInputs.length} inputs in fan-in transaction.`);

        let txnHex = txnHelpers.simpleTokenSend(tokenId, 
                                                Array(18).fill(new BigNumber(perInputAmount.times(actualInputsCreated))),
                                                txnInputs, 
                                                Array(18).fill(receiverSlptest), 
                                                receiverSlptest
                                                );

        fiTxid = await rpcNode1_miner.sendRawTransaction(txnHex, true);
    });

    step("FOFI-1: Received ZMQ notification for fan-in transaction", async () => {
        while(slpdbTxnNotifications.filter(t => t!.tx.h === fiTxid).length === 0) {
            await sleep(50);
        }

        let txnNotification = slpdbTxnNotifications.filter(t => t!.tx.h === fiTxid)[0];

        // check that SLPDB made proper outgoing ZMQ messages for 
        assert.equal(txnNotification.slp!.valid, true);
        assert.equal(txnNotification.slp!.detail!.name, "unit-test-4");
        assert.equal(txnNotification.slp!.detail!.symbol, "ut4");
        assert.equal(txnNotification.slp!.detail!.tokenIdHex, tokenId);
        assert.equal(txnNotification.slp!.detail!.outputs![0].address, receiverSlptest);
        assert.equal(txnNotification.slp!.detail!.transactionType, SlpTransactionType.SEND);
        for(let i = 0; i < 18; i++) {
            // @ts-ignore
            assert.equal(txnNotification.slp!.detail!.outputs![i].amount!["$numberDecimal"], new BigNumber(perInputAmount.times(actualInputsCreated)).dividedBy(10**TOKEN_DECIMALS).toFixed());
        }
        assert.equal(txnNotification.blk, null);
        assert.equal(typeof txnNotification.in, "object");
        assert.equal(typeof txnNotification.out, "object");
        assert.equal(typeof txnNotification.tx, "object");
        assert.equal(txnNotification.tx!.h, fiTxid);
    });

    step("FOFI-1: Check that fan-in transaction is in unconfirmed (before block)", async () => {
        let txn = await db.unconfirmedFetch(fiTxid);
        let unconfirmed = await db.db.collection("unconfirmed").find({}).toArray();
        assert.equal(txn!.slp!.valid, true);
        assert.equal(txn!.slp!.detail!.name, "unit-test-4");
        assert.equal(txn!.slp!.detail!.symbol, "ut4");
        for(let i = 0; i < 18; i++) {
            // @ts-ignore
            assert.equal(txn!.slp!.detail!.outputs![i].amount!.toString(), new BigNumber(perInputAmount.times(actualInputsCreated)).dividedBy(10**TOKEN_DECIMALS).toFixed());
        }
        assert.equal(txn!.slp!.detail!.tokenIdHex, tokenId);
        assert.equal(unconfirmed.length>0, true);
    });

    step("FOFI-1: Check that tokens collection is accurate (before block)", async () => {
        let t: TokenDBObject | null = await db.tokenFetch(tokenId);
        assert.equal(t!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(t!.mintBatonUtxo, tokenId + ":2");
        assert.equal(t!.tokenStats!.block_created! > 0, true);
        assert.equal(t!.tokenStats!.block_last_active_mint, null);
        assert.equal(t!.tokenStats!.block_last_active_send, lastBlockIndex);
        assert.equal(t!.tokenStats!.qty_token_burned.toString(), "0");
        assert.equal(t!.tokenStats!.qty_token_circulating_supply.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.qty_token_minted.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.minting_baton_status, TokenBatonStatus.ALIVE);
        assert.equal(t!.tokenStats.qty_valid_txns_since_genesis, inputTxnCount+1);
    });

    step("FOFI-1: Check that fan-in transaction is in graphs (before block)", async () => {
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": fiTxid });
        while(!g || !g.graphTxn) {
            await sleep(50);
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": fiTxid });
        }
        assert.equal(g!.graphTxn.txid, fiTxid);
        assert.equal(g!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(g!.graphTxn.blockHash, null);

        // TODO: Check unspent outputs.

        // TODO: Check... for genesis
        // "spendTxid": "7a19684d7eca289ff34faae06a3de7117852e445adb9bf147a5cbd3e420c5f05",
        // "status": "SPENT_SAME_TOKEN",
        // "invalidReason": null
    });

    step("FOFI-1: Check that fan-in transaction is in utxos (before block)", async () => {
        let x: UtxoDbo[] = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(x.length !== 19) {
            await sleep(50);
            x = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(x.length, 19);
        assert.equal(x[0].address, receiverSlptest);
        assert.equal(x[0].bchSatoshis, 546);
        
        // @ts-ignore
        //assert.equal(amounts.includes(x[0].slpAmount.toString()), true);
        
        // remove item and check the next amount
        //amounts = amounts.filter(a => a !== x[0].slpAmount.toString());

        assert.equal(x[1].address, receiverSlptest);
        assert.equal(x[1].bchSatoshis, 546);

        // @ts-ignore
        //assert.equal(amounts.includes(x[1].slpAmount.toString()), true);
    });

    step("FOFI-1: Check that fan-in transaction is in addresses (before block)", async () => {
        let a: AddressBalancesDbo[] = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(a.length === 0) {
            await sleep(50);
            a = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(a.length, 1);
        assert.equal(a[0].address, receiverSlptest);
        assert.equal(a[0].satoshis_balance, 19*546);
        // @ts-ignore
        assert.equal(a[0].token_balance.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("FOFI-1: Received ZMQ notification for block with fan-in transaction", async () => {
        lastBlockHash = (await rpcNode1_miner.generate(1))[0];
        while(slpdbBlockNotifications.length === 0) {
            await sleep(50);
        }

        let fiTxn = slpdbBlockNotifications[0].txns.filter(t => t!.txid === fiTxid)[0];

        lastBlockIndex = (await rpcNode1_miner.getBlock(lastBlockHash, true)).height;
        assert.equal(slpdbBlockNotifications.length, 1);
        assert.equal(slpdbBlockNotifications[0].txns.length > 0, true);
        assert.equal(fiTxn.txid, fiTxid);
        assert.equal(fiTxn.slp.detail!.tokenIdHex, tokenId);
        assert.equal(fiTxn.slp.detail!.name, "unit-test-4");
        assert.equal(fiTxn.slp.detail!.symbol, "ut4");
        for(let i = 0; i < 18; i++) {
            // @ts-ignore
            assert.equal(fiTxn!.slp!.detail!.outputs![i].amount!.toString(), new BigNumber(perInputAmount.times(actualInputsCreated)).dividedBy(10**TOKEN_DECIMALS).toFixed());
        }
        // TODO: There is not block hash with block zmq notification!
        // assert.equal(typeof slpdbBlockNotifications[0]!.hash, "string");
        // assert.equal(slpdbBlockNotifications[0]!.hash.length, 64);
    });

    step("FOFI-1: Check that fan-in transaction is in confirmed (after block)", async () => {
        let txn = await db.confirmedFetch(fiTxid);
        let confirmed = await db.db.collection("confirmed").find({}).toArray();
        while(!txn || !txn.slp) {
            await sleep(50);
            txn = await db.confirmedFetch(fiTxid);
            confirmed = await db.db.collection("confirmed").find({}).toArray();
        }
        assert.equal(txn!.slp!.valid, true);
        assert.equal(txn!.slp!.detail!.name, "unit-test-4");
        assert.equal(txn!.slp!.detail!.symbol, "ut4");
        for(let i = 0; i < 18; i++) {
            // @ts-ignore
            assert.equal(txn!.slp!.detail!.outputs![i].amount!.toString(), new BigNumber(perInputAmount.times(actualInputsCreated)).dividedBy(10**TOKEN_DECIMALS).toFixed());
        }
        assert.equal(txn!.slp!.detail!.tokenIdHex, tokenId);
        assert.equal(confirmed.length>0, true);
    });

    step("FOFI-1: Check that fan-in transaction is NOT in unconfirmed (after block)", async () => {
        let txn = await db.unconfirmedFetch(fiTxid);
        let unconfirmed = await db.db.collection("unconfirmed").find({}).toArray();
        assert.equal(txn, null);
        assert.equal(unconfirmed.length===0, true);
    });

    step("FOFI-1: Check that tokens collection is accurate (after block)", async () => {
        let t: TokenDBObject | null = await db.tokenFetch(tokenId);
        while(t!.tokenStats.block_last_active_send !== lastBlockIndex) {
            await sleep(50);
            t = await db.tokenFetch(tokenId);
        }
        assert.equal(t!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(t!.mintBatonUtxo, tokenId + ":2");
        assert.equal(t!.tokenStats!.block_created! > 0, true);
        assert.equal(t!.tokenStats!.block_last_active_mint, null);
        assert.equal(t!.tokenStats!.block_last_active_send, lastBlockIndex);
        assert.equal(t!.tokenStats!.qty_token_burned.toString(), "0");
        assert.equal(t!.tokenStats!.qty_token_circulating_supply.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.qty_token_minted.toString(), TOKEN_GENESIS_QTY.toFixed());
        assert.equal(t!.tokenStats!.minting_baton_status, TokenBatonStatus.ALIVE);
    });

    step("FOFI-1: Check that fan-in transaction is in graphs (after block)", async () => {
        let g: GraphTxnDbo | null = await db.db.collection("graphs").findOne({ "graphTxn.txid": fiTxid });
        while(!g || g!.graphTxn.blockHash === null) {
            await sleep(50);
            g = await db.db.collection("graphs").findOne({ "graphTxn.txid": fiTxid });
        }
        assert.equal(g!.graphTxn.txid, fiTxid);
        assert.equal(g!.tokenDetails.tokenIdHex, tokenId);
        assert.equal(g!.graphTxn.blockHash.toString('hex'), lastBlockHash);

        // TODO: Check unspent outputs.

        // TODO: Check... for genesis
        // "spendTxid": "7a19684d7eca289ff34faae06a3de7117852e445adb9bf147a5cbd3e420c5f05",
        // "status": "SPENT_SAME_TOKEN",
        // "invalidReason": null
    });

    step("FOFI-1: Check that fan-in transaction is in utxos (after block)", async () => {
       let x: UtxoDbo[] = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(x.length !== 19) {
            await sleep(50);
            x = await db.db.collection("utxos").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(x.length, 19);
        assert.equal(x[0].address, receiverSlptest);
        assert.equal(x[0].bchSatoshis, 546);
        
        // @ts-ignore
        //assert.equal(amounts.includes(x[0].slpAmount.toString()), true);
        
        // remove item and check the next amount
        //amounts = amounts.filter(a => a !== x[0].slpAmount.toString());

        assert.equal(x[1].address, receiverSlptest);
        assert.equal(x[1].bchSatoshis, 546);
        
        // @ts-ignore
        //assert.equal(amounts.includes(x[1].slpAmount.toString()), true);
    });

    step("FOFI-1: Check that fan-in transaction is in addresses (after block)", async () => {
        let a: AddressBalancesDbo[] = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        while(a.length === 0) {
            await sleep(50);
            a = await db.db.collection("addresses").find({ "tokenDetails.tokenIdHex": tokenId }).toArray();
        }
        assert.equal(a.length, 1);
        assert.equal(a[0].address, receiverSlptest);
        assert.equal(a[0].satoshis_balance, 19*546);
        // @ts-ignore
        assert.equal(a[0].token_balance.toString(), TOKEN_GENESIS_QTY.toFixed());
    });

    step("Clean up", async () => {
        // generate block to clear the mempool (may be dirty from previous tests)
        await rpcNode1_miner.generate(1);
        sock.disconnect('tcp://0.0.0.0:27339');
    });
});
