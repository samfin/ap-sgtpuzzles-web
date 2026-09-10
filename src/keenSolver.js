/**
 * keenSolver.js
 *
 * A from-scratch, non-guessing constraint solver for Keen (KenKen-style)
 * puzzles, plus a greedy "clue grouping" search that orders a puzzle's
 * cages into stages -- each stage's cages, once active, make a new set of
 * cells logically forced.
 *
 * This does NOT try to replicate Simon Tatham's own keen.c solver -- it's
 * an independent implementation of standard constraint-propagation
 * techniques (Latin-square elimination + hidden singles, and cage-level
 * arc consistency via candidate-combination enumeration), iterated to a
 * fixed point. No branching/backtracking/guessing is ever performed.
 *
 * Puzzle model used throughout:
 *   w      - grid is w x w
 *   cages  - array of { cells: [cellIndex, ...], op: 'add'|'sub'|'mul'|'div', value: number }
 *            cellIndex = row * w + col. sub/div cages must have exactly 2 cells
 *            (matches the base game's own rule that only dominoes get sub/div clues).
 *            A 1-cell cage is a "given": op is irrelevant, value is the digit itself.
 *   solution - (tests/generation only) array of w*w digits, the intended answer.
 */

'use strict';

// ---------------------------------------------------------------------
// Core constraint propagation
// ---------------------------------------------------------------------

/**
 * @param {number} w
 * @returns {Set<number>[]} one full {1..w} candidate set per cell
 */
function fullCandidates(w) {
    const all = [];
    for (let i = 1; i <= w; i++) all.push(i);
    const cells = new Array(w * w);
    for (let i = 0; i < w * w; i++) cells[i] = new Set(all);
    return cells;
}

function rowOf(cell, w) { return Math.floor(cell / w); }
function colOf(cell, w) { return cell % w; }

/**
 * Removes `value` from the candidate sets of every cell sharing a row or
 * column with `cell` (the standard Latin-square "naked single" propagation).
 * Returns true if anything changed.
 */
function eliminateFromPeers(candidates, w, cell, value) {
    let changed = false;
    const r = rowOf(cell, w), c = colOf(cell, w);
    for (let i = 0; i < w * w; i++) {
        if (i === cell) continue;
        if (rowOf(i, w) !== r && colOf(i, w) !== c) continue;
        if (candidates[i].has(value)) {
            candidates[i].delete(value);
            changed = true;
        }
    }
    return changed;
}

/**
 * Hidden singles: within each row and each column, if a digit's candidate
 * appears in exactly one cell, that cell must hold it.
 * Returns true if anything changed (a candidate set was collapsed).
 */
function applyHiddenSingles(candidates, w) {
    let changed = false;

    const scanLine = (cellsInLine) => {
        for (let v = 1; v <= w; v++) {
            let where = -1, count = 0;
            for (const cell of cellsInLine) {
                if (candidates[cell].has(v)) { count++; where = cell; }
            }
            if (count === 1 && candidates[where].size > 1) {
                candidates[where] = new Set([v]);
                changed = true;
            }
        }
    };

    for (let r = 0; r < w; r++) {
        const line = [];
        for (let c = 0; c < w; c++) line.push(r * w + c);
        scanLine(line);
    }
    for (let c = 0; c < w; c++) {
        const line = [];
        for (let r = 0; r < w; r++) line.push(r * w + c);
        scanLine(line);
    }
    return changed;
}

/**
 * For every cell whose candidate set has collapsed to a single value,
 * eliminate that value from its row/column peers. Iterates until no more
 * eliminations happen. Returns true if anything changed.
 */
function propagateNakedSingles(candidates, w) {
    let changedAny = false;
    let changed = true;
    while (changed) {
        changed = false;
        for (let cell = 0; cell < w * w; cell++) {
            if (candidates[cell].size === 1) {
                const value = [...candidates[cell]][0];
                if (eliminateFromPeers(candidates, w, cell, value)) {
                    changed = true;
                    changedAny = true;
                }
            }
        }
    }
    return changedAny;
}

/**
 * Evaluates a cage's operation over an assignment of values (in cell order).
 */
function cageValueMatches(op, values, target) {
    if (values.length === 1) return values[0] === target;
    if (op === 'add') return values.reduce((a, b) => a + b, 0) === target;
    if (op === 'mul') return values.reduce((a, b) => a * b, 1) === target;
    if (op === 'sub') {
        if (values.length !== 2) return false;
        return Math.abs(values[0] - values[1]) === target;
    }
    if (op === 'div') {
        if (values.length !== 2) return false;
        const [a, b] = values;
        const hi = Math.max(a, b), lo = Math.min(a, b);
        return lo !== 0 && hi % lo === 0 && hi / lo === target;
    }
    throw new Error(`Unknown cage op: ${op}`);
}

