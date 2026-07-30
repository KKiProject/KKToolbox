import assert from 'node:assert/strict';
import test from 'node:test';
import {
    clearAllSummaries,
    getSummaries,
    getSummaryStatus,
    initializeSummaryManager,
    migrateLegacySummaries,
    parseSummaryEvents,
    SUMMARY_KEY_PREFIX,
    SUMMARY_STATE_KEY,
    summarizePendingMessages,
} from '../summary-manager.js';

function unescapeSlashValue(value) {
    return value.replace(/\\([\\"{}|])/g, '$1');
}

function quotedValues(command) {
    return [...command.matchAll(/"((?:\\.|[^"])*)"/g)].map(match => unescapeSlashValue(match[1]));
}

function createContext(messages = []) {
    let metadataSaves = 0;
    const calls = [];
    const lorebooks = new Map();
    const bookName = '金钰琳-自动总结';
    const additionalBooks = [];
    const context = {
        chatId: 'summary-chat',
        characterId: 0,
        characters: [{ name: '金钰琳', avatar: 'jin-yulin.png', data: { extensions: { world: '角色主世界书' } } }],
        chat: structuredClone(messages),
        chatMetadata: {},
        async saveMetadata() {
            metadataSaves++;
        },
        async loadWorldInfo(name) {
            return lorebooks.has(name) ? structuredClone(lorebooks.get(name)) : null;
        },
        async saveWorldInfo(name, data) {
            lorebooks.set(name, structuredClone(data));
        },
        async createNewWorldInfo(name) {
            lorebooks.set(name, { entries: {} });
        },
        async bindAdditionalWorldInfoBook(name) {
            if (!additionalBooks.includes(name)) additionalBooks.push(name);
        },
        async executeSlashCommands(command) {
            calls.push(command);
            if (command.startsWith('/hide ')) {
                const messageIndex = Number(command.slice('/hide '.length));
                if (context.chat[messageIndex]) context.chat[messageIndex].is_system = true;
                return { pipe: '' };
            }
            if (command === '/getchatbook') {
                context.chatMetadata.world_info = bookName;
                lorebooks.set(bookName, lorebooks.get(bookName) ?? { entries: {} });
                return { pipe: bookName };
            }

            const values = quotedValues(command);
            const file = values[0];
            const data = lorebooks.get(file);
            if (command.startsWith('/findentry ')) {
                const key = values[1];
                const found = Object.values(data?.entries ?? {}).find(entry => entry.key?.includes(key));
                return { pipe: found ? String(found.uid) : '' };
            }
            if (command.startsWith('/createentry ')) {
                const [, key, content] = values;
                const ids = Object.keys(data.entries).map(Number);
                const uid = ids.length ? Math.max(...ids) + 1 : 0;
                data.entries[uid] = {
                    uid,
                    key: [key],
                    content,
                    constant: false,
                    position: 0,
                    order: 100,
                    disable: false,
                };
                return { pipe: String(uid) };
            }
            if (command.startsWith('/setentryfield ')) {
                const [, uid, value] = values;
                const field = command.match(/\sfield=([^\s]+)/)?.[1];
                const entry = data.entries[uid];
                if (field === 'key') entry.key = [value];
                else if (typeof entry[field] === 'boolean') entry[field] = value === 'true';
                else if (typeof entry[field] === 'number') entry[field] = Number(value);
                else entry[field] = value;
                return { pipe: '' };
            }
            if (command.startsWith('/getentryfield ')) {
                const [, uid] = values;
                return { pipe: data?.entries?.[uid]?.content ?? '' };
            }
            throw new Error(`Unexpected slash command: ${command}`);
        },
        get metadataSaves() {
            return metadataSaves;
        },
        get calls() {
            return calls;
        },
        get lorebooks() {
            return lorebooks;
        },
        get additionalBooks() {
            return additionalBooks;
        },
    };
    return context;
}

function dialoguePairs(count, offset = 0) {
    return Array.from({ length: count * 2 }, (_, localIndex) => {
        const index = offset + localIndex;
        return {
            name: index % 2 ? '角色' : '用户',
            is_user: index % 2 === 0,
            mes: `dialogue ${index}`,
            send_date: `date-${index}`,
        };
    });
}

test('a summary starts only after one full batch has left the recent-message window', async () => {
    const context = createContext(dialoguePairs(15));
    const prompts = [];
    context.chat.pop();
    const pending = await summarizePendingMessages({ context: { recentMessages: 20, summaryBatchSize: 10 } }, context, {
        getCurrentContext: () => context,
        generateSummary: async () => { throw new Error('only nine floors have left the window'); },
    });
    assert.deepEqual(pending, { created: 0, pendingFloors: 9 });

    context.chat.push(dialoguePairs(15).at(-1));
    context.chat[3].is_system = true;
    const result = await summarizePendingMessages({ context: { recentMessages: 20, summaryBatchSize: 10 } }, context, {
        getCurrentContext: () => context,
        async generateSummary(prompt, maxTokens) {
            prompts.push({ prompt, maxTokens });
            return [
                '[事件1]',
                '重要度：4',
                '时间：黄昏时分',
                '涉及角色：A、B',
                '地点：王都北区酒馆',
                '事件概述：A与B发生冲突，B亮出身份令牌，A决定暂时退让。',
                '',
                '[事件2]',
                '重要度：2',
                '时间：入夜后',
                '涉及角色：A、C',
                '地点：酒馆后巷',
                '事件概述：A暗中通知C留意B的行动。',
            ].join('\n');
        },
    });

    assert.deepEqual(result, { created: 1, pendingFloors: 0, start: 0, end: 9 });
    assert.match(prompts[0].prompt, /\[第 1 楼\].*dialogue 0/);
    assert.match(prompts[0].prompt, /\[第 10 楼\].*dialogue 9/);
    assert.match(prompts[0].prompt, /将以下10楼的内容提取为1-3个关键事件，按重要度从高到低排列/);
    assert.match(prompts[0].prompt, /如果这段对话全是日常闲聊/);
    assert.equal(prompts[0].maxTokens, 1200);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, 9);

    const data = context.lorebooks.get('金钰琳-自动总结');
    const entries = Object.values(data.entries);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key[0], `${SUMMARY_KEY_PREFIX}[第1-10楼]`);
    assert.equal(entries[0].constant, true);
    assert.equal(entries[0].content, [
        '[★★★★☆]',
        '⏰ 黄昏时分',
        ' A、B',
        ' 王都北区酒馆',
        ' A与B发生冲突，B亮出身份令牌，A决定暂时退让。',
        '',
        '[★★☆☆☆]',
        '⏰ 入夜后',
        ' A、C',
        ' 酒馆后巷',
        ' A暗中通知C留意B的行动。',
    ].join('\n'));
    assert.deepEqual(context.additionalBooks, ['金钰琳-自动总结']);
    assert.equal(context.characters[0].data.extensions.world, '角色主世界书');
    assert.ok(context.calls.some(command => command.startsWith('/createentry ')));
    assert.ok(context.calls.some(command => command.includes('field=constant')));
    assert.ok(context.calls.some(command => command.includes('field=position') && command.endsWith('"4"')));
    assert.ok(context.calls.some(command => command.includes('field=depth') && command.endsWith('"4"')));
    assert.deepEqual(
        context.calls.filter(command => command.startsWith('/hide ')),
        [0, 1, 2, 4, 5, 6, 7, 8, 9].map(index => `/hide ${index}`),
    );
    assert.equal(context.chat.slice(0, 10).every(message => message.is_system === true), true);
});

