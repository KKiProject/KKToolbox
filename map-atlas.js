import { normalizeBaseUrl } from './api-utils.js';
import { generateMapAtlas } from './rag-client.js';
import { getLatestStoryStatus } from './story-status.js';
import { loadAssociatedWorldInfoBooks } from './world-info-manager.js';

const MAP_MARKER = 'memory_augment_map_atlas';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
let mapUi = null;

function cleanText(value, maximum = 2000) {
    return String(value ?? '').trim().slice(0, maximum);
}

function cleanId(value, fallback) {
    const normalized = String(value ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return (normalized || fallback).slice(0, 80);
}

function uniqueId(base, used) {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    used.add(candidate);
    return candidate;
}

function extractJsonObject(content) {
    const raw = cleanText(content, 2_000_000);
    const candidates = [raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')];
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
    for (const candidate of [...new Set(candidates)]) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {
            // Try the next representation.
        }
    }
    throw new Error('副 API 返回的地图册不是有效 JSON。');
}

function makeDefaultPositions(nodes) {
    const count = nodes.length;
    if (count === 0) return;
    if (count === 1) {
        nodes[0].x = 500;
        nodes[0].y = 325;
        return;
    }
    const radiusX = count <= 8 ? 300 : 370;
    const radiusY = count <= 8 ? 220 : 255;
    nodes.forEach((node, index) => {
        if (Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y))) {
            node.x = Math.max(70, Math.min(930, Number(node.x)));
            node.y = Math.max(45, Math.min(605, Number(node.y)));
            return;
        }
        const angle = (Math.PI * 2 * index / count) - Math.PI / 2;
        const ring = count > 16 && index % 2 ? 0.68 : 1;
        node.x = Math.round(500 + Math.cos(angle) * radiusX * ring);
        node.y = Math.round(325 + Math.sin(angle) * radiusY * ring);
    });
}

export function normalizeMapAtlas(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('地图册数据为空。');
    }
    const rawPages = (Array.isArray(value.pages) ? value.pages : []).slice(0, 100);
    if (rawPages.length === 0) throw new Error('没有从世界书中整理出任何地图页面。');

    const pageIds = new Set();
    const pageIdMap = new Map();
    const pages = rawPages.map((rawPage, pageIndex) => {
        const originalId = cleanId(rawPage?.id, `page-${pageIndex + 1}`);
        const id = uniqueId(originalId, pageIds);
        if (!pageIdMap.has(originalId)) pageIdMap.set(originalId, id);
        const usedNodeIds = new Set();
        const nodeIdMap = new Map();
        const nodes = (Array.isArray(rawPage?.nodes) ? rawPage.nodes : []).slice(0, 200)
            .map((rawNode, nodeIndex) => {
                const name = cleanText(rawNode?.name, 160);
                if (!name) return null;
                const originalNodeId = cleanId(rawNode?.id, `node-${nodeIndex + 1}`);
                const nodeId = uniqueId(originalNodeId, usedNodeIds);
                if (!nodeIdMap.has(originalNodeId)) nodeIdMap.set(originalNodeId, nodeId);
                return {
                    id: nodeId,
                    name,
                    type: cleanText(rawNode?.type, 80) || '地点',
                    note: cleanText(rawNode?.note, 1500),
                    childPageId: cleanId(rawNode?.childPageId, ''),
                    x: Number(rawNode?.x),
                    y: Number(rawNode?.y),
                };
            })
            .filter(Boolean);
        makeDefaultPositions(nodes);
        const edges = (Array.isArray(rawPage?.edges) ? rawPage.edges : []).slice(0, 400)
            .map((rawEdge, edgeIndex) => {
                const from = nodeIdMap.get(cleanId(rawEdge?.from, ''));
                const to = nodeIdMap.get(cleanId(rawEdge?.to, ''));
                if (!from || !to || from === to) return null;
                return {
                    id: `edge-${edgeIndex + 1}-${from}-${to}`,
                    from,
                    to,
                    label: cleanText(rawEdge?.label, 160),
                };
            })
            .filter(Boolean);
        return {
            id,
            name: cleanText(rawPage?.name, 160) || `地图 ${pageIndex + 1}`,
            note: cleanText(rawPage?.note, 1500),
            nodes,
            edges,
        };
    });

    for (const page of pages) {
        for (const node of page.nodes) {
            node.childPageId = pageIdMap.get(node.childPageId) ?? '';
        }
    }
    const requestedRoot = pageIdMap.get(cleanId(value.rootPageId, ''));
    return {
        version: 1,
        title: cleanText(value.title, 160) || '世界地图册',
        rootPageId: requestedRoot ?? pages[0].id,
        pages,
        sourceBooks: Array.isArray(value.sourceBooks) ? value.sourceBooks.map(item => cleanText(item, 160)).filter(Boolean) : [],
        updatedAt: Number(value.updatedAt) || Date.now(),
        manuallyEdited: value.manuallyEdited === true,
    };
}

export function parseMapAtlasResponse(content) {
    return normalizeMapAtlas(extractJsonObject(content));
}

export function getMapOwnerKey(context = {}) {
    const groupId = cleanText(context?.groupId ?? context?.group_id, 200);
    if (groupId) return `group:${groupId}`;
    const character = context?.characters?.[context?.characterId];
    const identity = cleanText(character?.avatar ?? character?.name ?? context?.characterId, 300);
    return identity ? `character:${identity}` : `chat:${cleanText(context?.getCurrentChatId?.() ?? context?.chatId, 300) || 'unknown'}`;
}

