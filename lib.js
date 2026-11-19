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
    const bytes = new TextEncoder().encode(String(text));
    // http 页面上浏览器不给 crypto.subtle，用下面纯 JS 的版本，结果一样
    const buf = globalThis.crypto?.subtle ? await crypto.subtle.digest('SHA-256', bytes) : sha256Js(bytes);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const SHA_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 纯 JS 的 SHA-256，只在没有 crypto.subtle 时用。 */
export function sha256Js(bytes) {
    const len = bytes.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const m = new Uint8Array(total);
    m.set(bytes);
    m[len] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000), false);
    dv.setUint32(total - 4, (len * 8) >>> 0, false);

    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + SHA_K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i], false);
    return out.buffer;
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

// ---------- 内存里的文件夹 ----------
// 和浏览器的 FileSystemDirectoryHandle 用法一样。读写不了真文件夹的时候（http 页面、Firefox、iPhone），
// 先在内存里搭一个魂器，再打包成一个 zip 下载；唤醒时把 zip 解回内存里的魂器。

const notFound = name => new DOMException(`找不到 ${name}`, 'NotFoundError');

class MemFile {
    kind = 'file';
    constructor(name) { this.name = name; this.blob = new Blob([]); }
    async getFile() { return this.blob; }
    async createWritable() {
        const parts = [];
        return {
            write: async d => { parts.push(d); },
            close: async () => { this.blob = new Blob(parts); },
        };
    }
}

export class MemDir {
    kind = 'directory';
    constructor(name = '') { this.name = name; this.dirs = new Map(); this.files = new Map(); }
    async getDirectoryHandle(name, { create = false } = {}) {
        let d = this.dirs.get(name);
        if (!d) {
            if (!create) throw notFound(name);
            d = new MemDir(name);
            this.dirs.set(name, d);
        }
        return d;
    }
    async getFileHandle(name, { create = false } = {}) {
        let f = this.files.get(name);
        if (!f) {
            if (!create) throw notFound(name);
            f = new MemFile(name);
            this.files.set(name, f);
        }
        return f;
    }
    async *entries() {
        yield* this.dirs.entries();
        yield* this.files.entries();
    }
}

/** 用户自己打包的 zip 可能多包了一层文件夹（比如"魂器/souls/..."），往下找到真正的魂器。 */
export async function findSoulRoot(dir) {
    if (await getDir(dir, SOULS)) return dir;
    const subdirs = [];
    for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory' && !name.startsWith('__MACOSX')) subdirs.push(h);
    }
    for (const sub of subdirs) {
        if (await getDir(sub, SOULS)) return sub;
    }
    return dir;
}

// ---------- zip ----------
// 只用到最基本的 zip：不加密、不分卷、单个文件小于 4GB。文字用 deflate 压缩，图片原样存。

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

async function pipeBytes(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

const deflateRaw = bytes => pipeBytes(bytes, new CompressionStream('deflate-raw'));
const inflateRaw = bytes => pipeBytes(bytes, new DecompressionStream('deflate-raw'));

function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
}

function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}

async function walk(dir, prefix, out) {
    for await (const [name, h] of dir.entries()) {
        const p = prefix + name;
        if (h.kind === 'directory') await walk(h, `${p}/`, out);
        else out.push({ path: p, bytes: new Uint8Array(await (await h.getFile()).arrayBuffer()) });
    }
}

/** 把一个文件夹（真的或内存里的）整个打包成 zip。 */
export async function zipDir(dir) {
    const files = [];
    await walk(dir, '', files);
    const enc = new TextEncoder();
    const now = new Date();
    const time = dosTime(now);
    const date = dosDate(now);
    const UTF8 = 0x0800; // 文件名用 UTF-8，中文名不乱码
    const body = [];
    const central = [];
    let offset = 0;

    for (const { path, bytes } of files) {
        const name = enc.encode(path);
        const crc = crc32(bytes);
        let method = 0;
        let data = bytes;
        if (bytes.length > 64) {
            const packed = await deflateRaw(bytes);
            if (packed.length < bytes.length) {
                method = 8;
                data = packed;
            }
        }

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, UTF8, true);
        local.setUint16(8, method, true);
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, bytes.length, true);
        local.setUint16(26, name.length, true);
        body.push(new Uint8Array(local.buffer), name, data);

        const entry = new DataView(new ArrayBuffer(46));
        entry.setUint32(0, 0x02014b50, true);
        entry.setUint16(4, 20, true);
        entry.setUint16(6, 20, true);
        entry.setUint16(8, UTF8, true);
        entry.setUint16(10, method, true);
        entry.setUint16(12, time, true);
        entry.setUint16(14, date, true);
        entry.setUint32(16, crc, true);
        entry.setUint32(20, data.length, true);
        entry.setUint32(24, bytes.length, true);
        entry.setUint16(28, name.length, true);
        entry.setUint32(42, offset, true);
        central.push(new Uint8Array(entry.buffer), name);

        offset += 30 + name.length + data.length;
    }

    const centralSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...body, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** 把 zip 解到内存里的文件夹。每个文件都核对校验码，坏了就报错，不悄悄放进去。 */
export async function unzipToDir(input) {
    const buf = new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input);
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('这不是一个 zip 文件');

    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const root = new MemDir('');
    const dec = new TextDecoder();

    for (let i = 0; i < count; i++) {
        if (v.getUint32(p, true) !== 0x02014b50) throw new Error('zip 文件坏了（目录读不出来）');
        const method = v.getUint16(p + 10, true);
        const crc = v.getUint32(p + 16, true);
        const size = v.getUint32(p + 20, true);
        const nameLen = v.getUint16(p + 28, true);
        const extraLen = v.getUint16(p + 30, true);
        const commentLen = v.getUint16(p + 32, true);
        const localAt = v.getUint32(p + 42, true);
        const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith('/')) continue;

        const segs = name.split('/').filter(Boolean);
        if (!segs.length || segs.includes('..')) continue;

        const start = localAt + 30 + v.getUint16(localAt + 26, true) + v.getUint16(localAt + 28, true);
        const raw = buf.subarray(start, start + size);
        let data;
        if (method === 0) data = raw;
        else if (method === 8) data = await inflateRaw(raw);
        else throw new Error(`不认识的压缩方式（${method}）：${name}`);
        if (crc32(data) !== crc) throw new Error(`zip 里的文件坏了：${name}`);

        let d = root;
        for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
        const w = await (await d.getFileHandle(segs.at(-1), { create: true })).createWritable();
        await w.write(data);
        await w.close();
    }
    return root;
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
