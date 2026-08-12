import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildSummaryBookName,
    clearAllSummaries,
    buildSummaryPrompt,
    getSummaries,
    getSummaryStatus,
    initializeSummaryManager,
    isMalformedSummaryContent,
    isUnusableSummaryOutput,
    migrateLegacySummaries,
    parseSummaryEvents,
    repairMalformedSummaries,
    regenerateAllSummaries,
    regenerateSummaryRange,
    SUMMARY_KEY_PREFIX,
    SUMMARY_STATE_KEY,
    summarizePendingMessages,
    updateHistoricalOverview,
} from '../summary-manager.js';

test('summary prompt treats floor batches as processing windows and uses saved anchors', () => {
    const prompt = buildSummaryPrompt([
        { name: '角色', is_user: false, mes: '三天前，她曾在花园见过候补。' },
    ], 12, 12, [{
        messageId: 12,
        sceneTime: '王历100年春三月初一',
        mainlineTime: '王历100年春三月初一',
        sceneAnchorId: 't12-mainline',
        mainlineAnchorId: 't12-mainline',
        segments: [{ startQuote: '三天前', anchorLabel: '王历100年二月廿七', mode: 'mention' }],
    }]);
    assert.match(prompt, /只是本次处理窗口，不是事件边界/);
    assert.match(prompt, /通常提取2-4个关键事件/);
    assert.match(prompt, /绝对不超过5个/);
    assert.match(prompt, /原文细节会由 RAG 另行召回/);
    assert.match(prompt, /场景时间=王历100年春三月初一/);
    assert.match(prompt, /从“三天前”开始｜片段时间=王历100年二月廿七/);
    assert.match(prompt, /“昨天、三天前、十年前”等词只相对于它所在的场景时间有效/);
    assert.match(prompt, /时间字段不是自由概括/);
    assert.match(prompt, /禁止把“2025-01-28 23:30:00”改写成“除夕夜”/);
});

test('a summary retries when it paraphrases an exact saved time anchor', async () => {
    const context = createContext(dialoguePairs(15));
    context.chatMetadata.memory_augment_story_timeline = {
        version: 1,
        anchors: {
            't1-initial': {
                id: 't1-initial',
                label: '2025-02-04 15:00:00',
                mode: 'mainline',
                relativeTo: '',
                relation: '',
                sourceMessageId: 1,
            },
        },
        messageStates: {
            1: {
                sceneAnchorId: 't1-initial',
                mainlineAnchorId: 't1-initial',
                transition: 'unchanged',
                sourceHash: '',
            },
        },
        messageSegments: {},
    };
    let calls = 0;
    const result = await summarizePendingMessages(
        { context: { recentMessages: 20, summaryBatchSize: 10 } },
        context,
        {
            getCurrentContext: () => context,
            generateSummary: async () => {
                calls++;
                return calls === 1
                    ? '[事件1]\n重要度：4\n事件概述：两人确认了彼此的关系。\n时间：除夕夜至零点\n地点：室内\n涉及角色：用户，角色'
                    : '[事件1]\n重要度：4\n事件概述：两人确认了彼此的关系。\n时间：2025-02-04 15:00:00\n地点：室内\n涉及角色：用户，角色';
            },
        },
    );

    assert.equal(calls, 2);
    assert.equal(result.created, 1);
    const entries = Object.values(context.lorebooks.get(context.summaryBookName).entries);
    assert.match(entries[0].content, /固定历史时间锚点：2025-02-04 15:00:00/);
    assert.doesNotMatch(entries[0].content, /除夕夜至零点/);
});

test('summary lorebooks keep the character name and use a simple increasing sequence', () => {
    const first = buildSummaryBookName('金钰琳', 1);
    const repeated = buildSummaryBookName('金钰琳', 1);
    const second = buildSummaryBookName('金钰琳', 2);
    assert.equal(first, '金钰琳-自动总结1');
    assert.equal(repeated, first);
    assert.equal(second, '金钰琳-自动总结2');
});