function ensureMapSettings(settings) {
    settings.map ??= {};
    settings.map.atlases ??= {};
    settings.map.sourceEntryKeysByOwner ??= {};
    return settings.map;
}

export function isMapEntryCandidate(entry) {
    return /地图/i.test(String(entry?.name ?? ''));
}

export function selectMapSourceBooks(books, selectedKeys) {
    const selected = selectedKeys instanceof Set ? selectedKeys : new Set(Array.isArray(selectedKeys) ? selectedKeys.map(String) : []);
    return (Array.isArray(books) ? books : [])
        .map(book => ({
            ...book,
            entries: (Array.isArray(book?.entries) ? book.entries : []).filter(entry => selected.has(String(entry?.key ?? ''))),
        }))
        .filter(book => book.entries.length > 0);
}

function getMapSourceEntryKeys(settings, context) {
    const mapSettings = ensureMapSettings(settings);
    const ownerKey = getMapOwnerKey(context);
    const keys = mapSettings.sourceEntryKeysByOwner[ownerKey];
    return new Set(Array.isArray(keys) ? keys.map(String) : []);
}

function saveMapSourceEntryKeys(settings, context, keys) {
    ensureMapSettings(settings).sourceEntryKeysByOwner[getMapOwnerKey(context)] = [...keys].map(String).sort();
    context.saveSettingsDebounced?.();
}

function initializeMapSourceEntryKeys(settings, context, books, forceAuto = false) {
    const mapSettings = ensureMapSettings(settings);
    const ownerKey = getMapOwnerKey(context);
    if (!forceAuto && Object.hasOwn(mapSettings.sourceEntryKeysByOwner, ownerKey)) {
        return getMapSourceEntryKeys(settings, context);
    }
    const automatic = new Set((Array.isArray(books) ? books : [])
        .flatMap(book => Array.isArray(book?.entries) ? book.entries : [])
        .filter(isMapEntryCandidate)
        .map(entry => String(entry.key)));
    saveMapSourceEntryKeys(settings, context, automatic);
    return automatic;
}

export function getMapAtlas(settings, context) {
    const atlas = ensureMapSettings(settings).atlases[getMapOwnerKey(context)];
    if (!atlas) return null;
    try {
        return normalizeMapAtlas(atlas);
    } catch {
        return null;
    }
}

function saveMapAtlas(settings, context, atlas) {
    ensureMapSettings(settings).atlases[getMapOwnerKey(context)] = atlas;
    context.saveSettingsDebounced?.();
}

function completeSideApi(settings) {
    const config = {
        baseUrl: normalizeBaseUrl(settings?.apis?.barrage?.url),
        apiKey: cleanText(settings?.apis?.barrage?.apiKey, 1000),
        model: cleanText(settings?.apis?.barrage?.model, 500),
    };
    return config.baseUrl && config.apiKey && config.model ? config : null;
}

function showNotice(message, type = 'info') {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message, 'KKToolbox');
    else console[type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'info'](`[KKToolbox] ${message}`);
}

function findCurrentNode(atlas, location) {
    const query = cleanText(location, 1000).toLocaleLowerCase();
    if (!query) return null;
    const segments = query.split(/[>→/｜|,，、]/).map(item => item.trim()).filter(item => item.length >= 2);
    let best = null;
    for (const page of atlas.pages) {
        for (const node of page.nodes) {
            const name = node.name.toLocaleLowerCase();
            const note = node.note.toLocaleLowerCase();
            let score = query.includes(name) ? 100 + name.length : 0;
            for (const segment of segments) {
                if (segment === name) score = Math.max(score, 200 + segment.length);
                else if (segment.includes(name) || name.includes(segment)) score = Math.max(score, 80 + Math.min(segment.length, name.length));
                else if (note.includes(segment)) score = Math.max(score, 20 + segment.length);
            }
            if (score > (best?.score ?? 0)) best = { page, node, score };
        }
    }
    return best?.score > 0 ? best : null;
}

export function buildRelevantMapText(atlas, location = '') {
    const normalized = normalizeMapAtlas(atlas);
    const current = findCurrentNode(normalized, location);
    const page = current?.page ?? normalized.pages.find(item => item.id === normalized.rootPageId) ?? normalized.pages[0];
    const lines = ['【地点关系参考】', `地图页：${page.name}${page.note ? `｜${page.note}` : ''}`];
    if (current) {
        lines.push(`当前地点：${current.node.name}${current.node.note ? `｜${current.node.note}` : ''}`);
        const connected = page.edges.filter(edge => edge.from === current.node.id || edge.to === current.node.id)
            .map((edge) => {
                const otherId = edge.from === current.node.id ? edge.to : edge.from;
                const other = page.nodes.find(node => node.id === otherId);
                return other ? `${other.name}${edge.label ? `（${edge.label}）` : ''}` : '';
            })
            .filter(Boolean)
            .slice(0, 30);
        if (connected.length > 0) lines.push(`直接相连：${connected.join('、')}`);
        const child = normalized.pages.find(item => item.id === current.node.childPageId);
        if (child) {
            const facilities = child.nodes.slice(0, 40).map(node => `${node.name}${node.note ? `（${node.note}）` : ''}`);
            if (facilities.length > 0) lines.push(`内部地点与设施：${facilities.join('、')}`);
        }
    } else {
        const overview = page.nodes.slice(0, 40).map(node => `${node.name}${node.note ? `（${node.note}）` : ''}`);
        if (overview.length > 0) lines.push(`主要地点：${overview.join('、')}`);
    }
    lines.push('以上是玩家确认过的地图册信息，可用于选择合理地点和发展剧情；不得凭空改变地点之间的关系。');
    return lines.join('\n');
}

