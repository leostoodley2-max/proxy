// Fixes a bug in Scramjet 1.1.0's Function.prototype.toString source maps.
//
// registerRewrites() (src/client/shared/sourcemaps.ts) reads the original text
// of each "replace" rewrite but never advances its cursor past it, so every
// following record is read from the wrong offset. Pages then see corrupted
// source from fn.toString(); YouTube's player integrity script depends on it,
// so videos stop after ~30 seconds for visitors without saved YouTube data.
//
// The fix adds the missing `cursor += oldLen`. Runs on every install (Render
// installs fresh), and is a no-op once applied.

const fs = require("node:fs");
const path = require("node:path");

const dist = path.join(__dirname, "..", "node_modules", "@mercuryworkshop", "scramjet", "dist");
// let <str>=<decoder>.decode(<buf>.subarray(<cursor>,<cursor>+<len>));  not yet followed by <cursor>+=<len>
const buggy = /(let \w+=\w+\.decode\(\w+\.subarray\((\w+),\2\+(\w+)\)\);)(?!\2\+=\3;)/g;
const fixed = /let \w+=\w+\.decode\(\w+\.subarray\((\w+),\1\+(\w+)\)\);\1\+=\2;/;

for (const name of ["scramjet.all.js", "scramjet.bundle.js"]) {
  const file = path.join(dist, name);
  let code;
  try {
    code = fs.readFileSync(file, "utf8");
  } catch {
    console.warn("[patch-scramjet] " + name + " not found; skipped");
    continue;
  }
  const matches = code.match(buggy) || [];
  if (matches.length === 1) {
    fs.writeFileSync(file, code.replace(buggy, "$1$2+=$3;"));
    console.log("[patch-scramjet] Patched source-map cursor in " + name);
  } else if (matches.length === 0 && fixed.test(code)) {
    console.log("[patch-scramjet] " + name + " already patched");
  } else {
    console.warn("[patch-scramjet] Unexpected code in " + name + " (" + matches.length +
      " matches); left unchanged. YouTube playback may stop after ~30s.");
  }
}
