// Compresses the proxy engine files once, at install time, so the server
// doesn't have to compress ~3 MB on every first visit (slow on a small
// Render instance). Output goes to precompressed/<url path>.br|.gz and is
// served by server.js when the browser accepts it. Must run after
// patch-scramjet.js, which changes scramjet.all.js.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const { libcurlPath } = require("@mercuryworkshop/libcurl-transport");

const out = path.join(__dirname, "..", "precompressed");
// Only the files the app loads (see public/index.html, engine.js and sw.js).
const files = {
  "/scram/": [scramjetPath, ["scramjet.all.js", "scramjet.wasm.wasm", "scramjet.sync.js"]],
  "/baremux/": [baremuxPath, ["index.js", "worker.js"]],
  "/libcurl/": [libcurlPath, ["index.mjs"]],
};

try {
  fs.rmSync(out, { recursive: true, force: true });
  let count = 0;
  for (const [mount, [dir, names]] of Object.entries(files)) {
    for (const name of names) {
      const data = fs.readFileSync(path.join(dir, name));
      const target = path.join(out, mount, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target + ".br", zlib.brotliCompressSync(data, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length },
      }));
      fs.writeFileSync(target + ".gz", zlib.gzipSync(data, { level: 9 }));
      count++;
    }
  }
  console.log("[precompress] Compressed " + count + " engine files");
} catch (error) {
  // Not fatal: the server compresses on the fly when these are missing.
  console.warn("[precompress] Skipped: " + error.message);
}
