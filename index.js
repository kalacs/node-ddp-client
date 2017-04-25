"use strict";

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function _possibleConstructorReturn(self, call) { if (!self) { throw new ReferenceError("this hasn't been initialised - super() hasn't been called"); } return call && (typeof call === "object" || typeof call === "function") ? call : self; }

function _inherits(subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass; }

var _ = require('underscore');
var EventEmitter = require('events').EventEmitter;
var EJSON = require("ejson");

var DDPClient = function (_EventEmitter) {
  _inherits(DDPClient, _EventEmitter);

  function DDPClient(opts) {
    _classCallCheck(this, DDPClient);

    var _this = _possibleConstructorReturn(this, (DDPClient.__proto__ || Object.getPrototypeOf(DDPClient)).call(this));

    var self = _this;
    opts = opts || {};
    // backwards compatibility
    if ("use_ssl" in opts) opts.ssl = opts.use_ssl;
    if ("auto_reconnect" in opts) opts.autoReconnect = opts.auto_reconnect;
    if ("auto_reconnect_timer" in opts) opts.autoReconnectTimer = opts.auto_reconnect_timer;
    if ("maintain_collections" in opts) opts.maintainCollections = opts.maintain_collections;
    if ("ddp_version" in opts) opts.ddpVersion = opts.ddp_version;

    // default arguments
    self.host = opts.host || "localhost";
    self.port = opts.port || 3000;
    self.path = opts.path;
    self.ssl = opts.ssl || self.port === 443;
    self.tlsOpts = opts.tlsOpts || {};
    self.autoReconnect = "autoReconnect" in opts ? opts.autoReconnect : true;
    self.autoReconnectTimer = "autoReconnectTimer" in opts ? opts.autoReconnectTimer : 500;
    self.maintainCollections = "maintainCollections" in opts ? opts.maintainCollections : true;
    self.url = opts.url;
    self.socketConstructor = opts.socketConstructor || WebSocket;

    // support multiple ddp versions
    self.ddpVersion = "ddpVersion" in opts ? opts.ddpVersion : "1";
    self.supportedDdpVersions = ["1", "pre2", "pre1"];

    // Expose EJSON object, so client can use EJSON.addType(...)
    self.EJSON = EJSON;

    // very very simple collections (name -> [{id -> document}])
    if (self.maintainCollections) {
      self.collections = {};
    }

    // internal stuff to track callbacks
    self._isConnecting = false;
    self._isReconnecting = false;
    self._nextId = 0;
    self._callbacks = {};
    self._updatedCallbacks = {};
    self._pendingMethods = {};
    self._observers = {};
    return _this;
  }

  _createClass(DDPClient, [{
    key: '_prepareHandlers',
    value: function _prepareHandlers() {
      var self = this;
      self.socket.onopen = function () {
        // just go ahead and open the connection on connect
        var data = {
          msg : "connect",
          version : self.ddpVersion,
          support : self.supportedDdpVersions
        };

        if(self.session)
          data['session'] = self.session;

        self._send(data);
      };

      self.socket.onerror = function (error) {
        // error received before connection was established
        if (self._isConnecting) {
          self.emit("failed", error.message);
        }

        self.emit("socket-error", error);
      };

      self.socket.onclose = function (event) {
        self.emit("socket-close", event.code, event.reason);
        self._endPendingMethodCalls();
        self._recoverNetworkError();
      };

      self.socket.onmessage = function (event) {
        self._message(event.data);
        self.emit("message", event.data);
      };
    }
  }, {
    key: '_clearReconnectTimeout',
    value: function _clearReconnectTimeout() {
      var self = this;
      if (self.reconnectTimeout) {
        clearTimeout(self.reconnectTimeout);
        self.reconnectTimeout = null;
      }
    }
  }, {
    key: '_recoverNetworkError',
    value: function _recoverNetworkError() {
      var self = this;
      if (self.autoReconnect && !self._connectionFailed && !self._isClosing) {
        self._clearReconnectTimeout();
        self.reconnectTimeout = setTimeout(function () {
          self.connect();
        }, self.autoReconnectTimer);
        self._isReconnecting = true;
      }
    }

    ///////////////////////////////////////////////////////////////////////////
    // RAW, low level functions

  }, {
    key: '_send',
    value: function _send(data) {
      var self = this;
      self.socket.send(EJSON.stringify(data));
    }

    // handle a message from the server

  }, {
    key: '_message',
    value: function _message(data) {
      var self = this;
      data = EJSON.parse(data);

      // TODO: 'addedBefore' -- not yet implemented in Meteor
      // TODO: 'movedBefore' -- not yet implemented in Meteor

      if (!data.msg) {
        return;
      } else if (data.msg === "failed") {
        if (self.supportedDdpVersions.indexOf(data.version) !== -1) {
          self.ddpVersion = data.version;
          self.connect();
        } else {
          self.autoReconnect = false;
          self.emit("failed", "Cannot negotiate DDP version");
        }
      } else if (data.msg === "connected") {
        self.session = data.session;
        self.emit("connected");

        // method result
      } else if (data.msg === "result") {
        var cb = self._callbacks[data.id];

        if (cb) {
          cb(data.error, data.result);
          delete self._callbacks[data.id];
        }

        // method updated
      } else if (data.msg === "updated") {

        _.each(data.methods, function (method) {
          var cb = self._updatedCallbacks[method];
          if (cb) {
            cb();
            delete self._updatedCallbacks[method];
          }
        });

        // missing subscription
      } else if (data.msg === "nosub") {
        var cb = self._callbacks[data.id];

        if (cb) {
          cb(data.error);
          delete self._callbacks[data.id];
        }

        // add document to collection
      } else if (data.msg === "added") {
        if (self.maintainCollections && data.collection) {
          var name = data.collection,
              id = data.id;

          if (!self.collections[name]) {
            self.collections[name] = {};
          }
          if (!self.collections[name][id]) {
            self.collections[name][id] = {};
          }

          self.collections[name][id]._id = id;

          if (data.fields) {
            _.each(data.fields, function (value, key) {
              self.collections[name][id][key] = value;
            });
          }

          if (self._observers[name]) {
            _.each(self._observers[name], function (observer) {
              observer.added(id);
            });
          }
        }

        // remove document from collection
      } else if (data.msg === "removed") {
        if (self.maintainCollections && data.collection) {
          var name = data.collection,
              id = data.id;

          if (!self.collections[name][id]) {
            return;
          }

          var oldValue = self.collections[name][id];

          delete self.collections[name][id];

          if (self._observers[name]) {
            _.each(self._observers[name], function (observer) {
              observer.removed(id, oldValue);
            });
          }
        }

        // change document in collection
      } else if (data.msg === "changed") {
        if (self.maintainCollections && data.collection) {
          var name = data.collection,
              id = data.id;

          if (!self.collections[name]) {
            return;
          }
          if (!self.collections[name][id]) {
            return;
          }

          var oldFields = {},
              clearedFields = data.cleared || [],
              newFields = {};

          if (data.fields) {
            _.each(data.fields, function (value, key) {
              oldFields[key] = self.collections[name][id][key];
              newFields[key] = value;
              self.collections[name][id][key] = value;
            });
          }

          if (data.cleared) {
            _.each(data.cleared, function (value) {
              delete self.collections[name][id][value];
            });
          }

          if (self._observers[name]) {
            _.each(self._observers[name], function (observer) {
              observer.changed(id, oldFields, clearedFields, newFields);
            });
          }
        }

        // subscriptions ready
      } else if (data.msg === "ready") {
        _.each(data.subs, function (id) {
          var cb = self._callbacks[id];
          if (cb) {
            cb();
            delete self._callbacks[id];
          }
        });

        // minimal heartbeat response for ddp pre2
      } else if (data.msg === "ping") {
        self._send(_.has(data, "id") ? { msg: "pong", id: data.id } : { msg: "pong" });
      }
    }
  }, {
    key: '_getNextId',
    value: function _getNextId() {
      var self = this;
      return (self._nextId += 1).toString();
    }
  }, {
    key: '_addObserver',
    value: function _addObserver(observer) {
      var self = this;
      if (!self._observers[observer.name]) {
        self._observers[observer.name] = {};
      }
      self._observers[observer.name][observer._id] = observer;
    }
  }, {
    key: '_removeObserver',
    value: function _removeObserver(observer) {
      var self = this;
      if (!self._observers[observer.name]) {
        return;
      }

      delete self._observers[observer.name][observer._id];
    }

    //////////////////////////////////////////////////////////////////////////
    // USER functions -- use these to control the client

    /* open the connection to the server
     *
     *  connected(): Called when the 'connected' message is received
     *               If autoReconnect is true (default), the callback will be
     *               called each time the connection is opened.
     */

  }, {
    key: 'connect',
    value: function connect(connected) {
      var self = this;
      self._isConnecting = true;
      self._connectionFailed = false;
      self._isClosing = false;

      if (connected) {
        self.addListener("connected", function () {
          self._clearReconnectTimeout();

          connected(undefined, self._isReconnecting);
          self._isConnecting = false;
          self._isReconnecting = false;
        });
        self.addListener("failed", function (error) {
          self._isConnecting = false;
          self._connectionFailed = true;
          connected(error, self._isReconnecting);
        });
      }

      var url = self._buildWsUrl();
      self._makeWebSocketConnection(url);
    }
  }, {
    key: '_endPendingMethodCalls',
    value: function _endPendingMethodCalls() {
      var self = this;
      var ids = _.keys(self._pendingMethods);
      self._pendingMethods = {};

      ids.forEach(function (id) {
        if (self._callbacks[id]) {
          self._callbacks[id](new Error("DDPClient: Disconnected from DDP server"));
          delete self._callbacks[id];
        }

        if (self._updatedCallbacks[id]) {
          self._updatedCallbacks[id]();
          delete self._updatedCallbacks[id];
        }
      });
    }
  }, {
    key: '_buildWsUrl',
    value: function _buildWsUrl(path) {
      var self = this;
      var url;
      path = path || self.path || "websocket";
      var protocol = self.ssl ? "wss://" : "ws://";
      if (self.url) {
        url = self.url;
      } else {
        url = protocol + self.host + ":" + self.port;
        url += path.indexOf("/") === 0 ? path : "/" + path;
      }
      return url;
    }
  }, {
    key: '_makeWebSocketConnection',
    value: function _makeWebSocketConnection(url) {
      var self = this;
      self.socket = new self.socketConstructor(url);
      self._prepareHandlers();
    }
  }, {
    key: 'close',
    value: function close() {
      var self = this;
      self._isClosing = true;
      self.socket.close();
      self.removeAllListeners("connected");
      self.removeAllListeners("failed");
    }

    // call a method on the server,
    //
    // callback = function(err, result)

  }, {
    key: 'call',
    value: function call(name, params, callback, updatedCallback) {
      var self = this;
      var id = self._getNextId();

      self._callbacks[id] = function () {
        delete self._pendingMethods[id];

        if (callback) {
          callback.apply(this, arguments);
        }
      };

      self._updatedCallbacks[id] = function () {
        delete self._pendingMethods[id];

        if (updatedCallback) {
          updatedCallback.apply(this, arguments);
        }
      };

      self._pendingMethods[id] = true;

      self._send({
        msg: "method",
        id: id,
        method: name,
        params: params
      });
    }
  }, {
    key: 'callWithRandomSeed',
    value: function callWithRandomSeed(name, params, randomSeed, callback, updatedCallback) {
      var self = this;
      var id = self._getNextId();

      if (callback) {
        self._callbacks[id] = callback;
      }

      if (updatedCallback) {
        self._updatedCallbacks[id] = updatedCallback;
      }

      self._send({
        msg: "method",
        id: id,
        method: name,
        randomSeed: randomSeed,
        params: params
      });
    }

    // open a subscription on the server, callback should handle on ready and nosub

  }, {
    key: 'subscribe',
    value: function subscribe(name, params, callback) {
      var self = this;
      var id = self._getNextId();

      if (callback) {
        self._callbacks[id] = callback;
      }

      self._send({
        msg: "sub",
        id: id,
        name: name,
        params: params
      });

      return id;
    }
  }, {
    key: 'unsubscribe',
    value: function unsubscribe(id) {
      var self = this;
      self._send({
        msg: "unsub",
        id: id
      });
    }

    /**
     * Adds an observer to a collection and returns the observer.
     * Observation can be stopped by calling the stop() method on the observer.
     * Functions for added, updated and removed can be added to the observer
     * afterward.
     */

  }, {
    key: 'observe',
    value: function observe(name, added, updated, removed) {
      var self = this;
      var observer = {};
      var id = self._getNextId();

      // name, _id are immutable
      Object.defineProperty(observer, "name", {
        get: function get() {
          return name;
        },
        enumerable: true
      });

      Object.defineProperty(observer, "_id", { get: function get() {
          return id;
        } });

      observer.added = added || function () {};
      observer.updated = updated || function () {};
      observer.removed = removed || function () {};

      observer.stop = function () {
        self._removeObserver(observer);
      };

      self._addObserver(observer);

      return observer;
    }
  }]);

  return DDPClient;
}(EventEmitter);

module.exports = DDPClient;