function unescapeSlashValue(value) {
    return value.replace(/\\([\\"{}|])/g, '$1');
}

function quotedValues(command) {
    return [...command.matchAll(/"((?:\\.|[^"])*)"/g)].map(match => unescapeSlashValue(match[1]));
}

function createContext(messages = []) {
    let metadataSaves = 0;
    let worldInfoLoads = 0;
    let worldInfoListUpdates = 0;
    let additionalBindCalls = 0;
    const calls = [];
    const reloadedWorldInfoBooks = [];
    const lorebooks = new Map();
    const bookName = buildSummaryBookName('金钰琳', 1);
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
            worldInfoLoads++;
            return lorebooks.has(name) ? structuredClone(lorebooks.get(name)) : null;
        },
        async getWorldInfoBookNames() {
            return [...lorebooks.keys()];
        },
        async saveWorldInfo(name, data) {
            lorebooks.set(name, structuredClone(data));
        },
        async createNewWorldInfo(name) {
            lorebooks.set(name, { entries: {} });
        },
        async updateWorldInfoList() {
            worldInfoListUpdates++;
        },
        reloadWorldInfoEditor(name) {
            reloadedWorldInfoBooks.push(name);
        },
        createWorldInfoEntry(_name, data) {
            const ids = Object.keys(data.entries).map(Number);
            const uid = ids.length ? Math.max(...ids) + 1 : 0;
            const entry = {
                uid,
                key: [],
                comment: '',
                content: '',
                constant: false,
                position: 0,
                order: 100,
                disable: false,
            };
            data.entries[uid] = entry;
            return entry;
        },
        async bindAdditionalWorldInfoBook(name) {
            additionalBindCalls++;
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
        get worldInfoLoads() {
            return worldInfoLoads;
        },
        get worldInfoListUpdates() {
            return worldInfoListUpdates;
        },
        get reloadedWorldInfoBooks() {
            return reloadedWorldInfoBooks;
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
        get additionalBindCalls() {
            return additionalBindCalls;
        },
        get summaryBookName() {
            return bookName;
        },
    };
    return context;
}

test('a stale summary name is recreated from the real lorebook list before it is rebound', async () => {
    const context = createContext();
    const staleBookName = context.summaryBookName;
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        lastSummarizedMessageIndex: -1,
        entries: [],
        overviewGroups: [],
        bookName: staleBookName,
        migrationVersion: 2,
    };
    // SillyTavern returns an empty dummy object when a requested lorebook file
    // is missing, so loadWorldInfo alone cannot prove that the file exists.
    context.loadWorldInfo = async () => ({ entries: {} });

    await migrateLegacySummaries(context);

    assert.equal(context.lorebooks.has(staleBookName), true);
    assert.deepEqual(context.additionalBooks, [staleBookName]);
});

test('manually deleting the active summary book drops stale UIDs and backfills from the first floor', async () => {
    const context = createContext(dialoguePairs(15));
    const bookName = context.summaryBookName;
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        lastSummarizedMessageIndex: 9,
        entries: [{ uid: '8', start: 0, end: 9, bookName, createdAt: '' }],
        overviewGroups: [{ key: '0-9', start: 0, end: 9, sourceHash: 'old' }],
        bookName,
        migrationVersion: 2,
    };
    context.lorebooks.set(bookName, { entries: {
        8: { uid: 8, key: [`${SUMMARY_KEY_PREFIX}[第1-10楼]`], content: '已经被用户删除的旧摘要。' },
    } });
    context.lorebooks.delete(bookName);

    const result = await summarizePendingMessages(
        { context: { recentMessages: 20, summaryBatchSize: 10 } },
        context,
        {
            getCurrentContext: () => context,
            generateSummary: async () => '[事件1]\n重要度：3\n事件概述：删除世界书后从第一批原文重新生成摘要。\n时间：未明确\n地点：室内\n涉及角色：用户，角色',
        },
    );

    assert.equal(result.created, 1);
    assert.equal(result.start, 0);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].entries.length, 1);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].entries[0].start, 0);
    assert.equal(context.calls.some(command => command.startsWith('/getentryfield ')), false);
});

test('one-click regeneration can summarize already hidden floors from the beginning', async () => {
    const context = createContext(dialoguePairs(20));
    const bookName = context.summaryBookName;
    for (let index = 0; index < 10; index++) context.chat[index].is_system = true;
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        lastSummarizedMessageIndex: 9,
        entries: [{ uid: '0', start: 0, end: 9, bookName, createdAt: '' }],
        overviewGroups: [],
        bookName,
        migrationVersion: 2,
    };
    context.lorebooks.set(bookName, { entries: {
        0: { uid: 0, key: [`${SUMMARY_KEY_PREFIX}[第1-10楼]`], content: '准备被重新生成的旧摘要。' },
    } });

    const progress = [];
    const result = await regenerateAllSummaries(
        { context: { recentMessages: 20, summaryBatchSize: 10 } },
        context,
        {
            getCurrentContext: () => context,
            onProgress: update => progress.push(update),
            generateSummary: async prompt => {
                assert.match(prompt, /dialogue/);
                return '[事件1]\n重要度：3\n事件概述：隐藏楼层的原文仍然能够正常参与重新总结。\n时间：未明确\n地点：室内\n涉及角色：用户，角色';
            },
        },
    );

    assert.equal(result.removed, 1);
    assert.equal(result.created, 2);
    assert.equal(result.discarded, undefined);
    assert.deepEqual(progress.map(update => update.phase), [
        'cleared', 'generating', 'saved', 'generating', 'saved',
    ]);
    assert.deepEqual(
        progress.filter(update => update.phase === 'generating').map(update => [update.start, update.end]),
        [[0, 9], [10, 19]],
    );
    assert.deepEqual(
        context.chatMetadata[SUMMARY_STATE_KEY].entries.map(entry => [entry.start, entry.end]),
        [[0, 9], [10, 19]],
    );
});

