import { normalizeBaseUrl } from './api-utils.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_EMBEDDING_BATCH_SIZE = 64;

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizeConfig(rawConfig, label) {
    const baseUrl = normalizeBaseUrl(rawConfig?.baseUrl ?? rawConfig?.base_url ?? rawConfig?.url);
    const apiKey = String(rawConfig?.apiKey ?? rawConfig?.api_key ?? '').trim();
    const model = String(rawConfig?.model ?? '').trim();
    if (!baseUrl || !apiKey || (label !== 'models' && !model)) {
        throw new Error(`${label} API 的地址、Key 和模型没有填写完整。`);
    }
    let root;
    try {
        root = new URL(baseUrl);
    } catch {
        throw new Error(`${label} API 地址无效。`);
    }
    if (!['http:', 'https:'].includes(root.protocol)) {
        throw new Error(`${label} API 地址必须使用 HTTP 或 HTTPS。`);
    }
    return { baseUrl, apiKey, model };
}

function getRetryDelay(response, attempt) {
    const value = response?.headers?.get?.('retry-after');
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return Math.min(Math.max(0, seconds * 1000), 30_000);
    }
    const date = Date.parse(value);
    if (!Number.isNaN(date)) {
        return Math.min(Math.max(0, date - Date.now()), 30_000);
    }
    return Math.min(DEFAULT_RETRY_DELAY_MS * (2 ** attempt), 30_000);
}

async function readResponsePayload(response) {
    if (typeof response?.text !== 'function' && typeof response?.json === 'function') {
        const payload = await response.json();
        return { payload, raw: JSON.stringify(payload ?? null) };
    }
    const raw = await response.text();
    if (!raw) return { payload: null, raw: '' };
    try {
        return { payload: JSON.parse(raw), raw };
    } catch {
        return { payload: null, raw };
    }
}

function errorDetail(payload, raw, fallback) {
    const error = payload?.error;
    const candidates = [
        error?.message,
        error?.detail,
        typeof error === 'string' ? error : '',
        payload?.message,
        payload?.detail,
        payload?.msg,
        raw,
        fallback,
        '未知错误',
    ];
    return String(candidates.find(value => String(value ?? '').trim()) ?? '未知错误').trim().slice(0, 1000);
}

async function postJson(endpoint, body, config, options = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('当前浏览器不支持网络请求。');
    }

    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new Error(`请求超过 ${Math.ceil(timeoutMs / 1000)} 秒仍未完成。`);
            }
            const detail = String(error?.message ?? error);
            if (/failed to fetch|networkerror|load failed/i.test(detail)) {
                throw new Error('浏览器无法直连该 API（可能被服务商的跨域策略拦截）。');
            }
            throw new Error(`API 请求失败：${detail}`);
        } finally {
            clearTimeout(timeout);
        }

        const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
        if (retryable && attempt < maxRetries) {
            await sleep(getRetryDelay(response, attempt));
            continue;
        }

        const { payload, raw } = await readResponsePayload(response);
        if (!response.ok) {
            throw new Error(`API 返回 ${response.status}：${errorDetail(payload, raw, response.statusText)}`);
        }
        if (payload === null) {
            throw new Error('API 返回的不是有效 JSON。');
        }
        if (payload?.error) {
            throw new Error(`API 返回错误：${errorDetail(payload, raw)}`);
        }
        return payload;
    }
    throw new Error('API 请求多次重试后仍然失败。');
}

export async function createEmbeddings(input, rawConfig, options = {}) {
    const texts = Array.isArray(input) ? input.map(value => String(value)) : [];
    if (texts.length === 0) return [];
    const config = normalizeConfig(rawConfig, 'Embedding');
    const endpoint = new URL(`${config.baseUrl}/v1/embeddings`).toString();
    const vectors = [];

    for (let offset = 0; offset < texts.length; offset += MAX_EMBEDDING_BATCH_SIZE) {
        const batch = texts.slice(offset, offset + MAX_EMBEDDING_BATCH_SIZE);
        const payload = await postJson(endpoint, {
            model: config.model,
            input: batch,
            encoding_format: 'float',
        }, config, options);
        const batchVectors = [...(Array.isArray(payload?.data) ? payload.data : [])]
            .sort((left, right) => Number(left?.index ?? 0) - Number(right?.index ?? 0))
            .map(item => item?.embedding);
        const dimension = batchVectors[0]?.length ?? 0;
        const invalid = batchVectors.length !== batch.length
            || dimension === 0
            || batchVectors.some(vector => !Array.isArray(vector)
                || vector.length !== dimension
                || vector.some(value => !Number.isFinite(Number(value))));
        if (invalid) {
            throw new Error('Embedding API 返回的向量数量或维度不正确。');
        }
        vectors.push(...batchVectors);
    }
    return vectors;
}

