const dns = require("node:dns/promises");
const net = require("node:net");
const { once } = require("node:events");
const ipaddr = require("ipaddr.js");

// Leave application bytes in the socket's read buffer, including data sent
// in the same TCP segment as the SOCKS reply.
function connectSocks({ socksHost, socksPort }, host, port, signal) {
  const family = net.isIP(host);
  const address = family ? ipaddr.parse(host).toByteArray() : Buffer.from(host);
  if (!family && address.length > 255) throw new Error("SOCKS hostname too long");
  const prefix = family ? [family === 4 ? 1 : 4] : [3, address.length];
  const request = Buffer.from([5, 1, 0, ...prefix, ...address, port >> 8, port & 255]);
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = net.createConnection({ host: socksHost, port: socksPort });
    let stage = "method";
    let remaining;
    function cleanup() {
      socket.off("readable", read);
      socket.off("error", fail);
      socket.off("close", closed);
      socket.off("end", closed);
      signal.removeEventListener("abort", abort);
    }
    function fail(error) {
      cleanup();
      socket.destroy();
      reject(error);
    }
    function abort() { fail(signal.reason); }
    function closed() { fail(new Error("SOCKS connection closed during handshake")); }
    function read() {
      if (stage === "method") {
        const method = socket.read(2);
        if (!method) return;
        if (method[0] !== 5 || method[1] !== 0) return fail(new Error("SOCKS authentication failed"));
        socket.write(request);
        stage = "reply";
      }
      if (stage === "reply") {
        const reply = socket.read(4);
        if (!reply) return;
        if (reply[0] !== 5 || reply[2] !== 0 || ![1, 3, 4].includes(reply[3])) {
          return fail(new Error("Invalid SOCKS reply"));
        }
        if (reply[1] !== 0) {
          const error = new Error("SOCKS CONNECT rejected (" + reply[1] + ")");
          error.socksReply = reply[1];
          return fail(error);
        }
        remaining = { 1: 6, 4: 18 }[reply[3]];
        stage = "address";
      }
      if (remaining === undefined) {
        const size = socket.read(1);
        if (!size) return;
        remaining = size[0] + 2;
      }
      if (!socket.read(remaining)) return;
      cleanup();
      resolve(socket);
    }
    socket.on("readable", read).once("error", fail).once("end", closed).once("close", closed);
    signal.addEventListener("abort", abort, { once: true });
    socket.write(Buffer.from([5, 1, 0]));
  });
}

// Wisp applies its own hostname, port and stream filters before connect().
// Check the actual dial address as well, so DNS changes cannot invalidate
// its decision. Both the SOCKS request and any direct retry use that IP.
function makeTCPSocket(getRoute, options) {
  // A page opens many connections to the same few hosts; remember lookups
  // for a minute instead of resolving the name again for every connection.
  const lookups = new Map(); // hostname -> { address, expires }
  async function resolve(hostname) {
    if (net.isIP(hostname)) return hostname;
    const hit = lookups.get(hostname);
    if (hit && hit.expires > Date.now()) return hit.address;
    const { address } = await dns.lookup(hostname, { order: options.dns_result_order });
    if (lookups.size >= 1000) lookups.delete(lookups.keys().next().value);
    lookups.set(hostname, { address, expires: Date.now() + 60_000 });
    return address;
  }

  return class WispTCPSocket {
    constructor(hostname, port) {
      this.hostname = hostname;
      this.port = port;
      this.cancel = new AbortController();
    }

    async connect() {
      const ip = await resolve(this.hostname);
      const range = ipaddr.process(ip).range();
      if ((!options.allow_loopback_ips && ["loopback", "unspecified"].includes(range)) ||
          (!options.allow_private_ips && ["broadcast", "linkLocal", "carrierGradeNat", "private",
            "reserved", "uniqueLocal", "multicast"].includes(range))) {
        throw new Error("Destination IP blocked");
      }
      const signal = this.cancel.signal;
      signal.throwIfAborted();
      const route = getRoute();
      if (route) {
        try {
          this.socket = await connectSocks(route, ip, this.port,
            AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
        } catch (error) {
          signal.throwIfAborted();
          // A destination refusal is authoritative. Only retry failures of
          // the local relay or handshake, before sending application data.
          if (error.socksReply) {
            lookups.delete(this.hostname); // The cached address may be stale.
            throw error;
          }
        }
      }
      if (!this.socket) {
        this.socket = net.createConnection({ host: ip, port: this.port, signal });
        try {
          await once(this.socket, "connect");
        } catch (error) {
          lookups.delete(this.hostname); // The cached address may be stale.
          throw error;
        }
      }
      if (signal.aborted) {
        this.socket.destroy();
        signal.throwIfAborted();
      }
      this.socket.setNoDelay(true);
      // Errors surface through the reader / write callbacks; this listener
      // only stops a late error (e.g. after destroySoon) crashing the process.
      this.socket.on("error", () => {});
      this.reader = this.socket[Symbol.asyncIterator]();
    }

    async recv() { return (await this.reader.next()).value; }
    send(data) {
      return new Promise((resolve, reject) => {
        this.socket.write(data, error => error ? reject(error) : resolve());
      });
    }
    // The async iterator pulls only when Wisp asks for the next chunk.
    pause() {}
    resume() {}
    close() {
      if (this.reader) this.socket.destroySoon();
      else this.cancel.abort();
    }
  };
}

module.exports = { connectSocks, makeTCPSocket };
