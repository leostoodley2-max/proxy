const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// THIS is the key fix - correct path to public folder
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Main proxy route
app.get("/proxy", async (req, res) => {
  let targetUrl = req.query.url;

  if (!targetUrl) return res.redirect("/");

  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl;
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": targetUrl,
      },
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      res.setHeader("Content-Type", contentType);
      response.body.pipe(res);
      return;
    }

    const html = await response.text();
    const baseUrl = new URL(targetUrl);
    const $ = cheerio.load(html);

    const rewrite = (attr) => {
      $(`[${attr}]`).each((_, el) => {
        const original = $(el).attr(attr);
        if (!original || original.startsWith("data:") || original.startsWith("javascript:") || original.startsWith("#")) return;
        let absolute;
        try {
          absolute = new URL(original, baseUrl).href;
        } catch { return; }
        $(el).attr(attr, `/proxy?url=${encodeURIComponent(absolute)}`);
      });
    };

    rewrite("href");
    rewrite("src");
    rewrite("action");

    const toolbar = `
    <div id="proxy-bar" style="
      position:fixed;top:0;left:0;right:0;z-index:99999;
      background:#1a1a2e;color:white;padding:8px 12px;
      display:flex;align-items:center;gap:8px;font-family:sans-serif;
      font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.4);">
      <span style="font-weight:bold;white-space:nowrap;">🌐 Proxy</span>
      <form method="GET" action="/proxy" style="display:flex;flex:1;gap:6px;">
        <input name="url" value="${targetUrl}"
          style="flex:1;padding:5px 10px;border-radius:6px;border:none;font-size:14px;min-width:0;background:white;color:black;"
          placeholder="Enter URL..." />
        <button type="submit"
          style="padding:5px 12px;background:#e94560;color:white;border:none;border-radius:6px;cursor:pointer;">
          Go
        </button>
      </form>
      <a href="/" style="color:#aaa;text-decoration:none;font-size:12px;">Home</a>
    </div>
    <div style="height:46px;"></div>`;

    const finalHtml = $.html().replace("<body", `${toolbar}<body`);
    res.setHeader("Content-Type", "text/html");
    res.send(finalHtml);

  } catch (err) {
    res.status(500).send(`
      <style>body{font-family:sans-serif;padding:40px;background:#1a1a2e;color:white;}</style>
      <h2>❌ Error</h2><p>${err.message}</p>
      <a href="/" style="color:#e94560;">← Go Back</a>
    `);
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
