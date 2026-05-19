# claude-chat

> **Minimal Flask UI for chatting with Claude using your Claude.ai / Claude Code OAuth tokens.** Paste your tokens once, chat. Tokens never leave your browser → server → Anthropic — nothing stored server-side.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.10%2B-blue.svg)](#)
[![Flask](https://img.shields.io/badge/flask-3.x-black.svg)](#)
[![Stars](https://img.shields.io/github/stars/fafsfafaf/claude-chat?style=social)](https://github.com/fafsfafaf/claude-chat/stargazers)

## Quick start

```bash
git clone https://github.com/fafsfafaf/claude-chat
cd claude-chat
pip install -r requirements.txt
python app.py
# → http://localhost:5000
```

Open the page, click **Settings**, paste your two tokens:

- **Access token** — starts with `sk-ant-oat01-…`
- **Refresh token** — starts with `sk-ant-ort01-…`

Hit **Save** and start chatting.

## Features

- **Minimalist UI** — chat-only, nothing else. Light + dark mode follow your system.
- **Streaming** — text appears token-by-token via SSE.
- **Markdown + code blocks** — rendered via marked.js.
- **Auto token refresh** — when the access token expires (401), the refresh token is used transparently.
- **Model picker** — Opus 4.7 / Sonnet 4.6 / Haiku 4.5.
- **Custom system prompt + temperature + max tokens** in Settings.
- **No persistence** — tokens are stored in browser localStorage only; the server is a pure proxy.

## Where do I get OAuth tokens?

If you use Claude Code, your tokens live in `~/.claude/.credentials.json`:

```bash
cat ~/.claude/.credentials.json | jq .
```

You'll see something like:

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-…",
    "refreshToken": "sk-ant-ort01-…",
    "expiresAt": 1779200000000
  }
}
```

Copy the two values into the **Settings** modal in the web UI.

## How it works

```
   ┌─────────────┐    POST /api/chat       ┌───────────┐   /v1/messages   ┌──────────────┐
   │  Browser    │ ───────────────────────▶│  Flask    │ ────────────────▶│  Anthropic   │
   │ (localStor) │ ◀───── SSE stream ──────│ (proxy)   │◀──── SSE ────────│              │
   └─────────────┘                          └───────────┘                   └──────────────┘
```

- Tokens stay in the browser's localStorage.
- The Flask server receives them per-request, forwards to `api.anthropic.com`, streams the SSE response back. It does not log them, does not write them to disk.
- On `401 Unauthorized` from Anthropic, the client tries `POST /api/refresh` which exchanges the refresh token for a fresh access token via `console.anthropic.com/v1/oauth/token` using Claude Code's public client ID.

## Security notes

- **These OAuth tokens grant full access to your Claude account.** Don't paste them on a public/shared computer.
- Serve over HTTPS if exposing beyond localhost (use a reverse proxy + Let's Encrypt).
- The server logs no token material by default. If you add logging, make sure to redact `Authorization` headers.
- The included `client_id` (`9d1c250a-…`) is the public Claude Code OAuth client ID — same one the CLI uses.

## Deployment

### Docker

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 5000
CMD ["python", "app.py"]
```

```bash
docker build -t claude-chat .
docker run -p 5000:5000 claude-chat
```

### Behind nginx + Let's Encrypt

```nginx
location / {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;
    proxy_buffering off;            # important for SSE
    proxy_set_header Connection '';
    proxy_set_header X-Real-IP $remote_addr;
}
```

## Tech

- **Backend:** Flask + requests (~80 lines)
- **Frontend:** vanilla HTML/CSS/JS, no build step
- **Streaming:** Server-Sent Events forwarded as-is from Anthropic
- **Markdown:** marked.js (CDN)

## License

MIT
