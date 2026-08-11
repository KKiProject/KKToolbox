const TAG_NAME_PATTERN = /^[\p{L}_][\p{L}\p{N}_.:-]*$/u;

export function normalizeChatTagName(value) {
    const source = String(value ?? '').trim();
    const wrapped = source.match(/^<\s*\/?\s*([\p{L}_][\p{L}\p{N}_.:-]*)[^>]*>$/u)?.[1];
    const tagName = String(wrapped ?? source).trim();
    if (!TAG_NAME_PATTERN.test(tagName)) {
        throw new Error('请输入一个标签名，例如 status、状态栏或 <status>。');
    }
    return tagName;
}

function readMarkupTokens(text) {
    const source = String(text ?? '');
    const tokens = [];
    for (let start = source.indexOf('<'); start >= 0; start = source.indexOf('<', start + 1)) {
        let quote = '';
        let end = start + 1;
        for (; end < source.length; end++) {
            const character = source[end];
            if (quote) {
                if (character === quote) quote = '';
                continue;
            }
            if (character === '"' || character === "'") {
                quote = character;
                continue;
            }
            if (character === '>') break;
        }
        if (end >= source.length || source[end] !== '>') break;
        const body = source.slice(start + 1, end).trim();
        const match = body.match(/^(\/)?\s*([\p{L}_][\p{L}\p{N}_.:-]*)(?=\s|\/|$)/u);
        if (match) {
            tokens.push({
                start,
                end: end + 1,
                name: match[2],
                closing: Boolean(match[1]),
                selfClosing: !match[1] && /\/\s*$/u.test(body),
            });
        }
        start = end;
    }
    return tokens;
}

function mergeRanges(ranges) {
    const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const range of sorted) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
}

export function removeChatTagBlocks(value, requestedTag) {
    const text = String(value ?? '');
    const tagName = normalizeChatTagName(requestedTag);
    const normalizedTag = tagName.toLocaleLowerCase();
    const stack = [];
    const ranges = [];
    let blocks = 0;
    for (const token of readMarkupTokens(text)) {
        if (token.name.toLocaleLowerCase() !== normalizedTag) continue;
        if (token.selfClosing) {
            ranges.push({ start: token.start, end: token.end });
            blocks++;
        } else if (!token.closing) {
            stack.push(token);
        } else if (stack.length > 0) {
            const opening = stack.pop();
            ranges.push({ start: opening.start, end: token.end });
            blocks++;
        }
    }
    if (ranges.length === 0) return { text, blocks: 0, removedCharacters: 0 };
    const merged = mergeRanges(ranges);
    let cursor = 0;
    let output = '';
    let removedCharacters = 0;
    for (const range of merged) {
        output += text.slice(cursor, range.start);
        removedCharacters += range.end - range.start;
        cursor = range.end;
    }
    output += text.slice(cursor);
    return { text: output, blocks, removedCharacters };
}

function analyzeMessage(message, tagName) {
    const originalMes = String(message?.mes ?? '');
    const originalSwipes = Array.isArray(message?.swipes) ? message.swipes.map(value => String(value ?? '')) : null;
    const swipeResults = originalSwipes?.map(value => removeChatTagBlocks(value, tagName)) ?? null;
    const matchingSwipeIndex = originalSwipes?.findIndex(value => value === originalMes) ?? -1;
    const mesResult = matchingSwipeIndex >= 0
        ? swipeResults[matchingSwipeIndex]
        : removeChatTagBlocks(originalMes, tagName);
    const blocks = mesResult.blocks
        + (swipeResults?.reduce((total, result, index) => (
            index === matchingSwipeIndex ? total : total + result.blocks
        ), 0) ?? 0);
    const removedCharacters = mesResult.removedCharacters
        + (swipeResults?.reduce((total, result, index) => (
            index === matchingSwipeIndex ? total : total + result.removedCharacters
        ), 0) ?? 0);
    const swipesChanged = Boolean(swipeResults?.some((result, index) => result.text !== originalSwipes[index]));
    const changed = mesResult.text !== originalMes || swipesChanged;
    return {
        changed,
        blocks,
        removedCharacters,
        originalMes,
        originalSwipes,
        nextMes: mesResult.text,
        nextSwipes: swipeResults?.map(result => result.text) ?? null,
    };
}

export function analyzeChatTagRemoval(context, requestedTag, options = {}) {
    const tagName = normalizeChatTagName(requestedTag);
    const includeUser = options.includeUser === true;
    const changes = [];
    let blocks = 0;
    let removedCharacters = 0;
    for (const [messageId, message] of (Array.isArray(context?.chat) ? context.chat : []).entries()) {
        if (!includeUser && message?.is_user === true) continue;
        const result = analyzeMessage(message, tagName);
        if (!result.changed) continue;
        changes.push({ messageId, message, ...result });
        blocks += result.blocks;
        removedCharacters += result.removedCharacters;
    }
    return {
        tagName,
        includeUser,
        blocks,
        removedCharacters,
        affectedMessageIds: changes.map(change => change.messageId),
        changes,
    };
}

export async function removeChatTagContent(context, requestedTag, options = {}) {
    if (typeof context?.saveChat !== 'function') {
        throw new Error('当前酒馆没有提供可用的聊天保存接口。');
    }
    const analysis = analyzeChatTagRemoval(context, requestedTag, options);
    if (analysis.changes.length === 0) {
        return { ...analysis, changes: undefined, changed: false };
    }
    for (const change of analysis.changes) {
        change.message.mes = change.nextMes;
        if (change.nextSwipes) change.message.swipes = [...change.nextSwipes];
    }
    try {
        await context.saveChat();
    } catch (error) {
        for (const change of analysis.changes) {
            change.message.mes = change.originalMes;
            if (change.originalSwipes) change.message.swipes = [...change.originalSwipes];
        }
        throw error;
    }
    return {
        tagName: analysis.tagName,
        includeUser: analysis.includeUser,
        blocks: analysis.blocks,
        removedCharacters: analysis.removedCharacters,
        affectedMessageIds: analysis.affectedMessageIds,
        changed: true,
    };
}
