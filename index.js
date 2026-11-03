const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Browser Client Interface
const htmlUI = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Robust Web Proxy</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body { display: flex; flex-direction: column; height: 100vh; background-color: #0f172a; color: #f8fafc; }
        header { display: flex; align-items: center; padding: 12px 20px; background-color: #1e293b; border-bottom: 1px solid #334155; gap: 12px; }
        .nav-btn { background: #334155; color: #f8fafc; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; }
        .nav-btn:hover { background: #475569; }
        form { display: flex; flex: 1; gap: 10px; }
        input[type="text"] { flex: 1; padding: 10px 16px; border-radius: 6px; border: 1px solid #475569; background-color: #020617; color: #f8fafc; outline: none; font-size: 14px; }
        input[type="text"]:focus { border-color: #3b82f6; }
        button[type="submit"] { background-color: #2563eb; color: #ffffff; font-weight: 600; border: none; padding: 10px 24px; border-radius: 6px; cursor: pointer; }
        button[type="submit"]:hover { background-color: #1d4ed8; }
        iframe { flex: 1; border: none; background-color: #ffffff; }
    </style>
</head>
<body>
    <header>
        <button class="nav-btn" onclick="historyBack()">&#8592; Back</button>
        <button class="nav-btn" onclick="refreshFrame()">&#8635; Refresh</button>
        <form id="proxyForm">
            <input type="text" id="targetUrl" placeholder="Enter URL or domain (e.g., example.com)" required>
            <button type="submit">Browse</button>
        </form>
    </header>
    <iframe id="viewport" src="about:blank"></iframe>

    <script>
        const form = document.getElementById('proxyForm');
        const input = document.getElementById('targetUrl');
        const iframe = document.getElementById('viewport');

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            let url = input.value.trim();
            if (!url) return;

            if (!/^https?:\/\//i.test(url)) {
                url = 'https://' + url;
                input.value = url;
            }

            iframe.src = '/fetch?url=' + encodeURIComponent(url);
        });

        function historyBack() {
            try { iframe.contentWindow.history.back(); } catch (e) {}
        }
        function refreshFrame() {
            iframe.src = iframe.src;
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => {
    res.send(htmlUI);
});

app.get('/fetch', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Target URL required.');

    if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Cache-Control': 'no-cache'
            },
            responseType: 'arraybuffer',
            maxRedirects: 5,
            validateStatus: () => true
        });

        const contentType = response.headers['content-type'] || 'text/html';
        res.setHeader('Content-Type', contentType);

        // Strip security headers that block iframe rendering
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Content-Type-Options');

        // If HTML, inject the base tag so the browser automatically handles relative assets through the proxy
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf-8');
            
            // Ensure trailing slash on target base URL for accurate browser resolution
            const parsedUrl = new URL(targetUrl);
            const baseHref = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
            const proxyBaseTag = `<base href="/fetch?url=${encodeURIComponent(baseHref)}">`;

            // Inject base tag right after <head>
            if (/<head[^>]*>/i.test(html)) {
                html = html.replace(/<head[^>]*>/i, match => `${match}\n${proxyBaseTag}`);
            } else {
                html = proxyBaseTag + html;
            }

            return res.send(html);
        }

        // Return binary / assets directly (CSS, images, JS)
        return res.send(response.data);

    } catch (err) {
        res.status(500).send(`
            <div style="font-family:sans-serif; padding:30px; background:#fef2f2; border:1px solid #f87171; border-radius:8px; margin:20px;">
                <h3 style="color:#991b1b; margin-bottom:8px;">Proxy Request Failed</h3>
                <p style="font-family:monospace; background:#fff; padding:10px; border-radius:4px;">${err.message}</p>
            </div>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
