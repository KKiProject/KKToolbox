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
            { author: '后台通行证', content: '如果是散场以后，今晚公开行程里确实只有那一组留到最后。', likes: 306 },
            { author: '不信谣但爱蹲', content: '先码住外套款式，下一次公开照片说不定能对上。', likes: 214 },
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
            { author: '预告片考古队', content: '预告字幕的断句也支持第三幕，和结尾的语气完全不同。', likes: 337 },
            { author: '场记板收藏家', content: '补充一张花絮时间轴：这场戏确实拍在公开选择之前。', likes: 269 },
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
            { author: '台词本夹书签', content: '他每次问“你想不想”之前都会停顿，那一下更像在等退路。', likes: 203 },
            { author: '反复重看第三集', content: '真正的成长应该是敢说“我希望你留下”，不是继续替别人决定。', likes: 176 },
            { author: '角色不是圣人', content: '这个角度好，温柔和回避责任完全可以同时存在。', likes: 149 },
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
            { author: '活动流程搬运工', content: '往年流程单已补在二楼，座位按品牌合作区分得很清楚。', likes: 772 },
            { author: '只想看舞台', content: '吵座位不如等等正式舞台，至少作品不会骗人。', likes: 615 },
            { author: '广场降温小组', content: '已经有营销号截了半张图带节奏，别再给它贡献热度了。', likes: 508 },
        ],
    },
]);