test('range regeneration rewrites only summary entries intersecting the requested floors', async () => {
    const context = createContext(dialoguePairs(25));
    const bookName = context.summaryBookName;
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        lastSummarizedMessageIndex: 29,
        entries: [
            { uid: '0', start: 0, end: 9, bookName, createdAt: '' },
            { uid: '1', start: 10, end: 19, bookName, createdAt: '' },
            { uid: '2', start: 20, end: 29, bookName, createdAt: '' },
        ],
        overviewGroups: [],
        bookName,
        migrationVersion: 2,
    };
    context.lorebooks.set(bookName, { entries: {
        0: { uid: 0, key: [`${SUMMARY_KEY_PREFIX}[第1-10楼]`], content: '第一条保持不变。' },
        1: { uid: 1, key: [`${SUMMARY_KEY_PREFIX}[第11-20楼]`], content: '第二条旧摘要。' },
        2: { uid: 2, key: [`${SUMMARY_KEY_PREFIX}[第21-30楼]`], content: '第三条保持不变。' },
    } });
    let modelCalls = 0;

    const result = await regenerateSummaryRange(
        { context: { recentMessages: 20, summaryBatchSize: 10 } },
        context,
        12,
        12,
        {
            getCurrentContext: () => context,
            generateSummary: async prompt => {
                modelCalls++;
                assert.match(prompt, /第11-20楼/);
                return '[事件1]\n重要度：4\n事件概述：只重新生成指定楼层所在的摘要条目。\n时间：未明确\n地点：室内\n涉及角色：用户，角色';
            },
        },
    );

    assert.equal(modelCalls, 1);
    assert.equal(result.regenerated, 1);
    assert.deepEqual(result.ranges, [{ start: 11, end: 20 }]);
    const entries = context.lorebooks.get(bookName).entries;
    assert.equal(entries[0].content, '第一条保持不变。');
    assert.match(entries[1].content, /只重新生成指定楼层所在的摘要条目/);
    assert.equal(entries[2].content, '第三条保持不变。');
});

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
    assert.match(prompts[0].prompt, /以下10楼只是本次处理窗口，不是事件边界/);
    assert.match(prompts[0].prompt, /如果这段对话全是日常闲聊/);
    assert.equal(prompts[0].maxTokens, 4096);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, 9);
    assert.ok(context.worldInfoListUpdates > 0, 'the new summary lorebook must enter ST\'s live list immediately');
    assert.ok(context.reloadedWorldInfoBooks.includes(context.additionalBooks[0]), 'the open lorebook editor must reload after content is saved');

    const data = context.lorebooks.get(context.summaryBookName);
    const entries = Object.values(data.entries);
    assert.equal(entries.length, 2);
    const detail = entries.find(entry => entry.key[0] === `${SUMMARY_KEY_PREFIX}[第1-10楼]`);
    const overview = entries.find(entry => entry.key[0] === '[KKT历史概括]');
    assert.equal(detail.constant, false);
    assert.equal(detail.content, [
        '[★★★★☆]',
        '⏰ 固定历史时间锚点：黄昏时分（不得按当前回合重新解释）',
        ' A、B',
        ' 王都北区酒馆',
        ' A与B发生冲突，B亮出身份令牌，A决定暂时退让。',
        '',
        '[★★☆☆☆]',
        '⏰ 固定历史时间锚点：入夜后（不得按当前回合重新解释）',
        ' A、C',
        ' 酒馆后巷',
        ' A暗中通知C留意B的行动。',
    ].join('\n'));
    assert.equal(overview.constant, true);
    assert.equal(overview.content, '');
    assert.deepEqual(context.additionalBooks, [context.summaryBookName]);
    assert.equal(context.characters[0].data.extensions.world, '角色主世界书');
    assert.equal(context.calls.some(command => command.startsWith('/createentry ')), false);
    assert.deepEqual(
        context.calls.filter(command => command.startsWith('/hide ')),
        [0, 1, 2, 4, 5, 6, 7, 8, 9].map(index => `/hide ${index}`),
    );
    assert.equal(context.chat.slice(0, 10).every(message => message.is_system === true), true);
});

