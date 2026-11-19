const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Better headers to bypass verification
const getHeaders = (targetUrl) => ({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Referer": targetUrl,
  "Origin": new URL(targetUrl).origin,
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Handle ALL methods (GET, POST, etc.)
app.all("/proxy", async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) return res.redirect("/");

  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl;
  }

  try {
    const fetchOptions = {
      method: req.method,
      headers: getHeaders(targetUrl),
      redirect: "follow",
    };

    // Forward POST body
    if (req.method === "POST") {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get("content-type") || "";

    // Forward important response headers
    const allowedHeaders = [
      "content-type", "cache-control", "expires",
      "last-modified", "etag", "vary"
    ];
    allowedHeaders.forEach(h => {
      const val = response.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    // Stream non-HTML directly (fast)
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/css") &&
      !contentType.includes("javascript")
    ) {
      res.status(response.status);
      response.body.pipe(res);
      return;
    }

    // Rewrite CSS urls
    if (contentType.includes("text/css")) {
      const css = await response.text();
      const baseUrl = new URL(targetUrl);
      const rewrittenCss = css.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, u) => {
        if (u.startsWith("data:")) return match;
        try {
          const abs = new URL(u, baseUrl).href;
          return `url('/proxy?url=${encodeURIComponent(abs)}')`;
        } catch { return match; }
      });
      res.setHeader("Content-Type", "text/css");
      return res.send(rewrittenCss);
    }

    // Rewrite JS fetch/XHR calls
    if (contentType.includes("javascript")) {
      const js = await response.text();
      const baseUrl = new URL(targetUrl);
      // Inject a fetch interceptor at the top
      const interceptor = `
(function() {
  const _originalFetch = window.fetch;
  const _proxyBase = '/proxy?url=';
  const _base = '${new URL(targetUrl).origin}';
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && !url.startsWith('/proxy')) {
      try {
        const abs = new URL(url, _base).href;
        url = _proxyBase + encodeURIComponent(abs);
      } catch(e) {}
    }
    return _originalFetch(url, opts);
  };
})();
`;
      res.setHeader("Content-Type", "application/javascript");
      return res.send(interceptor + js);
    }

    // HTML rewriting
    const html = await response.text();
    const baseUrl = new URL(targetUrl);
    const $ = cheerio.load(html);

    // Remove CSP and other blocking meta tags
    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    // Rewrite attributes
    const rewriteAttr = (attr) => {
      $(`[${attr}]`).each((_, el) => {
        const original = $(el).attr(attr);
        if (
          !original ||
          original.startsWith("data:") ||
          original.startsWith("javascript:") ||
          original.startsWith("#") ||
          original.startsWith("mailto:") ||
          original.startsWith("tel:")
        ) return;
        try {
          const absolute = new URL(original, baseUrl).href;
          $(el).attr(attr, `/proxy?url=${encodeURIComponent(absolute)}`);
        } catch { return; }
      });
    };

    rewriteAttr("href");
    rewriteAttr("src");
    rewriteAttr("action");

    // Rewrite srcset
    $("[srcset]").each((_, el) => {
      const srcset = $(el).attr("srcset");
      const rewritten = srcset.replace(/(\S+)(\s+[\d.]+[wx])?/g, (match, u, descriptor) => {
        if (!u || u.startsWith("data:")) return match;
        try {
          const abs = new URL(u, baseUrl).href;
          return `/proxy?url=${encodeURIComponent(abs)}${descriptor || ""}`;
        } catch { return match; }
      });
      $(el).attr("srcset", rewritten);
    });

    // Rewrite inline styles with url()
    $("[style]").each((_, el) => {
      const style = $(el).attr("style");
      const rewritten = style.replace(/url\(['"]?([^'")]+)['"]?\)/g, (match, u) => {
        if (u.startsWith("data:")) return match;
        try {
          const abs = new URL(u, baseUrl).href;
          return `url('/proxy?url=${encodeURIComponent(abs)}')`;
        } catch { return match; }
      });
      $(el).attr("style", rewritten);
    });

    // Inject fetch/XHR interceptor into page
    const interceptorScript = `
<script>
(function() {
  const _base = '${new URL(targetUrl).origin}';
  const _proxy = '/proxy?url=';

  // Intercept fetch
  const _fetch = window.fetch;
  window.fetch = function(
