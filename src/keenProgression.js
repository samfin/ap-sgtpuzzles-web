'use strict';
/**
 * Glue layer between the pure Keen descriptor/solver modules and the
 * "progressive Clue Set item / Digit Group location" mechanic: given a
 * puzzle's true full descriptor and a target number of digit groups, works
 * out (a) the clue-grouping stages, (b) which cages should be visible for a
 * given number of received Clue Set items, and (c) which digit groups are
 * newly completed given the player's currently-entered grid.
 *
 * This module has no DOM/Archipelago-client dependencies and is meant to be
 * unit-testable standalone; `puzzles.js` is the thin glue that wires it to
 * the actual UI/client/save-file plumbing.
 */

const { parseKeenDescriptor, parseKeenParamsWidth, buildStagePuzzleId } = require('./keenDescriptor.js');
const { solveWithActiveCages, planClueGroups } = require('./keenSolver.js');

/**
 * Resolves a Keen puzzle's static content (cages, solution, clue-group
 * stages) from its true full descriptor (obtained once via a by-seed
 * generation pass) and a target digit-group count.
 *
 * @param {string} paramsStr - e.g. "6de"
 * @param {string} fullDescriptor - the ":"-suffix of a full "<params>:<desc>"
 *   puzzle id, i.e. just the "<desc>" part, with every cage's real clue
 *   visible (as freshly generated -- never partially masked).
 * @param {number} digitGroupCount - target number of stages (from slot
 *   data's `digit_group_counts[i]`)
 * @param {number} [maxComboSize]
 * @returns {{
 *   w: number,
 *   cages: object[],
 *   blockPart: string,
 *   clueTokens: string[],
 *   solution: number[],   // row-major, length w*w
 *   stages: object[],     // from keenSolver.planClueGroups, length digitGroupCount
 * }}
 */
function resolveKeenPuzzle(paramsStr, fullDescriptor, digitGroupCount, maxComboSize = 3) {
    const w = parseKeenParamsWidth(paramsStr);
    const { cages, blockPart, clueTokens } = parseKeenDescriptor(w, fullDescriptor);

    const solutionMap = solveWithActiveCages(w, cages, cages.map((_, i) => i), new Map());
    if (solutionMap.size !== w * w) {
        throw new Error(
            `Puzzle is not fully solvable by non-guessing deduction (${solutionMap.size}/${w * w} cells) ` +
            `-- bad seed or unsupported difficulty.`
        );
    }
    const solution = new Array(w * w);
    for (const [cell, value] of solutionMap) solution[cell] = value;

    const stages = planClueGroups(w, cages, digitGroupCount, maxComboSize);
    if (!stages) {
        throw new Error(
            `Could not plan ${digitGroupCount} clue groups for this puzzle ` +
            `(grid too small/simple for that many stages) -- pick a different seed or a smaller digit_group_count.`
        );
    }

    return { w, cages, blockPart, clueTokens, solution, stages };
}

/**
 * Cages visible (i.e. NOT masked as 'n') once `clueSetCount` copies of the
 * Clue Set item have been received: stages[0..clueSetCount-1]'s cages,
 * cumulative. clueSetCount 0 => nothing visible (blank puzzle).
 */
function activeCageIndicesForCount(stages, clueSetCount) {
    const active = new Set();
    const n = Math.max(0, Math.min(clueSetCount, stages.length));
    for (let k = 0; k < n; k++) {
        for (const c of stages[k].cageIndices) active.add(c);
    }
    return active;
}

/**
 * Builds the puzzle id string ("<params>:<descriptor>") for the puzzle as
 * it should appear once `clueSetCount` Clue Set items have been received.
 */
function buildStagePuzzleIdForCount(paramsStr, resolved, clueSetCount) {
    const active = activeCageIndicesForCount(resolved.stages, clueSetCount);
    return buildStagePuzzleId(paramsStr, resolved.blockPart, resolved.clueTokens, active);
}

/**
 * Given the player's currently-entered grid (0 = blank, matching Keen's own
 * convention) and a resolved puzzle, returns the list of stage indices
 * (0-indexed; "Digit Group stageIndex+1") whose target cells are ALL
 * correctly filled, restricted to stages that are actually reachable at
 * `clueSetCount` (i.e. stageIndex < clueSetCount) and not already in
 * `alreadyChecked`.
 *
 * @param {object} resolved - from resolveKeenPuzzle
 * @param {number[]} enteredGrid - row-major, length w*w
 * @param {number} clueSetCount
 * @param {Set<number>} alreadyChecked - stage indices already checked; not
 *   mutated
 * @returns {number[]} newly-completed stage indices, in ascending order
 */
function newlyCompletedStages(resolved, enteredGrid, clueSetCount, alreadyChecked) {
    const completed = [];
    const reachable = Math.min(clueSetCount, resolved.stages.length);
    for (let k = 0; k < reachable; k++) {
        if (alreadyChecked.has(k)) continue;
        const stage = resolved.stages[k];
        let allMatch = true;
        for (const [cell, value] of stage.newlyForced) {
            if (enteredGrid[cell] !== value) {
                allMatch = false;
                break;
            }
        }
        if (allMatch) completed.push(k);
    }
    return completed;
}

module.exports = {
    resolveKeenPuzzle,
    activeCageIndicesForCount,
    buildStagePuzzleIdForCount,
    newlyCompletedStages,
};
