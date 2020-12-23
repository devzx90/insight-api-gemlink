var async = require('async');

/**
 *
 * @param {Object} opts
 * @param {Object} opts.node

 * @constructor
 */
function TransactionService(opts) {
    this.node = opts.node;
}

/**
 *
 * @param {String} txid
 * @param {Function} callback
 * @return {*}
 */
TransactionService.prototype.getDetailedTransaction = function(txid, callback) {

    var self = this;
    var tx = null;
    return async.waterfall([function(callback) {

        return self.node.getDetailedTransaction(txid, function(err, transaction) {
            return callback(err, transaction);
        });

    }], function(err, transaction) {
        return callback(err, transaction);
    });

};


module.exports = TransactionService;
