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
            <input type="text" id="targetUrl" placeholder="Enter full URL (e.g., https://example.com)" required>
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

    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            responseType: 'arraybuffer',
            validateStatus: () => true
        });

        const contentType = response.headers['content-type'] || 'text/html';
        res.setHeader('Content-Type', contentType);

        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf-8');
            const origin = new URL(targetUrl).origin;

            html = html.replace(/(href|src)=["']([^"']+)["']/g, (match, attr, val) => {
                if (val.startsWith('http://') || val.startsWith('https://')) {
                    return `${attr}="/fetch?url=${encodeURIComponent(val)}"`;
                } else if (val.startsWith('/')) {
                    return `${attr}="/fetch?url=${encodeURIComponent(origin + val)}"`;
                }
                return match;
            });

            return res.send(html);
        }

        res.send(response.data);
    } catch (err) {
        res.status(500).send(`Failed to proxy request: ${err.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