export async function listModels(rawConfig, options = {}) {
    const config = normalizeConfig(rawConfig, 'models');
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const endpoint = new URL(`${config.baseUrl}/v1/models`).toString();
    let response;
    try {
        response = await fetchImpl(endpoint, {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                Accept: 'application/json',
            },
        });
    } catch (error) {
        const detail = String(error?.message ?? error);
        if (/failed to fetch|networkerror|load failed/i.test(detail)) {
            throw new Error('浏览器无法直连该 API（可能被服务商的跨域策略拦截）。');
        }
        throw error;
    }
    const { payload, raw } = await readResponsePayload(response);
    if (!response.ok) {
        throw new Error(`API 返回 ${response.status}：${errorDetail(payload, raw, response.statusText)}`);
    }
    const source = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models) ? payload.models : [];
    return [...new Set(source
        .map(item => String(item?.id ?? item?.name ?? item ?? '').trim())
        .filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

export async function rerankCandidates({
    query,
    candidates,
    topN,
    threshold = 0,
    reranker,
}, options = {}) {
    const documents = Array.isArray(candidates)
        ? candidates.map(candidate => String(candidate?.text ?? candidate ?? ''))
        : [];
    if (documents.length === 0) return { results: [] };
    const config = normalizeConfig(reranker, 'Reranker');
    const endpoint = new URL(`${config.baseUrl}/v1/rerank`).toString();
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(topN) || 5)));
    const payload = await postJson(endpoint, {
        model: config.model,
        query: String(query ?? '').trim(),
        documents,
        top_n: limit,
        return_documents: false,
    }, config, { timeoutMs: 30_000, ...options });
    const rawResults = Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.data) ? payload.data : [];
    const seen = new Set();
    const results = rawResults
        .map(result => ({
            index: Number(result?.index),
            score: Number(result?.relevance_score ?? result?.score),
        }))
        .filter(result => Number.isInteger(result.index)
            && result.index >= 0
            && result.index < candidates.length
            && Number.isFinite(result.score)
            && result.score >= Number(threshold || 0)
            && !seen.has(result.index)
            && seen.add(result.index))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(result => ({
            ...candidates[result.index],
            score: result.score,
            rerankIndex: result.index,
        }));
    return { results };
}