test('a fifteen-floor batch retries when the model compresses everything into one event', async () => {
    const context = createContext(dialoguePairs(18));
    let calls = 0;
    const result = await summarizePendingMessages({ context: { recentMessages: 20, summaryBatchSize: 15 } }, context, {
        getCurrentContext: () => context,
        generateSummary: async () => {
            calls++;
            if (calls === 1) {
                return '[事件1]\n重要度：3\n事件概述：A经历了这一阶段的全部剧情。\n时间：未明确\n地点：未明确\n涉及角色：A';
            }
            return [
                '[事件1]\n重要度：4\n事件概述：A发现关键线索并改变了原定计划。\n时间：清晨\n地点：庭院\n涉及角色：A',
                '[事件2]\n重要度：3\n事件概述：B随后确认线索来源并决定与A合作。\n时间：当天稍后\n地点：书房\n涉及角色：A、B',
            ].join('\n\n');
        },
    });

    assert.equal(calls, 2);
    assert.equal(result.created, 1);
    const detail = Object.values(context.lorebooks.get(context.summaryBookName).entries)
        .find(entry => entry.key?.[0] === `${SUMMARY_KEY_PREFIX}[第1-15楼]`);
    assert.equal((detail.content.match(/^\[[★☆]{5}\]$/gmu) ?? []).length, 2);
});

test('event parser accepts at most five complete concise events without cutting their text', () => {
    const output = Array.from({ length: 5 }, (_, index) => [
        `[事件${index + 1}]`,
        `重要度：${Math.min(index + 1, 5)}`,
        '时间：深夜',
        '涉及角色：甲、乙',
        '地点：旧城区',
        `事件概述：甲与乙完成了第${index + 1}件关键事项。`,
    ].join('\n')).join('\n\n');
    const events = parseSummaryEvents(output);
    assert.equal(events.length, 5);
    assert.equal(events[0].overview, '甲与乙完成了第1件关键事项。');

    const sixth = `${output}\n\n[事件6]\n重要度：1\n事件概述：不应被静默保存。\n时间：深夜\n地点：旧城区\n涉及角色：甲`;
    assert.deepEqual(parseSummaryEvents(sixth), []);

    const overlong = `[事件1]\n重要度：5\n事件概述：${'细'.repeat(151)}。\n时间：深夜\n地点：旧城区\n涉及角色：甲`;
    assert.deepEqual(parseSummaryEvents(overlong), [], 'overlong output must retry instead of being cut into an ellipsis');
});

test('event parser accepts fields on one line and rejects truncated structured output', () => {
    const oneLine = '[事件1] 重要度：5 事件概述：A找到了失踪多年的王冠。 时间：午夜 地点：旧王宫 涉及角色：A、B';
    const [event] = parseSummaryEvents(oneLine);
    assert.equal(event.importance, 5);
    assert.equal(event.overview, 'A找到了失踪多年的王冠。');
    assert.equal(event.time, '午夜');
    assert.equal(event.location, '旧王宫');
    assert.equal(event.characters, 'A、B');

    const truncated = '[事件1] 重要度：5 时间：午夜 涉及角色：奥蕾莉亚·';
    assert.deepEqual(parseSummaryEvents(truncated), []);
    assert.equal(isMalformedSummaryContent('[★☆☆☆☆]\n⏰ 未明确\n 未明确\n 未明确\n ' + truncated), true);
    assert.deepEqual(parseSummaryEvents('[事件1] 重要度：5 事件概述：A仍在追查真相…… 时间：午夜 地点：旧王宫 涉及角色：A'), []);
    const legacyCutoff = `${'旧'.repeat(149)}…`;
    assert.equal(isMalformedSummaryContent(`[★☆☆☆☆]\n⏰ 未明确\n 未明确\n 未明确\n ${legacyCutoff}`), true);
    assert.equal(isUnusableSummaryOutput('抱歉，我无法总结这类敏感内容。'), true);
    assert.equal(isUnusableSummaryOutput('Drafting Event 3 (analysis)'), true);
});

test('event parser accepts full-width headings, markdown field labels, and JSON', () => {
    const [markdownEvent] = parseSummaryEvents([
        '【事件1】',
        '**重要度**：4',
        '**事件概述**：A与B确认误会源于伪造的信件，并决定共同追查来源。',
        '**时间**：深夜',
        '**地点**：书房',
        '**涉及角色**：A、B',
    ].join('\n'));
    assert.equal(markdownEvent.importance, 4);
    assert.match(markdownEvent.overview, /共同追查来源/);

    const [jsonEvent] = parseSummaryEvents(JSON.stringify({ events: [{
        importance: 3,
        overview: 'A找到了能够证明身份的旧徽章。',
        time: '清晨',
        location: '阁楼',
        characters: ['A'],
    }] }));
    assert.equal(jsonEvent.importance, 3);
    assert.equal(jsonEvent.location, '阁楼');
    assert.equal(jsonEvent.characters, 'A');
});

test('event parser repairs punctuation only for complete records and rejects missing metadata', () => {
    const [event] = parseSummaryEvents([
        '[事件1]',
        '重要度：3',
        '事件概述：A与B解除误会并决定继续同行',
        '时间：傍晚',
        '地点：旅店',
        '涉及角色：A、B',
    ].join('\n'));
    assert.equal(event.overview, 'A与B解除误会并决定继续同行。');

    assert.deepEqual(parseSummaryEvents('[事件1]\n重要度：2\n事件概述：A暂时留在原地等待消息'), []);

    assert.deepEqual(parseSummaryEvents('[事件1]\n重要度：3\n事件概述：A与B决定继续……'), []);
});

