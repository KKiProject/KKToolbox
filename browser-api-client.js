import { normalizeBaseUrl } from './api-utils.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_EMBEDDING_BATCH_SIZE = 64;
const STATE_PSYCHOLOGY_GUIDE = `<State_Psychology_Guide>

When generating emotional states, desires, inner thoughts, or future intentions, infer them from the specific character and relationship rather than from surface behavior, genre convention, or dramatic stereotypes.

### 1. Derive the Inner State Causally

For each important character, determine:

* What did they actually perceive?
* How do their history, beliefs, relationship, and current emotional state shape their interpretation?
* What does the event mean to them personally?
* What emotion or need is the impulse actually coming from?
* What do they consciously want?
* What do they want but suppress, resist, misunderstand, or refuse to admit?
* What changed emotionally in the latest interaction?

Use psychological concepts such as core beliefs, schemas, attachment tendencies, defenses, and emotional regulation only when they help explain the current state. Do not mechanically label the character.

### 2. Meaning Comes From Motive and Relationship

Do not infer psychological or relational meaning from the outward form of behavior alone.

The same action may come from affection, trust, familiarity, playfulness, desire, reassurance, fear, pressure, obligation, avoidance, indifference, or other motives.

Kinship titles, honorifics, age differences, status differences, physical initiative, accepting another person's request, or allowing another person to take the lead do not by themselves define the relationship.

Determine meaning from:

* freedom of choice
* actual motive
* established relationship
* immediate context
* how the characters understand each other

Do not replace an already established relational meaning with a more dramatic interpretation without new evidence.

### 3. Distinguish Intensity From Emotional Nature

Strong affection or desire is not automatically darker, harsher, or more aggressive.

Teasing, wanting a loved one's private reaction, wanting greater closeness, possessive affection, playful aggression, sexual desire, or the urge to overwhelm or cling to someone may arise from affection, intimacy, fascination, vulnerability, emotional overflow, or playful cruelty.

First identify the emotional source. Then interpret the impulse.

Human impulses are filtered through affection, empathy, relationship history, values, self-restraint, and recognition of the other person as an independent person.

Instinct is one input, not the final psychological meaning.

### 4. Keep Traits Contextual

Power, authority, control, confidence, dependence, vulnerability, and possessiveness are context-dependent.

A character may be controlling at work but gentle in intimacy, decisive in public but hesitant with someone they love, or possessive while still deeply respecting the other person's agency.

Do not extend one personality trait across every relationship or domain.

When conflicting traits coexist, preserve the conflict instead of collapsing the character into one dominant trait.

### 5. Preserve Emotional Momentum

The current state must grow from the previous emotional beat.

If a character has softened, felt trusted, become moved, lost anger, hesitated, become embarrassed, reassured, uncertain, or emotionally disarmed, carry that change forward.

Do not reset them to a default personality trait or a more dramatic emotional state without a new trigger.

Future intentions should arise from the character's current state, not from what would create the most dramatic next scene.

### 6. State Extraction Rule

Record what the text supports.

Separate:

* current emotion
* current desire
* conscious thought
* partially recognized or suppressed thought
* likely near-future intention

Do not turn speculation into established fact.
When the character's inner meaning is ambiguous, preserve the ambiguity rather than inventing a stronger interpretation.

</State_Psychology_Guide>`;

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

function streamContentText(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(part => typeof part === 'string' ? part : part?.text ?? part?.content ?? '').join('');
}

