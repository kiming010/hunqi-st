// 魂器 ST 插件（本地模拟版）：存档、整理摘要、唤醒。
// 这一层就是"插头"：把 ST 的东西翻进魂器，再从魂器翻回 ST。
import {
    saveSoul, listSouls, loadSoul,
    readSummary, writeSummary, chunkMessages, buildSummaryPrompt,
    putSummaryIntoChat, countMessages, parseJsonl, cleanText,
} from './lib.js';

const MODULE = 'hunqi';
const CHUNK_CHARS = 12000;
const ctx = () => SillyTavern.getContext();

let rootDir = null;
let running = false;

// ---------- 魂器文件夹（模拟硬件） ----------

const IDB_NAME = 'hunqi';
const IDB_STORE = 'handles';

function idb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    try {
        const db = await idb();
        return await new Promise((resolve, reject) => {
            const req = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return null;
    }
}

async function idbSet(key, value) {
    try {
        const db = await idb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[魂器] 记不住文件夹，下次要重新选', e);
    }
}

function folderSupported() {
    return typeof window.showDirectoryPicker === 'function';
}

/** 不能读写文件夹时，说清楚是哪种原因。 */
function folderProblem() {
    if (!window.isSecureContext) {
        return '这个页面不是 HTTPS（也不是 localhost），浏览器不让读写文件夹。';
    }
    if (!folderSupported()) {
        return '这个浏览器不支持直接读写文件夹（Firefox、Safari、Brave 和大部分手机浏览器都不行）。请换电脑上的 Chrome 或 Edge 打开 ST。';
    }
    return null;
}

async function hasPermission(handle, ask) {
    const opts = { mode: 'readwrite' };
    if (await handle.queryPermission(opts) === 'granted') return true;
    return ask && await handle.requestPermission(opts) === 'granted';
}

async function pickFolder() {
    const problem = folderProblem();
    if (problem) {
        toastr.error(problem, '魂器');
        return null;
    }
    try {
        const handle = await window.showDirectoryPicker({ id: 'hunqi', mode: 'readwrite' });
        rootDir = handle;
        await idbSet('root', handle);
        await refreshSouls();
        return rootDir;
    } catch (e) {
        if (e?.name === 'AbortError') return null;
        if (e?.name === 'SecurityError') {
            throw new Error('浏览器不让弹出选文件夹的窗口。可能是云酒馆把 ST 套在了别的网页里面（iframe）。');
        }
        throw e;
    }
}

/** 拿到魂器文件夹：先用记住的，没权限就问一次，再不行就让用户选。 */
async function ensureFolder() {
    if (rootDir && await hasPermission(rootDir, true)) return rootDir;
    const saved = await idbGet('root');
    if (saved && await hasPermission(saved, true)) {
        rootDir = saved;
        await refreshSouls();
        return rootDir;
    }
    return await pickFolder();
}

// ---------- ST 接口 ----------

async function post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${url} 返回 ${res.status}`);
    return res;
}

const postJson = async (url, body) => (await post(url, body)).json();

function currentCharacter() {
    const c = ctx();
    if (c.groupId) return null;
    if (c.characterId === undefined || c.characterId === null) return null;
    const id = Number(c.characterId);
    return c.characters[id] ? id : null;
}

/** ST 没有稳定的角色 ID，魂器自己发一个，写进卡的 data.extensions.hunqi。 */
async function ensureSoulId(id) {
    const c = ctx();
    if (typeof c.unshallowCharacter === 'function') await c.unshallowCharacter(id);
    const ch = c.characters[id];
    let soulId = ch?.data?.extensions?.[MODULE]?.soul_id;
    if (!soulId) {
        soulId = c.uuidv4();
        await c.writeExtensionField(id, MODULE, { soul_id: soulId });
    }
    rememberAvatar(soulId, ch.avatar);
    return soulId;
}

function rememberAvatar(soulId, avatar) {
    const c = ctx();
    c.extensionSettings[MODULE] ??= {};
    c.extensionSettings[MODULE].map ??= {};
    c.extensionSettings[MODULE].map[soulId] = avatar;
    c.saveSettingsDebounced();
}

/** 这家酒馆里是不是已经有这个 TA 了。 */
function findAvatar(soulId) {
    const c = ctx();
    const mapped = c.extensionSettings[MODULE]?.map?.[soulId];
    if (mapped && c.characters.some(x => x.avatar === mapped)) return mapped;
    return c.characters.find(x => x?.data?.extensions?.[MODULE]?.soul_id === soulId)?.avatar ?? null;
}

async function listStChats(avatar) {
    const list = await postJson('/api/characters/chats', { avatar_url: avatar, simple: true });
    return Array.isArray(list) ? list.map(x => x.file_name) : [];
}

// ---------- 存档 ----------

async function onSave() {
    const id = currentCharacter();
    if (id === null) return toastr.warning('先打开一个角色的聊天（群聊这一版还不支持）', '魂器');
    const root = await ensureFolder();
    if (!root) return;

    const c = ctx();
    await c.saveChat?.();
    const soulId = await ensureSoulId(id);
    const ch = c.characters[id];
    const avatar = ch.avatar;

    say('正在收拾 TA 的东西…');
    const card = await (await post('/api/characters/export', { format: 'png', avatar_url: avatar })).blob();

    const chats = [];
    for (const file of await listStChats(avatar)) {
        const r = await postJson('/api/chats/export', {
            is_group: false, avatar_url: avatar, file, exportfilename: file, format: 'jsonl',
        });
        if (typeof r?.result === 'string') chats.push({ file, raw: r.result });
    }

    say('正在存进魂器…');
    const report = await saveSoul(root, { soulId, name: ch.name, avatar, activeChat: ch.chat, card, chats });
    await refreshSouls();

    let msg = `TA 记住了今天：${report.chats} 段聊天，共 ${report.messages} 条消息`;
    if (report.unchanged) msg += `（${report.unchanged} 段没变，没重写）`;
    say(msg);
    toastr.success(msg, '魂器');
    if (report.kept.length) {
        const lost = report.kept.reduce((s, k) => s + k.lost, 0);
        toastr.warning(`酒馆里有 ${report.kept.length} 段聊天变短了（少了 ${lost} 条），旧版本已经留在魂器的 chats/_old 里`, '魂器', { timeOut: 10000 });
    }
}

// ---------- 整理摘要 ----------

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function onSummarize() {
    const id = currentCharacter();
    if (id === null) return toastr.warning('先打开一个角色的聊天（群聊这一版还不支持）', '魂器');
    const c = ctx();
    const chatId = c.getCurrentChatId();
    if (!chatId) return toastr.warning('先打开一段聊天', '魂器');
    const root = await ensureFolder();
    if (!root) return;

    const soulId = await ensureSoulId(id);
    const ch = c.characters[id];
    const file = `${chatId}.jsonl`;
    const messages = c.chat;
    const prev = (await readSummary(root, soulId, file)) ?? { text: '', covered: 0 };
    let covered = Math.min(Number(prev.covered) || 0, messages.length);
    const chunks = chunkMessages(messages, covered, CHUNK_CHARS);

    if (!chunks.length) {
        toastr.info('这段聊天没有新内容要整理', '魂器');
        if (prev.text) await showSummary(ch.name, prev.text);
        return;
    }

    if (chunks.length > 3) {
        const ok = await c.callGenericPopup(
            `要整理 ${messages.length - covered} 条消息，会分 ${chunks.length} 次调用你现在用的模型。继续吗？`,
            c.POPUP_TYPE.CONFIRM,
        );
        if (ok !== 1) return;
    }

    let text = prev.text ?? '';
    for (let i = 0; i < chunks.length; i++) {
        say(`正在整理摘要 ${i + 1}/${chunks.length}…`);
        const { systemPrompt, prompt } = buildSummaryPrompt(text, chunks[i].text, ch.name, c.name1);
        const out = cleanText(await c.generateRaw({ systemPrompt, prompt, responseLength: 2048 }));
        if (!out) {
            toastr.warning('模型没有返回内容，先停在这里，下次点"整理摘要"会接着整理', '魂器');
            break;
        }
        text = out;
        covered = chunks[i].to;
        // 每段整理完就存一次，中途断了也不白做
        await writeSummary(root, soulId, file, {
            chat_file: file,
            text,
            covered,
            total: messages.length,
            updated_at: new Date().toISOString(),
        });
    }

    say(`摘要已存进魂器（整理到第 ${covered} 条）`);
    if (text) await showSummary(ch.name, text);
}

async function showSummary(name, text) {
    const c = ctx();
    await c.callGenericPopup(
        `<h3>${escapeHtml(name)} 的摘要</h3><div class="hunqi-summary">${escapeHtml(text)}</div>`,
        c.POPUP_TYPE.TEXT,
        '',
        { wide: true, allowVerticalScrolling: true },
    );
}

// ---------- 唤醒 ----------

async function onWake() {
    const soulId = String($('#hunqi_soul_select').val() || '');
    if (!soulId) return toastr.warning('先连接魂器，再选一个 TA', '魂器');
    const root = await ensureFolder();
    if (!root) return;

    say('正在叫醒 TA…');
    const soul = await loadSoul(root, soulId);
    const c = ctx();
    await c.saveChat?.();

    // 1. 这家酒馆里有 TA 就用现成的，没有就把卡导进来
    let avatar = findAvatar(soulId);
    if (!avatar) {
        if (!soul.card) throw new Error('魂器里没有这个 TA 的角色卡（card.png）');
        const fd = new FormData();
        fd.append('avatar', new File([soul.card], 'card.png', { type: 'image/png' }));
        fd.append('file_type', 'png');
        fd.append('user_name', c.name1);
        const res = await fetch('/api/characters/import', {
            method: 'POST',
            headers: c.getRequestHeaders({ omitContentType: true }),
            body: fd,
        });
        const data = res.ok ? await res.json() : { error: true };
        if (data.error || !data.file_name) throw new Error('角色卡导入失败');
        avatar = `${data.file_name}.png`;
    }

    // 2. 聊天：魂器里的更完整才写，酒馆里的不会被改短
    await postJson('/api/chats/get', { avatar_url: avatar, file_name: '' }); // 确保聊天目录存在
    const stFiles = new Set(await listStChats(avatar));
    let written = 0;
    let skipped = 0;
    let withSummary = 0;
    for (const { file, raw } of soul.chats) {
        const base = file.replace(/\.jsonl$/, '');
        if (stFiles.has(file)) {
            const theirs = await postJson('/api/chats/get', { avatar_url: avatar, file_name: base });
            const theirCount = Array.isArray(theirs) ? Math.max(0, theirs.length - 1) : 0;
            if (theirCount >= countMessages(raw)) {
                skipped++;
                continue;
            }
        }
        const arr = parseJsonl(raw);
        if (putSummaryIntoChat(arr, soul.summaries[file]?.text)) withSummary++;
        await post('/api/chats/save', { avatar_url: avatar, file_name: base, chat: arr, force: true });
        written++;
    }

    // 3. 打开 TA 上次在聊的那一段
    const active = soul.manifest.active_chat;
    if (active && soul.chats.some(x => x.file === `${active}.jsonl`)) {
        await post('/api/characters/merge-attributes', { avatar, chat: active });
    }

    rememberAvatar(soulId, avatar);
    const wasOpen = currentCharacter() !== null && ctx().characters[currentCharacter()]?.avatar === avatar;
    await c.getCharacters();
    const index = ctx().characters.findIndex(x => x.avatar === avatar);
    if (wasOpen) {
        // TA 正开着：重新读一遍聊天，免得 ST 拿内存里的旧版本把刚放回去的覆盖掉
        await ctx().reloadCurrentChat();
    } else if (index >= 0) {
        await ctx().selectCharacterById(index);
    }

    let msg = `TA 醒了：放回 ${written} 段聊天`;
    if (skipped) msg += `，${skipped} 段酒馆里已经是最全的`;
    if (withSummary) msg += `，${withSummary} 段带上了摘要`;
    say(msg);
    toastr.success(msg, '魂器');
}

// ---------- 面板 ----------

function say(text) {
    $('#hunqi_msg').text(text);
}

async function refreshSouls() {
    const select = $('#hunqi_soul_select');
    select.empty();
    if (!rootDir) {
        $('#hunqi_status').text('魂器：没连接');
        return;
    }
    $('#hunqi_status').text(`魂器：${rootDir.name}`);
    let souls = [];
    try {
        if (await hasPermission(rootDir, false)) souls = await listSouls(rootDir);
    } catch (e) {
        console.warn('[魂器] 读不出魂器里的 TA', e);
    }
    if (!souls.length) {
        select.append($('<option>').val('').text('（魂器里还没有 TA）'));
        return;
    }
    for (const s of souls) {
        const when = s.saved_at ? s.saved_at.slice(0, 16).replace('T', ' ') : '';
        select.append($('<option>').val(s.soul_id).text(`${s.name}：${s.chats} 段，${s.messages} 条，${when}`));
    }
}

function refreshCurrent() {
    const id = currentCharacter();
    $('#hunqi_current').text(id === null ? '（没打开角色）' : ctx().characters[id].name);
}

function guard(fn) {
    return async () => {
        if (running) return;
        running = true;
        $('.hunqi-panel .menu_button').addClass('disabled');
        try {
            await fn();
        } catch (e) {
            console.error('[魂器]', e);
            say(`出错了：${e?.message ?? e}`);
            toastr.error(String(e?.message ?? e), '魂器出错了');
        } finally {
            running = false;
            $('.hunqi-panel .menu_button').removeClass('disabled');
        }
    };
}

const PANEL = `
<div class="hunqi-panel">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>魂器（本地模拟）</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="hunqi-row"><span id="hunqi_status">魂器：没连接</span></div>
      <div class="hunqi-row"><div id="hunqi_connect" class="menu_button">选择魂器文件夹</div></div>
      <hr class="sysHR">
      <div class="hunqi-row">现在的 TA：<b id="hunqi_current">（没打开角色）</b></div>
      <div class="hunqi-row">
        <div id="hunqi_save" class="menu_button">存档</div>
        <div id="hunqi_summarize" class="menu_button">整理摘要</div>
      </div>
      <hr class="sysHR">
      <div class="hunqi-row">魂器里的 TA：</div>
      <div class="hunqi-row">
        <select id="hunqi_soul_select" class="text_pole"></select>
        <div id="hunqi_wake" class="menu_button">唤醒</div>
      </div>
      <div class="hunqi-row hunqi-hint" id="hunqi_msg"></div>
    </div>
  </div>
</div>`;

jQuery(async () => {
    $('#extensions_settings2').append(PANEL);
    $('#hunqi_connect').on('click', guard(pickFolder));
    $('#hunqi_save').on('click', guard(onSave));
    $('#hunqi_summarize').on('click', guard(onSummarize));
    $('#hunqi_wake').on('click', guard(onWake));

    const problem = folderProblem();
    if (problem) say(problem);

    // 记住的文件夹：先显示出来，点按钮时再要权限
    rootDir = await idbGet('root');
    await refreshSouls();
    refreshCurrent();

    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.CHAT_CHANGED, refreshCurrent);
});