test('a malformed summary is rebuilt from hidden messages before new ranges advance', async () => {
    const context = createContext(dialoguePairs(15));
    context.chat.slice(0, 10).forEach(message => message.is_system = true);
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        bookName: context.summaryBookName,
        lastSummarizedMessageIndex: 9,
        entries: [{ uid: '0', start: 0, end: 9, createdAt: '2026-08-02T00:00:00.000Z' }],
    };
    context.lorebooks.set(context.summaryBookName, { entries: {
        0: {
            uid: 0,
            key: [`${SUMMARY_KEY_PREFIX}[第1-10楼]`],
            content: '[★☆☆☆☆]\n⏰ 未明确\n 未明确\n 未明确\n [事件1] 重要度：5 时间：午夜 涉及角色：金钰琳',
            constant: true,
        },
    } });

    const result = await summarizePendingMessages({ context: { recentMessages: 20, summaryBatchSize: 10 } }, context, {
        getCurrentContext: () => context,
        repairMalformed: true,
        generateSummary: async (prompt) => {
            assert.match(prompt, /\[第 1 楼\].*dialogue 0/);
            return '[事件1] 重要度：5 事件概述：A重新取得了关键线索。 时间：午夜 地点：旧王宫 涉及角色：A';
        },
    });

    assert.equal(result.repaired, true);
    assert.equal(result.start, 0);
    assert.equal(result.end, 9);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, 9);
    assert.match(context.lorebooks.get(context.summaryBookName).entries[0].content, /A重新取得了关键线索/);
    assert.equal(context.calls.some(command => command.startsWith('/hide ')), false);
});

test('repair fills a missing batch after the model returned no usable events', async () => {
    const context = createContext(dialoguePairs(15));
    const settings = { context: { recentMessages: 20, summaryBatchSize: 10 } };
    await assert.rejects(
        summarizePendingMessages(settings, context, {
            getCurrentContext: () => context,
            generateSummary: async () => '抱歉，我无法总结这些内容。',
        }),
        /第1-10楼总结失败：首次模型拒绝总结或只输出了思考草稿/,
    );
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, -1);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].entries.length, 0);

    const progress = [];
    const repaired = await repairMalformedSummaries(settings, context, {
        getCurrentContext: () => context,
        onProgress: update => progress.push(update),
        generateSummary: async prompt => {
            assert.match(prompt, /第 1 楼/);
            assert.match(prompt, /第 10 楼/);
            return '[事件1]\n重要度：4\n事件概述：缺失的摘要区间已经重新生成。\n时间：未明确\n地点：室内\n涉及角色：用户，角色';
        },
    });

    assert.equal(repaired, 1);
    assert.deepEqual(progress, [{ current: 1, start: 0, end: 9, kind: 'missing' }]);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, 9);
    assert.match(context.lorebooks.get(context.summaryBookName).entries[0].content, /缺失的摘要区间已经重新生成/);
});

test('ordinary automatic summary checks do not repair old malformed entries in the background', async () => {
    const context = createContext(dialoguePairs(15));
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        bookName: context.summaryBookName,
        lastSummarizedMessageIndex: 9,
        entries: [{ uid: '0', start: 0, end: 9, createdAt: '2026-08-02T00:00:00.000Z' }],
    };
    context.lorebooks.set(context.summaryBookName, { entries: {
        0: { uid: 0, key: [`${SUMMARY_KEY_PREFIX}[第1-10楼]`], content: 'Drafting Event 1', constant: true },
    } });
    let generationCalls = 0;
    const result = await summarizePendingMessages({ context: { recentMessages: 20, summaryBatchSize: 10 } }, context, {
        getCurrentContext: () => context,
        generateSummary: async () => { generationCalls++; return '不应调用。'; },
    });
    assert.deepEqual(result, { created: 0, pendingFloors: 0 });
    assert.equal(generationCalls, 0);
});