async function postStreamingChatCompletion(endpoint, body, config, options = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('当前浏览器不支持网络请求。');
    const maxRetries = options.maxRetries ?? 1;
    const timeoutMs = options.timeoutMs ?? 300_000;
    const idleTimeoutMs = options.idleTimeoutMs ?? 180_000;
    const externalSignal = options.signal;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        let abortReason = 'total';
        const timeout = setTimeout(() => {
            abortReason = 'total';
            controller.abort();
        }, timeoutMs);
        let idleTimeout;
        const resetIdleTimeout = () => {
            clearTimeout(idleTimeout);
            idleTimeout = setTimeout(() => {
                abortReason = 'idle';
                controller.abort();
            }, idleTimeoutMs);
        };
        const abortFromOutside = () => {
            abortReason = 'external';
            controller.abort();
        };
        if (externalSignal?.aborted) abortFromOutside();
        else externalSignal?.addEventListener?.('abort', abortFromOutside, { once: true });
        resetIdleTimeout();
        try {
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream, application/json',
                },
                body: JSON.stringify({ ...body, stream: true }),
                signal: controller.signal,
            });
            resetIdleTimeout();
            const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
            if (retryable && attempt < maxRetries) {
                await sleep(getRetryDelay(response, attempt));
                continue;
            }
            if (!response.ok) {
                const { payload, raw } = await readResponsePayload(response);
                throw new Error(`API 返回 ${response.status}：${errorDetail(payload, raw, response.statusText)}`);
            }
            const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
            if (!contentType.includes('text/event-stream') || typeof response.body?.getReader !== 'function') {
                const { payload } = await readResponsePayload(response);
                if (payload === null) throw new Error('API 返回的不是有效 JSON。');
                if (payload?.error) throw new Error(`API 返回错误：${errorDetail(payload, '', '')}`);
                return payload;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let content = '';
            let reasoning = '';
            const consumeLine = (line) => {
                const trimmed = String(line ?? '').trim();
                if (!trimmed.startsWith('data:')) return;
                const data = trimmed.slice(5).trim();
                if (!data || data === '[DONE]') return;
                let payload;
                try {
                    payload = JSON.parse(data);
                } catch {
                    return;
                }
                if (payload?.error) throw new Error(`API 返回错误：${errorDetail(payload, data, '')}`);
                const choice = payload?.choices?.[0];
                content += streamContentText(choice?.delta?.content ?? choice?.message?.content ?? choice?.text);
                reasoning += streamContentText(choice?.delta?.reasoning_content
                    ?? choice?.delta?.reasoning
                    ?? choice?.message?.reasoning_content
                    ?? choice?.message?.reasoning);
            };
            while (true) {
                const { done, value } = await reader.read();
                if (!done || value?.length) resetIdleTimeout();
                buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
                const lines = buffer.split(/\r?\n/);
                buffer = done ? '' : lines.pop() ?? '';
                lines.forEach(consumeLine);
                if (done) {
                    if (buffer) consumeLine(buffer);
                    break;
                }
            }
            if (!content.trim() && !reasoning.trim()) throw new Error('手机世界更新 API 的流式响应没有返回正文。');
            return { choices: [{ message: { content, reasoning_content: reasoning } }] };
        } catch (error) {
            if (error?.name === 'AbortError') {
                if (abortReason === 'external') throw new Error('这次手机请求已被新的正文候选替换。');
                if (abortReason === 'idle') {
                    throw new Error(`连续 ${Math.ceil(idleTimeoutMs / 1000)} 秒没有收到 API 数据，已停止这次请求。`);
                }
                throw new Error(`请求超过 ${Math.ceil(timeoutMs / 1000)} 秒仍未完成。`);
            }
            const detail = String(error?.message ?? error);
            const connectionInterrupted = /failed to fetch|networkerror|load failed|fetch failed|terminated/i.test(detail);
            if (connectionInterrupted && attempt < maxRetries) {
                await sleep(getRetryDelay(null, attempt));
                continue;
            }
            if (connectionInterrupted) {
                throw new Error('浏览器与 API 的连接中断（可能是跨域限制、网关超时或中转主动断开）。');
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            clearTimeout(idleTimeout);
            externalSignal?.removeEventListener?.('abort', abortFromOutside);
        }
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
    threshold = 0.6,
    reranker,
}, options = {}) {
    const documents = Array.isArray(candidates)
        ? candidates.map(candidate => String(candidate?.text ?? candidate ?? ''))
        : [];
    if (documents.length === 0) return { results: [] };
    const config = normalizeConfig(reranker, 'Reranker');
    const endpoint = new URL(`${config.baseUrl}/v1/rerank`).toString();
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(topN) || 7)));
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
    statusWorldContext = '',
    previousStatus = null,
    previousTimeline = null,
    developmentSnapshot = null,
    characterBaselines = null,
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
    const previousTimeAnchor = String(
        previousStatus?.environment?.time
        || previousTimeline?.currentTime
        || previousTimeline?.mainlineTime
        || '',
    ).trim();
    const hasDate = /(?:\d{2,4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?|(?:历|纪元|纪年).{0,24}(?:年|月|日|旬))/u.test(previousTimeAnchor);
    const hasClock = /(?:(?:[01]?\d|2[0-3]):[0-5]\d|(?:子|丑|寅|卯|辰|巳|午|未|申|酉|戌|亥)时|\d+\s*(?:时|刻|更))/u.test(previousTimeAnchor);
    const hasCycle = /(?:星期|周[一二三四五六日天]|礼拜|曜|周期|轮回|月相)/u.test(previousTimeAnchor);
    const hasPreviousTimeAnchor = hasDate && hasClock && hasCycle;
    const customFields = (Array.isArray(statusOptions?.customFields) ? statusOptions.customFields : [])
        .filter(field => field?.enabled !== false)
        .map(field => String(field?.label ?? '').trim())
        .filter(Boolean);
    const showGoals = statusOptions?.showGoals !== false;
    const barrageEnabled = outputOptions?.barrageEnabled !== false;
    const statusEnabled = outputOptions?.statusEnabled !== false;
    const developmentEnabled = outputOptions?.developmentEnabled === true;
    const needsDerivedContext = statusEnabled || developmentEnabled;
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
        ...(statusEnabled ? [
            '',
            '【角色卡中的角色与世界基础】（用于理解人物性格、关系、时代、历法、地点与环境；是状态推导依据，不是新增剧情）',
            String(statusWorldContext ?? '').trim().slice(0, 24_000) || '（无额外世界基础）',
        ] : []),
        ...(needsDerivedContext ? [
            '',
            '【上一份剧情状态】（外貌、地点等没有变化的客观事实可以继承；动作、情绪、欲望和内心OS必须结合新剧情重新判断，不得机械照抄；如与新剧情冲突，以新剧情为准）',
            previous,
            '',
            '【上一份剧情时间线】（这是时间连续性的唯一基准；没有明确时间推进时必须原样继承）',
            previousTimelineText,
        ] : []),
        ...(developmentEnabled ? [
            '',
            '【人物初始基准】（这是故事开始前的设定，只用于判断“是否真的发生了变化”）',
            characterBaselines && typeof characterBaselines === 'object'
                ? JSON.stringify(characterBaselines)
                : '（未知；禁止根据身份刻板印象补写初始性格）',
            '',
            '【人物发展档案】（profiles 是已确认变化，不要重复提交；candidates 是观察中的同类趋势）',
            developmentSnapshot && typeof developmentSnapshot === 'object'
                ? JSON.stringify(developmentSnapshot)
                : '（无）',
        ] : []),
        '',
        '---',
        '',
        `[最新章节楼号：第 ${latest.id} 楼]`,
        '【最新章节】（这是本轮状态更新的直接剧情依据）',
        latest.text,
        '',
        '【必须完成的输出任务】',
        `完成：${requestedTasks || '返回空结果'}。只输出 JSONL，不要 Markdown，不要解释。每行必须是一个能够独立 JSON.parse 的完整对象；模块之间绝不能共用括号、逗号或字符串。`,
        '严格按 status → timeline → development → barrage 的顺序输出已启用模块。某一行损坏不得改变其他行；未启用模块整行省略。',
        ...(statusEnabled ? [
            'status 行：{"module":"status","data":{"environment":{"time":"完整时间","location":"大地点 → 小地点","season":"季节","weather":"天气"},"characters":[{"name":"人物名","role":"user、char或重要NPC","appearance":"当前外貌","action":"当前动作或姿态","emotion":"当前情绪","desire":"当前欲望或倾向","innerThoughts":"1至3句内心OS","extras":[{"label":"玩家启用的状态名","value":"状态内容"}]}],"event":{"activity":"正在做什么","situation":"当前形势","goals":["当前目标"]}}}',
            'timeline 行：{"module":"timeline","data":{"transition":"unchanged|advance|jump|enter_flashback|return_mainline|unknown","currentTime":"当前叙事时间","mainlineTime":"主线现在","elapsed":"明确经过多久或空字符串","evidence":"证明时间变化的短原文或空字符串","segments":[{"messageId":12,"startQuote":"该段开头的短原文","time":"该段时间","relation":"与主线现在的关系","mode":"mainline|flashback|flashforward|mention|unknown"}]}}',
        ] : []),
        ...(developmentEnabled ? [
            'development 行：{"module":"development","data":{"changes":[{"character":"人物名","dimension":"temperament|belief|relationship|habit|boundary|self_view","target":"关系对象或空字符串","candidateId":"候选ID或空字符串","trend":"稳定语义标签","before":"过去倾向或空字符串","after":"长期变化","reason":"已知原因或空字符串","source":"user_direct|observed","evidence":[{"messageId":12,"quote":"逐字短原文"}]}],"merges":[{"intoId":"保留ID","fromIds":["并入ID"],"trend":"合并标签","after":"合并后的当前倾向"}]}}',
        ] : []),
        ...(barrageEnabled ? [
            'barrage 必须最后输出。barrage 行：{"module":"barrage","data":{"lines":["弹幕1","弹幕2","弹幕3"]}}。lines 中每项只能是纯字符串，禁止输出作者对象、content 对象或包含真实换行的单个字符串。',
        ] : []),
        statusEnabled
            ? 'status 是最新章节结束时的一份当前快照，不是剧情总结。必须包含 user 和 char；只加入真正重要的 NPC，忽略普通 NPC。'
            : '剧情状态已关闭，省略 status 与 timeline 两行。',
        statusEnabled ? '不要生成金钱、物品栏、数值属性或游戏面板数据。人物状态的“有依据”包括两类：正文直接写明的事实，以及从角色卡人设、既有关系、相关记忆、上一份状态和本轮言行中能够合理推出的隐含状态。后者是允许且必须进行的有依据推导，不算瞎编。' : '',
        statusEnabled ? 'appearance 和 action 要写章节结束时的当前状态，可以在不改变事件结果的前提下补足正文省略的自然连续细节。emotion、desire、innerThoughts 本来就是解释性状态：正文没有逐字写出时，也必须结合人物性格、处境、关系与言行推导，不能因为原文未明说就留空，更不能复制正文句子充数。' : '',
        statusEnabled ? 'innerThoughts 要写成该人物此刻真正会在心里掠过的1至3句简短OS，使用符合其人设的内在口吻；不要复述旁白、动作或已经说出口的台词，不要把 emotion/desire 换个说法再写一遍。允许包含人物自己的判断、犹豫、误会、盘算和没有说出口的话。' : '',
        statusEnabled ? '心理推导仍受角色视角约束：人物只能根据自己亲历、看见、听见、被告知或能够合理猜到的信息思考；可以猜错，但不得知道未公开的他人内心、幕后事件或自己不可能掌握的事实。不得为了丰富OS新增正文之外已经发生的事件。' : '',
        statusEnabled && !hasPreviousTimeAnchor
            ? '这是本存档第一次建立时间锚点。先完整检查故事基础设定、相关记忆、前情回顾、最新章节中是否已有明确日期、时刻、星期或世界历法记录；有就以它为准，并在不冲突的前提下补齐缺少的组成。若完全没有明确记录，必须依据世界观合理设定一个完整起始时间，不能只写“早上、深夜、某日、时间不明”等模糊词。'
            : '',
        statusEnabled && !hasPreviousTimeAnchor
            ? '首次 environment.time 必须精确到“年-月-日 24小时制时:分 星期几”；若世界观不用公历或七日星期，则改用该世界真正采用的完整历法日期、记时刻度和对应周期名。首次 timeline.currentTime 与 timeline.mainlineTime 必须使用同一个完整锚点。'
            : '',
        statusEnabled && !hasPreviousTimeAnchor
            ? '首次 environment 的 location、season、weather 也必须建立。正文或设定明确写了就如实记录；没有写时，依据当前场景、世界观和刚建立的日期合理补全，不要留成“未知”。这种合理补全只负责建立可持续的环境基准，不得反过来新增剧情事件。'
            : '',
        statusEnabled && hasPreviousTimeAnchor
            ? '本存档已经有精确时间锚点。它是后续唯一基准：正文没有明确时间推进时，environment.time、timeline.currentTime 与 timeline.mainlineTime 必须逐字继承；明确推进时从该锚点连续换算出新的完整日期、24小时制时刻与星期／世界周期，不能退化成“次日、稍后、夜里”等模糊记录，也不能另起一套日期。'
            : '',
        statusEnabled && hasPreviousTimeAnchor
            ? '后续 environment 的地点、季节、天气：正文明确改变则更新，没有改变则继承上一份；不得每楼重新随机。'
            : '',
        statusEnabled ? '时间线规则：楼层数不代表时间流逝。即使连续很多楼，正文没有明确推进时间时，transition 必须为 unchanged，并逐字继承上一份 currentTime 与 mainlineTime。' : '',
        statusEnabled ? '仅仅提到、回忆或召回“昨天、三天前、十年前”的历史事件，不会改变主线现在。只有正文真的进入过去场景才是 enter_flashback；回到原场景才是 return_mainline。' : '',
        statusEnabled ? '最新用户指令或最新章节若明确写出“次日、数日后、十年后”等真实推进，可用 advance 或 jump，跨度不受限制；无法确定就用 unknown，绝不能猜。' : '',
        statusEnabled ? 'segments 覆盖前情回顾里尚未建立状态的最新用户楼和最新章节，按每一楼内真实发生的时间转折列出；一楼可有多个时间段。messageId 必须使用上文标出的楼号，startQuote 必须逐字摘取该时间段开头的短句，以便切片器定位；单纯提及历史而未进入场景时 mode=mention。' : '',
        statusEnabled ? 'timeline 模块必须输出；segments 没有内容时返回空数组。' : '',
        developmentEnabled ? '人物发展默认没有变化，development.changes 默认必须是空数组。提供了这个模块不代表必须填写；绝大多数回复都应返回空数组。当前情绪、一次行为、临时欲望和当场失态都不属于长期变化。' : '人物发展档案已关闭，省略 development 行。',
        developmentEnabled ? '必须先拿人物初始基准与已有发展档案比较。符合初始性格、初始关系或一贯保护方式的行为不是“变化”，绝不能为了填写 before/after 而虚构一个过去状态。' : '',
        developmentEnabled ? '人物初始基准里的 knownCharacters 只列出本轮确实找到基准的人物。某个人物不在 knownCharacters 中，就视为该人物基准未知：禁止从平民、贵族、职业、种族、阵营、性别或关系身份推断其原本性格；除非玩家最新输入直接明确前后变化，否则不要提交该人物的变化。' : '',
        developmentEnabled ? '单人卡模式中，primaryCharacter 的基础性格以酒馆角色卡为准；世界书条目只补充其标注 useFor 的人物关系、背景约束和重要 NPC，冲突时角色卡优先。世界／群像卡则只使用世界书中按 useFor 匹配到的各人物条目。不要把一个人物的设定套给另一个人。' : '',
        developmentEnabled ? '只有两类内容可以写入 changes：①玩家最新输入明确陈述人物如今已经变成怎样，此时 source=user_direct；②跨不同事件反复出现、足以支持长期改变的行为模式，此时 source=observed。AI 正文自己突然宣布性格大变，只能算 observed，不能冒充玩家设定。' : '',
        developmentEnabled ? 'user_direct 的 evidence 必须逐字引用用户楼层中的明确事实或设定。玩家明确设定拥有最高优先级，即使与角色卡或旧档案矛盾也必须采用；时间跳跃中未交代的变化原因必须留空，不准擅自补全。' : '',
        developmentEnabled ? '仅写“十年后”只代表时间推进，不能自动改变性格。只有同时明确写出“十年后她已变得阴郁”等人物新状态时，才记录对应变化。玩家角色 user 的性格、观念和内心只允许 user_direct，禁止根据一次选择擅自推断。' : '',
        developmentEnabled ? '每条 evidence 的 messageId 必须使用上文真实楼号，quote 必须是该楼逐字存在的短原文；没有可核对原文就不要提交。不要重复已经确认的人物发展。' : '',
        developmentEnabled ? '先比较 candidates：暴躁、火爆、易怒等措辞不同但含义和方向相同的描述必须复用同一个 candidateId，不能新建；含义相反的变化绝不能合并。after 写简洁结论，详细情节只放 evidence。' : '',
        developmentEnabled ? 'after 只写中性、可持续的当前倾向，不写“完全放弃、凌驾于、挑战权威、确立地位”等未经原文明确支持的动机、目的或夸张因果；reason 不明确就留空。' : '',
        developmentEnabled ? '若 candidates 中已经存在明显重复项，使用 merges 合并。merges 只整理语义和方向明确相同的候选；没有可安全合并的内容时返回空数组。' : '',
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
        '只输出一行合法 JSONL：{"module":"barrage","data":{"lines":["弹幕1","弹幕2","弹幕3"]}}。lines 每项只能是纯字符串。',
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

function findJsonlModuleLines(text) {
    const acceptedModules = new Set(['barrage', 'status', 'timeline', 'development']);
    const lines = [];
    for (const sourceLine of String(text ?? '').split(/\r?\n/)) {
        const line = sourceLine.trim().replace(/^```(?:jsonl?|javascript)?\s*/i, '').replace(/\s*```$/i, '');
        if (!line.startsWith('{') || !line.endsWith('}')) continue;
        try {
            const value = JSON.parse(line);
            const module = String(value?.module ?? '').trim().toLowerCase();
            if (value && typeof value === 'object' && !Array.isArray(value) && acceptedModules.has(module)) {
                lines.push(JSON.stringify(value));
            }
        } catch {
            // Ignore analysis prose and incomplete module lines.
        }
    }
    return lines.join('\n');
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
        if (/弹幕/.test(label)) {
            const jsonl = findJsonlModuleLines(reasoning);
            if (jsonl) return jsonl;
        }
        const acceptedKeys = /地图册/.test(label)
            ? ['title', 'pages']
            : /直播/.test(label) ? ['phase', 'sessionSummary']
            : /手机世界/.test(label) ? ['module', 'messages']
            : /手机/.test(label) ? ['messages']
            : /弹幕/.test(label) ? ['module', 'barrage', '弹幕', 'status', '状态', 'timeline', '时间线', 'development', '人物发展'] : [];
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
        payload?.statusWorldContext,
        payload?.previousStatus,
        payload?.previousTimeline,
        payload?.developmentSnapshot,
        payload?.characterBaselines,
        payload?.statusOptions,
        payload?.outputOptions,
    );
    const maxTokens = Math.max(1, Math.min(128_000, Math.trunc(Number(payload?.maxTokens) || 4064)));
    const barrageEnabled = payload?.outputOptions?.barrageEnabled !== false;
    const statusEnabled = payload?.outputOptions?.statusEnabled !== false;
    const developmentEnabled = payload?.outputOptions?.developmentEnabled === true;
    const requestBody = {
        model: config.model,
        messages: [
            ...(systemPrompt && barrageEnabled ? [{
                role: 'system',
                content: `以下自定义要求只控制 barrage 弹幕字段的语言风格，不得用于 status、timeline 或 development，也不得覆盖这些字段各自的规则：\n${systemPrompt}`,
            }] : []),
            ...((statusEnabled || developmentEnabled) ? [{
                role: 'system',
                content: [
                    '以下规则是 status 与 development 模块理解人物、关系、动机和心理变化时必须遵守的高优先级指导。',
                    '它适用于 emotion、desire、innerThoughts，适用于 event 的 activity、situation、goals 中涉及动机与未来意图的判断，也适用于 development 的人物长期发展判断。',
                    '客观时间、地点、季节、天气、外貌和已经发生的动作仍以正文、设定与时间线事实为准，不得被心理推导改写。',
                    STATE_PSYCHOLOGY_GUIDE,
                ].join('\n\n'),
            }] : []),
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

export async function generateCustomPanelCompletion(payload, options = {}) {
    const config = normalizeConfig(payload?.barrage, '自定义栏');
    const endpoint = new URL(`${config.baseUrl}/v1/chat/completions`).toString();
    const prompt = String(payload?.prompt ?? '').trim();
    const choicesEnabled = payload?.choicesEnabled === true;
    const customContentEnabled = payload?.customContentEnabled !== false;
    if (!choicesEnabled && (!customContentEnabled || !prompt)) {
        throw new Error('自定义栏没有开启任何需要生成的内容。');
    }
    const recentMessages = Array.isArray(payload?.recentMessages)
        ? payload.recentMessages.filter(message => String(message?.text ?? '').trim())
        : [];
    if (recentMessages.length === 0) throw new Error('自定义栏没有收到可供参考的剧情。');
    const renderHtml = customContentEnabled && payload?.renderHtml === true;
    const maxTokens = Math.max(1, Math.min(128_000, Math.trunc(Number(payload?.maxTokens) || 2048)));
    const story = recentMessages.map(message => {
        const role = message?.role === 'user' ? '用户' : '角色';
        const name = String(message?.name ?? role).trim() || role;
        return `[第${message.id}楼·${role}·${name}]\n${String(message.text ?? '').trim()}`;
    }).join('\n\n');
    const outputRule = !customContentEnabled
        ? ''
        : renderHtml
        ? [
            `${choicesEnabled ? '在规定的选项 JSON 首行之后' : '直接'}输出一份可在沙箱 iframe 中显示的 HTML，不要包裹 Markdown 代码块，不要解释。`,
            '界面必须响应式适配手机和电脑，字号清晰、对比度足够，不要依赖外部网页、外部脚本或外部样式。',
            '可以使用内联 CSS 和 JavaScript，但不得试图访问父页面、酒馆数据或本地存储。',
        ].join('\n')
        : '只输出最终要显示的纯文本，不要输出 HTML、Markdown 代码块或额外解释。';
    const choiceRule = choicesEnabled ? [
        '固定输出四个玩家此刻可以选择的下一步，顺序必须是：善良、邪恶、中立、沙雕。',
        '每个选项都是简短的一句台词加一个行动，必须结合最新剧情、玩家已有人设与当前情境，不能只写抽象路线或剧情预测。',
        '善良偏同理、体谅或主动帮助；邪恶偏自私、利用、挑衅或伤害；中立偏实用、克制或观望；沙雕偏荒诞搞笑，但四者都要在当前剧情中真的能做。',
        '不得代替其他角色回应，不得预定行动结果，不得使用玩家当前不知道的信息。',
        '回复第一行必须且只能是单行 JSON，格式为 KK_CHOICES_JSON={"choices":[{"tone":"善良","text":"台词＋行动"},{"tone":"邪恶","text":"台词＋行动"},{"tone":"中立","text":"台词＋行动"},{"tone":"沙雕","text":"台词＋行动"}]}。',
    ].join('\n') : '不生成剧情选项，也不得输出 KK_CHOICES_JSON 行。';
    const finalOutputRule = choicesEnabled && customContentEnabled
        ? '第一行选项 JSON 之后紧接自定义栏的最终内容；两部分都不要附加解释。'
        : choicesEnabled
            ? '只输出第一行选项 JSON，不要输出其他文字。'
            : outputRule;
    const response = await postJson(endpoint, {
        model: config.model,
        messages: [
            {
                role: 'system',
                content: [
                    '你负责生成一个完全由玩家定义的剧情附加栏。',
                    '忠实执行玩家的自定义要求；剧情原文是事实依据，可以在已有信息上合理推导，不得篡改已发生的事实。',
                    '这个栏没有预设用途、观众身份或直播语境，不得自行添加这些设定。',
                    choiceRule,
                    outputRule,
                    finalOutputRule,
                ].filter(Boolean).join('\n'),
            },
            {
                role: 'user',
                content: [
                    ...(customContentEnabled ? [`【玩家自定义要求】\n${prompt}`] : []),
                    `【最近剧情】\n${story}`,
                ].join('\n\n'),
            },
        ],
        max_tokens: maxTokens,
    }, config, options);
    return { content: extractChatContent(response, '自定义栏副 API') };
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

const PHONE_JSON_OUTPUT_SHAPE = '{"messages":[{"sender":"发言者姓名","type":"text","content":"正文","duration":1,"amount":0,"recipient":"","count":0,"stickerName":""}],"roundSummary":"用一两句话概括本轮线上对话中明确发生的内容，不推测未表达的反应","memory":{"events":[{"type":"commitment","summary":"只写明确成立的线上事实","participants":["人物"],"sourceMessageIds":["msg-id"],"evidenceQuotes":["逐字证据"],"status":"active","resolvesEventIds":[]}]}}';

export function buildPhoneUserContent(payload = {}) {
    const PHONE_PROMPT_CHAR_LIMIT = 50_000;
    const snapshot = payload?.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : {};
    const storyContext = payload?.storyContext && typeof payload.storyContext === 'object'
        ? payload.storyContext
        : {};
    const conversation = snapshot?.conversation ?? {};
    const profile = snapshot?.profile ?? {};
    const playerNickname = String(profile.nickname ?? '我').trim() || '我';
    const participants = conversation.type === 'group'
        ? (Array.isArray(conversation.members) ? conversation.members : [])
            .map(value => String(value ?? '').trim())
            .filter(value => value && value !== playerNickname)
        : [conversation.name];
    const recentStory = (Array.isArray(payload?.recentStory) ? payload.recentStory : [])
        .map(item => String(item ?? '').trim())
        .filter(Boolean)
        .slice(-8);
    const messageRecords = Array.isArray(snapshot?.messageRecords) ? snapshot.messageRecords : [];
    const phoneMessages = (messageRecords.length > 0
        ? messageRecords.map(item => {
            const roundId = String(item?.roundId ?? '').trim();
            const messageId = String(item?.id ?? '').trim();
            return `${roundId ? `[轮次 ${roundId}]` : ''}[${messageId}] ${String(item?.text ?? '').trim()}`;
        })
        : (Array.isArray(snapshot?.messages) ? snapshot.messages : []))
        .map(item => String(item ?? '').trim())
        .filter(Boolean);
    const activeMemory = (Array.isArray(snapshot?.activeMemory) ? snapshot.activeMemory : [])
        .map(item => `[${String(item?.id ?? '').trim()}] ${String(item?.summary ?? '').trim()}`)
        .filter(Boolean);
    const olderRoundSummaries = (Array.isArray(snapshot?.olderRoundSummaries)
        ? snapshot.olderRoundSummaries
        : [])
        .map(item => `[轮次 ${String(item?.id ?? '').trim()}] ${String(item?.summary ?? '').trim()}`)
        .filter(item => item.trim())
        .join('\n');
    const roundSummaryMap = new Map((Array.isArray(snapshot?.roundSummaries) ? snapshot.roundSummaries : [])
        .map(item => [String(item?.id ?? '').trim(), String(item?.summary ?? '').trim()]));
    const stickerNames = (Array.isArray(snapshot?.stickers) ? snapshot.stickers : [])
        .map(item => String(item ?? '').trim())
        .filter(Boolean);
    const formatIdentity = (displayName, identity = {}) => {
        const mode = String(identity?.mode ?? 'unbound');
        if (mode === 'unbound') {
            return `【${displayName}】尚未绑定真实身份。不得把角色卡主角或最近正文中的其他人物人格套给此联系人；只根据手机聊天中已经明确的信息回应，信息不足时保持克制。`;
        }
        const persona = String(identity?.persona ?? '').trim().slice(0, 12000);
        const note = String(identity?.note ?? '').trim().slice(0, 4000);
        return [
            `【${displayName}】真实身份：${String(identity?.label ?? '已绑定人物').trim()}`,
            persona,
            note ? `【玩家补充】${note}` : '',
        ].filter(Boolean).join('\n');
    };
    const identitySections = conversation.type === 'group'
        ? participants.map(name => formatIdentity(name, conversation?.memberIdentities?.[name]))
        : [formatIdentity(conversation.name || '联系人', conversation.identity)];
    const contextSection = (label, value, maximum) => {
        const content = String(value ?? '').trim().slice(0, maximum);
        return content ? `【${label}】\n${content}` : '';
    };
    const fixedHeader = [
        '你正在模拟虚构故事中的手机通讯，只扮演对话中的联系人或群成员，不扮演玩家。',
        `玩家手机昵称：${playerNickname}`,
        `会话类型：${conversation.type === 'group' ? '群聊' : '单聊'}`,
        `会话名称：${String(conversation.name ?? '').trim()}`,
        `允许发言者：${participants.filter(Boolean).join('、') || '会话中的联系人'}`,
        profile.persona ? `【玩家当前手机身份设定】\n${String(profile.persona).slice(0, 12000)}` : '',
        profile.isMask
            ? '【匿名马甲边界】当前账号是不绑定玩家真实身份的小号。联系人不得因为系统知道玩家是谁，就自动认出账号主人。只有聊天记录或正文里已经公开出现了足够线索时，才允许角色产生有根据的怀疑；怀疑也不能直接写成确认。'
            : '',
        '',
        '【联系人真实身份】（身份设定优先于最近正文；手机备注名不等于人物本名）',
        (identitySections.join('\n\n') || '（无）').slice(0, 16_000),
    ];
    const rules = [
        '返回1至5条自然的联系人回复。只输出合法 JSON，不要 Markdown，不要解释。',
        '输出结构：',
        PHONE_JSON_OUTPUT_SHAPE,
        'type 只能是 text、voice、image、redpacket、group_redpacket、location、sticker。',
        'text：content 是文字。',
        'voice：content 是语音转成的文字，duration 是1至60秒。',
        'image：content 只写图片内容描述，不输出图片链接，也不声称读取了真实图片。',
        'redpacket：amount 是模拟红包金额，content 是祝福语；在群聊中必须用 recipient 指定一名真实群成员，单聊中 recipient 留空。',
        'group_redpacket：仅群聊可用；amount 是模拟总金额，count 是红包份数，content 是祝福语，recipient 留空。发送者本人也可以参与随机领取。',
        'location：content 是地点名称及必要备注。',
        'sticker：stickerName 必须逐字选择上面已有的表情包名称，content 留空；没有可用名称时禁止使用。',
        'AI 只根据表情包名称选择，不需要也不得读取表情包图片内容。',
        '人物身份优先级：玩家补充／绑定人物设定 ＞ 手机聊天记录中已成立的信息 ＞ 最近正文。最近正文只提供事件与时间，不得擅自改变联系人是谁。',
        '事实与时间优先级：玩家刚刚发送的手机消息及最新用户正文 ＞ 当前剧情状态与较晚内容 ＞ 相关历史召回和较早总结。历史只供保持连续性，绝不能让时间线倒退或覆盖玩家的新设定。',
        '世界书、人物发展和地图属于背景约束；只在与本次通讯相关时自然体现，不要为了证明读过设定而强行提及。',
        '单聊只能由联系人发言；群聊可由一个或多个群成员分别发言。sender 必须使用允许发言者中的原名。不要代替玩家发送消息。',
        '这些功能都只是剧情中的通讯表现，不进行真实转账、定位、通话或图片识别。',
        'memory.events 只保存值得长期记住的内容；没有就返回空数组。type 只能是 platform_fact、explicit_action、commitment、conflict、confirmed_reaction、unknown_state。',
        '每条记忆必须提供至少一段 evidenceQuotes，且必须逐字存在于本次输出消息或上面的手机聊天记录；sourceMessageIds 只能使用记录前方真实存在的 msg-id。',
        '严格禁止脑补：发送、收到、热搜存在、帖子存在，都不代表任何角色已经看见、读完、理解、赞同、讨厌或产生情绪。只有角色在消息里明确说出的反应才能记为 confirmed_reaction；否则写 unknown_state 或完全不记录。',
        '不得根据人物性格推测其反应，不得把“可能、应该、看起来”改写成事实。平台内容只记录内容本身；角色是否接触或如何反应，必须等待正文或手机互动明确确认。',
        '匿名马甲不等于真实身份公开。若当前资料标记 isMask=true，严禁让联系人无证据认出玩家；系统提供的玩家真实剧情只能用于保持世界一致，不能当作联系人已知信息。',
        'commitment 和尚未化解的 conflict 使用 status=active；普通事实使用 informational。只有新消息逐字明确完成、取消或化解已有事项时，才把其真实 ID 写入 resolvesEventIds。',
        'roundSummary 只概括本轮真实出现的对话事实；视觉上拆成多个气泡仍然是一轮，不得因此虚构多个事件。',
    ];
    const fullPhoneHistory = `【手机聊天记录】\n${phoneMessages.join('\n') || '（这是第一次通讯）'}`;
    const compressPhoneHistory = maximum => {
        if (fullPhoneHistory.length <= maximum || messageRecords.length === 0) return fullPhoneHistory.slice(0, maximum);
        const groups = [];
        const byRound = new Map();
        for (const record of messageRecords) {
            const roundId = String(record?.roundId ?? record?.id ?? '').trim();
            let group = byRound.get(roundId);
            if (!group) {
                group = { roundId, records: [] };
                byRound.set(roundId, group);
                groups.push(group);
            }
            group.records.push(record);
        }
        const rawTarget = Math.max(4000, Math.floor(maximum * 0.68));
        const recentGroups = [];
        let rawLength = 0;
        let firstRecent = groups.length;
        for (let index = groups.length - 1; index >= 0; index -= 1) {
            const lines = groups[index].records.map(record => {
                const messageId = String(record?.id ?? '').trim();
                return `[轮次 ${groups[index].roundId}][${messageId}] ${String(record?.text ?? '').trim()}`;
            });
            const block = lines.join('\n');
            if (rawLength + block.length + 1 > rawTarget && recentGroups.length > 0) break;
            recentGroups.unshift(block);
            rawLength += block.length + 1;
            firstRecent = index;
        }
        const recentSection = `【最近手机轮次原文】\n${recentGroups.join('\n')}`;
        const olderGroups = groups.slice(0, firstRecent);
        const summaryBudget = Math.max(0, maximum - recentSection.length - 2);
        let summarySection = '';
        if (olderGroups.length > 0 && summaryBudget > 0) {
            const heading = '【较早手机轮次概括】\n';
            const lineBudget = Math.max(12, Math.floor((summaryBudget - heading.length) / olderGroups.length) - 1);
            const lines = olderGroups.map(group => {
                const fallback = group.records.map(record => String(record?.text ?? '').trim()).join('；');
                return `[${group.roundId}] ${String(roundSummaryMap.get(group.roundId) || fallback).slice(0, lineBudget)}`;
            });
            summarySection = `${heading}${lines.join('\n')}`.slice(0, summaryBudget);
        }
        return [summarySection, recentSection].filter(Boolean).join('\n\n').slice(0, maximum);
    };
    const priorityContextSections = [
        `【最近正文】（只用于人物、关系与当前事件连续性）\n${recentStory.join('\n') || '（无）'}`,
        `【仍有效的线上约定或冲突】（只有后续消息明确完成、取消或化解时，才能填写 resolvesEventIds）\n${activeMemory.join('\n') || '（无）'}`,
    ].filter(Boolean);
    const supplementalContextSections = [
        contextSection('当前剧情状态与时间线', storyContext.storyStatus, 12000),
        contextSection('故事基础设定', storyContext.storyFoundation, 24000),
        contextSection('酒馆关键词触发的世界书设定', storyContext.activatedWorldInfo, 24000),
        contextSection('相关历史总结、正文细节与语义设定召回', storyContext.retrievedContext, 32000),
        contextSection('与本次通讯相关的旧手机记忆', storyContext.phoneMemoryContext, 8000),
        contextSection('人物在长期剧情中已经形成的变化', storyContext.characterDevelopment, 12000),
        contextSection('当前地点关系', storyContext.mapContext, 8000),
        `【可用表情包名称】${stickerNames.length > 0 ? stickerNames.join('、') : '（无）'}`,
        olderRoundSummaries ? `【更早手机轮次概括】\n${olderRoundSummaries}` : '',
    ].filter(Boolean);
    const fullContextSections = [fullPhoneHistory, ...priorityContextSections, ...supplementalContextSections];
    const fixedText = fixedHeader.join('\n');
    const ruleText = rules.join('\n');
    let remaining = Math.max(0, PHONE_PROMPT_CHAR_LIMIT - fixedText.length - ruleText.length - 4);
    const fullContextLength = fullContextSections.reduce((total, section) => total + section.length + 2, 0);
    const priorityContextLength = priorityContextSections
        .reduce((total, section) => total + section.length + 2, 0);
    const availableForPhoneHistory = Math.max(0, remaining - priorityContextLength - 2);
    const phoneHistoryBudget = fullContextLength <= remaining
        ? fullPhoneHistory.length
        : Math.min(
            fullPhoneHistory.length,
            availableForPhoneHistory,
            Math.max(8000, Math.floor(remaining * 0.65)),
        );
    const contextSections = [
        compressPhoneHistory(phoneHistoryBudget),
        ...priorityContextSections,
        ...supplementalContextSections,
    ].filter(Boolean);
    const fittedContext = [];
    for (const section of contextSections) {
        if (remaining <= 0) break;
        const part = section.slice(0, remaining);
        fittedContext.push(part);
        remaining -= part.length + 2;
    }
    return [fixedText, ...fittedContext, ruleText].filter(Boolean).join('\n\n');
}

export async function generatePhoneCompletion(payload, options = {}) {
    const config = normalizeConfig(payload?.barrage, '手机通讯');
    const endpoint = new URL(`${config.baseUrl}/v1/chat/completions`).toString();
    const maxTokens = Math.max(256, Math.min(8192, Math.trunc(Number(payload?.maxTokens) || 2048)));
    const response = await postJson(endpoint, {
        model: config.model,
        messages: [
            {
                role: 'system',
                content: '你负责模拟虚构故事人物的手机消息。保持人物设定，只输出指定 JSON，不续写手机之外的正文。',
            },
            { role: 'user', content: buildPhoneUserContent(payload) },
        ],
        max_tokens: maxTokens,
    }, config, { timeoutMs: 120_000, ...options });
    return { content: extractChatContent(response, '手机通讯副 API') };
}

export function buildWeiboUserContent(payload = {}) {
    const request = payload?.request && typeof payload.request === 'object' ? payload.request : {};
    const sharedContext = request.storyContext && typeof request.storyContext === 'object'
        ? Object.values(request.storyContext).filter(value => typeof value === 'string' && value.trim()).join('\n\n').slice(0, 60_000)
        : '';
    const mode = String(request.mode ?? 'story');
    const roleAccounts = (Array.isArray(request.roleAccounts) ? request.roleAccounts : []).map(account => ({
        id: account?.id,
        nickname: account?.nickname,
        bio: account?.bio,
        identity: {
            mode: account?.identity?.mode,
            label: account?.identity?.label,
            persona: String(account?.identity?.persona ?? '').slice(0, 8000),
            note: String(account?.identity?.note ?? '').slice(0, 2000),
        },
    }));
    const operationRules = {
        player_post: '只生成 1 条 authorType=player 的完整帖子。正文、话题、图片描述、位置和提及必须忠实保留 operation 中的玩家输入；玩家输入先前尚未公开，不得假装网友已经见过别的版本。',
        player_repost: '只生成 1 条 authorType=player、kind=repost 的完整帖子，必须忠实保留 operation 中的转发文字与原帖 source。',
        player_reply: 'posts 必须为空。reply 的 postId、commentId、content 必须逐字对应 operation；根据这次公开回复只调整合理的粉丝变化和现有公共热度。',
        role_post: '只生成 1 条 authorType=role 的完整帖子，authorId 必须等于 operation.roleId。内容由该账号绑定人设、operation.instruction 与现有公共信息共同决定。',
        bootstrap: '生成 5–8 条初始首页帖子。若没有正文事件，则按玩家兴趣生成自然、互不重复且不围绕玩家的公共世界日常；同时根据玩家设定给出合理的初始粉丝基线（通过 followerDelta 返回）。',
        story: '根据本次正文新增 5–8 条首页帖子。没有适合公开讨论的剧情时，必须按玩家兴趣生成与主角无关的行业、作品、生活或陌生人公共动态，不能因此少生成。热搜增量生成 3–5 条，其余榜位由插件从旧帖补齐。',
    };
    return [
        '你负责模拟虚构故事世界里的公共微博。只输出合法 JSON，不要 Markdown，不要解释。',
        `本次模式：${mode}`,
        operationRules[mode] ?? operationRules.story,
        '',
        '输出结构：',
        '{"posts":[{"id":"唯一ID","authorType":"npc|role|player","authorId":"角色账号ID或空","author":"公开昵称","badge":"身份标签","tone":"rose","kind":"original|repost","content":"正文","topics":["兴趣ID"],"customTopics":["自由话题"],"imageDescription":"可空","location":"可空","mentions":[{"id":"账号ID","nickname":"昵称"}],"source":null,"createdAt":0,"metrics":{"reposts":0,"comments":0,"likes":0},"storyEvidence":"角色发帖时必须是正文中的逐字依据，否则为空","hotComments":[{"id":"唯一ID","author":"网友昵称","content":"必须与本帖高度相关","likes":0,"createdAt":0,"tone":"violet"}]}],"hotTopics":[{"id":"唯一ID","title":"热搜标题","postId":"必须指向本批新增帖子","heat":0,"mark":"爆|沸|热|新|"}],"reply":null,"followerDelta":0,"followerReason":"变化原因"}',
        '',
        '硬性规则：',
        '1. 每条帖子必须恰好生成 5 条与该帖具体内容高度相关的热评，不能把同一套评论复制给不同帖子；玩家回复模式除外，因为它不生成帖子。',
        '2. 点赞、评论、转发和热度按作者身份、内容性质与世界规模合理安排，不要所有帖子使用近似数据。',
        '3. 只有下方“已建立角色微博账号”中的账号允许 authorType=role。未建立账号的角色即使出现在正文也永远不能发帖。',
        '4. 正文驱动时，角色发帖必须有正文明确写出的动作或处境依据；storyEvidence 必须逐字复制正文中的一小段原句。仅出现姓名、仅有人设上可能会发、或网友可能猜到，都不构成依据。',
        '5. 即使正文有依据，也要判断角色性格、动机与公开发帖习惯；不适合发就不要强行发。',
        '6. 网友只能讨论公开可知的信息。私人场景没有公开来源时，不得让路人知道；可公开的目击、传闻或推测必须明确写成目击、传闻或推测。',
        '7. 玩家发帖、转发和回复的原始文字属于玩家本人，禁止改写意思或替玩家添加新的立场。',
        '8. 热搜只能指向本批 posts 中真实存在的 postId。没有值得上榜的内容可以返回空数组。',
        '9. followerDelta 表示本次增减量而非粉丝总数。普通互动通常小幅变化，爆款或名人事件才允许大幅变化，并给出简短原因。',
        '10. 若玩家微博资料 isMask=true，这是未绑定玩家真实身份的匿名马甲。网友、角色和参与者不得凭系统背景自动知道账号主人；只有公开帖子、互动或正文明确提供线索时才能有根据地猜测，而且猜测不能写成已确认。',
        '11. topics 只能填写 entertainment、film、music、variety、fashion、game、anime、sports、society、finance、technology、reading、food、travel、campus、emotion、pets 这些分类 ID；中文话题词必须放进 customTopics。',
        '12. 当前首页和热搜摘要只用于避免重复，不是仿写题库；公共微博生态不能默认围绕玩家或正文角色运转。',
        '',
        `玩家微博资料：${JSON.stringify(request.profile ?? {})}`,
        `玩家设定：${String(request.userPersona ?? '').slice(0, 12000) || '未提供；按普通人处理'}`,
        `当前粉丝数：${Number(request.followerCount) || 0}`,
        `兴趣标签：${JSON.stringify(request.interests ?? [])}`,
        `已建立角色微博账号：${JSON.stringify(roleAccounts)}`,
        `本次正文：${String(request.storyText ?? '').slice(0, 20000) || '（无）'}`,
        `共同故事背景：${sharedContext || '（无额外背景）'}`,
        `本次玩家操作：${JSON.stringify(request.operation ?? {})}`,
        `当前首页帖子摘要：${JSON.stringify(request.recentPosts ?? [])}`,
        `当前热搜摘要：${JSON.stringify(request.hotTopics ?? [])}`,
        `当前时间戳：${Number(request.now) || Date.now()}`,
    ].join('\n');
}

export async function generateWeiboCompletion(payload, options = {}) {
    const config = normalizeConfig(payload?.barrage, '微博更新');
    const endpoint = new URL(`${config.baseUrl}/v1/chat/completions`).toString();
    const maxTokens = Math.max(4096, Math.min(16_384, Math.trunc(Number(payload?.maxTokens) || 8192)));
    const response = await postJson(endpoint, {
        model: config.model,
        messages: [
            {
                role: 'system',
                content: '你只维护虚构世界的微博结构化数据。严格遵守角色账号门槛、正文证据门槛与 JSON 输出结构。',
            },
            { role: 'user', content: buildWeiboUserContent(payload) },
        ],
        max_tokens: maxTokens,
    }, config, { timeoutMs: 180_000, ...options });
    return { content: extractChatContent(response, '微博更新 API') };
}

export function buildLiveUserContent(payload = {}) {
    const request = payload?.request && typeof payload.request === 'object' ? payload.request : {};
    const sharedContext = request.storyContext && typeof request.storyContext === 'object'
        ? Object.values(request.storyContext).filter(value => typeof value === 'string' && value.trim()).join('\n\n').slice(0, 60_000)
        : '';
    const mode = String(request.mode ?? 'next');
    const modeRule = mode === 'start'
        ? '这是开播阶段。根据开播设置生成房间资料和第一阶段；room 必须完整填写。'
        : mode === 'end'
            ? '这是下播阶段。生成自然的收尾、告别弹幕和最终观众反应，不再开启新话题；room 返回 null。'
            : '这是普通的下一阶段。承接直播摘要和最近阶段，根据玩家发言、导演提示及所选弹幕继续；room 返回 null。';
    return [
        '你负责推进虚构故事里的玩家个人直播。只输出合法 JSON，不要 Markdown，不要解释。',
        modeRule,
        '',
        '输出结构：',
        '{"room":{"title":"直播标题","summary":"直播简介","cover":"画面标签","initialViewers":0},"phase":{"id":"唯一ID","scenes":[{"id":"唯一ID","kind":"narration|dialogue","segment":"画面阶段","speaker":"说话人，旁白可空","speakerRole":"身份，旁白可空","speakerType":"player|participant|host|guest，旁白可空","text":"内容"}],"barrages":[{"id":"唯一ID","author":"观众昵称","content":"弹幕","likes":0,"replyable":true}],"gifts":[{"id":"唯一ID","author":"观众昵称","label":"礼物名","icon":"emoji","value":1}],"viewerDelta":0,"followerDelta":0,"summary":"本阶段事实摘要"},"sessionSummary":"截至当前的整场直播摘要"}',
        '',
        '硬性规则：',
        '1. 每阶段生成 2–8 幕、8–20 条彼此不同且紧贴本阶段内容的弹幕；普通下一阶段建议生成 4–6 幕和 12–16 条弹幕。',
        '2. operation.speech 是玩家逐字填写的公开发言，插件会单独插入画面；禁止改写、扩写或在 scenes 中重复这段原话。',
        '3. operation.direction 是玩家授权的发挥范围。可以据此补充轻微衔接动作、镜头、参与者回应和自然后果，但不得越过方向替玩家作重大决定、制造新秘密或改变立场。',
        '4. selectedBarrages 是玩家选择要回应的准确弹幕。必须让本阶段自然体现回应关系，不能换人、换问题或假装回复了未选择的弹幕。',
        '5. 只有 participants 中的人允许作为出镜参与者说话或行动；未选择的人不得突然进入直播。保持每个人的绑定人设。',
        '6. 私人娱乐直播以主播与参与者说话为主，夹少量环境旁白；工作性质直播可以增加流程、主持、商品或工作细节，但仍然是玩家自己的直播。',
        '7. 弹幕只能知道直播公开画面、玩家已经公开说出的信息和合理可见事实，不得泄露私人剧情或读心。',
        '8. viewerDelta、followerDelta 和礼物规模必须符合玩家身份、初始人数、直播性质和本阶段表现，不要每阶段暴涨。',
        '9. sessionSummary 必须覆盖直播主题、已发生阶段、参与者、玩家公开发言和重要观众反应，控制在 800 字以内，供下一阶段续接。',
        '10. end 模式必须明显收束并告别；start 以外的模式 room 必须为 null。',
        '11. 若玩家资料 isMask=true，直播账号不绑定玩家真实身份。观众和参与者不得凭系统背景自动认出主播；只有直播公开画面、发言或既有公开证据足够时才能猜测，且不得把猜测写成确认。',
        '',
        `本次模式：${mode}`,
        `玩家资料：${JSON.stringify(request.profile ?? {})}`,
        `玩家设定：${String(request.userPersona ?? '').slice(0, 12000) || '未提供'}`,
        `直播设置：${JSON.stringify(request.setup ?? {})}`,
        `本次阶段指令：${JSON.stringify(request.operation ?? {})}`,
        `已选择参与者：${JSON.stringify(request.participants ?? [])}`,
        `当前直播摘要：${String(request.sessionSummary ?? '').slice(0, 800) || '（尚未开始）'}`,
        `最近两个阶段：${JSON.stringify(request.recentPhases ?? [])}`,
        `最近正文背景：${String(request.storyText ?? '').slice(0, 20000) || '（无）'}`,
        `共同故事背景：${sharedContext || '（无额外背景）'}`,
        `当前时间戳：${Number(request.now) || Date.now()}`,
    ].join('\n');
}

export async function generateLiveCompletion(payload, options = {}) {
    const config = normalizeConfig(payload?.barrage, '直播阶段');
    const endpoint = new URL(`${config.baseUrl}/v1/chat/completions`).toString();
    const maxTokens = Math.max(4096, Math.min(12_000, Math.trunc(Number(payload?.maxTokens) || 8192)));
    const response = await postJson(endpoint, {
        model: config.model,
        messages: [
            {
                role: 'system',
                content: '你只维护虚构世界里的阶段式个人直播数据。严格保留玩家原话、参与者边界和公共信息边界。',
            },
            { role: 'user', content: buildLiveUserContent(payload) },
        ],
        max_tokens: maxTokens,
    }, config, { timeoutMs: 180_000, ...options });
    return { content: extractChatContent(response, '直播阶段 API') };
}

export async function generatePhoneWorldCompletion(payload, options = {}) {
    const config = normalizeConfig(payload?.barrage, '手机世界更新');
    const endpoint = new URL(`${config.baseUrl}/v1/chat/completions`).toString();
    const prompt = String(payload?.prompt ?? '').trim();
    if (!prompt) throw new Error('手机世界更新没有收到生成规则。');
    const maxTokens = Math.max(4096, Math.min(32_000, Math.trunc(Number(payload?.maxTokens) || 12_000)));
    const response = await postStreamingChatCompletion(endpoint, {
        model: config.model,
        messages: [
            {
                role: 'system',
                content: '你只维护虚构故事中的手机公共世界和明确出现的线上通讯。严格遵守信息边界，并按要求输出相互独立的 JSONL 记录。',
            },
            { role: 'user', content: prompt },
        ],
        max_tokens: maxTokens,
    }, config, { timeoutMs: 600_000, idleTimeoutMs: 180_000, maxRetries: 1, ...options });
    return { content: extractChatContent(response, '手机世界更新 API') };
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
