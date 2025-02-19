'use strict';

var async = require('async');
var bitcore = require('bitcore-lib-gemlink');
var _ = bitcore.deps._;
var pools = require('../pools.json');
var BN = bitcore.crypto.BN;
var LRU = require('lru-cache');
var Common = require('./common');

function BlockController(options) {
  var self = this;
  this.node = options.node;
  this.transactionService = options.transactionService;

  this.blockSummaryCache = LRU(options.blockSummaryCacheSize || BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE);
  this.blockCacheConfirmations = 6;
  this.blockCache = LRU(options.blockCacheSize || BlockController.DEFAULT_BLOCK_CACHE_SIZE);

  this.poolStrings = {};
  pools.forEach(function (pool) {
    pool.searchStrings.forEach(function (s) {
      self.poolStrings[s] = {
        poolName: pool.poolName,
        url: pool.url
      };
    });
  });

  this.common = new Common({ log: this.node.log });
}

var BLOCK_LIMIT = 200;

BlockController.DEFAULT_BLOCKSUMMARY_CACHE_SIZE = 1000000;
BlockController.DEFAULT_BLOCK_CACHE_SIZE = 1000;

function isHexadecimal(hash) {
  if (!_.isString(hash)) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(hash);
}

BlockController.prototype.checkBlockHash = function (req, res, next) {
  var self = this;
  var hash = req.params.blockHash;
  if (hash.length < 64 || !isHexadecimal(hash)) {
    return self.common.handleErrors(null, res);
  }
  next();
};

/**
 * Find block by hash ...
 */
BlockController.prototype.block = function (req, res, next) {
  var self = this;
  var hash = req.params.blockHash;
  var blockCached = self.blockCache.get(hash);

  if (blockCached) {
    blockCached.confirmations = self.node.services.bitcoind.height - blockCached.height + 1;
    req.block = blockCached;
    next();
  } else {
    self.node.getBlock(hash, function (err, block) {
      if ((err && err.code === -5) || (err && err.code === -8)) {
        return self.common.handleErrors(null, res);
      } else if (err) {
        return self.common.handleErrors(err, res);
      }
      self.node.services.bitcoind.getBlockHeader(hash, function (err, info) {
        if (err) {
          return self.common.handleErrors(err, res);
        }
        var txHash = block.transactions[0].hash;
        self.transactionService.getDetailedTransaction(txHash, function (err, trx) {
          var blockResult = self.transformBlock(block, info, trx);
          if (blockResult.confirmations >= self.blockCacheConfirmations) {
            self.blockCache.set(hash, blockResult);
          }
          req.block = blockResult;
          next();
        });

      });
    });
  }
};

/**
 * Find rawblock by hash and height...
 */
BlockController.prototype.rawBlock = function (req, res, next) {
  var self = this;
  var blockHash = req.params.blockHash;

  self.node.getRawBlock(blockHash, function (err, blockBuffer) {
    if ((err && err.code === -5) || (err && err.code === -8)) {
      return self.common.handleErrors(null, res);
    } else if (err) {
      return self.common.handleErrors(err, res);
    }
    req.rawBlock = {
      rawblock: blockBuffer.toString('hex')
    };
    next();
  });

};

BlockController.prototype._normalizePrevHash = function (hash) {
  // TODO fix bitcore to give back null instead of null hash
  if (hash !== '0000000000000000000000000000000000000000000000000000000000000000') {
    return hash;
  } else {
    return null;
  }
};

BlockController.prototype.transformBlock = function (block, info, transaction) {
  var blockObj = block.toObject();
  var transactionIds = blockObj.transactions.map(function (tx) {
    return tx.hash;
  });

  var poolAddress;
  var lastBiggestNumber = 0;
  if (transaction) {
    var reward = this.getBlockReward(info.height);
    transaction.outputs.forEach(function (output) {
      if (output.satoshis !== reward * 0.5) {
        if (output.satoshis > lastBiggestNumber) {
          lastBiggestNumber = output.satoshis;
          poolAddress = output.address;
        }
      }
    });
  }

  return {
    hash: block.hash,
    size: block.toBuffer().length,
    height: info.height,
    version: blockObj.header.version,
    merkleroot: blockObj.header.merkleRoot,
    tx: transactionIds,
    time: blockObj.header.time,
    nonce: blockObj.header.nonce,
    solution: blockObj.header.solution,
    bits: blockObj.header.bits.toString(16),
    difficulty: block.header.getDifficulty(),
    chainwork: info.chainWork,
    confirmations: info.confirmations,
    previousblockhash: this._normalizePrevHash(blockObj.header.prevHash),
    nextblockhash: info.nextHash,
    reward: this.getBlockReward(info.height) / 1e8,
    minedBy: poolAddress,
    isMainChain: (info.confirmations !== -1),
    poolInfo: this.getPoolInfo(block)
  };
};

/**
 * Show block
 */
BlockController.prototype.show = function (req, res) {
  if (req.block) {
    res.jsonp(req.block);
  }
};

BlockController.prototype.showRaw = function (req, res) {
  if (req.rawBlock) {
    res.jsonp(req.rawBlock);
  }
};

BlockController.prototype.blockIndex = function (req, res) {
  var self = this;
  var height = req.params.height;
  this.node.services.bitcoind.getBlockHeader(parseInt(height), function (err, info) {
    if (err) {
      return self.common.handleErrors(err, res);
    }
    res.jsonp({
      blockHash: info.hash
    });
  });
};

