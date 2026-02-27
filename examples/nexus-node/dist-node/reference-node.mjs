#!/usr/bin/env tsx
import {
  __commonJS,
  __require,
  __toESM
} from "./chunk-LZOMFHX3.mjs";

// ../../node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../../node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../../node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../../node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../../node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// ../../node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../../node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       * @param {Boolean} [isServer=false] Create the instance in either server or
       *     client mode
       * @param {Number} [maxPayload=0] The maximum allowed message length
       */
      constructor(options, isServer, maxPayload) {
        this._maxPayload = maxPayload | 0;
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._isServer = !!isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../../node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../../node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../../node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// ../../node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../../node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var PerMessageDeflate = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else {
            buf.set(data, 2);
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../../node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../../node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../../node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../../node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension) => {
        let configurations = extensions[extension];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// ../../node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../../node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net2 = __require("net");
    var tls = __require("tls");
    var { randomBytes: randomBytes2, createHash: createHash2 } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate.extensionName]) {
          this._extensions[PerMessageDeflate.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch (e) {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes2(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate(
          opts.perMessageDeflate !== true ? opts.perMessageDeflate : {},
          false,
          opts.maxPayload
        );
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net2.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net2.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../../node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../../node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// ../../node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../../node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// ../../node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../../node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash: createHash2 } = __require("crypto");
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var subprotocol = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate(
            this.options.perMessageDeflate,
            true,
            this.options.maxPayload
          );
          try {
            const offers = extension.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
              extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash2("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate.extensionName]) {
          const params = extensions[PerMessageDeflate.extensionName].params;
          const value = extension.format({
            [PerMessageDeflate.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// reference-node.ts
import { exec, execFile, spawn as spawnChild } from "child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify
} from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import { createServer } from "http";
import net from "net";
import os from "os";
import path from "path";
import process2 from "process";
import { fileURLToPath } from "url";

// ../../node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// reference-node.ts
var ED25519_SPKI_RAW_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
var MAX_OUTPUT_CHARS = 6e4;
var MAX_PROCESS_LOG_CHARS = 12e4;
var DELIVERED_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var FIREWALL_SESSION_TTL_MS = 24 * 60 * 60 * 1e3;
var MCP_BRIDGE_CONFIG_FILE = "mcp-bridge.json";
var POLICYCTL_COMMAND = "nexus-policyctl";
var SHELLCTL_COMMAND = "nexus-shellctl";
var FILE_PULL_COMMAND = "file_pull";
var FILE_PUSH_COMMAND = "file_push";
var POLICY_PRESET_DIRNAME = "policy-presets";
var SHELLCTL_ROOT_DIRNAME = "interactive-shell";
var SHELLCTL_SESSION_DIRNAME = "sessions";
var SHELLCTL_LOG_DIRNAME = "logs";
var SHELLCTL_POLL_INTERVAL_MS = 60;
var SHELLCTL_MAX_WAIT_MS = 5e3;
var SHELLCTL_MAX_IDLE_MS = 1e3;
var SHELLCTL_MAX_CHARS = 12e3;
var SHELLCTL_MAX_READ_BYTES = 128e3;
var SHELLCTL_SESSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
var POLICY_ALLOWED_FIELDS = /* @__PURE__ */ new Set(["version", "label", "defaultQuarantine", "firewallMode", "denyCommands", "updatedAt"]);
var DEFAULT_FILE_TRANSFER_MAX_BYTES = 5 * 1024 * 1024;
var DEFAULT_CAPABILITIES = [
  "system.run",
  "system.which",
  "process.start",
  "process.status",
  "process.logs",
  "process.cancel",
  "symbols.list",
  "audit.query"
];
var DEFAULT_ALLOW_COMMANDS = ["echo", "uname", "whoami", "pwd", "date"];
var DEFAULT_POLICY_DOC = {
  version: 1,
  defaultQuarantine: "none",
  firewallMode: "transparent",
  denyCommands: []
};
var SYMBOL_TOKEN_PATTERN = /\{\{([a-z]+):([a-zA-Z0-9._-]+)(?::([a-zA-Z0-9._-]+))?\}\}/g;
var SYMBOL_KINDS = ["contact", "account", "secret", "user"];
var NodeToolError = class extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.name = "NodeToolError";
  }
};
async function runReferenceNode(argv = process2.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }
  const envFilePath = args.values["env-file"] ?? process2.env.NEXUS_NODE_ENV_FILE;
  if (envFilePath) {
    await loadEnvFileIntoProcessEnv(path.resolve(envFilePath));
  }
  const config = buildConfig(args.values, options);
  const logger = await ReferenceNodeLogger.create(config);
  if (isTruthyFlag(args.values.init)) {
    await initializeNodeBootstrap(config, logger);
    if (!isTruthyFlag(args.values["run-after-init"])) {
      logger.info("init complete; exiting (use --run-after-init to continue startup)");
      return;
    }
  }
  if (isTruthyFlag(args.values.doctor)) {
    const doctor = await runDoctorChecks(config, logger);
    if (!doctor.ok) {
      throw new Error("Doctor checks failed. Resolve the reported errors before starting the node.");
    }
    if (!isTruthyFlag(args.values["doctor-continue"])) {
      logger.info("doctor checks passed; exiting (use --doctor-continue to continue startup)");
      return;
    }
  }
  const identity = await loadOrCreateIdentity(config.stateDir);
  const stateStore = await openStateStore(config.stateDir, config.stateBackend);
  const client = new ReferenceNodeClient(config, identity, stateStore, logger);
  logger.info(`id=${config.nodeId} fingerprint=${identity.fingerprint} gateway=${config.gatewayUrl}`);
  logger.info(`capabilities=${config.capabilities.join(",")} allow_commands=${[...config.allowCommands].join(",")}`);
  logger.info(`state_backend=${stateStore.backend} state_path=${stateStore.statePath}`);
  logger.info(`mcp_bridge=${config.mcpBridgeEnabled ? "enabled" : "disabled"} mcp_config=${config.mcpBridgeConfigPath}`);
  logger.info(
    `local_webhook=${config.webhookEnabled ? `enabled http://${config.webhookHost}:${config.webhookPort}${config.webhookPath}` : "disabled"} auth=${config.webhookToken ? "token" : "none"}`
  );
  const fileTransferOps = [];
  if (isAllowedCommand(FILE_PULL_COMMAND, config.allowCommands)) fileTransferOps.push("pull");
  if (isAllowedCommand(FILE_PUSH_COMMAND, config.allowCommands)) fileTransferOps.push("push");
  logger.info(
    `file_transfer=${fileTransferOps.join(",") || "disabled"} roots=${config.fileTransferRoots.join(",")} max_bytes=${config.fileTransferMaxBytes}`
  );
  const shutdown = () => {
    client.stop("shutdown");
  };
  process2.on("SIGINT", shutdown);
  process2.on("SIGTERM", shutdown);
  await client.start();
}
var ReferenceNodeClient = class {
  constructor(config, identity, stateStore, logger) {
    this.config = config;
    this.identity = identity;
    this.stateStore = stateStore;
    this.logger = logger;
    this.policyPath = path.join(this.config.stateDir, "hermes-policy.json");
    this.policyPresetDir = path.join(this.config.stateDir, POLICY_PRESET_DIRNAME);
    this.symbolStoreDir = path.join(this.config.stateDir, "hermes-stores");
    this.mcpBridgeConfigPath = this.config.mcpBridgeConfigPath;
  }
  ws = null;
  webhookServer = null;
  stopped = false;
  reconnectTimer = null;
  reconnectAttempt = 0;
  processes = /* @__PURE__ */ new Map();
  drainingOutbox = false;
  gatewayPublicKey = null;
  gatewayFingerprint = null;
  nodeNonce = null;
  gatewayNonce = null;
  sessionId = null;
  ready = false;
  policy = { ...DEFAULT_POLICY_DOC };
  policyLoadedAtMs = null;
  policyDigest = null;
  policyPath;
  policyPresetDir;
  symbolStoreDir;
  mcpBridgeConfigPath;
  mcpBridgeServers = /* @__PURE__ */ new Map();
  mcpBridgeClients = /* @__PURE__ */ new Map();
  mcpBridgeClientCtorPromise = null;
  async start() {
    await this.loadPolicyFromDisk();
    await this.loadMcpBridgeConfig();
    this.bootstrapPersistedState();
    await this.startWebhookServer();
    this.connect();
  }
  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && this.ws.readyState === import_websocket.default.OPEN) {
      try {
        this.ws.close(1e3, truncateOutput(reason, 120));
      } catch {
      }
    }
    void this.stopWebhookServer().catch(() => void 0);
    this.terminateAllProcesses(reason);
    void this.closeMcpBridgeClients().catch(() => void 0);
    this.stateStore.close();
  }
  async startWebhookServer() {
    if (!this.config.webhookEnabled || this.webhookServer) return;
    const server = createServer((req, res) => {
      void this.handleWebhookHttpRequest(req, res).catch((err) => {
        this.log(`local webhook handler error=${err instanceof Error ? err.message : String(err)}`);
        this.sendWebhookJson(res, 500, { error: "internal server error" });
      });
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.config.webhookPort, this.config.webhookHost);
    });
    server.on("error", (err) => {
      this.log(`local webhook server error=${err instanceof Error ? err.message : String(err)}`);
    });
    this.webhookServer = server;
    this.log(
      `local webhook listening host=${this.config.webhookHost} port=${this.config.webhookPort} path=${this.config.webhookPath}`
    );
  }
  async stopWebhookServer() {
    const server = this.webhookServer;
    if (!server) return;
    this.webhookServer = null;
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  async handleWebhookHttpRequest(req, res) {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      this.sendWebhookJson(res, 400, { error: "invalid request url" });
      return;
    }
    if (pathname !== this.config.webhookPath) {
      this.sendWebhookJson(res, 404, { error: "not found" });
      return;
    }
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      this.sendWebhookJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (this.config.webhookToken) {
      const suppliedToken = this.readWebhookAuthToken(req);
      if (suppliedToken !== this.config.webhookToken) {
        this.sendWebhookJson(res, 401, { error: "invalid webhook token" });
        return;
      }
    }
    const body = await this.readRequestBodyTextLimited(req, this.config.webhookMaxBodyBytes);
    if (!body.ok) {
      this.sendWebhookJson(res, body.status, { error: body.error });
      return;
    }
    let parsed = {};
    if (body.text.trim().length > 0) {
      try {
        parsed = asObject(JSON.parse(body.text));
      } catch {
        this.sendWebhookJson(res, 400, { error: "invalid JSON body" });
        return;
      }
    }
    const destination = asObject(parsed.destination);
    const endpointId = asString(destination.endpointId) ?? asString(parsed.endpointId);
    if (!endpointId) {
      this.sendWebhookJson(res, 400, { error: "endpointId or destination.endpointId is required" });
      return;
    }
    const eventId = asString(parsed.eventId) ?? randomUUID();
    const traceId = asString(parsed.traceId) ?? eventId;
    const kind = asString(parsed.kind) ?? asString(parsed.eventType) ?? "node.webhook.received";
    const ts = asNumber(parsed.ts) ?? Date.now();
    const idempotencyKey = asString(parsed.idempotencyKey) ?? eventId;
    const sensitivity = asString(parsed.sensitivity) ?? "internal";
    const payload = asObject(parsed.payload);
    const meta = asObject(parsed.meta);
    if (!this.ready || !this.requireOpenSocket()) {
      this.sendWebhookJson(res, 503, { error: "gateway websocket is not connected" });
      return;
    }
    const sent = this.sendSignedEnvelope({
      type: "event",
      event: "webhook.deliver",
      payload: {
        schemaVersion: "1.0",
        eventId,
        traceId,
        kind,
        destination: {
          endpointId,
          peerId: asString(destination.peerId) ?? null
        },
        ts,
        idempotencyKey,
        sensitivity,
        payload,
        meta: {
          attempt: 1,
          maxAttempts: 1,
          orderingKey: asString(meta.orderingKey) ?? `node:${this.config.nodeId}:${kind}`
        }
      }
    });
    if (!sent) {
      this.sendWebhookJson(res, 503, { error: "failed to publish webhook event to gateway" });
      return;
    }
    this.sendWebhookJson(res, 202, {
      ok: true,
      eventId,
      traceId,
      kind,
      endpointId,
      queuedAt: Date.now()
    });
  }
  readWebhookAuthToken(req) {
    const header = req.headers.authorization;
    if (typeof header === "string") {
      const match = header.match(/^Bearer\s+(.+)$/i);
      if (match == null ? void 0 : match[1]) {
        const token = match[1].trim();
        if (token) return token;
      }
    }
    const tokenHeader = req.headers["x-nexus-node-webhook-token"];
    if (typeof tokenHeader === "string") {
      const token = tokenHeader.trim();
      if (token) return token;
    }
    if (Array.isArray(tokenHeader)) {
      for (const value of tokenHeader) {
        const token = String(value ?? "").trim();
        if (token) return token;
      }
    }
    return null;
  }
  async readRequestBodyTextLimited(req, maxBytes) {
    const contentLengthRaw = req.headers["content-length"];
    const contentLengthHeader = Array.isArray(contentLengthRaw) ? contentLengthRaw[0] : contentLengthRaw;
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        return {
          ok: false,
          status: 413,
          error: `request body exceeds max size (${maxBytes} bytes)`
        };
      }
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > maxBytes) {
          return {
            ok: false,
            status: 413,
            error: `request body exceeds max size (${maxBytes} bytes)`
          };
        }
        chunks.push(buffer);
      }
    } catch {
      return {
        ok: false,
        status: 400,
        error: "failed to read request body"
      };
    }
    const text = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
    return { ok: true, text };
  }
  sendWebhookJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-length", Buffer.byteLength(body));
    try {
      res.end(body);
    } catch {
      try {
        res.end();
      } catch {
      }
    }
  }
  connect() {
    if (this.stopped) return;
    const needsTlsPin = Boolean(this.config.gatewayTlsFingerprint);
    let tlsPinVerified = !needsTlsPin;
    const ws = needsTlsPin ? new import_websocket.default(this.config.gatewayUrl, { rejectUnauthorized: false }) : new import_websocket.default(this.config.gatewayUrl);
    this.ws = ws;
    this.ready = false;
    this.nodeNonce = null;
    this.gatewayNonce = null;
    this.sessionId = null;
    this.gatewayPublicKey = null;
    this.gatewayFingerprint = null;
    ws.on("upgrade", (response) => {
      var _a;
      if (!this.config.gatewayTlsFingerprint) return;
      const socket = response.socket;
      const certificate = (_a = socket.getPeerCertificate) == null ? void 0 : _a.call(socket, true);
      const actual = normalizeFingerprint256((certificate == null ? void 0 : certificate.fingerprint256) ?? (certificate == null ? void 0 : certificate.fingerprint) ?? "");
      if (!actual || actual !== this.config.gatewayTlsFingerprint) {
        this.log(
          `gateway TLS fingerprint mismatch expected=${this.config.gatewayTlsFingerprint} actual=${actual ?? "unknown"}`
        );
        this.closeSocket(4001, "gateway tls fingerprint mismatch");
        return;
      }
      tlsPinVerified = true;
    });
    ws.on("open", () => {
      this.reconnectAttempt = 0;
      if (needsTlsPin && !tlsPinVerified) {
        this.log("gateway TLS fingerprint was not validated before websocket open");
        this.closeSocket(4001, "gateway tls fingerprint missing");
        return;
      }
      this.sendConnectHello();
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.log("received binary frame; closing");
        this.closeSocket(4001, "binary frames unsupported");
        return;
      }
      const text = typeof data === "string" ? data : data.toString("utf8");
      this.handleMessage(text).catch((err) => {
        this.log(`message handling error=${err instanceof Error ? err.message : String(err)}`);
        this.closeSocket(4001, "message handling failed");
      });
    });
    ws.on("error", (err) => {
      this.log(`socket error=${err instanceof Error ? err.message : String(err)}`);
    });
    ws.on("close", (code, reasonRaw) => {
      const reason = String(reasonRaw || "");
      this.log(`socket closed code=${code} reason=${reason || "<none>"}`);
      this.ready = false;
      if (this.stopped) return;
      this.scheduleReconnect();
    });
  }
  scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectAttempt += 1;
    const base = this.config.reconnectMinMs;
    const delay = Math.min(
      this.config.reconnectMaxMs,
      Math.max(this.config.reconnectMinMs, base * Math.pow(2, Math.min(8, this.reconnectAttempt - 1)))
    );
    this.log(`reconnect attempt=${this.reconnectAttempt} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  bootstrapPersistedState() {
    this.stateStore.pruneDeliveredOlderThan(Date.now() - DELIVERED_OUTBOX_TTL_MS);
    const prunedFirewallSessions = this.stateStore.pruneExpiredFirewallSessions(Date.now());
    const persisted = this.stateStore.loadProcesses(1e3);
    const nowMs = Date.now();
    for (const record of persisted) {
      const entry = {
        processId: record.processId,
        command: record.command,
        cwd: record.cwd,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        exitCode: record.exitCode,
        signal: record.signal,
        cancelRequested: record.cancelRequested,
        timeoutMs: record.timeoutMs,
        logs: record.logs,
        child: null,
        timeoutTimer: null,
        killTimer: null,
        firewallMode: this.readProcessFirewallMode(record.routing),
        hermesReferences: this.readProcessHermesReferences(record.routing),
        routing: record.routing
      };
      this.processes.set(entry.processId, entry);
      if (entry.status === "queued" || entry.status === "running") {
        entry.status = "failed";
        entry.cancelRequested = true;
        entry.endedAt = nowMs;
        entry.exitCode = entry.exitCode ?? 1;
        entry.signal = entry.signal ?? "NODE_RESTART";
        entry.logs = truncateOutput(`${entry.logs}
process recovered after node restart before completion
`, MAX_PROCESS_LOG_CHARS);
        if (entry.firewallMode !== "transparent") {
          const recoveredReference = this.createHermesReference({
            sourceType: "process.output",
            processId: entry.processId,
            toolName: "system.run",
            title: "process recovered after restart",
            safeSummary: this.buildSafeSummary(entry.logs),
            metadata: {
              mode: entry.firewallMode,
              status: entry.status,
              exitCode: entry.exitCode,
              signal: entry.signal
            }
          });
          entry.hermesReferences = [recoveredReference];
          const routing = asObject(entry.routing ?? {});
          entry.routing = {
            ...routing,
            firewallMode: entry.firewallMode,
            hermesReferences: entry.hermesReferences
          };
        }
        this.persistProcess(entry);
        this.queueTerminalProcessUpdate(entry, "recovered_after_restart");
      }
    }
    const pendingOutbox = this.stateStore.countUndelivered();
    this.log(
      `restored processes=${persisted.length} outbox_pending=${pendingOutbox} firewall_sessions_pruned=${prunedFirewallSessions}`
    );
  }
  async loadPolicyFromDisk() {
    const nowMs = Date.now();
    try {
      const raw = await fs.readFile(this.policyPath, "utf8");
      const parsed = asObject(JSON.parse(raw));
      this.policy = this.normalizePolicyDocument(parsed, nowMs);
      const stat = await fs.stat(this.policyPath);
      this.policyLoadedAtMs = stat.mtimeMs;
      this.policyDigest = this.policyDocDigest(this.policy);
      this.log(
        `loaded hermes policy path=${this.policyPath} firewall_mode=${this.currentPolicyFirewallMode()} default_quarantine=${this.currentPolicyDefaultQuarantine()}`
      );
      return;
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      const missing = code === "ENOENT";
      if (!missing && this.config.policyRequired) {
        throw new Error(
          `Failed to load required Hermes policy at ${this.policyPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (!missing) {
        this.log(
          `policy load failed path=${this.policyPath} error=${err instanceof Error ? err.message : String(err)}; using default policy`
        );
      } else if (this.config.policyRequired) {
        throw new Error(`Required Hermes policy missing at ${this.policyPath}`);
      } else {
        this.log(`policy file missing path=${this.policyPath}; creating default policy`);
      }
    }
    this.policy = this.normalizePolicyDocument({}, nowMs);
    await this.persistPolicyToDisk(this.policy);
  }
  async loadMcpBridgeConfig() {
    this.mcpBridgeServers.clear();
    if (!this.config.mcpBridgeEnabled) return;
    const resolved = path.resolve(this.mcpBridgeConfigPath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    let rawText = "";
    try {
      rawText = await fs.readFile(resolved, "utf8");
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      if (code !== "ENOENT") {
        throw new Error(
          `Failed to read MCP bridge config at ${resolved}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const bootstrap = {
        enabled: true,
        servers: []
      };
      await fs.writeFile(resolved, `${JSON.stringify(bootstrap, null, 2)}
`, "utf8");
      this.log(`mcp bridge config created path=${resolved} (empty server list)`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw new Error(
        `Invalid MCP bridge config JSON at ${resolved}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const root = asObject(parsed);
    const serversRaw = Array.isArray(root.servers) ? root.servers : [];
    for (const item of serversRaw) {
      const itemObj = asObject(item);
      if (asBoolean(itemObj.enabled) === false) continue;
      const server = this.parseMcpBridgeServerConfig(item, resolved);
      if (this.mcpBridgeServers.has(server.id)) {
        throw new Error(`Duplicate MCP bridge server id '${server.id}' in ${resolved}`);
      }
      this.mcpBridgeServers.set(server.id, server);
    }
    this.log(`mcp bridge loaded servers=${this.mcpBridgeServers.size} path=${resolved}`);
  }
  parseMcpBridgeServerConfig(value, sourcePath) {
    const obj = asObject(value);
    const id = asString(obj.id);
    const command = asString(obj.command);
    if (!id) {
      throw new Error(`MCP bridge server missing 'id' in ${sourcePath}`);
    }
    if (!command) {
      throw new Error(`MCP bridge server '${id}' missing 'command' in ${sourcePath}`);
    }
    const args = Array.isArray(obj.args) ? obj.args.filter((entry) => typeof entry === "string") : [];
    const env = asStringMap(obj.env);
    const timeoutMs = clampInt(obj.timeoutMs, 2e3, 3e5) ?? this.config.mcpBridgeTimeoutMs;
    const allowTools = normalizeMcpAllowPatterns(obj.allowTools);
    const allowResources = normalizeMcpAllowPatterns(obj.allowResources);
    return {
      id,
      label: asString(obj.label) ?? id,
      command,
      args,
      env,
      timeoutMs,
      allowTools,
      allowResources
    };
  }
  assertMcpBridgeEnabled(method) {
    if (this.config.mcpBridgeEnabled) return;
    throw new NodeToolError(
      "CAPABILITY_UNAVAILABLE",
      `Method ${method} is unavailable because MCP bridge is disabled on this node.`,
      false
    );
  }
  selectMcpBridgeServers(serverId) {
    if (serverId) {
      return [this.requireMcpBridgeServer(serverId)];
    }
    return [...this.mcpBridgeServers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  requireMcpBridgeServer(serverId) {
    const server = this.mcpBridgeServers.get(serverId);
    if (!server) {
      throw new NodeToolError("INVALID_REQUEST", `Unknown MCP bridge server '${serverId}'.`, false);
    }
    return server;
  }
  async getMcpBridgeClient(server) {
    const existing = this.mcpBridgeClients.get(server.id);
    if (existing) return existing;
    const McpStdioClientCtor = await this.loadMcpBridgeClientCtor();
    const client = new McpStdioClientCtor({
      command: server.command,
      args: server.args,
      env: server.env,
      timeoutMs: server.timeoutMs,
      log: (line) => this.log(`mcp[${server.id}] ${line}`)
    });
    try {
      await client.initialize();
      this.mcpBridgeClients.set(server.id, client);
      return client;
    } catch (err) {
      await client.close().catch(() => void 0);
      throw err;
    }
  }
  async loadMcpBridgeClientCtor() {
    if (!this.mcpBridgeClientCtorPromise) {
      this.mcpBridgeClientCtorPromise = import("./stdio-client-QQZZN3VS.mjs").then((mod) => {
        if (typeof mod.McpStdioClient !== "function") {
          throw new Error("McpStdioClient export missing");
        }
        return mod.McpStdioClient;
      }).catch((err) => {
        this.mcpBridgeClientCtorPromise = null;
        throw new NodeToolError(
          "CAPABILITY_UNAVAILABLE",
          `MCP bridge runtime unavailable: ${err instanceof Error ? err.message : String(err)}`,
          false
        );
      });
    }
    return this.mcpBridgeClientCtorPromise;
  }
  allowlistedMcpName(name, allowPatterns) {
    if (!allowPatterns.length) return false;
    return allowPatterns.some((pattern) => mcpPatternMatches(name, pattern));
  }
  async closeMcpBridgeClients() {
    for (const [serverId, client] of this.mcpBridgeClients.entries()) {
      await client.close().catch((err) => {
        this.log(`mcp[${serverId}] close failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    this.mcpBridgeClients.clear();
  }
  normalizePolicyDocument(value, nowMs) {
    const defaultQuarantine = parseQuarantineState(value.defaultQuarantine, "none");
    const firewallMode = parseFirewallMode(asString(value.firewallMode), "transparent");
    const denyCommands = parsePolicyDenyCommands(value.denyCommands) ?? [];
    const updatedAt = asNumber(value.updatedAt) ?? nowMs;
    const normalized = {
      version: asNumber(value.version) ?? 1,
      defaultQuarantine,
      firewallMode,
      denyCommands,
      updatedAt
    };
    const label = asString(value.label);
    if (label) normalized.label = label;
    return normalized;
  }
  policyDocDigest(policyDoc) {
    return createHash("sha256").update(JSON.stringify(policyDoc)).digest("hex");
  }
  async refreshPolicyFromDiskIfChanged(source) {
    try {
      const stat = await fs.stat(this.policyPath);
      if (this.policyLoadedAtMs !== null && stat.mtimeMs <= this.policyLoadedAtMs) return;
      const raw = await fs.readFile(this.policyPath, "utf8");
      const parsed = asObject(JSON.parse(raw));
      const nextPolicy = this.normalizePolicyDocument(parsed, Date.now());
      const nextDigest = this.policyDocDigest(nextPolicy);
      if (nextDigest === this.policyDigest) {
        this.policyLoadedAtMs = stat.mtimeMs;
        return;
      }
      const previousMode = this.currentPolicyFirewallMode();
      this.policy = nextPolicy;
      this.policyDigest = nextDigest;
      this.policyLoadedAtMs = stat.mtimeMs;
      this.log(
        `policy reload source=${source} path=${this.policyPath} firewall_mode=${this.currentPolicyFirewallMode()} default_quarantine=${this.currentPolicyDefaultQuarantine()}`
      );
      this.writeAuditEvent({
        type: "policy.reload",
        details: {
          source,
          firewallMode: this.currentPolicyFirewallMode(),
          defaultQuarantine: this.currentPolicyDefaultQuarantine(),
          denyCommands: this.currentPolicyDenyCommands(),
          policyPath: this.policyPath
        }
      });
      if (previousMode !== this.currentPolicyFirewallMode()) this.sendCapsAdvertise();
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      if (code === "ENOENT" && !this.config.policyRequired) return;
      throw new NodeToolError(
        "NODE_POLICY_RELOAD_FAILED",
        `Failed to refresh Hermes policy from disk: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  currentPolicyDefaultQuarantine() {
    return parseQuarantineState(this.policy.defaultQuarantine, "none");
  }
  currentPolicyFirewallMode() {
    return parseFirewallMode(asString(this.policy.firewallMode), "transparent");
  }
  currentPolicyDenyCommands() {
    return parsePolicyDenyCommands(this.policy.denyCommands) ?? [];
  }
  advertisedCapabilities() {
    const mode = this.currentPolicyFirewallMode();
    const out = new Set(this.config.capabilities);
    if (isAllowedCommand(FILE_PULL_COMMAND, this.config.allowCommands)) out.add("file.pull");
    if (isAllowedCommand(FILE_PUSH_COMMAND, this.config.allowCommands)) out.add("file.push");
    if (this.config.mcpBridgeEnabled) {
      out.add("mcp.bridge");
      out.add("mcp.list");
      out.add("mcp.call");
      out.add("mcp.resources");
    }
    out.add("backend.nexus");
    out.add(`hermes.mode.${mode}`);
    if (mode !== "transparent") out.add("hermes.enabled");
    return [...out.values()].sort((a, b) => a.localeCompare(b));
  }
  async persistPolicyToDisk(policyDoc) {
    const dirPath = path.dirname(this.policyPath);
    await fs.mkdir(dirPath, { recursive: true });
    const tempPath = `${this.policyPath}.tmp-${process2.pid}-${randomUUID().slice(0, 8)}`;
    const payload = `${JSON.stringify(policyDoc, null, 2)}
`;
    try {
      const fileHandle = await fs.open(tempPath, "w", 384);
      try {
        await fileHandle.writeFile(payload, "utf8");
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
      await fs.rename(tempPath, this.policyPath);
      try {
        const dirHandle = await fs.open(dirPath, "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
      }
      const stat = await fs.stat(this.policyPath);
      this.policyLoadedAtMs = stat.mtimeMs;
      this.policyDigest = this.policyDocDigest(policyDoc);
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => void 0);
      throw err;
    }
  }
  sendConnectHello() {
    const ws = this.requireOpenSocket();
    if (!ws) return;
    this.nodeNonce = randomBytes(32).toString("base64url");
    const firewallMode = this.currentPolicyFirewallMode();
    const advertisedCapabilities = this.advertisedCapabilities();
    this.sendSignedEnvelope({
      type: "req",
      id: randomUUID(),
      method: "connect.hello",
      params: {
        role: "node",
        displayName: this.config.displayName,
        version: "0.1.0",
        nodeId: this.config.nodeId,
        backend: "nexus",
        trustLevel: "standard",
        firewallMode,
        nodeNonce: this.nodeNonce,
        caps: advertisedCapabilities,
        capabilities: advertisedCapabilities,
        device: {
          id: this.identity.fingerprint,
          fingerprint: this.identity.fingerprint,
          publicKey: this.identity.publicKeyRaw,
          signedAt: Date.now()
        }
      }
    });
    this.log("sent connect.hello");
  }
  async handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log("received invalid JSON");
      return;
    }
    const envelope = asObject(parsed);
    const msg = parseEnvelope(envelope);
    if (!msg) {
      this.log("received invalid envelope");
      return;
    }
    if (!this.verifyGatewayEnvelope(msg, envelope)) {
      this.log("gateway envelope verification failed");
      this.closeSocket(4001, "invalid gateway signature");
      return;
    }
    if (msg.type === "event") {
      await this.handleEvent(msg);
      return;
    }
    if (msg.type === "req") {
      await this.handleRequest(msg);
      return;
    }
    await this.handleResponse(msg);
  }
  verifyGatewayEnvelope(msg, envelope) {
    if (!msg.sender.startsWith("gateway:")) return false;
    const skew = Math.abs(Date.now() - msg.ts);
    if (skew > this.config.maxClockSkewMs) {
      this.log(`rejecting message with timestamp skew=${skew}ms`);
      return false;
    }
    const challengeTrusted = this.trustGatewayIdentityFromChallenge(msg, envelope);
    if (!this.gatewayPublicKey) {
      return challengeTrusted;
    }
    if (verifyEnvelopeSignature(envelope, this.gatewayPublicKey)) {
      return true;
    }
    if (challengeTrusted) {
      this.log(`gateway signing key rotated to fingerprint=${this.gatewayFingerprint ?? "unknown"}`);
      return true;
    }
    return false;
  }
  trustGatewayIdentityFromChallenge(msg, envelope) {
    if (msg.type !== "event" || msg.event !== "connect.challenge") return false;
    const payload = asObject(msg.payload);
    const gatewayKeyRaw = asString(payload.gatewayPublicKey);
    if (!gatewayKeyRaw) return false;
    const parsed = parsePublicKey(gatewayKeyRaw);
    if (!parsed) return false;
    const claimedFingerprintRaw = asString(payload.gatewayFingerprint);
    const claimedFingerprint = claimedFingerprintRaw ? normalizeFingerprint256(claimedFingerprintRaw) : null;
    if (claimedFingerprintRaw && !claimedFingerprint) {
      this.log("connect.challenge carries invalid gatewayFingerprint format");
      return false;
    }
    const parsedFingerprint = normalizeFingerprint256(parsed.fingerprint);
    if (claimedFingerprint && parsedFingerprint && claimedFingerprint !== parsedFingerprint) {
      this.log(
        `connect.challenge gateway fingerprint mismatch claimed=${claimedFingerprint} parsed=${parsedFingerprint}`
      );
      return false;
    }
    const envelopeOk = verifyEnvelopeSignature(envelope, parsed.key);
    if (!envelopeOk) return false;
    this.gatewayPublicKey = parsed.key;
    this.gatewayFingerprint = parsed.fingerprint;
    return true;
  }
  async handleEvent(msg) {
    switch (msg.event) {
      case "connect.challenge":
        await this.handleConnectChallenge(msg);
        return;
      case "connect.accept":
        this.ready = true;
        this.log("received connect.accept; session ready");
        this.sendCapsAdvertise();
        this.drainOutbox("connect.accept");
        return;
      default:
        this.log(`event=${msg.event}`);
    }
  }
  async handleConnectChallenge(msg) {
    if (!this.nodeNonce || !this.gatewayPublicKey) {
      this.log("challenge received before hello state was initialized");
      return;
    }
    const payload = asObject(msg.payload);
    const gatewayNonce = asString(payload.gatewayNonce);
    const gatewayProofSig = asString(payload.gatewayProofSig);
    const sessionId = asString(payload.sessionId);
    if (!gatewayNonce || !gatewayProofSig || !sessionId) {
      this.log("challenge payload is missing required fields");
      return;
    }
    const transcript = buildHandshakeTranscript({
      nodeId: this.config.nodeId,
      sessionId,
      nodeNonce: this.nodeNonce,
      gatewayNonce
    });
    if (!this.config.insecureSkipGatewayProof) {
      const proofOk = verifyDetachedPayload(transcript, gatewayProofSig, this.gatewayPublicKey);
      if (!proofOk) {
        this.log("gateway proof signature validation failed");
        this.closeSocket(4001, "invalid gateway proof");
        return;
      }
    }
    this.sessionId = sessionId;
    this.gatewayNonce = gatewayNonce;
    const nodeProofSig = signDetachedPayload(transcript, this.identity.privateKey);
    this.sendSignedEnvelope({
      type: "req",
      id: randomUUID(),
      method: "connect.prove",
      params: {
        nodeProofSig,
        permissions: {
          "system.run": true,
          "system.which": true,
          "process.start": true,
          "process.status": true,
          "process.logs": true,
          "process.cancel": true
        },
        nodeNonce: this.nodeNonce,
        gatewayNonce
      }
    });
    this.log(
      `sent connect.prove session=${sessionId} gateway_fingerprint=${this.gatewayFingerprint ?? "unknown"}`
    );
  }
  async handleResponse(msg) {
    if (msg.ok) {
      const payload = asObject(msg.payload);
      const status = asString(payload.status);
      if (status === "ready") {
        this.ready = true;
        this.log("gateway response status=ready");
        this.sendCapsAdvertise();
        this.drainOutbox("response.ready");
      }
      return;
    }
    const code = asString(asObject(msg.error).code) ?? "ERROR";
    const message = asString(asObject(msg.error).message) ?? "unknown error";
    this.log(`response error code=${code} message=${message}`);
    if (code === "PAIRING_PENDING" || code === "PAIRING_REQUIRED" || code === "AUTH_INVALID") {
      this.scheduleReconnect();
    }
  }
  async handleRequest(msg) {
    switch (msg.method) {
      case "ping":
        this.sendSignedEnvelope({
          type: "res",
          id: msg.id,
          ok: true,
          payload: { pong: true, ts: Date.now() }
        });
        return;
      case "tool.execute":
        await this.handleToolExecute(msg);
        return;
      case "process.start":
        await this.handleProcessStart(msg);
        return;
      case "process.status":
        await this.handleProcessStatus(msg);
        return;
      case "process.logs":
        await this.handleProcessLogs(msg);
        return;
      case "process.cancel":
        await this.handleProcessCancel(msg);
        return;
      case "process.ack":
        await this.handleProcessAck(msg);
        return;
      case "symbols.list":
        await this.handleSymbolsList(msg);
        return;
      case "audit.query":
        await this.handleAuditQuery(msg);
        return;
      case "mcp.list":
        await this.handleMcpList(msg);
        return;
      case "mcp.call":
        await this.handleMcpCall(msg);
        return;
      case "mcp.resources":
        await this.handleMcpResources(msg);
        return;
      case "file.pull":
        await this.handleFilePull(msg);
        return;
      case "file.push":
        await this.handleFilePush(msg);
        return;
      default:
        this.sendRequestError(msg.id, "METHOD_NOT_IMPLEMENTED", `Method ${msg.method} is not implemented by reference node.`, false);
    }
  }
  async handleToolExecute(msg) {
    const params = asObject(msg.params);
    const tool = asString(params.tool);
    const args = asObject(params.args);
    const routing = asObject(params.routing);
    if (!tool) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "tool.execute requires a tool name", false);
      return;
    }
    try {
      await this.refreshPolicyFromDiskIfChanged("tool.execute");
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
      return;
    }
    try {
      let output = "";
      if (tool === "system.which") {
        output = await this.execSystemWhich(args);
      } else if (tool === "system.run") {
        output = await this.execSystemRun({
          ...args,
          ...Object.keys(routing).length > 0 ? { routing } : {}
        });
      } else {
        throw new NodeToolError("CAPABILITY_UNAVAILABLE", `Tool ${tool} is not supported by this reference node.`);
      }
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          output
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleProcessStart(msg) {
    var _a, _b, _c, _d;
    const params = asObject(msg.params);
    const tool = asString(params.tool) ?? "system.run";
    if (tool !== "system.run") {
      this.sendRequestError(msg.id, "CAPABILITY_UNAVAILABLE", `process.start only supports system.run (got ${tool}).`, false);
      return;
    }
    const runArgs = asObject(params.args);
    const command = asString(runArgs.command);
    if (!command) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.start requires args.command.", false);
      return;
    }
    const commandValidation = validateAllowlistedCommand(command, this.config.allowCommands);
    if (!commandValidation.ok) {
      this.sendRequestError(msg.id, "PERMISSION_DENIED", commandValidation.message, false);
      return;
    }
    const commandName = commandValidation.commandName;
    try {
      await this.refreshPolicyFromDiskIfChanged("process.start");
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
      return;
    }
    const cwd = asString(runArgs.cwd) ?? null;
    const env = asStringMap(runArgs.env);
    const timeoutMs = clampInt(runArgs.timeoutMs ?? runArgs.timeout, 1e3, this.config.runTimeoutMs) ?? null;
    const firewallMode = this.currentPolicyFirewallMode();
    let executionCommand = command;
    let executionCwd = cwd;
    let executionEnv = env;
    let resolvedSymbols = [];
    if (firewallMode !== "transparent") {
      let resolvedInvocation;
      try {
        resolvedInvocation = await this.resolveSystemRunInvocation({
          command,
          cwd,
          env
        });
      } catch (err) {
        this.writeAuditEvent({
          type: "symbol.resolve.failed",
          toolName: "process.start",
          details: {
            code: err instanceof NodeToolError ? err.code : "NODE_EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err)
          }
        });
        this.sendToolExecutionError(msg.id, err);
        return;
      }
      executionCommand = resolvedInvocation.command;
      executionCwd = resolvedInvocation.cwd;
      executionEnv = resolvedInvocation.env;
      resolvedSymbols = resolvedInvocation.symbols;
    }
    const routingObj = asObject(params.routing);
    const routing = {
      ...routingObj,
      firewallMode
    };
    if (firewallMode === "transparent") {
      delete routing.firewallSession;
      delete routing.firewallQuarantine;
    }
    const resolvedFirewallSession = firewallMode === "transparent" ? null : this.resolveFirewallSession(routingObj);
    if (resolvedFirewallSession) {
      routing.firewallSession = resolvedFirewallSession.sessionId;
      routing.firewallQuarantine = resolvedFirewallSession.quarantineState;
    }
    const processId = `proc_${randomUUID().slice(0, 12)}`;
    try {
      this.enforceHermesCommandPolicy({
        toolName: "process.start",
        commandName,
        firewallMode,
        processId,
        firewallSession: (resolvedFirewallSession == null ? void 0 : resolvedFirewallSession.sessionId) ?? null
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
      return;
    }
    const entry = {
      processId,
      command,
      cwd,
      status: "queued",
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      cancelRequested: false,
      timeoutMs,
      logs: "",
      child: null,
      timeoutTimer: null,
      killTimer: null,
      firewallMode,
      hermesReferences: [],
      routing: Object.keys(routing).length > 0 ? routing : null
    };
    this.processes.set(processId, entry);
    this.persistProcess(entry);
    this.writeAuditEvent({
      type: "process.start.requested",
      processId,
      firewallSession: (resolvedFirewallSession == null ? void 0 : resolvedFirewallSession.sessionId) ?? null,
      toolName: "system.run",
      details: {
        commandName,
        symbolCount: resolvedSymbols.length,
        symbols: resolvedSymbols,
        firewallMode
      }
    });
    if (commandName === POLICYCTL_COMMAND) {
      try {
        entry.status = "running";
        entry.startedAt = Date.now();
        this.persistProcess(entry);
        this.emitProcessUpdate(entry, "running");
        const output = await this.execPolicyCtlCommand({
          command: executionCommand,
          routing,
          toolName: "process.start",
          processId,
          firewallSession: (resolvedFirewallSession == null ? void 0 : resolvedFirewallSession.sessionId) ?? null,
          firewallMode
        });
        if (output) this.appendProcessLog(entry, `${output}
`, "stdout");
        this.finishProcess(entry, 0, null);
        this.sendSignedEnvelope({
          type: "res",
          id: msg.id,
          ok: true,
          payload: {
            processId,
            status: entry.status,
            startedAt: entry.startedAt,
            command,
            firewallMode,
            ...resolvedFirewallSession ? {
              firewallSession: resolvedFirewallSession.sessionId,
              firewallSessionReused: resolvedFirewallSession.reused,
              firewallQuarantine: resolvedFirewallSession.quarantineState
            } : {},
            ...firewallMode !== "transparent" ? {
              hermes: {
                mode: firewallMode,
                sanitized: true,
                references: []
              }
            } : {}
          }
        });
      } catch (err) {
        this.processes.delete(processId);
        this.stateStore.removeProcess(processId);
        this.sendToolExecutionError(msg.id, err);
      }
      return;
    }
    try {
      const child = spawnChild(executionCommand, {
        shell: true,
        cwd: executionCwd ?? void 0,
        env: Object.keys(executionEnv).length > 0 ? { ...process2.env, ...executionEnv } : process2.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      entry.child = child;
      entry.status = "running";
      entry.startedAt = Date.now();
      this.persistProcess(entry);
      this.emitProcessUpdate(entry, "running");
      (_a = child.stdout) == null ? void 0 : _a.on("data", (chunk) => {
        this.appendProcessLog(entry, String(chunk), "stdout");
      });
      (_b = child.stderr) == null ? void 0 : _b.on("data", (chunk) => {
        this.appendProcessLog(entry, String(chunk), "stderr");
      });
      child.on("error", (err) => {
        this.appendProcessLog(entry, `process error: ${err instanceof Error ? err.message : String(err)}
`, "stderr");
      });
      child.on("close", (code, signal) => {
        this.finishProcess(entry, code, signal);
      });
      if (timeoutMs && timeoutMs > 0) {
        entry.timeoutTimer = setTimeout(() => {
          if (entry.status !== "running") return;
          this.appendProcessLog(entry, `process timeout exceeded (${timeoutMs}ms); terminating
`, "stderr");
          this.cancelProcess(entry, {
            signal: "SIGTERM",
            reason: "timeout",
            killAfterMs: 5e3
          });
        }, timeoutMs);
        (_d = (_c = entry.timeoutTimer).unref) == null ? void 0 : _d.call(_c);
      }
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          processId,
          status: entry.status,
          startedAt: entry.startedAt,
          command,
          firewallMode,
          ...resolvedFirewallSession ? {
            firewallSession: resolvedFirewallSession.sessionId,
            firewallSessionReused: resolvedFirewallSession.reused,
            firewallQuarantine: resolvedFirewallSession.quarantineState
          } : {},
          ...firewallMode !== "transparent" ? {
            hermes: {
              mode: firewallMode,
              sanitized: true,
              references: []
            }
          } : {}
        }
      });
    } catch (err) {
      this.processes.delete(processId);
      this.stateStore.removeProcess(processId);
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleProcessStatus(msg) {
    const params = asObject(msg.params);
    const processId = asString(params.processId) ?? asString(params.id);
    if (!processId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.status requires processId.", false);
      return;
    }
    const entry = this.processes.get(processId);
    if (!entry) {
      this.sendRequestError(msg.id, "PROCESS_NOT_FOUND", `Process ${processId} was not found.`, false);
      return;
    }
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: this.serializeProcess(entry, false)
    });
  }
  async handleProcessLogs(msg) {
    const params = asObject(msg.params);
    const processId = asString(params.processId) ?? asString(params.id);
    if (!processId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.logs requires processId.", false);
      return;
    }
    const entry = this.processes.get(processId);
    if (!entry) {
      this.sendRequestError(msg.id, "PROCESS_NOT_FOUND", `Process ${processId} was not found.`, false);
      return;
    }
    const maxChars = clampInt(params.maxChars, 200, MAX_OUTPUT_CHARS) ?? 8e3;
    const logs = entry.logs.length > maxChars ? entry.logs.slice(-maxChars) : entry.logs;
    if (entry.firewallMode !== "transparent") {
      const references = this.resolveProcessHermesReferences(entry);
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          processId,
          status: entry.status,
          logs: this.buildSafeSummary(logs),
          totalChars: entry.logs.length,
          truncated: entry.logs.length > maxChars,
          firewallMode: entry.firewallMode,
          firewallSession: asString(asObject(entry.routing ?? {}).firewallSession),
          hermes: {
            mode: entry.firewallMode,
            sanitized: true,
            references
          }
        }
      });
      return;
    }
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        processId,
        status: entry.status,
        logs,
        totalChars: entry.logs.length,
        truncated: entry.logs.length > maxChars
      }
    });
  }
  async handleProcessCancel(msg) {
    const params = asObject(msg.params);
    const processId = asString(params.processId) ?? asString(params.id);
    if (!processId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.cancel requires processId.", false);
      return;
    }
    const entry = this.processes.get(processId);
    if (!entry) {
      this.sendRequestError(msg.id, "PROCESS_NOT_FOUND", `Process ${processId} was not found.`, false);
      return;
    }
    const signal = normalizeSignal(asString(params.signal)) ?? "SIGTERM";
    const reason = asString(params.reason) ?? "gateway_cancel";
    const killAfterMs = clampInt(params.killAfterMs, 0, 6e4) ?? 5e3;
    this.cancelProcess(entry, { signal, reason, killAfterMs });
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        processId,
        status: entry.status === "running" ? "cancelling" : entry.status,
        signal,
        reason
      }
    });
  }
  async handleProcessAck(msg) {
    const params = asObject(msg.params);
    const deliveryId = asString(params.deliveryId);
    if (!deliveryId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.ack requires deliveryId.", false);
      return;
    }
    const processId = asString(params.processId) ?? void 0;
    const nowMs = Date.now();
    const acknowledged = this.stateStore.markOutboxDelivered(deliveryId, nowMs);
    this.stateStore.pruneDeliveredOlderThan(nowMs - DELIVERED_OUTBOX_TTL_MS);
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        deliveryId,
        processId: processId ?? null,
        acknowledged
      }
    });
  }
  async execPolicyCtlCommand(params) {
    const parsed = parsePolicyCtlCommand(params.command);
    const provenance = {
      runId: asString(params.routing.runId),
      parentRunId: asString(params.routing.parentRunId),
      sessionId: asString(params.routing.sessionId),
      channel: asString(params.routing.channel),
      channelKey: asString(params.routing.channelKey)
    };
    if (parsed.action === "show") {
      this.writeAuditEvent({
        type: "policy.command.show",
        processId: params.processId ?? null,
        firewallSession: params.firewallSession ?? null,
        actor: this.formatPolicyMutationActor(provenance),
        toolName: params.toolName,
        details: {
          command: params.command,
          firewallMode: params.firewallMode,
          policyPath: this.policyPath,
          policyDigest: `sha256:${this.policyDocDigest(this.policy)}`,
          provenance
        }
      });
      return JSON.stringify(
        {
          ok: true,
          action: "show",
          policyPath: this.policyPath,
          policyPresetDir: this.policyPresetDir,
          policyDigest: `sha256:${this.policyDocDigest(this.policy)}`,
          policy: this.policy
        },
        null,
        2
      );
    }
    const mutationSource = parsed.action === "apply-preset" ? "policyctl.apply-preset" : "policyctl.patch";
    let patch = {};
    if (parsed.action === "apply-preset") {
      const presetPath = resolvePolicyPresetPath(this.policyPresetDir, parsed.presetName);
      let raw = "";
      try {
        raw = await fs.readFile(presetPath, "utf8");
      } catch (err) {
        throw new NodeToolError(
          "POLICY_PRESET_NOT_FOUND",
          `Policy preset "${parsed.presetName}" was not found at ${presetPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        patch = asObject(JSON.parse(raw));
      } catch (err) {
        throw new NodeToolError(
          "POLICY_PRESET_INVALID",
          `Policy preset "${parsed.presetName}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else if (parsed.action === "set-mode") {
      patch = { firewallMode: parsed.mode };
    } else if (parsed.action === "deny-add") {
      patch = {
        denyCommands: [.../* @__PURE__ */ new Set([...this.currentPolicyDenyCommands(), parsed.commandName])].sort(
          (a, b) => a.localeCompare(b)
        )
      };
    } else {
      patch = {
        denyCommands: this.currentPolicyDenyCommands().filter((entry) => entry !== parsed.commandName).sort((a, b) => a.localeCompare(b))
      };
    }
    const applied = await this.applyPolicyPatch({
      patch,
      source: mutationSource,
      command: params.command,
      breakGlass: parsed.breakGlass,
      toolName: params.toolName,
      processId: params.processId ?? null,
      firewallSession: params.firewallSession ?? null,
      provenance
    });
    return JSON.stringify(
      {
        ok: true,
        action: parsed.action,
        changed: applied.changed,
        breakGlass: parsed.breakGlass,
        source: mutationSource,
        changedFields: applied.changedFields,
        policyPath: this.policyPath,
        policyDigestBefore: `sha256:${applied.digestBefore}`,
        policyDigestAfter: `sha256:${applied.digestAfter}`,
        defaultQuarantine: this.currentPolicyDefaultQuarantine(),
        firewallMode: this.currentPolicyFirewallMode(),
        denyCommands: this.currentPolicyDenyCommands()
      },
      null,
      2
    );
  }
  async applyPolicyPatch(params) {
    this.assertPolicyPatchShape(params.patch);
    const nowMs = Date.now();
    const current = this.normalizePolicyDocument(this.policy, nowMs);
    const next = this.normalizePolicyDocument(
      {
        ...current,
        ...params.patch
      },
      nowMs
    );
    const changedFields = this.policyChangedFields(current, next);
    const digestBefore = this.policyDocDigest(current);
    const digestAfter = this.policyDocDigest(next);
    if (changedFields.length === 0) {
      return {
        changed: false,
        changedFields: [],
        digestBefore,
        digestAfter
      };
    }
    const previousMode = parseFirewallMode(asString(current.firewallMode), "transparent");
    const nextMode = parseFirewallMode(asString(next.firewallMode), "transparent");
    if (firewallModeStrength(nextMode) < firewallModeStrength(previousMode) && !params.breakGlass) {
      throw new NodeToolError(
        "POLICY_MUTATION_DENIED",
        `Policy downgrade ${previousMode} -> ${nextMode} requires --break-glass.`
      );
    }
    const currentDeny = parsePolicyDenyCommands(current.denyCommands) ?? [];
    const nextDeny = parsePolicyDenyCommands(next.denyCommands) ?? [];
    if (nextDeny.length > 128) {
      throw new NodeToolError("INVALID_REQUEST", "denyCommands cannot exceed 128 entries.");
    }
    if (currentDeny.length > 0 && nextDeny.length === 0 && !params.breakGlass) {
      throw new NodeToolError(
        "POLICY_MUTATION_DENIED",
        "Clearing denyCommands requires --break-glass when denyCommands is currently non-empty."
      );
    }
    await this.persistPolicyToDisk(next);
    this.policy = next;
    this.log(
      `policy command applied source=${params.source} firewall_mode=${this.currentPolicyFirewallMode()} default_quarantine=${this.currentPolicyDefaultQuarantine()} deny_commands=${this.currentPolicyDenyCommands().join(",") || "-"}`
    );
    this.writeAuditEvent({
      type: "policy.command.applied",
      processId: params.processId,
      firewallSession: params.firewallSession,
      actor: this.formatPolicyMutationActor(params.provenance),
      toolName: params.toolName,
      details: {
        source: params.source,
        command: params.command,
        breakGlass: params.breakGlass,
        changedFields,
        previousFirewallMode: previousMode,
        firewallMode: this.currentPolicyFirewallMode(),
        defaultQuarantine: this.currentPolicyDefaultQuarantine(),
        denyCommands: this.currentPolicyDenyCommands(),
        policyPath: this.policyPath,
        digestBefore: `sha256:${digestBefore}`,
        digestAfter: `sha256:${this.policyDocDigest(this.policy)}`,
        provenance: params.provenance
      }
    });
    if (previousMode !== nextMode) this.sendCapsAdvertise();
    return {
      changed: true,
      changedFields,
      digestBefore,
      digestAfter: this.policyDocDigest(this.policy)
    };
  }
  assertPolicyPatchShape(patch) {
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} requires a non-empty policy patch.`);
    }
    for (const key of keys) {
      if (!POLICY_ALLOWED_FIELDS.has(key)) {
        throw new NodeToolError(
          "INVALID_REQUEST",
          `${POLICYCTL_COMMAND} does not allow policy field "${key}". Allowed fields: ${[...POLICY_ALLOWED_FIELDS.values()].join(", ")}.`
        );
      }
    }
    if ("defaultQuarantine" in patch) {
      const value = asString(patch.defaultQuarantine);
      if (!value || value !== "none" && value !== "soft" && value !== "hard") {
        throw new NodeToolError(
          "INVALID_REQUEST",
          `${POLICYCTL_COMMAND} defaultQuarantine must be one of: none, soft, hard.`
        );
      }
    }
    if ("firewallMode" in patch) {
      const value = asString(patch.firewallMode);
      if (!value || value !== "transparent" && value !== "audit-only" && value !== "hermes") {
        throw new NodeToolError(
          "INVALID_REQUEST",
          `${POLICYCTL_COMMAND} firewallMode must be one of: transparent, audit-only, hermes.`
        );
      }
    }
    if ("denyCommands" in patch && parsePolicyDenyCommands(patch.denyCommands) === null) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} denyCommands must be an array of command names.`);
    }
    if ("version" in patch) {
      const version = asNumber(patch.version);
      if (version === null || !Number.isInteger(version) || version <= 0) {
        throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} version must be a positive integer.`);
      }
    }
    if ("label" in patch) {
      const label = asString(patch.label);
      if (!label || label.length > 120) {
        throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} label must be a non-empty string up to 120 chars.`);
      }
    }
    if ("updatedAt" in patch) {
      const updatedAt = asNumber(patch.updatedAt);
      if (updatedAt === null || !Number.isInteger(updatedAt) || updatedAt < 0) {
        throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} updatedAt must be a non-negative integer.`);
      }
    }
  }
  policyChangedFields(current, next) {
    const fields = ["version", "label", "defaultQuarantine", "firewallMode", "denyCommands"];
    const changed = [];
    for (const field of fields) {
      if (JSON.stringify(current[field] ?? null) !== JSON.stringify(next[field] ?? null)) changed.push(field);
    }
    return changed;
  }
  formatPolicyMutationActor(provenance) {
    const parts = [this.senderId];
    if (provenance.channel) parts.push(`channel=${provenance.channel}`);
    if (provenance.channelKey) parts.push(`channelKey=${provenance.channelKey}`);
    if (provenance.sessionId) parts.push(`session=${provenance.sessionId}`);
    if (provenance.runId) parts.push(`run=${provenance.runId}`);
    return parts.join(" ");
  }
  shellCtlRootDir() {
    return path.join(this.config.stateDir, SHELLCTL_ROOT_DIRNAME);
  }
  shellCtlMetaDir() {
    return path.join(this.shellCtlRootDir(), SHELLCTL_SESSION_DIRNAME);
  }
  shellCtlLogDir() {
    return path.join(this.shellCtlRootDir(), SHELLCTL_LOG_DIRNAME);
  }
  shellCtlMetaPath(sessionId) {
    return path.join(this.shellCtlMetaDir(), `${sessionId}.json`);
  }
  shellCtlLogPath(sessionId) {
    return path.join(this.shellCtlLogDir(), `${sessionId}.log`);
  }
  async shellCtlEnsureDirs() {
    await fs.mkdir(this.shellCtlMetaDir(), { recursive: true });
    await fs.mkdir(this.shellCtlLogDir(), { recursive: true });
  }
  async shellCtlLoadMeta(sessionId) {
    try {
      const raw = await fs.readFile(this.shellCtlMetaPath(sessionId), "utf8");
      const parsed = asObject(JSON.parse(raw));
      const parsedSessionId = asString(parsed.sessionId);
      const tmuxSession = asString(parsed.tmuxSession);
      const cwd = asString(parsed.cwd);
      const logPath = asString(parsed.logPath);
      const createdAt = asNumber(parsed.createdAt);
      const updatedAt = asNumber(parsed.updatedAt);
      if (!parsedSessionId || !tmuxSession || !cwd || !logPath) return null;
      return {
        sessionId: parsedSessionId,
        tmuxSession,
        cwd,
        logPath,
        createdAt: createdAt ?? Date.now(),
        updatedAt: updatedAt ?? Date.now()
      };
    } catch {
      return null;
    }
  }
  async shellCtlSaveMeta(meta) {
    await this.shellCtlEnsureDirs();
    await fs.writeFile(this.shellCtlMetaPath(meta.sessionId), JSON.stringify(meta, null, 2), { mode: 384 });
  }
  async shellCtlDeleteMeta(sessionId) {
    try {
      await fs.rm(this.shellCtlMetaPath(sessionId), { force: true });
    } catch {
    }
  }
  async shellCtlFileSize(filePath) {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return 0;
      return stat.size;
    } catch {
      return 0;
    }
  }
  async shellCtlEnsureTmux() {
    const probe = await runTmuxCommand(["-V"]);
    if (probe.ok) return;
    if (probe.rawCode === "ENOENT") {
      throw new NodeToolError("CAPABILITY_UNAVAILABLE", `${SHELLCTL_COMMAND} requires tmux to be installed on the node.`);
    }
    const detail = [probe.errorMessage, probe.stderr].filter(Boolean).join(" | ");
    throw new NodeToolError("NODE_EXECUTION_FAILED", `tmux probe failed: ${truncateOutput(detail || "unknown error", 500)}`);
  }
  async shellCtlHasSession(tmuxSession) {
    const result = await runTmuxCommand(["has-session", "-t", tmuxSession]);
    return result.ok;
  }
  async shellCtlReadTimedOutput(params) {
    await fs.mkdir(path.dirname(params.logPath), { recursive: true });
    try {
      await fs.access(params.logPath);
    } catch {
      await fs.writeFile(params.logPath, "", { mode: 384 });
    }
    let startCursor = Math.max(0, Math.floor(params.cursor));
    const initialSize = await this.shellCtlFileSize(params.logPath);
    let resetCursor = false;
    if (startCursor > initialSize) {
      startCursor = 0;
      resetCursor = true;
    }
    const deadline = Date.now() + Math.max(0, params.waitMs);
    let observedSize = await this.shellCtlFileSize(params.logPath);
    let hasNewOutput = observedSize > startCursor;
    while (!hasNewOutput && Date.now() < deadline) {
      await sleepMs(SHELLCTL_POLL_INTERVAL_MS);
      observedSize = await this.shellCtlFileSize(params.logPath);
      hasNewOutput = observedSize > startCursor;
    }
    let finalSize = observedSize;
    if (hasNewOutput && params.idleMs > 0) {
      let quietUntil = Date.now() + params.idleMs;
      while (Date.now() < deadline && Date.now() < quietUntil) {
        await sleepMs(SHELLCTL_POLL_INTERVAL_MS);
        const nextSize = await this.shellCtlFileSize(params.logPath);
        if (nextSize > finalSize) {
          finalSize = nextSize;
          quietUntil = Date.now() + params.idleMs;
        }
      }
    }
    const bytesAvailable = Math.max(0, finalSize - startCursor);
    const maxBytes = Math.max(256, Math.min(SHELLCTL_MAX_READ_BYTES, params.maxChars * 4));
    const bytesToRead = Math.min(bytesAvailable, maxBytes);
    const nextCursor = startCursor + bytesToRead;
    let output = "";
    if (bytesToRead > 0) {
      const handle = await fs.open(params.logPath, "r");
      try {
        const buf = Buffer.alloc(bytesToRead);
        const { bytesRead } = await handle.read(buf, 0, bytesToRead, startCursor);
        output = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    }
    return {
      output,
      nextCursor,
      totalBytes: finalSize,
      truncated: nextCursor < finalSize,
      resetCursor
    };
  }
  async execShellCtlCommand(params) {
    const parsed = parseShellCtlCommand(params.command);
    if (parsed.action === "list") {
      await this.shellCtlEnsureDirs();
      const files = await fs.readdir(this.shellCtlMetaDir());
      const sessions = [];
      for (const entry of files.sort((a, b) => a.localeCompare(b))) {
        if (!entry.endsWith(".json")) continue;
        const sessionId = entry.slice(0, -5);
        const meta2 = await this.shellCtlLoadMeta(sessionId);
        if (!meta2) continue;
        sessions.push({
          session: sessionId,
          cwd: meta2.cwd,
          running: await this.shellCtlHasSession(meta2.tmuxSession),
          logBytes: await this.shellCtlFileSize(meta2.logPath),
          createdAt: meta2.createdAt,
          updatedAt: meta2.updatedAt
        });
      }
      return JSON.stringify(
        {
          ok: true,
          action: "list",
          count: sessions.length,
          sessions
        },
        null,
        2
      );
    }
    if (parsed.action === "open") {
      await this.shellCtlEnsureTmux();
      await this.shellCtlEnsureDirs();
      const existingMeta = await this.shellCtlLoadMeta(parsed.sessionId);
      if (existingMeta && await this.shellCtlHasSession(existingMeta.tmuxSession)) {
        return JSON.stringify(
          {
            ok: true,
            action: "open",
            session: parsed.sessionId,
            existed: true,
            cwd: existingMeta.cwd,
            cursor: await this.shellCtlFileSize(existingMeta.logPath)
          },
          null,
          2
        );
      }
      if (existingMeta) {
        await this.shellCtlDeleteMeta(parsed.sessionId);
      }
      const cwd = parsed.cwd ? path.resolve(path.isAbsolute(parsed.cwd) ? parsed.cwd : path.join(this.config.stateDir, parsed.cwd)) : this.config.stateDir;
      let cwdStat;
      try {
        cwdStat = await fs.stat(cwd);
      } catch (err) {
        throw new NodeToolError("INVALID_REQUEST", `open cwd does not exist: ${cwd} (${err instanceof Error ? err.message : String(err)})`);
      }
      if (!cwdStat.isDirectory()) {
        throw new NodeToolError("INVALID_REQUEST", `open cwd is not a directory: ${cwd}`);
      }
      const tmuxSession = shellCtlSessionNameFromId(parsed.sessionId);
      const logPath = this.shellCtlLogPath(parsed.sessionId);
      await fs.writeFile(logPath, "", { mode: 384 });
      const createRes = await runTmuxCommand(["new-session", "-d", "-s", tmuxSession, "-c", cwd]);
      if (!createRes.ok) {
        const detail = [createRes.errorMessage, createRes.stderr].filter(Boolean).join(" | ");
        throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to open tmux session: ${truncateOutput(detail || "unknown error", 500)}`);
      }
      await runTmuxCommand(["set-option", "-t", tmuxSession, "history-limit", "200000"]);
      const pipeCommand = `cat >> ${shellEscape(logPath)}`;
      const pipeRes = await runTmuxCommand(["pipe-pane", "-o", "-t", `${tmuxSession}:0.0`, pipeCommand]);
      if (!pipeRes.ok) {
        await runTmuxCommand(["kill-session", "-t", tmuxSession]);
        const detail = [pipeRes.errorMessage, pipeRes.stderr].filter(Boolean).join(" | ");
        throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to attach tmux output pipe: ${truncateOutput(detail || "unknown error", 500)}`);
      }
      const now = Date.now();
      await this.shellCtlSaveMeta({
        sessionId: parsed.sessionId,
        tmuxSession,
        cwd,
        logPath,
        createdAt: now,
        updatedAt: now
      });
      return JSON.stringify(
        {
          ok: true,
          action: "open",
          session: parsed.sessionId,
          existed: false,
          cwd,
          cursor: 0
        },
        null,
        2
      );
    }
    if (parsed.action === "send") {
      await this.shellCtlEnsureTmux();
      const meta2 = await this.shellCtlLoadMeta(parsed.sessionId);
      if (!meta2) {
        throw new NodeToolError("INVALID_REQUEST", `interactive session not found: ${parsed.sessionId}`);
      }
      if (!await this.shellCtlHasSession(meta2.tmuxSession)) {
        throw new NodeToolError("PROCESS_NOT_FOUND", `interactive session is not running: ${parsed.sessionId}`);
      }
      const target = `${meta2.tmuxSession}:0.0`;
      const sendRes = await runTmuxCommand(["send-keys", "-t", target, "-l", parsed.payload]);
      if (!sendRes.ok) {
        const detail = [sendRes.errorMessage, sendRes.stderr].filter(Boolean).join(" | ");
        throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to send tmux input: ${truncateOutput(detail || "unknown error", 500)}`);
      }
      if (parsed.enter) {
        const enterRes = await runTmuxCommand(["send-keys", "-t", target, "Enter"]);
        if (!enterRes.ok) {
          const detail = [enterRes.errorMessage, enterRes.stderr].filter(Boolean).join(" | ");
          throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to send Enter key: ${truncateOutput(detail || "unknown error", 500)}`);
        }
      }
      meta2.updatedAt = Date.now();
      await this.shellCtlSaveMeta(meta2);
      return JSON.stringify(
        {
          ok: true,
          action: "send",
          session: parsed.sessionId,
          enter: parsed.enter,
          cursor: await this.shellCtlFileSize(meta2.logPath)
        },
        null,
        2
      );
    }
    if (parsed.action === "read") {
      const meta2 = await this.shellCtlLoadMeta(parsed.sessionId);
      if (!meta2) {
        throw new NodeToolError("INVALID_REQUEST", `interactive session not found: ${parsed.sessionId}`);
      }
      const read = await this.shellCtlReadTimedOutput({
        logPath: meta2.logPath,
        cursor: parsed.cursor,
        waitMs: parsed.waitMs,
        idleMs: parsed.idleMs,
        maxChars: parsed.maxChars
      });
      const running2 = await this.shellCtlHasSession(meta2.tmuxSession);
      meta2.updatedAt = Date.now();
      await this.shellCtlSaveMeta(meta2);
      return JSON.stringify(
        {
          ok: true,
          action: "read",
          session: parsed.sessionId,
          output: read.output,
          nextCursor: read.nextCursor,
          totalBytes: read.totalBytes,
          truncated: read.truncated,
          resetCursor: read.resetCursor,
          running: running2
        },
        null,
        2
      );
    }
    if (parsed.action === "interrupt") {
      await this.shellCtlEnsureTmux();
      const meta2 = await this.shellCtlLoadMeta(parsed.sessionId);
      if (!meta2) {
        throw new NodeToolError("INVALID_REQUEST", `interactive session not found: ${parsed.sessionId}`);
      }
      if (!await this.shellCtlHasSession(meta2.tmuxSession)) {
        throw new NodeToolError("PROCESS_NOT_FOUND", `interactive session is not running: ${parsed.sessionId}`);
      }
      const res = await runTmuxCommand(["send-keys", "-t", `${meta2.tmuxSession}:0.0`, "C-c"]);
      if (!res.ok) {
        const detail = [res.errorMessage, res.stderr].filter(Boolean).join(" | ");
        throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to interrupt session: ${truncateOutput(detail || "unknown error", 500)}`);
      }
      meta2.updatedAt = Date.now();
      await this.shellCtlSaveMeta(meta2);
      return JSON.stringify(
        {
          ok: true,
          action: "interrupt",
          session: parsed.sessionId
        },
        null,
        2
      );
    }
    const meta = await this.shellCtlLoadMeta(parsed.sessionId);
    if (!meta) {
      return JSON.stringify(
        {
          ok: true,
          action: "close",
          session: parsed.sessionId,
          alreadyClosed: true
        },
        null,
        2
      );
    }
    const running = await this.shellCtlHasSession(meta.tmuxSession);
    if (running) {
      await runTmuxCommand(["kill-session", "-t", meta.tmuxSession]);
    }
    await this.shellCtlDeleteMeta(parsed.sessionId);
    return JSON.stringify(
      {
        ok: true,
        action: "close",
        session: parsed.sessionId,
        wasRunning: running
      },
      null,
      2
    );
  }
  async handleSymbolsList(msg) {
    const params = asObject(msg.params);
    const requestedKindRaw = asString(params.kind);
    const requestedKind = parseSymbolKind(requestedKindRaw);
    if (requestedKindRaw && !requestedKind) {
      this.sendRequestError(
        msg.id,
        "INVALID_REQUEST",
        `symbols.list kind must be one of: ${SYMBOL_KINDS.join(", ")} (got ${requestedKindRaw}).`,
        false
      );
      return;
    }
    const includeFields = asBoolean(params.includeFields) ?? true;
    try {
      const catalog = await this.readSymbolCatalog();
      const activeKinds = requestedKind ? [requestedKind] : SYMBOL_KINDS;
      const responseCatalog = {
        contact: [],
        account: [],
        secret: [],
        user: []
      };
      const symbols = [];
      const countsByKind = {
        contact: 0,
        account: 0,
        secret: 0,
        user: 0
      };
      for (const kind of activeKinds) {
        const entries = catalog[kind];
        countsByKind[kind] = entries.length;
        responseCatalog[kind] = entries.map((entry) => {
          const record = { key: entry.key };
          if (includeFields && entry.fields.length > 0 && kind !== "user") {
            record.fields = [...entry.fields];
          }
          return record;
        });
        for (const entry of entries) {
          symbols.push(`{{${kind}:${entry.key}}}`);
          if (includeFields && kind !== "user") {
            for (const field of entry.fields) {
              symbols.push(`{{${kind}:${entry.key}:${field}}}`);
            }
          }
        }
      }
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          kind: requestedKind ?? null,
          includeFields,
          generatedAt: Date.now(),
          storeDir: this.symbolStoreDir,
          catalog: responseCatalog,
          counts: {
            byKind: countsByKind,
            keys: countsByKind.contact + countsByKind.account + countsByKind.secret + countsByKind.user,
            symbols: symbols.length
          },
          symbols
        }
      });
      this.writeAuditEvent({
        type: "symbols.list",
        details: {
          kind: requestedKind ?? null,
          includeFields,
          keys: countsByKind.contact + countsByKind.account + countsByKind.secret + countsByKind.user,
          symbols: symbols.length
        }
      });
    } catch (err) {
      this.sendRequestError(
        msg.id,
        "NODE_SYMBOLS_LIST_FAILED",
        `Failed to build symbols catalog: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    }
  }
  async handleAuditQuery(msg) {
    const params = asObject(msg.params);
    const limit = clampInt(params.limit, 1, 500) ?? 100;
    const cursorCreatedAt = asNumber(params.cursorCreatedAt ?? params.cursor) ?? null;
    const type = asString(params.type);
    const processId = asString(params.processId) ?? asString(params.process);
    const firewallSession = asString(params.firewallSession);
    const actor = asString(params.actor);
    const result = this.stateStore.queryAuditEvents({
      limit,
      cursorCreatedAt,
      type,
      processId,
      firewallSession,
      actor
    });
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        count: result.events.length,
        nextCursorCreatedAt: result.nextCursorCreatedAt,
        events: result.events
      }
    });
  }
  async handleMcpList(msg) {
    const params = asObject(msg.params);
    const serverId = asString(params.serverId) ?? asString(params.server);
    const includeTools = asBoolean(params.includeTools) ?? true;
    const includeResources = asBoolean(params.includeResources) ?? false;
    try {
      this.assertMcpBridgeEnabled("mcp.list");
      const servers = this.selectMcpBridgeServers(serverId);
      const summaries = [];
      for (const server of servers) {
        const summary = {
          id: server.id,
          label: server.label,
          allowTools: [...server.allowTools],
          allowResources: [...server.allowResources],
          timeoutMs: server.timeoutMs,
          connected: false
        };
        try {
          const client = await this.getMcpBridgeClient(server);
          summary.connected = true;
          if (includeTools) {
            const listedTools = await client.listTools();
            summary.tools = listedTools.filter((tool) => this.allowlistedMcpName(tool.name, server.allowTools)).map((tool) => ({
              name: tool.name,
              ...tool.description ? { description: tool.description } : {},
              ...tool.inputSchema ? { inputSchema: tool.inputSchema } : {}
            }));
          }
          if (includeResources) {
            try {
              const listedResources = await client.listResources();
              const resources = listedResources.resources;
              summary.resources = resources.filter((resource) => this.allowlistedMcpName(resource.uri, server.allowResources)).map((resource) => ({
                uri: resource.uri,
                ...typeof resource.name === "string" ? { name: resource.name } : {},
                ...typeof resource.description === "string" ? { description: resource.description } : {},
                ...typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}
              }));
              if (listedResources.nextCursor) summary.nextCursor = listedResources.nextCursor;
            } catch (err) {
              summary.resourcesError = err instanceof Error ? err.message : String(err);
            }
          }
        } catch (err) {
          summary.error = err instanceof Error ? err.message : String(err);
        }
        summaries.push(summary);
      }
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          bridge: {
            enabled: true,
            configPath: this.mcpBridgeConfigPath
          },
          serverId: serverId ?? null,
          includeTools,
          includeResources,
          count: summaries.length,
          servers: summaries
        }
      });
      this.writeAuditEvent({
        type: "mcp.list",
        details: {
          serverId: serverId ?? null,
          includeTools,
          includeResources,
          count: summaries.length
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleMcpCall(msg) {
    const params = asObject(msg.params);
    const serverId = asString(params.serverId) ?? asString(params.server);
    const toolName = asString(params.tool) ?? asString(params.name);
    const toolArgs = asObject(params.arguments ?? params.args);
    if (!serverId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.call requires `serverId`.", false);
      return;
    }
    if (!toolName) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.call requires `tool`.", false);
      return;
    }
    try {
      this.assertMcpBridgeEnabled("mcp.call");
      const server = this.requireMcpBridgeServer(serverId);
      if (!this.allowlistedMcpName(toolName, server.allowTools)) {
        throw new NodeToolError(
          "PERMISSION_DENIED",
          `MCP tool '${toolName}' is not allowlisted for server '${server.id}'.`
        );
      }
      const client = await this.getMcpBridgeClient(server);
      const result = await client.callTool(toolName, toolArgs);
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          serverId: server.id,
          tool: toolName,
          result
        }
      });
      this.writeAuditEvent({
        type: "mcp.call",
        toolName: "mcp.call",
        details: {
          serverId: server.id,
          tool: toolName
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleMcpResources(msg) {
    const params = asObject(msg.params);
    const serverId = asString(params.serverId) ?? asString(params.server);
    if (!serverId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.resources requires `serverId`.", false);
      return;
    }
    const uri = asString(params.uri);
    const actionRaw = asString(params.action) ?? (uri ? "read" : "list");
    const action = actionRaw === "read" ? "read" : actionRaw === "list" ? "list" : null;
    if (!action) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.resources action must be `list` or `read`.", false);
      return;
    }
    try {
      this.assertMcpBridgeEnabled("mcp.resources");
      const server = this.requireMcpBridgeServer(serverId);
      const client = await this.getMcpBridgeClient(server);
      if (action === "read") {
        if (!uri) {
          this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.resources read requires `uri`.", false);
          return;
        }
        if (!this.allowlistedMcpName(uri, server.allowResources)) {
          throw new NodeToolError(
            "PERMISSION_DENIED",
            `MCP resource '${uri}' is not allowlisted for server '${server.id}'.`
          );
        }
        const result = await client.readResource(uri);
        this.sendSignedEnvelope({
          type: "res",
          id: msg.id,
          ok: true,
          payload: {
            serverId: server.id,
            action,
            uri,
            result
          }
        });
        this.writeAuditEvent({
          type: "mcp.resources.read",
          toolName: "mcp.resources",
          details: {
            serverId: server.id,
            uri
          }
        });
        return;
      }
      const cursor = asString(params.cursor) ?? void 0;
      const limit = clampInt(params.limit, 1, 500) ?? 200;
      const listed = await client.listResources(cursor);
      const filtered = listed.resources.filter(
        (resource) => this.allowlistedMcpName(resource.uri, server.allowResources)
      );
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          serverId: server.id,
          action,
          count: Math.min(filtered.length, limit),
          resources: filtered.slice(0, limit).map((resource) => ({
            uri: resource.uri,
            ...typeof resource.name === "string" ? { name: resource.name } : {},
            ...typeof resource.description === "string" ? { description: resource.description } : {},
            ...typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}
          })),
          nextCursor: listed.nextCursor ?? null
        }
      });
      this.writeAuditEvent({
        type: "mcp.resources.list",
        toolName: "mcp.resources",
        details: {
          serverId: server.id,
          count: Math.min(filtered.length, limit)
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleFilePull(msg) {
    const params = asObject(msg.params);
    const requestedPath = asString(params.path) ?? asString(params.remotePath);
    if (!requestedPath) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "file.pull requires `path`.", false);
      return;
    }
    const maxBytes = clampInt(params.maxBytes, 1024, this.config.fileTransferMaxBytes) ?? this.config.fileTransferMaxBytes;
    try {
      this.assertFileTransferAllowed("pull");
      await this.refreshPolicyFromDiskIfChanged("file.pull");
      const firewallMode = this.currentPolicyFirewallMode();
      this.enforceHermesCommandPolicy({
        toolName: "file.pull",
        commandName: FILE_PULL_COMMAND,
        firewallMode
      });
      const resolvedPath = await this.resolveFileTransferPath(requestedPath, "read");
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        throw new NodeToolError("INVALID_REQUEST", `file.pull path is not a regular file: ${requestedPath}`);
      }
      if (stat.size > maxBytes) {
        throw new NodeToolError(
          "PAYLOAD_TOO_LARGE",
          `file.pull exceeded maxBytes (${stat.size} > ${maxBytes}); increase maxBytes or use a smaller file.`
        );
      }
      const bytes = await fs.readFile(resolvedPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          path: resolvedPath,
          sizeBytes: bytes.length,
          mtimeMs: Math.floor(stat.mtimeMs),
          sha256,
          encoding: "base64",
          contentBase64: bytes.toString("base64")
        }
      });
      this.writeAuditEvent({
        type: "file.pull",
        toolName: "file.pull",
        details: {
          path: resolvedPath,
          sizeBytes: bytes.length,
          maxBytes,
          sha256
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleFilePush(msg) {
    const params = asObject(msg.params);
    const requestedPath = asString(params.path) ?? asString(params.remotePath);
    if (!requestedPath) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "file.push requires `path`.", false);
      return;
    }
    const contentBase64 = asString(params.contentBase64) ?? asString(params.base64);
    if (!contentBase64) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "file.push requires base64 payload in `contentBase64`.", false);
      return;
    }
    const overwrite = asBoolean(params.overwrite) ?? false;
    const maxBytes = clampInt(params.maxBytes, 1024, this.config.fileTransferMaxBytes) ?? this.config.fileTransferMaxBytes;
    try {
      this.assertFileTransferAllowed("push");
      await this.refreshPolicyFromDiskIfChanged("file.push");
      const firewallMode = this.currentPolicyFirewallMode();
      this.enforceHermesCommandPolicy({
        toolName: "file.push",
        commandName: FILE_PUSH_COMMAND,
        firewallMode
      });
      const bytes = decodeBase64Loose(contentBase64);
      if (!bytes) {
        throw new NodeToolError("INVALID_REQUEST", "file.push contentBase64 is not valid base64.");
      }
      if (bytes.length > maxBytes) {
        throw new NodeToolError(
          "PAYLOAD_TOO_LARGE",
          `file.push exceeded maxBytes (${bytes.length} > ${maxBytes}); increase maxBytes or upload a smaller file.`
        );
      }
      const resolvedPath = await this.resolveFileTransferPath(requestedPath, "write");
      if (!overwrite) {
        try {
          await fs.access(resolvedPath);
          throw new NodeToolError(
            "FILE_EXISTS",
            `file.push target already exists: ${resolvedPath} (set overwrite=true to replace).`
          );
        } catch (err) {
          const code = err == null ? void 0 : err.code;
          if (code !== "ENOENT") throw err;
        }
      }
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.writeFile(resolvedPath, bytes, { mode: 384 });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          path: resolvedPath,
          sizeBytes: bytes.length,
          sha256,
          overwritten: overwrite
        }
      });
      this.writeAuditEvent({
        type: "file.push",
        toolName: "file.push",
        details: {
          path: resolvedPath,
          sizeBytes: bytes.length,
          maxBytes,
          sha256,
          overwrite
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  assertFileTransferAllowed(direction) {
    const commandName = direction === "pull" ? FILE_PULL_COMMAND : FILE_PUSH_COMMAND;
    if (isAllowedCommand(commandName, this.config.allowCommands)) return;
    throw new NodeToolError(
      "PERMISSION_DENIED",
      `file.${direction} is not allowlisted on this node (add "${commandName}" to NEXUS_NODE_ALLOW_COMMANDS).`
    );
  }
  async resolveFileTransferPath(requestedPath, mode) {
    const trimmed = requestedPath.trim();
    if (!trimmed) throw new NodeToolError("INVALID_REQUEST", "file transfer path cannot be empty.");
    const candidate = path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(this.config.stateDir, trimmed));
    let resolved = "";
    if (mode === "read") {
      try {
        resolved = await fs.realpath(candidate);
      } catch (err) {
        const code = err == null ? void 0 : err.code;
        if (code === "ENOENT") throw new NodeToolError("FILE_NOT_FOUND", `File not found: ${requestedPath}`);
        throw err;
      }
    } else {
      resolved = await resolvePathViaExistingParent(candidate);
    }
    const allowed = await this.isFileTransferPathAllowed(resolved);
    if (!allowed) {
      throw new NodeToolError("PERMISSION_DENIED", `Path is outside allowed file-transfer roots: ${requestedPath}`);
    }
    return resolved;
  }
  async isFileTransferPathAllowed(resolvedPath) {
    for (const root of this.config.fileTransferRoots) {
      const normalizedRoot = await resolvePathViaExistingParent(root);
      if (isWithinPath(resolvedPath, normalizedRoot)) return true;
    }
    return false;
  }
  async readSymbolCatalog() {
    const contactsRaw = await this.readJsonUnknown(path.join(this.symbolStoreDir, "contacts.json"));
    const accountsRaw = await this.readJsonUnknown(path.join(this.symbolStoreDir, "accounts.json"));
    const secretsRaw = await this.readJsonUnknown(path.join(this.symbolStoreDir, "secrets.json"));
    const userRaw = await this.readJsonUnknown(path.join(this.symbolStoreDir, "user.json"));
    return {
      contact: this.parseContactsCatalog(contactsRaw),
      account: this.parseKeyedCatalog(accountsRaw),
      secret: this.parseKeyedCatalog(secretsRaw),
      user: this.parseUserCatalog(userRaw)
    };
  }
  async readJsonUnknown(filePath) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      if (code === "ENOENT") return {};
      this.log(
        `symbols store read failed path=${filePath} error=${err instanceof Error ? err.message : String(err)}; treating as empty`
      );
      return {};
    }
  }
  parseContactsCatalog(raw) {
    const entries = /* @__PURE__ */ new Map();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const row = asObject(item);
        const key = asString(row.key);
        if (!key) continue;
        const fields = /* @__PURE__ */ new Set();
        for (const [field, value] of Object.entries(row)) {
          if (field === "key" || value === null || value === void 0) continue;
          fields.add(field);
        }
        entries.set(key, fields);
      }
      return this.normalizeCatalogEntries(entries);
    }
    const map = asObject(raw);
    for (const [keyRaw, value] of Object.entries(map)) {
      const key = keyRaw.trim();
      if (!key) continue;
      const fields = /* @__PURE__ */ new Set();
      const valueObj = asObject(value);
      for (const [field, fieldValue] of Object.entries(valueObj)) {
        if (fieldValue === null || fieldValue === void 0) continue;
        fields.add(field);
      }
      entries.set(key, fields);
    }
    return this.normalizeCatalogEntries(entries);
  }
  parseKeyedCatalog(raw) {
    const map = asObject(raw);
    const entries = /* @__PURE__ */ new Map();
    for (const [keyRaw, value] of Object.entries(map)) {
      const key = keyRaw.trim();
      if (!key) continue;
      const fields = /* @__PURE__ */ new Set();
      const valueObj = asObject(value);
      for (const [field, fieldValue] of Object.entries(valueObj)) {
        if (fieldValue === null || fieldValue === void 0) continue;
        fields.add(field);
      }
      entries.set(key, fields);
    }
    return this.normalizeCatalogEntries(entries);
  }
  parseUserCatalog(raw) {
    const map = asObject(raw);
    const entries = /* @__PURE__ */ new Map();
    for (const keyRaw of Object.keys(map)) {
      const key = keyRaw.trim();
      if (!key) continue;
      entries.set(key, /* @__PURE__ */ new Set());
    }
    return this.normalizeCatalogEntries(entries);
  }
  normalizeCatalogEntries(entries) {
    return [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, fields]) => ({
      key,
      fields: [...fields].sort((a, b) => a.localeCompare(b))
    }));
  }
  sendRequestError(id, code, message, retryable) {
    this.sendSignedEnvelope({
      type: "res",
      id,
      ok: false,
      error: {
        code,
        message: truncateOutput(message, 2e3),
        retryable
      }
    });
  }
  sendToolExecutionError(id, err) {
    const code = err instanceof NodeToolError ? err.code : err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "NODE_EXECUTION_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof NodeToolError ? err.retryable : false;
    this.sendRequestError(id, code, message, retryable);
  }
  async execSystemWhich(args) {
    const command = asString(args.command) ?? asString(args.executable) ?? asString(args.name);
    if (!command) {
      throw new NodeToolError("INVALID_REQUEST", "system.which requires `command`.");
    }
    if (command === POLICYCTL_COMMAND) {
      if (!isAllowedCommand(POLICYCTL_COMMAND, this.config.allowCommands)) {
        throw new NodeToolError("COMMAND_NOT_FOUND", `Command not found: ${command}`);
      }
      return `${POLICYCTL_COMMAND} (node-builtin)`;
    }
    if (command === SHELLCTL_COMMAND) {
      if (!isAllowedCommand(SHELLCTL_COMMAND, this.config.allowCommands)) {
        throw new NodeToolError("COMMAND_NOT_FOUND", `Command not found: ${command}`);
      }
      return `${SHELLCTL_COMMAND} (node-builtin)`;
    }
    const safe = shellEscape(command);
    const result = await execShell(`command -v ${safe}`, {
      timeoutMs: Math.min(this.config.runTimeoutMs, 1e4)
    });
    if (result.exitCode !== 0) {
      throw new NodeToolError("COMMAND_NOT_FOUND", `Command not found: ${command}`);
    }
    return truncateOutput(result.stdout.trim() || result.stderr.trim() || "(not found)");
  }
  async execSystemRun(args) {
    const command = asString(args.command);
    if (!command) throw new NodeToolError("INVALID_REQUEST", "system.run requires `command`.");
    const commandValidation = validateAllowlistedCommand(command, this.config.allowCommands);
    if (!commandValidation.ok) throw new NodeToolError("PERMISSION_DENIED", commandValidation.message);
    const commandName = commandValidation.commandName;
    const routing = asObject(args.routing);
    const firewallMode = this.currentPolicyFirewallMode();
    const timeoutMs = clampInt(args.timeoutMs ?? args.timeout, 1e3, this.config.runTimeoutMs) ?? this.config.runTimeoutMs;
    const cwd = asString(args.cwd) ?? null;
    const env = asStringMap(args.env);
    let executionCommand = command;
    let executionCwd = cwd;
    let executionEnv = env;
    let resolvedSymbols = [];
    if (firewallMode !== "transparent") {
      let resolvedInvocation;
      try {
        resolvedInvocation = await this.resolveSystemRunInvocation({
          command,
          cwd,
          env
        });
      } catch (err) {
        this.writeAuditEvent({
          type: "symbol.resolve.failed",
          toolName: "system.run",
          details: {
            code: err instanceof NodeToolError ? err.code : "NODE_EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err)
          }
        });
        throw err;
      }
      executionCommand = resolvedInvocation.command;
      executionCwd = resolvedInvocation.cwd;
      executionEnv = resolvedInvocation.env;
      resolvedSymbols = resolvedInvocation.symbols;
    }
    this.writeAuditEvent({
      type: "tool.execute.requested",
      toolName: "system.run",
      details: {
        commandName,
        symbolCount: resolvedSymbols.length,
        symbols: resolvedSymbols,
        firewallMode
      }
    });
    this.enforceHermesCommandPolicy({
      toolName: "system.run",
      commandName,
      firewallMode
    });
    let combined = "";
    let exitCode = 0;
    let signal = null;
    let timedOut = false;
    if (commandName === POLICYCTL_COMMAND) {
      combined = await this.execPolicyCtlCommand({
        command: executionCommand,
        routing,
        toolName: "system.run",
        firewallMode
      });
    } else if (commandName === SHELLCTL_COMMAND) {
      combined = await this.execShellCtlCommand({
        command: executionCommand
      });
    } else {
      const result = await execShell(executionCommand, {
        cwd: executionCwd ?? void 0,
        timeoutMs,
        env: executionEnv
      });
      combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      exitCode = result.exitCode;
      signal = result.signal;
      timedOut = result.timedOut;
    }
    if (firewallMode === "transparent") {
      if (timedOut) {
        throw new NodeToolError("EXECUTION_TIMEOUT", `Command timed out after ${timeoutMs}ms.`, true);
      }
      if (exitCode !== 0) {
        const signalPart = signal ? ` signal=${signal}` : "";
        throw new NodeToolError(
          "COMMAND_FAILED",
          truncateOutput(`Command failed (exit=${exitCode}${signalPart}).
${combined}`)
        );
      }
      return truncateOutput(combined || "(no output)");
    }
    const safeSummary = this.buildSafeSummary(combined || "(no output)");
    const reference = this.createHermesReference({
      sourceType: "system.run.output",
      toolName: "system.run",
      title: commandName ? `system.run ${commandName}` : "system.run output",
      safeSummary,
      metadata: {
        mode: firewallMode,
        commandName,
        symbolCount: resolvedSymbols.length,
        symbols: resolvedSymbols,
        exitCode,
        signal,
        timedOut
      }
    });
    if (timedOut) {
      throw new NodeToolError(
        "EXECUTION_TIMEOUT",
        JSON.stringify(
          {
            mode: firewallMode,
            safeSummary,
            references: [reference],
            timedOut: true,
            timeoutMs
          },
          null,
          2
        ),
        true
      );
    }
    if (exitCode !== 0) {
      throw new NodeToolError(
        "COMMAND_FAILED",
        JSON.stringify(
          {
            mode: firewallMode,
            safeSummary,
            references: [reference],
            exitCode,
            signal
          },
          null,
          2
        )
      );
    }
    return JSON.stringify(
      {
        mode: firewallMode,
        safeSummary,
        references: [reference],
        exitCode,
        signal
      },
      null,
      2
    );
  }
  async resolveSystemRunInvocation(params) {
    const storeCache = {};
    const commandResolved = await this.resolveTemplateSymbols(params.command, {
      shellEscapeValues: true,
      storeCache
    });
    const cwdResolved = params.cwd ? await this.resolveTemplateSymbols(params.cwd, {
      shellEscapeValues: false,
      storeCache
    }) : { value: null, symbols: [] };
    const envResolved = {};
    const seenSymbols = /* @__PURE__ */ new Set([...commandResolved.symbols, ...cwdResolved.symbols]);
    for (const [key, value] of Object.entries(params.env)) {
      const resolved = await this.resolveTemplateSymbols(value, {
        shellEscapeValues: false,
        storeCache
      });
      envResolved[key] = resolved.value;
      for (const symbol of resolved.symbols) seenSymbols.add(symbol);
    }
    return {
      command: commandResolved.value,
      cwd: cwdResolved.value,
      env: envResolved,
      symbols: [...seenSymbols.values()]
    };
  }
  async resolveTemplateSymbols(input, opts) {
    const matcher = new RegExp(SYMBOL_TOKEN_PATTERN);
    let cursor = 0;
    let output = "";
    const symbols = [];
    while (true) {
      const match = matcher.exec(input);
      if (!match) break;
      const raw = match[0] ?? "";
      const kindRaw = match[1] ?? "";
      const keyRaw = match[2] ?? "";
      const fieldRaw = match[3] ?? null;
      const kind = parseSymbolKind(kindRaw);
      if (!kind) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `Unsupported symbol kind in token ${raw}.`);
      }
      const resolved = await this.resolveSymbolToken({
        kind,
        key: keyRaw,
        field: fieldRaw,
        storeCache: opts.storeCache
      });
      output += input.slice(cursor, match.index);
      output += opts.shellEscapeValues ? shellEscape(resolved) : resolved;
      cursor = match.index + raw.length;
      symbols.push(raw);
    }
    if (symbols.length === 0) {
      return {
        value: input,
        symbols: []
      };
    }
    output += input.slice(cursor);
    return {
      value: output,
      symbols
    };
  }
  async resolveSymbolToken(params) {
    const key = params.key.trim();
    if (!key) throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", "Symbol key cannot be empty.");
    if (params.kind === "contact") {
      const contactsRaw = await this.loadSymbolStore("contact", params.storeCache);
      const record = this.lookupContactRecord(contactsRaw, key);
      if (!record) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `contact symbol "${key}" was not found.`);
      }
      const value = this.pickContactValue(record, params.field);
      if (value === null) {
        const suffix = params.field ? `:${params.field}` : "";
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `contact symbol "${key}${suffix}" has no resolvable value.`);
      }
      return value;
    }
    if (params.kind === "user") {
      if (params.field) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `user symbols do not support field selectors (${params.field}).`);
      }
      const userRaw = await this.loadSymbolStore("user", params.storeCache);
      const userMap = asObject(userRaw);
      const scalar = this.scalarToString(userMap[key]);
      if (scalar === null) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `user symbol "${key}" was not found.`);
      }
      return scalar;
    }
    const storeKind = params.kind;
    const storeRaw = await this.loadSymbolStore(storeKind, params.storeCache);
    const storeMap = asObject(storeRaw);
    if (!(key in storeMap)) {
      throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `${storeKind} symbol "${key}" was not found.`);
    }
    const entry = storeMap[key];
    if (params.field) {
      const entryObj2 = asObject(entry);
      const value = this.scalarToString(entryObj2[params.field]);
      if (value === null) {
        throw new NodeToolError(
          "SYMBOL_RESOLUTION_FAILED",
          `${storeKind} symbol "${key}:${params.field}" was not found.`
        );
      }
      return value;
    }
    const direct = this.scalarToString(entry);
    if (direct !== null) return direct;
    const entryObj = asObject(entry);
    const preferred = this.scalarToString(entryObj.value);
    if (preferred !== null) return preferred;
    const scalarEntries = Object.entries(entryObj).flatMap(([field, value]) => {
      const scalar = this.scalarToString(value);
      return scalar === null ? [] : [{ field, value: scalar }];
    });
    if (scalarEntries.length === 1) return scalarEntries[0].value;
    if (scalarEntries.length === 0) {
      throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `${storeKind} symbol "${key}" has no scalar value to resolve.`);
    }
    throw new NodeToolError(
      "SYMBOL_RESOLUTION_FAILED",
      `${storeKind} symbol "${key}" is ambiguous; use an explicit field selector.`
    );
  }
  async loadSymbolStore(kind, cache) {
    if (cache[kind] !== void 0) return cache[kind];
    const fileName = kind === "contact" ? "contacts.json" : kind === "account" ? "accounts.json" : kind === "secret" ? "secrets.json" : "user.json";
    const loaded = await this.readJsonUnknown(path.join(this.symbolStoreDir, fileName));
    cache[kind] = loaded;
    return loaded;
  }
  lookupContactRecord(raw, key) {
    if (Array.isArray(raw)) {
      const row = raw.find((item) => asString(asObject(item).key) === key);
      const obj = asObject(row);
      return Object.keys(obj).length > 0 ? obj : null;
    }
    const map = asObject(raw);
    if (key in map) {
      const obj = asObject(map[key]);
      if (Object.keys(obj).length > 0) return obj;
    }
    return null;
  }
  pickContactValue(record, field) {
    if (field) return this.scalarToString(record[field]);
    const preferredFields = ["name", "email", "phone", "firstName", "lastName"];
    for (const candidate of preferredFields) {
      const value = this.scalarToString(record[candidate]);
      if (value !== null) return value;
    }
    for (const [candidate, value] of Object.entries(record)) {
      if (candidate === "key") continue;
      const scalar = this.scalarToString(value);
      if (scalar !== null) return scalar;
    }
    return null;
  }
  scalarToString(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
  }
  appendProcessLog(entry, chunk, stream) {
    if (!chunk) return;
    const line = chunk;
    entry.logs += line;
    if (entry.logs.length > MAX_PROCESS_LOG_CHARS) {
      entry.logs = entry.logs.slice(entry.logs.length - MAX_PROCESS_LOG_CHARS);
    }
    this.stateStore.updateProcessLogs(entry.processId, entry.logs, Date.now());
    this.sendSignedEnvelope({
      type: "event",
      event: "log.append",
      payload: {
        processId: entry.processId,
        stream,
        chunk: truncateOutput(line, 8e3),
        ts: Date.now()
      }
    });
  }
  finishProcess(entry, exitCode, signal) {
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
    entry.child = null;
    entry.exitCode = exitCode;
    entry.signal = signal ? String(signal) : null;
    entry.endedAt = Date.now();
    if (entry.cancelRequested) {
      entry.status = "cancelled";
    } else if ((exitCode ?? 0) === 0) {
      entry.status = "completed";
    } else {
      entry.status = "failed";
    }
    if (entry.firewallMode !== "transparent") {
      const safeSummary = this.buildSafeSummary(entry.logs);
      const commandName = parseCommandName(entry.command);
      const reference = this.createHermesReference({
        sourceType: "process.output",
        processId: entry.processId,
        toolName: "system.run",
        title: commandName ? `process ${commandName}` : "process output",
        safeSummary,
        metadata: {
          mode: entry.firewallMode,
          status: entry.status,
          exitCode: entry.exitCode,
          signal: entry.signal
        }
      });
      entry.hermesReferences = [reference];
      const routing = asObject(entry.routing ?? {});
      entry.routing = {
        ...routing,
        firewallMode: entry.firewallMode,
        hermesReferences: entry.hermesReferences
      };
    }
    this.persistProcess(entry);
    this.queueTerminalProcessUpdate(entry, "process_finished");
  }
  persistProcess(entry) {
    const record = {
      processId: entry.processId,
      status: entry.status,
      command: entry.command,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      cancelRequested: entry.cancelRequested,
      timeoutMs: entry.timeoutMs,
      logs: entry.logs,
      routing: entry.routing
    };
    this.stateStore.upsertProcess(record, Date.now());
  }
  resolveFirewallSession(routing) {
    const nowMs = Date.now();
    const requestedSessionId = asString(routing.firewallSession);
    if (requestedSessionId) {
      const existing = this.stateStore.getFirewallSession(requestedSessionId, nowMs);
      if (existing) {
        const touched = this.stateStore.touchFirewallSession(
          requestedSessionId,
          nowMs,
          FIREWALL_SESSION_TTL_MS
        );
        const current = touched ?? existing;
        return {
          sessionId: current.sessionId,
          quarantineState: current.quarantineState,
          reused: true
        };
      }
      this.log(`firewall session missing_or_expired id=${requestedSessionId}; creating replacement`);
    }
    const created = this.createFirewallSession(nowMs);
    return {
      sessionId: created.sessionId,
      quarantineState: created.quarantineState,
      reused: false
    };
  }
  createFirewallSession(nowMs) {
    const sessionId = `fw_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const quarantineState = this.currentPolicyDefaultQuarantine();
    const firewallMode = this.currentPolicyFirewallMode();
    return this.stateStore.createFirewallSession({
      sessionId,
      quarantineState,
      nowMs,
      ttlMs: FIREWALL_SESSION_TTL_MS,
      metadata: {
        source: "policy.defaultQuarantine",
        firewallMode,
        policyUpdatedAt: asNumber(this.policy.updatedAt) ?? nowMs
      }
    });
  }
  mapReferenceSummary(record) {
    return {
      refId: record.refId,
      sourceType: record.sourceType,
      title: record.title ?? null,
      safeSummary: record.safeSummary,
      metadata: record.metadata ?? null
    };
  }
  createHermesReference(params) {
    const nowMs = Date.now();
    const created = this.stateStore.createReference({
      sourceType: params.sourceType,
      processId: params.processId ?? null,
      toolName: params.toolName ?? null,
      title: params.title ?? null,
      safeSummary: params.safeSummary,
      metadata: params.metadata ?? null,
      nowMs
    });
    return this.mapReferenceSummary(created);
  }
  buildSafeSummary(value) {
    const normalized = value.replace(/\r/g, "");
    const charCount = normalized.length;
    if (charCount <= 0) {
      return "Sanitized output withheld by firewall mode (no output).";
    }
    const lineCount = normalized.split("\n").length;
    return `Sanitized output withheld by firewall mode (${lineCount} line(s), ${charCount} char(s)).`;
  }
  enforceHermesCommandPolicy(params) {
    if (params.firewallMode !== "hermes") return;
    const denyCommands = this.currentPolicyDenyCommands();
    if (!denyCommands.includes(params.commandName)) return;
    this.writeAuditEvent({
      type: "policy.deny",
      processId: params.processId ?? null,
      firewallSession: params.firewallSession ?? null,
      toolName: params.toolName,
      details: {
        mode: params.firewallMode,
        reason: "command_denied",
        commandName: params.commandName,
        denyCommands
      }
    });
    throw new NodeToolError(
      "HERMES_POLICY_DENIED",
      JSON.stringify(
        {
          code: "HERMES_POLICY_DENIED",
          mode: params.firewallMode,
          decision: "deny",
          reason: "command_denied",
          commandName: params.commandName,
          denyCommands
        },
        null,
        2
      ),
      false
    );
  }
  readProcessFirewallMode(routing) {
    return parseFirewallMode(asString(asObject(routing ?? {}).firewallMode), "transparent");
  }
  readProcessHermesReferences(routing) {
    const refsRaw = asObject(routing ?? {}).hermesReferences;
    if (!Array.isArray(refsRaw)) return [];
    const out = [];
    for (const item of refsRaw) {
      const obj = asObject(item);
      const refId = asString(obj.refId);
      const sourceType = asString(obj.sourceType);
      const safeSummary = asString(obj.safeSummary);
      if (!refId || !sourceType || !safeSummary) continue;
      const metadataObj = asObject(obj.metadata);
      out.push({
        refId,
        sourceType,
        title: asString(obj.title) ?? null,
        safeSummary,
        metadata: Object.keys(metadataObj).length > 0 ? metadataObj : null
      });
    }
    return out;
  }
  resolveProcessHermesReferences(entry) {
    if (entry.hermesReferences.length > 0) return entry.hermesReferences;
    const refs = this.stateStore.listReferencesByProcessId(entry.processId, 20).map((row) => this.mapReferenceSummary(row));
    if (refs.length > 0) {
      entry.hermesReferences = refs;
    }
    return entry.hermesReferences;
  }
  writeAuditEvent(params) {
    try {
      this.stateStore.appendAuditEvent({
        createdAt: params.createdAt ?? Date.now(),
        type: params.type,
        processId: params.processId ?? null,
        firewallSession: params.firewallSession ?? null,
        actor: params.actor ?? this.senderId,
        toolName: params.toolName ?? null,
        details: params.details ?? null
      });
    } catch (err) {
      this.log(
        `audit append failed type=${params.type} error=${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  queueTerminalProcessUpdate(entry, reason) {
    const deliveryId = `dlv_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const hermesEnabled = entry.firewallMode !== "transparent";
    const summary = hermesEnabled ? this.buildSafeSummary(entry.logs) : truncateOutput(entry.logs, 6e3);
    const references = hermesEnabled ? this.resolveProcessHermesReferences(entry) : [];
    const payload = {
      processId: entry.processId,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      summary,
      deliveryId,
      deliveryReason: reason,
      ts: Date.now(),
      firewallMode: entry.firewallMode,
      ...hermesEnabled ? {
        hermes: {
          mode: entry.firewallMode,
          sanitized: true,
          references
        }
      } : {},
      ...entry.routing ? { routing: entry.routing } : {}
    };
    this.stateStore.enqueueOutbox({
      deliveryId,
      processId: entry.processId,
      payload,
      createdAt: Date.now()
    });
    if (this.ready) this.sendOutboxEntry({ deliveryId, processId: entry.processId, payload, createdAt: Date.now(), delivered: false, deliveredAt: null });
  }
  sendOutboxEntry(entry) {
    return this.sendSignedEnvelope({
      type: "event",
      event: "process.update",
      payload: entry.payload
    });
  }
  drainOutbox(source) {
    if (!this.ready || this.drainingOutbox) return;
    this.drainingOutbox = true;
    try {
      const pending = this.stateStore.listUndelivered(250);
      let sent = 0;
      for (const entry of pending) {
        const ok = this.sendOutboxEntry(entry);
        if (!ok) break;
        sent += 1;
      }
      if (pending.length > 0) {
        this.log(`outbox drain source=${source} pending=${pending.length} sent=${sent}`);
      }
    } finally {
      this.drainingOutbox = false;
    }
  }
  emitProcessUpdate(entry, status) {
    this.sendSignedEnvelope({
      type: "event",
      event: "process.update",
      payload: {
        processId: entry.processId,
        status,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        exitCode: entry.exitCode,
        signal: entry.signal,
        firewallMode: entry.firewallMode,
        ts: Date.now()
      }
    });
  }
  serializeProcess(entry, includeLogs) {
    const hermesReferences = entry.firewallMode !== "transparent" ? this.resolveProcessHermesReferences(entry) : [];
    return {
      processId: entry.processId,
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      cancelRequested: entry.cancelRequested,
      timeoutMs: entry.timeoutMs,
      logChars: entry.logs.length,
      firewallMode: entry.firewallMode,
      ...includeLogs ? { logs: entry.logs } : {},
      ...entry.firewallMode !== "transparent" ? {
        hermes: {
          mode: entry.firewallMode,
          sanitized: true,
          references: hermesReferences
        }
      } : {},
      ...entry.routing ? { routing: entry.routing } : {}
    };
  }
  cancelProcess(entry, params) {
    var _a, _b;
    entry.cancelRequested = true;
    this.persistProcess(entry);
    if (!entry.child || entry.status !== "running") return;
    try {
      entry.child.kill(params.signal);
    } catch {
    }
    this.appendProcessLog(entry, `cancel requested (${params.reason}) using ${params.signal}
`, "stderr");
    if (params.signal !== "SIGKILL" && params.killAfterMs > 0) {
      if (entry.killTimer) clearTimeout(entry.killTimer);
      entry.killTimer = setTimeout(() => {
        if (!entry.child || entry.status !== "running") return;
        try {
          entry.child.kill("SIGKILL");
        } catch {
        }
      }, params.killAfterMs);
      (_b = (_a = entry.killTimer).unref) == null ? void 0 : _b.call(_a);
    }
  }
  terminateAllProcesses(reason) {
    for (const entry of this.processes.values()) {
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = null;
      }
      if (entry.killTimer) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      if (entry.child && entry.status === "running") {
        this.cancelProcess(entry, {
          signal: "SIGTERM",
          reason: `node shutdown: ${reason}`,
          killAfterMs: 2e3
        });
        this.appendProcessLog(entry, `node shutdown requested while process was running
`, "stderr");
        continue;
      }
      if (entry.status === "queued") {
        entry.status = "cancelled";
        entry.cancelRequested = true;
        entry.endedAt = Date.now();
        this.appendProcessLog(entry, `node shutdown before process start: ${reason}
`, "stderr");
        this.persistProcess(entry);
        this.queueTerminalProcessUpdate(entry, "shutdown_queued");
      }
    }
  }
  sendCapsAdvertise() {
    if (!this.ready) return;
    const firewallMode = this.currentPolicyFirewallMode();
    this.sendSignedEnvelope({
      type: "event",
      event: "caps.advertise",
      payload: {
        capabilities: this.advertisedCapabilities(),
        tags: ["reference-node"],
        firewallMode,
        timestamp: Date.now()
      }
    });
  }
  sendSignedEnvelope(envelope) {
    const ws = this.requireOpenSocket();
    if (!ws) return false;
    const withMeta = {
      ...envelope,
      ts: Date.now(),
      sender: this.senderId
    };
    const sig = signEnvelope(withMeta, this.identity.privateKey);
    try {
      ws.send(
        JSON.stringify({
          ...withMeta,
          sig
        })
      );
      return true;
    } catch {
      return false;
    }
  }
  get senderId() {
    return `node:${this.config.nodeId}`;
  }
  requireOpenSocket() {
    if (!this.ws || this.ws.readyState !== import_websocket.default.OPEN) return null;
    return this.ws;
  }
  closeSocket(code, reason) {
    if (!this.ws) return;
    try {
      this.ws.close(code, truncateOutput(reason, 120));
    } catch {
      try {
        this.ws.terminate();
      } catch {
      }
    }
  }
  log(line) {
    this.logger.info(line);
  }
};
function parseArgs(argv) {
  const values = {};
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    if (!key) continue;
    if (!next || next.startsWith("--")) {
      values[key] = "true";
      continue;
    }
    values[key] = next;
    i += 1;
  }
  return { help, values };
}
async function loadEnvFileIntoProcessEnv(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      if (!key || process2.env[key] !== void 0) continue;
      process2.env[key] = value;
    }
  } catch (err) {
    const code = err == null ? void 0 : err.code;
    if (code !== "ENOENT") throw err;
  }
}
var ReferenceNodeLogger = class _ReferenceNodeLogger {
  constructor(config) {
    this.config = config;
  }
  writeQueue = Promise.resolve();
  static async create(config) {
    await fs.mkdir(path.dirname(config.logFilePath), { recursive: true });
    return new _ReferenceNodeLogger(config);
  }
  info(message, fields = {}) {
    this.write("info", message, fields);
  }
  warn(message, fields = {}) {
    this.write("warn", message, fields);
  }
  error(message, fields = {}) {
    this.write("error", message, fields);
  }
  write(level, message, fields) {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const line = this.config.logFormat === "json" ? JSON.stringify({ ts, level, component: "reference-node", msg: message, ...fields }) : `[reference-node] ${ts} ${message}`;
    process2.stdout.write(`${line}
`);
    this.writeQueue = this.writeQueue.then(async () => {
      await this.rotateIfNeeded(Buffer.byteLength(`${line}
`, "utf8"));
      await fs.appendFile(this.config.logFilePath, `${line}
`, "utf8");
    }).catch(() => void 0);
  }
  async rotateIfNeeded(incomingBytes) {
    if (this.config.logMaxBytes <= 0) return;
    let currentSize = 0;
    try {
      const stat = await fs.stat(this.config.logFilePath);
      currentSize = stat.size;
    } catch {
      currentSize = 0;
    }
    if (currentSize + incomingBytes <= this.config.logMaxBytes) return;
    const maxFiles = Math.max(1, this.config.logMaxFiles);
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const src = `${this.config.logFilePath}.${i}`;
      const dest = `${this.config.logFilePath}.${i + 1}`;
      if (!fsSync.existsSync(src)) continue;
      try {
        await fs.rename(src, dest);
      } catch {
      }
    }
    try {
      await fs.rename(this.config.logFilePath, `${this.config.logFilePath}.1`);
    } catch {
    }
  }
};
var FORCE_JSON_BUNDLE = typeof __NEXUS_LITE_BUNDLE__ !== "undefined" && __NEXUS_LITE_BUNDLE__;
var openStateStore = FORCE_JSON_BUNDLE ? async (stateDir) => {
  const mod = await import("./state-store-json-PEF23GI3.mjs");
  return await mod.ReferenceNodeJsonStateStore.open(stateDir);
} : async (stateDir, stateBackend) => {
  if (stateBackend === "json") {
    const mod2 = await import("./state-store-json-PEF23GI3.mjs");
    return await mod2.ReferenceNodeJsonStateStore.open(stateDir);
  }
  const mod = await import("./state-store-ECHOI3MP.mjs");
  return await mod.ReferenceNodeStateStore.open(stateDir);
};
async function initializeNodeBootstrap(config, logger) {
  await fs.mkdir(config.stateDir, { recursive: true });
  await fs.mkdir(path.dirname(config.logFilePath), { recursive: true });
  const identity = await loadOrCreateIdentity(config.stateDir);
  const store = await openStateStore(config.stateDir, config.stateBackend);
  store.close();
  const policyPath = path.join(config.stateDir, "hermes-policy.json");
  try {
    await fs.access(policyPath);
  } catch {
    await fs.writeFile(policyPath, `${JSON.stringify({ ...DEFAULT_POLICY_DOC, updatedAt: Date.now() }, null, 2)}
`, {
      mode: 384,
      encoding: "utf8"
    });
  }
  await writeInitEnvFile(config, identity.fingerprint, logger);
  logger.info(`init backend=${config.stateBackend} state_dir=${config.stateDir} env_file=${config.initEnvFilePath}`);
  logger.info("next step: start with --doctor (or --doctor --doctor-continue to run immediately)");
}
async function writeInitEnvFile(config, fingerprint, logger) {
  try {
    await fs.access(config.initEnvFilePath);
    logger.info(`init env exists path=${config.initEnvFilePath}; leaving unchanged`);
    return;
  } catch {
  }
  await fs.mkdir(path.dirname(config.initEnvFilePath), { recursive: true });
  const template = [
    "# Bootstrap environment for Nexus reference node",
    `NEXUS_NODE_GATEWAY_URL=${config.gatewayUrl}`,
    "# Optional for wss:// self-signed gateways",
    "# NEXUS_NODE_GATEWAY_TLS_FINGERPRINT=AB:CD:...",
    `NEXUS_NODE_STATE_DIR=${config.stateDir}`,
    `NEXUS_NODE_STATE_BACKEND=${config.stateBackend}`,
    `NEXUS_NODE_PROFILE=${config.profile}`,
    `NEXUS_NODE_ID=${config.nodeId}`,
    `NEXUS_NODE_NAME=${config.displayName}`,
    `NEXUS_NODE_CAPS=${config.capabilities.join(",")}`,
    `NEXUS_NODE_ALLOW_COMMANDS=${[...config.allowCommands].join(",")}`,
    `NEXUS_NODE_LOG_FORMAT=${config.logFormat}`,
    `NEXUS_NODE_LOG_FILE=${config.logFilePath}`,
    `NEXUS_NODE_LOG_MAX_BYTES=${config.logMaxBytes}`,
    `NEXUS_NODE_LOG_MAX_FILES=${config.logMaxFiles}`,
    `NEXUS_NODE_MCP_BRIDGE=${config.mcpBridgeEnabled ? "1" : "0"}`,
    `NEXUS_NODE_MCP_BRIDGE_CONFIG=${config.mcpBridgeConfigPath}`,
    `NEXUS_NODE_WEBHOOK_HOST=${config.webhookHost}`,
    `NEXUS_NODE_WEBHOOK_PORT=${config.webhookEnabled ? String(config.webhookPort) : "0"}`,
    `NEXUS_NODE_WEBHOOK_PATH=${config.webhookPath}`,
    `NEXUS_NODE_WEBHOOK_MAX_BODY_BYTES=${config.webhookMaxBodyBytes}`,
    "# Optional static bearer token for local webhook ingress",
    "# NEXUS_NODE_WEBHOOK_TOKEN=change-me",
    "",
    `# Generated node fingerprint: ${fingerprint}`,
    ""
  ].join("\n");
  await fs.writeFile(config.initEnvFilePath, template, { mode: 384, encoding: "utf8" });
  logger.info(`init wrote env template path=${config.initEnvFilePath}`);
}
async function runDoctorChecks(config, logger) {
  const results = [];
  const nodeMajor = Number.parseInt(process2.versions.node.split(".")[0] ?? "0", 10);
  results.push({
    check: "node.version",
    ok: Number.isFinite(nodeMajor) && nodeMajor >= 22,
    detail: `node=${process2.versions.node} required>=22`
  });
  try {
    await fs.mkdir(config.stateDir, { recursive: true });
    const probePath = path.join(config.stateDir, `.doctor-write-${process2.pid}-${Date.now()}`);
    await fs.writeFile(probePath, "ok\n", { mode: 384, encoding: "utf8" });
    await fs.rm(probePath, { force: true });
    results.push({ check: "state.writable", ok: true, detail: config.stateDir });
  } catch (err) {
    results.push({
      check: "state.writable",
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    });
  }
  const gatewayProbe = await probeGateway(config.gatewayUrl, 3e3);
  results.push({
    check: "gateway.reachable",
    ok: gatewayProbe.ok,
    detail: gatewayProbe.detail
  });
  try {
    const store = await openStateStore(config.stateDir, config.stateBackend);
    store.close();
    results.push({ check: "state.backend", ok: true, detail: config.stateBackend });
  } catch (err) {
    results.push({
      check: "state.backend",
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    });
  }
  if (isAllowedCommand(SHELLCTL_COMMAND, config.allowCommands)) {
    const tmuxProbe = await runTmuxCommand(["-V"]);
    const tmuxOk = tmuxProbe.ok;
    const detail = tmuxOk ? truncateOutput(tmuxProbe.stdout || "tmux available", 180) : truncateOutput(tmuxProbe.stderr || tmuxProbe.errorMessage || "tmux not available", 180);
    results.push({ check: "tmux.available", ok: tmuxOk, detail });
  } else {
    results.push({
      check: "tmux.available",
      ok: true,
      detail: `${SHELLCTL_COMMAND} not allowlisted; tmux is optional`
    });
  }
  for (const result of results) {
    if (result.ok) {
      logger.info(`doctor ok check=${result.check} detail=${result.detail}`);
    } else {
      logger.error(`doctor fail check=${result.check} detail=${result.detail}`);
    }
  }
  return {
    ok: results.every((result) => result.ok),
    results
  };
}
async function probeGateway(gatewayUrl, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    return { ok: false, detail: `invalid gateway URL: ${gatewayUrl}` };
  }
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === "wss:" ? "443" : "80"));
  if (!host || !Number.isFinite(port) || port <= 0) {
    return { ok: false, detail: `invalid host/port host=${host} port=${String(parsed.port || "")}` };
  }
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, detail: `timeout connecting ${host}:${port}` });
    }, Math.max(500, timeoutMs));
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true, detail: `${host}:${port}` });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: false, detail: truncateOutput(err.message || String(err), 200) });
    });
  });
}
function isTruthyFlag(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
function parseStateBackend(value) {
  switch ((value || "").trim()) {
    case "sqlite":
    case "json":
      return value.trim();
    default:
      throw new Error(`Invalid state backend: ${value}. Expected sqlite or json.`);
  }
}
function parseNodeProfile(value) {
  switch ((value || "").trim()) {
    case "standard":
    case "minimal":
      return value.trim();
    default:
      throw new Error(`Invalid profile: ${value}. Expected standard or minimal.`);
  }
}
function parseLogFormat(value) {
  switch ((value || "").trim()) {
    case "text":
    case "json":
      return value.trim();
    default:
      throw new Error(`Invalid log format: ${value}. Expected text or json.`);
  }
}
function normalizeWebhookPath(value) {
  const raw = (value ?? "").trim();
  if (!raw) return "/node-webhook";
  return raw.startsWith("/") ? raw : `/${raw}`;
}
function buildConfig(values, options = {}) {
  const hostId = os.hostname().replace(/[^a-zA-Z0-9_-]/g, "-");
  const profileRaw = options.forceProfile ?? values.profile ?? process2.env.NEXUS_NODE_PROFILE ?? "standard";
  const profile = parseNodeProfile(profileRaw);
  const nodeId = values["node-id"] ?? process2.env.NEXUS_NODE_ID ?? `reference-${hostId}`;
  const displayName = values.name ?? process2.env.NEXUS_NODE_NAME ?? "Nexus Reference Node";
  const gatewayUrl = values.gateway ?? process2.env.NEXUS_NODE_GATEWAY_URL ?? "ws://127.0.0.1:18789/nx/nodes";
  const gatewayTlsFingerprintRaw = values["gateway-tls-fingerprint"] ?? process2.env.NEXUS_NODE_GATEWAY_TLS_FINGERPRINT ?? "";
  const gatewayTlsFingerprint = normalizeFingerprint256(gatewayTlsFingerprintRaw);
  if (gatewayTlsFingerprintRaw.trim() && !gatewayTlsFingerprint) {
    throw new Error(
      "Invalid gateway TLS fingerprint format. Expected SHA-256 fingerprint with 64 hex chars (with or without ':' separators)."
    );
  }
  const insecureAllowNonLoopbackWs = (values["insecure-allow-nonloopback-ws"] ?? process2.env.NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS ?? "").trim() === "1";
  validateGatewayTransportPolicy({
    gatewayUrl,
    gatewayTlsFingerprint,
    insecureAllowNonLoopbackWs
  });
  const stateDir = values["state-dir"] ?? process2.env.NEXUS_NODE_STATE_DIR ?? path.join(os.homedir(), ".nexus-node");
  const resolvedStateDir = path.resolve(stateDir);
  const stateBackendRaw = options.forceStateBackend ?? values["state-backend"] ?? process2.env.NEXUS_NODE_STATE_BACKEND ?? (profile === "minimal" ? "json" : "sqlite");
  const stateBackend = parseStateBackend(stateBackendRaw);
  const policyRequired = (values["policy-required"] ?? process2.env.NEXUS_NODE_POLICY_REQUIRED ?? "").trim() === "1";
  const capabilities = splitCsv(values.caps ?? process2.env.NEXUS_NODE_CAPS, DEFAULT_CAPABILITIES);
  const allowCommands = new Set(
    splitCsv(values.allow ?? process2.env.NEXUS_NODE_ALLOW_COMMANDS, DEFAULT_ALLOW_COMMANDS)
  );
  const legacyFileTransferSetting = (values["allow-file-transfer"] ?? process2.env.NEXUS_NODE_ALLOW_FILE_TRANSFER ?? "").trim();
  if (legacyFileTransferSetting) {
    throw new Error(
      `NEXUS_NODE_ALLOW_FILE_TRANSFER/--allow-file-transfer is no longer supported. Allowlist ${FILE_PULL_COMMAND},${FILE_PUSH_COMMAND} via NEXUS_NODE_ALLOW_COMMANDS or --allow instead.`
    );
  }
  const runTimeoutMs = clampInt(values["run-timeout-ms"] ?? process2.env.NEXUS_NODE_RUN_TIMEOUT_MS, 1e3, 3e5) ?? 6e4;
  const reconnectMinMs = clampInt(values["reconnect-min-ms"] ?? process2.env.NEXUS_NODE_RECONNECT_MIN_MS, 500, 6e4) ?? 2e3;
  const reconnectMaxMs = clampInt(values["reconnect-max-ms"] ?? process2.env.NEXUS_NODE_RECONNECT_MAX_MS, reconnectMinMs, 3e5) ?? 3e4;
  const maxClockSkewMs = clampInt(values["max-clock-skew-ms"] ?? process2.env.NEXUS_NODE_MAX_CLOCK_SKEW_MS, 5e3, 6e5) ?? 12e4;
  const insecureSkipGatewayProof = (values["insecure-skip-gateway-proof"] ?? process2.env.NEXUS_NODE_INSECURE_SKIP_GATEWAY_PROOF ?? "").trim() === "1";
  const rawMcpBridge = values["mcp-bridge"] ?? process2.env.NEXUS_NODE_MCP_BRIDGE;
  const mcpBridgeEnabled = (rawMcpBridge ?? "").trim() === "1";
  const mcpBridgeConfigPath = path.resolve(
    values["mcp-bridge-config"] ?? process2.env.NEXUS_NODE_MCP_BRIDGE_CONFIG ?? path.join(resolvedStateDir, MCP_BRIDGE_CONFIG_FILE)
  );
  const mcpBridgeTimeoutMs = clampInt(values["mcp-bridge-timeout-ms"] ?? process2.env.NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS, 2e3, 3e5) ?? 3e4;
  const fileTransferRoots = normalizeFileTransferRoots(
    values["file-transfer-roots"] ?? process2.env.NEXUS_NODE_FILE_TRANSFER_ROOTS,
    resolvedStateDir
  );
  const fileTransferMaxBytes = clampInt(values["file-transfer-max-bytes"] ?? process2.env.NEXUS_NODE_FILE_TRANSFER_MAX_BYTES, 1024, 50 * 1024 * 1024) ?? DEFAULT_FILE_TRANSFER_MAX_BYTES;
  const logFormat = parseLogFormat(
    values["log-format"] ?? process2.env.NEXUS_NODE_LOG_FORMAT ?? (profile === "minimal" ? "json" : "text")
  );
  const logFilePath = path.resolve(
    values["log-file"] ?? process2.env.NEXUS_NODE_LOG_FILE ?? path.join(resolvedStateDir, "logs", "reference-node.log")
  );
  const logMaxBytes = clampInt(values["log-max-bytes"] ?? process2.env.NEXUS_NODE_LOG_MAX_BYTES, 64 * 1024, 64 * 1024 * 1024) ?? 5 * 1024 * 1024;
  const logMaxFiles = clampInt(values["log-max-files"] ?? process2.env.NEXUS_NODE_LOG_MAX_FILES, 1, 50) ?? 5;
  const initEnvFilePath = path.resolve(
    values["env-file"] ?? process2.env.NEXUS_NODE_ENV_FILE ?? path.join(resolvedStateDir, "reference-node.env")
  );
  const webhookHost = (values["webhook-host"] ?? process2.env.NEXUS_NODE_WEBHOOK_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const webhookPort = clampInt(values["webhook-port"] ?? process2.env.NEXUS_NODE_WEBHOOK_PORT, 0, 65535) ?? 0;
  const webhookPath = normalizeWebhookPath(values["webhook-path"] ?? process2.env.NEXUS_NODE_WEBHOOK_PATH);
  const webhookTokenRaw = values["webhook-token"] ?? process2.env.NEXUS_NODE_WEBHOOK_TOKEN ?? "";
  const webhookToken = webhookTokenRaw.trim() ? webhookTokenRaw.trim() : null;
  const webhookMaxBodyBytes = clampInt(values["webhook-max-bytes"] ?? process2.env.NEXUS_NODE_WEBHOOK_MAX_BODY_BYTES, 1024, 10 * 1024 * 1024) ?? 256 * 1024;
  return {
    gatewayUrl,
    gatewayTlsFingerprint,
    stateDir: resolvedStateDir,
    stateBackend,
    profile,
    policyRequired,
    nodeId,
    displayName,
    capabilities,
    allowCommands,
    runTimeoutMs,
    reconnectMinMs,
    reconnectMaxMs,
    maxClockSkewMs,
    insecureAllowNonLoopbackWs,
    insecureSkipGatewayProof,
    mcpBridgeEnabled,
    mcpBridgeConfigPath,
    mcpBridgeTimeoutMs,
    fileTransferRoots,
    fileTransferMaxBytes,
    logFormat,
    logFilePath,
    logMaxBytes,
    logMaxFiles,
    initEnvFilePath,
    webhookEnabled: webhookPort > 0,
    webhookHost,
    webhookPort,
    webhookPath,
    webhookToken,
    webhookMaxBodyBytes
  };
}
function validateGatewayTransportPolicy(params) {
  let parsed;
  try {
    parsed = new URL(params.gatewayUrl);
  } catch {
    throw new Error(`Invalid gateway URL: ${params.gatewayUrl}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Gateway URL must use ws:// or wss:// (got ${parsed.protocol}).`);
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (!loopback && parsed.protocol !== "wss:" && !params.insecureAllowNonLoopbackWs) {
    throw new Error(
      `TLS is required for non-loopback gateway endpoints. Use wss:// for ${parsed.hostname} or set NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS=1 for debug-only development.`
    );
  }
  if (parsed.protocol === "ws:" && params.gatewayTlsFingerprint) {
    throw new Error("Gateway TLS fingerprint pinning requires a wss:// gateway URL.");
  }
}
function isLoopbackHost(hostname) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1") return true;
  if (normalized === "host.docker.internal") return true;
  if (normalized.startsWith("127.")) return true;
  return normalized.endsWith(".localhost");
}
function normalizeFingerprint256(value) {
  var _a;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hex = trimmed.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (hex.length !== 64) return null;
  return ((_a = hex.match(/.{1,2}/g)) == null ? void 0 : _a.join(":")) ?? null;
}
async function loadOrCreateIdentity(stateDir) {
  const authDir = path.join(stateDir, "auth");
  const privateKeyPath = path.join(authDir, "node-ed25519-private.pem");
  const publicKeyPath = path.join(authDir, "node-ed25519-public.pem");
  await fs.mkdir(authDir, { recursive: true });
  let privatePem = null;
  let publicPem = null;
  try {
    privatePem = await fs.readFile(privateKeyPath, "utf8");
    publicPem = await fs.readFile(publicKeyPath, "utf8");
  } catch {
    const pair = generateKeyPairSync("ed25519");
    privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    await fs.writeFile(privateKeyPath, privatePem, { mode: 384 });
    await fs.writeFile(publicKeyPath, publicPem, { mode: 420 });
  }
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);
  const parsed = parsePublicKey(publicPem);
  if (!parsed) throw new Error("Failed to parse generated node public key.");
  return {
    privateKey,
    publicKey,
    publicKeyRaw: parsed.raw,
    fingerprint: parsed.fingerprint,
    privateKeyPath,
    publicKeyPath
  };
}
function parseEnvelope(value) {
  const type = asString(value.type);
  const ts = asNumber(value.ts);
  const sender = asString(value.sender);
  const sig = asString(value.sig);
  if (!type || !ts || !sender || !sig) return null;
  if (type === "req") {
    const id = asString(value.id);
    const method = asString(value.method);
    if (!id || !method) return null;
    return {
      type: "req",
      id,
      ts,
      sender,
      sig,
      method,
      params: value.params
    };
  }
  if (type === "res") {
    const ok = value.ok;
    if (typeof ok !== "boolean") return null;
    return {
      type: "res",
      id: asString(value.id),
      ts,
      sender,
      sig,
      ok,
      payload: value.payload,
      error: asObject(value.error)
    };
  }
  if (type === "event") {
    const event = asString(value.event);
    if (!event) return null;
    return {
      type: "event",
      ts,
      sender,
      sig,
      event,
      payload: value.payload
    };
  }
  return null;
}
function verifyEnvelopeSignature(envelope, publicKey) {
  const sig = asString(envelope.sig);
  if (!sig) return false;
  return verifyDetachedPayload(withoutSig(envelope), sig, publicKey);
}
function buildHandshakeTranscript(params) {
  return {
    protocol: "nexus-node-v1",
    kind: "connect-proof",
    nodeId: params.nodeId,
    sessionId: params.sessionId,
    nodeNonce: params.nodeNonce,
    gatewayNonce: params.gatewayNonce
  };
}
async function execShell(paramsCommand, opts) {
  return await new Promise((resolve) => {
    exec(
      paramsCommand,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        env: opts.env ? { ...process2.env, ...opts.env } : process2.env,
        maxBuffer: 10 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({
            stdout,
            stderr,
            exitCode: 0,
            signal: null,
            timedOut: false
          });
          return;
        }
        const anyErr = err;
        const timedOut = Boolean(anyErr.killed) && (String(anyErr.message).toLowerCase().includes("timed out") || String(anyErr.code ?? "").toUpperCase() === "ETIMEDOUT");
        const exitCode = typeof anyErr.code === "number" ? anyErr.code : 1;
        resolve({
          stdout,
          stderr,
          exitCode,
          signal: anyErr.signal ?? null,
          timedOut
        });
      }
    );
  });
}
async function sleepMs(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function runTmuxCommand(args) {
  return await new Promise((resolve) => {
    execFile(
      "tmux",
      args,
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({
            ok: true,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            rawCode: 0,
            errorMessage: null
          });
          return;
        }
        const anyErr = err;
        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          rawCode: anyErr.code,
          errorMessage: anyErr.message ?? String(err)
        });
      }
    );
  });
}
function isAllowedCommand(commandName, allowCommands) {
  if (allowCommands.has("*")) return true;
  return allowCommands.has(commandName);
}
function hasDisallowedShellSyntax(command) {
  return /(?:&&|\|\||[;&|`$><\n\r])/.test(command);
}
function validateAllowlistedCommand(command, allowCommands) {
  if (hasDisallowedShellSyntax(command)) {
    return {
      ok: false,
      message: "Shell control operators are not allowed. Use a single allowlisted command without chaining, pipes, redirects, or substitutions."
    };
  }
  const commandName = parseCommandName(command);
  if (!commandName) {
    return {
      ok: false,
      message: "Unable to parse command name."
    };
  }
  if (!isAllowedCommand(commandName, allowCommands)) {
    return {
      ok: false,
      message: `Command "${commandName}" is not allowlisted for this node.`
    };
  }
  return {
    ok: true,
    commandName
  };
}
function parseCommandName(command) {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([^\s]+)/);
  return (match == null ? void 0 : match[1]) ?? null;
}
function normalizeSignal(value) {
  switch (value) {
    case "SIGTERM":
    case "SIGINT":
    case "SIGKILL":
      return value;
    default:
      return null;
  }
}
function parseQuarantineState(value, fallback) {
  if (typeof value !== "string") return fallback;
  switch (value.trim()) {
    case "none":
      return "none";
    case "soft":
      return "soft";
    case "hard":
      return "hard";
    default:
      return fallback;
  }
}
function parseFirewallMode(value, fallback) {
  if (!value) return fallback;
  switch (value.trim()) {
    case "transparent":
      return "transparent";
    case "audit-only":
      return "audit-only";
    case "hermes":
      return "hermes";
    default:
      return fallback;
  }
}
function parsePolicyDenyCommands(value) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const commandName = parseCommandName(trimmed) ?? trimmed;
    if (!commandName) continue;
    out.push(commandName);
  }
  return [...new Set(out.values())].sort((a, b) => a.localeCompare(b));
}
function parsePolicyCtlCommand(command) {
  const tokens = parseCommandTokens(command);
  if (!tokens || tokens.length === 0 || tokens[0] !== POLICYCTL_COMMAND) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${POLICYCTL_COMMAND} command is malformed. Expected: ${POLICYCTL_COMMAND} <show|apply-preset|set-mode|deny>.`
    );
  }
  const args = [];
  let breakGlass = false;
  for (const token of tokens.slice(1)) {
    if (token === "--break-glass") {
      breakGlass = true;
      continue;
    }
    args.push(token);
  }
  if (args.length === 0) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${POLICYCTL_COMMAND} requires a subcommand: show | apply-preset <name> | set-mode <mode> | deny add|remove <command>.`
    );
  }
  if (args[0] === "show") {
    if (args.length !== 1) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} show does not accept extra arguments.`);
    }
    return { action: "show", breakGlass };
  }
  if (args[0] === "apply-preset") {
    if (args.length !== 2) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} apply-preset requires a preset name.`);
    }
    return { action: "apply-preset", presetName: args[1], breakGlass };
  }
  if (args[0] === "set-mode") {
    if (args.length !== 2) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} set-mode requires one mode argument.`);
    }
    const mode = asString(args[1]);
    if (!mode || mode !== "transparent" && mode !== "audit-only" && mode !== "hermes") {
      throw new NodeToolError(
        "INVALID_REQUEST",
        `${POLICYCTL_COMMAND} set-mode must be one of: transparent, audit-only, hermes.`
      );
    }
    return { action: "set-mode", mode, breakGlass };
  }
  if (args[0] === "deny") {
    if (args.length !== 3) {
      throw new NodeToolError(
        "INVALID_REQUEST",
        `${POLICYCTL_COMMAND} deny requires: deny add <command> | deny remove <command>.`
      );
    }
    const operation = args[1];
    const candidate = asString(args[2]) ?? "";
    const commandName = parseCommandName(candidate);
    if (!commandName || commandName !== candidate || !/^[A-Za-z0-9._-]+$/.test(commandName)) {
      throw new NodeToolError(
        "INVALID_REQUEST",
        `${POLICYCTL_COMMAND} deny command name must be a single token matching [A-Za-z0-9._-]+.`
      );
    }
    if (operation === "add") return { action: "deny-add", commandName, breakGlass };
    if (operation === "remove") return { action: "deny-remove", commandName, breakGlass };
    throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} deny operation must be add or remove.`);
  }
  throw new NodeToolError(
    "INVALID_REQUEST",
    `${POLICYCTL_COMMAND} subcommand ${args[0]} is not supported. Use show|apply-preset|set-mode|deny.`
  );
}
function shellCtlSessionNameFromId(sessionId) {
  const base = sessionId.length <= 44 ? sessionId : `${sessionId.slice(0, 36)}_${shortStableHash(sessionId)}`;
  return `nxsh_${base}`;
}
function parseShellCtlSessionId(value) {
  const trimmed = (value ?? "").trim();
  if (!SHELLCTL_SESSION_PATTERN.test(trimmed)) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${SHELLCTL_COMMAND} session must match [A-Za-z0-9._-] and be 1-64 chars.`
    );
  }
  return trimmed;
}
function parseShellCtlInteger(value, flag) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${flag} must be an integer.`);
  }
  return num;
}
function parseShellCtlBool(value, flag) {
  const lowered = value.trim().toLowerCase();
  if (lowered === "1" || lowered === "true" || lowered === "yes" || lowered === "on") return true;
  if (lowered === "0" || lowered === "false" || lowered === "no" || lowered === "off") return false;
  throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${flag} must be one of 1/0/true/false.`);
}
function decodeBase64Utf8OrThrow(value, flag) {
  const decoded = decodeBase64Loose(value);
  if (!decoded) {
    throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${flag} must be valid base64.`);
  }
  return decoded.toString("utf8");
}
function parseShellCtlFlags(tokens) {
  const flags = /* @__PURE__ */ new Map();
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i];
    const value = tokens[i + 1];
    if (!key || !key.startsWith("--")) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} expected --flag arguments; got "${key ?? ""}".`);
    }
    if (value === void 0 || value.startsWith("--")) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${key} requires a value.`);
    }
    if (flags.has(key)) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${key} cannot be specified more than once.`);
    }
    flags.set(key, value);
  }
  return flags;
}
function ensureOnlyShellCtlFlags(flags, allowed) {
  const allow = new Set(allowed);
  for (const key of flags.keys()) {
    if (!allow.has(key)) {
      throw new NodeToolError(
        "INVALID_REQUEST",
        `${SHELLCTL_COMMAND} does not support flag ${key} for this action.`
      );
    }
  }
}
function parseShellCtlCommand(command) {
  const tokens = parseCommandTokens(command);
  if (!tokens || tokens.length < 2 || tokens[0] !== SHELLCTL_COMMAND) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${SHELLCTL_COMMAND} command is malformed. Expected: ${SHELLCTL_COMMAND} <open|send|read|list|close|interrupt>.`
    );
  }
  const action = tokens[1];
  const args = tokens.slice(2);
  if (action === "list") {
    if (args.length > 0) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} list does not accept additional arguments.`);
    }
    return { action: "list" };
  }
  const flags = parseShellCtlFlags(args);
  const sessionId = parseShellCtlSessionId(flags.get("--session"));
  if (action === "open") {
    ensureOnlyShellCtlFlags(flags, ["--session", "--cwd-b64"]);
    const cwdB64 = flags.get("--cwd-b64");
    const cwd = cwdB64 ? decodeBase64Utf8OrThrow(cwdB64, "--cwd-b64") : null;
    return { action: "open", sessionId, cwd };
  }
  if (action === "send") {
    ensureOnlyShellCtlFlags(flags, ["--session", "--payload-b64", "--enter"]);
    const payloadB64 = flags.get("--payload-b64");
    if (!payloadB64) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} send requires --payload-b64.`);
    }
    const payload = decodeBase64Utf8OrThrow(payloadB64, "--payload-b64");
    const enterRaw = flags.get("--enter");
    const enter = enterRaw ? parseShellCtlBool(enterRaw, "--enter") : true;
    return {
      action: "send",
      sessionId,
      payload,
      enter
    };
  }
  if (action === "read") {
    ensureOnlyShellCtlFlags(flags, ["--session", "--cursor", "--wait-ms", "--idle-ms", "--max-chars"]);
    const cursorRaw = flags.get("--cursor");
    const waitRaw = flags.get("--wait-ms");
    const idleRaw = flags.get("--idle-ms");
    const maxCharsRaw = flags.get("--max-chars");
    const cursor = cursorRaw ? Math.max(0, parseShellCtlInteger(cursorRaw, "--cursor")) : 0;
    const waitMs = waitRaw ? Math.max(0, Math.min(SHELLCTL_MAX_WAIT_MS, parseShellCtlInteger(waitRaw, "--wait-ms"))) : 1500;
    const idleMs = idleRaw ? Math.max(50, Math.min(SHELLCTL_MAX_IDLE_MS, parseShellCtlInteger(idleRaw, "--idle-ms"))) : 200;
    const maxChars = maxCharsRaw ? Math.max(128, Math.min(SHELLCTL_MAX_CHARS, parseShellCtlInteger(maxCharsRaw, "--max-chars"))) : 4e3;
    return {
      action: "read",
      sessionId,
      cursor,
      waitMs,
      idleMs,
      maxChars
    };
  }
  if (action === "close") {
    ensureOnlyShellCtlFlags(flags, ["--session"]);
    return { action: "close", sessionId };
  }
  if (action === "interrupt") {
    ensureOnlyShellCtlFlags(flags, ["--session"]);
    return { action: "interrupt", sessionId };
  }
  throw new NodeToolError(
    "INVALID_REQUEST",
    `${SHELLCTL_COMMAND} action ${action} is not supported. Use open|send|read|list|close|interrupt.`
  );
}
function parseCommandTokens(command) {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (tokens.length === 0) return [];
  const out = [];
  for (const token of tokens) {
    if (token.startsWith('"') || token.startsWith("'")) {
      if (token.length < 2 || token[0] !== token[token.length - 1]) return null;
      out.push(token.slice(1, -1));
      continue;
    }
    out.push(token);
  }
  return out;
}
function shortStableHash(input) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}
function resolvePolicyPresetPath(policyPresetDir, presetName) {
  const trimmed = presetName.trim();
  if (!trimmed) {
    throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} apply-preset requires a non-empty preset name.`);
  }
  if (trimmed.length > 128) {
    throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} preset names must be <= 128 characters.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) || trimmed.includes("..")) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${POLICYCTL_COMMAND} preset names can only include letters, numbers, dot, underscore, and dash.`
    );
  }
  const fileName = trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`;
  const root = path.resolve(policyPresetDir);
  const resolved = path.resolve(root, fileName);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} preset path escapes the approved preset directory.`);
  }
  return resolved;
}
function firewallModeStrength(mode) {
  if (mode === "transparent") return 0;
  if (mode === "audit-only") return 1;
  return 2;
}
function shellEscape(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function splitCsv(value, fallback) {
  if (!value || !value.trim()) return [...fallback];
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}
function normalizeFileTransferRoots(value, stateDir) {
  const rawRoots = splitCsv(value, [path.join(stateDir, "file-transfer")]);
  const out = /* @__PURE__ */ new Set();
  for (const raw of rawRoots) {
    const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(stateDir, raw));
    out.add(resolved);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}
function isWithinPath(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function resolvePathViaExistingParent(targetPath) {
  let cursor = path.resolve(targetPath);
  const tail = [];
  while (true) {
    try {
      const base = await fs.realpath(cursor);
      return tail.length > 0 ? path.join(base, ...tail) : base;
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      if (code !== "ENOENT") throw err;
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return tail.length > 0 ? path.join(cursor, ...tail) : cursor;
      }
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
function normalizeMcpAllowPatterns(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const pattern = entry.trim();
    if (!pattern) continue;
    seen.add(pattern);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
function mcpPatternMatches(name, pattern) {
  const value = name.trim();
  if (!value) return false;
  const normalized = pattern.trim();
  if (!normalized) return false;
  if (normalized === "*") return true;
  if (normalized.endsWith("*")) {
    const prefix = normalized.slice(0, -1);
    return value.startsWith(prefix);
  }
  return value === normalized;
}
function clampInt(value, min, max) {
  const str = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!str) return null;
  const num = Number(str);
  if (!Number.isFinite(num)) return null;
  return Math.min(max, Math.max(min, Math.floor(num)));
}
function asString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function asBoolean(value) {
  if (typeof value === "boolean") return value;
  return null;
}
function asNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}
function asStringMap(value) {
  const obj = asObject(value);
  const out = {};
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === "string") out[key] = v;
  }
  return out;
}
function parseSymbolKind(value) {
  if (!value) return null;
  switch (value) {
    case "contact":
    case "account":
    case "secret":
    case "user":
      return value;
    default:
      return null;
  }
}
function truncateOutput(text, maxChars = MAX_OUTPUT_CHARS) {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - maxChars;
  return `${text.slice(0, half)}

