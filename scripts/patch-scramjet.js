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
//
// 4. Public suffix list (used only for the Sec-Fetch-Site header): Scramjet
//    downloads it from publicsuffix.org through the proxy tunnel every hour,
//    reads all ~10,000 rules back from IndexedDB on every cross-site request
//    (YouTube makes hundreds), and fails the request outright if the download
//    fails. Fix: load it once per worker from this server (/psl.dat, see
//    server.js), keep it in memory, and fall back to "last two labels"
//    instead of failing.
//
// 5. Request bodies in Safari: the service worker's BareClient sends a
//    POST/PUT body to the network worker by transferring it as a stream,
//    which only Chromium supports. In Safari that fails (or loses the body),
//    breaking YouTube's player API, logins, searches and game APIs. Fix: when
//    streams can't be transferred, send the body as an ArrayBuffer instead.

//
// 6. Same list, CPU: to compare two sites, Scramjet scans all ~10,000 rules
//    and splits each one, twice per cross-site request (~60% of the service
//    worker's time in a request-heavy page). Fix: index the rules once and
//    look up only the suffixes of the hostname (orbitSiteOf below).
//
// 7. IndexedDB: Scramjet opens a new database connection for every cookie
//    and referrer lookup, several per request. Fix: reuse one connection per
//    database (reopened if the browser closes it).
//
// 8. document.referrer: Scramjet returns the page's own URL. Game sitelocks
//    (and analytics, and some logins) check the referrer to see which site
//    embeds them, so games refused to start. Fix: decode the real (proxied)
//    referrer with the configured prefix and codec (public/codec.js) and apply
//    the browser's default policy (full URL same-origin, origin only
//    cross-origin, nothing from https to http).
//
// 9. location.ancestorOrigins was missing from Scramjet's location object;
//    sitelocks read it too. Fix: list the real origins of the proxied
//    parent frames, like the browser does.
//
// 10. CSS added as a text node: Scramjet rewrites <style> CSS set through
//    textContent/innerHTML, but not the most common route, used by webpack's
//    style-loader and many games: style.appendChild(document.createTextNode(css)).
//    Addresses in that CSS (fonts, images) then went to the real site directly:
//    blocked on filtered networks, and visible. Fix: rewrite text appended or
//    inserted into a <style> (appendChild/insertBefore/replaceChild/append/
//    prepend), once per text node.

const fs = require("node:fs");
const path = require("node:path");

