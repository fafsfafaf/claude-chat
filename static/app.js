/* claude-chat — minimal client with chat history, file uploads, mobile UI */

const STORE = {
    get: (k, d = '') => localStorage.getItem('cc_' + k) ?? d,
    set: (k, v) => localStorage.setItem('cc_' + k, v),
    del: (k) => localStorage.removeItem('cc_' + k),
    getJSON: (k, d) => { try { return JSON.parse(localStorage.getItem('cc_' + k)) ?? d; } catch { return d; } },
    setJSON: (k, v) => localStorage.setItem('cc_' + k, JSON.stringify(v)),
};
const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

const state = {
    chats: [],
    currentId: null,
    attachments: [],
    streaming: false,
    abortCtl: null,
    searchTerm: '',
};

// ============================================================
// CHAT STORAGE
// ============================================================
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
function currentChat() { return state.chats.find(c => c.id === state.currentId); }

function newChat() {
    const chat = { id: uid(), title: 'New chat', created: Date.now(), updated: Date.now(), messages: [] };
    state.chats.unshift(chat);
    state.currentId = chat.id;
    saveChats();
    renderSidebar();
    renderMessages();
    updateHeader();
    closeSidebarOnMobile();
    $('#input').focus();
}
function switchChat(id) {
    state.currentId = id;
    saveChats();
    renderSidebar();
    renderMessages();
    updateHeader();
    closeSidebarOnMobile();
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

// ============================================================
// SIDEBAR RENDER
// ============================================================
function renderSidebar() {
    const list = $('#chat-list');
    list.innerHTML = '';
    const term = state.searchTerm.toLowerCase();
    const filtered = state.chats
        .slice()
        .sort((a, b) => b.updated - a.updated)
        .filter(c => !term || c.title.toLowerCase().includes(term) ||
                     JSON.stringify(c.messages).toLowerCase().includes(term));
    for (const c of filtered) {
        const el = document.createElement('div');
        el.className = 'chat-item' + (c.id === state.currentId ? ' active' : '');
        el.innerHTML = `<span class="title"></span><button class="del" title="Delete">×</button>`;
        el.querySelector('.title').textContent = c.title;
        el.addEventListener('click', () => switchChat(c.id));
        el.querySelector('.del').addEventListener('click', (e) => deleteChat(c.id, e));
        list.appendChild(el);
    }
    if (filtered.length === 0 && term) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:var(--text-muted);font-size:13px;padding:12px 10px;text-align:center;';
        empty.textContent = 'No matches';
        list.appendChild(empty);
    }
}
function updateHeader() {
    $('#chat-title').textContent = currentChat()?.title || 'claude-chat';
}

// ============================================================
// SETTINGS
// ============================================================
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
    toast('Saved');
}
function forgetTokens() {
    if (!confirm('Forget tokens? You will need to paste them again.')) return;
    ['access', 'refresh'].forEach(STORE.del);
    loadSettings();
    toast('Tokens forgotten');
}
function openModal() { $('#settings-modal').hidden = false; }
function closeModal() { $('#settings-modal').hidden = true; }

// ============================================================
// MESSAGE RENDER
// ============================================================
function renderMessages() {
    const m = $('#messages');
    m.innerHTML = '';
    const c = currentChat();
    if (!c || c.messages.length === 0) {
        const has = !!STORE.get('access');
        if (!has) {
            const wel = document.createElement('div');
            wel.className = 'welcome';
            wel.id = 'welcome';
            wel.innerHTML = `
                <h1>Talk to Claude</h1>
                <p>Paste your OAuth tokens once. Stored in your browser. Server only proxies.</p>
                <button class="primary" onclick="window._openSettings()">Add tokens to start</button>`;
            m.appendChild(wel);
        }
        return;
    }
    for (let i = 0; i < c.messages.length; i++) {
        renderMessageDOM(c.messages[i].role, c.messages[i].content, i);
    }
    scrollToBottom(true);
}