/**
 * Cage-level arc consistency: enumerates every assignment of candidate
 * values to a cage's cells that (a) satisfies the cage's arithmetic,
 * (b) respects each cell's current candidate set, and (c) gives different
 * values to any two cage cells that share a row or column (a real
 * constraint, since Latin-square peers must differ). Every cell's
 * candidate set is then intersected with the values it actually took
 * across *some* valid assignment. Returns true if any candidate set
 * shrank; throws if the cage has *no* valid assignment (contradiction --
 * should never happen against a real generated puzzle+solution).
 */
function propagateCage(candidates, w, cage) {
    const cells = cage.cells;
    const n = cells.length;
    const domains = cells.map((c) => [...candidates[c]].sort((a, b) => a - b));

    const possibleAtPosition = domains.map(() => new Set());
    let found = false;

    const sameLine = [];
    for (let i = 0; i < n; i++) {
        sameLine.push([]);
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            if (rowOf(cells[i], w) === rowOf(cells[j], w) || colOf(cells[i], w) === colOf(cells[j], w)) {
                sameLine[i].push(j);
            }
        }
    }

    const assignment = new Array(n);
    const recurse = (pos) => {
        if (pos === n) {
            if (!cageValueMatches(cage.op, assignment, cage.value)) return;
            found = true;
            for (let i = 0; i < n; i++) possibleAtPosition[i].add(assignment[i]);
            return;
        }
        for (const v of domains[pos]) {
            let ok = true;
            for (const j of sameLine[pos]) {
                if (j < pos && assignment[j] === v) { ok = false; break; }
            }
            if (!ok) continue;
            assignment[pos] = v;
            recurse(pos + 1);
        }
    };
    recurse(0);

    if (!found) {
        throw new Error('Cage has no valid assignment -- puzzle/solution mismatch or contradiction.');
    }

    let changed = false;
    for (let i = 0; i < n; i++) {
        const before = candidates[cells[i]].size;
        candidates[cells[i]] = new Set([...candidates[cells[i]]].filter((v) => possibleAtPosition[i].has(v)));
        if (candidates[cells[i]].size !== before) changed = true;
    }
    return changed;
}

/**
 * Runs propagation (naked singles, hidden singles, and cage consistency
 * for every cage in `activeCages`) to a fixed point.
 *
 * @param {number} w
 * @param {{cells:number[],op:string,value:number}[]} allCages
 * @param {number[]} activeCageIndices - indices into allCages currently "revealed"
 * @param {Map<number,number>} knownDigits - cellIndex -> value, already-known cells
 *        (e.g. forced by earlier stages) to seed the candidates with.
 * @returns {Map<number,number>} every cell forced to a single value, including
 *          the ones passed in via knownDigits.
 */
function solveWithActiveCages(w, allCages, activeCageIndices, knownDigits) {
    const candidates = fullCandidates(w);
    for (const [cell, value] of knownDigits) {
        candidates[cell] = new Set([value]);
    }
    // Seed peer elimination for pre-known cells before the main loop.
    propagateNakedSingles(candidates, w);

    let changed = true;
    while (changed) {
        changed = false;
        if (propagateNakedSingles(candidates, w)) changed = true;
        if (applyHiddenSingles(candidates, w)) changed = true;
        for (const idx of activeCageIndices) {
            if (propagateCage(candidates, w, allCages[idx])) changed = true;
        }
    }

    const result = new Map();
    for (let cell = 0; cell < w * w; cell++) {
        if (candidates[cell].size === 1) {
            result.set(cell, [...candidates[cell]][0]);
        }
    }
    return result;
}

module.exports = {
    solveWithActiveCages,
};

// ---------------------------------------------------------------------
// Clue grouping: order a puzzle's cages into progression stages.
// ---------------------------------------------------------------------

/**
 * Finds the smallest combination (by combo size, then by fewest newly
 * forced cells) of not-yet-active cages that, when added, forces at least
 * one new cell. Escalates combo size from 1 up to maxComboSize; if nothing
 * up to that size makes progress, falls back to activating everything
 * remaining at once (this always makes progress against a puzzle that is
 * fully solvable by these techniques with all clues present).
 *
 * @returns {{cageIndices:number[], newlyForced: Map<number,number>}}
 */
function findMinimalAddition(w, allCages, activeSet, remaining, known, maxComboSize) {
    const remainingArr = [...remaining];

    const combos = (arr, k) => {
        const result = [];
        const combo = [];
        const rec = (start) => {
            if (combo.length === k) { result.push([...combo]); return; }
            for (let i = start; i < arr.length; i++) {
                combo.push(arr[i]);
                rec(i + 1);
                combo.pop();
            }
        };
        rec(0);
        return result;
    };

    for (let k = 1; k <= Math.min(maxComboSize, remainingArr.length); k++) {
        let best = null;
        for (const combo of combos(remainingArr, k)) {
            const activeIndices = [...activeSet, ...combo];
            const forced = solveWithActiveCages(w, allCages, activeIndices, known);
            const newlyForced = new Map();
            for (const [cell, value] of forced) {
                if (!known.has(cell)) newlyForced.set(cell, value);
            }
            if (newlyForced.size > 0) {
                if (!best || newlyForced.size < best.newlyForced.size) {
                    best = { cageIndices: combo, newlyForced };
                }
            }
        }
        if (best) return best;
    }

    // Fallback: activate everything remaining at once.
    const activeIndices = [...activeSet, ...remainingArr];
    const forced = solveWithActiveCages(w, allCages, activeIndices, known);
    const newlyForced = new Map();
    for (const [cell, value] of forced) {
        if (!known.has(cell)) newlyForced.set(cell, value);
    }
    return { cageIndices: remainingArr, newlyForced };
}

