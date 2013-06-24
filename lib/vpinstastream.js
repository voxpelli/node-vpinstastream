/*jslint node: true, indent: 2 */

"use strict";

//TODO: Validate that a received update is for a still valid subscription
//TODO: Check for rate limit notifications and act on and log them especially well

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

  // How many milliseconds between each request?
  this.minTimeBetweenFetches = 1000; // Could in theory be 60 * 60 * 1000 / 5000 = 720, but we better have some margins...

  this.scheduledUpdateFetches = {};
  this.nextFetch = 0;
  this.config = config;
};
util.inherits(streamClient, EventEmitter);

streamClient.prototype.syncSubscriptions = function (subs, callback) {
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
          console.log('Already subscribed to', '#' + value.object_id, 'on Instagram');
          toAdd.track[index] = toAdd.track[toAdd.track.length - 1];
          toAdd.track.pop();
        }
      }
    });

    that.removeSubscriptions(toDelete);
    that.addSubscriptions(toAdd, callback);
  });
};
streamClient.prototype.addSubscriptions = function (subs, callback) {
  var baseRequest, i, length, value, requests = [];

  baseRequest = {
    client_secret : this.config.client_secret,
    client_id : this.config.client_id,
    aspect : 'media',
    callback_url : this.config.path
  };

  if (typeof subs.track === 'string') {
    subs.track = [subs.track];
  } else {
    subs.track = subs.track || [];
  }

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
      form : u.extend(requests[i], baseRequest),
      json : true
    }, function (error, response, body) {
      if (error || response.statusCode > 299 || !body.data) {
        console.error('Failed to subscribe to', value, 'on Instagram. Error:', error || body);
        if (callback) {
          callback(error || true);
        }
        return;
      }
      console.log('Successfully subscribed on Instagram. Got response:', body);
      if (callback) {
        callback(false, body.data);
      }
    });
  }
};
streamClient.prototype.removeSubscriptions = function (subs) {
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

  endpoint.use(PuSHHelper.signature_calculator(this.config.client_secret));
  endpoint.use(connect.query());
  endpoint.use(connect.json());
  endpoint.use(PuSHHelper.check_signature);
  endpoint.use(function (req, res, next) {
    if (req.method === 'GET') {
      //TODO: Add callback to remove verify_token from database
      PuSHHelper.handshake(req, res);
    } else if (req.method === 'POST') {
      res.writeHead(200); // Should be a 202, but Instagram might perhaps not like it? Hard to know
      res.end();
      that.handleUpdate(req.body);
    } else {
      next();
    }
  });

  return endpoint;
};
streamClient.prototype.handleUpdate = function (updates) {
  console.log('Handling Instagram update:', updates);

  var i, length, tagsToFetch = {};

  for (i = 0, length = updates.length; i < length; i += 1) {
    if (updates[i].object === 'tag') {
      tagsToFetch[updates[i].subscription_id] = updates[i].object_id;
    }
  }

  console.log('Emitting subscription-update: ', tagsToFetch);
  this.emit('subscription-update', {
    track : tagsToFetch
  });
};
streamClient.prototype.scheduleUpdateFetch = function (key, tag, callback, syncCallback) {
  var task, toHappenAt, schedule, that = this, now = Date.now();

  task = function () {
    var query;

    console.log('Actually fetching new Instagram media for:', key.substr(1));

    if (that.scheduledUpdateFetches[key]) {
      delete that.scheduledUpdateFetches[key];
    }

    if (syncCallback) {
      tag = syncCallback(key, tag);
    }

    query = {client_id : that.config.client_id};
    if (tag.min_tag_id) {
      query.min_tag_id = tag.min_tag_id;
    }

    request({
      method : 'GET',
      url : 'https://api.instagram.com/v1/tags/' + encodeURIComponent(key.substr(1)) + '/media/recent',
      qs : query,
      json : true
    }, function (error, response, body) {
      if (error || response.statusCode > 299 || !body.data) {
        console.error('Failed to fetch tag media from Instagram using client id. ', error || response.statusCode);
        callback(error || true, { track : tag });
        return;
      }
      callback(false, body.data, body.pagination.min_tag_id || false, tag);
    });
  };

  if (this.scheduledUpdateFetches[key]) {
    clearTimeout(this.scheduledUpdateFetches[key].timer);
    toHappenAt = this.scheduledUpdateFetches[key].toHappenAt;
  } else {
    toHappenAt = this.nextFetch;
  }

  schedule = Math.max(0, toHappenAt - now);
  toHappenAt = now + schedule;

  if (this.scheduledUpdateFetches[key]) {
    console.log('Rescheduling existing update of', key, ' in ', schedule, 'milliseconds');
  } else {
    this.nextFetch = toHappenAt + this.minTimeBetweenFetches;
    console.log('Scheduling update of', key, ' in ', schedule, 'milliseconds');
  }

  if (schedule === 0) {
    if (this.scheduledUpdateFetches[key]) {
      delete this.scheduledUpdateFetches[key];
    }
    process.nextTick(task);
  } else {
    this.scheduledUpdateFetches[key] = {
      timer : setTimeout(task, schedule),
      toHappenAt : toHappenAt
    };
  }
};
streamClient.prototype.fetchUpdates = function (subs, callback, syncCallback) {
  var key;

  subs.track = subs.track || {};

  for (key in subs.track) {
    if (subs.track.hasOwnProperty(key) && key[0] === '#' && key.length > 1) {
      this.scheduleUpdateFetch(key, subs.track[key], callback, syncCallback);
    }
  }
};

module.exports = streamClient;