function renderMessageDOM(role, content, index = null) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap ' + role;
    if (index !== null) wrap.dataset.idx = index;

    const msg = document.createElement('div');
    msg.className = 'msg ' + role;

    if (Array.isArray(content)) {
        const imgs = content.filter(b => b.type === 'image');
        const docs = content.filter(b => b.type === 'document');
        const txt = content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');

        if (imgs.length) {
            const wImg = document.createElement('div');
            wImg.className = 'images';
            for (const im of imgs) {
                const i = document.createElement('img');
                i.src = `data:${im.source.media_type};base64,${im.source.data}`;
                wImg.appendChild(i);
            }
            msg.appendChild(wImg);
        }
        if (docs.length) {
            const wDoc = document.createElement('div');
            wDoc.className = 'files';
            for (const d of docs) {
                const chip = document.createElement('span');
                chip.className = 'file-chip';
                chip.textContent = '📄 ' + (d._name || 'document');
                wDoc.appendChild(chip);
            }
            msg.appendChild(wDoc);
        }
        if (txt) {
            const t = document.createElement('div');
            if (role === 'assistant') t.innerHTML = renderMarkdown(txt);
            else { t.style.whiteSpace = 'pre-wrap'; t.textContent = txt; }
            msg.appendChild(t);
            if (role === 'assistant') highlightAndDecorate(t);
        }
    } else {
        if (role === 'assistant') msg.innerHTML = renderMarkdown(content || '');
        else msg.textContent = content || '';
        if (role === 'assistant') highlightAndDecorate(msg);
    }

    wrap.appendChild(msg);

    // Actions for assistant messages
    if (role === 'assistant') {
        const actions = document.createElement('div');
        actions.className = 'msg-actions';
        const txt = extractMsgText({ role, content });
        actions.innerHTML = `<button data-act="copy">Copy</button>
                             <button data-act="regen">↻ Regenerate</button>`;
        actions.querySelector('[data-act="copy"]').addEventListener('click', () => {
            copyToClipboard(txt); toast('Copied');
        });
        actions.querySelector('[data-act="regen"]').addEventListener('click', () => regenerate());
        wrap.appendChild(actions);
    }

    $('#messages').appendChild(wrap);
    return msg;
}

function extractMsgText(m) {
    if (typeof m.content === 'string') return m.content;
    return (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n\n');
}

function renderMarkdown(text) {
    if (window.marked) {
        marked.setOptions({ breaks: true, gfm: true });
        return marked.parse(text);
    }
    return text.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function highlightAndDecorate(root) {
    if (window.hljs) {
        root.querySelectorAll('pre code').forEach(b => {
            try { hljs.highlightElement(b); } catch {}
        });
    }
    // Add copy button to each pre
    root.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.copy-code')) return;
        const btn = document.createElement('button');
        btn.className = 'copy-code';
        btn.textContent = 'Copy';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const code = pre.querySelector('code')?.innerText || pre.innerText;
            copyToClipboard(code);
            btn.textContent = 'Copied!';
            setTimeout(() => (btn.textContent = 'Copy'), 1200);
        });
        pre.appendChild(btn);
    });
}

let userScrolledUp = false;
function scrollToBottom(force = false) {
    const m = $('#messages');
    if (force || !userScrolledUp) m.scrollTop = m.scrollHeight;
}
function setupScrollLock() {
    const m = $('#messages');
    m.addEventListener('scroll', () => {
        userScrolledUp = m.scrollHeight - m.scrollTop - m.clientHeight > 120;
    }, { passive: true });
}

