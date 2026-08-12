const STAGE_LABELS = {
    summaryRead: '读取自动总结',
    summarySync: '同步总结向量',
    summarySearch: '召回旧总结',
    summaryRerank: '精排旧总结',
    memorySearch: '召回正文/世界书',
    memoryRerank: '精排正文/世界书',
    localContext: '地图/状态等本地回注',
    phoneLoad: '读取手机存档',
    phoneRecall: '召回手机记忆',
    phoneInject: '回注手机内容',
};

let activeTiming = null;
let latestTiming = null;
let renderTarget = null;
let now = () => globalThis.performance?.now?.() ?? Date.now();
const boundEventSources = new WeakSet();

function currentTime() {
    return Number(now()) || 0;
}

function copyTiming(timing) {
    if (!timing) return null;
    return {
        ...timing,
        stages: { ...timing.stages },
    };
}

function publish() {
    if (!renderTarget) return;
    renderTarget.replaceChildren(...buildTimingNodes(renderTarget.ownerDocument, activeTiming ?? latestTiming));
}

export function beginMainGeneration(type, options = {}, dryRun = false) {
    if (dryRun || type === 'quiet') return null;
    const startedAt = currentTime();
    activeTiming = {
        type: String(type || 'normal'),
        startedAt,
        wallClockStartedAt: Date.now(),
        preparationStartedAt: null,
        preparationEndedAt: null,
        firstTokenAt: null,
        responseEndedAt: null,
        stopped: false,
        stages: {},
    };
    publish();
    return copyTiming(activeTiming);
}

export function beginGenerationPreparation(type = 'normal') {
    if (!activeTiming) beginMainGeneration(type);
    if (!activeTiming || activeTiming.preparationStartedAt !== null) return;
    activeTiming.preparationStartedAt = currentTime();
    publish();
}

export function recordGenerationTimingStage(stage, milliseconds) {
    if (!activeTiming) return;
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return;
    activeTiming.stages[stage] = (activeTiming.stages[stage] ?? 0) + value;
    publish();
}

export function completeGenerationPreparation() {
    if (!activeTiming) return;
    if (activeTiming.preparationStartedAt === null) activeTiming.preparationStartedAt = currentTime();
    activeTiming.preparationEndedAt = currentTime();
    latestTiming = copyTiming(activeTiming);
    publish();
}

export function markFirstGenerationToken() {
    if (!activeTiming || activeTiming.firstTokenAt !== null) return;
    activeTiming.firstTokenAt = currentTime();
    latestTiming = copyTiming(activeTiming);
    publish();
}

export function completeMainGeneration({ stopped = false } = {}) {
    if (!activeTiming) return;
    activeTiming.responseEndedAt = currentTime();
    activeTiming.stopped = Boolean(stopped);
    latestTiming = copyTiming(activeTiming);
    activeTiming = null;
    publish();
}

export function getLatestGenerationTiming() {
    return copyTiming(activeTiming ?? latestTiming);
}

