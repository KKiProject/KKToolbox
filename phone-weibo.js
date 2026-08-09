import { cleanPhoneText as text } from './phone-utils.js';
import { normalizePhoneIdentity, uploadPhoneImage } from './phone-store.js';
import { openPhoneConfirm, openPhoneForm } from './phone-dialogs.js';
import {
    getPhoneIdentityFromInput,
    getPhoneIdentitySelectOptions,
    loadPhoneIdentitySources,
} from './phone-identities.js';

export const PHONE_WEIBO_INTERESTS = Object.freeze([
    { id: 'entertainment', label: '娱乐', icon: 'fa-star' },
    { id: 'film', label: '影视', icon: 'fa-film' },
    { id: 'music', label: '音乐', icon: 'fa-music' },
    { id: 'variety', label: '综艺', icon: 'fa-microphone-lines' },
    { id: 'fashion', label: '时尚', icon: 'fa-gem' },
    { id: 'game', label: '游戏', icon: 'fa-gamepad' },
    { id: 'anime', label: '二次元', icon: 'fa-wand-magic-sparkles' },
    { id: 'sports', label: '体育', icon: 'fa-basketball' },
    { id: 'society', label: '社会', icon: 'fa-newspaper' },
    { id: 'finance', label: '财经', icon: 'fa-chart-line' },
    { id: 'technology', label: '科技', icon: 'fa-microchip' },
    { id: 'reading', label: '读书', icon: 'fa-book-open' },
    { id: 'food', label: '美食', icon: 'fa-bowl-food' },
    { id: 'travel', label: '旅行', icon: 'fa-plane' },
    { id: 'campus', label: '校园', icon: 'fa-graduation-cap' },
    { id: 'emotion', label: '情感', icon: 'fa-heart' },
    { id: 'pets', label: '萌宠', icon: 'fa-paw' },
]);

const INTEREST_IDS = new Set(PHONE_WEIBO_INTERESTS.map(item => item.id));
const INTEREST_LABELS = new Map(PHONE_WEIBO_INTERESTS.map(item => [item.id, item.label]));
const OTHER_FOLLOWING_COUNT = 2;

const SAMPLE_POSTS = Object.freeze([
    {
        id: 'sample-film-night',
        author: '银幕放映室',
        badge: '影评博主',
        tone: 'violet',
        time: '12分钟前',
        topics: ['film', 'entertainment'],
        content: '《长街灯火》今晚释出首支预告。雨夜、旧车站和那封没有寄出的信，氛围感已经拉满。你最期待哪位角色的故事线？',
        visual: '新片预告 · 长街灯火',
        reposts: 1268,
        comments: 509,
        likes: 8241,
    },
    {
        id: 'sample-music-live',
        author: '耳机分你一半',
        badge: '音乐博主',
        tone: 'rose',
        time: '28分钟前',
        topics: ['music', 'entertainment'],
        content: '今晚音乐节返场曲的全场合唱太绝了。没有复杂舞美，只有一束追光和几万人一起唱到最后一句。',
        visual: 'LIVE · 夏夜音乐节',
        reposts: 903,
        comments: 377,
        likes: 6904,
    },
    {
        id: 'sample-variety-room',
        author: '综艺观察员',
        badge: '视频博主',
        tone: 'orange',
        time: '43分钟前',
        topics: ['variety', 'entertainment'],
        content: '新一期的密室分组很有意思：胆子最大的负责解题，最冷静的反而被突然出现的广播吓了一跳。节目组是懂反差感的。',
        visual: '',
        reposts: 334,
        comments: 821,
        likes: 4550,
    },
    {
        id: 'sample-fashion-look',
        author: '今日造型簿',
        badge: '时尚博主',
        tone: 'gold',
        time: '1小时前',
        topics: ['fashion', 'entertainment'],
        content: '灰蓝色长风衣搭同色系衬衫，银色胸针是整套造型的点睛。克制，但在镜头里很抓人。',
        visual: 'LOOK · 雾蓝时刻',
        reposts: 576,
        comments: 198,
        likes: 7338,
    },
    {
        id: 'sample-game-update',
        author: '像素补给站',
        badge: '游戏博主',
        tone: 'blue',
        time: '2小时前',
        topics: ['game', 'technology'],
        content: '小队更新后终于能自定义基地灯光了。先别急着做主线，夜里把屋顶灯串打开真的很治愈。',
        visual: '版本更新 · 星港基地',
        reposts: 219,
        comments: 460,
        likes: 2981,
    },
    {
        id: 'sample-anime-season',
        author: '次元放送站',
        badge: '动漫博主',
        tone: 'violet',
        time: '2小时前',
        topics: ['anime', 'entertainment'],
        content: '本季新番的第三集终于把前两集埋下的细节串起来了。片尾曲响起时那个回头镜头，值得单独截出来反复看。',
        visual: '本季新番 · 第三集讨论',
        reposts: 718,
        comments: 1046,
        likes: 11320,
    },
    {
        id: 'sample-food-night',
        author: '城市夜宵地图',
        badge: '本地博主',
        tone: 'green',
        time: '2小时前',
        topics: ['food', 'travel'],
        content: '老街拐角的新菜单实测：炭烤年糕外脆里糯，桂花冰酿偏清爽。晚上十点后人会少很多。',
        visual: '夜宵地图 · 老街站',
        reposts: 164,
        comments: 233,
        likes: 1876,
    },
    {
        id: 'sample-pets-office',
        author: '毛茸茸研究所',
        badge: '萌宠博主',
        tone: 'sand',
        time: '3小时前',
        topics: ['pets', 'emotion'],
        content: '同事带猫来办公室的第三天，它已经学会准时坐在打印机旁边监工。今天的考核结果：所有人都需要再努力。',
        visual: '',
        reposts: 441,
        comments: 612,
        likes: 9602,
    },
    {
        id: 'sample-sports-final',
        author: '看台第七排',
        badge: '体育博主',
        tone: 'cyan',
        time: '4小时前',
        topics: ['sports'],
        content: '最后二十秒连续追平，终场前的那记远投让全场安静了一瞬，然后彻底沸腾。今晚值得反复回看。',
        visual: '高光时刻 · 终场反击',
        reposts: 1104,
        comments: 903,
        likes: 12560,
    },
    {
        id: 'sample-travel-weekend',
        author: '两日出逃计划',
        badge: '旅行博主',
        tone: 'green',
        time: '5小时前',
        topics: ['travel'],
        content: '周末不请假也能走的短途路线整理好了：上午坐慢车看江景，下午逛旧街，晚上住在山脚。第二天睡醒再回城，行程不赶。',
        visual: '周末路线 · 山城慢游',
        reposts: 382,
        comments: 286,
        likes: 5420,
    },
    {
        id: 'sample-reading-sentence',
        author: '页边留白',
        badge: '读书博主',
        tone: 'sand',
        time: '6小时前',
        topics: ['reading'],
        content: '今年读到最难忘的一句话，不是教人立刻振作，而是允许人先在原地坐一会儿。书合上以后，那句话还在。',
        visual: '',
        reposts: 247,
        comments: 419,
        likes: 6812,
    },
]);

const HOT_TOPICS = Object.freeze([
    { title: '长街灯火首支预告', category: 'film', postId: 'sample-film-night', heat: '986.4万', mark: '爆' },
    { title: '今晚音乐节全场合唱', category: 'music', postId: 'sample-music-live', heat: '831.2万', mark: '沸' },
    { title: '密室新一期分组', category: 'variety', postId: 'sample-variety-room', heat: '706.9万', mark: '热' },
    { title: '雾蓝色系红毯造型', category: 'fashion', postId: 'sample-fashion-look', heat: '592.1万', mark: '新' },
    { title: '终场前二十秒发生了什么', category: 'sports', postId: 'sample-sports-final', heat: '488.7万', mark: '' },
    { title: '星港基地自定义灯光', category: 'game', postId: 'sample-game-update', heat: '376.5万', mark: '新' },
    { title: '本季新番第三集封神', category: 'anime', postId: 'sample-anime-season', heat: '354.7万', mark: '热' },
    { title: '老街夜宵隐藏菜单', category: 'food', postId: 'sample-food-night', heat: '321.8万', mark: '' },
    { title: '办公室猫咪监工实录', category: 'pets', postId: 'sample-pets-office', heat: '268.3万', mark: '热' },
    { title: '周末短途旅行清单', category: 'travel', postId: 'sample-travel-weekend', heat: '201.6万', mark: '' },
    { title: '今年读到最难忘的一句话', category: 'reading', postId: 'sample-reading-sentence', heat: '188.9万', mark: '' },
]);

const COMMENT_AUTHORS = Object.freeze([
    { author: '镜头之外', tone: 'violet', likes: 4821, time: '8分钟前' },
    { author: '前排吃瓜中', tone: 'orange', likes: 3614, time: '11分钟前' },
    { author: '细节显微镜', tone: 'cyan', likes: 2978, time: '19分钟前' },
    { author: '今天也在线', tone: 'rose', likes: 2440, time: '26分钟前' },
    { author: '冷静围观群众', tone: 'green', likes: 1907, time: '31分钟前' },
]);

