function clone(value) {
    return structuredClone(value);
}

function makeResponse(payload, { status = 200 } = {}) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 404 ? 'Not Found' : 'OK',
        headers: { get: () => null },
        async json() {
            return payload;
        },
        async text() {
            return body;
        },
    };
}

function decodeBase64Utf8(value) {
    return Buffer.from(String(value ?? ''), 'base64').toString('utf8');
}

function vectorFor(text) {
    const source = String(text ?? '');
    return [
        source.length || 1,
        [...source].reduce((sum, character) => sum + character.codePointAt(0), 0) || 1,
        source.includes('world') || source.includes('setting') ? 2 : 1,
    ];
}

export function installNativeFetch({
    chatDocument,
    worldDocument,
    modelIds = ['model-a'],
    rerankScores,
} = {}) {
    const files = new Map();
    const vectors = new Map();
    const requests = [];

    function initialDocument(path) {
        if (path.includes('kktoolbox_chat_') && chatDocument) return clone(chatDocument);
        if (path.includes('kktoolbox_worldinfo_') && worldDocument) return clone(worldDocument);
        return null;
    }

    const fetch = async (url, options = {}) => {
        const address = String(url);
        const path = address.split('?')[0];
        const method = String(options.method ?? 'GET').toUpperCase();
        const body = options.body ? JSON.parse(options.body) : {};
        requests.push({ url: address, method, headers: options.headers ?? {}, body });

        if (method === 'GET' && path.startsWith('/user/files/')) {
            if (!files.has(path)) {
                const initial = initialDocument(path);
                if (initial) files.set(path, initial);
            }
            return files.has(path)
                ? makeResponse(clone(files.get(path)))
                : makeResponse({ error: 'missing' }, { status: 404 });
        }

        if (path === '/api/files/upload') {
            const document = JSON.parse(decodeBase64Utf8(body.data));
            files.set(`/user/files/${body.name}`, document);
            return makeResponse({ path: `/user/files/${body.name}` });
        }

        if (path === '/api/files/delete') {
            const filePath = `/${String(body.path ?? '').replace(/^\/+/, '')}`;
            const existed = files.delete(filePath);
            return makeResponse({}, { status: existed ? 200 : 404 });
        }

        if (path.startsWith('/api/plugins/st-memory-augment')) {
            return makeResponse({ error: 'legacy plugin absent' }, { status: 404 });
        }

        if (/\/v1\/models$/.test(path)) {
            return makeResponse({ data: modelIds.map(id => ({ id })) });
        }

        if (/\/v1\/embeddings$/.test(path)) {
            const input = Array.isArray(body.input) ? body.input : [body.input];
            return makeResponse({
                data: input.map((text, index) => ({ index, embedding: vectorFor(text) })),
            });
        }

        if (/\/v1\/rerank$/.test(path)) {
            const documents = Array.isArray(body.documents) ? body.documents : [];
            const scores = Array.isArray(rerankScores)
                ? rerankScores
                : documents.map((_, index) => 1 - (index * 0.01));
            return makeResponse({
                results: documents
                    .map((_, index) => ({ index, relevance_score: scores[index] ?? 0 }))
                    .slice(0, Number(body.top_n) || documents.length),
            });
        }

        if (/\/v1\/chat\/completions$/.test(path)) {
            return makeResponse({ choices: [{ message: { content: 'mock barrage' } }] });
        }

        if (path === '/api/vector/purge') {
            vectors.delete(String(body.collectionId));
            return makeResponse({});
        }

        if (path === '/api/vector/list') {
            const items = vectors.get(String(body.collectionId)) ?? [];
            return makeResponse(items.map(item => Number(item.hash)));
        }

        if (path === '/api/vector/insert') {
            const collectionId = String(body.collectionId);
            const saved = vectors.get(collectionId) ?? [];
            const byHash = new Map(saved.map(item => [Number(item.hash), item]));
            for (const item of body.items ?? []) byHash.set(Number(item.hash), clone(item));
            vectors.set(collectionId, [...byHash.values()]);
            return makeResponse({});
        }

        if (path === '/api/vector/delete') {
            const collectionId = String(body.collectionId);
            const deleted = new Set((body.hashes ?? []).map(Number));
            vectors.set(
                collectionId,
                (vectors.get(collectionId) ?? []).filter(item => !deleted.has(Number(item.hash))),
            );
            return makeResponse({});
        }

        if (path === '/api/vector/query') {
            const items = (vectors.get(String(body.collectionId)) ?? []).slice(0, Number(body.topK) || 10);
            return makeResponse({
                hashes: items.map(item => Number(item.hash)),
                metadata: items.map(item => clone(item)),
            });
        }

        if (path === '/api/vector/query-multi') {
            const grouped = {};
            let remaining = Number(body.topK) || 10;
            for (const collectionId of body.collectionIds ?? []) {
                const items = (vectors.get(String(collectionId)) ?? []).slice(0, remaining);
                if (items.length > 0) {
                    grouped[collectionId] = {
                        hashes: items.map(item => Number(item.hash)),
                        metadata: items.map(item => clone(item)),
                    };
                    remaining -= items.length;
                }
                if (remaining <= 0) break;
            }
            return makeResponse(grouped);
        }

        throw new Error(`Unexpected URL: ${address}`);
    };

    return { fetch, files, vectors, requests };
}
