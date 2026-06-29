'use strict';

const http = require('node:http');

function vectorFor(text) {
    const value = String(text).toLowerCase();
    if (value.includes('observatory') || value.includes('night-sky research')) return [1, 0, 0, 0];
    if (value.includes('phoenix') || value.includes('reborn fire bird')) return [0, 1, 0, 0];
    if (value.includes('harbor') || value.includes('ships')) return [0, 0, 1, 0];
    return [0, 0, 0, 1];
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch (error) {
                reject(error);
            }
        });
        request.on('error', reject);
    });
}

function send(response, status, payload) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
    try {
        const body = await readJson(request);
        if (request.url === '/v1/embeddings') {
            const input = Array.isArray(body.input) ? body.input : [body.input];
            return send(response, 200, {
                object: 'list',
                data: input.map((text, index) => ({ index, embedding: vectorFor(text) })),
            });
        }
        if (request.url === '/v1/rerank') {
            const queryVector = vectorFor(body.query);
            const results = (body.documents ?? []).map((document, index) => {
                const vector = vectorFor(document);
                const relevance_score = vector.reduce((sum, value, dimension) => sum + value * queryVector[dimension], 0);
                return { index, relevance_score };
            }).sort((left, right) => right.relevance_score - left.relevance_score)
                .slice(0, body.top_n ?? 5);
            return send(response, 200, { results });
        }
        if (request.url === '/v1/chat/completions') {
            return send(response, 200, {
                choices: [{ message: { role: 'assistant', content: '观众：这段剧情和前面的伏笔对上了！' } }],
            });
        }
        return send(response, 404, { error: { message: 'Not found' } });
    } catch (error) {
        return send(response, 400, { error: { message: error.message } });
    }
});

server.listen(19090, '127.0.0.1');
process.on('SIGTERM', () => server.close());