const SAMPLE_CP_RANKINGS = Object.freeze([
    {
        id: 'cp-starlight', rank: 1, name: '星遥', kind: 'directional', kindLabel: '角色CP', left: '顾星野', right: '沈知遥', pairing: '顾星野 × 沈知遥', members: ['顾星野', '沈知遥'], series: '长街灯火', trend: 'up', change: 2, heat: '986.4万',
        weekly: '后台同披一件外套，采访时顾星野又精准接住了沈知遥没说完的半句话。',
        comments: [
            { author: '星遥今日饭票', content: '顾星野递外套，沈知遥连客套都没有，这种熟稔感比官糖还狠。', likes: 1320 },
            { author: '星遥固定产出', content: '这周星遥的照顾感真的赢很大，后台那段完全是下意识反应。', likes: 987 },
            { author: '采访逐字稿', content: '接后半句话那里两个人甚至没对视，完全是肌肉记忆。', likes: 846 },
            { author: '星遥站姐', content: '从第三升第一合理，这周新糖和旧糖还能连成时间线。', likes: 711 },
            { author: '不拆不逆也围观', content: '路人路过都能看懂的程度，榜一今天实至名归。', likes: 560 },
        ],
    },
    {
        id: 'cp-echo', rank: 2, name: '十年搭档组', kind: 'group', kindLabel: '关系组', pairing: '贺听澜 & 周屿白', members: ['贺听澜', '周屿白'], series: '回声计划', trend: 'same', change: 0, heat: '843.7万',
        weekly: '返场曲换了两人第一次合作时的旧版编曲，十年前后的舞台被完整接在了一起。',
        comments: [
            { author: '回声计划考古队', content: '不是随便一版，偏偏是第一次合作的版本，这谁顶得住。', likes: 1056 },
            { author: '耳机分我一半', content: '贺听澜唱到那句时周屿白在侧台抬头了，导播没切全太可惜。', likes: 823 },
            { author: '十年搭档组资料站', content: '旧编曲像从十年前寄回来的回信，老搭档的分量就在这里。', likes: 644 },
            { author: '回声考古局', content: '十年前和十年后波形对比帖已经出了，改动只在最后八小节。', likes: 587 },
            { author: '节目老观众', content: '《回声计划》的十年搭档组很稳，不大起大落但每周都有新东西。', likes: 410 },
        ],
    },
    {
        id: 'cp-summer', rank: 3, name: '迟早', kind: 'pun', kindLabel: '谐音CP', left: '夏栖迟', right: '林照', pairing: '夏栖迟 × 林照', members: ['夏栖迟', '林照'], series: '盛夏来信', trend: 'up', change: 4, heat: '721.9万',
        weekly: '花絮里只出现两秒的拍立得，被发现背面写着林照惯用的落款；“迟”和“照”也因此被圈内玩成了“迟早”。',
        comments: [
            { author: '迟早拍立得相馆', content: '背面那个小太阳就是林照的落款，前面三个物料都出现过。', likes: 899 },
            { author: '迟早今天结婚吗', content: '夏栖迟把照片夹在贴身本子里才是重点吧。', likes: 768 },
            { author: '盛夏花絮考古', content: '林照拍的人，夏栖迟一直留着，这张照片的流向才是糖点。', likes: 542 },
            { author: '花絮垃圾桶', content: '两秒素材养活一个圈，剪辑老师谢谢你没删干净。', likes: 499 },
            { author: '迟早今日播报', content: '一周升四名，新人产品爆发力恐怖如斯。', likes: 381 },
        ],
    },
    {
        id: 'cp-moon', rank: 4, name: '月川', kind: 'directional', kindLabel: '角色CP', left: '江月', right: '陆长川', pairing: '江月 × 陆长川', members: ['江月', '陆长川'], series: '长夜追凶', trend: 'down', change: 3, heat: '655.2万',
        weekly: '本周正片零同框，但预告里出现了疑似陆长川留给江月的录音笔。',
        comments: [
            { author: '月川案情分析处', content: '录音笔编号和陆长川办公室抽屉里那支一致，不是随便一个道具。', likes: 780 },
            { author: '月川不许毕业', content: '零同框还能靠一支录音笔撑住第四，产品生命力可以。', likes: 634 },
            { author: '月川档案管理员', content: '江月听录音时那个表情明显认出了声音，下一集必须给我见面。', likes: 590 },
            { author: '长夜熬夜组', content: '下降只是本周没同框，不代表我们月川不行。', likes: 438 },
            { author: '录音笔本人', content: '我宣布隔空交付重要证物也算某种约会。', likes: 366 },
        ],
    },
    {
        id: 'cp-rain', rank: 5, name: '旧识组', kind: 'group', kindLabel: '关系组', pairing: '闻雨 & 程停', members: ['闻雨', '程停'], series: '逐光舞台', trend: 'new', change: 0, heat: '598.1万',
        weekly: '路演结束时程停伸手替闻雨挡了一下台阶，镜头外还喊了只有旧训练时期才用的小名。',
        comments: [
            { author: '逐光旧档案', content: '那个小名只在练习生时期出现过，旧识组突然有了完整时间线。', likes: 744 },
            { author: '旧识组前排', content: '程停挡台阶的手等人站稳才收回去，动作特别自然。', likes: 620 },
            { author: '路演收音组', content: '镜头外那个小名更要命，公开场合没人这样喊闻雨。', likes: 515 },
            { author: '路演前排', content: '现场确认不是主持人喊的，声音方向就在主创席。', likes: 446 },
            { author: '逐光舞台老观众', content: '这个组名必须带《逐光舞台》，不然隔壁也有一对旧识。', likes: 329 },
        ],
    },
    {
        id: 'cp-cloud', rank: 6, name: 'All临', kind: 'allx', kindLabel: 'All×', pairing: '云渡／谢燃／方既白 → 贺临', members: ['云渡', '谢燃', '方既白', '贺临'], target: '贺临', series: '巅峰时刻', trend: 'up', change: 1, heat: '510.8万',
        weekly: '贺临本周分别收到云渡递来的保温杯、谢燃留下的战术笔记和方既白替他挡掉的一次追问，三条线同时更新。',
        comments: [
            { author: 'All临今日菜单', content: '一周三条线都发粮，中心人物待遇终于来了。', likes: 690 },
            { author: '巅峰时刻杂食党', content: '保温杯、战术本、替他挡问题，口味不同但都很香。', likes: 574 },
            { author: '贺临中心粮仓', content: 'All临不是把几对方向混在一起，是明确以贺临为中心，别搬错tag。', likes: 482 },
            { author: '电竞同人粮仓', content: '今天新增二十篇文，三条线各有各的饭。', likes: 405 },
            { author: '纯路人但磕到了', content: '第一次见榜里有All向，终于不全是双人左右了。', likes: 311 },
        ],
    },
]);

