import assert from 'node:assert/strict';
import test from 'node:test';
import {
    analyzeChatTagRemoval,
    normalizeChatTagName,
    removeChatTagBlocks,
    removeChatTagContent,
} from '../chat-tag-cleaner.js';

test('tag cleaner accepts bare or wrapped Chinese and Latin tag names', () => {
    assert.equal(normalizeChatTagName('status'), 'status');
    assert.equal(normalizeChatTagName('<status mode="old">'), 'status');
    assert.equal(normalizeChatTagName('状态栏'), '状态栏');
    assert.throws(() => normalizeChatTagName('status other'), /请输入一个标签名/);
});

test('tag cleaner removes complete nested blocks and self-closing tags only', () => {
    const source = [
        '保留开头',
        '<status mode="a>b">旧内容<status>内层</status></status>',
        '<status />',
        '<status-extra>不能误删</status-extra>',
        '<status>没有结束的内容',
    ].join('\n');
    const result = removeChatTagBlocks(source, '<status>');

    assert.equal(result.blocks, 3);
    assert.doesNotMatch(result.text, /旧内容|内层|<status\s*\/>/);
    assert.match(result.text, /<status-extra>不能误删<\/status-extra>/);
    assert.match(result.text, /<status>没有结束的内容/);
});

test('chat tag cleanup covers selected text, all swipes and hidden assistant floors but skips users by default', async () => {
    let saves = 0;
    const context = {
        chat: [
            { is_user: true, mes: '玩家写下 <memo>别删</memo>' },
            {
                is_user: false,
                is_system: true,
                mes: '采用 <memo>当前残留</memo> 正文',
                swipes: [
                    '废案 <memo>旧残留</memo>',
                    '采用 <memo>当前残留</memo> 正文',
                ],
                swipe_id: 1,
            },
        ],
        async saveChat() { saves++; },
    };
    const preview = analyzeChatTagRemoval(context, 'memo');
    assert.deepEqual(preview.affectedMessageIds, [1]);
    assert.equal(preview.blocks, 2);

    const result = await removeChatTagContent(context, 'memo');
    assert.equal(result.changed, true);
    assert.equal(saves, 1);
    assert.equal(context.chat[0].mes, '玩家写下 <memo>别删</memo>');
    assert.equal(context.chat[1].mes, '采用  正文');
    assert.deepEqual(context.chat[1].swipes, ['废案 ', '采用  正文']);
});

test('chat tag cleanup restores every edited field when saving fails', async () => {
    const context = {
        chat: [{ is_user: false, mes: '前<memo>删</memo>后', swipes: ['前<memo>删</memo>后'] }],
        async saveChat() { throw new Error('save failed'); },
    };
    await assert.rejects(removeChatTagContent(context, 'memo'), /save failed/);
    assert.equal(context.chat[0].mes, '前<memo>删</memo>后');
    assert.deepEqual(context.chat[0].swipes, ['前<memo>删</memo>后']);
});
