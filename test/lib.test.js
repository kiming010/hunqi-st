// 本地测试：用电脑上的真文件夹模拟魂器，跑一遍存档、摘要、读出来的逻辑。
// 运行：cd hunqi-st && npm test
// 想留下测试生成的魂器文件夹看看：HUNQI_TEST_DIR=/某个目录 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    countMessages, parseJsonl, saveSoul, listSouls, loadSoul,
    readSummary, writeSummary, chunkMessages, buildSummaryPrompt, putSummaryIntoChat, cleanText,
} from '../lib.js';

// ---------- 用 Node 的文件系统模拟浏览器的 FileSystemDirectoryHandle ----------

const notFound = () => new DOMException('not found', 'NotFoundError');

class NodeFile {
    kind = 'file';
    constructor(p) { this.p = p; this.name = path.basename(p); }
    async getFile() { return new Blob([await fs.readFile(this.p)]); }
    async createWritable() {
        const parts = [];
        const p = this.p;
        return {
            async write(d) { parts.push(d); },
            async close() {
                const buf = Buffer.from(await new Blob(parts).arrayBuffer());
                await fs.writeFile(`${p}.tmp`, buf);
                await fs.rename(`${p}.tmp`, p);
            },
        };
    }
}

class NodeDir {
    kind = 'directory';
    constructor(p) { this.p = p; this.name = path.basename(p); }
    async getDirectoryHandle(name, { create = false } = {}) {
        const q = path.join(this.p, name);
        try {
            await fs.stat(q);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            if (!create) throw notFound();
            await fs.mkdir(q);
        }
        return new NodeDir(q);
    }
    async getFileHandle(name, { create = false } = {}) {
        const q = path.join(this.p, name);
        try {
            await fs.stat(q);
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            if (!create) throw notFound();
            await fs.writeFile(q, '');
        }
        return new NodeFile(q);
    }
    async *entries() {
        for (const d of await fs.readdir(this.p, { withFileTypes: true })) {
            const q = path.join(this.p, d.name);
            yield [d.name, d.isDirectory() ? new NodeDir(q) : new NodeFile(q)];
        }
    }
}

async function freshRoot(label) {
    const base = process.env.HUNQI_TEST_DIR || os.tmpdir();
    await fs.mkdir(base, { recursive: true });
    const dir = await fs.mkdtemp(path.join(base, `hunqi-${label}-`));
    return new NodeDir(dir);
}

// ---------- 测试数据：ST 格式的聊天 ----------

function stChat(n, { integrity = 'abc' } = {}) {
    const lines = [JSON.stringify({ chat_metadata: { integrity }, user_name: 'unused', character_name: 'unused' })];
    for (let i = 0; i < n; i++) {
        const isUser = i % 2 === 1;
        lines.push(JSON.stringify({
            name: isUser ? '我' : '小雪',
            is_user: isUser,
            is_system: false,
            send_date: `2026-11-19T10:${String(i).padStart(2, '0')}:00`,
            mes: isUser ? `第 ${i} 句，我说的` : `第 ${i} 句，<b>小雪</b>说的`,
            extra: {},
        }));
    }
    return lines.join('\n');
}

const CARD = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: 'image/png' });
const SOUL = { soulId: 'soul-1', name: '小雪', avatar: '小雪.png', activeChat: '小雪 - 第一段' };

// ---------- 聊天原件 ----------

test('数消息：表头不算，空行不算', () => {
    assert.equal(countMessages(stChat(5)), 5);
    assert.equal(countMessages(stChat(5) + '\n\n'), 5);
    assert.equal(countMessages(''), 0);
});

test('解析 JSONL：坏行跳过', () => {
    assert.equal(parseJsonl(stChat(3) + '\n{坏行').length, 4);
});

// ---------- 存档 ----------

test('第一次存档：卡、聊天原件、清单都在，原件一个字节不改', async () => {
    const root = await freshRoot('first');
    const raw = stChat(4);
    const report = await saveSoul(root, { ...SOUL, card: CARD, chats: [{ file: '小雪 - 第一段.jsonl', raw }] });

    assert.equal(report.written, 1);
    assert.equal(report.messages, 4);
    const dir = path.join(root.p, 'souls', 'soul-1');
    assert.equal(await fs.readFile(path.join(dir, 'chats', '小雪 - 第一段.jsonl'), 'utf8'), raw);
    assert.equal((await fs.readFile(path.join(dir, 'card.png'))).length, 7);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'soul.json'), 'utf8'));
    assert.equal(manifest.name, '小雪');
    assert.equal(manifest.active_chat, '小雪 - 第一段');
    assert.equal(manifest.chats['小雪 - 第一段.jsonl'].messages, 4);
    assert.ok(await fs.stat(path.join(root.p, 'hunqi.json')));
});

test('内容没变：不重写', async () => {
    const root = await freshRoot('same');
    const chats = [{ file: 'a.jsonl', raw: stChat(3) }];
    await saveSoul(root, { ...SOUL, chats });
    const report = await saveSoul(root, { ...SOUL, chats });
    assert.equal(report.unchanged, 1);
    assert.equal(report.written, 0);
});

test('聊天变长：直接覆盖，不留旧版', async () => {
    const root = await freshRoot('longer');
    await saveSoul(root, { ...SOUL, chats: [{ file: 'a.jsonl', raw: stChat(3) }] });
    const report = await saveSoul(root, { ...SOUL, chats: [{ file: 'a.jsonl', raw: stChat(6) }] });
    assert.equal(report.written, 1);
    assert.equal(report.kept.length, 0);
    await assert.rejects(fs.stat(path.join(root.p, 'souls', 'soul-1', 'chats', '_old')));
});

