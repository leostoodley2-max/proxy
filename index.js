const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Frontend UI Portal
const htmlUI = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Web Gateway</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body { background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; height: 100vh; }
        header { padding: 12px 20px; background: #1e293b; display: flex; gap: 10px; border-bottom: 1px solid #334155; align-items: center; }
        .btn { background: #334155; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 500; }
        .btn:hover { background: #475569; }
        form { display: flex; flex: 1; gap: 10px; }
        input { flex: 1; padding: 10px 14px; background: #020617; border: 1px solid #475569; color: #fff; border-radius: 6px; outline: none; font-size: 14px; }
        input:focus { border-color: #3b82f6; }
        button[type="submit"] { background: #2563eb; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; font-weight: bold; cursor: pointer; }
        button[type="submit"]:hover { background: #1d4ed8; }
        iframe { flex: 1; border: none; background: #fff; }
    </style>
</head>
<body>
    <header>
        <button class="btn" onclick="historyBack()">&#8592; Back</button>
        <button class="btn" onclick="reloadFrame()">&#8635; Refresh</button>
        <form id="form">
            <input type="text" id="targetUrl" placeholder="Enter URL or domain (e.g., example.com)" required autocomplete="off" />
            <button type="submit">Browse</button>
        </form>
    </header>
    <iframe id="viewport" src="about:blank"></iframe>
    <script>
        const form = document.getElementById('form');
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
            iframe.src = '/proxy?url=' + encodeURIComponent(url);
        });

        function historyBack() {
            try { iframe.contentWindow.history.back(); } catch (e) {}
        }
        function reloadFrame() {
            if (iframe.src && iframe.src !== 'about:blank') {
                iframe.src = iframe.src;
            }
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => {
    res.send(htmlUI);
});

app.get('/proxy', async (req, res) => {
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
                'Accept-Language': 'en-US,en;q=0.5'
            },
            responseType: 'arraybuffer',
            maxRedirects: 5,
            validateStatus: () => true
        });

        const contentType = response.headers['content-type'] || 'text/html';
        res.status(response.status);
        res.setHeader('Content-Type', contentType);

        // Strip security blocks
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Content-Type-Options');

        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf-8');
            const $ = cheerio.load(html);

            const rewriteUrl = (val) => {
                if (!val) return val;
                const trimmed = val.trim();
                if (trimmed.startsWith('data:') || trimmed.startsWith('javascript:') || trimmed.startsWith('#')) {
                    return trimmed;
                }
                try {
                    const absoluteUrl = new URL(trimmed, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
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
        res.status(500).send(`Proxy Error: ${err.message}`);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