const SAMPLE_COMMENT_CONTENT = Object.freeze({
    'sample-film-night': [
        '旧车站时钟停在十一点四十七分，和上一张人物海报里的时间完全一样，应该不是巧合。',
        '最期待女主那封没寄出的信，她在预告里每次准备开口，镜头都会切到雨幕。',
        '长街的暖灯和车站的冷光对比太漂亮了，导演这次还是很会拍夜景。',
        '男二从头到尾没有出现在同一条时间线里，我先大胆猜一个双线叙事。',
        '预告最后那句“你还记得回去的路吗”一出来，已经决定首映去看了。',
    ],
    'sample-music-live': [
        '返场没有伴奏的第一句，全场居然整整齐齐接上了，隔着屏幕都起鸡皮疙瘩。',
        '主唱把耳返摘下来听大家唱的那个笑，才是今晚最值回票价的画面。',
        '现场那束追光很克制，反而把几万人的合唱衬得特别有力量。',
        '最后一句结束以后安静了两秒才欢呼，那两秒真的会记很久。',
        '求官方把返场完整音源放出来，手机录的已经循环一晚上了。',
    ],
    'sample-variety-room': [
        '平时最冷静的人被广播吓到蹲下，旁边胆小担当反过来安慰他，笑死。',
        '这期分组不是随便抽的，每个人的长处刚好都被另一个人的弱点克制。',
        '红门密码其实在开场采访的背景板上，节目组埋线索越来越早了。',
        '负责解题的那位嘴上说别怕，手一直紧紧抓着队友袖口，反差拉满。',
        '这期剪辑节奏终于舒服了，既保留了解题过程，也没把惊吓点全剧透。',
    ],
    'sample-fashion-look': [
        '银色胸针的位置很妙，再往上一点会太正式，现在刚好拉长了肩颈线条。',
        '灰蓝不是好穿的颜色，但内搭和风衣差了半个明度，所以层次一下就出来了。',
        '红毯灯光偏暖，这套冷色反而在人群里特别显眼，造型师有算过。',
        '鞋子也用了低饱和银灰，没有突然塞一个黑色进来破坏整体感，舒服。',
        '想看这套的背面细节，风衣腰线和下摆走动时应该更好看。',
    ],
    'sample-game-update': [
        '屋顶灯串记得调到暖黄再把亮度降到四成，雨天从远处看特别像港口旅店。',
        '终于有人懂我，主线可以明天做，基地装修必须今晚完成。',
        '灯光会影响夜间访客出现的位置，我在蓝灯区域遇到了新的机械商人。',
        '希望下次更新能保存整套灯光预设，现在换主题还得一盏一盏调。',
        '星港二层窗边放矮灯也很好看，玻璃会映出两层光带。',
    ],
    'sample-anime-season': [
        '第三集回头的角度和第一集车窗倒影完全一致，原来当时看到的人就是她。',
        '片尾曲前奏提前两秒进来，刚好压在那句没说完的台词上，演出太会了。',
        '第二集桌上的两只杯子终于解释了，不是穿帮，是有人一直被刻意藏在镜头外。',
        '这集看完再回去看第一集，连路牌颜色都是伏笔，制作组真的有备而来。',
        '别急着说男主失忆，我感觉更像两个人对同一天的记忆发生了偏差。',
    ],
    'sample-food-night': [
        '炭烤年糕要趁热吃，放凉以后外壳会变硬，桂花冰酿倒是可以慢慢喝。',
        '昨晚十点半去只排了两桌，老板还送了一小碟新腌的青梅。',
        '隐藏菜单的椒盐藕盒也不错，但每天量很少，去晚了基本没有。',
        '桂花冰酿不是齁甜那种，配烤年糕刚好把炭火味压下去一点。',
        '老街东口在修路，从河边那个巷子绕进去更快，别跟着导航走正门。',
    ],
    'sample-pets-office': [
        '打印机一响它就过去坐好，明显已经把出纸声当成上班铃了。',
        '请问监工的考核标准是什么，是不是每个人都必须按时上交猫条？',
        '它盯着废纸篓的表情太严肃了，感觉下一秒就要通报纸张浪费问题。',
        '办公室有猫以后开会效率肯定提高，因为所有人都想快点散会去摸它。',
        '第三天已经占领打印机，下周应该就能坐到老板的位置了。',
    ],
    'sample-sports-final': [
        '最后那球出手时只剩零点八秒，防守已经封到脸上了，真的是大心脏。',
        '前一次追平靠的是抢断，这一次直接远投，最后二十秒每一拍都不能漏看。',
        '全场安静的那一瞬间比欢呼更震撼，所有人都在等篮网的声音。',
        '暂停回来那个边线战术画得太漂亮，两个掩护把底角空间完全清空了。',
        '落后三分时没有急着犯规是关键，教练赌对了那次前场夹击。',
    ],
    'sample-travel-weekend': [
        '慢车靠江一侧要选右边座位，进山前有四十分钟几乎一直贴着水走。',
        '旧街周六下午人不少，反而周日早上八点最安静，店也陆续开了。',
        '山脚那几家民宿晚上温差大，八月去也最好带一件薄外套。',
        '这个路线不租车也能走完很加分，车站到旧街的公交半小时一班。',
        '第二天别排太满，睡醒在河边吃碗面再回城，才有短途旅行的松弛感。',
    ],
    'sample-reading-sentence': [
        '“允许先坐一会儿”比催人向前更温柔，有时候被允许停下反而才走得动。',
        '我也记住了这句，它没有替痛苦找意义，只是承认人确实会累。',
        '读到这里时把书合上了一会儿，不是看不下去，是想让这句话多停一阵。',
        '请问书名是什么？最近正需要一本不会急着给答案的书。',
        '真正留下来的句子常常不响亮，却会在某个普通下午突然被想起来。',
    ],
});

function makeId(prefix) {
    const value = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    return `${prefix}-${value}`;
}

