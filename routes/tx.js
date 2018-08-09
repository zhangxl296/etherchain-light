var express = require('express');
var router = express.Router();

var async = require('async');
var Web3 = require('web3');
var abi = require('ethereumjs-abi');
var abiDecoder = require('abi-decoder');

router.get('/pending', function (req, res, next) {

    var config = req.app.get('config');
    var web3 = new Web3();
    web3.setProvider(config.provider);

    async.waterfall([
        function (callback) {
            web3.parity.pendingTransactions(function (err, result) {
                callback(err, result);
            });
        }
    ], function (err, txs) {
        if (err) {
            return next(err);
        }

        res.render('tx_pending', {
            txs: txs
        });
    });
});


router.get('/submit', function (req, res, next) {
    res.render('tx_submit', {});
});

router.post('/submit', function (req, res, next) {
    if (!req.body.txHex) {
        return res.render('tx_submit', {
            message: "No transaction data specified"
        });
    }

    var config = req.app.get('config');
    var web3 = new Web3();
    web3.setProvider(config.provider);

    async.waterfall([
        function (callback) {
            web3.eth.sendRawTransaction(req.body.txHex, function (err, result) {
                callback(err, result);
            });
        }
    ], function (err, hash) {
        if (err) {
            res.render('tx_submit', {
                message: "Error submitting transaction: " + err
            });
        } else {
            res.render('tx_submit', {
                message: "Transaction submitted. Hash: " + hash
            });
        }
    });
});

router.get('/:tx', function (req, res, next) {

    if (typeof String.prototype.endsWith != 'function') {
        String.prototype.endsWith = function (suffix) {
            return this.indexOf(suffix, this.length - suffix.length) !== -1;
        };
    }

    var config = req.app.get('config');
    var web3 = new Web3();
    web3.setProvider(config.provider);

    var db = req.app.get('db');

    async.waterfall([
        function (callback) {
            web3.eth.getTransaction(req.params.tx, function (err, result) {
                callback(err, result);
            });
        },
        function (result, callback) {

            if (!result || !result.hash) {
                return callback({
                    message: "Transaction hash not found"
                }, null);
            }

            web3.eth.getTransactionReceipt(result.hash, function (err, receipt) {
                callback(err, result, receipt);
            });
        },
        function (tx, receipt, callback) {
            web3.trace.transaction(tx.hash, function (err, traces) {
                callback(err, tx, receipt, traces);
            });
        },
        function (tx, receipt, traces, callback) {
            db.get(tx.to, function (err, value) {
                callback(null, tx, receipt, traces, value);
            });
        }
    ], function (err, tx, receipt, traces, source) {
        if (err) {
            return next(err);
        }

        // Try to match the tx to a solidity function call if the contract source is available
        if (source) {
            tx.source = JSON.parse(source);
            try {
                var jsonAbi = JSON.parse(tx.source.abi);
                abiDecoder.addABI(jsonAbi);
                tx.logs = abiDecoder.decodeLogs(receipt.logs);
                tx.callInfo = abiDecoder.decodeMethod(tx.input);
            } catch (e) {
                console.log("Error parsing ABI:", tx.source.abi, e);
            }
        } else {
            config.initWeb3ContractInfo();
            try {
                var from = tx.from.toLowerCase();
                var to = tx.to ? tx.to.toLowerCase() : '';

                var jsonAbiArray = config.abis[tx.to];
                for (const key in jsonAbiArray) {
                    const jsonAbi = jsonAbiArray[key];
                    abiDecoder.addABI(jsonAbi);
                    var callInfo;
                    if (callInfo = abiDecoder.decodeMethod(tx.input)) {
                        tx.from = config.addr2Name.hasOwnProperty(from) ? config.addr2Name[from] : from;
                        tx.to = config.addr2Name.hasOwnProperty(to) ? config.addr2Name[to] : to;
                        tx.callInfo = callInfo
                        abiDecoder.removeABI(jsonAbi);
                        break;
                    }
                    abiDecoder.removeABI(jsonAbi);
                }
            } catch (e) {
                console.log("Error parsing ABI:", e);
            }

            try {
                tx.logs = [];
                if (receipt.logs) {
                    for (const key in receipt.logs) {
                        const log = receipt.logs[key];

                        var to = log.address ? log.address.toLowerCase() : '';

                        var jsonAbiArray = config.abis[to];
                        for (const key in jsonAbiArray) {
                            const jsonAbi = jsonAbiArray[key];
                            abiDecoder.addABI(jsonAbi);

                            var decodeLog = abiDecoder.decodeLogs([log]);
                            if (decodeLog.length > 0) {
                                var tmp = decodeLog[0];
                                if (tmp) {
                                    tmp.decoded = {
                                        contract: config.addr2Name.hasOwnProperty(to) ? config.addr2Name[to] : to,
                                        event: tmp.name,
                                        result: {
                                            transactionHash: tx.hash,
                                            args: {}
                                        }
                                    };
                                    tmp.events.forEach(e => {
                                        if (e.type == "uint256" || e.type == "uint8" || e.type == "int") {
                                            tmp.decoded.result.args[e.name] = e.value;// new Web3().toBigNumber(e.value).toString(10);
                                        } else {
                                            tmp.decoded.result.args[e.name] = e.value;
                                        }
                                    });
                                    tx.logs.push(tmp);
                                    abiDecoder.removeABI(jsonAbi);
                                    break;
                                }
                            };
                            abiDecoder.removeABI(jsonAbi);
                        }
                    }
                }
            } catch (e) {
                console.log("Error parsing ABI:", e);
            }
        }

        tx.triggerEventBaseUrl = config.triggerEventBaseUrl;

        tx.traces = [];
        tx.failed = false;
        tx.gasUsed = 0;

        if (traces != null) {
            traces.forEach(function (trace) {
                tx.traces.push(trace);
                if (trace.error) {
                    tx.failed = true;
                    tx.error = trace.error;
                }
                if (trace.result && trace.result.gasUsed && tx.gasUsed == 0) {
                    tx.gasUsed += parseInt(trace.result.gasUsed, 16);
                }
            });
        }
        // console.log(tx.traces);    
        res.render('tx', {
            tx: tx
        });
    });

});

