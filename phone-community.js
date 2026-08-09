import { cleanPhoneText as text } from './phone-utils.js';

export const PHONE_COMMUNITY_TABS = Object.freeze([
    { id: 'forum', label: '论坛', icon: 'fa-message' },
    { id: 'cp', label: 'CP榜', icon: 'fa-heart' },
    { id: 'fanworks', label: '同人区', icon: 'fa-feather-pointed' },
]);

export const PHONE_COMMUNITY_FORUM_FILTERS = Object.freeze([
    ['all', '全部'],
    ['anonymous', '匿名爆料'],
    ['analysis', '剧情分析'],
    ['fandom', '角色讨论'],
    ['battle', '粉圈广场'],
]);

export const PHONE_COMMUNITY_FANWORK_FILTERS = Object.freeze([
    ['all', '全部'],
    ['article', '同人文'],
    ['art', '画作'],
    ['video', '剪辑'],
    ['au', 'AU'],
    ['discussion', '讨论'],
]);

const SAMPLE_FORUM_THREADS = Object.freeze([
    {
        id: 'forum-raincoat',
        category: 'anonymous',
        tag: '匿名爆料',
        title: '匿名区｜今晚后台看到的那件外套，好像不是第一次出现了',
        author: '匿名用户 2718',
        time: '8分钟前',
        excerpt: '不保真，路过化妆间时看到有人把自己的外套递过去了。重点是接的人非常自然，像早就习惯了一样。',
        body: '先声明不保真，也不放能定位工作人员的细节。今晚散场以后后台有点冷，我路过化妆间时看到有人把自己的外套递过去了。接的人连一句客套都没有，顺手披上继续低头看台本。重点不是借外套，是两个人都自然得像这件事发生过很多次。',
        replies: 326,
        views: '2.8万',
        heat: 98,
        comments: [
            { author: '今天也在吃瓜', content: '“没有客套”这四个字已经很说明问题了。', likes: 871 },
            { author: '理智路人', content: '先蹲一个，别急着认领，等公开行程对时间线。', likes: 522 },
            { author: '显微镜成精', content: '有人记得上周采访里那句“他怕冷”吗……', likes: 417 },
        ],
    },
    {
        id: 'forum-missing-line',
        category: 'analysis',
        tag: '剧情分析',
        title: '长文分析｜第三幕被删掉的那句台词，可能才是人物动机的钥匙',
        author: '纸上放映厅',
        time: '22分钟前',
        excerpt: '把预告、正片和幕后花絮按时间排了一遍，发现角色真正转变态度的节点比大家以为的更早。',
        body: '预告片里有一个正片没有出现的对视镜头，台词字幕只留了半句。结合幕后花絮的场记板，可以确认它原本属于第三幕，而不是结尾补拍。这意味着角色在做出公开选择之前，就已经知道了另一人的决定。后面的沉默不是犹豫，而是在替对方保留退路。',
        replies: 184,
        views: '1.6万',
        heat: 92,
        comments: [
            { author: '逐帧暂停员', content: '场记板这个证据很硬，时间线终于对上了。', likes: 603 },
            { author: '编剧你睡了吗', content: '如果真是这样，结尾那个回头就不是临时起意。', likes: 455 },
            { author: '只看文本', content: '分析很美，但还是建议把删减镜头和成片分开讨论。', likes: 188 },
        ],
    },
    {
        id: 'forum-character-choice',
        category: 'fandom',
        tag: '涛角色',
        title: '认真涛一下：他不是不会表达，是每次都把选择权留给别人',
        author: '角色观察小组',
        time: '41分钟前',
        excerpt: '几次重要场合里，他都先问“你想不想”，很少直接替对方做决定。这不只是温柔，也可能是一种自我保护。',
        body: '重新看了几段关键对话，他几乎从不说“你应该”，而是问“你想不想”。表面看是尊重，往深了说也可能是不敢承担被拒绝的结果。所以真正的成长点不是学会付出，而是有一天能坦白说出“这是我想要的”。',
        replies: 97,
        views: '8940',
        heat: 86,
        comments: [
            { author: '人物弧光研究员', content: '同意，自我消失式体贴不完全是优点。', likes: 284 },
            { author: '偏心但讲理', content: '所以他偶尔主动一次才特别有冲击力。', likes: 251 },
        ],
    },
    {
        id: 'forum-fandom-fight',
        category: 'battle',
        tag: '粉圈广场',
        title: '首页两家别吵了，活动座位是主办方排的，不是艺人自己抢的',
        author: '广场秩序维护员',
        time: '1小时前',
        excerpt: '已经有人贴了往年流程，座位和上台顺序根本不是一回事。再吵只会给营销号送素材。',
        body: '主办方往年的座位图和流程单都有人整理了，座位按合作品牌与到场顺序协调，不等于番位，更不是艺人本人要求。两边再拿模糊截图互相开麦，只会把一个普通活动炒成新的词条。',
        replies: 642,
        views: '5.1万',
        heat: 95,
        comments: [
            { author: '路过的主持人粉', content: '终于有人说了，直播导播切镜头也不归艺人管。', likes: 1044 },
            { author: '拒绝贷款吵架', content: '建议两家把营销号一起拉黑，世界清净。', likes: 931 },
        ],
    },
]);

