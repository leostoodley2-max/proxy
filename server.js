var express = require("express");
var fetch = require("node-fetch");
var cheerio = require("cheerio");
var path = require("path");

var app = express();
var PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function getHeaders(targetUrl) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Upgrade-Insecure-Requests": "1"
  };
}

function makeAbsolute(u, base) {
  if (!u) return null;
  if (u.startsWith("data:") || u.startsWith("javascript:") || u.startsWith("#") || u.startsWith("mailto:")) return null;
  try { return new URL(u, base).href; } catch (e) { return null; }
}

function proxyUrl(u, base) {
  var abs = makeAbsolute(u, base);
  if (!abs) return null;
  return "/proxy?url=" + encodeURIComponent(abs);
}

app.get("/", function(req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.all("/proxy", async function(req, res) {
  var targetUrl = req.query.url;
  if (!targetUrl) return res.redirect("/");
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;

  try {
    var resp = await fetch(targetUrl, {
      method: req.method,
      headers: getHeaders(targetUrl),
      redirect: "follow"
    });

    var ct = resp.headers.get("content-type") || "";

    if (!ct.includes("text/html") && !ct.includes("text/css") && !ct.includes("javascript")) {
      if (ct) res.setHeader("Content-Type", ct);
      resp.body.pipe(res);
      return;
    }

    if (ct.includes("text/css")) {
      var css = await resp.text();
      css = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, function(match, u) {
        var p = proxyUrl(u, targetUrl);
        return p ? "url('" + p + "')" : match;
      });
      res.setHeader("Content-Type", "text/css");
      res.send(css);
      return;
    }

    if (ct.includes("javascript")) {
      var js = await resp.text();
      res.setHeader("Content-Type", "application/javascript");
      res.send(js);
      return;
    }

    var html = await resp.text();
    var base = new URL(targetUrl);
    var $ = cheerio.load(html);

    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    ["href", "src", "action"].forEach(function(attr) {
      $("[" + attr + "]").each(function() {
        var val = $(this).attr(attr);
        var p = proxyUrl(val, base);
        if (p) $(this).attr(attr, p);
      });
    });

    $("[srcset]").each(function() {
      var srcset = $(this).attr("srcset");
      var rewritten = srcset.replace(/(\S+)(\s+[\d.]+[wx])?/g, function(m, u, d) {
        var p = proxyUrl(u, base);
        return p ? p + (d || "") : m;
      });
      $(this).attr("srcset", rewritten);
    });

    $("[style]").each(function() {
      var style = $(this).attr("style");
      var rewritten = style.replace(/url\(['"]?([^'")]+)['"]?\)/g, function(match, u) {
        var p = proxyUrl(u, base);
        return p ? "url('" + p + "')" : match;
      });
      $(this).attr("style", rewritten);
    });

    var origin = base.origin;
    var injectedScript = "<script>(function(){var b='" + origin + "';var p='/proxy?url=';var of=window.fetch;window.fetch=function(u,o){if(typeof u==='string'&&u.indexOf('/proxy')!==0){try{u=p+encodeURIComponent(new URL(u,b).href)}catch(e){}}return of.call(window,u,o)};var ox=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string'&&u.indexOf('/proxy')!==0){try{u=p+encodeURIComponent(new URL(u,b).href)}catch(e){}}return ox.apply(this,arguments)}})();<\/script>";

    var toolbar = '<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1a1a2e;padding:8px 12px;display:flex;align-items:center;gap:8px;font-family:sans-serif;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.4);color:white;"><span style="font-weight:bold;">P</span><form method="GET" action="/proxy" style="display:flex;flex:1;gap:6px;"><input name="url" value="' + targetUrl + '" style="flex:1;padding:5px 10px;border-radius:6px;border:none;font-size:14px;background:white;color:black;" /><button type="submit" style="padding:5px 12px;background:#e94560;color:white;border:none;border-radius:6px;cursor:pointer;">Go</button></form><a href="/" style="color:#aaa;text-decoration:none;font-size:12px;">Home</a></div><div style="height:46px;"></div>';

    var output = $.html();
    output = output.replace(/<head[^>]*>/i, function(m) { return m + injectedScript; });
    output = output.replace(/<body[^>]*>/i, function(m) { return m + toolbar; });

    res.setHeader("Content-Type", "text/html");
    res.send(output);

  } catch (err) {
    res.status(500).send("<html><body style='font-family:sans-serif;padding:40px;background:#1a1a2e;color:white;'><h2>Error</h2><p>" + err.message + "</p><a href='/' style='color:#e94560;'>Go Back</a></body></html>");
  }
});

app.all("*", async function(req, res) {
  var referer = req.headers.referer || "";
  if (!referer.includes("/proxy?url=")) {
    return res.redirect("/");
  }
  try {
    var encoded = referer.split("/proxy?url=")[1];
    var decoded = decodeURIComponent(encoded);
    var refUrl = new URL(decoded);
    var target = refUrl.origin + req.originalUrl;
    var resp = await fetch(target, { headers: getHeaders(target),