const SAMPLE_FAN_WORKS = Object.freeze([
    {
        id: 'fan-article-platform', type: 'article', typeLabel: '同人文', title: '《末班站台》｜他错过了最后一班车',
        creator: '夜航信箱', cpName: '星遥', pairing: '顾星野 × 沈知遥', series: '长街灯火', characters: ['顾星野', '沈知遥'], tags: ['长街灯火', '顾星野', '沈知遥', '星遥'], time: '15分钟前', likes: 2381, comments: 146,
        summary: '现代都市 · 久别重逢 · 一发完',
        preview: '雨水沿着站牌一笔一画地往下淌。他站在空无一人的月台尽头，手机屏幕亮了又暗，始终没有拨出那个号码。广播第三次提醒末班车即将进站时，身后忽然有人叫了他的名字。那声音隔着十年光阴，仍然准确得让他不敢回头……',
        commentsList: [
            { author: '凌晨三点不睡觉', content: '停在这里是人能干出来的事吗！全文链接呢！', likes: 492 },
            { author: '糖分摄入超标', content: '“准确得让他不敢回头”这句太会写了。', likes: 376 },
            { author: '星遥深夜食堂', content: '顾星野在站台等，沈知遥从身后叫住他，这个左右味太正了。', likes: 341 },
            { author: '末班车驾驶员', content: '老师把十年久别和当前剧情那封信扣上了，完全不是空架 AU。', likes: 286 },
            { author: '星遥粮仓管理员', content: '试读一百字已经把我钓住了，收藏等全文。', likes: 214 },
        ],
    },
    {
        id: 'fan-art-balcony', type: 'art', typeLabel: '画作', title: '雨夜阳台｜双人氛围插画',
        creator: '蓝灰色铅笔', cpName: '月川', pairing: '江月 × 陆长川', series: '长夜追凶', characters: ['江月', '陆长川'], tags: ['长夜追凶', '江月', '陆长川', '月川'], time: '33分钟前', likes: 4106, comments: 227,
        summary: '画面描述：深蓝雨夜，两个人隔着半开的玻璃门对望，室内暖光落在其中一人的肩上。',
        preview: '作品使用低饱和蓝灰色调，玻璃上的雨痕把两人的倒影叠在一起。没有直接牵手，但垂下的手指在倒影里几乎相触。',
        commentsList: [
            { author: '壁纸收集站', content: '倒影里的手指！老师您是懂留白的。', likes: 711 },
            { author: '今晚吃得很好', content: '一冷一暖的光刚好对应两个人现在的状态。', likes: 548 },
            { author: '月川美术馆', content: '江月在室外冷光里，陆长川站在门内暖光里，构图就是他们的关系。', likes: 469 },
            { author: '月川倒影研究所', content: '现实没碰到，倒影先牵手，这个处理太适合当前零同框剧情。', likes: 401 },
            { author: '画师请收膝盖', content: '玻璃雨痕没有挡脸，反而把两个人的轮廓缝在一起了。', likes: 328 },
        ],
    },
    {
        id: 'fan-video-eyes', type: 'video', typeLabel: '剪辑', title: '【眼神向】他每次说谎都会先看向同一个人',
        creator: '一帧一帧嗑', cpName: '听屿', pairing: '贺听澜 × 周屿白', series: '回声计划', characters: ['贺听澜', '周屿白'], tags: ['回声计划', '贺听澜', '周屿白', '听屿'], time: '1小时前', likes: 6950, comments: 504,
        summary: '视频描述：02:17 的剧情向剪辑，按时间排列七次下意识对视，结尾接第一次合作的旧画面。',
        preview: '剪辑以环境音开场，每一次鼓点都落在人物移开视线的瞬间。最后旧画面与最新采访重叠，同一句话形成前后呼应。',
        commentsList: [
            { author: '暂停键受害者', content: '第三次对视以前我还能嘴硬，看到第七次彻底投降。', likes: 988 },
            { author: '考古队一号', content: '结尾旧素材接得太神了，原来这么早就有呼应。', likes: 804 },
            { author: '听屿镜头语言课', content: '贺听澜说谎时先找周屿白，说明他潜意识里只在意一个人信不信。', likes: 733 },
            { author: '听屿循环播放', content: '02:03 那个叠化把十年前和现在的视线连成一条线了。', likes: 602 },
            { author: '剪辑区常住人口', content: '没有乱塞慢动作，全靠原镜头顺序讲关系，太高级了。', likes: 471 },
        ],
    },
    {
        id: 'fan-au-coffee', type: 'au', typeLabel: 'AU', title: '咖啡店 AU：每天点错单的人和从不纠正他的店长',
        creator: '平行宇宙办事处', cpName: '迟早', pairing: '夏栖迟 × 林照', series: '盛夏来信', characters: ['夏栖迟', '林照'], tags: ['盛夏来信', '夏栖迟', '林照', '迟早'], time: '2小时前', likes: 1877, comments: 193,
        summary: '咖啡店店长 × 赶稿摄影师，轻喜剧设定讨论楼',
        preview: '设定是摄影师每天睡眠不足，点单永远说错；店长第一次纠正，第二次沉默，第三次开始直接把真正想喝的递给他。直到某天摄影师清醒地说对了，店长反而愣住。',
        commentsList: [
            { author: 'AU永动机', content: '求加入“杯套背面画小相机”的设定！', likes: 321 },
            { author: '拿铁不加糖', content: '说对了反而愣住，这个瞬间已经能脑补一万字。', likes: 287 },
            { author: '迟早咖啡店股东', content: '夏栖迟每天说错，林照却永远递对，这不就是原作拍立得糖的 AU 变体。', likes: 258 },
            { author: '迟早今日菜单', content: '建议店长把错误点单都记下来，最后发现已经记满一本。', likes: 214 },
            { author: '平行宇宙催更部', content: '设定楼不要只放梗概，求老师真的写！', likes: 181 },
        ],
    },
    {
        id: 'fan-discussion-sugar', type: 'discussion', typeLabel: '放大镜找糖', title: '把两场采访的桌面反光叠了一下，那个挂件是不是同一个？',
        creator: '显微镜十级选手', cpName: '星遥', pairing: '顾星野 × 沈知遥', series: '长街灯火', characters: ['顾星野', '沈知遥'], tags: ['长街灯火', '顾星野', '沈知遥', '星遥'], time: '3小时前', likes: 3204, comments: 389,
        summary: '细节讨论 · 欢迎补充证据，拒绝造谣式认领',
        preview: '第一场采访右下角只露出一小截银色链条，第二场直播里能看到完整挂件。形状和缺口位置高度相似，但目前没有清晰正面图，只能算待确认糖点。',
        commentsList: [
            { author: '谨慎嗑糖人', content: '形状像，但链条长度不太一样，先放进疑似区。', likes: 466 },
            { author: '物料整理组', content: '补充：同品牌只有这一款有侧面缺口。', likes: 422 },
            { author: '星遥证据保全处', content: '顾星野采访那场的反光方向相反，长度可能只是透视问题。', likes: 381 },
            { author: '星遥显微镜分镜', content: '沈知遥直播里挂件背面有一道划痕，等高清图对位置。', likes: 310 },
            { author: '拒绝造谣式认领', content: '目前最多算同款疑似，楼主标注很规范，别搬出去说实锤。', likes: 294 },
        ],
    },
]);