test('a truncated structured summary retries as concise structured events before hiding', async () => {
    const context = createContext(dialoguePairs(15));
    let generationCalls = 0;
    const result = await summarizePendingMessages({ context: { recentMessages: 20, summaryBatchSize: 10 } }, context, {
        getCurrentContext: () => context,
        generateSummary: async (prompt) => {
            generationCalls++;
            if (generationCalls === 1) {
                return '[事件1] 重要度：5 时间：午夜 涉及角色：奥蕾莉亚·';
            }
            assert.match(prompt, /通常提取2-4个事件/);
            assert.match(prompt, /绝对不超过5个/);
            assert.match(prompt, /不要用省略号收尾/);
            return '[事件1]\n重要度：5\n事件概述：主角在旧王宫找回王冠，并决定翌日公开失踪多年的真相。\n时间：午夜\n地点：旧王宫\n涉及角色：主角';
        },
    });

    assert.equal(result.created, 1);
    assert.equal(generationCalls, 2);
    assert.match(context.lorebooks.get(context.summaryBookName).entries[0].content, /主角在旧王宫找回王冠/);
    assert.equal(context.chat.slice(0, 10).every(message => message.is_system === true), true);
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
    const entries = Object.values(context.lorebooks.get(context.summaryBookName).entries)
        .filter(entry => entry.key[0].startsWith(SUMMARY_KEY_PREFIX))
        .sort((left, right) => left.order - right.order);
    assert.deepEqual(entries.map(entry => entry.order), [100, 101]);
    assert.deepEqual(entries.map(entry => entry.key[0]), [
        `${SUMMARY_KEY_PREFIX}[第1-10楼]`,
        `${SUMMARY_KEY_PREFIX}[第11-20楼]`,
    ]);
});

test('existing summary lorebook entries are automatically reordered by floor range', async () => {
    const context = createContext(dialoguePairs(2));
    const bookName = context.summaryBookName;
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        bookName,
        lastSummarizedMessageIndex: -1,
        entries: [],
    };
    context.lorebooks.set(bookName, { entries: {
        3: { uid: 3, key: [`${SUMMARY_KEY_PREFIX}[第21-30楼]`], content: '第三段', order: 100 },
        1: { uid: 1, key: [`${SUMMARY_KEY_PREFIX}[第1-10楼]`], content: '第一段', order: 100 },
        2: { uid: 2, key: [`${SUMMARY_KEY_PREFIX}[第11-20楼]`], content: '第二段', order: 100 },
        9: { uid: 9, key: ['ordinary'], content: '普通条目', order: 77 },
    } });

    await migrateLegacySummaries(context);

    const entries = context.lorebooks.get(bookName).entries;
    assert.equal(entries[1].order, 100);
    assert.equal(entries[1].constant, false);
    assert.equal(entries[2].order, 101);
    assert.equal(entries[2].constant, false);
    assert.equal(entries[3].order, 102);
    assert.equal(entries[3].constant, false);
    assert.equal(entries[9].order, 77);
    assert.equal(Object.values(entries).some(entry => entry.key?.[0] === '[KKT历史概括]'), true);
});

test('every five detailed summaries append one blue historical overview block', async () => {
    const context = createContext(dialoguePairs(30));
    const bookName = context.summaryBookName;
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        bookName,
        lastSummarizedMessageIndex: 49,
        entries: Array.from({ length: 5 }, (_, index) => ({
            uid: String(index),
            start: index * 10,
            end: index * 10 + 9,
            createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
        })),
        overviewGroups: [],
    };
    context.lorebooks.set(bookName, { entries: Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
        index,
        {
            uid: index,
            key: [`${SUMMARY_KEY_PREFIX}[第${index * 10 + 1}-${index * 10 + 10}楼]`],
            content: `第${index + 1}段发生了明确的重要事件。`,
            constant: false,
            order: 100 + index,
        },
    ])) });

    const result = await updateHistoricalOverview({}, context, {
        getCurrentContext: () => context,
        generateSummary: async (prompt) => {
            assert.match(prompt, /第1-50楼的5份阶段事件总结/);
            assert.match(prompt, /第5段发生了明确的重要事件/);
            return '主角在这段时期依次处理了五件重要事件，并保留了继续推进主线的关键线索。';
        },
    });

    assert.deepEqual(result, { updated: 1, start: 0, end: 49 });
    const overview = Object.values(context.lorebooks.get(bookName).entries)
        .find(entry => entry.key?.[0] === '[KKT历史概括]');
    assert.equal(overview.constant, true);
    assert.match(overview.content, /^【历史概括·第1-50楼】/);
    assert.match(overview.content, /五件重要事件/);

    let repeatedCalls = 0;
    const repeated = await updateHistoricalOverview({}, context, {
        getCurrentContext: () => context,
        generateSummary: async () => { repeatedCalls++; return '不应重复生成。'; },
    });
    assert.deepEqual(repeated, { updated: 0 });
    assert.equal(repeatedCalls, 0);
    assert.equal((overview.content.match(/【历史概括·第1-50楼】/g) ?? []).length, 1);
});

