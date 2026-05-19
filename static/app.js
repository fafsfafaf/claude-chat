/* claude-chat — minimal client with chat history + file uploads */

const STORE = {
    get: (k, d = '') => localStorage.getItem('cc_' + k) ?? d,
    set: (k, v) => localStorage.setItem('cc_' + k, v),
    del: (k) => localStorage.removeItem('cc_' + k),
    getJSON: (k, d) => { try { return JSON.parse(localStorage.getItem('cc_' + k)) ?? d; } catch { return d; } },
    setJSON: (k, v) => localStorage.setItem('cc_' + k, JSON.stringify(v)),
};
const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ---------- State ----------
const state = {
    chats: [],          // [{id, title, created, updated, messages: [...]}]
    currentId: null,
    attachments: [],    // [{type:'image'|'document'|'text', name, size, media_type, data}]
    streaming: false,
    abortCtl: null,
};

// Each message: { role:'user'|'assistant', content: <string OR array of blocks> }
// Block formats match Anthropic API exactly:
//   {type:'text', text:'...'}
//   {type:'image', source:{type:'base64', media_type, data}}
//   {type:'document', source:{type:'base64', media_type, data}}

// ---------- Chat storage ----------
function loadChats() {
    state.chats = STORE.getJSON('chats', []) || [];
    state.currentId = STORE.get('current') || null;
    if (!state.chats.find(c => c.id === state.currentId)) {
        state.currentId = state.chats[0]?.id || null;
    }
}

function saveChats() {
    STORE.setJSON('chats', state.chats);
    if (state.currentId) STORE.set('current', state.currentId);
}

function currentChat() {
    return state.chats.find(c => c.id === state.currentId);
}

function newChat() {
    const chat = {
        id: uid(),
        title: 'New chat',
        created: Date.now(),
        updated: Date.now(),
        messages: [],
    };
    state.chats.unshift(chat);
    state.currentId = chat.id;
    saveChats();
    renderSidebar();
    renderMessages();
    updateHeader();
    $('#input').focus();
}

function switchChat(id) {
    state.currentId = id;
    saveChats();
    renderSidebar();
    renderMessages();
    updateHeader();
}

function deleteChat(id, ev) {
    ev?.stopPropagation();
    if (!confirm('Delete this chat?')) return;
    state.chats = state.chats.filter(c => c.id !== id);
    if (state.currentId === id) state.currentId = state.chats[0]?.id || null;
    saveChats();
    renderSidebar();
    renderMessages();
    updateHeader();
}

function renameChat() {
    const c = currentChat();
    if (!c) return;
    const t = prompt('Rename chat:', c.title);
    if (t === null) return;
    c.title = t.trim() || 'Untitled';
    saveChats();
    renderSidebar();
    updateHeader();
}

function autoTitleFromMessage(text) {
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, 48) || 'New chat';
}

// ---------- Sidebar render ----------
function renderSidebar() {
    const list = $('#chat-list');
    list.innerHTML = '';
    state.chats.sort((a, b) => b.updated - a.updated);
    for (const c of state.chats) {
        const el = document.createElement('div');
        el.className = 'chat-item' + (c.id === state.currentId ? ' active' : '');
        el.innerHTML = `<span class="title"></span><button class="del" title="Delete">×</button>`;
        el.querySelector('.title').textContent = c.title;
        el.addEventListener('click', () => switchChat(c.id));
        el.querySelector('.del').addEventListener('click', (e) => deleteChat(c.id, e));
        list.appendChild(el);
    }
}

function updateHeader() {
    $('#chat-title').textContent = currentChat()?.title || 'claude-chat';
}

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
    const has = !!STORE.get('access');
    $('#input').disabled = !has;
    $('#send').disabled = !has;
    const w = $('#welcome');
    if (w) w.style.display = has ? 'none' : '';
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

// ---------- Message render ----------
function renderMessages() {
    const m = $('#messages');
    m.innerHTML = '';
    const c = currentChat();
    if (!c || c.messages.length === 0) {
        // Show welcome only if no tokens yet
        const has = !!STORE.get('access');
        if (!has) {
            const wel = document.createElement('div');
            wel.className = 'welcome';
            wel.id = 'welcome';
            wel.innerHTML = `
                <h1>Talk to Claude</h1>
                <p>Paste your OAuth tokens once. Stored in your browser. Server only proxies.</p>
                <button class="primary" onclick="window._openSettings()">Add tokens to start</button>
            `;
            m.appendChild(wel);
        }
        return;
    }
    for (const msg of c.messages) renderMessageDOM(msg.role, msg.content);
    scrollToBottom();
}