// ============================================================
// FILE HANDLING
// ============================================================
async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = reject;
        r.onload = () => {
            const res = r.result;
            resolve(res.slice(res.indexOf(',') + 1));
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

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

async function addAttachment(file) {
    if (file.size > MAX_FILE_BYTES) { toast(`${file.name}: too large (max 5 MB)`); return; }
    const mt = file.type || 'application/octet-stream';
    if (mt.startsWith('image/')) {
        state.attachments.push({ kind: 'image', name: file.name, size: file.size, media_type: mt, data: await fileToBase64(file) });
    } else if (mt === 'application/pdf') {
        state.attachments.push({ kind: 'document', name: file.name, size: file.size, media_type: 'application/pdf', data: await fileToBase64(file) });
    } else {
        let text = await fileToText(file);
        if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[…truncated]';
        state.attachments.push({ kind: 'text', name: file.name, size: file.size, text });
    }
    renderAttachments();
}
function removeAttachment(i) { state.attachments.splice(i, 1); renderAttachments(); }

function renderAttachments() {
    const el = $('#attachments');
    el.innerHTML = '';
    state.attachments.forEach((a, i) => {
        const chip = document.createElement('div');
        chip.className = 'attachment-chip';
        if (a.kind === 'image') {
            chip.innerHTML = `<img alt=""><span class="filename"></span><span class="filemeta"></span><button class="remove">×</button>`;
            chip.querySelector('img').src = `data:${a.media_type};base64,${a.data}`;
        } else {
            const icon = a.kind === 'document' ? '📄' : '📝';
            chip.innerHTML = `<span>${icon}</span><span class="filename"></span><span class="filemeta"></span><button class="remove">×</button>`;
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

function cleanForApi(messages) {
    return messages.map(m => {
        if (typeof m.content === 'string') return { role: m.role, content: m.content };
        return { role: m.role, content: m.content.map(b => b.type === 'document' ? { type: 'document', source: b.source } : b) };
    });
}

// ============================================================
// CHAT (send / stream / stop / regen)
// ============================================================
async function sendMessage(text) {
    text = text.trim();
    if (!text && state.attachments.length === 0) return;
    if (state.streaming) return;

    if (!currentChat()) newChat();
    const chat = currentChat();
    const userContent = buildUserContent(text);
    chat.messages.push({ role: 'user', content: userContent });

    if (chat.title === 'New chat') chat.title = autoTitleFromMessage(text || 'Chat');
    chat.updated = Date.now();
    state.attachments = [];
    renderAttachments();

    $('#welcome')?.remove();
    renderMessageDOM('user', userContent);
    await streamAndAppendAssistant();
}

async function regenerate() {
    if (state.streaming) return;
    const chat = currentChat();
    if (!chat || chat.messages.length === 0) return;
    // Drop last assistant message; keep last user message
    if (chat.messages[chat.messages.length - 1].role === 'assistant') {
        chat.messages.pop();
    }
    saveChats();
    renderMessages();
    await streamAndAppendAssistant();
}

async function streamAndAppendAssistant() {
    const chat = currentChat();
    const assistantEl = renderMessageDOM('assistant', '');
    assistantEl.classList.add('typing');
    scrollToBottom(true);

    state.streaming = true;
    state.abortCtl = new AbortController();
    setStopVisible(true);
    $('#send').disabled = true;
    $('#input').value = '';
    autoResize();

    let fullText = '';

    const doStream = async () => {
        await streamChat({
            messages: cleanForApi(chat.messages),
            onDelta: (d) => {
                fullText += d;
                assistantEl.innerHTML = renderMarkdown(fullText);
                highlightAndDecorate(assistantEl);
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

    try { await doStream(); }
    catch (e) {
        if (e.name === 'AbortError') {
            assistantEl.innerHTML = renderMarkdown(fullText + '\n\n_[stopped]_');
            highlightAndDecorate(assistantEl);
        } else showError(assistantEl, 0, e.message);
    } finally {
        assistantEl.classList.remove('typing');
        chat.messages.push({ role: 'assistant', content: fullText });
        chat.updated = Date.now();
        saveChats();
        renderMessages();      // re-render so action buttons get wired up
        renderSidebar();
        updateHeader();
        state.streaming = false;
        setStopVisible(false);
        $('#send').disabled = false;
        $('#input').focus();
    }
}

function stopStreaming() {
    if (state.abortCtl) state.abortCtl.abort();
}
function setStopVisible(v) {
    $('#stop').hidden = !v;
    $('#send').hidden = v;
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
    if (!resp.ok) { onError(resp.status, await resp.text()); return; }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let curEvent = null;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('event: ')) curEvent = line.slice(7).trim();
            else if (line.startsWith('data: ')) {
                try {
                    const j = JSON.parse(line.slice(6));
                    if (curEvent === 'error' || j.error) {
                        onError(j.status || resp.status, JSON.stringify(j));
                        return;
                    }
                    if (j.type === 'content_block_delta' && j.delta?.text) onDelta(j.delta.text);
                } catch {}
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
    } catch {}
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

// ============================================================
// EXPORT
// ============================================================
function exportChat() {
    const c = currentChat();
    if (!c || c.messages.length === 0) { toast('Nothing to export'); return; }
    let md = `# ${c.title}\n\n_${new Date(c.created).toISOString()}_\n\n`;
    for (const m of c.messages) {
        const role = m.role === 'user' ? '**You**' : '**Claude**';
        md += `## ${role}\n\n${extractMsgText(m)}\n\n---\n\n`;
    }
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = c.title.replace(/[^a-z0-9-_ ]/gi, '_') + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Exported');
}

// ============================================================
// UTIL
// ============================================================
function autoResize() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.3) + 'px';
}
async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { /* fallback */ const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
}
let toastTimer;
function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 1800);
}

// ============================================================
// SIDEBAR (mobile toggle + backdrop)
// ============================================================
function toggleSidebar() {
    const sb = $('#sidebar');
    const collapsed = sb.classList.toggle('collapsed');
    $('#backdrop').hidden = collapsed || !isMobile();
}
function closeSidebarOnMobile() {
    if (!isMobile()) return;
    $('#sidebar').classList.add('collapsed');
    $('#backdrop').hidden = true;
}
function initSidebarState() {
    // Default: collapsed on mobile, open on desktop
    if (isMobile()) {
        $('#sidebar').classList.add('collapsed');
        $('#backdrop').hidden = true;
    } else {
        $('#sidebar').classList.remove('collapsed');
        $('#backdrop').hidden = true;
    }
}

// ============================================================
// DRAG & DROP / PASTE
// ============================================================
let dragDepth = 0;
function setupDropZone() {
    const overlay = $('#drop-overlay');
    window.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dragDepth++; overlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) overlay.hidden = true;
    });
    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragDepth = 0; overlay.hidden = true;
        for (const f of (e.dataTransfer?.files || [])) await addAttachment(f);
    });
    window.addEventListener('paste', async (e) => {
        for (const it of (e.clipboardData?.items || [])) {
            if (it.kind === 'file') {
                const f = it.getAsFile();
                if (f) await addAttachment(f);
            }
        }
    });
}

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
function setupShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Cmd/Ctrl + K — new chat
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault(); newChat();
        }
        // Cmd/Ctrl + / — settings
        if ((e.metaKey || e.ctrlKey) && e.key === '/') {
            e.preventDefault(); openModal();
        }
        // Escape — close modal / sidebar (mobile)
        if (e.key === 'Escape') {
            if (!$('#settings-modal').hidden) closeModal();
            else if (isMobile() && !$('#sidebar').classList.contains('collapsed')) closeSidebarOnMobile();
        }
    });
}

