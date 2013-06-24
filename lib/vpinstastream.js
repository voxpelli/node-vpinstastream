/*jslint node: true, indent: 2 */

"use strict";

//TODO: Validate that a received update is for a still valid subscription
//TODO: Limited to 5000 requests per day

var request = require('request'),
  connect = require('connect'),
  PuSHHelper = require('node-push-helper').PuSHHelper,
  EventEmitter = require('events').EventEmitter,
  util = require('util'),
  u = require('underscore'),
  packageVersion = require('../package.json').version,
  packageUrl = require('../package.json').url,
  streamClient;

request.defaults({
  jar: false,
  headers : {
    'User-Agent' : 'vpinstastream/' + packageVersion + ' (' + packageUrl + ')'
  }
});

streamClient = function (config) {
  EventEmitter.call(this);

  if (!config.path || !config.client_secret || !config.client_id) {
    throw "Need a path, client_secret and client_id!";
  }

  this.config = config;
};
util.inherits(streamClient, EventEmitter);

streamClient.prototype.syncSubscriptions = function (subs) {
  var that = this;

  console.log('Syncing Instagram subscriptions');

  request({
    method : 'GET',
    url : 'https://api.instagram.com/v1/subscriptions',
    qs : {
      client_secret : this.config.client_secret,
      client_id : this.config.client_id
    },
    json : true
  }, function (error, response, body) {
    var toAdd = {
        track : subs.track ? subs.track.concat([]) : []
      },
      toDelete = [];

    if (error || response.statusCode > 299 || !body.data) {
      console.error('Failed to fetch subscriptions from Instagram');
    }

    body.data.forEach(function (value) {
      var index;

      if (value.object === 'tag') {
        index = toAdd.track.indexOf('#' + value.object_id);
        if (index === -1) {
          toDelete.push(value.id);
        } else {
          toAdd.track[index] = toAdd.track[toAdd.track.length - 1];
          toAdd.track.pop();
        }
      }
    });

    that.removeSubscription(toDelete);
    that.addSubscriptions(toAdd);
  });
};
streamClient.prototype.addSubscriptions = function (subs) {
  var baseRequest, i, length, value, requests = [];

  baseRequest = {
    client_secret : this.config.client_secret,
    client_id : this.config.client_id,
    aspect : 'media',
    callback_url : this.config.path
  };

  subs.track = subs.track || [];
  for (i = 0, length = subs.track.length; i < length; i += 1) {
    value = subs.track[i];
    if (value && value[0] === '#' && value.length > 1) {
      requests.push({
        object : 'tag',
        object_id : value.substr(1)
      });
    }
  }

  for (i = 0, length = requests.length; i < length; i += 1) {
    //TODO: Create verify_token first!
    console.log('Adding subscription for', requests[i].object_id, 'to Instagram');
    request({
      method : 'POST',
      url : 'https://api.instagram.com/v1/subscriptions/',
      form : u.extend(requests[i], baseRequest)
    }, function (error, response, body) {
      if (error || response.statusCode > 299) {
        console.error('Failed to subscribe to', value, 'on Instagram. Error:', error || body);
      }
    });
  }
};
streamClient.prototype.removeSubscription = function (subs) {
  var baseRequest, i, length;

  if (!Array.isArray(subs)) {
    subs = [subs];
  }

  baseRequest = {
    client_secret : this.config.client_secret,
    client_id : this.config.client_id
  };

  for (i = 0, length = subs.length; i < length; i += 1) {
    console.log('Removing subscription with id', subs[i], 'from Instagram');
    request({
      method : 'DELETE',
      url : 'https://api.instagram.com/v1/subscriptions',
      qs : u.extend({id : subs[i]}, baseRequest)
    }, function (error, response) {
      if (error || response.statusCode > 299) {
        console.error('Failed to delete subscription on Instagram');
        return;
      }
    });
  }
};
streamClient.prototype.getEndpoint = function () {
  var endpoint = connect(), that = this;

  endpoint.use(connect.query());
  endpoint.use(connect.json());
  endpoint.use(PuSHHelper.check_signature);
  endpoint.use(function (req, res, next) {
    if (req.method === 'GET') {
      //TODO: Add callback to remove verify_token from database
      PuSHHelper.handshake(req, res);
    } else if (req.method === 'POST') {
      res.writeHead(202);
      res.end();
      that.handleUpdate(req.body);
    } else {
      next();
    }
  });

  return endpoint;
};
streamClient.prototype.handleUpdate = function (updates) {
  var i, length, tagsToFetch = [];

  for (i = 0, length = updates.length; i < length; i += 1) {
    if (updates[i].object === 'tag') {
      tagsToFetch[updates[i].subscription_id] = updates[i].object_id;
    }
    this.emit('subscription-update', {
      track : tagsToFetch
    });
  }
};
streamClient.prototype.fetchUpdates = function (subs, callback) {
  var key, tag, query;

  subs.track = subs.track || {};

  for (key in subs.track) {
    if (subs.track.hasOwnProperty(key) && key[0] === '#' && key.length > 1) {
      tag = subs.track[key];

      query = {client_id : this.config.client_id};
      if (tag.maxId) {
        query.maxId = tag.maxId;
      }

      request({
        method : 'GET',
        url : 'https://api.instagram.com/v1/tags/' + encodeURIComponent(key.substr(1)) + '/media/recent',
        qs : query
      }, function (error, response) {
        if (error || response.statusCode > 299) {
          console.error('Failed to fetch tag media from Instagram using client id');
          callback(error || true, { track : tag });
        }

        callback(false, response.data, response.pagination.next_min_id || false, tag);
      });
    }
  }
};

module.exports = streamClient;
