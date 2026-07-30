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

function buildBarrageUserContent(recentMessages, ragFragments) {
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
    return [
        '【前情回顾】（仅供理解上下文，不要单独评论）',
        recap || '（无）',
        '',
        '【相关记忆】（仅供前后呼应参考，不要单独评论）',
        memories || '（无）',
        '',
        '---',
        '',
        '【最新章节】（这是你要评论的内容）',
        latest.text,
    ].join('\n');
}

function extractChatContent(payload) {
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
        const text = content.map(part => part?.text ?? '').join('').trim();
        if (text) return text;
    }
    throw new Error('弹幕 API 没有返回有效正文。');
}

export async function generateBarrageCompletion(payload, options = {}) {
    const config = normalizeConfig(payload?.barrage, 'Barrage');
    const endpoint = new URL(`${config.baseUrl}/v1/chat/completions`).toString();
    const systemPrompt = String(payload?.systemPrompt ?? '').trim();
    const userContent = buildBarrageUserContent(payload?.recentMessages, payload?.ragFragments);
    const maxTokens = Math.max(1, Math.min(128_000, Math.trunc(Number(payload?.maxTokens) || 4064)));
    const response = await postJson(endpoint, {
        model: config.model,
        messages: [
            ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
            { role: 'user', content: userContent },
        ],
        max_tokens: maxTokens,
    }, config, options);
    return { content: extractChatContent(response) };
}

export { buildBarrageUserContent, MAX_EMBEDDING_BATCH_SIZE };
