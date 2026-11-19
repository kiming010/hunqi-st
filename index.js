// 魂器 ST 插件（本地模拟版）：存档、整理摘要、唤醒。
// 这一层就是"插头"：把 ST 的东西翻进魂器，再从魂器翻回 ST。
//
// 两种存法：
//   1. 魂器文件夹：浏览器能直接读写文件夹时（电脑上的 Chrome / Edge，页面是 https 或 localhost）
//   2. 存档文件：读写不了文件夹时（http 局域网地址、Firefox、iPhone），下载一个 zip，唤醒时再选这个 zip。
//      zip 里的结构和魂器文件夹一模一样，解压到 U 盘上就是一个魂器。
import {
    saveSoul, listSouls, loadSoul,
    readSummary, writeSummary, chunkMessages, buildSummaryPrompt,
    putSummaryIntoChat, countMessages, parseJsonl, cleanText,
    MemDir, zipDir, unzipToDir, findSoulRoot,
} from './lib.js';

const MODULE = 'hunqi';
const CHUNK_CHARS = 12000;
const ctx = () => SillyTavern.getContext();

let rootDir = null;
let running = false;

// ---------- 浏览器里的小仓库：记住魂器文件夹；没有文件夹时存摘要 ----------

const IDB_NAME = 'hunqi';
const STORE_HANDLES = 'handles';
const STORE_SUMMARIES = 'summaries';

