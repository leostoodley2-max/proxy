

const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const getHeaders = (targetUrl) => {
  try {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
      "Referer": targetUrl,
      "Origin": new URL(targetUrl).origin,
    };
  } catch {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };
  }
};

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Main proxy route
app.all("/proxy", async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.redirect("/");
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl;
  }
  return handleProxy(targetUrl, req, res);
});

// THIS is the key fix — catches /results, /watch, /search etc.
app.all("*", async (req, res, next) => {
  const referer = req.headers.referer || "";

  // Only intercept if came from a proxied page
  if (!referer.includes("/proxy?url=")) return next();

  try {
    // Extract the base URL from referer
    const refererUrl = new URL(decodeURIComponent(
      referer.split("/proxy?url=")[1]
    ));
    const baseOrigin = refererUrl.origin;

    // Build the full target URL
    const targetUrl = baseOrigin + req.url;
    return handleProxy(targetUrl, req, res);
  } catch (err) {
    return next();
  }
});

async function handleProxy(targetUrl, req, res) {
  try {
    const fetchOptions = {
      method: req.method === "GET" ? "GET" : req.method,
      headers: getHeaders(targetUrl),
      redirect: "follow",
    };

    if (req.method === "POST") {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get("content-type") || "";

    // Remove security headers
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");

    // Forward safe headers
    ["content-type", "cache-control", "expires", "last-modified"].forEach(h => {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    // Stream binary/media directly
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/css") &&
      !contentType.includes("javascript")
    ) {
      res.status(response.status);
      response.body.pipe(res);
      return;
    }

    // Rewrite CSS
    if (contentType.includes("text/css")) {
      const css = await response.text();
      const baseUrl = new URL(targetUrl);
      const rewritten = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, u) => {
        if (u.startsWith("data:")) return match;
        try {
          const abs = new URL(u, baseUrl).href;
          return `url('/proxy?url=${encodeURIComponent(abs)}')`;
        } catch { return match; }
      });
      res.setHeader("Content-Type", "text/css");
      return res.send(rewritten);
    }

    // Rewrite JS
    if (contentType.includes("javascript")) {
      const js = await response.text();
      let origin = "";
      try { origin = new URL(targetUrl).origin; } catch {}
      const interceptor = `
(function(){
  const _b='${origin}';
  const _p='/proxy?url=';
  const _f=window.fetch.bind(window);
  window.fetch=function(u,o){
    if(typeof u==='string'&&!u.startsWith('/proxy')){
      try{u=_p+encodeURIComponent(new URL(u,_b).href);}catch(e){}
    }
    return _f(u,o);
  };
  const _xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u,...a){
    if(typeof u==='string'&&!u.startsWith('/proxy')){
      try{u=_p+encodeURIComponent(new URL(u,_b).href);}catch(e){}
    }
    return _xo.call(this,m,u,...a);
  };
})();`;
      res.setHeader("Content-Type", "application/javascript");
      return res.send(interceptor + js);
    }

    // Rewrite HTML
    const html = await response.text();
    const baseUrl = new URL(targetUrl);
    const $ = cheerio.load(html);

    // Remove blocking tags
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    const rewriteAttr = (attr) => {
      $(`[${attr}]`).each((_, el) => {
        const val = $(el).attr(attr);
        if (!val || val.startsWith("data:") || val.startsWith("javascript:") ||
            val.startsWith("#") || val.startsWith("mailto:") || val.startsWith("tel:")) return;
        try {
          const abs = new URL(val, baseUrl).href;
          $(el).attr(attr, `/proxy?url=${encodeURIComponent(abs)}`);
        } catch {}
      });
    };

    rewriteAttr("href");
    rewriteAttr("src");
    rewriteAttr("action");

    // Rewrite srcset
    $("[srcset]").each((_, el) => {
      const srcset = $(el).attr("srcset");
      const rewritten = srcset.replace(/(\S+)(\s+[\d.]+[wx])?/g, (match, u, d) => {
        if (!u || u.startsWith("data:")) return match;
        try {
          const abs = new URL
