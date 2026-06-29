import assert from 'node:assert/strict';
import test from 'node:test';
import {
    clearAllSummaries,
    getSummaries,
    getSummaryStatus,
    initializeSummaryManager,
    migrateLegacySummaries,
    recordAiReply,
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
    const bookName = 'Chat_Book_summary-chat';
    const context = {
        chatId: 'summary-chat',
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
        async executeSlashCommands(command) {
            calls.push(command);
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

test('five AI replies trigger one summary covering all messages since the previous summary', async () => {
    const context = createContext(dialoguePairs(5));
    const prompts = [];

    for (const index of [1, 3, 5, 7]) {
        await recordAiReply(context, index, 'normal');
        const pending = await summarizePendingMessages({ context: {} }, context, {
            getCurrentContext: () => context,
            async generateSummary() {
                throw new Error('must not summarize before the fifth AI reply');
            },
        });
        assert.equal(pending.created, 0);
    }

    await recordAiReply(context, 9, 'normal');
    const result = await summarizePendingMessages({ context: { summaryMaxTokens: 321 } }, context, {
        endMessageIndex: 9,
        getCurrentContext: () => context,
        async generateSummary(prompt, maxTokens) {
            prompts.push({ prompt, maxTokens });
            return 'first five replies summary';
        },
    });

    assert.deepEqual(result, { created: 1, pendingReplies: 0, start: 0, end: 9 });
    assert.match(prompts[0].prompt, /dialogue 0/);
    assert.match(prompts[0].prompt, /dialogue 9/);
    assert.equal(prompts[0].maxTokens, 321);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].aiRepliesSinceLastSummary, 0);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, 9);

    const data = context.lorebooks.get(context.chatMetadata.world_info);
    const entry = Object.values(data.entries)[0];
    assert.equal(entry.key[0], `${SUMMARY_KEY_PREFIX}第0-9楼`);
    assert.equal(entry.constant, true);
    assert.equal(entry.content, 'first five replies summary');
    assert.ok(context.calls.some(command => command === '/getchatbook'));
    assert.ok(context.calls.some(command => command.startsWith('/createentry ')));
    assert.ok(context.calls.some(command => command.includes('field=constant')));
});

test('user messages, first messages, and duplicate reply events do not increment the counter', async () => {
    const context = createContext(dialoguePairs(1));
    assert.equal((await recordAiReply(context, 0, 'normal')).counted, false);
    assert.equal((await recordAiReply(context, 1, 'first_message')).counted, false);
    assert.equal((await recordAiReply(context, 1, 'normal')).count, 1);
    assert.equal((await recordAiReply(context, 1, 'normal')).duplicate, true);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].aiRepliesSinceLastSummary, 1);
    assert.ok(context.metadataSaves >= 1, 'reply counter is persisted in chatMetadata');
});

test('the next summary starts immediately after the previous summarized range', async () => {
    const context = createContext(dialoguePairs(5));
    for (const index of [1, 3, 5, 7, 9]) await recordAiReply(context, index, 'normal');
    await summarizePendingMessages({ context: { summaryInterval: 5 } }, context, {
        endMessageIndex: 9,
        getCurrentContext: () => context,
        generateSummary: async () => 'first batch',
    });

    context.chat.push(...dialoguePairs(5, 10));
    for (const index of [11, 13, 15, 17, 19]) await recordAiReply(context, index, 'normal');
    const result = await summarizePendingMessages({ context: { summaryInterval: 5 } }, context, {
        endMessageIndex: 19,
        getCurrentContext: () => context,
        generateSummary: async prompt => {
            assert.doesNotMatch(prompt, /dialogue 9/);
            assert.match(prompt, /dialogue 10/);
            assert.match(prompt, /dialogue 19/);
            return 'second batch';
        },
    });
    assert.equal(result.start, 10);
    assert.deepEqual((await getSummaries(context)).map(item => item.summary), ['first batch', 'second batch']);
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

test('status counts prefixed entries and clear preserves ordinary lorebook entries', async () => {
    const context = createContext(dialoguePairs(1));
    context.chatMetadata.world_info = 'Chat_Book_summary-chat';
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        aiRepliesSinceLastSummary: 2,
        lastSummarizedMessageIndex: 1,
        entries: [{ uid: '0', start: 0, end: 1, createdAt: '2026-01-01T00:00:00.000Z' }],
    };
    context.lorebooks.set('Chat_Book_summary-chat', { entries: {
        0: { uid: 0, key: [`${SUMMARY_KEY_PREFIX}第0-1楼`], content: 'summary' },
        9: { uid: 9, key: ['ordinary'], content: 'keep me' },
    } });

    const status = await getSummaryStatus(context);
    assert.equal(status.entryCount, 1);
    assert.equal(status.pendingAiReplies, 2);
    assert.equal(await clearAllSummaries(context), 1);
    assert.equal(context.lorebooks.get('Chat_Book_summary-chat').entries[9].content, 'keep me');
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].entries.length, 0);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].aiRepliesSinceLastSummary, 0);
});

test('MESSAGE_RECEIVED counts rendered AI replies and triggers on the fifth one', async (testContext) => {
    const context = createContext(dialoguePairs(5));
    const handlers = new Map();
    const calls = [];
    context.eventTypes = {
        MESSAGE_RECEIVED: 'received',
        CHARACTER_MESSAGE_RENDERED: 'rendered',
        CHAT_CHANGED: 'changed',
    };
    context.eventSource = { on: (event, handler) => handlers.set(event, handler) };
    context.generateQuietPrompt = async (...args) => {
        calls.push(args);
        return 'quiet summary';
    };

    const originalSillyTavern = globalThis.SillyTavern;
    testContext.after(() => globalThis.SillyTavern = originalSillyTavern);
    globalThis.SillyTavern = { getContext: () => context };
    initializeSummaryManager({ context: { summaryInterval: 5, summaryMaxTokens: 275 } }, context);

    for (const index of [1, 3, 5, 7, 9]) {
        handlers.get('received')(index, 'normal');
        handlers.get('rendered')(index, 'normal');
    }
    await new Promise(resolve => setTimeout(resolve, 35));

    assert.equal(calls.length, 1);
    assert.equal(calls[0][5], 275);
    assert.equal((await getSummaries(context))[0].summary, 'quiet summary');
});
