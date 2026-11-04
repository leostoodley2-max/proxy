const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Portal Home Page: Clears session cookie so you never get stuck on a target site
app.get('/', (req, res) => {
    res.setHeader('Set-Cookie', 'current_target=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
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
            <input type="text" name="url" placeholder="https://html.duckduckgo.com" required autocomplete="off">
            <button type="submit">Go</button>
        </form>
    </div>
</body>
</html>`);
});

app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.redirect('/');
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

    res.setHeader('Set-Cookie', `current_target=${encodeURIComponent(targetUrl)}; Path=/; HttpOnly`);
    await streamProxy(targetUrl, req, res);
});

app.get('*', async (req, res, next) => {
    if (req.path === '/' || req.path === '/proxy') return next();

    const cookies = req.headers.cookie || '';
    const match = cookies.match(/current_target=([^;]+)/);
    if (!match) return res.redirect('/');

    const targetBase = decodeURIComponent(match[1]);
    try {
        const absoluteUrl = new URL(req.url, targetBase).href;
        await streamProxy(absoluteUrl, req, res);
    } catch (err) {
        res.status(500).send(`Proxy Error: ${err.message}`);
    }
});

async function streamProxy(targetUrl, req, res) {
    // TWEAK 1: Drop tracking domains immediately to free up Render's CPU/bandwidth
    const blockedDomains = ['google-analytics.com', 'googlesyndication.com', 'doubleclick.net', 'facebook.net'];
    if (blockedDomains.some(domain => targetUrl.includes(domain))) {
        return res.status(204).end();
    }

    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br', // TWEAK 2: Compressed payloads
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': targetUrl
            },
            responseType: 'stream',
            maxRedirects: 5,
            validateStatus: () => true
        });

        const contentType = response.headers['content-type'] || '';
        res.status(response.status);
        res.setHeader('Content-Type', contentType);

        if (contentType.includes('text/html')) {
            let data = '';
            response.data.on('data', chunk => { data += chunk; });
            response.data.on('end', () => {
                // TWEAK 3: High-speed Cheerio parsing options
                const $ = cheerio.load(data, { decodeEntities: false });
                const targetHost = new URL(targetUrl).hostname;

                const rewriteUrl = (val) => {
                    if (!val) return val;
                    const trimmed = val.trim();
                    if (trimmed.startsWith('data:') || trimmed.startsWith('javascript:') || trimmed.startsWith('#')) return trimmed;
                    try {
                        const absUrl = new URL(trimmed, targetUrl).href;
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

                res.send($.html());
            });
        } else {
            response.data.pipe(res);
        }
    } catch (err) {
        res.status(500).send(`Streaming Error: ${err.message}`);
    }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
