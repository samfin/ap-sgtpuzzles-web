'use strict';
const assert = require('assert');
const { solveWithActiveCages, planNaturalStages, mergeToTargetCount, planClueGroups } = require('./keenSolver.js');

// 4x4 fixture (see design notes): solution grid
// 1 2 3 4
// 3 4 1 2
// 2 1 4 3
// 4 3 2 1
const w = 4;
const sol = [
    1, 2, 3, 4,
    3, 4, 1, 2,
    2, 1, 4, 3,
    4, 3, 2, 1,
];
const idx = (r, c) => r * w + c;

const cages = [
    { cells: [idx(0, 0)], op: 'add', value: sol[idx(0, 0)] },                         // 0: given, =1
    { cells: [idx(0, 1), idx(0, 2)], op: 'add', value: sol[idx(0, 1)] + sol[idx(0, 2)] }, // 1: sum=5
    { cells: [idx(0, 3), idx(1, 3)], op: 'add', value: sol[idx(0, 3)] + sol[idx(1, 3)] }, // 2: sum=6
    { cells: [idx(1, 0), idx(1, 1)], op: 'add', value: sol[idx(1, 0)] + sol[idx(1, 1)] }, // 3: sum=7
    { cells: [idx(1, 2), idx(2, 2)], op: 'add', value: sol[idx(1, 2)] + sol[idx(2, 2)] }, // 4: sum=5
    { cells: [idx(2, 0), idx(3, 0)], op: 'add', value: sol[idx(2, 0)] + sol[idx(3, 0)] }, // 5: sum=6
    // 6-9 are single-cell givens rather than dominoes: a 2x2 block left with
    // only {1,3} in both remaining rows/columns is a symmetric Latin
    // sub-square (either arrangement satisfies every row/column and every
    // *symmetric* 2-cell cage clue -- add/sub/mul/div all treat the two
    // cells interchangeably), so it can only be broken by something that
    // pins one specific cell, not by another domino.
    { cells: [idx(2, 1)], op: 'add', value: sol[idx(2, 1)] },                          // 6: given, =1
    { cells: [idx(3, 1)], op: 'add', value: sol[idx(3, 1)] },                          // 7: given, =3
    { cells: [idx(2, 3)], op: 'add', value: sol[idx(2, 3)] },                          // 8: given, =3
    { cells: [idx(3, 3)], op: 'add', value: sol[idx(3, 3)] },                          // 9: given, =1
    { cells: [idx(3, 2)], op: 'add', value: sol[idx(3, 2)] },                          // 10: given, =2
];

// sanity: cages partition the grid exactly
{
    const seen = new Set();
    for (const cage of cages) for (const c of cage.cells) {
        assert(!seen.has(c), `cell ${c} covered twice`);
        seen.add(c);
    }
    assert.strictEqual(seen.size, w * w);
}

// 1. A single "given" cage alone forces exactly its own cell.
{
    const forced = solveWithActiveCages(w, cages, [0], new Map());
    assert.strictEqual(forced.get(idx(0, 0)), 1);
    assert.strictEqual(forced.size, 1, 'cage 0 alone should force nothing else');
}

// 2. A single sum-domino cage alone (no givens active) forces nothing --
//    the classic "plateau": {1,4} and {2,3} are both consistent with sum=5
//    until something else narrows it down.
{
    const forced = solveWithActiveCages(w, cages, [1], new Map());
    assert.strictEqual(forced.size, 0, 'lone sum cage should be ambiguous');
}

// 3. Combining cage 0 (gives (0,0)=1) + cage 8 (gives (3,2)=2) + cage 1
//    (sum=5 at (0,1)/(0,2)) should force BOTH cells of cage 1, via a real
//    cross-cage chain: (0,0)=1 removes 1 from row0 candidates at (0,1)/(0,2);
//    (3,2)=2 removes 2 from column2 candidates, hitting (0,2); the only
//    remaining sum-5 split of {2,3,4} without a 1 is {2,3}, and (0,2) can't
//    be 2, so (0,2)=3 and therefore (0,1)=2.
{
    const forced = solveWithActiveCages(w, cages, [0, 1, 10], new Map());
    assert.strictEqual(forced.get(idx(0, 0)), 1);
    assert.strictEqual(forced.get(idx(3, 2)), 2);
    assert.strictEqual(forced.get(idx(0, 2)), 3, 'cross-cage/column deduction should force (0,2)=3');
    assert.strictEqual(forced.get(idx(0, 1)), 2, 'cross-cage/column deduction should force (0,1)=2');
}

// 4. With every cage active, the solver fully solves the grid (no guessing
//    needed for this fixture).
{
    const forced = solveWithActiveCages(w, cages, cages.map((_, i) => i), new Map());
    assert.strictEqual(forced.size, w * w, 'full clue set should fully solve the grid');
    for (let cell = 0; cell < w * w; cell++) {
        assert.strictEqual(forced.get(cell), sol[cell], `cell ${cell} solved incorrectly`);
    }
}

// 5. Natural stage planning: covers every cage exactly once, stages are in
//    non-decreasing... well, non-empty and cumulative, and fully solve the
//    grid by the end. Also demonstrates the plateau is bridged automatically
//    (stage boundaries don't need to be single cages).
{
    const stages = planNaturalStages(w, cages);
    const allCageIdx = new Set();
    const allForced = new Map();
    for (const stage of stages) {
        assert(stage.newlyForced.size > 0, 'every stage must make some progress');
        for (const c of stage.cageIndices) {
            assert(!allCageIdx.has(c), 'cage revealed twice');
            allCageIdx.add(c);
        }
        for (const [cell, value] of stage.newlyForced) allForced.set(cell, value);
    }
    assert.strictEqual(allCageIdx.size, cages.length, 'every cage must appear exactly once');
    assert.strictEqual(allForced.size, w * w, 'stages must together solve the whole grid');
    console.log(`natural stage count: ${stages.length} (cages: ${cages.length})`);
}

// 6. Merging down to a smaller target count.
{
    const stages = planNaturalStages(w, cages);
    const target = Math.max(1, stages.length - 2);
    const merged = mergeToTargetCount(stages, target);
    assert.strictEqual(merged.length, target);
    const allForced = new Map();
    for (const stage of merged) for (const [cell, value] of stage.newlyForced) allForced.set(cell, value);
    assert.strictEqual(allForced.size, w * w);

    // asking for MORE than the natural count should fail (null)
    assert.strictEqual(mergeToTargetCount(stages, stages.length + 5), null);
}

// 7. planClueGroups end-to-end at a reasonable target.
{
    const groups = planClueGroups(w, cages, 3);
    assert(groups, 'expected 3 groups to be achievable for this fixture');
    assert.strictEqual(groups.length, 3);
}

// 8. A puzzle that isn't fully solvable by deduction alone (even with every
//    cage active) must be rejected loudly, not silently return partial
//    coverage -- the generator needs to know to try a different seed/grid.
{
    const underConstrained = [cages[0]]; // just one given cage, nothing else
    assert.throws(
        () => planNaturalStages(w, underConstrained),
        /not fully solvable by non-guessing deduction/,
    );
}

console.log('ALL TESTS PASSED');
