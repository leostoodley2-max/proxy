var express = require("express");
var fetch = require("node-fetch");
var cheerio = require("cheerio");
var path = require("path");
var app = express();
var PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

function px(u, base) {
  if (!u || u.startsWith("data:") || u.startsWith("#") || u.startsWith("javascript:") || u.startsWith("mailto:")) return null;
  try { return "/proxy?url=" + encodeURIComponent(new URL(u, base).href); } catch (e) { return null; }
}

app.get("/", function(req, res) {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/proxy", async function(req, res) {
  var target = req.query.url;
  if (!target) return res.redirect("/");
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  try {
    var r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }, redirect: "follow" });
    var ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/html")) { if (ct) res.setHeader("Content-Type", ct); r.body.pipe(res); return; }
    var html = await r.text();
    var base = new URL(target);
    var $ = cheerio.load(html);
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    ["href","src","action"].forEach(function(a) { $("["+a+"]").each(function() { var v = $(this).attr(a); var p = px(v, base); if (p) $(this).attr(a, p); }); });
    $("[srcset]").each(function() { var s = $(this).attr("srcset"); $(this).attr("srcset", s.replace(/(\S+)/g, function(m) { var p = px(m, base); return p || m; })); });
    var o = base.origin;
    var sc = "<script>(function(){var b='"+o+"',p='/proxy?url=',f=window.fetch;window.fetch=function(u,o){if(typeof u=='string'&&u.indexOf('/proxy')!=0){try{u=p+encodeURIComponent(new URL(u,b).href)}catch(e){}}return f.call(window,u,o)};var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u=='string'&&u.indexOf('/proxy')!=0){try{u=p+encodeURIComponent(new URL(u,b).href)}catch(e){}}return x.apply(this,arguments)}})()<\/script>";
    var bar = '<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1a1a2e;padding:6px 10px;display:flex;gap:6px;align-items:center;font-family:sans-serif;color:white;font-size:13px"><form action="/proxy" style="display:flex;flex:1;gap:6px"><input name="url" value="'+target+'" style="flex:1;padding:4px 8px;border-radius:5px;border:none;font-size:13px"><button style="padding:4px 10px;background:#e94560;color:white;border:none;border-radius:5px">Go</button></form><a href="/" style="color:#aaa;font-size:11px">Home</a></div><div style="height:38px"></div>';
    var out = $.html();
    out = out.replace(/<head[^>]*>/i, function(m) { return m + sc; });
    out = out.replace(/<body[^>]*>/i, function(m) { return m + bar; });
    res.send(out);
  } catch (e) { res.status(500).send("<body style='background:#1a1a2e;color:white;padding:40px;font-family:sans-serif'><h2>Error</h2><p>"+e.message+"</p><a href='/' style='color:#e94560'>Back</a></body>"); }
});

app.all("*", async function(req, res) {
  var ref = req.headers.referer || "";
  if (!ref.includes("/proxy?url=")) return res.redirect("/");
  try {
    var d = decodeURIComponent(ref.split("/proxy?url=")[1]);
    var t = new URL(d).origin + req.originalUrl;
    var r = await fetch(t, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    var ct = r.headers.get("content-type") || "";
    if (ct) res.setHeader("Content-Type", ct);
    r.body.pipe(res);
  } catch (e) { res.redirect("/"); }
});

app.listen(PORT, function() { console.log("Proxy running on port " + PORT); });
