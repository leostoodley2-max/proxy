const express = require('express');
const Unblocker = require('node-unblocker');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize node-unblocker with the /proxy/ path prefix
const unblocker = new Unblocker({ prefix: '/proxy/' });

// Mount the unblocker middleware
app.use(unblocker);

// Simple landing page UI for your iPad browser
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Web Gateway</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); width: 90%; max-width: 450px; text-align: center; }
            input { width: 100%; padding: 12px; margin-bottom: 15px; border-radius: 6px; border: 1px string #475569; border: 1px solid #475569; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 16px; outline: none; }
            input:focus { border-color: #3b82f6; }
            button { width: 100%; padding: 12px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 16px; }
            button:hover { background: #1d4ed8; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>Proxy Portal</h2>
            <p style="color: #94a3b8; font-size: 14px; margin-bottom: 20px;">Enter a website URL to browse</p>
            <form onsubmit="goProxy(event)">
                <input type="text" id="target" placeholder="example.com" required autocomplete="off">
                <button type="submit">Go</button>
            </form>
        </div>
        <script>
            function goProxy(e) {
                e.preventDefault();
                let url = document.getElementById('target').value.trim();
                if (!/^https?:\/\//i.test(url)) {
                    url = 'https://' + url;
                }
                // Redirect straight into the unblocker route
                window.location.href = '/proxy/' + url;
            }
        </script>
    </body>
    </html>
    `);
});

// Start server with WebSocket support required by node-unblocker
const server = app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
});

server.on('upgrade', unblocker.onUpgrade);