const SAMPLE_CP_RANKINGS = Object.freeze([
    { id: 'cp-starlight', rank: 1, name: '星河入梦', pairing: '冷面演员 × 天才编剧', trend: 'up', change: 2, heat: '986.4万', weekly: '后台同披一件外套，采访时又精准接住了对方没说完的半句话。', tags: ['外套糖', '默契接话'] },
    { id: 'cp-echo', rank: 2, name: '回声成双', pairing: '主唱 × 制作人', trend: 'same', change: 0, heat: '843.7万', weekly: '返场曲换了旧版编曲，正好是两人第一次合作时的版本。', tags: ['旧版编曲', '十年回环'] },
    { id: 'cp-summer', rank: 3, name: '盛夏来信', pairing: '新人演员 × 摄影师', trend: 'up', change: 4, heat: '721.9万', weekly: '花絮里只出现两秒的拍立得，被发现背面写着对方的字。', tags: ['拍立得', '花絮考古'] },
    { id: 'cp-moon', rank: 4, name: '月落长街', pairing: '刑警 × 记者', trend: 'down', change: 3, heat: '655.2万', weekly: '本周正片零同框，但预告里出现了疑似对方留下的录音笔。', tags: ['隔空同框', '录音笔'] },
    { id: 'cp-rain', rank: 5, name: '听雨停靠', pairing: '舞者 × 导演', trend: 'new', change: 0, heat: '598.1万', weekly: '路演结束时导演伸手挡了一下台阶，镜头外还有人喊了小名。', tags: ['路演糖', '小名疑云'] },
    { id: 'cp-cloud', rank: 6, name: '云端失重', pairing: '电竞选手 × 解说', trend: 'up', change: 1, heat: '510.8万', weekly: '赛后采访嘴上互怼，转头却在休息室用了同一个保温杯。', tags: ['欢喜冤家', '同款实锤'] },
]);