test('event parser keeps at most three events and limits each overview to 150 characters', () => {
    const longOverview = '细'.repeat(180);
    const output = Array.from({ length: 4 }, (_, index) => [
        `[事件${index + 1}]`,
        `重要度：${index + 2}`,
        '时间：深夜',
        '涉及角色：甲、乙',
        '地点：旧城区',
        `事件概述：${longOverview}`,
    ].join('\n')).join('\n\n');
    const events = parseSummaryEvents(output);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(event => event.importance), [2, 3, 4]);
    assert.equal(Array.from(events[0].overview).length, 150);
});

test('the next summary starts immediately after the previous summarized range', async () => {
    const context = createContext(dialoguePairs(15));
    await summarizePendingMessages({ context: { recentMessages: 20, summaryBatchSize: 10 } }, context, {
        getCurrentContext: () => context,
        generateSummary: async () => '[事件1]\n重要度：3\n时间：清晨\n涉及角色：A\n地点：庭院\n事件概述：A发现了新的线索。',
    });

    context.chat.push(...dialoguePairs(5, 30));
    const result = await summarizePendingMessages({ context: { recentMessages: 20, summaryBatchSize: 10 } }, context, {
        getCurrentContext: () => context,
        generateSummary: async prompt => {
            assert.doesNotMatch(prompt, /\[第 10 楼\].*dialogue 9/);
            assert.match(prompt, /\[第 11 楼\].*dialogue 10/);
            assert.match(prompt, /\[第 20 楼\].*dialogue 19/);
            return '[事件1]\n重要度：5\n时间：当晚\n涉及角色：A、B\n地点：城门\n事件概述：A与B作出改变主线走向的决定。';
        },
    });
    assert.equal(result.start, 10);
    const summaries = (await getSummaries(context)).map(item => item.summary);
    assert.match(summaries[0], /A发现了新的线索/);
    assert.match(summaries[1], /A与B作出改变主线走向的决定/);
});