/**
 * Builds the finest-grained (natural) ordering of a puzzle's cages into
 * stages, greedily picking the smallest addition that makes progress at
 * each step. This is the "maximize the length of the progression" search.
 *
 * @param {number} w
 * @param {{cells:number[],op:string,value:number}[]} cages
 * @param {number} [maxComboSize=3] - how large a combination to search
 *        before falling back to "activate everything remaining".
 * @returns {{cageIndices:number[], newlyForced: Map<number,number>}[]} stages,
 *          in reveal order. Concatenating all stages' cageIndices covers
 *          every cage exactly once, and all stages' newlyForced maps
 *          together cover the whole grid (the puzzle is fully solved once
 *          every stage is active) -- assuming the puzzle is solvable by
 *          these techniques at all.
 */
function planNaturalStages(w, cages, maxComboSize = 3) {
    let active = new Set();
    let remaining = new Set(cages.map((_, i) => i));
    let known = new Map();
    const stages = [];

    while (remaining.size > 0) {
        const found = findMinimalAddition(w, cages, active, remaining, known, maxComboSize);
        for (const idx of found.cageIndices) {
            active.add(idx);
            remaining.delete(idx);
        }
        for (const [cell, value] of found.newlyForced) known.set(cell, value);

        if (found.newlyForced.size === 0) {
            // These cages turned out to be logically redundant given
            // everything already known (their information was already
            // implied). Don't give them their own empty stage -- fold them
            // into the previous one so every stage still represents real
            // progress. If this is the very first stage, the puzzle can't
            // be solved by these techniques at all.
            if (stages.length === 0) {
                throw new Error('Puzzle is not solvable by non-guessing deduction alone.');
            }
            stages[stages.length - 1].cageIndices.push(...found.cageIndices);
        } else {
            stages.push(found);
        }
    }

    if (known.size !== w * w) {
        // Every cage is active at this point (remaining is empty) yet the
        // grid isn't fully determined -- this puzzle has more than one
        // solution consistent with all its clues, i.e. it's not solvable
        // by non-guessing deduction at all. The generator should reject
        // this seed/grid and try another rather than use these stages.
        throw new Error(
            `Puzzle is not fully solvable by non-guessing deduction: ` +
            `${known.size}/${w * w} cells determined even with every clue active.`);
    }

    return stages;
}

/**
 * Merges adjacent stages (always the pair with the fewest combined newly
 * forced cells, to keep the remaining stages as evenly sized as possible)
 * until exactly `target` stages remain. Returns null if `stages` already
 * has fewer than `target` entries -- the caller should retry generation
 * with a different seed/larger grid, or fall back to clamping.
 *
 * @param {{cageIndices:number[], newlyForced: Map<number,number>}[]} stages
 * @param {number} target
 */
function mergeToTargetCount(stages, target) {
    if (stages.length < target) return null;
    if (target < 1) throw new Error('target must be >= 1');

    let result = stages.map((s) => ({
        cageIndices: [...s.cageIndices],
        newlyForced: new Map(s.newlyForced),
    }));

    while (result.length > target) {
        let bestIdx = 0;
        let bestSize = Infinity;
        for (let i = 0; i < result.length - 1; i++) {
            const size = result[i].newlyForced.size + result[i + 1].newlyForced.size;
            if (size < bestSize) { bestSize = size; bestIdx = i; }
        }
        const merged = {
            cageIndices: [...result[bestIdx].cageIndices, ...result[bestIdx + 1].cageIndices],
            newlyForced: new Map([...result[bestIdx].newlyForced, ...result[bestIdx + 1].newlyForced]),
        };
        result.splice(bestIdx, 2, merged);
    }

    return result;
}

/**
 * End-to-end: plan the natural stage decomposition for a puzzle and merge
 * it down to `targetGroupCount` stages. Returns null (caller should retry
 * with a different seed/grid, or clamp) if the puzzle's natural chain is
 * shorter than the target.
 */
function planClueGroups(w, cages, targetGroupCount, maxComboSize = 3) {
    const natural = planNaturalStages(w, cages, maxComboSize);
    return mergeToTargetCount(natural, targetGroupCount);
}

module.exports.planNaturalStages = planNaturalStages;
module.exports.mergeToTargetCount = mergeToTargetCount;
module.exports.planClueGroups = planClueGroups;