function stableHash(value) {
    let hash = 2166136261;
    for (const character of String(value ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function compactNumber(value) {
    const number = Math.max(0, Number(value) || 0);
    if (number >= 10_000) return `${(number / 10_000).toFixed(number >= 100_000 ? 0 : 1)}万`;
    return String(Math.trunc(number));
}

function normalizePostSource(value = {}) {
    const content = text(value?.content, 500);
    if (!content) return null;
    return {
        postId: text(value?.postId ?? value?.id, 120),
        author: text(value?.author, 80) || '原作者',
        badge: text(value?.badge, 80),
        content,
        topic: INTEREST_IDS.has(value?.topic) ? value.topic : '',
        visual: text(value?.visual, 160),
    };
}

function normalizePost(value = {}) {
    const topic = INTEREST_IDS.has(value?.topic) ? value.topic : '';
    const content = text(value?.content, 500);
    const legacyCustomTopic = text(value?.customTopic, 50).replace(/^#+|#+$/g, '');
    const customTopics = [...new Set([
        ...(Array.isArray(value?.customTopics) ? value.customTopics : []),
        legacyCustomTopic,
    ].map(item => text(item, 50).replace(/^#+|#+$/g, '')).filter(Boolean))];
    const source = normalizePostSource(value?.source);
    const kind = value?.kind === 'repost' && source ? 'repost' : 'original';
    if (!content && kind === 'original') return null;
    return {
        id: text(value?.id, 120) || makeId('weibo-post'),
        kind,
        authorType: ['npc', 'role', 'player'].includes(value?.authorType) ? value.authorType : 'player',
        authorId: text(value?.authorId, 120),
        author: text(value?.author, 80),
        avatar: text(value?.avatar, 4000),
        badge: text(value?.badge, 80),
        tone: text(value?.tone, 20) || 'rose',
        content: content || '转发微博',
        topic,
        topics: [...new Set((Array.isArray(value?.topics) ? value.topics : [topic])
            .map(item => text(item, 40)).filter(Boolean))],
        customTopics,
        imageDescription: text(value?.imageDescription, 240),
        location: text(value?.location, 120),
        mentions: (Array.isArray(value?.mentions) ? value.mentions : []).map(mention => ({
            id: text(mention?.id, 120),
            nickname: text(mention?.nickname, 80),
        })).filter(mention => mention.id && mention.nickname),
        source,
        createdAt: Number.isFinite(Number(value?.createdAt)) ? Number(value.createdAt) : Date.now(),
        reposts: Math.max(0, Math.trunc(Number(value?.reposts) || 0)),
        comments: Math.max(0, Math.trunc(Number(value?.comments) || 0)),
        likes: Math.max(0, Math.trunc(Number(value?.likes) || 0)),
        hotComments: (Array.isArray(value?.hotComments) ? value.hotComments : []).slice(0, 5).map((comment, index) => ({
            id: text(comment?.id, 160) || `${text(value?.id, 120)}-comment-${index + 1}`,
            author: text(comment?.author, 80) || '微博网友',
            content: text(comment?.content, 300),
            likes: Math.max(0, Math.trunc(Number(comment?.likes) || 0)),
            createdAt: Number.isFinite(Number(comment?.createdAt)) ? Number(comment.createdAt) : Date.now(),
            tone: text(comment?.tone, 20) || 'violet',
        })).filter(comment => comment.content),
        generationBatchId: text(value?.generationBatchId, 120),
        storyEvidence: text(value?.storyEvidence, 300),
    };
}

function normalizeCommentReply(value = {}) {
    const content = text(value?.content, 300);
    const postId = text(value?.postId, 120);
    const commentId = text(value?.commentId, 160);
    if (!content || !postId || !commentId) return null;
    return {
        id: text(value?.id, 120) || makeId('weibo-reply'),
        postId,
        commentId,
        content,
        createdAt: Number.isFinite(Number(value?.createdAt)) ? Number(value.createdAt) : Date.now(),
    };
}

function normalizeRoleAccount(value = {}) {
    const nickname = text(value?.nickname ?? value?.name, 80);
    if (!nickname) return null;
    return {
        id: text(value?.id, 120) || makeId('weibo-role'),
        nickname,
        avatar: text(value?.avatar, 4000),
        bio: text(value?.bio, 160) || '这个人很神秘，还没有填写简介。',
        identity: normalizePhoneIdentity(value?.identity),
        createdAt: Number.isFinite(Number(value?.createdAt)) ? Number(value.createdAt) : Date.now(),
    };
}

export function buildPhoneWeiboRoleAccounts(values = []) {
    const accounts = Array.isArray(values) ? values : [];
    const seenIds = new Set();
    return accounts.map(normalizeRoleAccount).filter(account => {
        if (!account) return false;
        if (seenIds.has(account.id)) return false;
        seenIds.add(account.id);
        return true;
    });
}

export function getPhoneWeiboRelationship(state = {}, roleId = '') {
    const following = Array.isArray(state.followingRoleIds) && state.followingRoleIds.includes(roleId);
    const follower = Array.isArray(state.followerRoleIds) && state.followerRoleIds.includes(roleId);
    if (following && follower) return 'mutual';
    if (following) return 'following';
    if (follower) return 'follower';
    return 'none';
}

export function normalizePhoneWeiboState(settings = {}) {
    settings.phone ??= {};
    const source = settings.phone.weibo && typeof settings.phone.weibo === 'object'
        ? settings.phone.weibo
        : {};
    const sourceProfile = source.profile && typeof source.profile === 'object' ? source.profile : null;
    const phoneProfile = settings.phone.profile && typeof settings.phone.profile === 'object'
        ? settings.phone.profile
        : {};
    const profile = {
        accountId: sourceProfile && Object.hasOwn(sourceProfile, 'accountId')
            ? text(sourceProfile.accountId, 120)
            : text(phoneProfile.accountId, 120),
        isMask: sourceProfile && Object.hasOwn(sourceProfile, 'isMask')
            ? Boolean(sourceProfile.isMask)
            : Boolean(phoneProfile.isMask),
        nickname: sourceProfile && Object.hasOwn(sourceProfile, 'nickname')
            ? (text(sourceProfile.nickname, 80) || '我')
            : (text(phoneProfile.nickname, 80) || '我'),
        avatar: sourceProfile && Object.hasOwn(sourceProfile, 'avatar')
            ? text(sourceProfile.avatar, 4000)
            : text(phoneProfile.avatar, 4000),
        bio: sourceProfile && Object.hasOwn(sourceProfile, 'bio')
            ? text(sourceProfile.bio, 160)
            : (text(source.profileBio, 160) || '记录故事里正在发生的新鲜事。'),
        persona: sourceProfile && Object.hasOwn(sourceProfile, 'persona')
            ? text(sourceProfile.persona, 12000)
            : text(phoneProfile.persona, 12000),
    };
    const roleAccounts = buildPhoneWeiboRoleAccounts(source.roleAccounts);
    const roleAccountIds = new Set(roleAccounts.map(account => account.id));
    const state = {
        interests: [...new Set((Array.isArray(source.interests) ? source.interests : [])
            .map(value => text(value, 40))
            .filter(value => INTEREST_IDS.has(value)))],
        posts: (Array.isArray(source.posts) ? source.posts : []).map(normalizePost).filter(Boolean),
        likedPostIds: [...new Set((Array.isArray(source.likedPostIds) ? source.likedPostIds : [])
            .map(value => text(value, 120)).filter(Boolean))],
        commentReplies: (Array.isArray(source.commentReplies) ? source.commentReplies : [])
            .map(normalizeCommentReply).filter(Boolean),
        roleAccounts,
        followingRoleIds: [...new Set((Array.isArray(source.followingRoleIds) ? source.followingRoleIds : [])
            .map(value => text(value, 120)).filter(value => roleAccountIds.has(value)))],
        followerRoleIds: [...new Set((Array.isArray(source.followerRoleIds) ? source.followerRoleIds : [])
            .map(value => text(value, 120)).filter(value => roleAccountIds.has(value)))],
        feedPostIds: [...new Set((Array.isArray(source.feedPostIds) ? source.feedPostIds : [])
            .map(value => text(value, 120)).filter(Boolean))].slice(0, 30),
        hotTopics: (Array.isArray(source.hotTopics) ? source.hotTopics : []).map(item => ({
            id: text(item?.id, 120) || makeId('weibo-hot'),
            title: text(item?.title, 80),
            postId: text(item?.postId, 120),
            heat: Math.max(0, Math.trunc(Number(item?.heat) || 0)),
            mark: ['爆', '沸', '热', '新', ''].includes(item?.mark) ? item.mark : '',
        })).filter(item => item.title && item.postId).slice(0, 30),
        followerCount: Math.max(0, Math.trunc(Number(source.followerCount) || 0)),
        followerHistory: (Array.isArray(source.followerHistory) ? source.followerHistory : []).slice(0, 100),
        generationBatches: (Array.isArray(source.generationBatches) ? source.generationBatches : []).slice(-200),
        generationMaxTokens: Math.max(4096, Math.min(16_384, Math.trunc(Number(source.generationMaxTokens) || 12_000))),
        initialized: source.initialized === true,
        initializing: source.initializing === true,
        lastError: text(source.lastError, 500),
        profile,
    };
    settings.phone.weibo = state;
    return state;
}

export function buildPhoneWeiboFeed(state = {}, activeInterest = '') {
    const postsById = new Map((Array.isArray(state.posts) ? state.posts : []).map(post => [post.id, post]));
    const generated = (Array.isArray(state.feedPostIds) ? state.feedPostIds : [])
        .map(id => postsById.get(id)).filter(Boolean).slice(0, 30);
    if (generated.length > 0) return generated;
    const interests = new Set(Array.isArray(state.interests) ? state.interests : []);
    const active = INTEREST_IDS.has(activeInterest) ? activeInterest : '';
    const matches = post => active
        ? post.topics.includes(active)
        : post.topics.some(topic => interests.has(topic));
    return [
        ...SAMPLE_POSTS.filter(matches),
        ...SAMPLE_POSTS.filter(post => !matches(post)),
    ];
}

export function createPhoneWeiboPost(state, input = {}, now = Date.now()) {
    const post = normalizePost({
        id: input.id,
        content: input.content,
        topic: input.topic,
        customTopics: input.customTopics,
        imageDescription: input.imageDescription,
        location: input.location,
        mentions: input.mentions,
        createdAt: now,
    });
    if (!post) throw new Error('微博正文不能为空。');
    state.posts.unshift(post);
    return post;
}

export function createPhoneWeiboRepost(state, input = {}, now = Date.now()) {
    const post = normalizePost({
        id: input.id,
        kind: 'repost',
        content: text(input.content, 500) || '转发微博',
        topic: input?.source?.topic,
        source: input.source,
        createdAt: now,
    });
    if (!post?.source) throw new Error('没有找到需要转发的原帖。');
    state.posts.unshift(post);
    return post;
}

export function buildPhoneWeiboComments(post = {}) {
    if (Array.isArray(post?.hotComments) && post.hotComments.length > 0) {
        return post.hotComments.slice(0, 5).sort((left, right) => right.likes - left.likes).map(comment => ({
            ...comment,
            time: comment.time || relativeTime(comment.createdAt),
        }));
    }
    const postId = text(post?.id, 120);
    const contents = SAMPLE_COMMENT_CONTENT[postId];
    if (!Array.isArray(contents)) return [];
    return contents.slice(0, 5)
        .map((content, index) => ({
            ...COMMENT_AUTHORS[index],
            id: `${postId}-comment-${index + 1}`,
            content,
            likes: COMMENT_AUTHORS[index].likes + (stableHash(`${postId}-${index}`) % 380),
        }))
        .sort((left, right) => right.likes - left.likes);
}

export function createPhoneWeiboCommentReply(state, input = {}, now = Date.now()) {
    const reply = normalizeCommentReply({ ...input, createdAt: now });
    if (!reply) throw new Error('回复内容不能为空。');
    state.commentReplies.push(reply);
    return reply;
}

function element(documentRef, tag, className = '', content = '') {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    return node;
}

function button(documentRef, className, label, icon = '') {
    const node = element(documentRef, 'button', className);
    node.type = 'button';
    if (icon) {
        const glyph = element(documentRef, 'i', `fa-solid ${icon}`);
        glyph.setAttribute('aria-hidden', 'true');
        node.append(glyph);
    }
    if (label) node.append(element(documentRef, 'span', '', label));
    return node;
}

function avatar(documentRef, name, url = '', tone = 'rose') {
    const holder = element(documentRef, 'span', `memory-augment-weibo-avatar is-${tone}`);
    if (url) {
        const image = element(documentRef, 'img');
        image.src = url;
        image.alt = `${name}的头像`;
        holder.append(image);
    } else {
        holder.textContent = String(name || '我').trim().slice(0, 1);
    }
    return holder;
}

function relativeTime(timestamp) {
    const elapsed = Math.max(0, Date.now() - Number(timestamp || 0));
    if (elapsed < 60_000) return '刚刚';
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分钟前`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}小时前`;
    return `${Math.floor(elapsed / 86_400_000)}天前`;
}

export function createPhoneWeiboController(options = {}) {
    const documentRef = options.document ?? globalThis.document;
    const settings = options.settings ?? {};
    const saveSettings = options.saveSettings ?? (() => undefined);
    const contextGetter = options.contextGetter ?? (() => globalThis.SillyTavern?.getContext?.());
    const weiboAiReady = options.weiboAiReady ?? (() => false);
    const bootstrapWeibo = options.bootstrapWeibo;
    const performWeiboOperation = options.performWeiboOperation;
    let contentRoot = null;
    let activeTab = 'home';
    let viewMode = 'main';
    let weiboState = normalizePhoneWeiboState(settings);
    let lastMainScrollTop = 0;
    let detailPost = null;
    let detailOwn = false;
    let repostReturnMode = 'main';
    let repostReturnScroll = 0;
    let relationMode = 'following';
    let selectedRoleAccount = null;
    let identitySources = null;

    const profile = () => state().profile;
    const state = () => weiboState;
    const persist = () => saveSettings();

    function showWeiboError(error) {
        const message = text(error?.message, 500) || '微博更新失败，请稍后重试。';
        globalThis.toastr?.error?.(message, '微博更新失败');
        console.warn('[KKToolbox] Weibo operation failed.', error);
        return message;
    }

    async function runAiOperation(operation) {
        if (typeof performWeiboOperation !== 'function' || !weiboAiReady()) {
            throw new Error('请先配置弹幕/手机共用的 API，微博内容需要生成完整数据后才会发布。');
        }
        await performWeiboOperation(operation);
        weiboState = normalizePhoneWeiboState(settings);
        return weiboState;
    }

    async function getIdentitySources() {
        if (identitySources) return identitySources;
        identitySources = await loadPhoneIdentitySources(contextGetter?.());
        return identitySources;
    }

    async function resolveWeiboAvatar(input, currentAvatar = '', prefix = 'weibo-role') {
        if (input.file) return uploadPhoneImage(input.file, prefix);
        const url = text(input.url, 4000);
        if (!url) return input.url === '' ? '' : currentAvatar;
        let parsed;
        try {
            parsed = new URL(url, globalThis.location?.origin ?? 'http://localhost');
        } catch {
            throw new Error('头像链接格式不正确。');
        }
        if (!['http:', 'https:'].includes(parsed.protocol) && !url.startsWith('/user/files/')) {
            throw new Error('头像链接必须使用 http 或 https。');
        }
        return url;
    }

    async function editRoleAccount(account = null) {
        const sources = await getIdentitySources();
        const currentIdentity = normalizePhoneIdentity(account?.identity);
        const sourceValue = currentIdentity.mode === 'custom'
            ? 'custom'
            : sources.some(source => source.key === currentIdentity.sourceKey)
                ? currentIdentity.sourceKey
                : 'unbound';
        const details = currentIdentity.mode === 'custom' ? currentIdentity.persona : currentIdentity.note;
        const result = await openPhoneForm(contentRoot, {
            title: account ? '编辑微博角色账号' : '新建微博角色账号',
            submitLabel: account ? '保存' : '创建',
            fields: [
                {
                    name: 'nickname',
                    label: '微博昵称（不需要使用角色真名）',
                    value: account?.nickname ?? '',
                    required: true,
                },
                { name: 'bio', label: '微博简介', type: 'textarea', value: account?.bio ?? '' },
                {
                    name: 'identitySource',
                    label: '绑定人物身份',
                    type: 'select',
                    value: sourceValue,
                    options: getPhoneIdentitySelectOptions(sources),
                },
                {
                    name: 'identityDetails',
                    label: '自定义人物设定／绑定后的补充说明',
                    type: 'textarea',
                    value: details,
                    placeholder: '补充人物设定',
                },
                { name: 'url', label: '头像链接（可选）', type: 'url', value: account?.avatar ?? '' },
                { name: 'file', label: '本地头像（可选）', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' },
            ],
            onSubmit: async input => normalizeRoleAccount({
                id: account?.id,
                nickname: input.nickname,
                bio: input.bio,
                identity: getPhoneIdentityFromInput(input.identitySource, input.identityDetails, sources),
                avatar: await resolveWeiboAvatar(input, account?.avatar),
                createdAt: account?.createdAt,
            }),
        });
        if (!result) return;
        if (account) {
            Object.assign(account, result);
            selectedRoleAccount = account;
        } else {
            state().roleAccounts.push(result);
            selectedRoleAccount = result;
        }
        persist();
        renderRelations(relationMode);
    }

    async function editWeiboProfile() {
        const current = profile();
        const result = await openPhoneForm(contentRoot, {
            title: '编辑微博资料',
            submitLabel: '保存',
            fields: [
                { name: 'nickname', label: '微博昵称', value: current.nickname, required: true },
                { name: 'bio', label: '个人简介', type: 'textarea', value: current.bio, placeholder: '介绍一下这个微博账号。' },
                { name: 'url', label: '头像链接（可选）', type: 'url', value: current.avatar },
                { name: 'file', label: '本地头像（可选）', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' },
            ],
            onSubmit: async input => ({
                nickname: text(input.nickname, 80) || '我',
                bio: text(input.bio, 160),
                avatar: await resolveWeiboAvatar(input, current.avatar, 'weibo-profile'),
            }),
        });
        if (!result) return;
        state().profile = { ...current, ...result };
        persist();
        renderMain();
    }

    async function deleteRoleAccount(account) {
        if (!account) return;
        const confirmed = await openPhoneConfirm(contentRoot, {
            title: '删除微博角色账号',
            message: `确定删除“${account.nickname}”吗？关注、粉丝关系和这个账号主页会一起移除。`,
            confirmLabel: '删除',
        });
        if (!confirmed) return;
        const current = state();
        current.roleAccounts = current.roleAccounts.filter(item => item.id !== account.id);
        current.followingRoleIds = current.followingRoleIds.filter(id => id !== account.id);
        current.followerRoleIds = current.followerRoleIds.filter(id => id !== account.id);
        const removedPostIds = new Set(current.posts
            .filter(post => post.authorType === 'role' && post.authorId === account.id)
            .map(post => post.id));
        current.posts = current.posts.filter(post => !removedPostIds.has(post.id));
        current.feedPostIds = current.feedPostIds.filter(id => !removedPostIds.has(id));
        current.hotTopics = current.hotTopics.filter(topic => !removedPostIds.has(topic.postId));
        current.commentReplies = current.commentReplies.filter(reply => !removedPostIds.has(reply.postId));
        current.likedPostIds = current.likedPostIds.filter(id => !removedPostIds.has(id));
        selectedRoleAccount = null;
        persist();
        renderRelations(relationMode);
    }

    function prepareRoot() {
        if (!contentRoot) return null;
        contentRoot.classList.remove('is-messages', 'is-community', 'is-live');
        contentRoot.classList.add('is-weibo');
        contentRoot.replaceChildren();
        return contentRoot;
    }

    function rememberMainPosition() {
        lastMainScrollTop = contentRoot?.querySelector('.memory-augment-weibo-view')?.scrollTop ?? 0;
    }

    function returnToMain() {
        detailPost = null;
        detailOwn = false;
        renderMain();
    }

    function relationshipLabel(roleId) {
        return {
            mutual: '互相关注',
            following: '已关注',
            follower: '关注了你',
            none: '角色账号',
        }[getPhoneWeiboRelationship(state(), roleId)];
    }

    function toggleRoleRelation(kind, roleId) {
        const key = kind === 'followers' ? 'followerRoleIds' : 'followingRoleIds';
        const values = state()[key];
        const index = values.indexOf(roleId);
        if (index >= 0) values.splice(index, 1);
        else values.push(roleId);
        persist();
    }

    function repostSource(post, own) {
        const user = profile();
        if (own && post.kind === 'repost' && post.source) return post.source;
        return {
            postId: post.id,
            author: own ? user.nickname : post.author,
            badge: own ? 'KK PHONE 用户' : post.badge,
            content: post.content,
            topic: own ? post.topic : post.topics?.[0],
            visual: post.visual,
        };
    }

    function localReplyCount(postId) {
        const post = SAMPLE_POSTS.find(item => item.id === postId)
            ?? state().posts.find(item => item.id === postId);
        if (!post) return 0;
        const commentIds = new Set(buildPhoneWeiboComments(post).map(comment => comment.id));
        return state().commentReplies
            .filter(reply => reply.postId === postId && commentIds.has(reply.commentId))
            .length;
    }

    function localRepostCount(postId) {
        return state().posts.filter(post => post.kind === 'repost' && post.source?.postId === postId).length;
    }

    function toggleLike(postId, control, originalLikes = 0) {
        const current = state();
        const index = current.likedPostIds.indexOf(postId);
        if (index >= 0) current.likedPostIds.splice(index, 1);
        else current.likedPostIds.push(postId);
        const liked = index < 0;
        control.classList.toggle('is-liked', liked);
        const count = control.querySelector('span');
        if (count) count.textContent = compactNumber(originalLikes + (liked ? 1 : 0));
        persist();
    }

    function renderRepostCard(source) {
        const card = element(documentRef, 'section', 'memory-augment-weibo-repost-card');
        const author = element(documentRef, 'strong', '', `@${source.author}`);
        if (source.badge) author.append(element(documentRef, 'small', '', ` · ${source.badge}`));
        card.append(author);
        if (source.topic) card.append(element(documentRef, 'span', '', `#${INTEREST_LABELS.get(source.topic)}#`));
        card.append(element(documentRef, 'p', '', source.content));
        if (source.visual) {
            const visual = element(documentRef, 'div', 'memory-augment-weibo-repost-visual');
            visual.append(element(documentRef, 'i', 'fa-solid fa-image'), element(documentRef, 'span', '', source.visual));
            card.append(visual);
        }
        return card;
    }

    function renderPost(post, { own = false, inDetail = false } = {}) {
        const user = profile();
        const card = element(documentRef, 'article', 'memory-augment-weibo-post');
        const head = element(documentRef, 'header', 'memory-augment-weibo-post-head');
        const authorName = own ? user.nickname : post.author;
        head.append(avatar(documentRef, authorName, own ? user.avatar : post.avatar, own ? 'rose' : post.tone));
        const identity = element(documentRef, 'div', 'memory-augment-weibo-post-author');
        const nameLine = element(documentRef, 'strong', '', authorName);
        if (!own) nameLine.append(element(documentRef, 'i', 'fa-solid fa-circle-check'));
        identity.append(nameLine, element(
            documentRef,
            'small',
            '',
            own || post.createdAt
                ? `${relativeTime(post.createdAt)} · ${post.badge || '来自 KK PHONE'}`
                : `${post.badge} · ${post.time}`,
        ));
        head.append(identity, button(documentRef, 'memory-augment-weibo-more', '', 'fa-ellipsis'));
        card.append(head);

        const body = element(documentRef, 'div', 'memory-augment-weibo-post-body');
        const topic = post.topic || post.topics?.[0];
        if (topic) {
            body.append(element(documentRef, 'span', 'memory-augment-weibo-topic-label', `#${INTEREST_LABELS.get(topic)}#`));
        }
        if (Array.isArray(post.customTopics) && post.customTopics.length > 0) {
            post.customTopics.forEach(customTopic => {
                body.append(element(documentRef, 'span', 'memory-augment-weibo-custom-topic', `#${customTopic}#`));
            });
        }
        if (Array.isArray(post.mentions) && post.mentions.length > 0) {
            const mentions = element(documentRef, 'div', 'memory-augment-weibo-post-mentions');
            post.mentions.forEach(mention => mentions.append(element(documentRef, 'span', '', `@${mention.nickname}`)));
            body.append(mentions);
        }
        body.append(element(documentRef, 'div', 'memory-augment-weibo-post-text', post.content));
        if (post.kind === 'repost' && post.source) body.append(renderRepostCard(post.source));
        const visualDescription = post.imageDescription || post.visual;
        if (visualDescription) {
            const visual = element(documentRef, 'div', `memory-augment-weibo-post-visual is-${post.tone || 'rose'}`);
            visual.append(
                element(documentRef, 'i', 'fa-solid fa-image'),
                element(documentRef, 'strong', '', visualDescription),
            );
            body.append(visual);
        }
        if (post.location) {
            const location = element(documentRef, 'div', 'memory-augment-weibo-post-location');
            location.append(element(documentRef, 'i', 'fa-solid fa-location-dot'), documentRef.createTextNode(post.location));
            body.append(location);
        }
        card.append(body);

        const liked = state().likedPostIds.includes(post.id);
        const actions = element(documentRef, 'footer', 'memory-augment-weibo-post-actions');
        const repost = button(documentRef, '', compactNumber(post.reposts + localRepostCount(post.id)), 'fa-retweet');
        repost.title = '转发';
        repost.addEventListener('click', () => {
            if (viewMode === 'main') rememberMainPosition();
            renderRepostComposer(post, own);
        });
        const comments = button(documentRef, '', compactNumber(post.comments + localReplyCount(post.id)), 'fa-comment-dots');
        comments.title = '查看评论';
        if (!inDetail) comments.addEventListener('click', () => {
            rememberMainPosition();
            detailPost = post;
            detailOwn = own;
            renderComments();
        });
        actions.append(repost, comments);
        const like = button(documentRef, liked ? 'is-liked' : '', compactNumber(post.likes + (liked ? 1 : 0)), 'fa-heart');
        like.addEventListener('click', () => toggleLike(post.id, like, post.likes));
        actions.append(like);
        card.append(actions);
        return card;
    }

    function renderHome(view) {
        const current = state();
        const feed = element(documentRef, 'div', 'memory-augment-weibo-feed');
        const generatedFeed = buildPhoneWeiboFeed(current);
        if (current.feedPostIds.length === 0) {
            current.posts.forEach(post => feed.append(renderPost(post, { own: post.authorType === 'player' })));
        }
        generatedFeed.forEach(post => feed.append(renderPost(post, { own: post.authorType === 'player' })));
        view.append(feed);
    }

    function renderHot(view) {
        const feature = element(documentRef, 'section', 'memory-augment-weibo-hot-feature');
        feature.append(
            element(documentRef, 'span', '', 'TRENDING NOW'),
            element(documentRef, 'strong', '', '此刻，全网正在讨论'),
        );
        view.append(feature);
        const list = element(documentRef, 'div', 'memory-augment-weibo-hot-list');
        const topics = state().hotTopics.length > 0 ? state().hotTopics : HOT_TOPICS;
        topics.forEach((topic, index) => {
            const row = button(documentRef, 'memory-augment-weibo-hot-row', '');
            row.append(element(documentRef, 'span', `memory-augment-weibo-hot-rank${index < 3 ? ' is-top' : ''}`, String(index + 1)));
            const copy = element(documentRef, 'span', 'memory-augment-weibo-hot-copy');
            const title = element(documentRef, 'strong', '', topic.title);
            if (topic.mark) title.append(element(documentRef, 'em', `is-${topic.mark}`, topic.mark));
            const heat = typeof topic.heat === 'number' ? compactNumber(topic.heat) : topic.heat;
            copy.append(title, element(documentRef, 'small', '', `${INTEREST_LABELS.get(topic.category) || '实时'} · ${heat} 热度`));
            row.append(copy, element(documentRef, 'i', 'fa-solid fa-chevron-right'));
            row.addEventListener('click', () => {
                const post = state().posts.find(item => item.id === topic.postId)
                    ?? SAMPLE_POSTS.find(item => item.id === topic.postId);
                if (!post) return;
                rememberMainPosition();
                detailPost = post;
                detailOwn = post.authorType === 'player';
                renderComments();
            });
            list.append(row);
        });
        view.append(list);
    }

    function renderProfile(view) {
        const current = state();
        const user = profile();
        const playerPosts = current.posts.filter(post => post.authorType === 'player');
        const card = element(documentRef, 'section', 'memory-augment-weibo-profile');
        card.append(element(documentRef, 'div', 'memory-augment-weibo-profile-cover'));
        const main = element(documentRef, 'div', 'memory-augment-weibo-profile-main');
        main.append(avatar(documentRef, user.nickname, user.avatar, 'rose'));
        const compose = button(documentRef, 'memory-augment-weibo-profile-post', '发微博', 'fa-pen');
        compose.addEventListener('click', renderComposer);
        main.append(compose);
        card.append(main);
        const copy = element(documentRef, 'div', 'memory-augment-weibo-profile-copy');
        copy.append(
            element(documentRef, 'strong', '', user.nickname),
            element(documentRef, 'small', '', `@${user.nickname.replace(/\s+/g, '_')} · KK PHONE 用户`),
            element(documentRef, 'p', '', user.bio || '这个人很神秘，还没有填写简介。'),
        );
        card.append(copy);
        const stats = element(documentRef, 'div', 'memory-augment-weibo-profile-stats');
        [
            ['微博', playerPosts.length, ''],
            ['关注', 2 + current.followingRoleIds.length, 'following'],
            ['粉丝', current.followerCount + current.followerRoleIds.length, 'followers'],
        ].forEach(([label, value, mode]) => {
            const item = mode
                ? button(documentRef, 'memory-augment-weibo-profile-stat', '')
                : element(documentRef, 'span');
            item.append(element(documentRef, 'strong', '', String(value)), element(documentRef, 'small', '', label));
            if (mode) item.addEventListener('click', () => renderRelations(mode));
            stats.append(item);
        });
        card.append(stats);
        const actions = element(documentRef, 'div', 'memory-augment-weibo-profile-actions');
        const editProfile = button(documentRef, '', '编辑资料', 'fa-pen-to-square');
        editProfile.addEventListener('click', () => void editWeiboProfile());
        const interests = button(documentRef, '', '调整兴趣', 'fa-sliders');
        interests.addEventListener('click', renderInterestPicker);
        actions.append(editProfile, interests);
        card.append(actions);
        view.append(card);

        const heading = element(documentRef, 'div', 'memory-augment-weibo-section-heading');
        heading.append(element(documentRef, 'strong', '', '我的微博'), element(documentRef, 'small', '', `${playerPosts.length} 条`));
        view.append(heading);
        if (playerPosts.length === 0) {
            const empty = element(documentRef, 'div', 'memory-augment-weibo-empty');
            empty.append(
                element(documentRef, 'i', 'fa-solid fa-feather-pointed'),
                element(documentRef, 'strong', '', '还没有发布微博'),
            );
            const start = button(documentRef, '', '发布第一条');
            start.addEventListener('click', renderComposer);
            empty.append(start);
            view.append(empty);
            return;
        }
        const posts = element(documentRef, 'div', 'memory-augment-weibo-feed');
        playerPosts.forEach(post => posts.append(renderPost(post, { own: true })));
        view.append(posts);
    }

    function renderRoleAccountRow(account, mode) {
        const current = state();
        const key = mode === 'followers' ? 'followerRoleIds' : 'followingRoleIds';
        const included = current[key].includes(account.id);
        const row = element(documentRef, 'article', `memory-augment-weibo-role-row${included ? ' is-included' : ''}`);
        const open = button(documentRef, 'memory-augment-weibo-role-open', '');
        open.append(avatar(documentRef, account.nickname, account.avatar, 'violet'));
        const copy = element(documentRef, 'span', 'memory-augment-weibo-role-copy');
        copy.append(
            element(documentRef, 'strong', '', account.nickname),
            element(
                documentRef,
                'small',
                '',
                `${relationshipLabel(account.id)} · ${account.identity.label || '尚未绑定'}`,
            ),
        );
        open.append(copy);
        open.addEventListener('click', () => {
            selectedRoleAccount = account;
            renderRoleProfile();
        });
        const toggle = button(
            documentRef,
            `memory-augment-weibo-role-toggle${included ? ' is-active' : ''}`,
            mode === 'followers'
                ? (included ? '已添加' : '添加粉丝')
                : (included ? '已关注' : '关注'),
            included ? 'fa-check' : 'fa-plus',
        );
        toggle.addEventListener('click', () => {
            toggleRoleRelation(mode, account.id);
            renderRelations(mode);
        });
        row.append(open, toggle);
        return row;
    }

    function renderRelations(mode = relationMode) {
        relationMode = mode === 'followers' ? 'followers' : 'following';
        viewMode = 'relations';
        const root = prepareRoot();
        if (!root) return;
        const isFollowers = relationMode === 'followers';
        const wrapper = element(documentRef, 'section', 'memory-augment-weibo-relations');
        const header = element(documentRef, 'header', 'memory-augment-weibo-detail-header');
        const back = button(documentRef, '', '返回', 'fa-chevron-left');
        back.addEventListener('click', renderMain);
        header.append(
            back,
            element(documentRef, 'strong', '', isFollowers ? '粉丝' : '关注'),
            element(documentRef, 'span'),
        );
        const view = element(documentRef, 'main', 'memory-augment-weibo-relations-view');
        const intro = element(documentRef, 'section', 'memory-augment-weibo-relations-intro');
        const introCopy = element(documentRef, 'strong', '', isFollowers ? '角色粉丝' : '关注角色');
        const create = button(documentRef, 'memory-augment-weibo-role-create', '新建账号', 'fa-plus');
        create.addEventListener('click', () => void editRoleAccount());
        intro.append(introCopy, create);
        view.append(intro);
        const list = element(documentRef, 'div', 'memory-augment-weibo-role-list');
        const relationKey = isFollowers ? 'followerRoleIds' : 'followingRoleIds';
        const ordered = [...state().roleAccounts].sort((left, right) => (
            Number(state()[relationKey].includes(right.id)) - Number(state()[relationKey].includes(left.id))
        ));
        ordered.forEach(account => list.append(renderRoleAccountRow(account, relationMode)));
        if (ordered.length === 0) {
            const empty = element(documentRef, 'div', 'memory-augment-weibo-role-empty');
            empty.append(
                element(documentRef, 'i', 'fa-solid fa-user-plus'),
                element(documentRef, 'strong', '', '还没有建立微博角色账号'),
            );
            list.append(empty);
        }
        const others = element(documentRef, 'div', 'memory-augment-weibo-role-more');
        others.append(
            element(documentRef, 'span', 'memory-augment-weibo-role-more-icon', '+'),
            element(documentRef, 'strong', '', `还有 ${isFollowers ? state().followerCount : OTHER_FOLLOWING_COUNT} 位其他用户`),
        );
        list.append(others);
        view.append(list);
        wrapper.append(header, view);
        root.append(wrapper);
    }

    function renderRoleProfile() {
        if (!selectedRoleAccount) {
            renderRelations();
            return;
        }
        viewMode = 'role-profile';
        const root = prepareRoot();
        if (!root) return;
        const account = selectedRoleAccount;
        const wrapper = element(documentRef, 'section', 'memory-augment-weibo-role-profile-page');
        const header = element(documentRef, 'header', 'memory-augment-weibo-detail-header');
        const back = button(documentRef, '', '返回', 'fa-chevron-left');
        back.addEventListener('click', () => renderRelations(relationMode));
        const edit = button(documentRef, 'memory-augment-weibo-role-edit', '编辑');
        edit.addEventListener('click', () => void editRoleAccount(account));
        header.append(back, element(documentRef, 'strong', '', account.nickname), edit);
        const view = element(documentRef, 'main', 'memory-augment-weibo-role-profile-view');
        const card = element(documentRef, 'section', 'memory-augment-weibo-profile is-role');
        card.append(element(documentRef, 'div', 'memory-augment-weibo-profile-cover'));
        const main = element(documentRef, 'div', 'memory-augment-weibo-profile-main');
        main.append(avatar(documentRef, account.nickname, account.avatar, 'violet'));
        card.append(main);
        const copy = element(documentRef, 'div', 'memory-augment-weibo-profile-copy');
        copy.append(
            element(documentRef, 'strong', '', account.nickname),
            element(documentRef, 'small', '', `@${account.id.replace(/^weibo-role-/, '')} · ${account.identity.label || '尚未绑定'}`),
            element(documentRef, 'p', '', account.bio),
        );
        const relation = element(documentRef, 'span', 'memory-augment-weibo-role-relation', relationshipLabel(account.id));
        relation.dataset.relation = getPhoneWeiboRelationship(state(), account.id);
        copy.append(relation);
        card.append(copy);
        const accountActions = element(documentRef, 'div', 'memory-augment-weibo-role-profile-actions');
        const generatePost = button(documentRef, 'memory-augment-weibo-role-generate', '让TA发微博', 'fa-feather-pointed');
        generatePost.disabled = account.identity?.mode === 'unbound';
        generatePost.title = generatePost.disabled ? '请先给这个微博账号绑定角色身份' : '';
        generatePost.addEventListener('click', async () => {
            const instruction = await openPhoneForm(contentRoot, {
                title: `让 ${account.nickname} 发微博`,
                submitLabel: '生成并发布',
                fields: [{
                    name: 'instruction',
                    label: '想让TA发什么（可留空）',
                    type: 'textarea',
                    placeholder: '发帖内容',
                }],
                onSubmit: input => text(input.instruction, 500),
            });
            if (instruction === null) return;
            generatePost.disabled = true;
            generatePost.textContent = '正在生成…';
            try {
                await runAiOperation({ type: 'role_post', roleId: account.id, instruction });
                selectedRoleAccount = state().roleAccounts.find(item => item.id === account.id) ?? account;
                renderRoleProfile();
            } catch (error) {
                showWeiboError(error);
                renderRoleProfile();
            }
        });
        const remove = button(documentRef, 'is-danger', '删除账号', 'fa-trash');
        remove.addEventListener('click', () => void deleteRoleAccount(account));
        accountActions.append(generatePost, remove);
        card.append(accountActions);
        view.append(card);
        const rolePosts = state().posts.filter(post => post.authorType === 'role' && post.authorId === account.id);
        const heading = element(documentRef, 'div', 'memory-augment-weibo-section-heading');
        heading.append(element(documentRef, 'strong', '', `${account.nickname}的微博`), element(documentRef, 'small', '', '0 条'));
        heading.querySelector('small').textContent = `${rolePosts.length} 条`;
        view.append(heading);
        if (rolePosts.length > 0) {
            const posts = element(documentRef, 'div', 'memory-augment-weibo-feed');
            rolePosts.forEach(post => posts.append(renderPost(post)));
            view.append(posts);
            wrapper.append(header, view);
            root.append(wrapper);
            return;
        }
        const empty = element(documentRef, 'div', 'memory-augment-weibo-empty');
        empty.append(
            element(documentRef, 'i', 'fa-solid fa-feather-pointed'),
            element(documentRef, 'strong', '', '还没有发布微博'),
        );
        view.append(empty);
        wrapper.append(header, view);
        root.append(wrapper);
    }

    function renderNavigation(wrapper) {
        const nav = element(documentRef, 'nav', 'memory-augment-weibo-nav');
        [
            ['home', '首页', 'fa-house'],
            ['hot', '热搜', 'fa-arrow-trend-up'],
            ['profile', '我的', 'fa-user'],
        ].forEach(([id, label, icon]) => {
            const item = button(documentRef, activeTab === id ? 'is-active' : '', label, icon);
            item.addEventListener('click', () => {
                activeTab = id;
                lastMainScrollTop = 0;
                renderMain();
            });
            nav.append(item);
        });
        wrapper.append(nav);
    }

    function renderMain() {
        viewMode = 'main';
        const root = prepareRoot();
        if (!root) return;
        const wrapper = element(documentRef, 'section', 'memory-augment-phone-weibo');
        const topbar = element(documentRef, 'header', 'memory-augment-weibo-topbar');
        const brand = element(documentRef, 'strong');
        const pageTitle = activeTab === 'hot' ? '热搜' : activeTab === 'profile' ? '我的主页' : '推荐';
        brand.append(element(documentRef, 'i', 'fa-brands fa-weibo'), element(documentRef, 'span', '', pageTitle));
        topbar.append(brand);
        const view = element(documentRef, 'main', 'memory-augment-weibo-view');
        if (activeTab === 'hot') renderHot(view);
        else if (activeTab === 'profile') renderProfile(view);
        else renderHome(view);
        wrapper.append(topbar, view);
        renderNavigation(wrapper);
        root.append(wrapper);
        view.scrollTop = lastMainScrollTop;
    }

    function renderComments(restoreScroll = 0) {
        if (!detailPost) {
            returnToMain();
            return;
        }
        viewMode = 'comments';
        const root = prepareRoot();
        if (!root || !detailPost) return;
        const wrapper = element(documentRef, 'section', 'memory-augment-weibo-detail');
        const header = element(documentRef, 'header', 'memory-augment-weibo-detail-header');
        const back = button(documentRef, '', '返回', 'fa-chevron-left');
        back.addEventListener('click', returnToMain);
        header.append(back, element(documentRef, 'strong', '', '微博正文'), element(documentRef, 'span'));
        const view = element(documentRef, 'main', 'memory-augment-weibo-comments-view');
        view.append(renderPost(detailPost, { own: detailOwn, inDetail: true }));
        const hotComments = buildPhoneWeiboComments(detailPost);
        const heading = element(documentRef, 'div', 'memory-augment-weibo-comment-heading');
        heading.append(
            element(documentRef, 'strong', '', hotComments.length > 0 ? '热门评论' : '评论'),
            element(documentRef, 'small', '', hotComments.length > 0 ? '按热度排序 · 展示 5 条' : '0 条'),
        );
        view.append(heading);

        const replyForm = element(documentRef, 'form', 'memory-augment-weibo-reply-form');
        const replyHint = element(documentRef, 'small');
        const replyBox = element(documentRef, 'div');
        const replyInput = element(documentRef, 'textarea');
        replyInput.maxLength = 300;
        replyInput.rows = 1;
        replyInput.disabled = true;
        replyInput.placeholder = '回复评论';
        const replySend = button(documentRef, '', '发送');
        replySend.type = 'submit';
        replySend.disabled = true;
        replyBox.append(replyInput, replySend);
        replyForm.append(replyHint, replyBox);
        let replyTarget = null;
        const selectReplyTarget = comment => {
            replyTarget = comment;
            replyHint.textContent = `回复 @${comment.author}`;
            replyInput.disabled = false;
            replyInput.placeholder = `回复 @${comment.author}`;
            replySend.disabled = !replyInput.value.trim();
            replyInput.focus({ preventScroll: true });
        };
        replyInput.addEventListener('input', () => {
            replySend.disabled = !replyTarget || !replyInput.value.trim();
        });
        replyForm.addEventListener('submit', async event => {
            event.preventDefault();
            if (!replyTarget || !replyInput.value.trim()) return;
            const scrollTop = view.scrollTop;
            const content = replyInput.value;
            replyInput.disabled = true;
            replySend.disabled = true;
            replySend.textContent = '生成中…';
            try {
                await runAiOperation({
                    type: 'player_reply',
                    postId: detailPost.id,
                    commentId: replyTarget.id,
                    content,
                });
                detailPost = state().posts.find(post => post.id === detailPost.id) ?? detailPost;
                renderComments(scrollTop);
            } catch (error) {
                replyInput.disabled = false;
                replySend.disabled = false;
                replySend.textContent = '发送';
                showWeiboError(error);
            }
        });

        const comments = element(documentRef, 'div', 'memory-augment-weibo-comment-list');
        hotComments.forEach(comment => {
            const row = element(documentRef, 'article', 'memory-augment-weibo-comment');
            row.append(avatar(documentRef, comment.author, '', comment.tone));
            const copy = element(documentRef, 'div', 'memory-augment-weibo-comment-copy');
            const meta = element(documentRef, 'header');
            meta.append(
                element(documentRef, 'strong', '', comment.author),
                element(documentRef, 'small', '', comment.time),
            );
            copy.append(meta, element(documentRef, 'p', '', comment.content));
            const actions = element(documentRef, 'footer');
            const reply = button(documentRef, '', '回复', 'fa-reply');
            reply.addEventListener('click', () => selectReplyTarget(comment));
            const likes = button(documentRef, '', compactNumber(comment.likes), 'fa-thumbs-up');
            likes.disabled = true;
            actions.append(reply, likes);
            copy.append(actions);
            const savedReplies = state().commentReplies
                .filter(item => item.postId === detailPost.id && item.commentId === comment.id);
            if (savedReplies.length > 0) {
                const replies = element(documentRef, 'div', 'memory-augment-weibo-player-replies');
                savedReplies.forEach(item => {
                    const line = element(documentRef, 'p');
                    line.append(
                        element(documentRef, 'strong', '', profile().nickname),
                        documentRef.createTextNode(` 回复 @${comment.author}：${item.content}`),
                    );
                    replies.append(line);
                });
                copy.append(replies);
            }
            row.append(copy);
            comments.append(row);
        });
        if (hotComments.length === 0) {
            const empty = element(documentRef, 'div', 'memory-augment-weibo-comment-empty');
            empty.append(
                element(documentRef, 'i', 'fa-regular fa-comment-dots'),
                element(documentRef, 'strong', '', '还没有评论'),
            );
            comments.append(empty);
        }
        view.append(comments);
        wrapper.append(header, view);
        if (hotComments.length > 0) wrapper.append(replyForm);
        root.append(wrapper);
        view.scrollTop = restoreScroll;
    }

    function returnFromRepost() {
        if (repostReturnMode === 'comments' && detailPost) renderComments(repostReturnScroll);
        else renderMain();
    }

    function renderRepostComposer(post, own) {
        repostReturnMode = viewMode;
        repostReturnScroll = viewMode === 'comments'
            ? contentRoot?.querySelector('.memory-augment-weibo-comments-view')?.scrollTop ?? 0
            : 0;
        viewMode = 'repost';
        const root = prepareRoot();
        if (!root) return;
        const source = repostSource(post, own);
        const wrapper = element(documentRef, 'section', 'memory-augment-weibo-composer is-repost');
        const header = element(documentRef, 'header');
        const close = button(documentRef, '', '取消');
        close.addEventListener('click', returnFromRepost);
        const publish = button(documentRef, 'is-publish', '转发');
        header.append(close, element(documentRef, 'strong', '', '转发微博'), publish);
        const user = profile();
        const body = element(documentRef, 'div', 'memory-augment-weibo-composer-body');
        body.append(avatar(documentRef, user.nickname, user.avatar, 'rose'));
        const editor = element(documentRef, 'div', 'memory-augment-weibo-editor');
        const textarea = element(documentRef, 'textarea');
        textarea.maxLength = 500;
        textarea.placeholder = '说说你的想法…（可以留空）';
        const counter = element(documentRef, 'small', '', '0 / 500');
        editor.append(textarea, counter);
        body.append(editor);
        const preview = element(documentRef, 'div', 'memory-augment-weibo-repost-preview');
        preview.append(renderRepostCard(source));
        wrapper.append(header, body, preview);
        root.append(wrapper);
        textarea.addEventListener('input', () => {
            counter.textContent = `${textarea.value.length} / 500`;
        });
        publish.addEventListener('click', async () => {
            publish.disabled = true;
            publish.textContent = '生成中…';
            try {
                await runAiOperation({ type: 'player_repost', source, content: textarea.value });
                activeTab = 'profile';
                lastMainScrollTop = 0;
                detailPost = null;
                detailOwn = false;
                renderMain();
            } catch (error) {
                publish.disabled = false;
                publish.textContent = '转发';
                showWeiboError(error);
            }
        });
        textarea.focus();
    }

    function renderInterestPicker() {
        viewMode = 'interests';
        const root = prepareRoot();
        if (!root) return;
        const current = state();
        const selected = new Set(current.interests);
        const wrapper = element(documentRef, 'section', 'memory-augment-weibo-onboarding');
        const header = element(documentRef, 'header');
        header.append(
            element(documentRef, 'span', '', current.interests.length ? '调整你的推荐' : 'WELCOME TO WEIBO'),
            element(documentRef, 'strong', '', '你想看些什么？'),
        );
        wrapper.append(header);
        const grid = element(documentRef, 'div', 'memory-augment-weibo-interest-grid');
        const count = element(documentRef, 'small', 'memory-augment-weibo-interest-count');
        const done = button(documentRef, 'memory-augment-weibo-primary', current.interests.length ? '保存兴趣' : '开始逛微博', 'fa-arrow-right');
        const update = () => {
            count.textContent = selected.size > 0 ? `已选择 ${selected.size} 个兴趣` : '至少选择一个兴趣';
            done.disabled = selected.size === 0;
        };
        PHONE_WEIBO_INTERESTS.forEach(interest => {
            const chip = button(
                documentRef,
                selected.has(interest.id) ? 'is-selected' : '',
                interest.label,
                interest.icon,
            );
            chip.addEventListener('click', () => {
                if (selected.has(interest.id)) selected.delete(interest.id);
                else selected.add(interest.id);
                chip.classList.toggle('is-selected', selected.has(interest.id));
                update();
            });
            grid.append(chip);
        });
        done.addEventListener('click', () => {
            current.interests = [...selected];
            persist();
            activeTab = 'home';
            if (!current.initialized && weiboAiReady()) void initializeAiFeed();
            else renderMain();
        });
        const footer = element(documentRef, 'footer');
        footer.append(count, done);
        wrapper.append(grid, footer);
        root.append(wrapper);
        update();
    }

    function renderComposer() {
        viewMode = 'compose';
        const root = prepareRoot();
        if (!root) return;
        const current = state();
        const customTopics = [];
        let imageDescription = '';
        let location = '';
        const selectedMentionIds = new Set();
        const wrapper = element(documentRef, 'section', 'memory-augment-weibo-composer');
        const header = element(documentRef, 'header');
        const close = button(documentRef, '', '取消');
        const title = element(documentRef, 'strong', '', '发微博');
        const publish = button(documentRef, 'is-publish', '发布');
        header.append(close, title, publish);
        const user = profile();
        const body = element(documentRef, 'div', 'memory-augment-weibo-composer-body');
        body.append(avatar(documentRef, user.nickname, user.avatar, 'rose'));
        const editor = element(documentRef, 'div', 'memory-augment-weibo-editor');
        const textarea = element(documentRef, 'textarea');
        textarea.maxLength = 500;
        textarea.placeholder = '分享此刻的新鲜事…';
        const counter = element(documentRef, 'small', '', '0 / 500');
        editor.append(textarea, counter);
        body.append(editor);
        const topicBox = element(documentRef, 'section', 'memory-augment-weibo-compose-topics');
        const topicHeading = element(documentRef, 'header');
        topicHeading.append(element(documentRef, 'strong', '', '话题（可选）'));
        const customTopicButton = button(documentRef, '', '添加话题', 'fa-plus');
        topicHeading.append(customTopicButton);
        topicBox.append(topicHeading);
        const topicStrip = element(documentRef, 'div');
        topicBox.append(topicStrip);
        const extras = element(documentRef, 'div', 'memory-augment-weibo-compose-extras');
        const toolPanel = element(documentRef, 'section', 'memory-augment-weibo-compose-tool-panel');
        toolPanel.hidden = true;
        const tools = element(documentRef, 'div', 'memory-augment-weibo-compose-tools');
        const toolButtons = new Map();
        [['image', 'fa-image', '图片'], ['mention', 'fa-at', '提及'], ['emoji', 'fa-face-smile', '表情'], ['location', 'fa-location-dot', '位置']].forEach(([id, icon, label]) => {
            const tool = button(documentRef, '', label, icon);
            toolButtons.set(id, tool);
            tools.append(tool);
        });
        wrapper.append(header, body, topicBox, extras, toolPanel, tools);
        root.append(wrapper);

        const mentionAccounts = () => {
            const allowed = new Set([...current.followingRoleIds, ...current.followerRoleIds]);
            return current.roleAccounts.filter(account => allowed.has(account.id));
        };

        const renderExtras = () => {
            extras.replaceChildren();
            const descriptors = [
                imageDescription && ['fa-image', imageDescription],
                selectedMentionIds.size > 0 && ['fa-at', `已提及 ${selectedMentionIds.size} 人`],
                location && ['fa-location-dot', location],
            ].filter(Boolean);
            descriptors.forEach(([icon, label]) => {
                const chip = element(documentRef, 'span');
                chip.append(element(documentRef, 'i', `fa-solid ${icon}`), documentRef.createTextNode(label));
                extras.append(chip);
            });
            extras.hidden = descriptors.length === 0;
        };

        const renderCustomTopics = () => {
            topicStrip.replaceChildren();
            if (customTopics.length === 0) return;
            customTopics.forEach((topic, index) => {
                const chip = button(documentRef, 'is-custom', `#${topic}# ×`);
                chip.setAttribute('aria-label', `删除话题 ${topic}`);
                chip.addEventListener('click', () => {
                    customTopics.splice(index, 1);
                    renderCustomTopics();
                    textarea.focus({ preventScroll: true });
                });
                topicStrip.append(chip);
            });
        };

        const showToolPanel = type => {
            toolPanel.replaceChildren();
            toolPanel.hidden = false;
            toolButtons.forEach((control, id) => control.classList.toggle('is-active', id === type));
            const panelHeader = element(documentRef, 'header');
            panelHeader.append(element(documentRef, 'strong', '', type === 'mention' ? '选择要提及的人' : '选择表情'));
            const closePanel = button(documentRef, '', '完成', 'fa-check');
            closePanel.addEventListener('click', () => {
                toolPanel.hidden = true;
                toolButtons.forEach(control => control.classList.remove('is-active'));
                textarea.focus({ preventScroll: true });
            });
            panelHeader.append(closePanel);
            toolPanel.append(panelHeader);
            const grid = element(documentRef, 'div');
            if (type === 'mention') {
                const accounts = mentionAccounts();
                if (accounts.length === 0) {
                    grid.append(element(documentRef, 'small', 'memory-augment-weibo-compose-tool-empty', '关注或粉丝名单里还没有角色账号。'));
                }
                accounts.forEach(account => {
                    const selected = selectedMentionIds.has(account.id);
                    const control = button(documentRef, selected ? 'is-selected' : '', account.nickname);
                    control.addEventListener('click', () => {
                        if (selectedMentionIds.has(account.id)) selectedMentionIds.delete(account.id);
                        else selectedMentionIds.add(account.id);
                        showToolPanel('mention');
                        renderExtras();
                    });
                    grid.append(control);
                });
            } else {
                ['😀', '😂', '🥹', '😍', '🥰', '😎', '🤔', '😭', '😤', '🥳', '😴', '🙈', '👍', '👏', '🙏', '❤️', '💔', '✨', '🔥', '🎉', '🌙', '🍉', '🐾', '📷'].forEach(emoji => {
                    const control = button(documentRef, '', emoji);
                    control.setAttribute('aria-label', `插入表情 ${emoji}`);
                    control.addEventListener('click', () => {
                        const start = textarea.selectionStart ?? textarea.value.length;
                        const end = textarea.selectionEnd ?? start;
                        textarea.value = `${textarea.value.slice(0, start)}${emoji}${textarea.value.slice(end)}`.slice(0, textarea.maxLength);
                        const cursor = Math.min(textarea.value.length, start + emoji.length);
                        textarea.setSelectionRange(cursor, cursor);
                        update();
                    });
                    grid.append(control);
                });
            }
            toolPanel.append(grid);
        };

        customTopicButton.addEventListener('click', async () => {
            const result = await openPhoneForm(contentRoot, {
                title: '添加微博话题',
                submitLabel: '添加',
                fields: [{ name: 'topic', label: '话题名称', placeholder: '话题名称' }],
                onSubmit: input => text(input.topic, 50).replace(/^#+|#+$/g, ''),
            });
            if (!result) {
                textarea.focus({ preventScroll: true });
                return;
            }
            if (!customTopics.includes(result)) customTopics.push(result);
            renderCustomTopics();
            textarea.focus({ preventScroll: true });
        });
        toolButtons.get('image').addEventListener('click', async () => {
            const result = await openPhoneForm(contentRoot, {
                title: '添加图片描述',
                submitLabel: '添加',
                fields: [{ name: 'description', label: '图片画面描述', type: 'textarea', value: imageDescription, required: true, placeholder: '例如：雨夜车窗外的霓虹灯，玻璃上有水珠。' }],
                onSubmit: input => text(input.description, 240),
            });
            if (result === null) return;
            imageDescription = result;
            renderExtras();
            textarea.focus({ preventScroll: true });
        });
        toolButtons.get('mention').addEventListener('click', () => showToolPanel('mention'));
        toolButtons.get('emoji').addEventListener('click', () => showToolPanel('emoji'));
        toolButtons.get('location').addEventListener('click', async () => {
            const result = await openPhoneForm(contentRoot, {
                title: '添加位置',
                submitLabel: '添加',
                fields: [{ name: 'location', label: '位置文字', value: location, required: true, placeholder: '例如：星光影视城 · A3 摄影棚' }],
                onSubmit: input => text(input.location, 120),
            });
            if (result === null) return;
            location = result;
            renderExtras();
            textarea.focus({ preventScroll: true });
        });
        const update = () => {
            counter.textContent = `${textarea.value.length} / 500`;
            publish.disabled = !textarea.value.trim();
        };
        textarea.addEventListener('input', update);
        close.addEventListener('click', renderMain);
        publish.addEventListener('click', async () => {
            if (!textarea.value.trim()) return;
            const accountsById = new Map(current.roleAccounts.map(account => [account.id, account]));
            const mentions = [...selectedMentionIds].map(id => accountsById.get(id)).filter(Boolean)
                .map(account => ({ id: account.id, nickname: account.nickname }));
            publish.disabled = true;
            publish.textContent = '生成中…';
            try {
                await runAiOperation({
                    type: 'player_post',
                    content: textarea.value,
                    customTopics,
                    imageDescription,
                    location,
                    mentions,
                });
                activeTab = 'profile';
                renderMain();
            } catch (error) {
                publish.disabled = false;
                publish.textContent = '发布';
                showWeiboError(error);
            }
        });
        renderCustomTopics();
        renderExtras();
        update();
        textarea.focus();
    }

    function renderAiStatus(errorMessage = '') {
        viewMode = 'loading';
        const root = prepareRoot();
        if (!root) return;
        const wrapper = element(documentRef, 'section', 'memory-augment-weibo-ai-status');
        wrapper.append(
            element(documentRef, 'i', errorMessage ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-spinner fa-spin'),
            element(documentRef, 'strong', '', errorMessage ? '加载失败' : '正在加载…'),
        );
        if (errorMessage) wrapper.append(element(documentRef, 'p', '', errorMessage));
        if (errorMessage) {
            const retry = button(documentRef, 'memory-augment-weibo-primary', '重新生成', 'fa-rotate-right');
            retry.addEventListener('click', () => void initializeAiFeed());
            wrapper.append(retry);
        }
        root.append(wrapper);
    }

    async function initializeAiFeed() {
        if (typeof bootstrapWeibo !== 'function' || !weiboAiReady()) {
            renderMain();
            return;
        }
        renderAiStatus();
        try {
            await bootstrapWeibo();
            weiboState = normalizePhoneWeiboState(settings);
            renderMain();
        } catch (error) {
            weiboState = normalizePhoneWeiboState(settings);
            renderAiStatus(showWeiboError(error));
        }
    }

    globalThis.addEventListener?.('memory-augment-weibo-updated', () => {
        weiboState = normalizePhoneWeiboState(settings);
        if (contentRoot && viewMode === 'main') renderMain();
    });

    return {
        async open(content) {
            contentRoot = content;
            weiboState = normalizePhoneWeiboState(settings);
            if (state().interests.length === 0) renderInterestPicker();
            else if (!state().initialized && weiboAiReady()) await initializeAiFeed();
            else renderMain();
        },
        back() {
            if (viewMode === 'compose') {
                renderMain();
                return true;
            }
            if (viewMode === 'comments') {
                returnToMain();
                return true;
            }
            if (viewMode === 'repost') {
                returnFromRepost();
                return true;
            }
            if (viewMode === 'role-profile') {
                renderRelations(relationMode);
                return true;
            }
            if (viewMode === 'relations') {
                renderMain();
                return true;
            }
            if (viewMode === 'interests' && state().interests.length > 0) {
                renderMain();
                return true;
            }
            if (viewMode === 'loading') return true;
            return false;
        },
    };
}
