import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PHONE_ACCOUNT_AREAS,
    assignPhoneAccount,
    createPhoneAltAccount,
    getPhoneAccountForArea,
    normalizePhoneAccounts,
    removePhoneAltAccount,
    setDefaultPhoneAccount,
    syncPhoneAccountProfiles,
    updatePhoneAccount,
    updatePhoneAltAccount,
} from '../phone-settings.js';

const context = {
    name1: '夜酱',
    powerUser: { persona_description: '夜酱是当前酒馆用户设定。' },
};

test('main phone account binds the SillyTavern identity while keeping editable public details', () => {
    const settings = { phone: { profile: { nickname: '旧昵称', avatar: 'old.png' } } };
    const state = normalizePhoneAccounts(settings, context, null);
    assert.equal(state.items[0].id, 'main');
    assert.equal(state.items[0].nickname, '旧昵称');
    assert.equal(state.items[0].bio, '');
    assert.equal(state.items[0].persona, '夜酱是当前酒馆用户设定。');
    assert.equal(state.defaultAccountId, 'main');
    assert.deepEqual(Object.keys(state.assignments), PHONE_ACCOUNT_AREAS.map(([id]) => id));
    assert.ok(Object.values(state.assignments).every(id => id === 'main'));
    updatePhoneAccount(settings, 'main', {
        nickname: '随便改的大号昵称',
        avatar: '/user/files/local-main.png',
        bio: '新的公开简介',
        persona: '不允许覆盖真实绑定',
    }, context, null);
    assert.equal(settings.phone.accounts.items[0].nickname, '随便改的大号昵称');
    assert.equal(settings.phone.accounts.items[0].avatar, '/user/files/local-main.png');
    assert.equal(settings.phone.accounts.items[0].persona, '夜酱是当前酒馆用户设定。');
    assert.equal(settings.phone.profile.isMask, false);
});

test('alt accounts can be created, edited, assigned selectively, and switched everywhere', () => {
    const settings = { phone: {} };
    const alt = createPhoneAltAccount(settings, {
        label: '吃瓜号',
        nickname: '瓜田常住人口',
        bio: '只围观不站队',
        persona: '说话谨慎的围观群众。',
    }, context, null);
    assignPhoneAccount(settings, alt.id, ['weibo', 'community'], context, null);
    assert.equal(getPhoneAccountForArea(settings, 'weibo', context, null).id, alt.id);
    assert.equal(getPhoneAccountForArea(settings, 'community', context, null).id, alt.id);
    assert.equal(getPhoneAccountForArea(settings, 'messages', context, null).id, 'main');
    assert.equal(settings.phone.weibo.profile.isMask, true);

    updatePhoneAltAccount(settings, alt.id, { nickname: '新瓜名' }, context, null);
    assert.equal(getPhoneAccountForArea(settings, 'weibo', context, null).nickname, '新瓜名');

    assignPhoneAccount(settings, alt.id, PHONE_ACCOUNT_AREAS.map(([id]) => id), context, null);
    assert.ok(Object.values(settings.phone.accounts.assignments).every(id => id === alt.id));
    assert.equal(settings.phone.profile.nickname, '新瓜名');
    assert.equal(settings.phone.weibo.profile.nickname, '新瓜名');
    assert.equal(settings.phone.community.profile.nickname, '新瓜名');
    assert.equal(settings.phone.live.profile.nickname, '新瓜名');
});

test('default identity survives new areas and deleting an alt safely falls back to main', () => {
    const settings = { phone: {} };
    const alt = createPhoneAltAccount(settings, { label: '工作号', nickname: '认真营业中' }, context, null);
    setDefaultPhoneAccount(settings, alt.id, context, null);
    assignPhoneAccount(settings, alt.id, ['live'], context, null);
    assert.equal(settings.phone.accounts.defaultAccountId, alt.id);
    assert.equal(removePhoneAltAccount(settings, alt.id, context, null), true);
    assert.equal(settings.phone.accounts.defaultAccountId, 'main');
    assert.equal(settings.phone.accounts.assignments.live, 'main');
    assert.equal(settings.phone.live.profile.nickname, '夜酱');
});

test('profile synchronization writes only identity data and keeps application content', () => {
    const settings = {
        phone: {
            community: { forumThreads: [{ id: 'keep-me' }] },
            live: { streams: [{ id: 'keep-live' }] },
        },
    };
    syncPhoneAccountProfiles(settings, context, null);
    assert.equal(settings.phone.community.forumThreads[0].id, 'keep-me');
    assert.equal(settings.phone.live.streams[0].id, 'keep-live');
    assert.equal(settings.phone.profile.nickname, '夜酱');
});
