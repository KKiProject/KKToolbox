import { cleanPhoneText as text } from './phone-utils.js';

export const PHONE_LIVE_CHANNELS = Object.freeze([
    ['official', '官方直播'],
    ['private', '私人直播'],
    ['mine', '我的'],
]);

export const PHONE_LIVE_FORMATS = Object.freeze([
    ['chat', '纯闲聊'],
    ['gaming', '打游戏'],
    ['work', '工作实录'],
    ['creative', '创作过程'],
    ['shopping', '带货'],
    ['outing', '外出探店'],
    ['event', '活动直播'],
]);

export const PHONE_LIVE_NATURES = Object.freeze([
    ['casual', '私人娱乐'],
    ['professional', '工作性质'],
]);

const SAMPLE_LIVE_STREAMS = Object.freeze([
    {
        id: 'live-awards-night',
        type: 'official',
        title: '星光盛典 · 红毯特别直播',
        host: '星光盛典官方',
        badge: '官方直播',
        viewers: '328.6万',
        cover: '红毯现场',
        summary: '艺人陆续抵达，主持人与现场媒体正在红毯区进行实时采访。',
        scene: '镜头从灯光璀璨的主舞台缓缓推向红毯入口。两侧媒体快门声连成一片，主持人抬手示意下一组嘉宾入场，远处的大屏正循环播放本届入围作品。',
        segment: '红毯直播 · 嘉宾入场阶段',
        scenes: [
            { kind: 'narration', segment: '红毯直播 · 全景', text: '镜头从灯光璀璨的主舞台缓缓推向红毯入口。两侧媒体快门声连成一片，远处的大屏正循环播放本届入围作品。' },
            { kind: 'dialogue', segment: '红毯直播 · 主持区', speaker: '主持人', speakerRole: '星光盛典红毯主持', text: '欢迎来到星光盛典红毯特别直播。下一组嘉宾已经抵达入口，我们先把镜头交给红毯前方。' },
            { kind: 'narration', segment: '红毯直播 · 嘉宾入场', text: '黑色礼宾车停在签名墙外，现场灯光同时转向入口。嘉宾下车后向两侧挥手，媒体区的快门声骤然密集起来。' },
            { kind: 'dialogue', segment: '红毯直播 · 即时采访', speaker: '受访嘉宾', speakerRole: '本届入围演员', text: '今天最期待的是和观众一起看完整场颁奖礼。至于准备了什么，我只能说，希望等会儿还有机会再上台。' },
            { kind: 'narration', segment: '红毯直播 · 媒体区', text: '主持人侧身让出签名墙，镜头给到礼服细节和媒体合影。后方工作人员已经举牌提醒下一组嘉宾候场。' },
            { kind: 'narration', segment: '红毯直播 · 转场', text: '航拍画面越过红毯与灯海，最终落回主会场入口。直播画面打出下一环节预告，红毯采访仍在继续。' },
        ],
        barrages: ['来了来了！镜头终于转过来了', '今天现场灯光好漂亮', '主持人反应速度太强了', '导播老师这个推镜加鸡腿', '红毯后面是不是还有采访区', '快门声听着好有盛典感', '蹲一个后台采访', '这个舞美真的下本了'],
        chats: [],
    },
    {
        id: 'live-premiere',
        type: 'official',
        title: '《长街灯火》全球首映礼',
        host: '长街灯火电影频道',
        badge: '节目组官方',
        viewers: '186.2万',
        cover: '首映礼现场',
        summary: '主创映后交流即将开始，现场观众正在等待嘉宾返场。',
        scene: '影厅顶灯逐排亮起，银幕上停留着影片最后一帧。主持人拿着手卡走到台前，观众席仍有压低的讨论声，舞台侧边已经摆好了六把高脚椅。',
        segment: '映后交流 · 主创返场前',
        scenes: [
            { kind: 'narration', segment: '映后交流 · 返场前', text: '影厅顶灯逐排亮起，银幕上停留着影片最后一帧。观众席仍有压低的讨论声，舞台侧边已经摆好了六把高脚椅。' },
            { kind: 'dialogue', segment: '映后交流 · 主持开场', speaker: '主持人', speakerRole: '首映礼主持', text: '谢谢大家留到现在。接下来请用掌声欢迎《长街灯火》的主创团队回到现场。' },
            { kind: 'narration', segment: '映后交流 · 主创返场', text: '侧幕灯光亮起，六位主创依次登台。台下有人举起电影票根，掌声持续到所有人落座才渐渐安静。' },
            { kind: 'dialogue', segment: '映后交流 · 现场采访', speaker: '导演', speakerRole: '《长街灯火》导演', text: '最后那个回头我们拍了三版，成片留下的是最克制的一版。没有说出口的部分，希望观众能自己带走。' },
            { kind: 'narration', segment: '映后交流 · 观众提问', text: '工作人员把话筒递到第三排，银幕同步切出拍摄花絮。几位主创交换了一下眼神，编剧低头翻开手中的笔记。' },
            { kind: 'narration', segment: '映后交流 · 花絮播放', text: '现场灯光再次暗下，未公开的片场片段开始播放。观众席传来短促的惊呼，直播弹幕也在同一刻迅速刷屏。' },
        ],
        barrages: ['刚看完真的缓不过来', '最后那个回头我哭死', '求问导演删减片段', '现场观众好安静', '高脚椅有六把！全员都会来吧', '主持人快问结局', '想听编剧解释那封信'],
        chats: [],
    },
    {
        id: 'live-late-night',
        type: 'private',
        title: '收工了，随便聊十分钟',
        host: '今晚不熬夜',
        badge: '个人直播',
        viewers: '8.7万',
        cover: '酒店房间',
        summary: '刚结束夜戏，主播正坐在窗边拆一杯温热的外卖粥。',
        scene: '手机靠在窗边的小桌上，画面偶尔被夜风吹动的窗帘挡住一角。主播穿着宽松卫衣低头拆开餐具，桌边还放着没有来得及卸下的剧本和胸牌。',
        segment: '闲聊 · 收工夜宵',
        scenes: [
            { kind: 'narration', segment: '闲聊 · 刚刚开播', text: '手机靠在窗边的小桌上，画面偶尔被夜风吹动的窗帘挡住一角。主播穿着宽松卫衣低头拆开餐具。' },
            { kind: 'dialogue', segment: '闲聊 · 收工夜宵', speaker: '今晚不熬夜', speakerRole: '主播', text: '你们怎么这么快就进来了？先说好，真的只聊十分钟，我明早还得起床。' },
            { kind: 'dialogue', segment: '闲聊 · 回应弹幕', speaker: '今晚不熬夜', speakerRole: '主播', text: '今天收工是早一点。没有受伤，袖口那个是道具血，已经洗掉了。' },
            { kind: 'narration', segment: '闲聊 · 镜头外', text: '主播把差点滑进画面的剧本往旁边推了推，又端起粥吹了两下。窗外车灯从玻璃上缓慢掠过。' },
            { kind: 'dialogue', segment: '闲聊 · 回应弹幕', speaker: '今晚不熬夜', speakerRole: '主播', text: '不能拍剧本，当然不能。你们别截屏放大了，今晚什么线索都没有。' },
            { kind: 'dialogue', segment: '闲聊 · 夜宵时间', speaker: '今晚不熬夜', speakerRole: '主播', text: '好好好，我先吃。你们想听今天片场最好笑的事，还是想看窗外的夜景？' },
        ],
        barrages: ['今天辛苦啦', '真的只聊十分钟吗', '先吃饭先吃饭', '窗外夜景好好看', '剧本不要拍进去啦', '声音有一点小', '终于等到私人直播', '粥看起来还挺香'],
        chats: [
            { id: 'chat-private-1', author: '准时下班', content: '今天收工比昨天早一点！', kind: 'message' },
            { id: 'chat-private-2', author: '小夜灯', content: '送出一颗星星', kind: 'gift' },
            { id: 'chat-private-3', author: '围观群众', content: '先好好吃饭，我们可以等。', kind: 'message' },
        ],
    },
    {
        id: 'live-studio',
        type: 'private',
        title: '新编曲试听｜只放一小段',
        host: '耳返忘充电',
        badge: '个人直播',
        viewers: '3.2万',
        cover: '个人工作室',
        summary: '主播在工作室调整新歌编曲，答应观众试听尚未公开的小样。',
        scene: '镜头朝向铺满设备的工作台，显示器上是密集的音轨波形。主播侧身戴着一边耳机，手指在键盘上敲了几下，房间里短暂响起一段没有人声的钢琴前奏。',
        segment: '创作直播 · 小样试听',
        scenes: [
            { kind: 'narration', segment: '创作直播 · 工作台', text: '镜头朝向铺满设备的工作台，显示器上是密集的音轨波形。主播侧身戴着一边耳机，手指在键盘上敲了几下。' },
            { kind: 'dialogue', segment: '创作直播 · 开场', speaker: '耳返忘充电', speakerRole: '主播', text: '先声明，只放一小段，而且你们听完不许催正式版。现在这个编曲还没定。' },
            { kind: 'dialogue', segment: '创作直播 · 小样试听', speaker: '耳返忘充电', speakerRole: '主播', text: '准备好了吗？从钢琴进来的地方开始，八秒，真的只有八秒。' },
            { kind: 'narration', segment: '创作直播 · 播放中', text: '房间安静下来，一段没有人声的钢琴前奏从监听音箱里响起。第八秒刚到，主播立刻按下暂停键。' },
            { kind: 'dialogue', segment: '创作直播 · 回应弹幕', speaker: '耳返忘充电', speakerRole: '主播', text: '不可以再放一次。你们刚才还说八秒也够，怎么现在集体反悔？' },
            { kind: 'dialogue', segment: '创作直播 · 调整音轨', speaker: '耳返忘充电', speakerRole: '主播', text: '我把弦乐再压低一点。等正式版出来，你们再回来看看今天猜对了多少。' },
        ],
        barrages: ['这一小段也太短了', '钢琴进来那下好喜欢', '可以再放一次吗', '工作室好多设备', '不要熬太晚', '前奏听起来很温柔', '记住了现在有八秒'],
        chats: [
            { id: 'chat-studio-1', author: '循环播放中', content: '八秒已经够我脑补整首了。', kind: 'message' },
            { id: 'chat-studio-2', author: '旋律收藏家', content: '送出音乐盒', kind: 'gift' },
        ],
    },
]);

