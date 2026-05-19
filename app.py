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
    }

    def stream():
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
                for raw in r.iter_lines():
                    if raw:
                        # Anthropic already sends SSE-formatted lines (event: ... / data: ...).
                        yield raw.decode("utf-8") + "\n"
                    else:
                        yield "\n"
        except requests.RequestException as e:
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"

    return Response(stream(), mimetype="text/event-stream")


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