const SAMPLE_FAN_WORKS = Object.freeze([
    {
        id: 'fan-article-platform', type: 'article', typeLabel: '同人文', title: '《末班站台》｜他错过了最后一班车',
        creator: '夜航信箱', pairing: '星河入梦', time: '15分钟前', likes: 2381, comments: 146,
        summary: '现代都市 · 久别重逢 · 一发完',
        preview: '雨水沿着站牌一笔一画地往下淌。他站在空无一人的月台尽头，手机屏幕亮了又暗，始终没有拨出那个号码。广播第三次提醒末班车即将进站时，身后忽然有人叫了他的名字。那声音隔着十年光阴，仍然准确得让他不敢回头……',
        commentsList: [
            { author: '凌晨三点不睡觉', content: '停在这里是人能干出来的事吗！全文链接呢！', likes: 492 },
            { author: '糖分摄入超标', content: '“准确得让他不敢回头”这句太会写了。', likes: 376 },
        ],
    },
    {
        id: 'fan-art-balcony', type: 'art', typeLabel: '画作', title: '雨夜阳台｜双人氛围插画',
        creator: '蓝灰色铅笔', pairing: '月落长街', time: '33分钟前', likes: 4106, comments: 227,
        summary: '画面描述：深蓝雨夜，两个人隔着半开的玻璃门对望，室内暖光落在其中一人的肩上。',
        preview: '作品使用低饱和蓝灰色调，玻璃上的雨痕把两人的倒影叠在一起。没有直接牵手，但垂下的手指在倒影里几乎相触。',
        commentsList: [
            { author: '壁纸收集站', content: '倒影里的手指！老师您是懂留白的。', likes: 711 },
            { author: '今晚吃得很好', content: '一冷一暖的光刚好对应两个人现在的状态。', likes: 548 },
        ],
    },
    {
        id: 'fan-video-eyes', type: 'video', typeLabel: '剪辑', title: '【眼神向】他每次说谎都会先看向同一个人',
        creator: '一帧一帧嗑', pairing: '回声成双', time: '1小时前', likes: 6950, comments: 504,
        summary: '视频描述：02:17 的剧情向剪辑，按时间排列七次下意识对视，结尾接第一次合作的旧画面。',
        preview: '剪辑以环境音开场，每一次鼓点都落在人物移开视线的瞬间。最后旧画面与最新采访重叠，同一句话形成前后呼应。',
        commentsList: [
            { author: '暂停键受害者', content: '第三次对视以前我还能嘴硬，看到第七次彻底投降。', likes: 988 },
            { author: '考古队一号', content: '结尾旧素材接得太神了，原来这么早就有呼应。', likes: 804 },
        ],
    },
    {
        id: 'fan-au-coffee', type: 'au', typeLabel: 'AU', title: '咖啡店 AU：每天点错单的人和从不纠正他的店长',
        creator: '平行宇宙办事处', pairing: '盛夏来信', time: '2小时前', likes: 1877, comments: 193,
        summary: '咖啡店店长 × 赶稿摄影师，轻喜剧设定讨论楼',
        preview: '设定是摄影师每天睡眠不足，点单永远说错；店长第一次纠正，第二次沉默，第三次开始直接把真正想喝的递给他。直到某天摄影师清醒地说对了，店长反而愣住。',
        commentsList: [
            { author: 'AU永动机', content: '求加入“杯套背面画小相机”的设定！', likes: 321 },
            { author: '拿铁不加糖', content: '说对了反而愣住，这个瞬间已经能脑补一万字。', likes: 287 },
        ],
    },
    {
        id: 'fan-discussion-sugar', type: 'discussion', typeLabel: '放大镜找糖', title: '把两场采访的桌面反光叠了一下，那个挂件是不是同一个？',
        creator: '显微镜十级选手', pairing: '星河入梦', time: '3小时前', likes: 3204, comments: 389,
        summary: '细节讨论 · 欢迎补充证据，拒绝造谣式认领',
        preview: '第一场采访右下角只露出一小截银色链条，第二场直播里能看到完整挂件。形状和缺口位置高度相似，但目前没有清晰正面图，只能算待确认糖点。',
        commentsList: [
            { author: '谨慎嗑糖人', content: '形状像，但链条长度不太一样，先放进疑似区。', likes: 466 },
            { author: '物料整理组', content: '补充：同品牌只有这一款有侧面缺口。', likes: 422 },
        ],
    },
]);

