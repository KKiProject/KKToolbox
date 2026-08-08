import { cleanPhoneText as text } from './phone-utils.js';

const PHONE_AI_MESSAGE_TYPES = new Set([
    'text', 'voice', 'image', 'redpacket', 'group_redpacket', 'location', 'sticker',
]);

function parseJsonObject(raw) {
    const source = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try {
        return JSON.parse(source);
    } catch (initialError) {
        const start = source.indexOf('{');
        const end = source.lastIndexOf('}');
        const candidate = start >= 0 && end > start ? source.slice(start, end + 1) : '';
        if (candidate && candidate !== source) {
            try {
                return JSON.parse(candidate);
            } catch (candidateError) {
                throw createPhoneJsonError(candidate, candidateError);
            }
        }
        throw createPhoneJsonError(source, initialError);
    }
}

function createPhoneJsonError(source, cause) {
    const detail = String(cause?.message ?? '').trim();
    const lineMatch = detail.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    const positionMatch = detail.match(/position\s+(\d+)/i);
    let line = Number(lineMatch?.[1]) || 0;
    let column = Number(lineMatch?.[2]) || 0;
    if (!line && positionMatch) {
        const before = source.slice(0, Number(positionMatch[1]));
        const rows = before.split(/\r?\n/);
        line = rows.length;
        column = (rows.at(-1)?.length ?? 0) + 1;
    }
    const lineText = line > 0
        ? String(source.split(/\r?\n/)[line - 1] ?? '').trim().slice(0, 240)
        : '';
    const location = line > 0 ? `第 ${line} 行第 ${column || '?'} 列` : '内容中';
    const excerpt = lineText ? `，该行是 ${JSON.stringify(lineText)}` : '';
    const error = new Error(`手机副 API 返回了损坏的 JSON（${location}${excerpt}）。`);
    error.cause = cause;
    error.rawResponse = source;
    return error;
}

export function parsePhoneAiBundle(raw) {
    const parsed = parseJsonObject(raw);
    if (!Array.isArray(parsed?.messages)) throw new Error('手机副 API 没有返回消息列表。');
    const messages = parsed.messages.slice(0, 8).map(item => ({
        sender: text(item?.sender, 80),
        type: PHONE_AI_MESSAGE_TYPES.has(item?.type) ? item.type : 'text',
        content: text(item?.content, 4000),
        duration: Math.max(1, Math.min(60, Math.trunc(Number(item?.duration) || 1))),
        amount: Math.max(0, Number(item?.amount) || 0),
        recipient: text(item?.recipient, 80),
        count: Math.max(0, Math.trunc(Number(item?.count) || 0)),
        stickerName: text(item?.stickerName ?? item?.sticker, 120),
    }));
    const memoryEvents = (Array.isArray(parsed?.memory?.events) ? parsed.memory.events : [])
        .slice(0, 12)
        .map(item => ({
            type: text(item?.type, 40),
            summary: text(item?.summary, 600),
            participants: Array.isArray(item?.participants)
                ? item.participants.map(value => text(value, 80)).filter(Boolean)
                : [],
            sourceMessageIds: Array.isArray(item?.sourceMessageIds)
                ? item.sourceMessageIds.map(value => text(value, 120)).filter(Boolean)
                : [],
            evidenceQuotes: Array.isArray(item?.evidenceQuotes)
                ? item.evidenceQuotes.map(value => text(value, 500)).filter(Boolean)
                : [],
            status: text(item?.status, 40),
            resolvesEventIds: Array.isArray(item?.resolvesEventIds)
                ? item.resolvesEventIds.map(value => text(value, 120)).filter(Boolean)
                : [],
        }));
    return {
        messages,
        memoryEvents,
        roundSummary: text(parsed?.roundSummary, 1200),
    };
}

export function parsePhoneAiResponse(raw) {
    return parsePhoneAiBundle(raw).messages;
}

export function parsePhoneGroupMembers(raw) {
    return [...new Set(String(raw ?? '')
        .split(/[，,\n]/)
        .map(item => text(item, 80))
        .filter(Boolean))];
}

export async function requestPhoneAiBundle(generatePhone, payload) {
    const response = await generatePhone(payload);
    try {
        return parsePhoneAiBundle(response?.content);
    } catch (error) {
        console.warn('[KKToolbox] 手机副 API 返回的原始内容：', response?.content);
        throw error;
    }
}