test('legacy per-event entries for the same floor range are merged', async () => {
    const context = createContext(dialoguePairs(15));
    const bookName = context.summaryBookName;
    context.chatMetadata.world_info = bookName;
    context.lorebooks.set(bookName, { entries: {
        4: { uid: 4, key: [`${SUMMARY_KEY_PREFIX}[★★★★★][第0-9楼]`], content: 'old high', constant: true },
        5: { uid: 5, key: [`${SUMMARY_KEY_PREFIX}[★★☆☆☆][第0-9楼]`], content: 'old low', constant: true },
        9: { uid: 9, key: ['ordinary'], content: 'keep me', constant: false },
    } });

    await migrateLegacySummaries(context);
    const entries = Object.values(context.lorebooks.get(bookName).entries);
    assert.equal(entries.length, 3);
    assert.equal(entries.filter(entry => entry.key[0].startsWith(SUMMARY_KEY_PREFIX)).length, 1);
    assert.equal(entries.find(entry => entry.key[0].startsWith(SUMMARY_KEY_PREFIX)).constant, false);
    assert.equal(entries.find(entry => entry.key[0] === '[KKT历史概括]').constant, true);
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

test('legacy summary migration scans the lorebook once and then stays dormant', async () => {
    const context = createContext(dialoguePairs(2));
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        bookName: context.summaryBookName,
        lastSummarizedMessageIndex: -1,
        entries: [],
    };
    context.lorebooks.set(context.summaryBookName, { entries: {} });

    assert.equal(await migrateLegacySummaries(context), 0);
    const loadsAfterFirstMigration = context.worldInfoLoads;
    const savesAfterFirstMigration = context.metadataSaves;
    assert.ok(loadsAfterFirstMigration > 0);

    assert.equal(await migrateLegacySummaries(context), 0);
    assert.equal(context.worldInfoLoads, loadsAfterFirstMigration);
    assert.equal(context.metadataSaves, savesAfterFirstMigration);
});

test('summary binding is reconciled again when it is manually removed in the same chat', async () => {
    const context = createContext(dialoguePairs(2));
    await migrateLegacySummaries(context);
    assert.deepEqual(context.additionalBooks, [context.summaryBookName]);
    const firstBindCalls = context.additionalBindCalls;

    context.additionalBooks.splice(0);
    await migrateLegacySummaries(context);

    assert.deepEqual(context.additionalBooks, [context.summaryBookName]);
    assert.equal(context.additionalBindCalls, firstBindCalls + 1);
});

test('a new chat does not adopt the character legacy summary lorebook', async () => {
    const context = createContext(dialoguePairs(2));
    context.lorebooks.set('金钰琳-自动总结', { entries: {
        0: { uid: 0, key: [`${SUMMARY_KEY_PREFIX}[第1-2楼]`], content: '另一个存档的旧总结。' },
    } });

    await migrateLegacySummaries(context);

    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].bookName, context.summaryBookName);
    assert.notEqual(context.chatMetadata[SUMMARY_STATE_KEY].bookName, '金钰琳-自动总结');
    assert.equal(context.lorebooks.get('金钰琳-自动总结').entries[0].content, '另一个存档的旧总结。');
});

test('a new chat takes the next number after existing character summary lorebooks', async () => {
    const context = createContext(dialoguePairs(2));
    context.lorebooks.set(buildSummaryBookName('金钰琳', 1), { entries: {} });
    context.lorebooks.set(buildSummaryBookName('金钰琳', 2), { entries: {} });

    await migrateLegacySummaries(context);

    const expected = '金钰琳-自动总结3';
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].bookName, expected);
    assert.equal(context.lorebooks.has(expected), true);
});

test('an existing legacy chat keeps its original unsuffixed summary lorebook', async () => {
    const context = createContext(dialoguePairs(2));
    const legacyBookName = '金钰琳-自动总结';
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        lastSummarizedMessageIndex: 1,
        entries: [{ uid: '0', start: 0, end: 1, createdAt: '' }],
    };
    context.lorebooks.set(legacyBookName, { entries: {
        0: { uid: 0, key: [`${SUMMARY_KEY_PREFIX}[第1-2楼]`], content: '这个旧档自己的总结。' },
    } });

    await migrateLegacySummaries(context);

    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].bookName, legacyBookName);
    assert.equal((await getSummaries(context))[0].summary, '这个旧档自己的总结。');
});

test('a migrated chat recovers its populated legacy book instead of keeping an empty numbered shell', async () => {
    const context = createContext(dialoguePairs(15));
    const emptyNumberedBook = context.summaryBookName;
    const legacyBookName = '金钰琳-自动总结';
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        migrationVersion: 1,
        bookName: emptyNumberedBook,
        lastSummarizedMessageIndex: 9,
        entries: [{ uid: '8', start: 0, end: 9, bookName: emptyNumberedBook, createdAt: '' }],
        overviewGroups: [],
    };
    context.lorebooks.set(emptyNumberedBook, { entries: {} });
    context.lorebooks.set(legacyBookName, { entries: {
        3: { uid: 3, key: [`${SUMMARY_KEY_PREFIX}[第1-10楼]`], content: '跨版本前已经保存的真实总结。' },
    } });

    await migrateLegacySummaries(context);

    const state = context.chatMetadata[SUMMARY_STATE_KEY];
    assert.equal(state.bookName, legacyBookName);
    assert.equal(state.lastSummarizedMessageIndex, 9);
    assert.deepEqual(state.entries.map(entry => entry.uid), ['3']);
    assert.equal((await getSummaries(context))[0].summary, '跨版本前已经保存的真实总结。');
    assert.ok(context.additionalBooks.includes(legacyBookName));
});

