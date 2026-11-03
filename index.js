const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// FRONTEND BROWSER USER INTERFACE
// ==========================================
const htmlUI = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Advanced DOM-Rewriting Web Proxy</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
        body { display: flex; flex-direction: column; height: 100vh; background-color: #090d16; color: #f1f5f9; }
        header { display: flex; align-items: center; padding: 12px 20px; background-color: #111827; border-bottom: 1px solid #1f2937; gap: 10px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        .nav-btn { background: #1f2937; color: #f1f5f9; border: 1px solid #374151; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 500; transition: background 0.2s; }
        .nav-btn:hover { background: #374151; }
        form { display: flex; flex: 1; gap: 10px; }
        input[type="text"] { flex: 1; padding: 10px 16px; border-radius: 6px; border: 1px solid #374151; background-color: #030712; color: #f1f5f9; outline: none; font-size: 14px; transition: border-color 0.2s; }
        input[type="text"]:focus { border-color: #3b82f6; }
        button[type="submit"] { background-color: #2563eb; color: #ffffff; font-weight: 600; border: none; padding: 10px 22px; border-radius: 6px; cursor: pointer; transition: background 0.2s; }
        button[type="submit"]:hover { background-color: #1d4ed8; }
        .status-bar { padding: 4px 20px; background: #0f172a; font-size: 12px; color: #94a3b8; border-bottom: 1px solid #1e293b; display: flex; justify-content: space-between; }
        .viewport-container { flex: 1; position: relative; background: #ffffff; }
        iframe { width: 100%; height: 100%; border: none; background: #ffffff; }
    </style>
</head>
<body>
    <header>
        <button class="nav-btn" onclick="goBack()" title="Back">&#8592;</button>
        <button class="nav-btn" onclick="refreshFrame()" title="Refresh">&#8635;</button>
        <form id="proxyForm">
            <input type="text" id="targetUrl" placeholder="Enter URL or domain (e.g., wikipedia.org, example.com)" required autocomplete="off" spellcheck="false">
            <button type="submit">Browse</button>
        </form>
    </header>
    <div class="status-bar">
        <span id="statusText">Status: Ready</span>
        <span>Secure DOM-Rewriting Engine</span>
    </div>
    <div class="viewport-container">
        <iframe id="viewport" src="about:blank"></iframe>
    </div>

    <script>
        const form = document.getElementById('proxyForm');
        const input = document.getElementById('targetUrl');
        const iframe = document.getElementById('viewport');
        const statusText = document.getElementById('statusText');

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            let url = input.value.trim();
            if (!url) return;

            // Automatically prepend https:// if missing a protocol
            if (!/^https?:\/\//i.test(url)) {
                url = 'https://' + url;
                input.value = url;
            }

            statusText.innerText = 'Status: Connecting to ' + url + '...';
            iframe.src = '/proxy?url=' + encodeURIComponent(url);
        });

        iframe.addEventListener('load', () => {
            try {
                statusText.innerText = 'Status: Loaded successfully';
            } catch (e) {
                statusText.innerText = 'Status: Active';
            }
        });

        function goBack() {
            try { iframe.contentWindow.history.back(); } catch (e) {}
        }

        function refreshFrame() {
            if (iframe.src && iframe.src !== 'about:blank') {
                iframe.src = iframe.src;
            }
        }
    </script>
</body>
</html>
`;

// ==========================================
// EXPRESS SERVER ROUTES
// ==========================================

// Serve the UI at root
app.get('/', (req, res) => {
    res.send(htmlUI);
});

// Main Proxy Route with DOM Rewriting
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('Error: Missing "url" query parameter.');
    }

    // Auto-fix protocol if missing
    if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
    }

    try {
        // Fetch target resource using Axios with full browser simulation headers
        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            responseType: 'arraybuffer', // Handles both text and binary assets without corruption
            maxRedirects: 5,
            validateStatus: () => true // Prevent axios from throwing on 4xx/5xx errors so we can relay status
        });

        const contentType = response.headers['content-type'] || 'text/html';
        res.status(response.status);
        res.setHeader('Content-Type', contentType);

        // Strip security headers that prevent browser iframe rendering
        res.removeHeader('X-Frame-Options');
        res.removeHeader('Content-Security-Policy');
        res.removeHeader('X-Content-Type-Options');

        // ==========================================
        // HTML PARSING & DOM REWRITING VIA CHEERIO
        // ==========================================
        if (contentType.includes('text/html')) {
            let html = response.data.toString('utf-8');
            const $ = cheerio.load(html);

            // Helper function to resolve relative paths and wrap them through our proxy endpoint
            const rewriteUrl = (val) => {
                if (!val) return val;
                const trimmed = val.trim();
                // Skip data URIs, anchor hashes, javascript calls, or mailto links
                if (
                    trimmed.startsWith('data:') ||
                    trimmed.startsWith('javascript:') ||
                    trimmed.startsWith('mailto:') ||
                    trimmed.startsWith('#')
                ) {
                    return trimmed;
                }

                try {
                    // Resolve relative/absolute paths against the live target URL
                    const absoluteUrl = new URL(trimmed, targetUrl).href;
                    return `/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                } catch (e) {
                    return trimmed;
                }
            };

            // 1. Rewrite hyperlinks
            $('[href]').each((i, el) => {
                const val = $(el).attr('href');
                $(el).attr('href', rewriteUrl(val));
            });

            // 2. Rewrite source links (images, scripts, media, iframes)
            $('[src]').each((i, el) => {
                const val = $(el).attr('src');
                $(el).attr('src', rewriteUrl(val));
            });

            // 3. Rewrite form action endpoints
            $('[action]').each((i, el) => {
                const val = $(el).attr('action');
                $(el).attr('action', rewriteUrl(val));
            });

            // 4. Rewrite responsive image srcset attributes
            $('[srcset]').each((i, el) => {
                const srcset = $(el).attr('srcset');
                if (srcset) {
                    const rewritten = srcset.split(',').map(part => {
                        const trimmedPart = part.trim();
                        const parts = trimmedPart.split(/\s+/);
                        const imgUrl = parts[0];
                        const descriptor = parts.slice(1).join(' ');
                        const newUrl = rewriteUrl(imgUrl);
                        return descriptor ? `${newUrl} ${descriptor}` : newUrl;
                    }).join(', ');
                    $(el).attr('srcset', rewritten);
                }
            });

            // 5. Inject anti-frame-busting protection script into header
            const antiFrameScript = `
                <script>
                    try {
                        if (window.top !== window.self) {
                            window.__defineGetter__('top', () => window.self);
                        }
                    } catch(e) {}
                </script>
            `;
            if ($('head').length > 0) {
                $('head').prepend(antiFrameScript);
            } else {
                $.root().prepend(antiFrameScript);
            }

            return res.send($.html());
        }

        // For non-HTML assets (CSS, JS, Images, Fonts), stream them through directly
        return res.send(response.data);

    } catch (err) {
        console.error('Proxy execution error:', err.message);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Proxy Error</title>
                <style>
                    body { font-family: sans-serif; background: #fff1f2; color: #881337; padding: 40px; }
                    .card { background: #ffffff; border: 1px solid #f43f5e; padding: 25px; border-radius: 8px; max-width: 600px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
                    h2 { margin-top: 0; color: #9f1239; }
                    code { background: #f1f5f9; padding: 4px 8px; border-radius: 4px; font-family: monospace; display: block; margin-top: 10px; color: #334155; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>Proxy Navigation Failed</h2>
                    <p>The server encountered an exception while attempting to fetch or parse the requested resource.</p>
                    <code>${err.message}</code>
                </div>
            </body>
            </html>
        `);
    }
});

// Start listening
app.listen(PORT, () => {
    console.log(`DOM-Rewriting Proxy server active and listening on port ${PORT}`);
});