BlockController.prototype._getBlockSummary = function (hash, moreTimestamp, next) {
  var self = this;

  function finish(result) {
    if (moreTimestamp > result.time) {
      moreTimestamp = result.time;
    }
    return next(null, result);
  }

  var summaryCache = self.blockSummaryCache.get(hash);

  if (summaryCache) {
    finish(summaryCache);
  } else {
    self.node.services.bitcoind.getRawBlock(hash, function (err, blockBuffer) {
      if (err) {
        return next(err);
      }

      var br = new bitcore.encoding.BufferReader(blockBuffer);

      // take a shortcut to get number of transactions and the blocksize.
      // Also reads the coinbase transaction and only that.
      // Old code parsed all transactions in every block _and_ then encoded
      // them all back together to get the binary size of the block.
      // FIXME: This code might still read the whole block. Fixing that
      // would require changes in bitcore-node.
      var header = bitcore.BlockHeader.fromBufferReader(br);
      var info = {};
      var txlength = br.readVarintNum();
      info.transactions = [bitcore.Transaction().fromBufferReader(br)];

      return self.node.services.bitcoind.client.getBlock(hash, function (err, response) {
        var txHash = response.result.tx[0];
        return self.transactionService.getDetailedTransaction(txHash, function (err, trx) {
          self.node.services.bitcoind.getBlockHeader(hash, function (err, blockHeader) {
            if (err) {
              return next(err);
            }
            var height = blockHeader.height;

            var reward = self.getBlockReward(height);
            var lastBiggestNumber = 0;
            var poolAddress;
            trx.outputs.forEach(function (output) {
              if (output.satoshis !== reward * 0.5) {
                if (output.satoshis > lastBiggestNumber) {
                  lastBiggestNumber = output.satoshis;
                  poolAddress = output.address;
                }
              }
            });

            var summary = {
              height: height,
              size: blockBuffer.length,
              hash: hash,
              time: header.time,
              txlength: txlength,
              poolInfo: self.getPoolInfo(info)
            };
            summary.minedBy = poolAddress;
            var confirmations = self.node.services.bitcoind.height - height + 1;
            if (confirmations >= self.blockCacheConfirmations) {
              self.blockSummaryCache.set(hash, summary);
            }

            finish(summary);
          });
        });
      });
    })

  }
};

// List blocks by date
BlockController.prototype.list = function (req, res) {
  var self = this;

  var dateStr;
  var todayStr = this.formatTimestamp(new Date());
  var isToday;

  if (req.query.blockDate) {
    dateStr = req.query.blockDate;
    var datePattern = /\d{4}-\d{2}-\d{2}/;
    if (!datePattern.test(dateStr)) {
      return self.common.handleErrors(new Error('Please use yyyy-mm-dd format'), res);
    }

    isToday = dateStr === todayStr;
  } else {
    dateStr = todayStr;
    isToday = true;
  }

  var gte = Math.round((new Date(dateStr)).getTime() / 1000);

  //pagination
  var lte = parseInt(req.query.startTimestamp) || gte + 86400;
  var prev = this.formatTimestamp(new Date((gte - 86400) * 1000));
  var next = lte ? this.formatTimestamp(new Date(lte * 1000)) : null;
  var limit = parseInt(req.query.limit || BLOCK_LIMIT);
  var more = false;
  var moreTimestamp = lte;

  self.node.services.bitcoind.getBlockHashesByTimestamp(lte, gte, function (err, hashes) {
    if (err) {
      return self.common.handleErrors(err, res);
    }

    hashes.reverse();

    if (hashes.length > limit) {
      more = true;
      hashes = hashes.slice(0, limit);
    }

    async.mapSeries(
      hashes,
      function (hash, next) {
        self._getBlockSummary(hash, moreTimestamp, next);
      },
      function (err, blocks) {
        if (err) {
          return self.common.handleErrors(err, res);
        }

        blocks.sort(function (a, b) {
          return b.height - a.height;
        });

        var data = {
          blocks: blocks,
          length: blocks.length,
          pagination: {
            next: next,
            prev: prev,
            currentTs: lte - 1,
            current: dateStr,
            isToday: isToday,
            more: more
          }
        };

        if (more) {
          data.pagination.moreTs = moreTimestamp;
        }

        res.jsonp(data);
      }
    );
  });
};

BlockController.prototype.getPoolInfo = function (block) {
  var coinbaseBuffer = block.transactions[0].inputs[0]._scriptBuffer;
  // console.log(coinbaseBuffer.toString('utf-8'))
  for (var k in this.poolStrings) {
    if (coinbaseBuffer.toString('utf-8').match(k)) {
      return this.poolStrings[k];
    }
  }

  return {};
};

//helper to convert timestamps to yyyy-mm-dd format
BlockController.prototype.formatTimestamp = function (date) {
  var yyyy = date.getUTCFullYear().toString();
  var mm = (date.getUTCMonth() + 1).toString(); // getMonth() is zero-based
  var dd = date.getUTCDate().toString();

  return yyyy + '-' + (mm[1] ? mm : '0' + mm[0]) + '-' + (dd[1] ? dd : '0' + dd[0]); //padding
};

BlockController.prototype.getBlockReward = function (height) {
  var subsidy = new BN(20 * 1e8);

  // Mining slow start
  // The subsidy is ramped up linearly, skipping the middle payout of
  // MAX_SUBSIDY/2 to keep the monetary curve consistent with no slow start.
  if (height < (4000 / 2)) {
    subsidy /= 4000;
    subsidy *= height;
    return subsidy;
  } else if (height < 4000) {
    subsidy /= 4000;
    subsidy *= (height + 1);
    return subsidy;
  }

  var halvings = Math.floor((height - (4000 / 2)) / 2102400);
  // Force block reward to zero when right shift is undefined.
  if (halvings >= 64) {
    return 0;
  }

  // Subsidy is cut in half every 840,000 blocks which will occur approximately every 4 years.
  subsidy = subsidy.shrn(halvings);

  return parseInt(subsidy.toString(10));
};

module.exports = BlockController;