function clone(value) {
    return typeof globalThis.structuredClone === 'function'
        ? globalThis.structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function normalizeComments(value, fallback, ownerId) {
    const combined = [
        ...(Array.isArray(value) ? value : []),
        ...(Array.isArray(fallback) ? fallback : []),
    ];
    const unique = [];
    const seen = new Set();
    for (const comment of combined) {
        const content = text(comment?.content, 400);
        if (!content) continue;
        const key = `${text(comment?.author, 80)}\n${content}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({
            id: text(comment?.id, 120) || `${ownerId}-comment-${unique.length + 1}`,
            author: text(comment?.author, 80) || '社区用户',
            content,
            likes: Math.max(0, Math.trunc(Number(comment?.likes) || 0)),
        });
        if (unique.length === 5) break;
    }
    return unique;
}

function mergeKnownItems(value, fallback, kind) {
    const source = Array.isArray(value) && value.length > 0 ? clone(value) : clone(fallback);
    const seeds = new Map(fallback.map(item => [item.id, item]));
    return source.map((item, index) => {
        const seed = seeds.get(item?.id);
        const id = text(item?.id, 120) || `${kind}-${index + 1}`;
        if (kind === 'forum') {
            return { ...(seed ?? {}), ...item, id, comments: normalizeComments(item?.comments, seed?.comments, id) };
        }
        if (kind === 'cp') {
            const upgraded = seed
                ? {
                    ...item,
                    name: seed.name,
                    kind: seed.kind,
                    kindLabel: seed.kindLabel,
                    left: seed.left,
                    right: seed.right,
                    pairing: seed.pairing,
                    members: clone(seed.members),
                    target: seed.target,
                    series: seed.series,
                }
                : item;
            const names = [text(upgraded?.left, 50), text(upgraded?.right, 50)].filter(Boolean);
            const allowedKinds = new Set(['directional', 'group', 'pun', 'allx']);
            const normalizedKind = allowedKinds.has(upgraded?.kind) ? upgraded.kind : 'directional';
            const kindLabels = { directional: '角色CP', group: '关系组', pun: '谐音CP', allx: 'All×' };
            const members = Array.isArray(upgraded?.members)
                ? upgraded.members.map(name => text(name, 50)).filter(Boolean).slice(0, 8)
                : names;
            const { reverse: _legacyReverse, group: _legacyGroup, tags: _legacyTags, ...cleaned } = upgraded;
            return {
                ...cleaned,
                id,
                name: text(upgraded?.name, 60) || names.map(name => name.slice(0, 1)).join('') || '未命名CP',
                kind: normalizedKind,
                kindLabel: text(upgraded?.kindLabel, 30) || kindLabels[normalizedKind],
                pairing: text(upgraded?.pairing, 100) || names.join(' × '),
                members,
                series: text(upgraded?.series, 60) || '未注明作品',
                comments: normalizeComments(item?.comments, seed?.comments, id),
            };
        }
        const upgraded = seed
            ? {
                ...item,
                cpName: seed.cpName,
                pairing: seed.pairing,
                series: seed.series,
                characters: clone(seed.characters),
                tags: clone(seed.tags),
            }
            : item;
        const characters = Array.isArray(upgraded?.characters)
            ? upgraded.characters.map(name => text(name, 50)).filter(Boolean).slice(0, 2)
            : text(upgraded?.pairing, 100).split(/[×xX]/).map(name => text(name, 50)).filter(Boolean).slice(0, 2);
        const series = text(upgraded?.series, 60) || '原创世界';
        const cpName = text(upgraded?.cpName, 60) || characters.map(name => name.slice(0, 1)).join('') || '未命名CP';
        const tags = [...new Set([
            series,
            ...characters,
            cpName,
            ...(Array.isArray(upgraded?.tags) ? upgraded.tags.map(tag => text(tag, 40)).filter(Boolean) : []),
        ])];
        return {
            ...upgraded,
            id,
            series,
            cpName,
            characters,
            pairing: text(upgraded?.pairing, 100) || characters.join(' × '),
            tags,
            commentsList: normalizeComments(item?.commentsList, seed?.commentsList, id),
        };
    });
}

export function normalizePhoneCommunityState(settings = {}) {
    settings.phone ??= {};
    const source = settings.phone.community && typeof settings.phone.community === 'object'
        ? settings.phone.community
        : {};
    const sourceProfile = source.profile && typeof source.profile === 'object' ? source.profile : {};
    const profile = {
        accountId: text(sourceProfile.accountId, 120),
        isMask: Boolean(sourceProfile.isMask),
        nickname: text(sourceProfile.nickname, 80) || text(settings.phone.profile?.nickname, 80) || '我',
        avatar: text(sourceProfile.avatar, 4000),
        bio: text(sourceProfile.bio, 240),
        persona: text(sourceProfile.persona, 12_000),
    };
    const state = {
        profile,
        forumThreads: mergeKnownItems(source.forumThreads, SAMPLE_FORUM_THREADS, 'forum'),
        cpRankings: mergeKnownItems(source.cpRankings, SAMPLE_CP_RANKINGS, 'cp'),
        fanWorks: mergeKnownItems(source.fanWorks, SAMPLE_FAN_WORKS, 'fanwork'),
        commentReplies: Array.isArray(source.commentReplies)
            ? source.commentReplies.map(reply => ({
                id: text(reply?.id, 120),
                targetType: text(reply?.targetType, 30),
                targetId: text(reply?.targetId, 120),
                commentId: text(reply?.commentId, 120),
                accountId: text(reply?.accountId, 120),
                author: text(reply?.author, 80) || profile.nickname,
                content: text(reply?.content, 400),
                createdAt: Math.trunc(Number(reply?.createdAt) || Date.now()),
            })).filter(reply => reply.targetId && reply.commentId && reply.content)
            : [],
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

export function bindClickSafeHorizontalStrip(strip) {
    if (!strip?.addEventListener) return false;
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let dragging = false;
    let suppressClickUntil = 0;
    const reset = (event, suppress = false) => {
        if (pointerId === null || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
        if (suppress && dragging) suppressClickUntil = Date.now() + 320;
        try {
            if (strip.hasPointerCapture?.(pointerId)) strip.releasePointerCapture(pointerId);
        } catch {
            // The browser may already have released capture during cancellation.
        }
        pointerId = null;
        dragging = false;
        strip.classList.remove('is-dragging');
    };
    strip.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.isPrimary === false) return;
        pointerId = event.pointerId;
        startX = event.clientX;
        startY = event.clientY;
        startScrollLeft = strip.scrollLeft;
        dragging = false;
    });
    strip.addEventListener('pointermove', (event) => {
        if (event.pointerId !== pointerId) return;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        if (!dragging) {
            if (Math.abs(deltaX) < 7) return;
            if (Math.abs(deltaY) >= Math.abs(deltaX)) return reset(event, false);
            dragging = true;
            strip.classList.add('is-dragging');
            try { strip.setPointerCapture?.(pointerId); } catch { /* Pointer capture is an enhancement only. */ }
        }
        strip.scrollLeft = startScrollLeft - deltaX;
        event.preventDefault();
    }, { passive: false });
    strip.addEventListener('pointerup', event => reset(event, true));
    strip.addEventListener('pointercancel', event => reset(event, true));
    strip.addEventListener('click', (event) => {
        if (Date.now() >= suppressClickUntil) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
    return true;
}

function renderComments(documentRef, comments = [], options = {}) {
    const section = element(documentRef, 'section', 'memory-augment-community-comments');
    const heading = element(documentRef, 'header');
    const sorted = [...comments].sort((left, right) => Number(right.likes) - Number(left.likes)).slice(0, 5);
    heading.append(element(documentRef, 'strong', '', '热门回复'), element(documentRef, 'small', '', `按热度 · ${sorted.length} 条`));
    section.append(heading);
    for (const comment of sorted) {
        const row = element(documentRef, 'article', 'memory-augment-community-comment');
        const avatar = element(documentRef, 'span', 'memory-augment-community-mini-avatar', text(comment.author, 1) || '匿');
        const copy = element(documentRef, 'div');
        const meta = element(documentRef, 'header');
        meta.append(element(documentRef, 'strong', '', text(comment.author, 50) || '社区用户'));
        meta.append(element(documentRef, 'small', '', `♡ ${Number(comment.likes) || 0}`));
        copy.append(meta, element(documentRef, 'p', '', text(comment.content, 400)));
        const actions = element(documentRef, 'footer');
        actions.append(button(documentRef, '', options.activeCommentId === comment.id ? '收起回复' : '回复', () => options.onToggleReply?.(comment.id)));
        copy.append(actions);
        const replies = (options.replies ?? []).filter(reply => reply.commentId === comment.id);
        if (replies.length > 0) {
            const replyList = element(documentRef, 'div', 'memory-augment-community-player-replies');
            for (const reply of replies) {
                const line = element(documentRef, 'p');
                line.append(element(documentRef, 'strong', '', text(reply.author, 80) || options.playerProfile?.nickname || '我'), documentRef.createTextNode(` ${text(reply.content, 400)}`));
                replyList.append(line);
            }
            copy.append(replyList);
        }
        if (options.activeCommentId === comment.id) {
            const form = element(documentRef, 'form', 'memory-augment-community-reply-form');
            form.autocomplete = 'off';
            const input = element(documentRef, 'textarea');
            input.name = 'community-reply';
            input.maxLength = 300;
            input.placeholder = `回复 ${text(comment.author, 50)}…`;
            const submit = button(documentRef, '', '发送回复');
            submit.type = 'submit';
            form.append(input, submit);
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                if (!options.onSubmitReply?.(comment.id, input.value)) input.focus();
            });
            copy.append(form);
            (globalThis.requestAnimationFrame ?? globalThis.setTimeout)(() => input.focus(), 0);
        }
        row.append(avatar, copy);
        section.append(row);
    }
    return section;
}

export function createPhoneCommunityController(options = {}) {
    const documentRef = options.document ?? globalThis.document;
    const settings = options.settings ?? {};
    const saveSettings = options.saveSettings ?? (() => {});
    const recordActivity = options.recordActivity ?? (() => undefined);
    let state = normalizePhoneCommunityState(settings);
    let root = null;
    let activeTab = 'forum';
    let forumFilter = 'all';
    let fanFilter = 'all';
    let detail = null;
    let replyTarget = null;

    function persist() {
        settings.phone.community = state;
        saveSettings();
    }

    function renderCommentSection(targetType, item, comments) {
        const targetId = item.id;
        const replies = state.commentReplies.filter(reply => reply.targetType === targetType && reply.targetId === targetId);
        const activeCommentId = replyTarget?.targetType === targetType && replyTarget?.targetId === targetId
            ? replyTarget.commentId
            : '';
        return renderComments(documentRef, comments, {
            replies,
            playerProfile: state.profile,
            activeCommentId,
            onToggleReply(commentId) {
                replyTarget = activeCommentId === commentId ? null : { targetType, targetId, commentId };
                render();
            },
            onSubmitReply(commentId, value) {
                const content = text(value, 300);
                if (!content) return false;
                state.commentReplies.push({
                    id: `community-reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
                    targetType,
                    targetId,
                    commentId,
                    accountId: state.profile.accountId,
                    author: state.profile.nickname,
                    content,
                    createdAt: Date.now(),
                });
                const roleAccounts = settings.phone?.weibo?.roleAccounts ?? [];
                const searchable = [item.title, item.body, item.weekly, item.pairing, item.preview]
                    .map(value => text(value, 1200)).join('\n');
                const structuredNames = [
                    ...(Array.isArray(item.characters) ? item.characters : []),
                    ...(Array.isArray(item.members) ? item.members : []),
                ].map(value => text(value, 80)).filter(Boolean);
                const matchedNames = roleAccounts.filter(account => {
                    const names = [account.nickname, account.identity?.label]
                        .map(value => text(value, 80)).filter(Boolean);
                    return names.some(name => searchable.includes(name));
                }).map(account => account.nickname);
                const participants = [...new Set([...structuredNames, ...matchedNames])];
                if (participants.length > 0) {
                    void recordActivity({
                        app: 'community',
                        tier: 'ambient_role',
                        accountId: state.profile.accountId,
                        isMask: state.profile.isMask,
                        summary: `在社区帖子“${text(item.title ?? item.name, 160)}”的评论区回复：“${content}”`,
                        participants,
                        sourceKey: `community-reply:${state.commentReplies.at(-1).id}`,
                    });
                }
                replyTarget = null;
                persist();
                render();
                return true;
            },
        });
    }

    function renderTabs(container) {
        const nav = element(documentRef, 'nav', 'memory-augment-community-tabs');
        for (const tab of PHONE_COMMUNITY_TABS) {
            const item = button(documentRef, tab.id === activeTab ? 'is-active' : '', '', () => {
                activeTab = tab.id;
                detail = null;
                replyTarget = null;
                render();
            });
            const icon = element(documentRef, 'i', `fa-solid ${tab.icon}`);
            icon.setAttribute('aria-hidden', 'true');
            item.append(icon, element(documentRef, 'span', '', tab.label));
            nav.append(item);
        }
        bindClickSafeHorizontalStrip(nav);
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
        bindClickSafeHorizontalStrip(strip);
        container.append(strip);
    }

    function renderForum(container) {
        const hero = element(documentRef, 'section', 'memory-augment-community-hero is-forum');
        hero.append(
            element(documentRef, 'small', '', 'COMMUNITY NOW'),
            element(documentRef, 'strong', '', '此刻大家都在聊'),
        );
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
        hero.append(
            element(documentRef, 'small', '', 'WEEKLY CP CHART'),
            element(documentRef, 'strong', '', '本周心动榜'),
        );
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
            copy.append(title, element(documentRef, 'small', '', `${text(item.kindLabel, 30)} · 《${text(item.series, 60)}》 · ${text(item.pairing, 100)}`), element(documentRef, 'p', '', text(item.weekly, 220)));
            const heat = element(documentRef, 'span', 'memory-augment-community-cp-heat');
            heat.append(element(documentRef, 'strong', '', text(item.heat, 30)), element(documentRef, 'small', '', '热度'));
            row.append(rank, copy, heat);
            list.append(row);
        }
        container.append(list);
    }

    function renderFanworks(container) {
        const hero = element(documentRef, 'section', 'memory-augment-community-hero is-fanworks');
        hero.append(
            element(documentRef, 'small', '', 'FANWORKS'),
            element(documentRef, 'strong', '', '造梦放映厅'),
        );
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
            copy.append(element(documentRef, 'small', 'memory-augment-community-fan-cp', `【${text(work.cpName, 50)}】${text(work.pairing, 80)} · ${text(work.time, 30)}`), element(documentRef, 'strong', '', text(work.title, 140)), element(documentRef, 'p', '', text(work.summary, 220)));
            const footer = element(documentRef, 'footer');
            footer.append(element(documentRef, 'span', '', `@${text(work.creator, 50)}`), element(documentRef, 'small', '', `♡ ${Number(work.likes) || 0}　💬 ${Number(work.comments) || 0}`));
            const tags = element(documentRef, 'div', 'memory-augment-community-fan-tags');
            for (const tag of work.tags ?? []) tags.append(element(documentRef, 'span', '', `#${text(tag, 40)}`));
            copy.append(footer, tags);
            card.append(cover, copy);
            grid.append(card);
        }
        container.append(grid);
    }

    function renderDetail(container) {
        const shell = element(documentRef, 'section', 'memory-augment-community-detail');
        const back = button(documentRef, 'memory-augment-community-detail-back', '', () => {
            detail = null;
            replyTarget = null;
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
            shell.append(byline, element(documentRef, 'p', 'memory-augment-community-detail-body', text(item.body, 1200)), renderCommentSection('forum', item, item.comments));
        } else if (detail.type === 'cp') {
            const item = state.cpRankings.find(cp => cp.id === detail.id);
            if (!item) return;
            shell.append(element(documentRef, 'span', 'memory-augment-community-detail-tag', `本周第 ${item.rank} 名 · ${text(item.kindLabel, 30)}`), element(documentRef, 'h2', '', text(item.name, 80)), element(documentRef, 'div', 'memory-augment-community-detail-byline', `《${text(item.series, 60)}》 · ${text(item.pairing, 100)} · ${text(item.heat, 30)} 热度`));
            const spotlight = element(documentRef, 'div', 'memory-augment-community-cp-spotlight');
            spotlight.append(element(documentRef, 'small', '', '本周嗑点'), element(documentRef, 'p', '', text(item.weekly, 500)));
            shell.append(spotlight, renderCommentSection('cp', item, item.comments));
        } else {
            const item = state.fanWorks.find(work => work.id === detail.id);
            if (!item) return;
            shell.append(element(documentRef, 'span', 'memory-augment-community-detail-tag', `${text(item.typeLabel, 30)} · ${text(item.cpName, 50)}`), element(documentRef, 'h2', '', text(item.title, 180)), element(documentRef, 'div', 'memory-augment-community-detail-byline', `@${text(item.creator, 60)} · ${text(item.pairing, 80)} · ${text(item.time, 30)}`));
            const preview = element(documentRef, 'div', `memory-augment-community-work-preview is-${text(item.type, 20)}`);
            preview.append(element(documentRef, 'p', '', text(item.preview, 1000)));
            if (item.type === 'article') preview.append(element(documentRef, 'strong', '', '……阅读全文'));
            const tags = element(documentRef, 'div', 'memory-augment-community-fan-tags is-detail');
            for (const tag of item.tags ?? []) tags.append(element(documentRef, 'span', '', `#${text(tag, 40)}`));
            shell.append(preview, tags, renderCommentSection('fanwork', item, item.commentsList));
        }
        container.append(shell);
    }

    function render() {
        if (!root) return;
        const previousView = root.querySelector('.memory-augment-community-view');
        const restoreDetailPosition = Boolean(detail && previousView?.querySelector('.memory-augment-community-detail'));
        const previousScrollTop = restoreDetailPosition ? previousView.scrollTop : 0;
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
        if (restoreDetailPosition) (globalThis.requestAnimationFrame ?? globalThis.setTimeout)(() => { page.scrollTop = previousScrollTop; }, 0);
    }

    globalThis.addEventListener?.('memory-augment-phone-world-updated', event => {
        if (!event?.detail?.modules?.includes?.('community')) return;
        state = normalizePhoneCommunityState(settings);
        if (detail) {
            const collection = detail.type === 'forum' ? state.forumThreads
                : detail.type === 'cp' ? state.cpRankings : state.fanWorks;
            if (!collection.some(item => item.id === detail.id)) detail = null;
        }
        if (root) render();
    });

    return {
        async open(container) {
            root = container;
            state = normalizePhoneCommunityState(settings);
            render();
        },
        back() {
            if (!detail) return false;
            detail = null;
            replyTarget = null;
            render();
            return true;
        },
        getState: () => state,
    };
}