test('酒馆里删了消息：旧版本先留进 _old，再覆盖', async () => {
    const root = await freshRoot('shorter');
    const longRaw = stChat(10);
    await saveSoul(root, { ...SOUL, chats: [{ file: 'a.jsonl', raw: longRaw }] });
    const report = await saveSoul(root, { ...SOUL, chats: [{ file: 'a.jsonl', raw: stChat(7) }] });

    assert.deepEqual(report.kept, [{ file: 'a.jsonl', lost: 3 }]);
    const oldDir = path.join(root.p, 'souls', 'soul-1', 'chats', '_old');
    const kept = await fs.readdir(oldDir);
    assert.equal(kept.length, 1);
    assert.equal(await fs.readFile(path.join(oldDir, kept[0]), 'utf8'), longRaw);
    const manifest = JSON.parse(await fs.readFile(path.join(root.p, 'souls', 'soul-1', 'soul.json'), 'utf8'));
    assert.equal(manifest.kept_old.length, 1);
    assert.equal(manifest.kept_old[0].messages, 10);
});

test('酒馆里整段聊天没了：魂器里的原样留着', async () => {
    const root = await freshRoot('gone');
    await saveSoul(root, { ...SOUL, chats: [{ file: 'a.jsonl', raw: stChat(3) }, { file: 'b.jsonl', raw: stChat(2) }] });
    const report = await saveSoul(root, { ...SOUL, chats: [{ file: 'a.jsonl', raw: stChat(3) }] });
    assert.deepEqual(report.onlyInSoul, ['b.jsonl']);
    const soul = await loadSoul(root, 'soul-1');
    assert.deepEqual(soul.chats.map(c => c.file).sort(), ['a.jsonl', 'b.jsonl']);
});

// ---------- 读出来 ----------

test('列出魂器里的 TA，再整个读出来', async () => {
    const root = await freshRoot('load');
    const raw = stChat(4);
    await saveSoul(root, { ...SOUL, card: CARD, chats: [{ file: 'a.jsonl', raw }] });
    await saveSoul(root, { soulId: 'soul-2', name: '阿哲', avatar: '阿哲.png', chats: [{ file: 'x.jsonl', raw: stChat(2) }] });
    await writeSummary(root, 'soul-1', 'a.jsonl', { text: '我们认识了。', covered: 4 });

    const souls = await listSouls(root);
    assert.equal(souls.length, 2);
    assert.deepEqual(souls.map(s => s.name).sort(), ['小雪', '阿哲']);

    const soul = await loadSoul(root, 'soul-1');
    assert.equal(soul.manifest.name, '小雪');
    assert.equal(soul.chats[0].raw, raw);
    assert.equal((await soul.card.arrayBuffer()).byteLength, 7);
    assert.equal(soul.summaries['a.jsonl'].text, '我们认识了。');
});

test('空文件夹：没有 TA，不报错', async () => {
    const root = await freshRoot('empty');
    assert.deepEqual(await listSouls(root), []);
    assert.equal(await readSummary(root, 'nobody', 'a.jsonl'), null);
});

// ---------- 摘要 ----------

test('切段：跳过系统消息，去掉 HTML，按字数切，从上次整理到的地方开始', () => {
    const messages = parseJsonl(stChat(6)).slice(1);
    messages[2].is_system = true;
    const all = chunkMessages(messages, 0, 100000);
    assert.equal(all.length, 1);
    assert.equal(all[0].to, 6);
    assert.ok(!all[0].text.includes('第 2 句'));
    assert.ok(!all[0].text.includes('<b>'));

    const small = chunkMessages(messages, 0, 30);
    assert.ok(small.length > 1);
    assert.equal(small.at(-1).to, 6);
    for (let i = 1; i < small.length; i++) assert.equal(small[i].from, small[i - 1].to);

    assert.equal(chunkMessages(messages, 4, 100000)[0].from, 4);
    assert.deepEqual(chunkMessages(messages, 6, 100000), []);
});

test('摘要提示词：带上旧摘要和新对话', () => {
    const { systemPrompt, prompt } = buildSummaryPrompt('旧的', '小雪：你好', '小雪', '我');
    assert.ok(systemPrompt.includes('小雪'));
    assert.ok(prompt.includes('旧的'));
    assert.ok(prompt.includes('小雪：你好'));
    assert.ok(buildSummaryPrompt('', 'x', 'a', 'b').prompt.includes('（还没有）'));
});

test('倒回 ST：摘要放进倒数第二条消息的 extra.memory', () => {
    const arr = parseJsonl(stChat(4));
    assert.equal(putSummaryIntoChat(arr, '摘要'), true);
    assert.equal(arr[arr.length - 2].extra.memory, '摘要');
    assert.equal(arr[arr.length - 1].extra.memory, undefined);
});

test('倒回 ST：聊天里已经有 ST 自己的摘要，就不动', () => {
    const arr = parseJsonl(stChat(4));
    arr[2].extra.memory = 'ST 原来的';
    assert.equal(putSummaryIntoChat(arr, '摘要'), false);
    assert.equal(arr[arr.length - 2].extra.memory, undefined);
});

test('倒回 ST：只有一条消息时放不下', () => {
    assert.equal(putSummaryIntoChat(parseJsonl(stChat(1)), '摘要'), false);
    assert.equal(putSummaryIntoChat(parseJsonl(stChat(4)), ''), false);
});

test('cleanText：去标签、压空行', () => {
    assert.equal(cleanText('<div>你好</div>\n\n\n\n再见'), '你好\n\n再见');
});