// ============================================================
// WIRE UP
// ============================================================
window._openSettings = openModal;

document.addEventListener('DOMContentLoaded', () => {
    loadChats();
    loadSettings();
    if (!state.currentId) newChat();
    else { renderSidebar(); renderMessages(); updateHeader(); }
    initSidebarState();

    $('#new-chat').addEventListener('click', newChat);
    $('#settings-btn').addEventListener('click', openModal);
    $('#open-settings')?.addEventListener('click', openModal);
    $('#save-btn').addEventListener('click', saveSettings);
    $('#forget-btn').addEventListener('click', forgetTokens);
    $('#rename-chat-btn').addEventListener('click', renameChat);
    $('#export-btn').addEventListener('click', exportChat);
    $('#toggle-sidebar').addEventListener('click', toggleSidebar);
    $('#backdrop').addEventListener('click', closeSidebarOnMobile);
    $('#stop').addEventListener('click', stopStreaming);

    $('#settings-modal').addEventListener('click', (e) => {
        if (e.target.id === 'settings-modal') closeModal();
    });

    $('#model').addEventListener('change', (e) => STORE.set('model', e.target.value));
    $('#search').addEventListener('input', (e) => {
        state.searchTerm = e.target.value;
        renderSidebar();
    });

    $('#file-input').addEventListener('change', async (e) => {
        for (const f of e.target.files) await addAttachment(f);
        e.target.value = '';
    });

    $('#input').addEventListener('input', autoResize);
    $('#input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
            e.preventDefault();
            sendMessage($('#input').value);
        }
    });
    $('#composer').addEventListener('submit', (e) => {
        e.preventDefault();
        sendMessage($('#input').value);
    });

    setupDropZone();
    setupScrollLock();
    setupShortcuts();

    // Re-eval sidebar state on resize
    window.addEventListener('resize', () => {
        if (!isMobile()) {
            $('#sidebar').classList.remove('collapsed');
            $('#backdrop').hidden = true;
        }
    });
});
