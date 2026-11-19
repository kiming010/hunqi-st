// 魂器容器的纯逻辑。不碰 ST，只碰"文件夹"。
// 文件夹 = 模拟的魂器。以后换成硬件：U 盘模式本身就是文件夹；串口模式只要换掉这一层的读写。
//
// 魂器文件夹长这样：
//   hunqi.json                         这是一个魂器
//   souls/<soul_id>/soul.json          这个 TA 的清单
//   souls/<soul_id>/card.png           角色卡原件（ST 导出的 PNG）
//   souls/<soul_id>/chats/*.jsonl      聊天原件，一个字节不改
//   souls/<soul_id>/chats/_old/        酒馆里聊天变短时，留下的旧版本
//   souls/<soul_id>/summary/*.json     摘要（从原话算出来的，可以重算，永远不覆盖原话）

export const FORMAT_VERSION = 1;
const SOULS = 'souls';

// ---------- 聊天原件 ----------

/** JSONL：第一行是表头，之后每行一条消息。 */
export function countMessages(raw) {
    const lines = String(raw ?? '').split('\n').filter(l => l.trim().length > 0);
    return Math.max(0, lines.length - 1);
}

export function parseJsonl(raw) {
    const out = [];
    for (const line of String(raw ?? '').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return out;
}

export async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function stamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

// ---------- 文件夹读写 ----------

async function getDir(parent, name, create = false) {
    try {
        return await parent.getDirectoryHandle(name, { create });
    } catch (e) {
        if (!create && e?.name === 'NotFoundError') return null;
        throw e;
    }
}

async function readFile(dir, name) {
    try {
        const fh = await dir.getFileHandle(name);
        return await fh.getFile();
    } catch (e) {
        if (e?.name === 'NotFoundError') return null;
        throw e;
    }
}

async function readText(dir, name) {
    const file = await readFile(dir, name);
    return file === null ? null : await file.text();
}

async function writeFile(dir, name, data) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
}

async function readJson(dir, name) {
    const text = await readText(dir, name);
    if (text === null) return null;
    try { return JSON.parse(text); } catch { return null; }
}

/** 摘要文件名：聊天文件名去掉 .jsonl 再加 .json */
function summaryName(chatFile) {
    return `${String(chatFile).replace(/\.jsonl$/, '')}.json`;
}

// ---------- 存档 ----------

/**
 * 把一个 TA 存进魂器。
 * 规矩：聊天原样存；内容没变就不写；酒馆里的聊天变短了（删了消息），旧版本先留进 _old 再覆盖；
 * 魂器里有、酒馆里已经没有的聊天，原样留着，永远不删。
 * @param {FileSystemDirectoryHandle} root 魂器文件夹
 * @param {{soulId:string, name:string, avatar:string, activeChat?:string, card?:Blob, chats:{file:string, raw:string}[]}} soul
 */
export async function saveSoul(root, { soulId, name, avatar, activeChat, card, chats }) {
    const now = new Date().toISOString();
    if (await readText(root, 'hunqi.json') === null) {
        await writeFile(root, 'hunqi.json', JSON.stringify({ format: 'hunqi-folder', format_version: FORMAT_VERSION }, null, 2));
    }

    const soulsDir = await getDir(root, SOULS, true);
    const dir = await getDir(soulsDir, soulId, true);
    const chatsDir = await getDir(dir, 'chats', true);

    const manifest = (await readJson(dir, 'soul.json')) ?? {
        format_version: FORMAT_VERSION,
        soul_id: soulId,
        chats: {},
        kept_old: [],
    };
    manifest.chats ??= {};
    manifest.kept_old ??= [];
    manifest.name = name;
    manifest.st_avatar = avatar;
    if (activeChat) manifest.active_chat = activeChat;
    manifest.saved_at = now;

    if (card) await writeFile(dir, 'card.png', card);

    const report = { chats: chats.length, messages: 0, written: 0, unchanged: 0, kept: [], onlyInSoul: [] };

    for (const { file, raw } of chats) {
        const count = countMessages(raw);
        report.messages += count;
        const hash = await sha256(raw);
        const prev = manifest.chats[file];

        if (prev && prev.sha256 === hash) {
            report.unchanged++;
            continue;
        }

        const prevRaw = await readText(chatsDir, file);
        if (prevRaw !== null) {
            const prevCount = countMessages(prevRaw);
            if (prevCount > count) {
                const oldDir = await getDir(chatsDir, '_old', true);
                const keptAs = `${file.replace(/\.jsonl$/, '')}.${stamp()}.jsonl`;
                await writeFile(oldDir, keptAs, prevRaw);
                manifest.kept_old.push({ file, kept_as: keptAs, messages: prevCount, kept_at: now });
                report.kept.push({ file, lost: prevCount - count });
            }
        }

        await writeFile(chatsDir, file, raw);
        manifest.chats[file] = { messages: count, sha256: hash, saved_at: now };
        report.written++;
    }

    const savedNow = new Set(chats.map(c => c.file));
    report.onlyInSoul = Object.keys(manifest.chats).filter(f => !savedNow.has(f));

    await writeFile(dir, 'soul.json', JSON.stringify(manifest, null, 2));
    return report;
}

// ---------- 读出来 ----------

