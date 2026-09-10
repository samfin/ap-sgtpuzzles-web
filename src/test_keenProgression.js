'use strict';
const assert = require('assert');
const { encodeKeenDescriptorRef } = require('./keenDescriptor.js');
const {
    resolveKeenPuzzle, activeCageIndicesForCount, buildStagePuzzleIdForCount, newlyCompletedStages,
} = require('./keenProgression.js');

// Same 4x4 fixture as the other test files.
const w = 4;
const sol = [
    1, 2, 3, 4,
    3, 4, 1, 2,
    2, 1, 4, 3,
    4, 3, 2, 1,
];
const idx = (r, c) => r * w + c;
const cages = [
    { cells: [idx(0, 0)], op: 'add', value: sol[idx(0, 0)] },
    { cells: [idx(0, 1), idx(0, 2)], op: 'add', value: sol[idx(0, 1)] + sol[idx(0, 2)] },
    { cells: [idx(0, 3), idx(1, 3)], op: 'add', value: sol[idx(0, 3)] + sol[idx(1, 3)] },
    { cells: [idx(1, 0), idx(1, 1)], op: 'add', value: sol[idx(1, 0)] + sol[idx(1, 1)] },
    { cells: [idx(1, 2), idx(2, 2)], op: 'add', value: sol[idx(1, 2)] + sol[idx(2, 2)] },
    { cells: [idx(2, 0), idx(3, 0)], op: 'add', value: sol[idx(2, 0)] + sol[idx(3, 0)] },
    { cells: [idx(2, 1)], op: 'add', value: sol[idx(2, 1)] },
    { cells: [idx(3, 1)], op: 'add', value: sol[idx(3, 1)] },
    { cells: [idx(2, 3)], op: 'add', value: sol[idx(2, 3)] },
    { cells: [idx(3, 3)], op: 'add', value: sol[idx(3, 3)] },
    { cells: [idx(3, 2)], op: 'add', value: sol[idx(3, 2)] },
];

const paramsStr = '4de';
const fullDescriptor = encodeKeenDescriptorRef(w, cages);

// 1. resolveKeenPuzzle produces the right solution and the requested number
//    of stages.
let resolved;
{
    resolved = resolveKeenPuzzle(paramsStr, fullDescriptor, 3);
    assert.strictEqual(resolved.w, 4);
    assert.deepStrictEqual(resolved.solution, sol);
    assert.strictEqual(resolved.stages.length, 3);
}

// 2. activeCageIndicesForCount is cumulative and monotonic; 0 items means
//    nothing visible, and by the last stage everything is visible.
{
    const active0 = activeCageIndicesForCount(resolved.stages, 0);
    assert.strictEqual(active0.size, 0);

    const active1 = activeCageIndicesForCount(resolved.stages, 1);
    const active2 = activeCageIndicesForCount(resolved.stages, 2);
    const active3 = activeCageIndicesForCount(resolved.stages, 3);

    for (const c of active1) assert(active2.has(c), 'stage sets must be cumulative');
    for (const c of active2) assert(active3.has(c), 'stage sets must be cumulative');
    assert.strictEqual(active3.size, cages.length, 'all cages visible once every stage is unlocked');

    // asking for more than available clamps rather than erroring
    const activeOver = activeCageIndicesForCount(resolved.stages, 99);
    assert.strictEqual(activeOver.size, cages.length);
}

// 3. buildStagePuzzleIdForCount produces a "<params>:<desc>" string whose
//    descriptor matches the fully-masked/unmasked expectations.
{
    const idAt0 = buildStagePuzzleIdForCount(paramsStr, resolved, 0);
    assert(idAt0.startsWith(`${paramsStr}:`));
    const descAt0 = idAt0.slice(paramsStr.length + 1);
    assert(descAt0.startsWith(resolved.blockPart), 'block structure part must be preserved verbatim');
    const clueSection = descAt0.slice(resolved.blockPart.length);
    assert.strictEqual(clueSection.length, cages.length, 'one clue token (masked to a single "n") per cage');
    assert(/^n+$/.test(clueSection), 'with 0 items, every clue must be masked');

    const idAtFull = buildStagePuzzleIdForCount(paramsStr, resolved, resolved.stages.length);
    assert.strictEqual(idAtFull, `${paramsStr}:${fullDescriptor}`, 'fully unlocked puzzle id must equal the original');
}

// 4. newlyCompletedStages: filling in exactly one stage's target cells
//    (and nothing else) reports only that stage, and only once it's
//    actually reachable via clueSetCount; already-checked stages are
//    skipped even if their cells are filled correctly.
{
    const grid = new Array(w * w).fill(0);
    // Fill in stage 0's target cells only.
    for (const [cell, value] of resolved.stages[0].newlyForced) grid[cell] = value;

    // Not reachable yet (0 items received) -> nothing reported.
    assert.deepStrictEqual(newlyCompletedStages(resolved, grid, 0, new Set()), []);

    // Reachable (1 item received) -> stage 0 reported.
    assert.deepStrictEqual(newlyCompletedStages(resolved, grid, 1, new Set()), [0]);

    // Already checked -> not reported again.
    assert.deepStrictEqual(newlyCompletedStages(resolved, grid, 1, new Set([0])), []);

    // Partially filling stage 1's cells (missing one) must not complete it.
    const stage1Entries = [...resolved.stages[1].newlyForced.entries()];
    for (let i = 0; i < stage1Entries.length - 1; i++) {
        grid[stage1Entries[i][0]] = stage1Entries[i][1];
    }
    assert.deepStrictEqual(newlyCompletedStages(resolved, grid, 2, new Set([0])), [], 'partial stage must not complete');

    // Fill in the last cell too -> now it completes.
    const [lastCell, lastValue] = stage1Entries[stage1Entries.length - 1];
    grid[lastCell] = lastValue;
    assert.deepStrictEqual(newlyCompletedStages(resolved, grid, 2, new Set([0])), [1]);

    // A wrong digit in a target cell must not count as complete.
    const wrongGrid = grid.slice();
    wrongGrid[lastCell] = (lastValue % w) + 1; // some other digit
    assert.deepStrictEqual(newlyCompletedStages(resolved, wrongGrid, 2, new Set([0])), []);
}

// 5. An impossible target group count is rejected loudly (mirrors
//    planClueGroups returning null).
{
    assert.throws(() => resolveKeenPuzzle(paramsStr, fullDescriptor, 999), /Could not plan/);
}

console.log('ALL TESTS PASSED');
