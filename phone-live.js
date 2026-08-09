import { cleanPhoneText as text } from './phone-utils.js';

export const PHONE_LIVE_CHANNELS = Object.freeze([
    ['official', '官方直播'],
    ['private', '私人直播'],
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

export function normalizePhoneLiveState(settings = {}) {
    settings.phone ??= {};
    const source = settings.phone.live && typeof settings.phone.live === 'object' ? settings.phone.live : {};
    const state = {
        streams: Array.isArray(source.streams) && source.streams.length > 0 ? clone(source.streams) : clone(SAMPLE_LIVE_STREAMS),
        followedStreamIds: Array.isArray(source.followedStreamIds) ? [...new Set(source.followedStreamIds.map(String))] : [],
    };
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
    const state = normalizePhoneLiveState(settings);
    let root = null;
    let activeChannel = 'official';
    let activeStreamId = '';
    let barrageOffset = 0;
    let playbackTimer = null;
    let giftTrayOpen = false;

    function currentStream() {
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
                render();
            }));
        }
        container.append(nav);
    }

    function renderHome(container) {
        renderChannels(container);
        const hero = element(documentRef, `section`, `memory-augment-live-hero is-${activeChannel}`);
        const liveDot = element(documentRef, 'span', 'memory-augment-live-dot', 'LIVE');
        hero.append(liveDot, element(documentRef, 'strong', '', activeChannel === 'official' ? '正在发生的大现场' : '与他们共享这一刻'), element(documentRef, 'small', '', activeChannel === 'official' ? '活动、节目与公开行程实时放送' : '距离更近，也可以发送消息互动'));
        container.append(hero);

        const list = element(documentRef, 'section', 'memory-augment-live-list');
        const streams = state.streams.filter(stream => stream.type === activeChannel);
        for (const stream of streams) {
            const card = button(documentRef, 'memory-augment-live-card', '', () => {
                activeStreamId = stream.id;
                barrageOffset = 0;
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

    function renderChatList(container, stream) {
        const chat = element(documentRef, 'section', 'memory-augment-live-chat');
        const heading = element(documentRef, 'header');
        heading.append(element(documentRef, 'strong', '', stream.type === 'official' ? '实时弹幕' : '直播互动'), element(documentRef, 'small', '', stream.type === 'official' ? '正在滚动播放' : '主播可能会看到你的消息'));
        chat.append(heading);
        const list = element(documentRef, 'div', 'memory-augment-live-chat-list');
        const source = stream.type === 'official'
            ? (stream.barrages ?? []).slice(Math.max(0, barrageOffset - 1), barrageOffset + 5).map((content, index) => ({ author: `观众${String(index + 1).padStart(2, '0')}`, content, kind: 'message' }))
            : stream.chats ?? [];
        for (const item of source) {
            const row = element(documentRef, 'p', item.kind === 'gift' ? 'is-gift' : item.mine ? 'is-mine' : '');
            row.append(element(documentRef, 'strong', '', item.mine ? '我' : text(item.author, 50)), documentRef.createTextNode(` ${text(item.content, 180)}`));
            list.append(row);
        }
        chat.append(list);
        container.append(chat);
        requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    }

    function sendMessage(stream, value) {
        const content = text(value, 120);
        if (!content) return false;
        stream.chats ??= [];
        stream.chats.push({ id: makeId('live-chat'), author: '我', content, kind: 'message', mine: true });
        if (stream.chats.length > 40) stream.chats.splice(0, stream.chats.length - 40);
        persist();
        render();
        return true;
    }

    function sendGift(stream, gift) {
        stream.chats ??= [];
        stream.chats.push({ id: makeId('live-gift'), author: '我', content: `送出 ${gift.icon} ${gift.label}`, kind: 'gift', mine: true });
        if (stream.chats.length > 40) stream.chats.splice(0, stream.chats.length - 40);
        giftTrayOpen = false;
        persist();
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

    function renderRoom(container, stream) {
        const room = element(documentRef, 'section', `memory-augment-live-room is-${stream.type}`);
        const roomHeader = element(documentRef, 'header', 'memory-augment-live-room-header');
        const back = button(documentRef, '', '', () => {
            stopPlayback();
            activeStreamId = '';
            render();
        });
        const backIcon = element(documentRef, 'i', 'fa-solid fa-chevron-left');
        backIcon.setAttribute('aria-hidden', 'true');
        back.append(backIcon);
        const identity = element(documentRef, 'div');
        identity.append(element(documentRef, 'strong', '', text(stream.host, 60)), element(documentRef, 'small', '', `${text(stream.badge, 30)} · ${text(stream.viewers, 30)} 在线`));
        const follow = button(documentRef, state.followedStreamIds.includes(stream.id) ? 'is-followed' : '', state.followedStreamIds.includes(stream.id) ? '已关注' : '关注', () => {
            const index = state.followedStreamIds.indexOf(stream.id);
            if (index >= 0) state.followedStreamIds.splice(index, 1);
            else state.followedStreamIds.push(stream.id);
            persist();
            render();
        });
        roomHeader.append(back, identity, follow);
        room.append(roomHeader);

        const stage = element(documentRef, 'section', `memory-augment-live-stage is-${stream.type}`);
        const sceneLabel = element(documentRef, 'header');
        sceneLabel.append(element(documentRef, 'span', '', '● LIVE'), element(documentRef, 'small', '', text(stream.segment, 80)));
        const scene = element(documentRef, 'p', '', text(stream.scene, 800));
        stage.append(sceneLabel, scene);
        renderFloatingBarrages(stage, stream);
        room.append(stage);

        if (stream.type === 'official') {
            const notice = element(documentRef, 'div', 'memory-augment-live-official-notice');
            notice.append(element(documentRef, 'i', 'fa-solid fa-tower-broadcast'), element(documentRef, 'span', '', '官方直播以现场画面与观众弹幕为主'));
            room.append(notice);
        }
        renderChatList(room, stream);
        if (stream.type === 'private') renderPrivateComposer(room, stream);
        container.append(room);
    }

    function startPlayback() {
        stopPlayback();
        const stream = currentStream();
        if (!stream || !Array.isArray(stream.barrages) || stream.barrages.length < 2) return;
        playbackTimer = setInterval(() => {
            if (!root || !activeStreamId) return stopPlayback();
            barrageOffset = (barrageOffset + 1) % stream.barrages.length;
            render();
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
        else renderHome(view);
        root.append(view);
        if (stream) startPlayback();
    }

    return {
        async open(container) {
            root = container;
            render();
        },
        back() {
            if (!activeStreamId) return false;
            stopPlayback();
            activeStreamId = '';
            render();
            return true;
        },
        close() {
            stopPlayback();
        },
        getState: () => state,
    };
}
