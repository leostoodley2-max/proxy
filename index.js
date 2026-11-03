const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const htmlUI = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Web Proxy Hub</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body { display: flex; flex-direction: column; height: 100vh; background-color: #111827; color: #f3f4f6; }
        header { display: flex; align-items: center; padding: 12px 20px; background-color: #1f2937; border-bottom: 1px solid #374151; gap: 10px; }
        .btn { background: #374151; color: #f3f4f6; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 500; }
        .btn:hover { background: #4b5563; }
        form { display: flex; flex: 1; gap: 10px; }
        input[type="text"] { flex: 1; padding: 10px 14px; border-radius: 6px; border: 1px solid #4b5563; background-color: #0f172a; color: #f3f4f6; outline: none; }
        input[type="text"]:focus { border-color: #3b82f6; }
        button[type="submit"] { background-color: #2563eb; color: #ffffff; font-weight: 600; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; }
        button[type="submit"]:hover { background-color: #1d4ed8; }
        iframe { flex: 1; border: none; background-color: #ffffff; }
    </style>
</head>
<body>
    <header>
        <button class="btn" onclick="historyBack()">&#8592; Back</button>
        <button class="btn" onclick="reloadFrame()">&#8635; Refresh</button>
        <form id="proxyForm">
            <input type="text" id="targetUrl" placeholder="Enter URL (e.g., example.com)" required>
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
        function reloadFrame() {
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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            responseType: 'arraybuffer',
            validateStatus: () => true
        });

        const contentType = response.headers['content-type'] || 'text/html';
        res.setHeader('Content-Type', contentType);

        // Remove frame restrictions
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');

        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf-8');
            const targetObj = new URL(targetUrl);
            const origin = targetObj.origin;

            // Handle relative and absolute link rewriting
            html = html.replace(/(href|src)=["']([^"']+)["']/g, (match, attr, val) => {
                if (val.startsWith('http://') || val.startsWith('https://')) {
                    return `${attr}="/fetch?url=${encodeURIComponent(val)}"`;
                } else if (val.startsWith('//')) {
                    return `${attr}="/fetch?url=${encodeURIComponent('https:' + val)}"`;
                } else if (val.startsWith('/')) {
                    return `${attr}="/fetch?url=${encodeURIComponent(origin + val)}"`;
                } else if (!val.startsWith('#') && !val.startsWith('javascript:') && !val.startsWith('data:')) {
                    return `${attr}="/fetch?url=${encodeURIComponent(origin + '/' + val)}"`;
                }
                return match;
            });

            return res.send(html);
        }

        res.send(response.data);
    } catch (err) {
        // Send a readable error page into the iframe so you know why it failed
        res.status(500).send(`
            <div style="font-family:sans-serif; padding:40px; color:#333; background:#fee2e2; border:1px solid #f87171; border-radius:8px; margin:20px;">
                <h2 style="color:#991b1b; margin-bottom:10px;">Proxy Navigation Failed</h2>
                <p>Could not fetch target resource via proxy server.</p>
                <p style="margin-top:15px; font-family:monospace; background:#fff; padding:10px; border-radius:4px;">Error: ${err.message}</p>
                <p style="margin-top:15px; font-size:14px; color:#555;">Tip: Try testing with a basic site like <strong>example.com</strong>. Heavy sites (like Google or YouTube) use advanced anti-bot protections that block simple server proxies.</p>
            </div>
        `);
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

