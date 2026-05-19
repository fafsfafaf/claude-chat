/* claude-chat — minimal client */

const STORE = {
    get: (k, d = '') => localStorage.getItem('cc_' + k) || d,
    set: (k, v) => localStorage.setItem('cc_' + k, v),
    del: (k) => localStorage.removeItem('cc_' + k),
};

const $ = (s) => document.querySelector(s);

const state = {
    messages: [],     // {role, content}
    streaming: false,
    abortCtl: null,
};

// ---------- Settings ----------
function loadSettings() {
    $('#access-token').value = STORE.get('access');
    $('#refresh-token').value = STORE.get('refresh');
    $('#system-prompt').value = STORE.get('system');
    $('#temperature').value = STORE.get('temperature', '1');
    $('#max-tokens').value = STORE.get('max_tokens', '8192');
    $('#model').value = STORE.get('model', 'claude-opus-4-7');
    refreshUiForTokens();
}

function refreshUiForTokens() {
    const hasToken = !!STORE.get('access');
    $('#input').disabled = !hasToken;
    $('#send').disabled = !hasToken;
    $('#welcome')?.style.setProperty('display', hasToken ? 'none' : '');
}

function saveSettings() {
    STORE.set('access', $('#access-token').value.trim());
    STORE.set('refresh', $('#refresh-token').value.trim());
    STORE.set('system', $('#system-prompt').value.trim());
    STORE.set('temperature', $('#temperature').value);
    STORE.set('max_tokens', $('#max-tokens').value);
    STORE.set('model', $('#model').value);
    closeModal();
    refreshUiForTokens();
}

function forgetTokens() {
    if (!confirm('Forget tokens? You will need to paste them again.')) return;
    ['access', 'refresh'].forEach(STORE.del);
    loadSettings();
}

function openModal() { $('#settings-modal').hidden = false; }
function closeModal() { $('#settings-modal').hidden = true; }

// ---------- Rendering ----------
function addMessage(role, content) {
    state.messages.push({ role, content });
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap ' + role;
    const msg = document.createElement('div');
    msg.className = 'msg ' + role;
    if (role === 'assistant') {
        msg.innerHTML = renderMarkdown(content);
    } else {
        msg.textContent = content;
    }
    wrap.appendChild(msg);
    $('#messages').appendChild(wrap);
    scrollToBottom();
    return msg;
}

function renderMarkdown(text) {
    if (window.marked) {
        marked.setOptions({ breaks: true, gfm: true });
        return marked.parse(text);
    }
    return escape(text);
}

function escape(s) {
    return s.replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function scrollToBottom() {
    const m = $('#messages');
    m.scrollTop = m.scrollHeight;
}

// ---------- Chat ----------
async function sendMessage(text) {
    if (!text.trim() || state.streaming) return;
    $('#welcome')?.remove();

    addMessage('user', text);
    const assistantEl = addMessage('assistant', '');
    assistantEl.classList.add('typing');

    state.streaming = true;
    $('#send').disabled = true;
    $('#input').value = '';
    autoResize();

    let fullText = '';
    state.abortCtl = new AbortController();

    try {
        await streamChat({
            onDelta: (delta) => {
                fullText += delta;
                assistantEl.innerHTML = renderMarkdown(fullText);
                assistantEl.classList.add('typing');
                scrollToBottom();
            },
            onError: async (status, body) => {
                // 401 → try to refresh once
                if (status === 401 && STORE.get('refresh')) {
                    const ok = await refreshAccessToken();
                    if (ok) {
                        // Retry once after refresh
                        fullText = '';
                        await streamChat({
                            onDelta: (delta) => {
                                fullText += delta;
                                assistantEl.innerHTML = renderMarkdown(fullText);
                                scrollToBottom();
                            },
                            onError: (s, b) => showError(assistantEl, s, b),
                            signal: state.abortCtl.signal,
                        });
                        return;
                    }
                }
                showError(assistantEl, status, body);
            },
            signal: state.abortCtl.signal,
        });
    } catch (e) {
        if (e.name !== 'AbortError') showError(assistantEl, 0, e.message);
    } finally {
        assistantEl.classList.remove('typing');
        state.messages[state.messages.length - 1].content = fullText;
        state.streaming = false;
        $('#send').disabled = false;
        $('#input').focus();
    }
}

async function streamChat({ onDelta, onError, signal }) {
    const body = {
        access_token: STORE.get('access'),
        model: STORE.get('model', 'claude-opus-4-7'),
        max_tokens: parseInt(STORE.get('max_tokens', '8192'), 10),
        temperature: parseFloat(STORE.get('temperature', '1')),
        system: STORE.get('system'),
        messages: state.messages
            .filter(m => m.content)
            .map(m => ({ role: m.role, content: m.content })),
    };

    const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });

    if (!resp.ok && resp.status !== 200) {
        const t = await resp.text();
        onError(resp.status, t);
        return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = null;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);

            if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
                const data = line.slice(6);
                try {
                    const j = JSON.parse(data);
                    if (currentEvent === 'error' || j.error) {
                        onError(j.status || 0, JSON.stringify(j));
                        return;
                    }
                    if (j.type === 'content_block_delta' && j.delta?.text) {
                        onDelta(j.delta.text);
                    }
                } catch {/* ignore non-JSON keepalives */ }
            }
        }
    }
}

async function refreshAccessToken() {
    try {
        const r = await fetch('/api/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: STORE.get('refresh') }),
        });
        if (!r.ok) return false;
        const j = await r.json();
        if (j.access_token) {
            STORE.set('access', j.access_token);
            if (j.refresh_token) STORE.set('refresh', j.refresh_token);
            return true;
        }
    } catch { /* fall through */ }
    return false;
}

function showError(el, status, body) {
    let msg = `Error ${status}`;
    try {
        const j = typeof body === 'string' ? JSON.parse(body) : body;
        msg = j.error?.message || j.body || j.error || JSON.stringify(j);
        if (status === 401) msg = 'Access token rejected. Open settings and update it.';
    } catch { msg = String(body).slice(0, 400); }
    el.className = 'msg error';
    el.textContent = msg;
}

// ---------- Composer ----------
function autoResize() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}

function clearChat() {
    if (state.messages.length && !confirm('Clear conversation?')) return;
    state.messages = [];
    $('#messages').innerHTML = '';
    if (!STORE.get('access')) location.reload();
}

// ---------- Wire up ----------
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    $('#settings-btn').addEventListener('click', openModal);
    $('#open-settings')?.addEventListener('click', openModal);
    $('#save-btn').addEventListener('click', saveSettings);
    $('#forget-btn').addEventListener('click', forgetTokens);
    $('#clear-btn').addEventListener('click', clearChat);
    $('#settings-modal').addEventListener('click', (e) => {
        if (e.target.id === 'settings-modal') closeModal();
    });

    $('#model').addEventListener('change', (e) => STORE.set('model', e.target.value));

    $('#input').addEventListener('input', autoResize);
    $('#input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage($('#input').value);
        }
    });
    $('#composer').addEventListener('submit', (e) => {
        e.preventDefault();
        sendMessage($('#input').value);
    });
});