const LIVE_GIFTS = Object.freeze([
    { id: 'star', icon: '⭐', label: '小星星', value: 1 },
    { id: 'flower', icon: '🌷', label: '小花束', value: 10 },
    { id: 'drink', icon: '🥤', label: '应援饮料', value: 30 },
    { id: 'crown', icon: '👑', label: '闪耀皇冠', value: 99 },
]);

function clone(value) {
    return typeof globalThis.structuredClone === 'function'
        ? globalThis.structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function normalizeLiveScenes(value, fallback, stream = {}) {
    const source = Array.isArray(value) && value.length > 0
        ? value
        : Array.isArray(fallback) && fallback.length > 0
            ? fallback
            : [{ kind: 'narration', segment: stream.segment, text: stream.scene || stream.summary }];
    const scenes = source.map((scene, index) => {
        const kind = scene?.kind === 'dialogue' ? 'dialogue' : 'narration';
        const content = text(scene?.text, 800);
        if (!content) return null;
        return {
            id: text(scene?.id, 100) || `${text(stream.id, 80) || 'live'}-scene-${index + 1}`,
            kind,
            segment: text(scene?.segment, 80) || text(stream.segment, 80) || '直播进行中',
            text: content,
            ...(kind === 'dialogue' ? {
                speaker: text(scene?.speaker, 60) || text(stream.host, 60) || '主播',
                speakerRole: text(scene?.speakerRole, 60) || (stream.type === 'official' ? '现场发言' : '主播'),
            } : {}),
        };
    }).filter(Boolean);
    return scenes.length > 0 ? scenes : [{
        id: `${text(stream.id, 80) || 'live'}-scene-1`,
        kind: 'narration',
        segment: text(stream.segment, 80) || '直播进行中',
        text: text(stream.summary, 800) || '直播画面仍在继续。',
    }];
}

export function advancePhoneLiveSceneIndex(index, sceneCount) {
    const count = Math.max(0, Math.trunc(Number(sceneCount) || 0));
    if (count === 0) return 0;
    return (Math.max(0, Math.trunc(Number(index) || 0)) + 1) % count;
}

function normalizePhoneLiveRecord(value = {}) {
    const sessionId = text(value.sessionId ?? value.id, 120);
    const phases = (Array.isArray(value.phases) ? value.phases : []).map((phase, phaseIndex) => ({
        id: text(phase?.id, 120) || `${sessionId || 'live-record'}-phase-${phaseIndex + 1}`,
        summary: text(phase?.summary, 400),
        scenes: (Array.isArray(phase?.scenes) ? phase.scenes : []).map((scene, sceneIndex) => {
            const content = text(scene?.text, 800);
            if (!content) return null;
            const kind = scene?.kind === 'dialogue' ? 'dialogue' : 'narration';
            return {
                id: text(scene?.id, 120) || `${sessionId || 'live-record'}-scene-${phaseIndex + 1}-${sceneIndex + 1}`,
                kind,
                segment: text(scene?.segment, 80) || '直播片段',
                text: content,
                ...(kind === 'dialogue' ? {
                    speaker: text(scene?.speaker, 60) || '主播',
                    speakerRole: text(scene?.speakerRole, 60),
                } : {}),
            };
        }).filter(Boolean),
    })).filter(phase => phase.scenes.length > 0);
    if (!sessionId || phases.length === 0) return null;
    return {
        id: text(value.id, 120) || `live-record-${sessionId}`,
        sessionId,
        title: text(value.title, 120) || '一场直播',
        summary: text(value.sessionSummary ?? value.summary, 800),
        cover: text(value.cover, 80),
        setup: value.setup && typeof value.setup === 'object' ? clone(value.setup) : {},
        phases,
        peakViewers: Math.max(0, Math.trunc(Number(value.peakViewers) || 0)),
        followerDelta: Math.trunc(Number(value.followerDelta) || 0),
        startedAt: Math.max(0, Number(value.startedAt) || 0),
        endedAt: Math.max(0, Number(value.endedAt) || 0),
    };
}

export function buildPhoneLiveRecord(ownLive = {}) {
    return normalizePhoneLiveRecord(ownLive);
}

export function normalizePhoneLiveState(settings = {}) {
    settings.phone ??= {};
    const source = settings.phone.live && typeof settings.phone.live === 'object' ? settings.phone.live : {};
    const savedStreams = Array.isArray(source.streams) && source.streams.length > 0 ? clone(source.streams) : clone(SAMPLE_LIVE_STREAMS);
    const seeds = new Map(SAMPLE_LIVE_STREAMS.map(stream => [stream.id, stream]));
    const ownSource = source.ownLive && typeof source.ownLive === 'object' ? source.ownLive : {};
    const ownStatus = ['idle', 'live', 'ended'].includes(ownSource.status) ? ownSource.status : 'idle';
    const sourceProfile = source.profile && typeof source.profile === 'object' ? source.profile : {};
    const state = {
        profile: {
            accountId: text(sourceProfile.accountId, 120),
            isMask: Boolean(sourceProfile.isMask),
            nickname: text(sourceProfile.nickname, 80) || text(settings.phone.profile?.nickname, 80) || '我',
            avatar: text(sourceProfile.avatar, 4000),
            bio: text(sourceProfile.bio, 240),
            persona: text(sourceProfile.persona, 12_000),
        },
        streams: savedStreams.map(stream => {
            const seed = seeds.get(stream?.id);
            const merged = seed ? { ...clone(seed), ...stream } : stream;
            return {
                ...merged,
                scenes: normalizeLiveScenes(stream?.scenes, seed?.scenes, merged),
                barrages: Array.isArray(merged?.barrages) ? merged.barrages.map(message => text(message, 100)).filter(Boolean) : [],
                chats: Array.isArray(merged?.chats) ? merged.chats : [],
            };
        }),
        followedStreamIds: Array.isArray(source.followedStreamIds) ? [...new Set(source.followedStreamIds.map(String))] : [],
        ownLive: {
            status: ownStatus,
            sessionId: text(ownSource.sessionId, 120),
            title: text(ownSource.title, 120),
            summary: text(ownSource.summary, 300),
            cover: text(ownSource.cover, 80) || '我的直播间',
            setup: ownSource.setup && typeof ownSource.setup === 'object' ? clone(ownSource.setup) : {},
            phases: Array.isArray(ownSource.phases) ? clone(ownSource.phases).slice(-20) : [],
            records: (Array.isArray(ownSource.records) ? ownSource.records : [])
                .map(normalizePhoneLiveRecord).filter(Boolean),
            sessionSummary: text(ownSource.sessionSummary, 800),
            viewerCount: Math.max(0, Math.trunc(Number(ownSource.viewerCount) || 0)),
            peakViewers: Math.max(0, Math.trunc(Number(ownSource.peakViewers) || 0)),
            followerDelta: Math.trunc(Number(ownSource.followerDelta) || 0),
            giftTotal: Math.max(0, Math.trunc(Number(ownSource.giftTotal) || 0)),
            generating: Boolean(ownSource.generating),
            lastError: text(ownSource.lastError, 500),
            startedAt: Math.max(0, Number(ownSource.startedAt) || 0),
            endedAt: Math.max(0, Number(ownSource.endedAt) || 0),
        },
    };
    if (state.ownLive.status === 'ended') {
        const migratedRecord = buildPhoneLiveRecord(state.ownLive);
        if (migratedRecord && !state.ownLive.records.some(record => record.sessionId === migratedRecord.sessionId)) {
            state.ownLive.records.push(migratedRecord);
        }
    }
    settings.phone.live = state;
    return state;
}

function element(documentRef, tag, className = '', content = '') {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (content !== '') node.textContent = content;
    return node;
}

function button(documentRef, className, content, onClick) {
    const node = element(documentRef, 'button', className, content);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
}

function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createPhoneLiveController(options = {}) {
    const documentRef = options.document ?? globalThis.document;
    const settings = options.settings ?? {};
    const saveSettings = options.saveSettings ?? (() => {});
    const recordActivity = options.recordActivity ?? (() => undefined);
    const liveAiReady = options.liveAiReady ?? (() => false);
    const performLiveOperation = options.performLiveOperation ?? (async () => { throw new Error('直播生成功能尚未连接。'); });
    let state = normalizePhoneLiveState(settings);
    let root = null;
    let viewMode = 'home';
    let activeChannel = 'official';
    let activeStreamId = '';
    let barrageOffset = 0;
    let sceneIndex = 0;
    let playbackTimer = null;
    let giftTrayOpen = false;
    let stagePanelOpen = false;
    let selectedRecordId = '';
    let selectedBarrageIds = new Set();

    function ownStream() {
        const own = state.ownLive;
        const phase = own.phases.at(-1);
        if (!phase || !['live', 'ended'].includes(own.status)) return null;
        const profile = ownProfile();
        const barrages = (phase.barrages ?? []).map(item => text(item?.content ?? item, 100)).filter(Boolean);
        const chats = [
            ...(phase.barrages ?? []).map(item => ({ ...item, kind: 'message' })),
            ...(phase.gifts ?? []).map(item => ({ ...item, kind: 'gift', content: `送出 ${item.icon || '🎁'} ${item.label}` })),
        ];
        return {
            id: '__own_live__',
            type: 'private',
            isOwn: true,
            title: own.title,
            host: text(profile.nickname, 60) || '我',
            badge: own.status === 'ended' ? '直播已结束' : '我的直播',
            viewers: String(own.viewerCount),
            cover: own.cover,
            summary: own.summary,
            segment: phase.scenes?.[0]?.segment || '直播进行中',
            scenes: phase.scenes ?? [],
            barrages,
            barrageRecords: phase.barrages ?? [],
            chats,
        };
    }

    function currentStream() {
        if (activeStreamId === '__own_live__') return ownStream();
        return state.streams.find(stream => stream.id === activeStreamId) ?? null;
    }

    function stopPlayback() {
        if (playbackTimer) clearInterval(playbackTimer);
        playbackTimer = null;
    }

    function persist() {
        settings.phone.live = state;
        saveSettings();
    }

    function renderChannels(container) {
        const nav = element(documentRef, 'nav', 'memory-augment-live-channels');
        for (const [id, label] of PHONE_LIVE_CHANNELS) {
            nav.append(button(documentRef, id === activeChannel ? 'is-active' : '', label, () => {
                activeChannel = id;
                viewMode = 'home';
                selectedRecordId = '';
                render();
            }));
        }
        container.append(nav);
    }

    function renderHome(container) {
        renderChannels(container);
        const own = state.ownLive;
        if (activeChannel === 'mine') {
            renderSelfCenter(container);
            return;
        }
        const hero = element(documentRef, 'section', `memory-augment-live-hero is-${activeChannel}`);
        hero.append(
            element(documentRef, 'span', 'memory-augment-live-dot', 'LIVE'),
            element(documentRef, 'strong', '', activeChannel === 'official' ? '正在发生的大现场' : '与他们共享这一刻'),
        );
        container.append(hero);
        if (own.status === 'live') {
            const selfEntry = button(documentRef, 'memory-augment-live-self-entry', '', () => {
                activeStreamId = '__own_live__';
                sceneIndex = 0;
                barrageOffset = 0;
                selectedBarrageIds.clear();
                render();
            });
            const selfIcon = element(documentRef, 'span', '', text(ownProfile().nickname, 1) || '我');
            const selfCopy = element(documentRef, 'div');
            selfCopy.append(
                element(documentRef, 'strong', '', '我的直播正在进行'),
                element(documentRef, 'small', '', `${own.viewerCount} 人在线 · 回去继续播`),
            );
            const selfArrow = element(documentRef, 'i', 'fa-solid fa-chevron-right');
            selfEntry.append(selfIcon, selfCopy, selfArrow);
            container.append(selfEntry);
        }
        const list = element(documentRef, 'section', 'memory-augment-live-list');
        const streams = state.streams.filter(stream => stream.type === activeChannel);
        for (const stream of streams) {
            const card = button(documentRef, 'memory-augment-live-card', '', () => {
                activeStreamId = stream.id;
                barrageOffset = 0;
                sceneIndex = 0;
                giftTrayOpen = false;
                render();
            });
            const cover = element(documentRef, `div`, `memory-augment-live-card-cover is-${stream.type}`);
            cover.append(element(documentRef, 'span', '', '● 直播中'), element(documentRef, 'strong', '', text(stream.cover, 80)), element(documentRef, 'small', '', `${text(stream.viewers, 30)} 人观看`));
            const copy = element(documentRef, 'div');
            const badge = element(documentRef, 'span', `memory-augment-live-badge is-${stream.type}`, text(stream.badge, 30));
            copy.append(badge, element(documentRef, 'strong', '', text(stream.title, 120)), element(documentRef, 'p', '', text(stream.summary, 240)));
            const host = element(documentRef, 'small', '', `@ ${text(stream.host, 60)}`);
            copy.append(host);
            card.append(cover, copy);
            list.append(card);
        }
        container.append(list);
    }

    function ownProfile() {
        return settings.phone?.live?.profile ?? settings.phone?.profile ?? { nickname: '我', bio: '' };
    }

    function boundRoleAccounts() {
        return (settings.phone?.weibo?.roleAccounts ?? [])
            .filter(account => account?.identity?.mode !== 'unbound');
    }

    function ownStat(label, value) {
        const item = element(documentRef, 'div', 'memory-augment-live-own-stat');
        item.append(element(documentRef, 'strong', '', String(value)), element(documentRef, 'small', '', label));
        return item;
    }

    function renderOwnSummary(container) {
        const own = state.ownLive;
        const summary = element(documentRef, 'section', 'memory-augment-live-own-summary');
        summary.append(
            element(documentRef, 'strong', '', own.title || '上一场直播'),
            element(documentRef, 'p', '', own.sessionSummary || own.summary || '这场直播已经结束。'),
        );
        const stats = element(documentRef, 'div', 'memory-augment-live-own-stats');
        stats.append(
            ownStat('最高在线', own.peakViewers),
            ownStat('新增粉丝', own.followerDelta >= 0 ? `+${own.followerDelta}` : own.followerDelta),
            ownStat('礼物心意', own.giftTotal),
            ownStat('直播阶段', own.phases.length),
        );
        summary.append(stats);
        container.append(summary);
    }

    function formatLiveRecordTime(timestamp) {
        const value = Number(timestamp);
        if (!Number.isFinite(value) || value <= 0) return '时间未知';
        try {
            return new Intl.DateTimeFormat('zh-CN', {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false,
            }).format(new Date(value));
        } catch {
            return new Date(value).toLocaleString();
        }
    }

    function renderOwnRecords(container) {
        const section = element(documentRef, 'section', 'memory-augment-live-records');
        const heading = element(documentRef, 'header');
        heading.append(
            element(documentRef, 'strong', '', '直播记录'),
            element(documentRef, 'small', '', `${state.ownLive.records.length} 场`),
        );
        section.append(heading);
        if (state.ownLive.records.length === 0) {
            section.append(element(documentRef, 'p', 'is-empty', '暂无直播记录'));
        } else {
            const list = element(documentRef, 'div', 'memory-augment-live-record-list');
            [...state.ownLive.records].reverse().forEach(record => {
                const sceneCount = record.phases.reduce((total, phase) => total + phase.scenes.length, 0);
                const card = button(documentRef, 'memory-augment-live-record-card', '', () => {
                    selectedRecordId = record.id;
                    viewMode = 'record';
                    render();
                });
                const copy = element(documentRef, 'div');
                copy.append(
                    element(documentRef, 'strong', '', record.title),
                    element(documentRef, 'p', '', record.summary || '这场直播留下了一些画面。'),
                    element(documentRef, 'small', '', `${formatLiveRecordTime(record.endedAt || record.startedAt)} · ${record.phases.length} 阶段 · ${sceneCount} 段`),
                );
                card.append(copy, element(documentRef, 'i', 'fa-solid fa-chevron-right'));
                list.append(card);
            });
            section.append(list);
        }
        container.append(section);
    }

    function renderRecordDetail(container) {
        const record = state.ownLive.records.find(item => item.id === selectedRecordId);
        if (!record) {
            viewMode = 'home';
            activeChannel = 'mine';
            renderHome(container);
            return;
        }
        const header = element(documentRef, 'header', 'memory-augment-live-own-header');
        const back = button(documentRef, '', '', () => {
            selectedRecordId = '';
            viewMode = 'home';
            activeChannel = 'mine';
            render();
        });
        back.append(element(documentRef, 'i', 'fa-solid fa-chevron-left'));
        header.append(back, element(documentRef, 'strong', '', '直播记录'));
        container.append(header);

        const intro = element(documentRef, 'section', 'memory-augment-live-record-intro');
        intro.append(
            element(documentRef, 'small', '', formatLiveRecordTime(record.endedAt || record.startedAt)),
            element(documentRef, 'strong', '', record.title),
            element(documentRef, 'p', '', record.summary || '这场直播已经结束。'),
        );
        container.append(intro);

        const transcript = element(documentRef, 'section', 'memory-augment-live-record-transcript');
        record.phases.forEach((phase, phaseIndex) => {
            const phaseBlock = element(documentRef, 'article');
            const phaseHeader = element(documentRef, 'header');
            phaseHeader.append(
                element(documentRef, 'strong', '', `阶段 ${phaseIndex + 1}`),
                element(documentRef, 'small', '', phase.summary),
            );
            phaseBlock.append(phaseHeader);
            phase.scenes.forEach(scene => {
                const sceneBlock = element(documentRef, 'div', `is-${scene.kind}`);
                const label = scene.kind === 'dialogue'
                    ? `${scene.speaker}${scene.speakerRole ? ` · ${scene.speakerRole}` : ''}`
                    : '画面旁白';
                sceneBlock.append(
                    element(documentRef, 'small', '', `${scene.segment} · ${label}`),
                    element(documentRef, 'p', '', scene.text),
                );
                phaseBlock.append(sceneBlock);
            });
            transcript.append(phaseBlock);
        });
        container.append(transcript);
    }

    function renderSelfCenter(container) {
        const profile = ownProfile();
        const card = element(documentRef, 'section', 'memory-augment-live-own-profile');
        const avatar = element(documentRef, 'span', 'memory-augment-live-own-avatar', text(profile.nickname, 1) || '我');
        const copy = element(documentRef, 'div');
        copy.append(
            element(documentRef, 'strong', '', text(profile.nickname, 60) || '我'),
            element(documentRef, 'p', '', text(profile.bio, 180) || '欢迎来到我的直播间。'),
        );
        card.append(avatar, copy);
        container.append(card);

        const own = state.ownLive;
        const action = element(documentRef, 'section', 'memory-augment-live-own-action');
        if (own.status === 'live') {
            action.append(
                element(documentRef, 'strong', '', own.title || '直播进行中'),
                element(documentRef, 'p', '', `${own.viewerCount} 人在线 · 已进行 ${own.phases.length} 个阶段`),
                button(documentRef, 'is-primary', '回到直播', () => {
                    activeStreamId = '__own_live__';
                    sceneIndex = 0;
                    barrageOffset = 0;
                    selectedBarrageIds.clear();
                    render();
                }),
            );
        } else {
            action.append(
                element(documentRef, 'strong', '', own.status === 'ended' ? '还想再播一场？' : '准备开一场自己的直播'),
                button(documentRef, 'is-primary', own.status === 'ended' ? '再开一场' : '开始设置', () => {
                    viewMode = 'setup';
                    render();
                }),
            );
        }
        container.append(action);
        renderOwnRecords(container);
    }

    function field(label, control) {
        const wrapper = element(documentRef, 'label', 'memory-augment-live-field');
        wrapper.append(element(documentRef, 'strong', '', label), control);
        return wrapper;
    }

    function renderChoiceGroup(name, choices, defaultValue) {
        const group = element(documentRef, 'div', 'memory-augment-live-choice-group');
        choices.forEach(([value, label], index) => {
            const choice = element(documentRef, 'label');
            const input = element(documentRef, 'input');
            input.type = 'radio';
            input.name = name;
            input.value = value;
            input.checked = value === defaultValue || (!defaultValue && index === 0);
            choice.append(input, element(documentRef, 'span', '', label));
            group.append(choice);
        });
        return group;
    }

    function renderOwnSetup(container) {
        const header = element(documentRef, 'header', 'memory-augment-live-own-header');
        const back = button(documentRef, '', '', () => {
            viewMode = 'home';
            activeChannel = 'mine';
            render();
        });
        back.append(element(documentRef, 'i', 'fa-solid fa-chevron-left'));
        header.append(back, element(documentRef, 'strong', '', '开播设置'));
        container.append(header);

        const form = element(documentRef, 'form', 'memory-augment-live-setup');
        const title = element(documentRef, 'input');
        title.name = 'title';
        title.maxLength = 120;
        title.placeholder = '例如：今晚随便聊聊';
        title.required = true;
        const topic = element(documentRef, 'textarea');
        topic.name = 'topic';
        topic.maxLength = 500;
        topic.rows = 3;
        topic.placeholder = '这次主要想播什么？';
        topic.required = true;
        const location = element(documentRef, 'input');
        location.name = 'location';
        location.maxLength = 120;
        location.placeholder = '可不填，例如：家里、片场休息室';
        const speech = element(documentRef, 'textarea');
        speech.name = 'speech';
        speech.maxLength = 500;
        speech.rows = 2;
        speech.placeholder = '想说什么？';
        const direction = element(documentRef, 'textarea');
        direction.name = 'direction';
        direction.maxLength = 800;
        direction.rows = 3;
        direction.placeholder = '例如：先和观众打招呼，再聊今天发生的事';

        form.append(
            field('直播标题', title),
            field('本场主题', topic),
            field('直播类型', renderChoiceGroup('format', PHONE_LIVE_FORMATS, 'chat')),
            field('直播性质', renderChoiceGroup('nature', PHONE_LIVE_NATURES, 'casual')),
            field('直播地点', location),
        );

        const participants = boundRoleAccounts();
        const participantGroup = element(documentRef, 'div', 'memory-augment-live-participants');
        if (participants.length === 0) {
            participantGroup.append(element(documentRef, 'p', 'is-empty', '暂无可选参与者'));
        } else {
            for (const account of participants) {
                const choice = element(documentRef, 'label');
                const input = element(documentRef, 'input');
                input.type = 'checkbox';
                input.name = 'participant';
                input.value = account.id;
                choice.append(input, element(documentRef, 'span', '', text(account.nickname, 60)));
                participantGroup.append(choice);
            }
        }
        form.append(
            field('谁会参与', participantGroup),
            field('开场时我会说', speech),
            field('开场大概怎么播', direction),
        );

        const feedback = element(documentRef, 'p', 'memory-augment-live-form-feedback');
        const submit = button(documentRef, 'memory-augment-live-submit', '生成并开播');
        submit.type = 'submit';
        form.append(feedback, submit);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!liveAiReady()) {
                feedback.textContent = '请先配置弹幕/手机共用的 API。';
                feedback.classList.add('is-error');
                return;
            }
            const data = new FormData(form);
            const operation = {
                type: 'start',
                sessionId: makeId('own-live'),
                title: text(data.get('title'), 120),
                topic: text(data.get('topic'), 500),
                format: text(data.get('format'), 40) || 'chat',
                nature: text(data.get('nature'), 40) || 'casual',
                location: text(data.get('location'), 120),
                participantIds: data.getAll('participant').map(String),
                speech: text(data.get('speech'), 500),
                direction: text(data.get('direction'), 800) || text(data.get('topic'), 500),
                selectedBarrages: [],
            };
            submit.disabled = true;
            feedback.classList.remove('is-error');
            feedback.textContent = '正在生成直播间和第一阶段，请稍等……';
            try {
                await performLiveOperation(operation);
                state = normalizePhoneLiveState(settings);
                viewMode = 'home';
                activeChannel = 'mine';
                activeStreamId = '__own_live__';
                sceneIndex = 0;
                barrageOffset = 0;
                selectedBarrageIds.clear();
                render();
            } catch (error) {
                state = normalizePhoneLiveState(settings);
                feedback.textContent = text(error?.message, 500) || '生成失败，请稍后重试。';
                feedback.classList.add('is-error');
                submit.disabled = false;
            }
        });
        container.append(form);
    }

    function renderFloatingBarrages(stage, stream) {
        const layer = element(documentRef, 'div', 'memory-augment-live-floating-barrages');
        const messages = Array.isArray(stream.barrages) ? stream.barrages : [];
        const visible = messages.length > 0
            ? [0, 1, 2].map(index => messages[(barrageOffset + index) % messages.length]).filter(Boolean)
            : [];
        visible.forEach((message, index) => {
            const line = element(documentRef, 'span', `is-lane-${index + 1}`, text(message, 100));
            layer.append(line);
        });
        stage.append(layer);
    }

    function renderStageFrame(stage, stream) {
        const scenes = Array.isArray(stream.scenes) ? stream.scenes : [];
        const safeIndex = scenes.length > 0 ? sceneIndex % scenes.length : 0;
        const scene = scenes[safeIndex] ?? normalizeLiveScenes([], [], stream)[0];
        stage.replaceChildren();
        stage.classList.toggle('is-dialogue', scene.kind === 'dialogue');
        stage.classList.toggle('is-narration', scene.kind !== 'dialogue');
        stage.setAttribute('aria-label', `直播画面，第 ${safeIndex + 1} 幕，共 ${Math.max(1, scenes.length)} 幕，点击继续`);

        const sceneLabel = element(documentRef, 'header');
        const isEndedReplay = stream.isOwn && state.ownLive.status === 'ended';
        sceneLabel.append(element(documentRef, 'span', '', isEndedReplay ? '■ 回放' : '● LIVE'), element(documentRef, 'small', '', text(scene.segment, 80)));
        stage.append(sceneLabel);

        const copy = element(documentRef, 'div', `memory-augment-live-stage-copy is-${scene.kind}`);
        const copyHeader = element(documentRef, 'header');
        copyHeader.append(
            element(documentRef, 'strong', '', scene.kind === 'dialogue' ? text(scene.speaker, 60) : '画面'),
            element(documentRef, 'small', '', scene.kind === 'dialogue' ? text(scene.speakerRole, 60) : '场景旁白'),
        );
        copy.append(copyHeader, element(documentRef, 'p', '', text(scene.text, 800)));
        const progress = element(documentRef, 'footer');
        progress.append(element(documentRef, 'span', '', `${safeIndex + 1} / ${Math.max(1, scenes.length)}`));
        copy.append(progress);
        stage.append(copy);
        renderFloatingBarrages(stage, stream);
    }

    function liveChatItems(stream) {
        if (stream.type !== 'official') return stream.chats ?? [];
        const messages = Array.isArray(stream.barrages) ? stream.barrages : [];
        const count = Math.min(6, messages.length);
        return Array.from({ length: count }, (_, index) => ({
            author: `观众${String(index + 1).padStart(2, '0')}`,
            content: messages[(barrageOffset + index) % messages.length],
            kind: 'message',
        }));
    }

    function fillChatList(list, stream) {
        list.replaceChildren();
        for (const item of liveChatItems(stream)) {
            const row = element(documentRef, 'p', item.kind === 'gift' ? 'is-gift' : item.mine ? 'is-mine' : '');
            row.append(element(documentRef, 'strong', '', item.mine ? '我' : text(item.author, 50)), documentRef.createTextNode(` ${text(item.content, 180)}`));
            list.append(row);
        }
        (globalThis.requestAnimationFrame ?? globalThis.setTimeout)(() => {
            list.scrollTop = stream.type === 'private' && !stream.isOwn ? list.scrollHeight : 0;
        }, 0);
    }

    function renderChatList(container, stream) {
        const chat = element(documentRef, 'section', 'memory-augment-live-chat');
        const heading = element(documentRef, 'header');
        heading.append(
            element(documentRef, 'strong', '', stream.isOwn ? '本阶段弹幕' : stream.type === 'official' ? '实时弹幕' : '直播互动'),
        );
        chat.append(heading);
        const list = element(documentRef, 'div', 'memory-augment-live-chat-list');
        fillChatList(list, stream);
        chat.append(list);
        container.append(chat);
    }

    function sendMessage(stream, value) {
        const content = text(value, 120);
        if (!content) return false;
        stream.chats ??= [];
        const entry = { id: makeId('live-chat'), author: '我', content, kind: 'message', mine: true };
        stream.chats.push(entry);
        if (stream.chats.length > 40) stream.chats.splice(0, stream.chats.length - 40);
        persist();
        void recordActivity({
            app: 'live',
            tier: 'public_personal',
            accountId: state.profile.accountId,
            isMask: state.profile.isMask,
            summary: `在“${text(stream.title, 120)}”直播间对${text(stream.host, 60)}说：“${content}”`,
            participants: [text(stream.host, 60)].filter(Boolean),
            sourceKey: `live-chat:${entry.id}`,
        });
        render();
        return true;
    }

    function sendGift(stream, gift) {
        stream.chats ??= [];
        const entry = { id: makeId('live-gift'), author: '我', content: `送出 ${gift.icon} ${gift.label}`, kind: 'gift', mine: true };
        stream.chats.push(entry);
        if (stream.chats.length > 40) stream.chats.splice(0, stream.chats.length - 40);
        giftTrayOpen = false;
        persist();
        void recordActivity({
            app: 'live',
            tier: 'public_personal',
            accountId: state.profile.accountId,
            isMask: state.profile.isMask,
            summary: `在“${text(stream.title, 120)}”直播间给${text(stream.host, 60)}送出${gift.label}`,
            participants: [text(stream.host, 60)].filter(Boolean),
            sourceKey: `live-gift:${entry.id}`,
        });
        render();
    }

    function renderPrivateComposer(container, stream) {
        if (giftTrayOpen) {
            const tray = element(documentRef, 'section', 'memory-augment-live-gift-tray');
            const heading = element(documentRef, 'header');
            heading.append(element(documentRef, 'strong', '', '送个小礼物'), button(documentRef, '', '收起', () => { giftTrayOpen = false; render(); }));
            tray.append(heading);
            const gifts = element(documentRef, 'div');
            for (const gift of LIVE_GIFTS) {
                const choice = button(documentRef, '', '', () => sendGift(stream, gift));
                choice.append(element(documentRef, 'span', '', gift.icon), element(documentRef, 'strong', '', gift.label), element(documentRef, 'small', '', `${gift.value} 心意`));
                gifts.append(choice);
            }
            tray.append(gifts);
            container.append(tray);
        }

        const form = element(documentRef, 'form', 'memory-augment-live-composer');
        form.autocomplete = 'off';
        const input = element(documentRef, 'input');
        input.type = 'text';
        input.name = 'live-message';
        input.maxLength = 120;
        input.placeholder = '和主播说点什么…';
        const gift = button(documentRef, 'is-gift', '🎁', () => { giftTrayOpen = !giftTrayOpen; render(); });
        gift.setAttribute('aria-label', '打开礼物区');
        const send = button(documentRef, 'is-send', '发送');
        send.type = 'submit';
        form.append(input, gift, send);
        form.addEventListener('submit', event => {
            event.preventDefault();
            if (sendMessage(stream, input.value)) input.value = '';
            else input.focus();
        });
        container.append(form);
    }

    function renderOwnStagePanel(container) {
        const own = state.ownLive;
        if (own.status === 'ended') {
            const ended = element(documentRef, 'section', 'memory-augment-live-stage-panel is-ended');
            ended.append(element(documentRef, 'strong', '', '直播已结束'));
            renderOwnSummary(ended);
            ended.append(button(documentRef, 'memory-augment-live-submit', '返回我的直播', () => {
                activeStreamId = '';
                viewMode = 'home';
                activeChannel = 'mine';
                render();
            }));
            container.append(ended);
            return;
        }

        const phase = own.phases.at(-1);
        const overlay = element(documentRef, 'div', 'memory-augment-live-stage-overlay');
        overlay.addEventListener('click', event => {
            if (event.target !== overlay || own.generating) return;
            stagePanelOpen = false;
            render();
        });
        const panel = element(documentRef, 'section', 'memory-augment-live-stage-panel');
        const panelHeader = element(documentRef, 'header', 'memory-augment-live-stage-panel-header');
        const close = button(documentRef, '', '', () => {
            if (own.generating) return;
            stagePanelOpen = false;
            render();
        });
        close.setAttribute('aria-label', '关闭推进面板');
        close.append(element(documentRef, 'i', 'fa-solid fa-xmark'));
        panelHeader.append(element(documentRef, 'strong', '', `准备第 ${own.phases.length + 1} 个阶段`), close);
        panel.append(panelHeader);

        const speech = element(documentRef, 'textarea');
        speech.maxLength = 500;
        speech.rows = 2;
        speech.placeholder = '想说什么？';
        const direction = element(documentRef, 'textarea');
        direction.maxLength = 800;
        direction.rows = 3;
        direction.placeholder = '接下来大概要做什么？例如：回答刚才的问题，然后开始打游戏';
        panel.append(field('这一阶段我会说', speech), field('接下来怎么播', direction));

        const picker = element(documentRef, 'details', 'memory-augment-live-barrage-picker');
        const pickerTitle = element(documentRef, 'summary');
        const pickerCount = element(documentRef, 'span', '', selectedBarrageIds.size ? `已选 ${selectedBarrageIds.size} 条` : '展开选择');
        pickerTitle.append(element(documentRef, 'strong', '', '挑弹幕回复'), pickerCount);
        picker.append(pickerTitle);
        const choices = element(documentRef, 'div', 'memory-augment-live-barrage-choices');
        const barrages = (phase?.barrages ?? []).filter(item => item?.replyable !== false);
        if (barrages.length === 0) {
            choices.append(element(documentRef, 'p', 'is-empty', '这一阶段没有可选择的弹幕。'));
        } else {
            barrages.forEach(item => {
                const choice = button(documentRef, selectedBarrageIds.has(item.id) ? 'is-selected' : '', '', () => {
                    if (selectedBarrageIds.has(item.id)) selectedBarrageIds.delete(item.id);
                    else selectedBarrageIds.add(item.id);
                    choice.classList.toggle('is-selected', selectedBarrageIds.has(item.id));
                    choice.setAttribute('aria-pressed', String(selectedBarrageIds.has(item.id)));
                    pickerCount.textContent = selectedBarrageIds.size ? `已选 ${selectedBarrageIds.size} 条` : '展开选择';
                });
                choice.setAttribute('aria-pressed', String(selectedBarrageIds.has(item.id)));
                choice.append(
                    element(documentRef, 'strong', '', text(item.author, 60)),
                    element(documentRef, 'span', '', text(item.content, 160)),
                    element(documentRef, 'small', '', `♡ ${Math.max(0, Number(item.likes) || 0)}`),
                );
                choices.append(choice);
            });
        }
        picker.append(choices);
        panel.append(picker);

        const feedback = element(documentRef, 'p', 'memory-augment-live-form-feedback');
        if (own.lastError) {
            feedback.textContent = own.lastError;
            feedback.classList.add('is-error');
        }
        const actions = element(documentRef, 'div', 'memory-augment-live-stage-actions');
        const next = button(documentRef, 'is-primary', own.generating ? '正在生成……' : '生成下一阶段');
        const end = button(documentRef, 'is-danger', '下播');
        next.disabled = own.generating;
        end.disabled = own.generating;
        actions.append(next, end);
        panel.append(feedback, actions);

        const submitOperation = async type => {
            if (!liveAiReady()) {
                feedback.textContent = '请先配置弹幕/手机共用的 API。';
                feedback.classList.add('is-error');
                return;
            }
            const selectedBarrages = barrages
                .filter(item => selectedBarrageIds.has(item.id))
                .map(item => ({ id: item.id, author: item.author, content: item.content }));
            const operation = {
                type,
                speech: text(speech.value, 500),
                direction: text(direction.value, 800) || (type === 'end' ? '自然收束本场直播，回应必要的弹幕并向观众告别。' : '自然延续当前直播内容。'),
                selectedBarrages,
            };
            next.disabled = true;
            end.disabled = true;
            feedback.classList.remove('is-error');
            feedback.textContent = type === 'end' ? '正在生成收尾并下播……' : '正在生成下一个阶段……';
            state.ownLive.generating = true;
            state.ownLive.lastError = '';
            persist();
            stagePanelOpen = false;
            render();
            try {
                await performLiveOperation(operation);
                state = normalizePhoneLiveState(settings);
                selectedBarrageIds.clear();
                sceneIndex = 0;
                barrageOffset = 0;
                stagePanelOpen = false;
                render();
            } catch (error) {
                state = normalizePhoneLiveState(settings);
                state.ownLive.generating = false;
                state.ownLive.lastError = text(error?.message, 500) || '生成失败，请稍后重试。';
                persist();
                render();
            }
        };
        next.addEventListener('click', () => submitOperation('next'));
        end.addEventListener('click', () => submitOperation('end'));
        overlay.append(panel);
        container.append(overlay);
    }

    function renderRoom(container, stream) {
        const room = element(documentRef, 'section', `memory-augment-live-room is-${stream.type}`);
        const roomHeader = element(documentRef, 'header', 'memory-augment-live-room-header');
        const back = button(documentRef, '', '', () => {
            stopPlayback();
            activeStreamId = '';
            sceneIndex = 0;
            stagePanelOpen = false;
            if (stream.isOwn) {
                viewMode = 'home';
                activeChannel = 'mine';
            }
            render();
        });
        const backIcon = element(documentRef, 'i', 'fa-solid fa-chevron-left');
        backIcon.setAttribute('aria-hidden', 'true');
        back.setAttribute('aria-label', stream.isOwn ? '返回我的直播' : '返回直播列表');
        back.append(backIcon);
        const identity = element(documentRef, 'div');
        const audienceLabel = stream.isOwn && state.ownLive.status === 'ended'
            ? `结束时 ${text(stream.viewers, 30)} 人`
            : `${text(stream.viewers, 30)} 在线`;
        identity.append(element(documentRef, 'strong', '', text(stream.host, 60)), element(documentRef, 'small', '', `${text(stream.badge, 30)} · ${audienceLabel}`));
        let follow;
        if (stream.isOwn && state.ownLive.status === 'ended') {
            follow = element(documentRef, 'span', 'memory-augment-live-own-badge', '已下播');
        } else if (stream.isOwn) {
            follow = button(documentRef, `memory-augment-live-advance-button${state.ownLive.generating ? ' is-generating' : ''}`, '', () => {
                if (state.ownLive.generating) return;
                    stagePanelOpen = true;
                    render();
                });
            follow.disabled = state.ownLive.generating;
            follow.setAttribute('aria-label', state.ownLive.generating ? '正在生成直播阶段' : '推进直播');
            if (state.ownLive.generating) follow.append(element(documentRef, 'i', 'fa-solid fa-spinner'));
            follow.append(element(documentRef, 'span', '', state.ownLive.generating ? '生成中' : '推进'));
        } else {
            follow = button(documentRef, state.followedStreamIds.includes(stream.id) ? 'is-followed' : '', state.followedStreamIds.includes(stream.id) ? '已关注' : '关注', () => {
                const index = state.followedStreamIds.indexOf(stream.id);
                if (index >= 0) state.followedStreamIds.splice(index, 1);
                else state.followedStreamIds.push(stream.id);
                persist();
                render();
            });
        }
        roomHeader.append(back, identity, follow);
        room.append(roomHeader);

        const stage = element(documentRef, 'section', `memory-augment-live-stage is-${stream.type}`);
        stage.tabIndex = 0;
        stage.setAttribute('role', 'button');
        const advanceScene = () => {
            sceneIndex = advancePhoneLiveSceneIndex(sceneIndex, stream.scenes?.length);
            renderStageFrame(stage, stream);
        };
        stage.addEventListener('click', advanceScene);
        stage.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            advanceScene();
        });
        renderStageFrame(stage, stream);
        room.append(stage);

        renderChatList(room, stream);
        if (stream.isOwn && state.ownLive.status === 'ended') renderOwnStagePanel(room);
        else if (!stream.isOwn && stream.type === 'private') renderPrivateComposer(room, stream);
        container.append(room);
    }

    function startPlayback() {
        stopPlayback();
        const stream = currentStream();
        if (!stream || (stream.isOwn && state.ownLive.status === 'ended') || !Array.isArray(stream.barrages) || stream.barrages.length < 2) return;
        playbackTimer = setInterval(() => {
            if (!root || !activeStreamId) return stopPlayback();
            barrageOffset = (barrageOffset + 1) % stream.barrages.length;
            const stage = root.querySelector('.memory-augment-live-stage');
            const oldLayer = stage?.querySelector('.memory-augment-live-floating-barrages');
            oldLayer?.remove();
            if (stage) renderFloatingBarrages(stage, stream);
            const list = root.querySelector('.memory-augment-live-chat-list');
            if (list && stream.type === 'official') fillChatList(list, stream);
        }, 3200);
    }

    function render() {
        if (!root) return;
        stopPlayback();
        root.replaceChildren();
        root.classList.remove('is-messages', 'is-weibo', 'is-community', 'is-live');
        root.classList.add('is-live');
        const view = element(documentRef, 'div', 'memory-augment-live-view');
        const stream = currentStream();
        if (stream) renderRoom(view, stream);
        else if (viewMode === 'setup') renderOwnSetup(view);
        else if (viewMode === 'record') renderRecordDetail(view);
        else renderHome(view);
        root.append(view);
        if (stream?.isOwn && state.ownLive.status === 'live' && stagePanelOpen) renderOwnStagePanel(root);
        if (stream) startPlayback();
    }

    globalThis.addEventListener?.('memory-augment-phone-world-updated', event => {
        if (!event?.detail?.modules?.includes?.('live')) return;
        state = normalizePhoneLiveState(settings);
        if (activeStreamId && activeStreamId !== '__own_live__'
            && !state.streams.some(stream => stream.id === activeStreamId)) {
            activeStreamId = '';
            sceneIndex = 0;
        }
        if (root) render();
    });

    return {
        async open(container) {
            root = container;
            state = normalizePhoneLiveState(settings);
            render();
        },
        back() {
            if (activeStreamId) {
                stopPlayback();
                const wasOwn = activeStreamId === '__own_live__';
                activeStreamId = '';
                sceneIndex = 0;
                stagePanelOpen = false;
                if (wasOwn) {
                    viewMode = 'home';
                    activeChannel = 'mine';
                }
                render();
                return true;
            }
            if (viewMode === 'setup') {
                viewMode = 'home';
                activeChannel = 'mine';
                render();
                return true;
            }
            if (viewMode === 'record') {
                selectedRecordId = '';
                viewMode = 'home';
                activeChannel = 'mine';
                render();
                return true;
            }
            return false;
        },
        close() {
            stopPlayback();
        },
        getState: () => state,
    };
}