function renderMessageDOM(role, content) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap ' + role;
    const msg = document.createElement('div');
    msg.className = 'msg ' + role;

    if (Array.isArray(content)) {
        const imgs = content.filter(b => b.type === 'image');
        const docs = content.filter(b => b.type === 'document');
        const txt = content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');

        if (imgs.length) {
            const wrapImg = document.createElement('div');
            wrapImg.className = 'images';
            for (const im of imgs) {
                const i = document.createElement('img');
                i.src = `data:${im.source.media_type};base64,${im.source.data}`;
                wrapImg.appendChild(i);
            }
            msg.appendChild(wrapImg);
        }
        if (docs.length) {
            const wrapDoc = document.createElement('div');
            wrapDoc.className = 'files';
            for (const d of docs) {
                const chip = document.createElement('span');
                chip.className = 'file-chip';
                chip.textContent = '📄 ' + (d._name || 'document');
                wrapDoc.appendChild(chip);
            }
            msg.appendChild(wrapDoc);
        }
        if (txt) {
            const t = document.createElement('div');
            if (role === 'assistant') t.innerHTML = renderMarkdown(txt);
            else { t.style.whiteSpace = 'pre-wrap'; t.textContent = txt; }
            msg.appendChild(t);
        }
    } else {
        if (role === 'assistant') msg.innerHTML = renderMarkdown(content || '');
        else msg.textContent = content || '';
    }

    wrap.appendChild(msg);
    $('#messages').appendChild(wrap);
    return msg;
}

function renderMarkdown(text) {
    if (window.marked) {
        marked.setOptions({ breaks: true, gfm: true });
        return marked.parse(text);
    }
    return text.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function scrollToBottom() {
    const m = $('#messages');
    m.scrollTop = m.scrollHeight;
}

// ---------- File handling ----------
async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = reject;
        r.onload = () => {
            const result = r.result;
            const idx = result.indexOf(',');
            resolve(result.slice(idx + 1));
        };
        r.readAsDataURL(file);
    });
}

async function fileToText(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = reject;
        r.onload = () => resolve(r.result);
        r.readAsText(file);
    });
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;     // 5 MB per file
const MAX_TEXT_CHARS = 200_000;             // 200 K chars per text file

async function addAttachment(file) {
    if (file.size > MAX_FILE_BYTES) {
        alert(`${file.name}: file too large (max 5 MB)`);
        return;
    }
    const mt = file.type || 'application/octet-stream';
    if (mt.startsWith('image/')) {
        const data = await fileToBase64(file);
        state.attachments.push({
            kind: 'image', name: file.name, size: file.size,
            media_type: mt, data,
        });
    } else if (mt === 'application/pdf') {
        const data = await fileToBase64(file);
        state.attachments.push({
            kind: 'document', name: file.name, size: file.size,
            media_type: 'application/pdf', data,
        });
    } else {
        // text-ish file
        let text = await fileToText(file);
        if (text.length > MAX_TEXT_CHARS) {
            text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[…truncated]';
        }
        state.attachments.push({
            kind: 'text', name: file.name, size: file.size, text,
        });
    }
    renderAttachments();
}

function removeAttachment(idx) {
    state.attachments.splice(idx, 1);
    renderAttachments();
}

function renderAttachments() {
    const el = $('#attachments');
    el.innerHTML = '';
    state.attachments.forEach((a, i) => {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        if (a.kind === 'image') {
            chip.innerHTML = `<img alt=""><span class="filename"></span>
                <span class="filemeta"></span><button class="remove" title="Remove">×</button>`;
            chip.querySelector('img').src = `data:${a.media_type};base64,${a.data}`;
        } else {
            const icon = a.kind === 'document' ? '📄' : '📝';
            chip.innerHTML = `<span>${icon}</span><span class="filename"></span>
                <span class="filemeta"></span><button class="remove" title="Remove">×</button>`;
        }
        chip.querySelector('.filename').textContent = a.name;
        chip.querySelector('.filemeta').textContent = humanSize(a.size);
        chip.querySelector('.remove').addEventListener('click', () => removeAttachment(i));
        el.appendChild(chip);
    });
}

function humanSize(b) {
    const u = ['B','KB','MB','GB']; let i = 0;
    while (b > 1024 && i < 3) { b /= 1024; i++; }
    return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`;
}

// Compose user message content array from text + attachments
function buildUserContent(text) {
    const parts = [];
    for (const a of state.attachments) {
        if (a.kind === 'image') {
            parts.push({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } });
        } else if (a.kind === 'document') {
            parts.push({ type: 'document', source: { type: 'base64', media_type: a.media_type, data: a.data }, _name: a.name });
        } else {
            parts.push({ type: 'text', text: `Attached file \`${a.name}\`:\n\n\`\`\`\n${a.text}\n\`\`\`` });
        }
    }
    if (text) parts.push({ type: 'text', text });
    return parts.length === 1 && parts[0].type === 'text' ? text : parts;
}

// Strip internal fields and outbound to API (removes `_name`)
function cleanForApi(messages) {
    return messages.map(m => {
        if (typeof m.content === 'string') return { role: m.role, content: m.content };
        const blocks = m.content.map(b => {
            if (b.type === 'document') return { type: 'document', source: b.source };
            return b;
        });
        return { role: m.role, content: blocks };
    });
}