export function injectMapAtlasContext(chat, settings, context) {
    if (!Array.isArray(chat) || settings?.map?.includeInPrompt === false
        || chat.some(message => message?.extra?.[MAP_MARKER])) return false;
    const atlas = getMapAtlas(settings, context);
    if (!atlas) return false;
    const location = getLatestStoryStatus(context)?.status?.environment?.location ?? '';
    const content = buildRelevantMapText(atlas, location);
    const message = {
        role: 'system', content, mes: content, name: 'KKToolbox Map Atlas',
        is_user: false, is_system: false,
        extra: { type: 'narrator', [MAP_MARKER]: true },
    };
    let insertionIndex = chat.length;
    for (let index = chat.length - 1; index >= 0; index--) {
        if (chat[index]?.is_user || chat[index]?.role === 'user') {
            insertionIndex = index;
            break;
        }
    }
    chat.splice(insertionIndex, 0, message);
    return true;
}

function svgElement(name, attributes = {}) {
    const element = document.createElementNS(SVG_NAMESPACE, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
}

function markManualEdit(state) {
    state.atlas.manuallyEdited = true;
    state.atlas.updatedAt = Date.now();
    saveMapAtlas(state.settings, state.context, state.atlas);
}

function currentPage(state) {
    return state.atlas?.pages.find(page => page.id === state.pageId) ?? state.atlas?.pages[0] ?? null;
}

function renderNodeDetails(state) {
    const detail = document.querySelector('#memory_augment_map_detail');
    if (!detail) return;
    detail.replaceChildren();
    const page = currentPage(state);
    if (!page) return;
    const node = page.nodes.find(item => item.id === state.selectedNodeId);

    if (!state.editing) {
        if (!node) {
            const text = document.createElement('p');
            text.textContent = page.note || '点击地点查看备注。';
            detail.append(text);
            return;
        }
        const heading = document.createElement('h4');
        heading.textContent = `${node.name} · ${node.type}`;
        const note = document.createElement('p');
        note.textContent = node.note || '暂无备注。';
        detail.append(heading, note);
        const child = state.atlas.pages.find(item => item.id === node.childPageId);
        if (child) {
            const enter = document.createElement('button');
            enter.type = 'button';
            enter.className = 'menu_button';
            enter.textContent = `进入 ${child.name}`;
            enter.addEventListener('click', () => {
                state.pageId = child.id;
                state.selectedNodeId = '';
                renderMap(state);
            });
            detail.append(enter);
        }
        return;
    }

    const pageEditor = document.createElement('div');
    pageEditor.className = 'memory-augment-map-editor-grid';
    const pageName = document.createElement('input');
    pageName.className = 'text_pole';
    pageName.value = page.name;
    pageName.placeholder = '地图页名称';
    const pageNote = document.createElement('textarea');
    pageNote.className = 'text_pole';
    pageNote.rows = 2;
    pageNote.value = page.note;
    pageNote.placeholder = '地图页备注';
    const savePage = document.createElement('button');
    savePage.type = 'button';
    savePage.className = 'menu_button';
    savePage.textContent = '保存页面说明';
    savePage.addEventListener('click', () => {
        page.name = cleanText(pageName.value, 160) || page.name;
        page.note = cleanText(pageNote.value, 1500);
        markManualEdit(state);
        renderMap(state);
    });
    pageEditor.append(pageName, pageNote, savePage);
    detail.append(pageEditor);
    if (!node) {
        const hint = document.createElement('p');
        hint.textContent = '点击一个地点后可修改它；也可以使用上方按钮添加地点。';
        detail.append(hint);
        return;
    }

    const separator = document.createElement('hr');
    const editor = document.createElement('div');
    editor.className = 'memory-augment-map-editor-grid';
    const name = document.createElement('input');
    name.className = 'text_pole';
    name.value = node.name;
    name.placeholder = '地点名称';
    const type = document.createElement('input');
    type.className = 'text_pole';
    type.value = node.type;
    type.placeholder = '地点类型';
    const note = document.createElement('textarea');
    note.className = 'text_pole';
    note.rows = 3;
    note.value = node.note;
    note.placeholder = '备注与别称';
    const child = document.createElement('select');
    child.className = 'text_pole';
    child.append(new Option('不连接子地图', ''));
    for (const candidate of state.atlas.pages.filter(item => item.id !== page.id)) {
        child.append(new Option(candidate.name, candidate.id));
    }
    child.value = node.childPageId;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'menu_button';
    save.textContent = '保存地点';
    save.addEventListener('click', () => {
        node.name = cleanText(name.value, 160) || node.name;
        node.type = cleanText(type.value, 80) || '地点';
        node.note = cleanText(note.value, 1500);
        node.childPageId = child.value;
        markManualEdit(state);
        renderMap(state);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'menu_button';
    remove.textContent = '删除地点';
    remove.addEventListener('click', async () => {
        if (!await state.confirm('删除这个地点？', `将删除“${node.name}”及其连接线，子地图本身不会删除。`)) return;
        page.nodes = page.nodes.filter(item => item.id !== node.id);
        page.edges = page.edges.filter(edge => edge.from !== node.id && edge.to !== node.id);
        state.selectedNodeId = '';
        markManualEdit(state);
        renderMap(state);
    });
    editor.append(name, type, note, child, save, remove);

    const connectionTitle = document.createElement('strong');
    connectionTitle.textContent = '连接线';
    const connectionEditor = document.createElement('div');
    connectionEditor.className = 'memory-augment-map-connection-editor';
    const target = document.createElement('select');
    target.className = 'text_pole';
    target.append(new Option('选择另一个地点', ''));
    for (const candidate of page.nodes.filter(item => item.id !== node.id)) target.append(new Option(candidate.name, candidate.id));
    const edgeLabel = document.createElement('input');
    edgeLabel.className = 'text_pole';
    edgeLabel.placeholder = '连接说明，可留空';
    const addEdge = document.createElement('button');
    addEdge.type = 'button';
    addEdge.className = 'menu_button';
    addEdge.textContent = '添加连接';
    addEdge.addEventListener('click', () => {
        if (!target.value || page.edges.some(edge => (edge.from === node.id && edge.to === target.value)
            || (edge.to === node.id && edge.from === target.value))) return;
        page.edges.push({
            id: `edge-manual-${Date.now().toString(36)}`,
            from: node.id,
            to: target.value,
            label: cleanText(edgeLabel.value, 160),
        });
        markManualEdit(state);
        renderMap(state);
    });
    connectionEditor.append(target, edgeLabel, addEdge);
    const edgeList = document.createElement('div');
    edgeList.className = 'memory-augment-map-edge-list';
    for (const edge of page.edges.filter(item => item.from === node.id || item.to === node.id)) {
        const otherId = edge.from === node.id ? edge.to : edge.from;
        const other = page.nodes.find(item => item.id === otherId);
        if (!other) continue;
        const row = document.createElement('div');
        const text = document.createElement('span');
        text.textContent = `${other.name}${edge.label ? ` · ${edge.label}` : ''}`;
        const deleteEdge = document.createElement('button');
        deleteEdge.type = 'button';
        deleteEdge.className = 'menu_button';
        deleteEdge.textContent = '删除连接';
        deleteEdge.addEventListener('click', () => {
            page.edges = page.edges.filter(item => item.id !== edge.id);
            markManualEdit(state);
            renderMap(state);
        });
        row.append(text, deleteEdge);
        edgeList.append(row);
    }
    detail.append(separator, editor, connectionTitle, connectionEditor, edgeList);
}

function bindNodeDrag(group, node, state) {
    let suppressClick = false;
    group.addEventListener('pointerdown', (event) => {
        if (!state.editing || event.button !== 0) return;
        const svg = group.ownerSVGElement;
        const rectangle = svg.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const originalX = node.x;
        const originalY = node.y;
        let moved = false;
        const move = (moveEvent) => {
            const deltaX = moveEvent.clientX - startX;
            const deltaY = moveEvent.clientY - startY;
            if (!moved && Math.abs(deltaX) + Math.abs(deltaY) <= 5) return;
            moved = true;
            suppressClick = true;
            node.x = Math.max(70, Math.min(930, originalX + deltaX / rectangle.width * 1000));
            node.y = Math.max(45, Math.min(605, originalY + deltaY / rectangle.height * 650));
            group.setAttribute('transform', `translate(${node.x} ${node.y})`);
            renderEdgesOnly(state);
            moveEvent.preventDefault();
        };
        const finish = () => {
            globalThis.removeEventListener('pointermove', move);
            globalThis.removeEventListener('pointerup', finish);
            if (moved) {
                markManualEdit(state);
                renderMap(state);
            }
        };
        globalThis.addEventListener('pointermove', move);
        globalThis.addEventListener('pointerup', finish, { once: true });
    });
    return () => {
        const blocked = suppressClick;
        suppressClick = false;
        return blocked;
    };
}

function renderEdgesOnly(state) {
    const page = currentPage(state);
    const layer = document.querySelector('#memory_augment_map_edges');
    if (!page || !layer) return;
    layer.replaceChildren();
    for (const edge of page.edges) {
        const from = page.nodes.find(node => node.id === edge.from);
        const to = page.nodes.find(node => node.id === edge.to);
        if (!from || !to) continue;
        const line = svgElement('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'memory-augment-map-edge' });
        layer.append(line);
        if (edge.label) {
            const label = svgElement('text', {
                x: (from.x + to.x) / 2,
                y: (from.y + to.y) / 2 - 6,
                class: 'memory-augment-map-edge-label',
                'text-anchor': 'middle',
            });
            label.textContent = edge.label;
            layer.append(label);
        }
    }
}

function renderGraph(state) {
    const svg = document.querySelector('#memory_augment_map_svg');
    const page = currentPage(state);
    if (!svg || !page) return;
    svg.replaceChildren();
    const edgeLayer = svgElement('g', { id: 'memory_augment_map_edges' });
    const nodeLayer = svgElement('g', { id: 'memory_augment_map_nodes' });
    svg.append(edgeLayer, nodeLayer);
    renderEdgesOnly(state);
    const location = getLatestStoryStatus(state.context)?.status?.environment?.location ?? '';
    const current = findCurrentNode(state.atlas, location);
    for (const node of page.nodes) {
        const group = svgElement('g', {
            transform: `translate(${node.x} ${node.y})`,
            class: `memory-augment-map-node${node.id === state.selectedNodeId ? ' is-selected' : ''}${current?.page.id === page.id && current.node.id === node.id ? ' is-current' : ''}`,
            tabindex: 0,
            role: 'button',
            'aria-label': node.name,
        });
        const rect = svgElement('rect', { x: -70, y: -25, width: 140, height: 50, rx: 14 });
        const name = svgElement('text', { x: 0, y: 5, 'text-anchor': 'middle' });
        name.textContent = node.name.length > 12 ? `${node.name.slice(0, 11)}…` : node.name;
        group.append(rect, name);
        if (node.childPageId) {
            const marker = svgElement('text', { x: 58, y: -11, class: 'memory-augment-map-child-marker', 'text-anchor': 'middle' });
            marker.textContent = '↗';
            group.append(marker);
        }
        const wasDragged = bindNodeDrag(group, node, state);
        group.addEventListener('click', () => {
            if (wasDragged()) return;
            state.selectedNodeId = node.id;
            renderMap(state);
        });
        group.addEventListener('dblclick', () => {
            if (!node.childPageId) return;
            state.pageId = node.childPageId;
            state.selectedNodeId = '';
            renderMap(state);
        });
        group.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                state.selectedNodeId = node.id;
                renderMap(state);
            }
        });
        nodeLayer.append(group);
    }
}

function renderMap(state) {
    const empty = document.querySelector('#memory_augment_map_empty');
    const body = document.querySelector('#memory_augment_map_body');
    const generator = document.querySelector('#memory_augment_map_generator');
    const select = document.querySelector('#memory_augment_map_page_select');
    const editorActions = document.querySelector('#memory_augment_map_editor_actions');
    const editButton = document.querySelector('#memory_augment_map_edit');
    const parentButton = document.querySelector('#memory_augment_map_parent');
    if (!empty || !body || !generator || !select) return;
    state.context = globalThis.SillyTavern?.getContext?.() ?? state.context;
    state.atlas = getMapAtlas(state.settings, state.context);
    generator.hidden = !state.generatorOpen;
    if (state.generatorOpen) {
        empty.hidden = true;
        body.hidden = true;
        renderMapSourceSelector(state);
        return;
    }
    if (!state.atlas) {
        empty.hidden = false;
        body.hidden = true;
        const text = empty.querySelector('p');
        if (text) text.textContent = '当前角色还没有地图册。';
        return;
    }
    if (!state.atlas.pages.some(page => page.id === state.pageId)) state.pageId = state.atlas.rootPageId;
    empty.hidden = true;
    body.hidden = false;
    select.replaceChildren();
    for (const page of state.atlas.pages) select.append(new Option(page.name, page.id));
    select.value = state.pageId;
    if (parentButton) {
        parentButton.hidden = !state.atlas.pages.some(candidate => candidate.nodes.some(node => node.childPageId === state.pageId));
    }
    editorActions.hidden = !state.editing;
    editButton.textContent = state.editing ? '完成编辑' : '编辑地图';
    renderGraph(state);
    renderNodeDetails(state);
}

function buildMapUi(state) {
    const root = document.querySelector('#memory_augment_story_map_view');
    if (!root || root.dataset.ready === 'true') return;
    root.dataset.ready = 'true';
    root.innerHTML = `
        <div class="memory-augment-map-toolbar">
            <button type="button" class="menu_button" id="memory_augment_map_parent" aria-label="返回上级地图" title="返回上级地图">↑</button>
            <button type="button" class="menu_button" id="memory_augment_map_previous" aria-label="上一张地图">‹</button>
            <select class="text_pole" id="memory_augment_map_page_select" aria-label="地图页面"></select>
            <button type="button" class="menu_button" id="memory_augment_map_next" aria-label="下一张地图">›</button>
            <button type="button" class="menu_button" id="memory_augment_map_edit">编辑地图</button>
            <button type="button" class="menu_button" id="memory_augment_map_manage">制作地图册</button>
        </div>
        <div id="memory_augment_map_editor_actions" class="memory-augment-map-editor-actions" hidden>
            <button type="button" class="menu_button" id="memory_augment_map_add_page">新增地图页</button>
            <button type="button" class="menu_button" id="memory_augment_map_delete_page">删除当前页</button>
            <button type="button" class="menu_button" id="memory_augment_map_add_node">添加地点</button>
        </div>
        <section id="memory_augment_map_generator" class="memory-augment-map-generator" hidden>
            <div class="memory-augment-map-generator-header">
                <strong>从世界书制作地图册</strong>
                <button type="button" class="menu_button" id="memory_augment_map_generator_close">返回地图</button>
            </div>
            <p>只会把你勾选的条目发给副 API，重新生成会替换当前地图册。</p>
            <div class="memory-augment-map-source-selector">
                <div class="memory-augment-map-source-header">
                    <strong>地图来源条目</strong>
                    <span id="memory_augment_map_floating_source_status">正在读取…</span>
                </div>
                <input id="memory_augment_map_floating_source_search" class="text_pole" type="search" placeholder="搜索世界书或条目标题">
                <div id="memory_augment_map_floating_source_entries" class="memory-augment-map-source-entries">正在读取当前角色关联的世界书…</div>
                <button id="memory_augment_map_floating_auto_select" type="button" class="menu_button" title="自动勾选标题含“地图”的条目">自动选择地图条目</button>
            </div>
            <div id="memory_augment_map_floating_status" class="memory-augment-model-status"></div>
            <button id="memory_augment_map_floating_generate" type="button" class="menu_button">从已选条目生成地图册</button>
        </section>
        <div id="memory_augment_map_empty">
            <p>当前角色还没有地图册。</p>
            <button type="button" class="menu_button" id="memory_augment_map_empty_generate">现在制作地图册</button>
        </div>
        <div id="memory_augment_map_body" hidden>
            <div class="memory-augment-map-canvas"><svg id="memory_augment_map_svg" viewBox="0 0 1000 650" aria-label="地点关系图"></svg></div>
            <div id="memory_augment_map_detail"></div>
        </div>`;

    const select = root.querySelector('#memory_augment_map_page_select');
    select.addEventListener('change', () => {
        state.pageId = select.value;
        state.selectedNodeId = '';
        renderMap(state);
    });
    const changePage = (direction) => {
        if (!state.atlas) return;
        const index = state.atlas.pages.findIndex(page => page.id === state.pageId);
        state.pageId = state.atlas.pages[(index + direction + state.atlas.pages.length) % state.atlas.pages.length].id;
        state.selectedNodeId = '';
        renderMap(state);
    };
    root.querySelector('#memory_augment_map_previous').addEventListener('click', () => changePage(-1));
    root.querySelector('#memory_augment_map_next').addEventListener('click', () => changePage(1));
    root.querySelector('#memory_augment_map_parent').addEventListener('click', () => {
        const parent = state.atlas?.pages.find(candidate => candidate.nodes.some(node => node.childPageId === state.pageId));
        if (!parent) return;
        state.pageId = parent.id;
        state.selectedNodeId = '';
        renderMap(state);
    });
    root.querySelector('#memory_augment_map_edit').addEventListener('click', () => {
        state.editing = !state.editing;
        renderMap(state);
    });
    const setGeneratorOpen = (open) => {
        state.generatorOpen = open;
        if (open) void refreshMapSourceSelector(state);
        renderMap(state);
    };
    root.querySelector('#memory_augment_map_manage').addEventListener('click', () => setGeneratorOpen(true));
    root.querySelector('#memory_augment_map_empty_generate').addEventListener('click', () => setGeneratorOpen(true));
    root.querySelector('#memory_augment_map_generator_close').addEventListener('click', () => setGeneratorOpen(false));
    root.querySelector('#memory_augment_map_add_page').addEventListener('click', () => {
        const used = new Set(state.atlas.pages.map(page => page.id));
        const id = uniqueId(`manual-page-${Date.now().toString(36)}`, used);
        state.atlas.pages.push({ id, name: '新地图页', note: '', nodes: [], edges: [] });
        state.pageId = id;
        state.selectedNodeId = '';
        markManualEdit(state);
        renderMap(state);
    });
    root.querySelector('#memory_augment_map_delete_page').addEventListener('click', async () => {
        if (state.atlas.pages.length <= 1) {
            showNotice('地图册至少需要保留一张页面。', 'warning');
            return;
        }
        const page = currentPage(state);
        if (!await state.confirm('删除当前地图页？', `将删除“${page.name}”及其中地点。`)) return;
        state.atlas.pages = state.atlas.pages.filter(item => item.id !== page.id);
        for (const remaining of state.atlas.pages) {
            for (const node of remaining.nodes) if (node.childPageId === page.id) node.childPageId = '';
        }
        if (state.atlas.rootPageId === page.id) state.atlas.rootPageId = state.atlas.pages[0].id;
        state.pageId = state.atlas.rootPageId;
        state.selectedNodeId = '';
        markManualEdit(state);
        renderMap(state);
    });
    root.querySelector('#memory_augment_map_add_node').addEventListener('click', () => {
        const page = currentPage(state);
        const used = new Set(page.nodes.map(node => node.id));
        const id = uniqueId(`manual-node-${Date.now().toString(36)}`, used);
        page.nodes.push({ id, name: '新地点', type: '地点', note: '', childPageId: '', x: 500, y: 325 });
        state.selectedNodeId = id;
        markManualEdit(state);
        renderMap(state);
    });
    document.addEventListener('memory-augment-map-opened', () => renderMap(state));
}

function renderMapSourceSelector(state) {
    const surfaces = [
        {
            container: document.querySelector('#memory_augment_map_source_entries'),
            status: document.querySelector('#memory_augment_map_source_status'),
            search: document.querySelector('#memory_augment_map_source_search'),
        },
        {
            container: document.querySelector('#memory_augment_map_floating_source_entries'),
            status: document.querySelector('#memory_augment_map_floating_source_status'),
            search: document.querySelector('#memory_augment_map_floating_source_search'),
        },
    ];
    for (const surface of surfaces) {
        if (!surface.container) continue;
        if (surface.search && surface.search !== document.activeElement) surface.search.value = state.sourceSearch;
        renderMapSourceSelectorInto(state, surface.container, surface.status);
    }
}

function renderMapSourceSelectorInto(state, container, status) {
    container.replaceChildren();
    const books = Array.isArray(state.sourceBooks) ? state.sourceBooks : [];
    const selected = getMapSourceEntryKeys(state.settings, state.context);
    const query = cleanText(state.sourceSearch, 500).toLocaleLowerCase();
    const total = books.reduce((sum, book) => sum + (Array.isArray(book.entries) ? book.entries.length : 0), 0);
    const availableKeys = new Set(books.flatMap(book => (Array.isArray(book.entries) ? book.entries : []).map(entry => String(entry.key))));
    const selectedCount = [...selected].filter(key => availableKeys.has(key)).length;
    if (status) status.textContent = `已选择 ${selectedCount} / ${total} 条`;

    if (books.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'memory-augment-map-source-empty';
        empty.textContent = '当前角色没有关联的可用世界书条目。';
        container.append(empty);
        return;
    }

    let visibleCount = 0;
    for (const book of books) {
        const entries = (Array.isArray(book.entries) ? book.entries : []).filter((entry) => {
            if (!query) return true;
            return `${book.name} ${entry.name} ${entry.entryKey}`.toLocaleLowerCase().includes(query);
        });
        if (entries.length === 0) continue;
        visibleCount += entries.length;
        const details = document.createElement('details');
        details.className = 'memory-augment-map-source-book';
        details.open = Boolean(query);
        const summary = document.createElement('summary');
        const bookCheckbox = document.createElement('input');
        bookCheckbox.type = 'checkbox';
        const bookSelectedCount = entries.filter(entry => selected.has(String(entry.key))).length;
        bookCheckbox.checked = bookSelectedCount === entries.length;
        bookCheckbox.indeterminate = bookSelectedCount > 0 && bookSelectedCount < entries.length;
        bookCheckbox.title = '勾选或取消当前显示的全部条目';
        bookCheckbox.addEventListener('click', event => event.stopPropagation());
        bookCheckbox.addEventListener('change', () => {
            const next = getMapSourceEntryKeys(state.settings, state.context);
            for (const entry of entries) {
                if (bookCheckbox.checked) next.add(String(entry.key));
                else next.delete(String(entry.key));
            }
            saveMapSourceEntryKeys(state.settings, state.context, next);
            renderMapSourceSelector(state);
        });
        const title = document.createElement('strong');
        title.textContent = book.name;
        const count = document.createElement('span');
        count.textContent = `${bookSelectedCount}/${entries.length}`;
        summary.append(bookCheckbox, title, count);
        details.append(summary);

        const list = document.createElement('div');
        list.className = 'memory-augment-map-source-entry-list';
        for (const entry of entries) {
            const label = document.createElement('label');
            label.className = 'checkbox_label memory-augment-map-source-entry';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(String(entry.key));
            checkbox.addEventListener('change', () => {
                const next = getMapSourceEntryKeys(state.settings, state.context);
                if (checkbox.checked) next.add(String(entry.key));
                else next.delete(String(entry.key));
                saveMapSourceEntryKeys(state.settings, state.context, next);
                renderMapSourceSelector(state);
            });
            const name = document.createElement('span');
            name.textContent = entry.name || entry.entryKey || `条目 ${entry.uid}`;
            if (isMapEntryCandidate(entry)) name.title = '标题含“地图”，首次读取时会自动勾选';
            label.append(checkbox, name);
            list.append(label);
        }
        details.append(list);
        container.append(details);
    }

    if (visibleCount === 0) {
        const empty = document.createElement('p');
        empty.className = 'memory-augment-map-source-empty';
        empty.textContent = '没有符合搜索条件的条目。';
        container.append(empty);
    }
}

async function refreshMapSourceSelector(state, { forceAuto = false } = {}) {
    const containers = [
        document.querySelector('#memory_augment_map_source_entries'),
        document.querySelector('#memory_augment_map_floating_source_entries'),
    ].filter(Boolean);
    const statuses = [
        document.querySelector('#memory_augment_map_source_status'),
        document.querySelector('#memory_augment_map_floating_source_status'),
    ].filter(Boolean);
    containers.forEach(container => container.textContent = '正在读取当前角色关联的世界书…');
    statuses.forEach(status => status.textContent = '正在读取…');
    state.context = globalThis.SillyTavern?.getContext?.() ?? state.context;
    const ownerKey = getMapOwnerKey(state.context);
    try {
        const books = await loadAssociatedWorldInfoBooks(null, state.context);
        const latestContext = globalThis.SillyTavern?.getContext?.() ?? state.context;
        if (getMapOwnerKey(latestContext) !== ownerKey) return refreshMapSourceSelector(state, { forceAuto: false });
        state.sourceBooks = books;
        initializeMapSourceEntryKeys(state.settings, state.context, books, forceAuto);
        renderMapSourceSelector(state);
    } catch (error) {
        state.sourceBooks = [];
        containers.forEach(container => container.textContent = `世界书条目读取失败：${error.message}`);
        statuses.forEach(status => status.textContent = '读取失败');
        console.error('[KKToolbox] Failed to load map source entries.', error);
    }
}

async function generateAtlasFromWorldInfo(state) {
    const books = await loadAssociatedWorldInfoBooks(null, state.context);
    state.sourceBooks = books;
    const selected = initializeMapSourceEntryKeys(state.settings, state.context, books);
    const usableBooks = selectMapSourceBooks(books, selected);
    renderMapSourceSelector(state);
    if (usableBooks.length === 0) throw new Error('请先勾选至少一个地图来源条目。');
    const api = completeSideApi(state.settings);
    if (!api) throw new Error('请先填写完整的副 API 地址、Key 和模型。');
    const response = await generateMapAtlas({
        barrage: api,
        maxTokens: state.settings?.map?.maxTokens,
        books: usableBooks,
    });
    const atlas = parseMapAtlasResponse(response?.content);
    atlas.sourceBooks = usableBooks.map(book => book.name);
    atlas.updatedAt = Date.now();
    saveMapAtlas(state.settings, state.context, atlas);
    state.atlas = atlas;
    state.pageId = atlas.rootPageId;
    state.selectedNodeId = '';
    state.generatorOpen = false;
    renderMap(state);
    return atlas;
}

export function initializeMapAtlasUi(settings, context, options = {}) {
    ensureMapSettings(settings);
    const state = mapUi ??= {
        settings,
        context,
        atlas: null,
        pageId: '',
        selectedNodeId: '',
        editing: false,
        generatorOpen: false,
        sourceBooks: [],
        sourceSearch: '',
        confirm: options.confirm ?? (async (_title, message) => globalThis.confirm?.(message) ?? false),
    };
    state.settings = settings;
    state.context = context;
    buildMapUi(state);
    renderMap(state);

    const updateStatus = () => {
        const atlas = getMapAtlas(settings, globalThis.SillyTavern?.getContext?.() ?? context);
        const text = atlas
            ? `${atlas.title} · ${atlas.pages.length} 张地图 · ${atlas.pages.reduce((sum, page) => sum + page.nodes.length, 0)} 个地点`
            : '当前角色尚未生成地图册。';
        for (const status of [
            document.querySelector('#memory_augment_map_settings_status'),
            document.querySelector('#memory_augment_map_floating_status'),
        ]) {
            if (status) status.textContent = text;
        }
    };
    updateStatus();
    refreshMapSourceSelector(state);

    for (const searchId of ['#memory_augment_map_source_search', '#memory_augment_map_floating_source_search']) {
        document.querySelector(searchId)?.addEventListener('input', (event) => {
            state.sourceSearch = event.currentTarget.value;
            renderMapSourceSelector(state);
        });
    }
    for (const autoSelectId of ['#memory_augment_map_auto_select', '#memory_augment_map_floating_auto_select']) {
        document.querySelector(autoSelectId)?.addEventListener('click', async () => {
            await refreshMapSourceSelector(state, { forceAuto: true });
            showNotice('已自动勾选标题含“地图”的条目。', 'success');
        });
    }

    const generateFromSelection = async (event) => {
        const currentContext = globalThis.SillyTavern?.getContext?.() ?? context;
        state.context = currentContext;
        const existing = getMapAtlas(settings, currentContext);
        if (existing && !await state.confirm('重新生成地图册？', '新地图会替换当前角色现有地图，包括手动修改。')) return;
        const button = event.currentTarget;
        button.disabled = true;
        button.classList.add('disabled');
        for (const status of [
            document.querySelector('#memory_augment_map_settings_status'),
            document.querySelector('#memory_augment_map_floating_status'),
        ]) {
            if (status) status.textContent = '正在读取世界书并生成地图册…';
        }
        try {
            const atlas = await generateAtlasFromWorldInfo(state);
            showNotice(`已生成 ${atlas.pages.length} 张地图。`, 'success');
        } catch (error) {
            showNotice(`地图册生成失败：${error.message}`, 'error');
            console.error('[KKToolbox] Map atlas generation failed.', error);
        } finally {
            button.disabled = false;
            button.classList.remove('disabled');
            updateStatus();
        }
    };
    document.querySelector('#memory_augment_generate_map')?.addEventListener('click', generateFromSelection);
    document.querySelector('#memory_augment_map_floating_generate')?.addEventListener('click', generateFromSelection);
    document.querySelector('#memory_augment_open_map')?.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('memory-augment-open-story-view', { detail: { view: 'map' } }));
    });
    document.querySelector('#memory_augment_clear_map')?.addEventListener('click', async () => {
        const currentContext = globalThis.SillyTavern?.getContext?.() ?? context;
        const atlas = getMapAtlas(settings, currentContext);
        if (!atlas || !await state.confirm('清空当前角色地图册？', '地图页面、地点、连接和手动修改都会被删除。')) return;
        delete ensureMapSettings(settings).atlases[getMapOwnerKey(currentContext)];
        currentContext.saveSettingsDebounced?.();
        state.atlas = null;
        state.pageId = '';
        state.selectedNodeId = '';
        renderMap(state);
        updateStatus();
    });

    const chatChanged = context.eventTypes?.CHAT_CHANGED ?? context.event_types?.CHAT_CHANGED;
    if (chatChanged) context.eventSource.on(chatChanged, () => setTimeout(() => {
        state.context = globalThis.SillyTavern?.getContext?.() ?? context;
        state.pageId = '';
        state.selectedNodeId = '';
        renderMap(state);
        updateStatus();
        refreshMapSourceSelector(state);
    }, 0));
}

export { MAP_MARKER };