function clone(value) {
    return typeof globalThis.structuredClone === 'function'
        ? globalThis.structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function normalizeList(value, fallback) {
    return Array.isArray(value) && value.length > 0 ? clone(value) : clone(fallback);
}

export function normalizePhoneCommunityState(settings = {}) {
    settings.phone ??= {};
    const source = settings.phone.community && typeof settings.phone.community === 'object'
        ? settings.phone.community
        : {};
    const state = {
        forumThreads: normalizeList(source.forumThreads, SAMPLE_FORUM_THREADS),
        cpRankings: normalizeList(source.cpRankings, SAMPLE_CP_RANKINGS),
        fanWorks: normalizeList(source.fanWorks, SAMPLE_FAN_WORKS),
    };
    settings.phone.community = state;
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

function renderComments(documentRef, comments = []) {
    const section = element(documentRef, 'section', 'memory-augment-community-comments');
    const heading = element(documentRef, 'header');
    heading.append(element(documentRef, 'strong', '', '热门回复'), element(documentRef, 'small', '', `${comments.length} 条精选`));
    section.append(heading);
    for (const comment of comments) {
        const row = element(documentRef, 'article', 'memory-augment-community-comment');
        const avatar = element(documentRef, 'span', 'memory-augment-community-mini-avatar', text(comment.author, 1) || '匿');
        const copy = element(documentRef, 'div');
        const meta = element(documentRef, 'header');
        meta.append(element(documentRef, 'strong', '', text(comment.author, 50) || '社区用户'));
        const like = element(documentRef, 'small', '', `♡ ${Number(comment.likes) || 0}`);
        meta.append(like);
        copy.append(meta, element(documentRef, 'p', '', text(comment.content, 400)));
        row.append(avatar, copy);
        section.append(row);
    }
    return section;
}

export function createPhoneCommunityController(options = {}) {
    const documentRef = options.document ?? globalThis.document;
    const settings = options.settings ?? {};
    const state = normalizePhoneCommunityState(settings);
    let root = null;
    let activeTab = 'forum';
    let forumFilter = 'all';
    let fanFilter = 'all';
    let detail = null;

    function renderTabs(container) {
        const nav = element(documentRef, 'nav', 'memory-augment-community-tabs');
        for (const tab of PHONE_COMMUNITY_TABS) {
            const item = button(documentRef, tab.id === activeTab ? 'is-active' : '', '', () => {
                activeTab = tab.id;
                detail = null;
                render();
            });
            const icon = element(documentRef, 'i', `fa-solid ${tab.icon}`);
            icon.setAttribute('aria-hidden', 'true');
            item.append(icon, element(documentRef, 'span', '', tab.label));
            nav.append(item);
        }
        container.append(nav);
    }

    function renderFilters(container, filters, selected, onSelect) {
        const strip = element(documentRef, 'div', 'memory-augment-community-filters');
        for (const [id, label] of filters) {
            strip.append(button(documentRef, id === selected ? 'is-active' : '', label, () => {
                onSelect(id);
                render();
            }));
        }
        container.append(strip);
    }

    function renderForum(container) {
        const hero = element(documentRef, 'section', 'memory-augment-community-hero is-forum');
        hero.append(element(documentRef, 'small', '', 'COMMUNITY NOW'), element(documentRef, 'strong', '', '此刻大家都在聊'), element(documentRef, 'span', '', '爆料、角色讨论与剧情显微镜集中地'));
        container.append(hero);
        renderFilters(container, PHONE_COMMUNITY_FORUM_FILTERS, forumFilter, value => { forumFilter = value; });
        const list = element(documentRef, 'section', 'memory-augment-community-thread-list');
        const threads = state.forumThreads
            .filter(item => forumFilter === 'all' || item.category === forumFilter)
            .sort((a, b) => Number(b.heat) - Number(a.heat));
        for (const thread of threads) {
            const card = button(documentRef, 'memory-augment-community-thread', '', () => {
                detail = { type: 'forum', id: thread.id };
                render();
            });
            const meta = element(documentRef, 'header');
            meta.append(element(documentRef, 'span', '', text(thread.tag, 30)), element(documentRef, 'small', '', text(thread.time, 30)));
            card.append(meta, element(documentRef, 'strong', '', text(thread.title, 160)), element(documentRef, 'p', '', text(thread.excerpt, 260)));
            const footer = element(documentRef, 'footer');
            footer.append(element(documentRef, 'span', '', text(thread.author, 60)), element(documentRef, 'small', '', `◉ ${thread.views}　💬 ${Number(thread.replies) || 0}`));
            card.append(footer);
            list.append(card);
        }
        container.append(list);
    }

    function trendLabel(item) {
        if (item.trend === 'new') return ['is-new', 'NEW'];
        if (item.trend === 'up') return ['is-up', `↑ ${Number(item.change) || 0}`];
        if (item.trend === 'down') return ['is-down', `↓ ${Number(item.change) || 0}`];
        return ['is-same', '—'];
    }

    function renderCp(container) {
        const hero = element(documentRef, 'section', 'memory-augment-community-hero is-cp');
        hero.append(element(documentRef, 'small', '', 'WEEKLY CP CHART'), element(documentRef, 'strong', '', '本周心动榜'), element(documentRef, 'span', '', '热度每周刷新 · 涨跌只代表社区讨论量'));
        container.append(hero);
        const list = element(documentRef, 'section', 'memory-augment-community-cp-list');
        for (const item of [...state.cpRankings].sort((a, b) => Number(a.rank) - Number(b.rank))) {
            const row = button(documentRef, `memory-augment-community-cp-row${Number(item.rank) <= 3 ? ' is-top' : ''}`, '', () => {
                detail = { type: 'cp', id: item.id };
                render();
            });
            const rank = element(documentRef, 'span', 'memory-augment-community-rank', String(item.rank));
            const copy = element(documentRef, 'div');
            const title = element(documentRef, 'header');
            title.append(element(documentRef, 'strong', '', text(item.name, 60)));
            const [trendClass, trendText] = trendLabel(item);
            title.append(element(documentRef, 'em', trendClass, trendText));
            copy.append(title, element(documentRef, 'small', '', text(item.pairing, 100)), element(documentRef, 'p', '', text(item.weekly, 220)));
            const heat = element(documentRef, 'span', 'memory-augment-community-cp-heat');
            heat.append(element(documentRef, 'strong', '', text(item.heat, 30)), element(documentRef, 'small', '', '热度'));
            row.append(rank, copy, heat);
            list.append(row);
        }
        container.append(list);
    }

    function renderFanworks(container) {
        const hero = element(documentRef, 'section', 'memory-augment-community-hero is-fanworks');
        hero.append(element(documentRef, 'small', '', 'FANWORKS'), element(documentRef, 'strong', '', '造梦放映厅'), element(documentRef, 'span', '', '文字、画面与剪辑都用想象力加载'));
        container.append(hero);
        renderFilters(container, PHONE_COMMUNITY_FANWORK_FILTERS, fanFilter, value => { fanFilter = value; });
        const grid = element(documentRef, 'section', 'memory-augment-community-fan-list');
        const works = state.fanWorks.filter(item => fanFilter === 'all' || item.type === fanFilter);
        for (const work of works) {
            const card = button(documentRef, `memory-augment-community-fan-card is-${text(work.type, 20)}`, '', () => {
                detail = { type: 'fanwork', id: work.id };
                render();
            });
            const cover = element(documentRef, 'div', 'memory-augment-community-fan-cover');
            const iconNames = { article: 'fa-book-open', art: 'fa-palette', video: 'fa-play', au: 'fa-shuffle', discussion: 'fa-magnifying-glass' };
            const coverIcon = element(documentRef, 'i', `fa-solid ${iconNames[work.type] ?? 'fa-feather-pointed'}`);
            coverIcon.setAttribute('aria-hidden', 'true');
            cover.append(coverIcon, element(documentRef, 'span', '', text(work.typeLabel, 30)));
            const copy = element(documentRef, 'div');
            copy.append(element(documentRef, 'small', '', `${text(work.pairing, 50)} · ${text(work.time, 30)}`), element(documentRef, 'strong', '', text(work.title, 140)), element(documentRef, 'p', '', text(work.summary, 220)));
            const footer = element(documentRef, 'footer');
            footer.append(element(documentRef, 'span', '', `@${text(work.creator, 50)}`), element(documentRef, 'small', '', `♡ ${Number(work.likes) || 0}　💬 ${Number(work.comments) || 0}`));
            copy.append(footer);
            card.append(cover, copy);
            grid.append(card);
        }
        container.append(grid);
    }

    function renderDetail(container) {
        const shell = element(documentRef, 'section', 'memory-augment-community-detail');
        const back = button(documentRef, 'memory-augment-community-detail-back', '', () => {
            detail = null;
            render();
        });
        const backIcon = element(documentRef, 'i', 'fa-solid fa-chevron-left');
        backIcon.setAttribute('aria-hidden', 'true');
        back.append(backIcon, element(documentRef, 'span', '', '返回'));
        shell.append(back);

        if (detail.type === 'forum') {
            const item = state.forumThreads.find(thread => thread.id === detail.id);
            if (!item) return;
            shell.append(element(documentRef, 'span', 'memory-augment-community-detail-tag', text(item.tag, 30)), element(documentRef, 'h2', '', text(item.title, 180)));
            const byline = element(documentRef, 'div', 'memory-augment-community-detail-byline', `${text(item.author, 60)} · ${text(item.time, 30)} · ${item.views} 阅读`);
            shell.append(byline, element(documentRef, 'p', 'memory-augment-community-detail-body', text(item.body, 1200)), renderComments(documentRef, item.comments));
        } else if (detail.type === 'cp') {
            const item = state.cpRankings.find(cp => cp.id === detail.id);
            if (!item) return;
            shell.append(element(documentRef, 'span', 'memory-augment-community-detail-tag', `本周第 ${item.rank} 名`), element(documentRef, 'h2', '', text(item.name, 80)), element(documentRef, 'div', 'memory-augment-community-detail-byline', `${text(item.pairing, 100)} · ${text(item.heat, 30)} 热度`));
            const spotlight = element(documentRef, 'div', 'memory-augment-community-cp-spotlight');
            spotlight.append(element(documentRef, 'small', '', '本周嗑点'), element(documentRef, 'p', '', text(item.weekly, 500)));
            const tags = element(documentRef, 'div', 'memory-augment-community-detail-tags');
            for (const tag of item.tags ?? []) tags.append(element(documentRef, 'span', '', `# ${text(tag, 30)}`));
            shell.append(spotlight, tags);
        } else {
            const item = state.fanWorks.find(work => work.id === detail.id);
            if (!item) return;
            shell.append(element(documentRef, 'span', 'memory-augment-community-detail-tag', text(item.typeLabel, 30)), element(documentRef, 'h2', '', text(item.title, 180)), element(documentRef, 'div', 'memory-augment-community-detail-byline', `@${text(item.creator, 60)} · ${text(item.pairing, 60)} · ${text(item.time, 30)}`));
            const preview = element(documentRef, 'div', `memory-augment-community-work-preview is-${text(item.type, 20)}`);
            preview.append(element(documentRef, 'small', '', item.type === 'article' ? '约 100 字试读' : '作品文字预览'), element(documentRef, 'p', '', text(item.preview, 1000)));
            if (item.type === 'article') preview.append(element(documentRef, 'strong', '', '……阅读全文'));
            shell.append(preview, renderComments(documentRef, item.commentsList));
        }
        container.append(shell);
    }

    function render() {
        if (!root) return;
        root.replaceChildren();
        root.classList.remove('is-messages', 'is-weibo', 'is-community', 'is-live');
        root.classList.add('is-community');
        const page = element(documentRef, 'div', 'memory-augment-community-view');
        if (detail) renderDetail(page);
        else {
            renderTabs(page);
            if (activeTab === 'forum') renderForum(page);
            else if (activeTab === 'cp') renderCp(page);
            else renderFanworks(page);
        }
        root.append(page);
    }

    return {
        async open(container) {
            root = container;
            render();
        },
        back() {
            if (!detail) return false;
            detail = null;
            render();
            return true;
        },
        getState: () => state,
    };
}