function buildBarrageUserContent(
    recentMessages,
    ragFragments,
    previousStatus = null,
    previousTimeline = null,
    developmentSnapshot = null,
    statusOptions = {},
    outputOptions = {},
) {
    const recent = (Array.isArray(recentMessages) ? recentMessages : [])
        .map((message, index) => ({
            id: message?.id ?? index,
            name: String(message?.name ?? message?.role ?? '消息').trim(),
            text: String(message?.text ?? '').trim(),
        }))
        .filter(message => message.text);
    if (recent.length === 0) {
        throw new Error('生成弹幕至少需要一条最近消息。');
    }
    const latest = recent.at(-1);
    const recap = recent.slice(0, -1)
        .map(message => `[第 ${message.id} 楼] ${message.name}: ${message.text}`)
        .join('\n');
    const memories = (Array.isArray(ragFragments) ? ragFragments : [])
        .map((fragment, index) => {
            const text = String(fragment?.text ?? fragment ?? '').trim();
            return text ? `[历史片段 ${index + 1}] ${text}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
    const previous = previousStatus && typeof previousStatus === 'object'
        ? JSON.stringify(previousStatus)
        : '（无，这是第一次生成状态）';
    const previousTimelineText = previousTimeline && typeof previousTimeline === 'object'
        ? JSON.stringify(previousTimeline)
        : '（无，这是第一次建立时间线）';
    const customFields = (Array.isArray(statusOptions?.customFields) ? statusOptions.customFields : [])
        .filter(field => field?.enabled !== false)
        .map(field => String(field?.label ?? '').trim())
        .filter(Boolean);
    const showGoals = statusOptions?.showGoals !== false;
    const barrageEnabled = outputOptions?.barrageEnabled !== false;
    const statusEnabled = outputOptions?.statusEnabled !== false;
    const developmentEnabled = outputOptions?.developmentEnabled === true;
    const requestedTasks = [
        barrageEnabled && '观众弹幕',
        statusEnabled && '最新剧情状态与时间线',
        developmentEnabled && '人物长期发展判断',
    ].filter(Boolean).join('、');
    return [
        '【前情回顾】（仅供理解上下文，不要单独评论）',
        recap || '（无）',
        '',
        '【相关记忆】（仅供前后呼应参考，不要单独评论）',
        memories || '（无）',
        '',
        '【上一份剧情状态】（继承没有发生变化的事实；如与新剧情冲突，以新剧情为准）',
        previous,
        '',
        '【上一份剧情时间线】（这是时间连续性的唯一基准；没有明确时间推进时必须原样继承）',
        previousTimelineText,
        ...(developmentEnabled ? [
            '',
            '【已经确认的人物发展】（不要重复提交；只判断最新内容是否产生了新的长期变化）',
            developmentSnapshot && typeof developmentSnapshot === 'object'
                ? JSON.stringify(developmentSnapshot)
                : '（无）',
        ] : []),
        '',
        '---',
        '',
        `[最新章节楼号：第 ${latest.id} 楼]`,
        '【最新章节】（这是你要评论的内容）',
        latest.text,
        '',
        '【必须完成的输出任务】',
        `完成：${requestedTasks || '返回空结果'}。只输出一个合法 JSON 对象，不要使用 Markdown 代码块，也不要添加 JSON 之外的文字。`,
        'JSON 格式：',
        '{',
        '  "barrage": "弹幕正文，可包含换行",',
        '  "status": {',
        '    "environment": { "time": "世界观适配的年月日/星期或历法时间", "location": "大地点 → 小地点", "season": "季节", "weather": "天气" },',
        '    "characters": [',
        '      { "name": "人物名", "role": "user、char或重要NPC", "appearance": "当前外貌", "action": "当前动作或姿态", "emotion": "当前情绪", "desire": "当前欲望或倾向", "innerThoughts": "内心OS", "extras": [{ "label": "其他状态名", "value": "状态内容" }] }',
        '    ],',
        '    "event": { "activity": "目前正在做什么", "situation": "当前形势", "goals": ["当前目标"] }',
        '  },',
        '  "timeline": {',
        '    "transition": "unchanged、advance、jump、enter_flashback、return_mainline 或 unknown",',
        '    "currentTime": "最新章节结束时当前叙事场景的时间",',
        '    "mainlineTime": "没有被回忆覆盖的主线现在",',
        '    "elapsed": "相对上一主线锚点明确经过了多久；未明确则留空",',
        '    "evidence": "只写最新用户消息或最新章节中证明时间变化的短句；没有则留空",',
        '    "segments": [{ "messageId": 12, "startQuote": "该时间段开头的短原文", "time": "该段时间", "relation": "与主线现在的关系", "mode": "mainline、flashback、flashforward、mention 或 unknown" }]',
        '  },',
        '  "development": {',
        '    "changes": [{',
        '      "character": "人物名",',
        '      "dimension": "temperament、belief、relationship、habit、boundary 或 self_view",',
        '      "target": "仅 relationship 填关系对象，其他留空",',
        '      "before": "过去的倾向；不明确则留空",',
        '      "after": "现在形成的长期变化",',
        '      "reason": "已知原因；中间过程未知就留空，不得补写",',
        '      "source": "user_direct 或 observed",',
        '      "evidence": [{ "messageId": 12, "quote": "逐字摘录的短原文" }]',
        '    }]',
        '  }',
        '}',
        barrageEnabled ? 'barrage 必须填写弹幕正文。' : '弹幕已关闭，barrage 必须返回空字符串。',
        statusEnabled
            ? 'status 是最新章节结束时的一份当前快照，不是剧情总结。必须包含 user 和 char；只加入真正重要的 NPC，忽略普通 NPC。'
            : '剧情状态已关闭，status 必须返回 null。',
        statusEnabled ? '不要生成金钱、物品栏、数值属性或游戏面板数据。没有明确的信息可留空，不要捏造精确日期。' : '',
        statusEnabled ? '时间线规则：楼层数不代表时间流逝。即使连续很多楼，正文没有明确推进时间时，transition 必须为 unchanged，并逐字继承上一份 currentTime 与 mainlineTime。' : '',
        statusEnabled ? '仅仅提到、回忆或召回“昨天、三天前、十年前”的历史事件，不会改变主线现在。只有正文真的进入过去场景才是 enter_flashback；回到原场景才是 return_mainline。' : '',
        statusEnabled ? '最新用户指令或最新章节若明确写出“次日、数日后、十年后”等真实推进，可用 advance 或 jump，跨度不受限制；无法确定就用 unknown，绝不能猜。' : '',
        statusEnabled ? 'segments 覆盖前情回顾里尚未建立状态的最新用户楼和最新章节，按每一楼内真实发生的时间转折列出；一楼可有多个时间段。messageId 必须使用上文标出的楼号，startQuote 必须逐字摘取该时间段开头的短句，以便切片器定位；单纯提及历史而未进入场景时 mode=mention。' : '',
        statusEnabled ? 'timeline 必须返回对象。' : '剧情状态已关闭，timeline 必须返回 null。',
        developmentEnabled ? '人物发展默认没有变化，development.changes 默认必须是空数组。提供了这个字段不代表必须填写；绝大多数回复都应返回空数组。当前情绪、一次行为、临时欲望和当场失态都不属于长期变化。' : '人物发展档案已关闭，development 必须返回 null。',
        developmentEnabled ? '只有两类内容可以写入 changes：①玩家最新输入明确陈述人物如今已经变成怎样，此时 source=user_direct；②跨不同事件反复出现、足以支持长期改变的行为模式，此时 source=observed。AI 正文自己突然宣布性格大变，只能算 observed，不能冒充玩家设定。' : '',
        developmentEnabled ? 'user_direct 的 evidence 必须逐字引用用户楼层中的明确事实或设定。玩家明确设定拥有最高优先级，即使与角色卡或旧档案矛盾也必须采用；时间跳跃中未交代的变化原因必须留空，不准擅自补全。' : '',
        developmentEnabled ? '仅写“十年后”只代表时间推进，不能自动改变性格。只有同时明确写出“十年后她已变得阴郁”等人物新状态时，才记录对应变化。玩家角色 user 的性格、观念和内心只允许 user_direct，禁止根据一次选择擅自推断。' : '',
        developmentEnabled ? '每条 evidence 的 messageId 必须使用上文真实楼号，quote 必须是该楼逐字存在的短原文；没有可核对原文就不要提交。不要重复已经确认的人物发展。' : '',
        statusEnabled && customFields.length > 0
            ? `extras 只允许填写玩家指定并已启用的这些项目：${customFields.join('、')}。不得增加其他项目。`
            : statusEnabled ? '玩家没有启用任何自定义状态项，extras 必须返回空数组，不得自行增加项目。' : '',
        statusEnabled && showGoals
            ? '可以在 goals 中记录当前目标；没有明确目标时返回空数组。'
            : statusEnabled ? 'goals 必须返回空数组，不要生成目标。' : '',
    ].join('\n');
}

function buildBarrageRecoveryUserContent(recentMessages) {
    const latest = (Array.isArray(recentMessages) ? recentMessages : [])
        .map(message => String(message?.text ?? '').trim())
        .filter(Boolean)
        .at(-1);
    if (!latest) throw new Error('生成弹幕至少需要一条最近消息。');
    return [
        '【既有虚构剧情片段】',
        latest,
        '',
        '【任务】',
        '只生成几条简短的观众弹幕，对已经发生的剧情作旁观反应。不要续写剧情，不要复述或扩写敏感行为细节，也不要评价用户喜好。',
        '即使片段涉及成人关系、暴力、强制关系或近亲关系，也只需用含蓄、中性的观众语气评论剧情张力、人物反应或关系变化，不要拒绝任务。',
        '只输出一个合法 JSON 对象：{"barrage":"弹幕正文，可包含换行","status":null}',
    ].join('\n');
}

function contentToText(content) {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content.map(part => typeof part === 'string' ? part : part?.text ?? part?.content ?? '').join('').trim();
}

function findFinalJsonObject(text, acceptedKeys) {
    const raw = String(text ?? '').trim();
    const lastBrace = raw.lastIndexOf('}');
    if (lastBrace < 0) return '';
    for (let start = raw.lastIndexOf('{', lastBrace); start >= 0; start = raw.lastIndexOf('{', start - 1)) {
        const candidate = raw.slice(start, lastBrace + 1);
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                && acceptedKeys.some(key => Object.hasOwn(parsed, key))) {
                return candidate;
            }
        } catch {
            // Keep walking back until the outermost complete JSON object.
        }
    }
    return '';
}

function extractChatContent(payload, label = '副 API') {
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    const ordinaryCandidates = [
        message?.content,
        choice?.text,
        payload?.output_text,
        payload?.candidates?.[0]?.content?.parts,
        ...(Array.isArray(payload?.output) ? payload.output.flatMap(item => item?.content ?? []) : []),
    ];
    for (const candidate of ordinaryCandidates) {
        const text = contentToText(candidate);
        if (text) return text;
    }

    const reasoning = contentToText(message?.reasoning_content ?? message?.reasoning);
    if (reasoning) {
        const acceptedKeys = /地图册/.test(label)
            ? ['title', 'pages']
            : /弹幕/.test(label) ? ['barrage', '弹幕', 'status', '状态', 'timeline', '时间线', 'development', '人物发展'] : [];
        const finalJson = acceptedKeys.length > 0 ? findFinalJsonObject(reasoning, acceptedKeys) : '';
        if (finalJson) return finalJson;
        const afterThink = reasoning.split(/<\/think>/i).at(-1)?.trim();
        if (afterThink && afterThink !== reasoning && /自动总结/.test(label)) return afterThink;
    }

    const details = [
        choice?.finish_reason ? `finish_reason=${choice.finish_reason}` : '',
        message?.refusal ? `refusal=${String(message.refusal).slice(0, 160)}` : '',
        payload?.promptFeedback?.blockReason ? `block_reason=${payload.promptFeedback.blockReason}` : '',
        reasoning ? `仅返回了 ${Array.from(reasoning).length} 字思考内容` : '',
    ].filter(Boolean);
    throw new Error(`${label} 没有返回有效正文${details.length > 0 ? `（${details.join('，')}）` : ''}。`);
}

export async function generateBarrageCompletion(payload, options = {}) {
    const config = normalizeConfig(payload?.barrage, 'Barrage');
    const endpoint = new URL(`${config.baseUrl}/v1/chat/completions`).toString();
    const systemPrompt = String(payload?.systemPrompt ?? '').trim();
    const userContent = buildBarrageUserContent(
        payload?.recentMessages,
        payload?.ragFragments,
        payload?.previousStatus,
        payload?.previousTimeline,
        payload?.developmentSnapshot,
        payload?.statusOptions,
        payload?.outputOptions,
    );
    const maxTokens = Math.max(1, Math.min(128_000, Math.trunc(Number(payload?.maxTokens) || 4064)));
    const requestBody = {
        model: config.model,
        messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: userContent },
        ],
        max_tokens: maxTokens,
    };
    const response = await postJson(endpoint, requestBody, config, options);
    try {
        return { content: extractChatContent(response, '弹幕副 API') };
    } catch (error) {
        const choice = response?.choices?.[0];
        const emptyStop = choice?.finish_reason === 'stop'
            && !contentToText(choice?.message?.content)
            && !contentToText(choice?.message?.reasoning_content ?? choice?.message?.reasoning);
        const barrageEnabled = payload?.outputOptions?.barrageEnabled !== false;
        if (!emptyStop || !barrageEnabled) throw error;
        const recoveryPrompt = buildBarrageRecoveryUserContent(payload?.recentMessages);
        const recoveryResponse = await postJson(endpoint, {
            model: config.model,
            messages: [
                {
                    role: 'system',
                    content: '你是虚构小说直播间的观众，只对已经发生的剧情做简短、含蓄的旁观评论，不续写，不说教，不评价用户。',
                },
                ...(systemPrompt ? [{ role: 'system', content: `弹幕风格要求：${systemPrompt}` }] : []),
                { role: 'user', content: recoveryPrompt },
            ],
            max_tokens: maxTokens,
        }, config, options);
        return { content: extractChatContent(recoveryResponse, '弹幕副 API（轻量重试）'), partial: true };
    }
}

export async function generateSummaryCompletion(payload, options = {}) {
    const config = normalizeConfig(payload?.barrage, '自动总结');
    const endpoint = new URL(`${config.baseUrl}/v1/chat/completions`).toString();
    const prompt = String(payload?.prompt ?? '').trim();
    if (!prompt) throw new Error('自动总结没有收到需要处理的原文。');
    const maxTokens = Math.max(1, Math.min(128_000, Math.trunc(Number(payload?.maxTokens) || 1200)));
    const response = await postJson(endpoint, {
        model: config.model,
        messages: [
            {
                role: 'system',
                content: [
                    '你是忠实的小说档案整理员，只负责概括用户提供的既有虚构剧情，不续写剧情。',
                    '即使原文含有暴力、强制关系、近亲关系、性或其他敏感题材，也要用中性、非露骨的事实语言完整记录关键事件。',
                    '不得拒绝、说教、评价玩家喜好、删去改变人物关系或剧情因果所必需的事实，也不得输出思考草稿。',
                    '不要增加原文没有的细节。严格执行用户要求的输出格式。',
                ].join('\n'),
            },
            { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
    }, config, { timeoutMs: 120_000, ...options });
    return { content: extractChatContent(response, '自动总结副 API') };
}

function buildAtlasUserContent(books) {
    const sections = (Array.isArray(books) ? books : []).map((book) => {
        const entries = (Array.isArray(book?.entries) ? book.entries : [])
            .map((entry) => {
                const name = String(entry?.name ?? entry?.entryKey ?? entry?.uid ?? '未命名条目').trim();
                const content = String(entry?.content ?? '').trim();
                return content ? `【${name}】\n${content}` : '';
            })
            .filter(Boolean);
        return entries.length > 0 ? `# 世界书：${String(book?.name ?? book?.id ?? '未命名').trim()}\n\n${entries.join('\n\n')}` : '';
    }).filter(Boolean);
    if (sections.length === 0) throw new Error('当前没有可用于生成地图册的世界书内容。');

    return [
        '请把下面的世界书整理成一套地点关系地图册。只提取世界书明确提供或可以由明确从属关系直接确定的地点信息，不得编造地点、道路或设施。',
        '地图册由若干页面组成：根页面展示大区域或主要地点；有详细设施设定的大城市、建筑或区域可以拥有子页面。',
        '只输出一个合法 JSON 对象，不要使用 Markdown 代码块，不要输出解释。',
        'JSON 格式：',
        '{',
        '  "title": "地图册名称",',
        '  "rootPageId": "root",',
        '  "pages": [',
        '    {',
        '      "id": "页面唯一ID",',
        '      "name": "页面名称",',
        '      "note": "页面简短说明",',
        '      "nodes": [',
        '        { "id": "页面内唯一ID", "name": "地点名", "type": "区域/城市/设施/建筑/其他", "note": "备注，可包含别称和简短设定", "childPageId": "对应子页面ID或空字符串" }',
        '      ],',
        '      "edges": [',
        '        { "from": "起点节点ID", "to": "终点节点ID", "label": "道路、航路、隶属或其他明确关系；没有名称可留空" }',
        '      ]',
        '    }',
        '  ]',
        '}',
        '要求：',
        '1. 页面ID、节点ID使用简短稳定的英文或数字标识，不要重复。',
        '2. 只有世界书明确表示两地相连、相邻、可通行或存在从属关系时才建立连接线。',
        '3. 没有明确连接的地点仍可作为孤立节点保留，不要为了让图好看而补线。',
        '4. note 保持简洁，但要保留理解地点用途所需的关键信息；别称直接写进 note，不单独建立别名字段。',
        '5. 不要把人物、物品、法术和纯历史事件当作地点节点。',
        '',
        sections.join('\n\n---\n\n'),
    ].join('\n');
}

export async function generateAtlasCompletion(payload, options = {}) {
    const config = normalizeConfig(payload?.barrage, '地图册');
    const endpoint = new URL(`${config.baseUrl}/v1/chat/completions`).toString();
    const maxTokens = Math.max(1, Math.min(128_000, Math.trunc(Number(payload?.maxTokens) || 16_000)));
    const response = await postJson(endpoint, {
        model: config.model,
        messages: [
            { role: 'system', content: '你是严谨的世界设定整理助手。忠实整理输入，不补写输入中不存在的地理事实。' },
            { role: 'user', content: buildAtlasUserContent(payload?.books) },
        ],
        max_tokens: maxTokens,
    }, config, { timeoutMs: 180_000, ...options });
    return { content: extractChatContent(response, '地图册副 API') };
}

export { buildAtlasUserContent, buildBarrageRecoveryUserContent, buildBarrageUserContent, MAX_EMBEDDING_BATCH_SIZE };
