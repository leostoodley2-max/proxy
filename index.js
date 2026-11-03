const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Portal Home Page
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Web Gateway</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .card { background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); width: 90%; max-width: 450px; text-align: center; }
        input { width: 100%; padding: 12px; margin-bottom: 15px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 16px; outline: none; }
        input:focus { border-color: #3b82f6; }
        button { width: 100%; padding: 12px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 16px; }
        button:hover { background: #1d4ed8; }
    </style>
</head>
<body>
    <div class="card">
        <h2>Web Gateway</h2>
        <p style="color: #94a3b8; font-size: 14px; margin-bottom: 20px;">Enter a URL to browse</p>
        <form action="/proxy" method="GET">
            <input type="text" name="url" placeholder="https://youtube.com" required autocomplete="off">
            <button type="submit">Go</button>
        </form>
    </div>
</body>
</html>`);
});

// Main Entry Point: Sets the session cookie and loads the initial page
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.redirect('/');
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

    // Set a session cookie remembering what site the user is currently browsing
    res.setHeader('Set-Cookie', `current_target=${encodeURIComponent(targetUrl)}; Path=/; HttpOnly`);

    await proxyRequest(targetUrl, req, res);
});

// Catch-All Router: Intercepts any relative navigation/search requests (like /results) and proxies them using the active session cookie
app.get('*', async (req, res, next) => {
    if (req.path === '/' || req.path === '/proxy') {
        return next();
    }

    // Read the active target from the cookie
    const cookies = req.headers.cookie || '';
    const match = cookies.match(/current_target=([^;]+)/);
    if (!match) {
        return res.redirect('/');
    }

    const targetBase = decodeURIComponent(match[1]);
    
    try {
        // Construct the full absolute URL from the relative path (e.g., /results?search_query=...)
        const absoluteUrl = new URL(req.url, targetBase).href;
        await proxyRequest(absoluteUrl, req, res);
    } catch (err) {
        res.status(500).send(`Proxy Routing Error: ${err.message}`);
    }
});

// Core Proxy Fetch & Rewrite Engine
async function proxyRequest(targetUrl, req, res) {
    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': targetUrl
            },
            responseType: 'arraybuffer',
            maxRedirects: 5,
            validateStatus: () => true
        });

        const contentType = response.headers['content-type'] || 'text/html';
        res.status(response.status);
        res.setHeader('Content-Type', contentType);

        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf-8');
            const $ = cheerio.load(html);

            // Optional cleanup for absolute links to keep them flowing smoothly
            const rewriteUrl = (val) => {
                if (!val) return val;
                const trimmed = val.trim();
                if (trimmed.startsWith('data:') || trimmed.startsWith('javascript:') || trimmed.startsWith('#')) return trimmed;
                try {
                    const absUrl = new URL(trimmed, targetUrl).href;
                    // If it's on the same domain, let relative/catch-all handle it cleanly
                    const targetHost = new URL(targetUrl).hostname;
                    const absHost = new URL(absUrl).hostname;
                    if (absHost.includes(targetHost) || targetHost.includes(absHost)) {
                        return absUrl.replace(new URL(targetUrl).origin, '');
                    }
                    return `/proxy?url=${encodeURIComponent(absUrl)}`;
                } catch (e) {
                    return trimmed;
                }
            };

            $('[href]').each((i, el) => $(el).attr('href', rewriteUrl($(el).attr('href'))));
            $('[src]').each((i, el) => $(el).attr('src', rewriteUrl($(el).attr('src'))));
            $('[action]').each((i, el) => $(el).attr('action', rewriteUrl($(el).attr('action'))));

            return res.send($.html());
        }

        return res.send(response.data);
    } catch (err) {
        res.status(500).send(`Proxy Execution Error: ${err.message}`);
    }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