function idb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 2);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
            if (!db.objectStoreNames.contains(STORE_SUMMARIES)) db.createObjectStore(STORE_SUMMARIES);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(store, key) {
    try {
        const db = await idb();
        return await new Promise((resolve, reject) => {
            const req = db.transaction(store).objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    } catch {
        return null;
    }
}

async function idbSet(store, key, value) {
    const db = await idb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** 取出某个 TA 存在浏览器里的全部摘要：{ 聊天文件名: 摘要 } */
async function idbSummaries(soulId) {
    try {
        const db = await idb();
        return await new Promise((resolve, reject) => {
            const out = {};
            const range = IDBKeyRange.bound(`${soulId}\n`, `${soulId}\n￿`);
            const req = db.transaction(STORE_SUMMARIES).objectStore(STORE_SUMMARIES).openCursor(range);
            req.onsuccess = () => {
                const cur = req.result;
                if (!cur) return resolve(out);
                out[String(cur.key).slice(soulId.length + 1)] = cur.value;
                cur.continue();
            };
            req.onerror = () => reject(req.error);
        });
    } catch {
        return {};
    }
}

// ---------- 魂器文件夹（模拟硬件） ----------

function folderSupported() {
    return window.isSecureContext && typeof window.showDirectoryPicker === 'function';
}

/** 不能读写文件夹时，说清楚是哪种原因。 */
function folderProblem() {
    if (!window.isSecureContext) {
        return '这个页面不是 https（也不是 localhost），浏览器不让直接读写文件夹。可以用"下载存档文件"和"从文件唤醒"。';
    }
    if (typeof window.showDirectoryPicker !== 'function') {
        return '这个浏览器不支持直接读写文件夹（Firefox、Safari、Brave 和大部分手机浏览器都不行）。可以用"下载存档文件"和"从文件唤醒"。';
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
        try { await idbSet(STORE_HANDLES, 'root', handle); } catch (e) { console.warn('[魂器] 记不住文件夹，下次要重新选', e); }
        await refreshSouls();
        return rootDir;
    } catch (e) {
        if (e?.name === 'AbortError') return null;
        if (e?.name === 'SecurityError') {
            throw new Error('浏览器不让弹出选文件夹的窗口。可能是 ST 被套在了别的网页里面（iframe）。可以用"下载存档文件"和"从文件唤醒"。');
        }
        throw e;
    }
}

/** 拿到魂器文件夹：先用记住的，没权限就问一次，再不行就让用户选。 */
async function ensureFolder() {
    if (rootDir && await hasPermission(rootDir, true)) return rootDir;
    const saved = await idbGet(STORE_HANDLES, 'root');
    if (saved && await hasPermission(saved, true)) {
        rootDir = saved;
        await refreshSouls();
        return rootDir;
    }
    return await pickFolder();
}

/** 已经连着、而且不用再问权限的魂器文件夹；没有就是 null。 */
async function connectedFolder() {
    try {
        return rootDir && await hasPermission(rootDir, false) ? rootDir : null;
    } catch {
        return null;
    }
}

// ---------- 摘要存在哪：有文件夹存文件夹，没有存浏览器 ----------

async function getSummary(soulId, file) {
    if (folderSupported()) {
        const root = await ensureFolder();
        if (root) return await readSummary(root, soulId, file);
    }
    return await idbGet(STORE_SUMMARIES, `${soulId}\n${file}`);
}

async function putSummary(soulId, file, data) {
    if (folderSupported() && rootDir) return await writeSummary(rootDir, soulId, file, data);
    await idbSet(STORE_SUMMARIES, `${soulId}\n${file}`, data);
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

/** 从 ST 里收齐现在这个 TA：卡和全部聊天原件。 */
async function collectSoul() {
    const id = currentCharacter();
    if (id === null) {
        toastr.warning('先打开一个角色的聊天（群聊这一版还不支持）', '魂器');
        return null;
    }
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
    return { soulId, name: ch.name, avatar, activeChat: ch.chat, card, chats };
}

function reportText(report) {
    let msg = `${report.chats} 段聊天，共 ${report.messages} 条消息`;
    if (report.unchanged) msg += `（${report.unchanged} 段没变，没重写）`;
    return msg;
}

async function onSave() {
    const root = await ensureFolder();
    if (!root) return;
    const soul = await collectSoul();
    if (!soul) return;

    say('正在存进魂器…');
    const report = await saveSoul(root, soul);
    await refreshSouls();

    const msg = `TA 记住了今天：${reportText(report)}`;
    say(msg);
    toastr.success(msg, '魂器');
    if (report.kept.length) {
        const lost = report.kept.reduce((s, k) => s + k.lost, 0);
        toastr.warning(`酒馆里有 ${report.kept.length} 段聊天变短了（少了 ${lost} 条），旧版本已经留在魂器的 chats/_old 里`, '魂器', { timeOut: 10000 });
    }
}

function safeFileName(s) {
    return String(s).replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim() || 'TA';
}

function stampForFile(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 下载存档文件：在内存里搭一个魂器，打成 zip。 */
async function onDownload() {
    const soul = await collectSoul();
    if (!soul) return;

    say('正在打包…');
    const mem = new MemDir('');
    const report = await saveSoul(mem, soul);

    // 摘要一起带上：浏览器里存的，加上魂器文件夹里的（如果连着）
    const summaries = await idbSummaries(soul.soulId);
    const folder = await connectedFolder();
    for (const { file } of soul.chats) {
        const s = (folder && await readSummary(folder, soul.soulId, file)) || summaries[file];
        if (s) await writeSummary(mem, soul.soulId, file, s);
    }

    const zip = await zipDir(mem);
    const name = `${safeFileName(soul.name)}-存档-${stampForFile()}.hunqi.zip`;
    downloadBlob(zip, name);

    const msg = `存档文件已下载：${name}（${(zip.size / 1048576).toFixed(2)}MB，${reportText(report)}）`;
    say(msg);
    toastr.success(msg, '魂器');
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

    const soulId = await ensureSoulId(id);
    const ch = c.characters[id];
    const file = `${chatId}.jsonl`;
    const messages = c.chat;
    const prev = (await getSummary(soulId, file)) ?? { text: '', covered: 0 };
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
        await putSummary(soulId, file, {
            chat_file: file,
            text,
            covered,
            total: messages.length,
            updated_at: new Date().toISOString(),
        });
    }

    const where = folderSupported() && rootDir ? '魂器' : '浏览器里（下载存档文件时会一起带上）';
    say(`摘要已存进${where}，整理到第 ${covered} 条`);
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

/** 从一个魂器（文件夹，或者存档文件解出来的内存魂器）里把 TA 放回这家酒馆。 */
async function wakeFrom(root, soulId) {
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

async function onWake() {
    const soulId = String($('#hunqi_soul_select').val() || '');
    if (!soulId) return toastr.warning('先连接魂器，再选一个 TA', '魂器');
    const root = await ensureFolder();
    if (!root) return;
    await wakeFrom(root, soulId);
}

/** 从文件唤醒：选一个存档文件（zip），解到内存里，再唤醒。 */
async function onWakeFile(file) {
    if (!file) return;
    say(`正在打开 ${file.name}…`);
    const root = await findSoulRoot(await unzipToDir(file));
    const souls = await listSouls(root);
    if (!souls.length) throw new Error('这个文件里没有 TA。要选"下载存档文件"下载的那个 .zip');

    let pick = souls[0];
    if (souls.length > 1) {
        const c = ctx();
        const list = souls.map((s, i) => `${i + 1}. ${escapeHtml(s.name)}（${s.chats} 段，${s.messages} 条）`).join('<br>');
        const answer = await c.callGenericPopup(`这个文件里有 ${souls.length} 个 TA，要唤醒第几个？<br><br>${list}`, c.POPUP_TYPE.INPUT, '1');
        if (answer === null || answer === false || answer === '') return;
        pick = souls[Number(answer) - 1];
        if (!pick) throw new Error('没有这个编号');
    }
    await wakeFrom(root, pick.soul_id);
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
    return async (...args) => {
        if (running) return;
        running = true;
        $('.hunqi-panel .menu_button').addClass('disabled');
        try {
            await fn(...args);
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
      <div class="hunqi-row hunqi-folder-only"><span id="hunqi_status">魂器：没连接</span></div>
      <div class="hunqi-row hunqi-folder-only"><div id="hunqi_connect" class="menu_button">选择魂器文件夹</div></div>
      <hr class="sysHR hunqi-folder-only">
      <div class="hunqi-row">现在的 TA：<b id="hunqi_current">（没打开角色）</b></div>
      <div class="hunqi-row">
        <div id="hunqi_save" class="menu_button hunqi-folder-only">存档</div>
        <div id="hunqi_download" class="menu_button">下载存档文件</div>
        <div id="hunqi_summarize" class="menu_button">整理摘要</div>
      </div>
      <hr class="sysHR">
      <div class="hunqi-row hunqi-folder-only">魂器里的 TA：</div>
      <div class="hunqi-row hunqi-folder-only">
        <select id="hunqi_soul_select" class="text_pole"></select>
        <div id="hunqi_wake" class="menu_button">唤醒</div>
      </div>
      <div class="hunqi-row">
        <div id="hunqi_wake_file" class="menu_button">从文件唤醒</div>
        <input id="hunqi_file" type="file" accept=".zip,application/zip" hidden>
      </div>
      <div class="hunqi-row hunqi-hint" id="hunqi_msg"></div>
    </div>
  </div>
</div>`;

jQuery(async () => {
    $('#extensions_settings2').append(PANEL);
    $('#hunqi_connect').on('click', guard(pickFolder));
    $('#hunqi_save').on('click', guard(onSave));
    $('#hunqi_download').on('click', guard(onDownload));
    $('#hunqi_summarize').on('click', guard(onSummarize));
    $('#hunqi_wake').on('click', guard(onWake));
    $('#hunqi_wake_file').on('click', () => { if (!running) $('#hunqi_file').trigger('click'); });
    $('#hunqi_file').on('change', guard(async function () {
        const input = /** @type {HTMLInputElement} */ (document.getElementById('hunqi_file'));
        const file = input.files?.[0];
        input.value = '';
        await onWakeFile(file);
    }));

    const problem = folderProblem();
    if (problem) {
        $('.hunqi-panel .hunqi-folder-only').hide();
        say(problem);
    } else {
        // 记住的文件夹：先显示出来，点按钮时再要权限
        rootDir = await idbGet(STORE_HANDLES, 'root');
        await refreshSouls();
    }
    refreshCurrent();

    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.CHAT_CHANGED, refreshCurrent);
});
