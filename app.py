"""
claude-chat — minimal Flask UI for talking to Claude with OAuth tokens.

Tokens never leave the browser → server → Anthropic round-trip; nothing is
stored server-side. Refresh tokens are used automatically if the access token
is expired.
"""
import json
import os
from flask import Flask, request, Response, render_template, jsonify
import requests

app = Flask(__name__, static_folder="static", template_folder="templates")

ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
# Public client_id used by Claude Code CLI for the OAuth flow.
CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

# When using OAuth tokens, Anthropic expects the request to identify as Claude Code.
CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/chat", methods=["POST"])
def chat():
    body = request.get_json(force=True)
    access_token = body.get("access_token")
    if not access_token:
        return jsonify({"error": "missing access_token"}), 400

    user_system = body.get("system", "").strip()
    system = CLAUDE_CODE_SYSTEM_PREFIX
    if user_system:
        system = f"{CLAUDE_CODE_SYSTEM_PREFIX}\n\n{user_system}"

    payload = {
        "model": body.get("model", "claude-opus-4-7"),
        "messages": body.get("messages", []),
        "max_tokens": body.get("max_tokens", 8192),
        "system": system,
        "stream": True,
    }
    if "temperature" in body:
        payload["temperature"] = body["temperature"]

    headers = {
        "Authorization": f"Bearer {access_token}",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "claude-chat/1.0",
        # Refuse gzip from Anthropic — gzip + SSE is a recipe for mobile-proxy buffering.
        "Accept-Encoding": "identity",
    }

    def stream():
        # First chunk fires immediately so the browser's fetch reader opens
        # before Anthropic's first byte. Without this, some Android browsers
        # don't yield from response.body.getReader() for several seconds.
        yield ": open\n\n"
        try:
            with requests.post(
                ANTHROPIC_MESSAGES_URL,
                headers=headers,
                json=payload,
                stream=True,
                timeout=120,
            ) as r:
                if r.status_code != 200:
                    err = r.text
                    yield f"event: error\ndata: {json.dumps({'status': r.status_code, 'body': err})}\n\n"
                    return
                # iter_content with small chunks forwards data the instant the upstream
                # flushes, instead of waiting for line boundaries. This is what fixes
                # the "messages don't load on Android" case — mobile data proxies and
                # Android Chrome both buffer line-based streams aggressively.
                for chunk in r.iter_content(chunk_size=64, decode_unicode=False):
                    if chunk:
                        yield chunk
        except requests.RequestException as e:
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    resp = Response(stream(), mimetype="text/event-stream", direct_passthrough=True)
    # Headers that disable buffering across every intermediary that might be in the path:
    # browsers, mobile carrier proxies, Cloudflare, nginx, gunicorn, …
    resp.headers["Cache-Control"] = "no-cache, no-transform"
    resp.headers["X-Accel-Buffering"] = "no"        # nginx
    resp.headers["Connection"] = "keep-alive"
    resp.headers["Content-Encoding"] = "identity"   # tell the browser: don't expect gzip
    return resp


@app.route("/api/refresh", methods=["POST"])
def refresh_token():
    """Exchange a refresh token for a new access token."""
    refresh = (request.get_json(force=True) or {}).get("refresh_token")
    if not refresh:
        return jsonify({"error": "missing refresh_token"}), 400

    r = requests.post(
        OAUTH_TOKEN_URL,
        json={
            "grant_type": "refresh_token",
            "refresh_token": refresh,
            "client_id": CLAUDE_CODE_CLIENT_ID,
        },
        headers={"Content-Type": "application/json", "User-Agent": "claude-chat/1.0"},
        timeout=15,
    )
    return Response(r.text, status=r.status_code, mimetype="application/json")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