test('orphaned summary progress is reset so an old chat can backfill from its first missing floor', async () => {
    const context = createContext(dialoguePairs(15));
    const bookName = context.summaryBookName;
    context.chatMetadata[SUMMARY_STATE_KEY] = {
        migrationVersion: 1,
        bookName,
        lastSummarizedMessageIndex: 9,
        entries: [{ uid: '8', start: 0, end: 9, bookName, createdAt: '' }],
        overviewGroups: [],
    };
    context.lorebooks.set(bookName, { entries: {} });

    const result = await summarizePendingMessages(
        { context: { recentMessages: 20, summaryBatchSize: 10 } },
        context,
        {
            getCurrentContext: () => context,
            generateSummary: async prompt => {
                assert.match(prompt, /\[第 1 楼\].*dialogue 0/);
                assert.match(prompt, /\[第 10 楼\].*dialogue 9/);
                return '[事件1]\n重要度：3\n时间：当天\n涉及角色：A\n地点：室内\n事件概述：旧档成功从缺失的第一段重新补总结。';
            },
        },
    );

    assert.equal(result.created, 1);
    assert.equal(result.start, 0);
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, 9);
    assert.equal((await getSummaries(context))[0].summary.includes('重新补总结'), true);
});

test('existing unstructured KKT lorebook entries remain readable without changing their key', async () => {
    const context = createContext(dialoguePairs(2));
    const bookName = context.summaryBookName;
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
        bookName: context.summaryBookName,
        lastSummarizedMessageIndex: 1,
        entries: [{ uid: '0', start: 0, end: 1, createdAt: '2026-01-01T00:00:00.000Z' }],
    };
    context.lorebooks.set(context.summaryBookName, { entries: {
        0: { uid: 0, key: [`${SUMMARY_KEY_PREFIX}第0-1楼`], content: '旧格式摘要，没有星级和结构化字段' },
        9: { uid: 9, key: ['ordinary'], content: 'keep me' },
    } });

    const status = await getSummaryStatus(context);
    assert.equal(status.entryCount, 1);
    assert.equal(await clearAllSummaries(context), 1);
    assert.equal(context.lorebooks.get(context.summaryBookName).entries[9].content, 'keep me');
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
    const generateSummary = async (...args) => {
        calls.push(args);
        return '[事件1]\n重要度：1\n时间：午后\n涉及角色：A\n地点：家中\n事件概述：A进行了一段普通的日常交谈。';
    };

    const originalSillyTavern = globalThis.SillyTavern;
    testContext.after(() => globalThis.SillyTavern = originalSillyTavern);
    globalThis.SillyTavern = { getContext: () => context };
    initializeSummaryManager({ context: { recentMessages: 20, summaryBatchSize: 10 } }, context, { generateSummary });

    assert.equal(handlers.has('received'), false, 'swipe/regenerate events must not trigger summaries');
    handlers.get('sent')(28);
    await new Promise(resolve => setTimeout(resolve, 35));

    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 4096);
    assert.match((await getSummaries(context))[0].summary, /普通的日常交谈/);
});

test('opening an existing chat backfills at most three configured-size batches immediately', async (testContext) => {
    const context = createContext(dialoguePairs(20));
    const handlers = new Map();
    let calls = 0;
    context.eventTypes = {
        MESSAGE_SENT: 'sent',
        CHAT_CHANGED: 'changed',
    };
    context.eventSource = { on: (event, handler) => handlers.set(event, handler) };

    const originalSillyTavern = globalThis.SillyTavern;
    testContext.after(() => globalThis.SillyTavern = originalSillyTavern);
    globalThis.SillyTavern = { getContext: () => context };

    initializeSummaryManager({ context: { recentMessages: 5, summaryBatchSize: 4 } }, context, {
        generateSummary: async () => {
            calls++;
            return '[事件1]\n重要度：3\n时间：未明确\n涉及角色：A\n地点：庭院\n事件概述：A确认了一条足以继续推动剧情的可靠线索。';
        },
    });
    await new Promise(resolve => setTimeout(resolve, 60));

    assert.equal(calls, 3, 'one automatic check must be capped instead of flooding the side API');
    assert.equal(context.chatMetadata[SUMMARY_STATE_KEY].lastSummarizedMessageIndex, 11);
    const status = await getSummaryStatus(context, { context: { recentMessages: 5, summaryBatchSize: 4 } });
    assert.equal(status.batchSize, 4, 'backfill must use the panel setting rather than a fixed floor count');
    assert.equal(status.pendingFloors, 23);
    assert.equal(status.phase, 'pending');
    assert.ok(handlers.has('changed'));
});
