'use strict';
/**
 * Stress test for Task 4 ("Validate open risks from plan ... retry
 * heuristics"): exercises keenSolver.js's planNaturalStages/mergeToTargetCount
 * /planClueGroups across a range of grid sizes and requested digit_group_count
 * targets, using synthetically-generated (not WASM-generated) Keen puzzles.
 *
 * Since we have no WASM engine in this sandbox, puzzles are built from a
 * cyclic Latin square (grid[r][c] = (r + c + shift) % w + 1) partitioned into
 * random cages (sizes 1-4, contiguous via random growth from a seed cell),
 * with cage ops derived from the true solution (add/mul for >2 cells,
 * add/sub/mul/div for 2 cells, the digit itself for 1 cell). This mirrors
 * what a real generator produces closely enough to stress the *stage-planning*
 * code (which only cares about {cells, op, value}), even though these
 * particular puzzles are not guaranteed minimal/unique by construction --
 * we explicitly verify full solvability (checkAllCages) before using a
 * generated puzzle, exactly as a real generator would reject an
 * under-constrained grid and retry.
 */

const { solveWithActiveCages, planNaturalStages, mergeToTargetCount, planClueGroups } = require('./keenSolver.js');

// Simple deterministic PRNG (a basic LCG) so failures are reproducible. Not
// mulberry32 -- deliberately avoids bitwise-xor so this text survives being
// pasted through shells that mishandle rare control bytes.
function mulberry32(seed) {
    let state = (seed >>> 0) || 1;
    const a = 1103515245;
    const c = 12345;
    const m = 2147483648; // 2**31
    return function () {
        state = ((Math.imul(state, a) + c) >>> 0) % m;
        return state / m;
    };
}

function buildCyclicSolution(w, shift) {
    const sol = new Array(w * w);
    for (let r = 0; r < w; r++) {
        for (let c = 0; c < w; c++) {
            sol[r * w + c] = ((r + c + shift) % w) + 1;
        }
    }
    return sol;
}

// Partitions all w*w cells into contiguous (edge-adjacent) cages of random
// size 1..maxCageSize via randomized region growth.
function randomCagePartition(w, rng, maxCageSize) {
    const n = w * w;
    const unassigned = new Set();
    for (let i = 0; i < n; i++) unassigned.add(i);
    const neighbors = (cell) => {
        const r = Math.floor(cell / w), c = cell % w;
        const res = [];
        if (r > 0) res.push(cell - w);
        if (r < w - 1) res.push(cell + w);
        if (c > 0) res.push(cell - 1);
        if (c < w - 1) res.push(cell + 1);
        return res;
    };

    const cageGroups = [];
    while (unassigned.size > 0) {
        const arr = [...unassigned];
        const seed = arr[Math.floor(rng() * arr.length)];
        const group = [seed];
        unassigned.delete(seed);
        const targetSize = 1 + Math.floor(rng() * maxCageSize);
        while (group.length < targetSize) {
            // Frontier: unassigned neighbors of any cell currently in group.
            const frontier = new Set();
            for (const cell of group) {
                for (const nb of neighbors(cell)) {
                    if (unassigned.has(nb)) frontier.add(nb);
                }
            }
            if (frontier.size === 0) break;
            const fArr = [...frontier];
            const pick = fArr[Math.floor(rng() * fArr.length)];
            group.push(pick);
            unassigned.delete(pick);
        }
        cageGroups.push(group);
    }
    return cageGroups;
}

function cagesFromPartitionAndSolution(cageGroups, solution, rng) {
    return cageGroups.map((cells) => {
        const values = cells.map((c) => solution[c]);
        if (cells.length === 1) {
            return { cells, op: 'add', value: values[0] };
        }
        if (cells.length === 2) {
            const [a, b] = values;
            const options = ['add', 'mul'];
            if (Math.abs(a - b) !== 0) options.push('sub');
            const hi = Math.max(a, b), lo = Math.min(a, b);
            if (lo !== 0 && hi % lo === 0) options.push('div');
            const op = options[Math.floor(rng() * options.length)];
            let value;
            if (op === 'add') value = a + b;
            else if (op === 'mul') value = a * b;
            else if (op === 'sub') value = Math.abs(a - b);
            else value = Math.max(a, b) / Math.min(a, b);
            return { cells, op, value };
        }
        // 3+ cells: add or mul only (matches base game's own restriction).
        const op = rng() < 0.5 ? 'add' : 'mul';
        const value = op === 'add'
            ? values.reduce((x, y) => x + y, 0)
            : values.reduce((x, y) => x * y, 1);
        return { cells, op, value };
    });
}

// Generates a fully-solvable-by-deduction puzzle at width w, retrying with
// new cage partitions/shifts until solveWithActiveCages (all cages active)
// determines every cell -- exactly the check a real generator must make.
function generateSolvablePuzzle(w, rng, maxCageSize, maxAttempts = 200) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const shift = Math.floor(rng() * w);
        const solution = buildCyclicSolution(w, shift);
        const groups = randomCagePartition(w, rng, maxCageSize);
        const cages = cagesFromPartitionAndSolution(groups, solution, rng);
        let forced;
        try {
            forced = solveWithActiveCages(w, cages, cages.map((_, i) => i), new Map());
        } catch (e) {
            continue; // contradiction (shouldn't happen against a real solution, but be defensive)
        }
        if (forced.size === w * w) {
            return { cages, solution };
        }
    }
    return null;
}

