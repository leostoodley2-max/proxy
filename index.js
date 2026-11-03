const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// Embedded Browser Dashboard & Proxy Gateway
const htmlUI = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Stream Proxy Gateway</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body { display: flex; flex-direction: column; height: 100vh; background-color: #0f172a; color: #f8fafc; }
        header { display: flex; align-items: center; padding: 12px 20px; background-color: #1e293b; border-bottom: 1px solid #334155; gap: 12px; }
        .nav-btn { background: #334155; color: #f8fafc; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500; transition: background 0.2s; }
        .nav-btn:hover { background: #475569; }
        form { display: flex; flex: 1; gap: 10px; }
        input[type="text"] { flex: 1; padding: 10px 16px; border-radius: 6px; border: 1px solid #475569; background-color: #020617; color: #f8fafc; outline: none; font-size: 14px; }
        input[type="text"]:focus { border-color: #3b82f6; }
        button[type="submit"] { background-color: #2563eb; color: #ffffff; font-weight: 600; border: none; padding: 10px 24px; border-radius: 6px; cursor: pointer; transition: background 0.2s; }
        button[type="submit"]:hover { background-color: #1d4ed8; }
        iframe { flex: 1; border: none; background-color: #ffffff; }
    </style>
</head>
<body>
    <header>
        <button class="nav-btn" onclick="goBack()">&#8592; Back</button>
        <button class="nav-btn" onclick="refreshFrame()">&#8635; Refresh</button>
        <form id="proxyForm">
            <input type="text" id="targetUrl" placeholder="Enter target domain or URL (e.g., example.com)" required>
            <button type="submit">Connect</button>
        </form>
    </header>
    <iframe id="viewport" src="about:blank"></iframe>

    <script>
        const form = document.getElementById('proxyForm');
        const input = document.getElementById('targetUrl');
        const iframe = document.getElementById('viewport');

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            let rawUrl = input.value.trim();
            if (!rawUrl) return;

            // Auto-format protocol
            if (!/^https?:\/\//i.test(rawUrl)) {
                rawUrl = 'https://' + rawUrl;
            }

            try {
                const parsedUrl = new URL(rawUrl);
                // Send request via gateway router path
                iframe.src = '/gateway/' + parsedUrl.hostname + parsedUrl.pathname + parsedUrl.search;
                input.value = rawUrl;
            } catch (err) {
                alert('Invalid URL format. Please check the domain entered.');
            }
        });

        function goBack() {
            try { iframe.contentWindow.history.back(); } catch (e) {}
        }
        function refreshFrame() {
            iframe.src = iframe.src;
        }
    </script>
</body>
</html>
`;

// 1. Serve UI Landing Page
app.get('/', (req, res) => {
    res.send(htmlUI);
});

// 2. Dynamic HTTP/HTTPS Stream Proxy Gateway Route
app.use('/gateway/:host*', (req, res, next) => {
    const targetHost = req.params.host;
    const targetUrl = 'https://' + targetHost;

    const dynamicProxy = createProxyMiddleware({
        target: targetUrl,
        changeOrigin: true, // Rewrites the Host header to match target server
        followRedirects: true,
        pathRewrite: (path) => {
            // Remove the '/gateway/domain.com' prefix when forwarding request to target
            return path.replace(new RegExp('^/gateway/' + targetHost), '') || '/';
        },
        on: {
            proxyReq: (proxyReq, req, res) => {
                // Impersonate standard browser headers
                proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
                proxyReq.setHeader('Accept-Language', 'en-US,en;q=0.9');
            },
            proxyRes: (proxyRes, req, res) => {
                // Strip security restrictions to allow embedding inside the browser iframe
                delete proxyRes.headers['x-frame-options'];
                delete proxyRes.headers['content-security-policy'];
                delete proxyRes.headers['content-security-policy-report-only'];
            },
            error: (err, req, res) => {
                res.status(500).send(`
                    <div style="font-family:sans-serif; padding:30px; background:#fef2f2; border:1px solid #f87171; border-radius:8px; margin:20px;">
                        <h3 style="color:#991b1b;">Proxy Gateway Error</h3>
                        <p style="margin-top:10px; font-family:monospace;">${err.message}</p>
                    </div>
                `);
            }
        }
    });

    return dynamicProxy(req, res, next);
});

app.listen(PORT, () => {
    console.log(`Proxy Gateway active on port ${PORT}`);
});