/** 列出魂器里所有的 TA，最近存档的排前面。 */
export async function listSouls(root) {
    const soulsDir = await getDir(root, SOULS);
    if (!soulsDir) return [];
    const out = [];
    for await (const [name, handle] of soulsDir.entries()) {
        if (handle.kind !== 'directory') continue;
        const m = await readJson(handle, 'soul.json');
        if (!m) continue;
        const chats = Object.values(m.chats ?? {});
        out.push({
            soul_id: m.soul_id ?? name,
            name: m.name ?? name,
            saved_at: m.saved_at ?? '',
            chats: chats.length,
            messages: chats.reduce((s, c) => s + (c.messages ?? 0), 0),
        });
    }
    return out.sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
}

/** 把一个 TA 整个读出来：清单、卡、全部聊天原件、摘要。 */
export async function loadSoul(root, soulId) {
    const soulsDir = await getDir(root, SOULS);
    const dir = soulsDir && await getDir(soulsDir, soulId);
    if (!dir) throw new Error(`魂器里找不到这个 TA（${soulId}）`);
    const manifest = await readJson(dir, 'soul.json');
    if (!manifest) throw new Error('这个 TA 的清单（soul.json）读不出来');
    const card = await readFile(dir, 'card.png');
    const chatsDir = await getDir(dir, 'chats');
    const summaryDir = await getDir(dir, 'summary');

    const chats = [];
    const summaries = {};
    for (const file of Object.keys(manifest.chats ?? {})) {
        const raw = chatsDir && await readText(chatsDir, file);
        if (raw !== null && raw !== undefined) chats.push({ file, raw });
        const s = summaryDir && await readJson(summaryDir, summaryName(file));
        if (s) summaries[file] = s;
    }
    return { manifest, card, chats, summaries };
}

// ---------- 摘要 ----------

export async function readSummary(root, soulId, chatFile) {
    const soulsDir = await getDir(root, SOULS);
    const dir = soulsDir && await getDir(soulsDir, soulId);
    const summaryDir = dir && await getDir(dir, 'summary');
    return summaryDir ? await readJson(summaryDir, summaryName(chatFile)) : null;
}

export async function writeSummary(root, soulId, chatFile, data) {
    const soulsDir = await getDir(root, SOULS, true);
    const dir = await getDir(soulsDir, soulId, true);
    const summaryDir = await getDir(dir, 'summary', true);
    await writeFile(summaryDir, summaryName(chatFile), JSON.stringify(data, null, 2));
}

/** 去掉 HTML 标签（前端卡、状态栏），只留文字。 */
export function cleanText(s) {
    return String(s ?? '').replace(/<[^>]*>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 把还没整理过的消息切成几段，每段不超过 maxChars 个字。
 * @param {object[]} messages ST 内存里的聊天（不含表头）
 * @param {number} start 从第几条开始（之前的已经整理过）
 * @returns {{from:number, to:number, text:string}[]} to 是"整理到这一段后，已经覆盖到第几条"
 */
export function chunkMessages(messages, start, maxChars) {
    const chunks = [];
    let lines = [];
    let len = 0;
    let from = start;
    for (let i = start; i < messages.length; i++) {
        const m = messages[i];
        if (!m || m.is_system) continue;
        const line = `${m.name || (m.is_user ? '我' : 'TA')}：${cleanText(m.mes)}`;
        if (lines.length && len + line.length > maxChars) {
            chunks.push({ from, to: i, text: lines.join('\n\n') });
            lines = [];
            len = 0;
            from = i;
        }
        lines.push(line);
        len += line.length + 2;
    }
    if (lines.length) chunks.push({ from, to: messages.length, text: lines.join('\n\n') });
    return chunks;
}

export function buildSummaryPrompt(previous, chunkText, charName, userName) {
    const systemPrompt = [
        `你是一位记录员，负责为 ${userName} 和 ${charName} 之间的长期对话维护一份摘要。`,
        `这份摘要的用途：${charName} 换到一个新的地方醒来时，读了它就知道你们之间发生过什么，能接着聊下去。`,
        '要保留：两人现在的关系、彼此的称呼、按时间顺序的重要事件、约定和承诺、只有两人懂的梗、几句关键时刻的原话（加引号，一字不改）。',
        '如实记录，不评价，不删减任何类型的内容。',
        '只输出更新后的完整摘要，不超过 1500 字，不要输出别的。',
    ].join('\n');
    const prompt = [
        '【已有的摘要】',
        previous?.trim() ? previous.trim() : '（还没有）',
        '',
        '【新的对话】',
        chunkText,
        '',
        '请把新的对话合进摘要，输出更新后的完整摘要。',
    ].join('\n');
    return { systemPrompt, prompt };
}

/**
 * 倒回 ST 时，把摘要放进 ST 自带摘要扩展认的位置：某条消息的 extra.memory。
 * ST 读摘要时会跳过最后一条消息，所以放在倒数第二条。
 * 聊天里已经有 ST 自己的摘要时不动它。
 * @param {object[]} arr 整个聊天文件（第 0 项是表头）
 * @returns {boolean} 有没有放进去
 */
export function putSummaryIntoChat(arr, text) {
    if (!text || !Array.isArray(arr)) return false;
    const messages = arr.slice(1);
    if (messages.some(m => m?.extra?.memory)) return false;
    const target = arr.length - 2;
    if (target < 1) return false;
    arr[target].extra = { ...(arr[target].extra ?? {}), memory: text };
    return true;
}