[... truncated ${omitted} chars ...]

${text.slice(-half)}`;
}
function toBase64Url(value) {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decodeBase64Loose(value) {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) return null;
  if (/[^A-Za-z0-9+/=]/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}
function parsePublicKey(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let key = null;
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    try {
      key = createPublicKey(trimmed);
    } catch {
      key = null;
    }
  }
  if (!key) {
    const decoded = decodeBase64Loose(trimmed);
    if (decoded) {
      if (decoded.length === 32) {
        try {
          key = createPublicKey({
            key: Buffer.concat([ED25519_SPKI_RAW_PREFIX, decoded]),
            format: "der",
            type: "spki"
          });
        } catch {
          key = null;
        }
      } else {
        try {
          key = createPublicKey({ key: decoded, format: "der", type: "spki" });
        } catch {
          key = null;
        }
      }
    }
  }
  if (!key || key.asymmetricKeyType !== "ed25519") return null;
  const raw = publicKeyRawFromObject(key);
  if (!raw) return null;
  return {
    key,
    raw: toBase64Url(raw),
    fingerprint: createHash("sha256").update(raw).digest("hex")
  };
}
function publicKeyRawFromObject(publicKey) {
  try {
    const der = publicKey.export({ format: "der", type: "spki" });
    if (der.length !== ED25519_SPKI_RAW_PREFIX.length + 32) return null;
    if (!der.subarray(0, ED25519_SPKI_RAW_PREFIX.length).equals(ED25519_SPKI_RAW_PREFIX)) return null;
    return der.subarray(ED25519_SPKI_RAW_PREFIX.length);
  } catch {
    return null;
  }
}
function stableStringify(value) {
  if (value === null || value === void 0) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value;
    const keys = Object.keys(obj).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",");
    return `{${body}}`;
  }
  return JSON.stringify(String(value));
}
function withoutSig(value) {
  const { sig: _sig, ...rest } = value;
  return rest;
}
function signDetachedPayload(payload, privateKey) {
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  return toBase64Url(sign(null, bytes, privateKey));
}
function verifyDetachedPayload(payload, signature, publicKey) {
  const sigBytes = decodeBase64Loose(signature);
  if (!sigBytes) return false;
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  try {
    return verify(null, bytes, publicKey, sigBytes);
  } catch {
    return false;
  }
}
function signEnvelope(envelopeWithoutSig, privateKey) {
  return signDetachedPayload(envelopeWithoutSig, privateKey);
}
function printHelp() {
  process2.stdout.write(
    [
      "Reference Nexus node (signed protocol + system.run/system.which + process primitives)",
      "",
      "Usage:",
      "  tsx examples/nexus-node/reference-node.ts [options]",
      "",
      "Options:",
      "  --gateway <url>                 Gateway websocket URL (default ws://127.0.0.1:18789/nx/nodes)",
      "  --gateway-tls-fingerprint <fp>  Pin SHA-256 cert fingerprint for wss:// gateways (self-signed friendly)",
      "  --node-id <id>                  Node ID (sender becomes node:<id>)",
      "  --name <display-name>           Node display name",
      "  --state-dir <dir>               Local state dir for keys (default ~/.nexus-node)",
      "  --state-backend <sqlite|json>   Persistent backend (default sqlite; minimal profile defaults to json)",
      "  --profile <standard|minimal>    Startup profile (default standard)",
      "  --caps <csv>                    Capability list (default system.run,system.which,process.start,process.status,process.logs,process.cancel,symbols.list,audit.query)",
      "  --allow <csv>                   Allowlisted command names for system.run/process.start (include nexus-policyctl,nexus-shellctl,file_pull,file_push to enable control surfaces)",
      "  --policy-required 1             Fail startup when hermes-policy.json is missing/invalid",
      "  --init                          Bootstrap state dir, keys, policy file, and env template then exit",
      "  --run-after-init 1              Continue startup after --init completes",
      "  --env-file <path>               Env file path used by --init (default <stateDir>/reference-node.env)",
      "  --doctor                        Run startup preflight checks then exit",
      "  --doctor-continue 1             Continue startup after --doctor passes",
      "  --run-timeout-ms <ms>           Max system.run timeout (default 60000)",
      "  --file-transfer-roots <csv>     Allowed absolute roots for file transfer paths (default <stateDir>/file-transfer)",
      "  --file-transfer-max-bytes <n>   Max bytes per file.pull/file.push payload (default 5242880)",
      "  --log-format <text|json>        Log format for stdout and rotating log file (default text)",
      "  --log-file <path>               Log file path (default <stateDir>/logs/reference-node.log)",
      "  --log-max-bytes <n>             Rotate log when current file reaches size in bytes (default 5242880)",
      "  --log-max-files <n>             Number of rotated files to keep (default 5)",
      "  --webhook-host <host>           Local webhook bind host (default 127.0.0.1)",
      "  --webhook-port <port>           Enable node-local webhook listener on this port (default 0=disabled)",
      "  --webhook-path <path>           Local webhook path (default /node-webhook)",
      "  --webhook-max-bytes <n>         Max local webhook request size in bytes (default 262144)",
      "  --webhook-token <token>         Optional bearer/x-nexus-node-webhook-token requirement",
      "  --mcp-bridge 1                  Enable MCP bridge methods (mcp.list/mcp.call/mcp.resources)",
      "  --mcp-bridge-config <path>      MCP bridge JSON config path (default <stateDir>/mcp-bridge.json)",
      "  --mcp-bridge-timeout-ms <ms>    MCP bridge request timeout per server (default 30000)",
      "  --reconnect-min-ms <ms>         Minimum reconnect delay (default 2000)",
      "  --reconnect-max-ms <ms>         Maximum reconnect delay (default 30000)",
      "  --max-clock-skew-ms <ms>        Max accepted signed message skew (default 120000)",
      "  --insecure-allow-nonloopback-ws 1 Allow ws:// to non-loopback hosts (debug only; insecure)",
      "  --insecure-skip-gateway-proof 1 Skip challenge proof verification (debug only)",
      "  --help                          Show this help",
      "",
      "Examples:",
      "  tsx examples/nexus-node/reference-node.ts --gateway ws://127.0.0.1:18789/nx/nodes",
      '  tsx examples/nexus-node/reference-node.ts --allow "echo,uname,ls"',
      ""
    ].join("\n")
  );
}
var invokedPath = process2.argv[1] ? path.resolve(process2.argv[1]) : null;
var currentPath = fileURLToPath(import.meta.url);
if ((process2.env.NEXUS_REFERENCE_NODE_NO_AUTORUN ?? "") !== "1" && invokedPath && invokedPath === currentPath) {
  void runReferenceNode().catch((err) => {
    process2.stderr.write(`[reference-node] fatal: ${err instanceof Error ? err.message : String(err)}
`);
    process2.exitCode = 1;
  });
}
export {
  runReferenceNode
};
//# sourceMappingURL=reference-node.mjs.map