// ---------- Chat ----------
async function sendMessage(text) {
    text = text.trim();
    if (!text && state.attachments.length === 0) return;
    if (state.streaming) return;

    if (!currentChat()) newChat();
    const chat = currentChat();
    const userContent = buildUserContent(text);
    chat.messages.push({ role: 'user', content: userContent });

    // Auto-title from first user message
    if (chat.title === 'New chat') {
        chat.title = autoTitleFromMessage(text || chat.messages.find(m => true)?.content?.find?.(b => b.type === 'text')?.text || 'Chat');
    }
    chat.updated = Date.now();
    state.attachments = [];
    renderAttachments();

    // Render
    $('#welcome')?.remove();
    renderMessageDOM('user', userContent);
    const assistantEl = renderMessageDOM('assistant', '');
    assistantEl.classList.add('typing');
    scrollToBottom();

    state.streaming = true;
    $('#send').disabled = true;
    $('#input').value = '';
    autoResize();

    let fullText = '';
    state.abortCtl = new AbortController();

    const doStream = async () => {
        await streamChat({
            messages: cleanForApi(chat.messages),
            onDelta: (delta) => {
                fullText += delta;
                assistantEl.innerHTML = renderMarkdown(fullText);
                assistantEl.classList.add('typing');
                scrollToBottom();
            },
            onError: async (status, body) => {
                if (status === 401 && STORE.get('refresh')) {
                    const ok = await refreshAccessToken();
                    if (ok) { fullText = ''; await doStream(); return; }
                }
                showError(assistantEl, status, body);
            },
            signal: state.abortCtl.signal,
        });
    };

    try {
        await doStream();
    } catch (e) {
        if (e.name !== 'AbortError') showError(assistantEl, 0, e.message);
    } finally {
        assistantEl.classList.remove('typing');
        chat.messages.push({ role: 'assistant', content: fullText });
        chat.updated = Date.now();
        saveChats();
        renderSidebar();
        updateHeader();
        state.streaming = false;
        $('#send').disabled = false;
        $('#input').focus();
    }
}

async function streamChat({ messages, onDelta, onError, signal }) {
    const body = {
        access_token: STORE.get('access'),
        model: STORE.get('model', 'claude-opus-4-7'),
        max_tokens: parseInt(STORE.get('max_tokens', '8192'), 10),
        temperature: parseFloat(STORE.get('temperature', '1')),
        system: STORE.get('system'),
        messages,
    };

    const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });

    if (!resp.ok) {
        onError(resp.status, await resp.text());
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
                        onError(j.status || resp.status, JSON.stringify(j));
                        return;
                    }
                    if (j.type === 'content_block_delta' && j.delta?.text) {
                        onDelta(j.delta.text);
                    }
                } catch {/* ignore */ }
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
        if (status === 401) msg = 'Access token rejected. Open Settings and update it.';
    } catch { msg = String(body).slice(0, 400); }
    el.className = 'msg error';
    el.textContent = msg;
}

function autoResize() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}

// ---------- Drag & drop / paste ----------
let dragDepth = 0;
function setupDropZone() {
    const overlay = $('#drop-overlay');
    window.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dragDepth++;
        overlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', (e) => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) overlay.hidden = true;
    });
    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragDepth = 0;
        overlay.hidden = true;
        const files = [...(e.dataTransfer?.files || [])];
        for (const f of files) await addAttachment(f);
    });
    // paste images
    window.addEventListener('paste', async (e) => {
        const items = e.clipboardData?.items || [];
        for (const it of items) {
            if (it.kind === 'file') {
                const f = it.getAsFile();
                if (f) await addAttachment(f);
            }
        }
    });
}

// ---------- Wire up ----------
window._openSettings = openModal;

document.addEventListener('DOMContentLoaded', () => {
    loadChats();
    loadSettings();
    if (!state.currentId) newChat();
    else { renderSidebar(); renderMessages(); updateHeader(); }

    $('#new-chat').addEventListener('click', newChat);
    $('#settings-btn').addEventListener('click', openModal);
    $('#open-settings')?.addEventListener('click', openModal);
    $('#save-btn').addEventListener('click', saveSettings);
    $('#forget-btn').addEventListener('click', forgetTokens);
    $('#rename-chat-btn').addEventListener('click', renameChat);
    $('#toggle-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('collapsed'));

    $('#settings-modal').addEventListener('click', (e) => {
        if (e.target.id === 'settings-modal') closeModal();
    });

    $('#model').addEventListener('change', (e) => STORE.set('model', e.target.value));

    $('#file-input').addEventListener('change', async (e) => {
        for (const f of e.target.files) await addAttachment(f);
        e.target.value = '';
    });

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

    setupDropZone();
});
