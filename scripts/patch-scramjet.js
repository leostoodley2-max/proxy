// Fixes bugs in Scramjet 1.1.0. Runs on every install (Render installs
// fresh); each patch is a no-op once applied.
//
// 1. Function.prototype.toString source maps: registerRewrites()
//    (src/client/shared/sourcemaps.ts) reads the original text of each
//    "replace" rewrite but never advances its cursor past it, so every
//    following record is read from the wrong offset. Pages then see corrupted
//    source from fn.toString(); YouTube's player integrity script depends on
//    it, so videos stop after ~30 seconds for visitors without saved YouTube
//    data. Fix: add the missing `cursor += oldLen`.
//
// 2. Pages stalling on responses that set cookies: for a script, image or API
//    response with Set-Cookie, the service worker posts the cookie to the page
//    and waits for a reply before handing over the response. A page only
//    receives service worker messages once it has finished parsing, so a
//    parser-blocking <script> with Set-Cookie (common, e.g. Cloudflare's
//    __cf_bm) deadlocks the page forever. Fix: the page starts receiving
//    messages straight away (ServiceWorkerContainer.startMessages()).
//
// 3. The same code sends the cookie's array index ("0") instead of the
//    cookie itself, so pages saw a junk cookie. Fix: iterate the values.

const fs = require("node:fs");
const path = require("node:path");

const dist = path.join(__dirname, "..", "node_modules", "@mercuryworkshop", "scramjet", "dist");

const patches = [
  {
    name: "source-map cursor",
    files: ["scramjet.all.js", "scramjet.bundle.js"],
    impact: "YouTube playback may stop after ~30s",
    // let <str>=<decoder>.decode(<buf>.subarray(<cursor>,<cursor>+<len>));  not yet followed by <cursor>+=<len>
    buggy: /(let \w+=\w+\.decode\(\w+\.subarray\((\w+),\2\+(\w+)\)\);)(?!\2\+=\3;)/g,
    replace: "$1$2+=$3;",
    fixed: /let \w+=\w+\.decode\(\w+\.subarray\((\w+),\1\+(\w+)\)\);\1\+=\2;/,
  },
  {
    name: "cookie message deadlock",
    files: ["scramjet.all.js"],
    impact: "pages may stall on scripts that set cookies",
    // function n(e,t){e.serviceWorker.addEventListener("message",({data:t})=>{if("scramjet$type"in t&&"cookie"===
    buggy: /(function \w+\((\w+),\w+\)\{)(\2\.serviceWorker\.addEventListener\("message",\(\{data:\w+\}\)=>\{if\("scramjet\$type"in \w+&&"cookie"===)/g,
    replace: "$1try{$2.serviceWorker.startMessages()}catch(e){}$3",
    fixed: /\{try\{\w+\.serviceWorker\.startMessages\(\)\}catch\(e\)\{\}\w+\.serviceWorker\.addEventListener\("message",/,
  },
  {
    name: "cookie message value",
    files: ["scramjet.all.js"],
    impact: "pages may see a junk cookie",
    // for(let t in x)if(h){let r=f.dispatch(h,{scramjet$type:"cookie",cookie:t,
    buggy: /for\(let (\w+) in (\w+)\)if\((\w+)\)\{let (\w+)=(\w+)\.dispatch\(\3,\{scramjet\$type:"cookie",cookie:\1,/g,
    replace: "for(let $1 of $2 instanceof Array?$2:[$2])if($3){let $4=$5.dispatch($3,{scramjet$type:\"cookie\",cookie:$1,",
    fixed: /for\(let (\w+) of (\w+) instanceof Array\?\2:\[\2\]\)if\((\w+)\)\{let \w+=\w+\.dispatch\(\3,\{scramjet\$type:"cookie",cookie:\1,/,
  },
];

const sources = {};
for (const patch of patches) {
  for (const name of patch.files) {
    const file = path.join(dist, name);
    if (!(name in sources)) {
      try {
        sources[name] = fs.readFileSync(file, "utf8");
      } catch {
        sources[name] = null;
        console.warn("[patch-scramjet] " + name + " not found; skipped");
      }
    }
    const code = sources[name];
    if (code === null) continue;
    const matches = code.match(patch.buggy) || [];
    if (matches.length === 1) {
      sources[name] = code.replace(patch.buggy, patch.replace);
      fs.writeFileSync(file, sources[name]);
      console.log("[patch-scramjet] Patched " + patch.name + " in " + name);
    } else if (matches.length === 0 && patch.fixed.test(code)) {
      console.log("[patch-scramjet] " + patch.name + " already patched in " + name);
    } else {
      console.warn("[patch-scramjet] Unexpected code in " + name + " (" + matches.length +
        " matches for " + patch.name + "); left unchanged. " + patch.impact[0].toUpperCase() +
        patch.impact.slice(1) + ".");
    }
  }
}
