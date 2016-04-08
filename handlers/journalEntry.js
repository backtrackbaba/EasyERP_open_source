var mongoose = require('mongoose');
var journalSchema = mongoose.Schemas['journal'];
var journalEntrySchema = mongoose.Schemas['journalEntry'];
var CurrencySchema = mongoose.Schemas.Currency;

var oxr = require('open-exchange-rates');
var fx = require('money');
var _ = require('underscore');
var async = require('async');
var moment = require('../public/js/libs/moment/moment');

var Module = function (models) {
    "use strict";
    oxr.set({app_id: process.env.OXR_APP_ID});

    var access = require("../Modules/additions/access.js")(models);

    this.create = function (body, dbIndex, cb, uId) {
        var Journal = models.get(dbIndex, 'journal', journalSchema);
        var Model = models.get(dbIndex, 'journalEntry', journalEntrySchema);
        var Currency = models.get(dbIndex, 'currency', CurrencySchema);
        var journalId = body.journal;
        var now = moment();
        var date = body.date ? moment(body.date) : now;
        //var currency = {
        //    name: body.currency
        //};
        var currency;
        var amount = body.amount;
        var rates;

        var waterfallTasks = [currencyNameFinder, journalFinder, journalEntrySave];

        date = date.format('YYYY-MM-DD');

        function currencyNameFinder(waterfallCb) {

            Currency.findById(body.currency, function (err, result) {
                if (err) {
                    waterfallCb(err);
                }

                waterfallCb(null, result.name);
            });
        }

        function journalFinder(currencyName, waterfallCb) {
            var err;

            if (!journalId) {
                err = new Error('Journal id is required field');
                err.status = 400;

                return waterfallCb(err);
            }

            currency = {
                name: currencyName
            };

            Journal.findById(journalId, waterfallCb);

        }

        function journalEntrySave(journal, waterfallCb) {
            oxr.historical(date, function () {
                var err;
                var debitObject;
                var creditObject;
                var parallelTasks = {
                    debitSaver : function (parallelCb) {
                        var journalEntry;

                        debitObject.debit = amount;
                        debitObject.account = journal.debitAccount;

                        debitObject.editedBy = {
                            user: uId,
                            date: new Date()
                        };

                        debitObject.createdBy = {
                            user: uId,
                            date: new Date()
                        };

                        journalEntry = new Model(debitObject);
                        journalEntry.save(parallelCb);
                    },
                    creditSaver: function (parallelCb) {
                        var journalEntry;

                        creditObject.credit = amount;
                        creditObject.account = journal.creditAccount;

                        creditObject.editedBy = {
                            user: uId,
                            date: new Date()
                        };

                        creditObject.createdBy = {
                            user: uId,
                            date: new Date()
                        };

                        journalEntry = new Model(creditObject);
                        journalEntry.save(parallelCb);
                    }
                };

                if (!journal || !journal._id) {
                    err = new Error('Invalid Journal');
                    err.status = 400;

                    return waterfallCb(err);
                }

                rates = oxr.rates;
                currency.rate = rates[currency.name];

                if (!body.currency.rate){
                    body.currency = currency;
                }

                body.journal = journal._id;

                debitObject = _.extend({}, body);
                creditObject = _.extend({}, body);

                async.parallel(parallelTasks, function (err, result) {
                    if (err) {
                        return waterfallCb(err);
                    }

                    waterfallCb(null, result);
                });
            });
        }

        async.waterfall(waterfallTasks, function (err, response) {
            if (err) {
                return cb(err);
            }

            cb(null, response);
        });
    };

    this.getForView = function (req, res, next) {
        var dbIndex = req.session.lastDb;
        var Journal = models.get(dbIndex, 'journal', journalSchema);
        var Model = models.get(dbIndex, 'journalEntry', journalEntrySchema);

        var data = req.query;
        var sort = data.sort ? data.sort : {_id: 1};

        access.getReadAccess(req, req.session.uId, 86, function (access) {
            if (access) {
                Model
                    .aggregate([{
                        $lookup: {
                            from                   : "chartOfAccount",
                            localField             : "account",
                            foreignField: "_id", as: "account"
                        }
                    }, {
                        $lookup: {
                            from                   : "Invoice",
                            localField             : "sourceDocument._id",
                            foreignField: "_id", as: "sourceDocument"
                        }
                    }, {
                        $project: {
                            debit         : {$divide: ['$debit', '$currency.rate']},
                            credit        : {$divide: ['$credit', '$currency.rate']},
                            currency      : 1,
                            name          : 1,
                            journal       : 1,
                            account       : {$arrayElemAt: ["$account", 0]},
                            sourceDocument: {$arrayElemAt: ["$sourceDocument", 0]},
                            date          : 1
                        }
                    }, {
                        $lookup: {
                            from                   : "Customers",
                            localField             : "sourceDocument.supplier",
                            foreignField: "_id", as: "sourceDocument.supplier"
                        }
                    }, {
                        $project: {
                            debit                    : 1,
                            credit                   : 1,
                            currency                 : 1,
                            name                     : 1,
                            journal                  : 1,
                            date                     : 1,
                            'sourceDocument._id'     : 1,
                            'sourceDocument.name'    : 1,
                            'sourceDocument.supplier': {$arrayElemAt: ["$sourceDocument.supplier", 0]},
                            account                  : 1
                        }
                    }, {
                        $project: {
                            debit                    : 1,
                            credit                   : 1,
                            currency                 : 1,
                            name                     : 1,
                            journal                  : 1,
                            date                     : 1,
                            'sourceDocument._id'     : 1,
                            'sourceDocument.name'    : 1,
                            'sourceDocument.supplier': 1,
                            account                  : 1
                        }
                    }], function (err, result) {
                        if (err) {
                            return next(err);
                        }
                        Journal.populate(result, {
                            path  : 'journal',
                            select: '_id name'
                        }, function (err, journals) {
                            if (err) {
                                return next(err);
                            }

                            res.status(200).send(result);
                        });
                    });
            } else {
                res.status(403).send();
            }
        });
    };

    this.removeByDocId = function (docId, dbIndex, callback) {
        var Model = models.get(dbIndex, 'journalEntry', journalEntrySchema);

        Model
            .remove({'sourceDocument._id': docId}, callback);
    };

    this.changeDate = function (query, date, dbIndex, callback) {
        var Model = models.get(dbIndex, 'journalEntry', journalEntrySchema);

        Model
            .update(query, {$set: {date: new Date(date)}}, {multi: true}, callback);
    };
};

module.exports = Module;