function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds)) return '—';
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 2 : 1)} 秒`;
}

export function describeGenerationTiming(timing) {
    if (!timing) return null;
    const preparation = timing.preparationStartedAt !== null && timing.preparationEndedAt !== null
        ? timing.preparationEndedAt - timing.preparationStartedAt
        : null;
    const beforePlugin = timing.preparationStartedAt !== null
        ? timing.preparationStartedAt - timing.startedAt
        : null;
    const afterPluginToFirst = timing.preparationEndedAt !== null && timing.firstTokenAt !== null
        ? timing.firstTokenAt - timing.preparationEndedAt
        : null;
    const totalToFirst = timing.firstTokenAt !== null
        ? timing.firstTokenAt - timing.startedAt
        : null;
    const totalResponse = timing.responseEndedAt !== null
        ? timing.responseEndedAt - timing.startedAt
        : null;
    const phases = [
        ['酒馆前置处理', beforePlugin],
        ['插件发送前准备', preparation],
        ['插件结束到首字', afterPluginToFirst],
    ].filter(([, value]) => Number.isFinite(value));
    const bottleneck = phases.sort((left, right) => right[1] - left[1])[0] ?? null;
    return {
        preparation,
        beforePlugin,
        afterPluginToFirst,
        totalToFirst,
        totalResponse,
        bottleneck: bottleneck ? { label: bottleneck[0], milliseconds: bottleneck[1] } : null,
        stages: Object.entries(timing.stages)
            .filter(([, value]) => Number.isFinite(value))
            .map(([key, value]) => ({ key, label: STAGE_LABELS[key] ?? key, milliseconds: value })),
    };
}

function createRow(documentRef, label, value, className = '') {
    const row = documentRef.createElement('div');
    if (className) row.className = className;
    const name = documentRef.createElement('span');
    const result = documentRef.createElement('strong');
    name.textContent = label;
    result.textContent = value;
    row.append(name, result);
    return row;
}

function buildTimingNodes(documentRef, timing) {
    if (!timing) {
        const empty = documentRef.createElement('p');
        empty.className = 'memory-augment-timing-empty';
        empty.textContent = '发送一次正文后，这里会显示最近一轮耗时。';
        return [empty];
    }
    const description = describeGenerationTiming(timing);
    const nodes = [];
    const time = new Date(timing.wallClockStartedAt).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const headline = documentRef.createElement('div');
    headline.className = 'memory-augment-timing-headline';
    headline.textContent = activeTiming === timing || timing.responseEndedAt === null
        ? `本轮生成中 · ${time}`
        : `最近一轮 · ${time}${timing.stopped ? ' · 已停止' : ''}`;
    nodes.push(headline);
    nodes.push(createRow(documentRef, '点发送到插件开始', formatDuration(description.beforePlugin)));
    nodes.push(createRow(documentRef, '插件发送前准备', formatDuration(description.preparation)));
    nodes.push(createRow(documentRef, '插件结束到正文首字', formatDuration(description.afterPluginToFirst)));
    nodes.push(createRow(
        documentRef,
        timing.firstTokenAt !== null ? '点发送到正文首字' : '点发送到完整响应',
        formatDuration(timing.firstTokenAt !== null ? description.totalToFirst : description.totalResponse),
        'memory-augment-timing-total',
    ));
    if (description.bottleneck) {
        nodes.push(createRow(
            documentRef,
            '本轮最慢阶段',
            `${description.bottleneck.label} · ${formatDuration(description.bottleneck.milliseconds)}`,
            'memory-augment-timing-bottleneck',
        ));
    }
    if (description.stages.length > 0) {
        const details = documentRef.createElement('details');
        details.className = 'memory-augment-timing-details';
        const summary = documentRef.createElement('summary');
        summary.textContent = '查看插件内部明细';
        const body = documentRef.createElement('div');
        description.stages.forEach(stage => body.append(createRow(documentRef, stage.label, formatDuration(stage.milliseconds))));
        details.append(summary, body);
        nodes.push(details);
    }
    return nodes;
}

export function initializeGenerationTimingUi({ eventSource, eventTypes, documentRef = globalThis.document } = {}) {
    renderTarget = documentRef?.querySelector?.('#memory_augment_generation_timing') ?? null;
    publish();
    if (!eventSource?.on || !eventTypes || boundEventSources.has(eventSource)) return;
    boundEventSources.add(eventSource);
    eventSource.on(eventTypes.GENERATION_STARTED, beginMainGeneration);
    eventSource.on(eventTypes.STREAM_TOKEN_RECEIVED, markFirstGenerationToken);
    eventSource.on(eventTypes.GENERATION_ENDED, () => completeMainGeneration());
    eventSource.on(eventTypes.GENERATION_STOPPED, () => completeMainGeneration({ stopped: true }));
}

export function setGenerationTimingClockForTests(clock) {
    now = typeof clock === 'function' ? clock : (() => globalThis.performance?.now?.() ?? Date.now());
    activeTiming = null;
    latestTiming = null;
    renderTarget = null;
}