test('legacy per-event entries for the same floor range are merged', async () => {
    const context = createContext(dialoguePairs(15));
    const bookName = '金钰琳-自动总结';
    context.chatMetadata.world_info = bookName;
    context.lorebooks.set(bookName, { entries: {
        4: { uid: 4, key: [`${SUMMARY_KEY_PREFIX}[★★★★★][第0-9楼]`], content: 'old high', constant: true },
        5: { uid: 5, key: [`${SUMMARY_KEY_PREFIX}[★★☆☆☆][第0-9楼]`], content: 'old low', constant: true },
        9: { uid: 9, key: ['ordinary'], content: 'keep me', constant: false },
    } });

    await migrateLegacySummaries(context);
    const entries = Object.values(context.lorebooks.get(bookName).entries);
    assert.equal(entries.length, 2);
    assert.equal(entries.filter(entry => entry.key[0].startsWith(SUMMARY_KEY_PREFIX)).length, 1);
    assert.equal(entries.find(entry => entry.uid === 4).key[0], `${SUMMARY_KEY_PREFIX}[第1-10楼]`);
    assert.match(entries.find(entry => entry.uid === 4).content, /^\[★★★★★\]\nold high\n\n\[★★☆☆☆\]\nold low$/);
    assert.equal(entries.find(entry => entry.uid === 9).content, 'keep me');
});

test('legacy metadata summaries migrate through slash commands and are removed from chatMetadata', async () => {
    const context = createContext(dialoguePairs(2));
    context.chatMetadata.memory_augment_summaries = {
        '0-2': { start: 0, end: 2, summary: 'legacy summary', createdAt: '2026-01-01T00:00:00.000Z' },
    };
    assert.equal(await migrateLegacySummaries(context), 1);
    assert.equal('memory_augment_summaries' in context.chatMetadata, false);
    assert.equal((await getSummaries(context))[0].summary, 'legacy summary');
    assert.ok(context.calls.some(command => command.startsWith('/findentry ')));
});

test('existing unstructured KKT lorebook entries remain readable without changing their key', async () => {
    const context = createContext(dialoguePairs(2));
    const bookName = '金钰琳-自动总结';
    const oldKey = `${SUMMARY_KEY_PREFIX}第0-2楼`;
    context.chatMetadata.world_info = bookName;
    context.lorebooks.set(bookName, { entries: {
        7: { uid: 7, key: [oldKey], content: '旧格式的一段笼统摘要', constant: true },
    } });

    assert.equal(await migrateLegacySummaries(context), 1);
    assert.equal(context.lorebooks.get(bookName).entries[7].key[0], oldKey);
    assert.equal((await getSummaries(context))[0].summary, '旧格式的一段笼统摘要');
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, 2);
});

test('status counts prefixed entries and clear preserves ordinary lorebook entries', async () => {
    const context = createContext(dialoguePairs(1));
    context.chatMetadata.world_info = 'unused-chat-book';
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        lastSummarizedMessageIndex: 1,
        entries: [{ uid: '0', start: 0, end: 1, createdAt: '2026-01-01T00:00:00.000Z' }],
    };
    context.lorebooks.set('金钰琳-自动总结', { entries: {
        0: { uid: 0, key: [`${SUMMARY_KEY_PREFIX}第0-1楼`], content: '旧格式摘要，没有星级和结构化字段' },
        9: { uid: 9, key: ['ordinary'], content: 'keep me' },
    } });

    const status = await getSummaryStatus(context);
    assert.equal(status.entryCount, 1);
    assert.equal(await clearAllSummaries(context), 1);
    assert.equal(context.lorebooks.get('金钰琳-自动总结').entries[9].content, 'keep me');
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].entries.length, 0);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, -1);
});

test('MESSAGE_SENT checks window overflow while swipe events remain ignored', async (testContext) => {
    const context = createContext(dialoguePairs(15));
    const handlers = new Map();
    const calls = [];
    context.eventTypes = {
        MESSAGE_RECEIVED: 'received',
        MESSAGE_SENT: 'sent',
        CHAT_CHANGED: 'changed',
    };
    context.eventSource = { on: (event, handler) => handlers.set(event, handler) };
    context.generateQuietPrompt = async (...args) => {
        calls.push(args);
        return '[事件1]\n重要度：1\n时间：午后\n涉及角色：A\n地点：家中\n事件概述：A进行了一段普通的日常交谈。';
    };

    const originalSillyTavern = globalThis.SillyTavern;
    testContext.after(() => globalThis.SillyTavern = originalSillyTavern);
    globalThis.SillyTavern = { getContext: () => context };
    initializeSummaryManager({ context: { recentMessages: 20, summaryBatchSize: 10 } }, context);

    assert.equal(handlers.has('received'), false, 'swipe/regenerate events must not trigger summaries');
    handlers.get('sent')(28);
    await new Promise(resolve => setTimeout(resolve, 35));

    assert.equal(calls.length, 1);
    assert.equal(calls[0][5], 1200);
    assert.match((await getSummaries(context))[0].summary, /普通的日常交谈/);
});
