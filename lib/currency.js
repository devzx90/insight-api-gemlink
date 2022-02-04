'use strict';

var request = require('request');

function CurrencyController(options) {
  this.node = options.node;
  var refresh = options.currencyRefresh || CurrencyController.DEFAULT_CURRENCY_DELAY;
  this.currencyDelay = refresh * 60000;
  this.bitstampRate = 0; // USD/BTC
  this.stexRate = 0; // BTC/Gemlink
  this.timestamp = Date.now();
}

CurrencyController.DEFAULT_CURRENCY_DELAY = 10;

CurrencyController.prototype.index = function(req, res) {
  var self = this;
  var unit = 'USD';
  var currentTime = Date.now();
  if (self.bitstampRate === 0 || currentTime >= (self.timestamp + self.currencyDelay)) {
    self.timestamp = currentTime;
    request('https://blockchain.info/ticker', function(err, response, body) {
      if (err) {
        self.node.log.error(err);
      }
      if (!err && response.statusCode === 200) {
        self.bitstampRate = JSON.parse(body);
      }
      request('https://api3.stex.com/public/ticker/250', function(err, response, body) {
        if (err) {
          self.node.log.error(err);
        }
        if (!err && response.statusCode === 200) {
          if (parseFloat(JSON.parse(body).data.last) != null) {
            self.stexRate = parseFloat(JSON.parse(body).data.last);
          }
        }
        res.jsonp({
          status: 200,
          data: {
            bitstamp: self.bitstampRate[unit].last * self.stexRate
          }
        });
      });
    });
  } else {
    res.jsonp({
      status: 200,
      data: {
        bitstamp: self.bitstampRate[unit].last * self.stexRate
      }
    });
  }

};

module.exports = CurrencyController;
