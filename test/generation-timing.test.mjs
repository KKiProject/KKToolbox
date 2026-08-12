import assert from 'node:assert/strict';
import test from 'node:test';
import {
    beginGenerationPreparation,
    beginMainGeneration,
    completeGenerationPreparation,
    completeMainGeneration,
    describeGenerationTiming,
    getLatestGenerationTiming,
    markFirstGenerationToken,
    recordGenerationTimingStage,
    setGenerationTimingClockForTests,
} from '../generation-timing.js';

test('records preparation, first-token wait, detailed stages, and total response time', () => {
    let time = 0;
    setGenerationTimingClockForTests(() => time);
    beginMainGeneration('normal');
    time = 100;
    beginGenerationPreparation();
    recordGenerationTimingStage('summaryRead', 20);
    recordGenerationTimingStage('summaryRead', 5);
    recordGenerationTimingStage('memorySearch', 180);
    time = 500;
    completeGenerationPreparation();
    time = 2500;
    markFirstGenerationToken();
    time = 4000;
    completeMainGeneration();

    const timing = getLatestGenerationTiming();
    const description = describeGenerationTiming(timing);
    assert.equal(description.beforePlugin, 100);
    assert.equal(description.preparation, 400);
    assert.equal(description.afterPluginToFirst, 2000);
    assert.equal(description.totalToFirst, 2500);
    assert.equal(description.totalResponse, 4000);
    assert.equal(description.bottleneck.label, '插件结束到首字');
    assert.deepEqual(timing.stages, { summaryRead: 25, memorySearch: 180 });
});

test('ignores quiet generations and supports non-streaming completion', () => {
    let time = 10;
    setGenerationTimingClockForTests(() => time);
    beginMainGeneration('quiet');
    assert.equal(getLatestGenerationTiming(), null);

    beginMainGeneration('regenerate');
    time = 20;
    beginGenerationPreparation();
    time = 30;
    completeGenerationPreparation();
    time = 90;
    completeMainGeneration();
    const description = describeGenerationTiming(getLatestGenerationTiming());
    assert.equal(description.totalToFirst, null);
    assert.equal(description.totalResponse, 80);
});