const results = [];
const overallStart = Date.now();

const gridSizes = [3, 4, 5, 6, 7, 8, 9];
const PER_SIZE_TIME_BUDGET_MS = 15000;

for (const w of gridSizes) {
    const rng = mulberry32(1000 + w);
    const maxCageSize = w <= 4 ? 3 : 4;

    const genStart = Date.now();
    const gen = generateSolvablePuzzle(w, rng, maxCageSize);
    const genMs = Date.now() - genStart;

    if (!gen) {
        results.push({ w, ok: false, note: 'could not generate a solvable puzzle within attempt budget' });
        continue;
    }

    const { cages } = gen;

    const t0 = Date.now();
    let natural;
    try {
        natural = planNaturalStages(w, cages, 3);
    } catch (e) {
        results.push({ w, ok: false, note: `planNaturalStages threw: ${e.message}`, genMs, cageCount: cages.length });
        continue;
    }
    const naturalMs = Date.now() - t0;

    // Sanity: stages partition all cages exactly once, and cover the full grid.
    const allCageIdx = new Set();
    let totalForced = 0;
    for (const s of natural) {
        for (const idx of s.cageIndices) {
            if (allCageIdx.has(idx)) throw new Error(`w=${w}: cage ${idx} appears in multiple stages`);
            allCageIdx.add(idx);
        }
        totalForced += s.newlyForced.size;
    }
    if (allCageIdx.size !== cages.length) throw new Error(`w=${w}: stages don't cover all cages (${allCageIdx.size}/${cages.length})`);
    if (totalForced !== w * w) throw new Error(`w=${w}: stages' newlyForced don't cover the grid (${totalForced}/${w * w})`);

    // Targets to try: 1, half natural, exactly natural, natural-1 (merge by
    // one), and one deliberately unreachable target (natural + 5) which must
    // return null (the generator's cue to retry with a different seed/grid).
    const naturalCount = natural.length;
    const targets = new Set([
        1,
        Math.max(1, Math.floor(naturalCount / 2)),
        naturalCount,
        Math.max(1, naturalCount - 1),
    ]);

    const targetResults = [];
    let elapsedTooLong = false;
    for (const target of targets) {
        const tStart = Date.now();
        const merged = mergeToTargetCount(natural, target);
        const tMs = Date.now() - tStart;
        if (Date.now() - overallStart > 0 && tMs > PER_SIZE_TIME_BUDGET_MS) elapsedTooLong = true;

        if (!merged) {
            throw new Error(`w=${w}: mergeToTargetCount(target=${target}) unexpectedly returned null (target <= naturalCount=${naturalCount})`);
        }
        if (merged.length !== target) throw new Error(`w=${w}: merged length ${merged.length} !== target ${target}`);
        const mergedCages = new Set();
        let mergedForced = 0;
        for (const s of merged) {
            for (const idx of s.cageIndices) mergedCages.add(idx);
            mergedForced += s.newlyForced.size;
        }
        if (mergedCages.size !== cages.length) throw new Error(`w=${w} target=${target}: merged stages lost cages`);
        if (mergedForced !== w * w) throw new Error(`w=${w} target=${target}: merged stages lost forced cells`);

        targetResults.push({ target, ms: tMs });
    }

    // Unreachable target: naturalCount + 5 must return null via planClueGroups
    // (going through the full pipeline, not just mergeToTargetCount) --
    // this is exactly the "retry with different seed/larger grid" signal the
    // real caller (keenProgression.resolveKeenPuzzle) turns into a thrown
    // error for the caller to catch and retry on.
    const unreachableTarget = naturalCount + 5;
    const unreachable = planClueGroups(w, cages, unreachableTarget, 3);
    if (unreachable !== null) throw new Error(`w=${w}: expected null for unreachable target ${unreachableTarget}, got ${unreachable.length} stages`);

    results.push({
        w,
        ok: true,
        cageCount: cages.length,
        naturalCount,
        genMs,
        naturalMs,
        targetResults,
        elapsedTooLong,
    });
}

console.log('Stress test results:');
for (const r of results) {
    if (!r.ok) {
        console.log(`  w=${r.w}: FAILED -- ${r.note}`);
    } else {
        console.log(
            `  w=${r.w}: cages=${r.cageCount} naturalStages=${r.naturalCount} ` +
            `genMs=${r.genMs} naturalMs=${r.naturalMs} ` +
            `targets=[${r.targetResults.map(t => `${t.target}:${t.ms}ms`).join(', ')}]` +
            (r.elapsedTooLong ? ' *** SLOW ***' : '')
        );
    }
}

const anyFailed = results.some(r => !r.ok);
const anySlow = results.some(r => r.ok && r.elapsedTooLong);
if (anyFailed) {
    console.error('STRESS TEST: one or more grid sizes could not be generated/planned.');
    process.exitCode = 1;
} else if (anySlow) {
    console.error('STRESS TEST: completed but some sizes exceeded the time budget -- consider tuning maxComboSize/heuristics for larger grids.');
    process.exitCode = 1;
} else {
    console.log(`ALL STRESS TESTS PASSED (total ${Date.now() - overallStart}ms)`);
}