router.get('/raw/:tx', function (req, res, next) {

    var config = req.app.get('config');
    var web3 = new Web3();
    web3.setProvider(config.provider);

    async.waterfall([
        function (callback) {
            web3.eth.getTransaction(req.params.tx, function (err, result) {
                callback(err, result);
            });
        },
        function (result, callback) {
            if(result){
                web3.trace.replayTransaction(result.hash, ["trace", "stateDiff", "vmTrace"], function (err, traces) {
                    callback(err, result, traces);
                });
            }else{
                callback('tx not exist');
            }
        }
    ], function (err, tx, traces) {
        if (err) {
            return next(err);
        }

        config.initWeb3ContractInfo();

        for (const key in traces.trace) {
            let ele = traces.trace[key];

            let action = ele.action;

            try {
                var callInfo = {};

                var from = action.from.toLowerCase();
                var to = action.to ? action.to.toLowerCase() : '';

                callInfo.from = config.addr2Name.hasOwnProperty(from) ? config.addr2Name[from] : from;
                callInfo.to = config.addr2Name.hasOwnProperty(to) ? config.addr2Name[to] : to;
                if (action.value) {
                    var InWei = parseInt(action.value);
                    var eth = InWei / Math.pow(10, 18);
                    callInfo.value = InWei + " wei, " + eth + " ether";
                }
                if (action.gas) {
                    callInfo.gas = parseInt(action.gas)
                }

                var jsonAbiArray = config.abis[to];

                for (const key in jsonAbiArray) {
                    const jsonAbi = jsonAbiArray[key];
                    abiDecoder.addABI(jsonAbi);

                    var decodedCallInfo;
                    if (decodedCallInfo = abiDecoder.decodeMethod(action.input)) {
                        callInfo.function = callInfo.from + "->" + callInfo.to + '.' + decodedCallInfo.name;
                        var pStr = '( ';
                        decodedCallInfo.params.forEach(p => {
                            pStr += (typeof p.value === 'object') ? JSON.stringify(p.value) : p.value + ',';
                        });
                        pStr = pStr.substr(0, pStr.length - 1);
                        pStr += ")"
                        callInfo.function += pStr;
                        callInfo.params = decodedCallInfo.params;

                        if (ele.result) {
                            var outinfo;
                            if (outinfo = abiDecoder.decodeOutput(action.input, ele.result.output)) {
                                var opStr = '( ';
                                outinfo.params.forEach(p => {
                                    opStr += p.value + ',';
                                });
                                opStr = opStr.substr(0, opStr.length - 1);
                                opStr += ")"
                                callInfo.function += " = " + opStr;
                            }
                        }

                        abiDecoder.removeABI(jsonAbi);
                        break;
                    }
                    abiDecoder.removeABI(jsonAbi);
                }

                action = {
                    original: action,
                    decoded: callInfo
                };
            } catch (e) {
                console.log("Error parsing ABI:", action.to, e);
            }

            traces.trace[key].action = action;
        }

        tx.traces = traces;

        res.render('tx_raw', {
            tx: tx
        });
    });
});

module.exports = router;