// Registrable domain ("site") of a hostname under the public suffix list.
// Injected into Scramjet as source text, so it must be self-contained.
function orbitSiteOf(rules, cache, host) {
  host = host.toLowerCase();
  let hit = cache.get(host);
  if (hit) return hit;
  let index = cache.index;
  if (!index || index.rules !== rules) {
    index = cache.index = { rules, exact: new Set(), wild: new Set(), except: new Set() };
    for (const r of rules) {
      if (r.startsWith("!")) index.except.add(r.slice(1));
      else if (r.startsWith("*.")) index.wild.add(r.slice(2));
      else index.exact.add(r);
    }
    cache.clear();
  }
  const labels = host.split(".");
  let suffix = 1; // the default rule "*": the last label
  if (/^[\d.]+$|:/.test(host)) suffix = labels.length; // an IP address is its own site
  else {
    for (let i = 0; i < labels.length; i++) {
      const name = labels.slice(i).join(".");
      if (index.except.has(name)) { suffix = labels.length - i - 1; break; }
      if (index.exact.has(name) || (i + 1 < labels.length && index.wild.has(labels.slice(i + 1).join(".")))) {
        suffix = labels.length - i;
        break;
      }
    }
  }
  hit = labels.slice(-Math.min(labels.length, suffix + 1)).join(".");
  if (cache.size > 2000) cache.clear();
  cache.set(host, hit);
  return hit;
}

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
  {
    name: "public suffix list",
    files: ["scramjet.all.js"],
    impact: "cross-site requests stay slower and fail if publicsuffix.org can't be reached",
    // async function d(e){let t,r=await s();if(r&&Date.now()<r.expiry)return r.data;try{t=await e.fetch("https://publicsuffix.org/...")}...return await o(n),n}
    buggy: /async function (\w+)\(\w+\)\{let \w+,\w+=await \w+\(\);if\(\w+&&Date\.now\(\)<\w+\.expiry\)return \w+\.data;try\{\w+=await \w+\.fetch\("https:\/\/publicsuffix\.org\/list\/public_suffix_list\.dat"\)\}[^]*?return await \w+\((\w+)\),\2\}/g,
    replace: "let __orbitPsl;async function $1(){return __orbitPsl||(__orbitPsl=fetch(self.location.origin+\"/psl.dat\")" +
      ".then(r=>{if(!r.ok)throw Error(\"HTTP \"+r.status);return r.text()}).then(t=>t.split(\"\\n\").filter(Boolean))" +
      ".catch(()=>(__orbitPsl=null,[])))}",
    fixed: /let __orbitPsl;async function \w+\(\)\{return __orbitPsl\|\|/,
  },
  {
    name: "request bodies without stream transfer",
    files: ["scramjet.all.js"],
    impact: "POST requests may fail in Safari",
    // async fetch(e,t){let r=new Request(e,t),i=...,a=...,s=r.body,o=new URL(r.url);
    buggy: /(async fetch\((\w+),(\w+)\)\{let (\w+)=new Request\(\2,\3\),\w+=[^,]+,\w+=[^,]+,(\w+)=)\4\.body,/g,
    replace: (_, head, a, b, req) => head +
      `await(async()=>{if("GET"===${req}.method||"HEAD"===${req}.method)return ${req}.body||void 0;` +
      `if(${req}.body){if(self.__orbitStreams===void 0)try{let c=new MessageChannel,x=new ReadableStream;` +
      `c.port1.postMessage(x,[x]);self.__orbitStreams=!0}catch(_){self.__orbitStreams=!1}` +
      `if(self.__orbitStreams)return ${req}.body}return await ${req}.arrayBuffer()})(),`,
    fixed: /self\.__orbitStreams===void 0/,
  },
  {
    name: "public suffix lookup speed",
    files: ["scramjet.all.js"],
    impact: "cross-site requests stay slower",
    // async function u(e,t){let r=await d(t),n=e.hostname.toLowerCase().split("."),...return n.slice(-o).join(".")}
    buggy: /async function (\w+)\((\w+),(\w+)\)\{let (\w+)=await (\w+)\(\3\),\w+=\2\.hostname\.toLowerCase\(\)\.split\("\."\)[^]*?return \w+\.slice\(-\w+\)\.join\("\."\)\}/g,
    replace: (_, name, url, client, rules, load) =>
      `const __orbitSites=new Map(),__orbitSiteOf=${orbitSiteOf.toString()};` +
      `async function ${name}(${url},${client}){return __orbitSiteOf(await ${load}(${client}),__orbitSites,${url}.hostname)}`,
    fixed: /__orbitSiteOf\(await \w+\(\w+\),__orbitSites,\w+\.hostname\)/,
  },
  {
    name: "IndexedDB connection reuse",
    files: ["scramjet.all.js"],
    impact: "every request stays slower",
    // function f(e,t,{blocked:r,upgrade:n,blocking:i,terminated:a}={}){let s=indexedDB.open(e,t)
    buggy: /function (\w+)(\(\w+,\w+,\{blocked:\w+,upgrade:\w+,blocking:\w+,terminated:\w+\}=\{\}\)\{let \w+=indexedDB\.open\()/g,
    replace: (_, name, rest) =>
      `const __orbitDbs=new Map();function ${name}(name,version,options){` +
      `if(options)return __orbitOpenDb(name,version,options);` +
      `let key=name+"|"+version,db=__orbitDbs.get(key);` +
      `if(!db){db=__orbitOpenDb(name,version);__orbitDbs.set(key,db);` +
      `const drop=()=>{__orbitDbs.get(key)===db&&__orbitDbs.delete(key)};` +
      `db.then(d=>{d.addEventListener("close",drop);d.addEventListener("versionchange",()=>{drop();d.close()})},drop)}` +
      `return db}function __orbitOpenDb${rest}`,
    fixed: /const __orbitDbs=new Map\(\);function \w+\(name,version,options\)/,
  },
  {
    name: "document.referrer",
    files: ["scramjet.all.js"],
    impact: "game sitelocks see the wrong referrer",
    // Module header `{default:()=>i});var n=r(884);function i(e,t){let r=String;e.Proxy(["Document.prototype.querySelector"`
    // gains access to Scramjet's config (module 37: prefix and codec), then the trap
    // e.Trap("Document.prototype.referrer",{get:()=>e.url.toString()}) (or this patch's
    // earlier /scramjet/-only version) is replaced.
    buggy: /(\{default:\(\)=>(\w+)\}\);var \w+=r\(884\);)(function \2\(e,t\)\{let r=String;e\.Proxy\(\["Document\.prototype\.querySelector"[^]*?)(\w+)\.Trap\("Document\.prototype\.referrer",\{get:(?:\(\)=>\4\.url\.toString\(\)|ctx=>\{let raw;[^]*?from\.origin\+"\/"\})\}\)/g,
    replace: (_, header, _name, body, c) => header + "var __orbitCfg=r(37);" + body +
      `${c}.Trap("Document.prototype.referrer",{get:ctx=>{` +
      `let raw;try{raw=ctx.get()}catch(x){return""}if(!raw)return"";` +
      `let from;try{let p=new URL(raw),pre=__orbitCfg.$W.prefix;if(p.origin!==location.origin||!p.pathname.startsWith(pre))return"";` +
      `from=new URL(__orbitCfg.P_(p.pathname.slice(pre.length)))}catch(x){return""}` +
      `let here=${c}.url;if(from.protocol==="https:"&&here.protocol==="http:")return"";` +
      `return from.origin===here.origin?from.href:from.origin+"/"}})`,
    fixed: /__orbitCfg\.P_\(p\.pathname\.slice\(pre\.length\)\)/,
  },
  {
    name: "CSS text nodes in <style>",
    files: ["scramjet.all.js"],
    impact: "fonts and images in script-added CSS load directly from the real site",
    // e.Proxy("Text.prototype.appendData",{apply(t){t.this.parentElement?.tagName==="STYLE"&&(t.args[0]=(0,i.s)(t.args[0],e.meta))}}),
    buggy: /((\w+)\.Proxy\("Text\.prototype\.appendData",\{apply\(t\)\{t\.this\.parentElement\?\.tagName==="STYLE"&&\(t\.args\[0\]=\(0,(\w+)\.(\w+)\)\(t\.args\[0\],\2\.meta\)\)\}\}\),)/g,
    replace: (_, original, c, mod, fn) => original +
      `${c}.Proxy(["Node.prototype.appendChild","Node.prototype.insertBefore","Node.prototype.replaceChild","Element.prototype.append","Element.prototype.prepend"],{apply(t){` +
      `let p=t.this;if(!p||p.localName!=="style")return;let done=self.__orbitCssDone||(self.__orbitCssDone=new WeakSet);` +
      `let all=/append|prepend/.test(t.fn&&t.fn.name||"")?t.args:[t.args[0]];` +
      `for(let k=0;k<t.args.length;k++){let a=t.args[k];if(!all.includes(a))continue;` +
      `if(typeof a==="string"&&all===t.args){t.args[k]=(0,${mod}.${fn})(a,${c}.meta)}` +
      `else if(a&&a.nodeType===3&&!done.has(a)){a.data=(0,${mod}.${fn})(a.data,${c}.meta);done.add(a)}}}}),`,
    fixed: /self\.__orbitCssDone\|\|/,
  },
  {
    name: "location.ancestorOrigins",
    files: ["scramjet.all.js"],
    impact: "game sitelocks can't see the embedding site",
    // function s(e,t){let r=a.iswindow?t.Location:t.WorkerLocation,s={};Object.setPrototypeOf(s,r.prototype),s.constructor=r;
    buggy: /(function \w+\(\w+,(\w+)\)\{let (\w+)=(\w+)\.iswindow\?\2\.Location:\2\.WorkerLocation,(\w+)=\{\};Object\.setPrototypeOf\(\5,\3\.prototype\),\5\.constructor=\3;)/g,
    replace: (_, head, win, _loc, env, obj) => head +
      `${env}.iswindow&&Object.defineProperty(${obj},"ancestorOrigins",{enumerable:!0,configurable:!1,get(){` +
      `let list=[],w=${win};try{for(;w.parent!==w;){w=w.parent;let c=w[Symbol.for("scramjet client global")];` +
      `if(!c)break;list.push(c.url.origin)}}catch(x){}` +
      `let out={length:list.length,item:i=>list[i]??null,contains:v=>list.includes(v),[Symbol.iterator]:()=>list[Symbol.iterator]()};` +
      `list.forEach((v,i)=>{out[i]=v});return out}});`,
    fixed: /\.iswindow&&Object\.defineProperty\(\w+,"ancestorOrigins"/,
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
    // Check "already patched" first: a patched file can still match `buggy`
    // (e.g. the renamed original function), and patching twice breaks it.
    if (patch.fixed.test(code)) {
      console.log("[patch-scramjet] " + patch.name + " already patched in " + name);
      continue;
    }
    const matches = code.match(patch.buggy) || [];
    if (matches.length === 1) {
      sources[name] = code.replace(patch.buggy, patch.replace);
      fs.writeFileSync(file, sources[name]);
      console.log("[patch-scramjet] Patched " + patch.name + " in " + name);
    } else {
      console.warn("[patch-scramjet] Unexpected code in " + name + " (" + matches.length +
        " matches for " + patch.name + "); left unchanged. " + patch.impact[0].toUpperCase() +
        patch.impact.slice(1) + ".");
    }
  }
}
