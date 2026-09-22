/**
 * Pure, DOM/WASM-free helpers for dividing a Keen puzzle's clues into an
 * ordered chain of progressively-revealed groups (the client-side clue
 * division algorithm -- see progress-notes.md "Stage 2").
 *
 * This module never solves anything itself and never touches the game's
 * solver: it only understands the *descriptor string format* (block
 * structure + one clue token per cage) well enough to (a) parse it into
 * cages, (b) tell which cages touch a given row/column, (c) decide how to
 * split cages into up to N incremental groups, and (d) re-render a
 * descriptor with some cages' clues replaced by the existing 'n' ("no
 * clue") marker the solver already understands. Actually solving each
 * stage (via the existing, unmodified solver, exposed as
 * solve_partial_desc/getForcedDigits) happens elsewhere, once a masked
 * descriptor from here is handed to it.
 *
 * Descriptor format (keen.c): "<block-structure>,<clue-tokens>"
 *   - block-structure: an RLE-ish encoding of the w*(w-1) internal
 *     horizontal edges followed by the w*(w-1) internal vertical edges of
 *     the grid, where each edge is either a cage boundary or not. See
 *     parseBlockStructure() below for a line-for-line port of keen.c's
 *     parse_block_structure().
 *   - clue-tokens: one token per cage (a/m/s/d/n, optionally followed by
 *     digits for a/m/s/d), enumerated in ascending order of each cage's
 *     minimal (lowest-index) cell -- i.e. exactly the iteration order
 *     `for (i = 0; i < a; i++) if (dsf_minimal(dsf, i) == i)` in keen.c's
 *     validate_desc()/new_game().
 *
 * Verified (see progress-notes.md) against 12 real generated descriptors
 * (sizes 3/4/5/6/9, difficulties easy through extreme) with: exact
 * round-trip reconstruction, cage-partition completeness, d/s cage-size
 * invariants, and -- cross-checked through the real native
 * thegame.solve_partial() on the user's machine -- 422 masked descriptors
 * across 72 (puzzle, target-group-count) combinations, all accepted with
 * no errors, monotonically non-decreasing forced-digit counts, and full
 * grids forced once every cage is revealed.
 */

function parseBlockStructure(desc, startIndex, w) {
    const parent = new Int32Array(w * w);
    for (let i = 0; i < w * w; i++) parent[i] = i;

    function find(x) {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    }
    function union(a, b) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    }

    let pos = 0;
    let repc = 0, repn = 0;
    let i = startIndex;
    const total = 2 * w * (w - 1);

    while (i < desc.length && (repn > 0 || desc[i] !== ',')) {
        let c;

        if (repn > 0) {
            repn--;
            c = repc;
        } else if (desc[i] === '_' || (desc[i] >= 'a' && desc[i] <= 'z')) {
            c = desc[i] === '_' ? 0 : desc.charCodeAt(i) - 'a'.charCodeAt(0) + 1;
            i++;
            if (i < desc.length && desc[i] >= '0' && desc[i] <= '9') {
                repc = c;
                const numStart = i;
                while (i < desc.length && desc[i] >= '0' && desc[i] <= '9') i++;
                repn = parseInt(desc.slice(numStart, i), 10) - 1;
            }
        } else {
            throw new Error(`Invalid character '${desc[i]}' in block structure at index ${i}`);
        }

        const adv = c !== 25;

        while (c-- > 0) {
            let p0, p1;
            if (pos >= total) {
                throw new Error("Too much data in block structure specification");
            }
            if (pos < w * (w - 1)) {
                const y = Math.floor(pos / (w - 1));
                const x = pos % (w - 1);
                p0 = y * w + x;
                p1 = y * w + x + 1;
            } else {
                const x = Math.floor(pos / (w - 1)) - w;
                const y = pos % (w - 1);
                p0 = y * w + x;
                p1 = (y + 1) * w + x;
            }
            union(p0, p1);
            pos++;
        }
        if (adv) {
            pos++;
            if (pos > total + 1) {
                throw new Error("Too much data in block structure specification");
            }
        }
    }

    if (pos !== total + 1) {
        throw new Error("Not enough data in block structure specification");
    }
    if (desc[i] !== ',') {
        throw new Error("Expected ',' after block structure");
    }

    return { find, nextIndex: i + 1 };
}

function parseKeenDescriptor(desc, w) {
    const commaIndex = desc.indexOf(',');
    if (commaIndex === -1) {
        throw new Error("Descriptor has no ',' separating block structure from clues");
    }

    const { find, nextIndex } = parseBlockStructure(desc, 0, w);
    const blockStructure = desc.slice(0, commaIndex);

    const a = w * w;
    const cageIdOfCell = new Int32Array(a);
    for (let cell = 0; cell < a; cell++) {
        cageIdOfCell[cell] = find(cell);
    }

    const minimalOf = new Map();
    for (let cell = 0; cell < a; cell++) {
        const root = cageIdOfCell[cell];
        if (!minimalOf.has(root) || minimalOf.get(root) > cell) {
            minimalOf.set(root, cell);
        }
    }
    for (let cell = 0; cell < a; cell++) {
        cageIdOfCell[cell] = minimalOf.get(cageIdOfCell[cell]);
    }

    const cages = new Map();
    for (let cell = 0; cell < a; cell++) {
        const id = cageIdOfCell[cell];
        if (!cages.has(id)) cages.set(id, { id, cells: [], token: null });
        cages.get(id).cells.push(cell);
    }

    const cageOrder = [...cages.keys()].sort((x, y) => x - y);

    let p = nextIndex;
    for (const id of cageOrder) {
        if (p >= desc.length) {
            throw new Error("Too few clues for block structure");
        }
        const clueType = desc[p];
        if (!"namsd".includes(clueType)) {
            throw new Error(`Unrecognised clue type '${clueType}' at index ${p}`);
        }
        let tokenEnd = p + 1;
        if (clueType !== 'n') {
            while (tokenEnd < desc.length && desc[tokenEnd] >= '0' && desc[tokenEnd] <= '9') tokenEnd++;
        }
        cages.get(id).token = desc.slice(p, tokenEnd);
        p = tokenEnd;
    }
    if (p !== desc.length) {
        throw new Error("Too many clues for block structure");
    }

    return { w, blockStructure, cageIdOfCell, cages, cageOrder };
}

function buildMaskedDescriptor(parsed, visibleCageIds) {
    const visible = visibleCageIds instanceof Set ? visibleCageIds : new Set(visibleCageIds);
    const tokens = parsed.cageOrder.map(id => (
        visible.has(id) ? parsed.cages.get(id).token : 'n'
    ));
    return `${parsed.blockStructure},${tokens.join('')}`;
}

function touchingCagesByLine(parsed) {
    const { w, cageIdOfCell } = parsed;
    const rows = Array.from({ length: w }, () => new Set());
    const cols = Array.from({ length: w }, () => new Set());

    for (let cell = 0; cell < w * w; cell++) {
        const row = Math.floor(cell / w);
        const col = cell % w;
        const id = cageIdOfCell[cell];
        rows[row].add(id);
        cols[col].add(id);
    }

    return { rows, cols };
}

function hashStringToSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffleInPlace(array, rng) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function divideCages(parsed, targetGroups, seedInput) {
    const allCageIds = parsed.cageOrder;
    const n = Math.max(1, Math.floor(targetGroups));

    if (allCageIds.length === 0) {
        return { groups: [[]], achieved: 1, requested: n };
    }

    const rng = mulberry32(hashStringToSeed(String(seedInput)));

    if (n <= 1) {
        return { groups: [allCageIds.slice().sort((a, b) => a - b)], achieved: 1, requested: n };
    }

    const { rows, cols } = touchingCagesByLine(parsed);
    const candidates = [...rows, ...cols];

    let best = candidates[0];
    for (const cand of candidates) {
        if (cand.size < best.size || (cand.size === best.size && rng() < 0.5)) {
            best = cand;
        }
    }

    const group1 = [...best].sort((a, b) => a - b);
    const group1Set = new Set(group1);
    const remaining = allCageIds.filter(id => !group1Set.has(id));
    shuffleInPlace(remaining, rng);

    const achieved = Math.min(n, 1 + remaining.length);
    const groups = [group1];

    if (achieved > 1) {
        const chunkCount = achieved - 1;
        const base = Math.floor(remaining.length / chunkCount);
        const extra = remaining.length % chunkCount;
        let idx = 0;
        for (let k = 0; k < chunkCount; k++) {
            const size = base + (k < extra ? 1 : 0);
            groups.push(remaining.slice(idx, idx + size));
            idx += size;
        }
    }

    return { groups, achieved, requested: n };
}

/**
 * Every (row, col) combination's starting-group candidate: the union of
 * cages touching that row or that column, one full row plus one full
 * column of "coverage" -- in practice almost always enough for the real
 * solver to deduce at least one digit, unlike a single row or column
 * alone (see divideCages()'s group[0], which this supersedes as the
 * starting-group strategy for the progressive-reveal client -- kept
 * side-by-side rather than replacing divideCages() itself, since that
 * function's existing callers/tests don't need solver access).
 *
 * Returns candidates in a seeded-shuffled order (deterministic per
 * puzzle instance via seedInput, same scheme as divideCages()), so a
 * caller can try them in order against the real solver and stop at the
 * first one that actually forces something. Different (row, col) pairs
 * can happen to touch the exact same set of cages (small grids
 * especially); those duplicates are collapsed so a caller never re-tests
 * an identical mask twice, without skipping any distinct combination's
 * actual effect.
 *
 * Returns [{ row, col, cageIds: number[] }, ...], length <= w*w.
 */
function rowColStartCandidates(parsed, seedInput) {
    const { w } = parsed;
    const { rows, cols } = touchingCagesByLine(parsed);
    const rng = mulberry32(hashStringToSeed(String(seedInput)));

    const pairs = [];
    for (let r = 0; r < w; r++) {
        for (let c = 0; c < w; c++) {
            pairs.push([r, c]);
        }
    }
    shuffleInPlace(pairs, rng);

    const seen = new Set();
    const candidates = [];
    for (const [r, c] of pairs) {
        const union = new Set([...rows[r], ...cols[c]]);
        const cageIds = [...union].sort((a, b) => a - b);
        const key = cageIds.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ row: r, col: c, cageIds });
    }
    return candidates;
}

/**
 * All 2w "lines" of a w*w grid, as { type: 'row'|'col', index }. Used by
 * the per-stage line search in src/puzzles.js's resolveKeenStagePlan()
 * (see also rowColStartCandidates() above, for the very first stage).
 */
function allLines(w) {
    const lines = [];
    for (let i = 0; i < w; i++) lines.push({ type: 'row', index: i });
    for (let i = 0; i < w; i++) lines.push({ type: 'col', index: i });
    return lines;
}

/**
 * Stable string key for a line, for Set membership (tracking which lines
 * have already been revealed).
 */
function lineKey(line) {
    return `${line.type}:${line.index}`;
}

/**
 * All k-element combinations of `items` (order-independent, no repeats),
 * as an array of arrays. Used to escalate the per-stage line search from
 * a single new row/column to a pair of them when no single remaining
 * line adds a deducible digit on its own.
 */
function combinations(items, k) {
    const result = [];
    const combo = [];
    function recurse(start) {
        if (combo.length === k) {
            result.push(combo.slice());
            return;
        }
        for (let i = start; i < items.length; i++) {
            combo.push(items[i]);
            recurse(i + 1);
            combo.pop();
        }
    }
    recurse(0);
    return result;
}

/**
 * A seeded-shuffled copy of `array` (the module's own mulberry32 PRNG,
 * keyed the same way as divideCages()/rowColStartCandidates()), without
 * mutating the input. Exposed so callers outside this module (the
 * per-stage line search in src/puzzles.js) get the same
 * deterministic-per-puzzle-instance shuffling without duplicating the
 * seed/PRNG machinery.
 */
function seededShuffleCopy(array, seedInput) {
    const rng = mulberry32(hashStringToSeed(String(seedInput)));
    return shuffleInPlace(array.slice(), rng);
}

function buildStageDescriptors(parsed, targetGroups, seedInput) {
    const { groups, achieved, requested } = divideCages(parsed, targetGroups, seedInput);
    const running = new Set();
    const stages = groups.map(newIds => {
        for (const id of newIds) running.add(id);
        return {
            cageIds: new Set(running),
            descriptor: buildMaskedDescriptor(parsed, running),
        };
    });
    return { achieved, requested, stages };
}

/**
 * Number of forced (non-'0') digits in a forced-digit string as returned
 * by the game's solve_partial (see getForcedDigits()/solve_partial_desc()
 * in src/puzzles.js) -- '0' means undetermined, anything else is a
 * solved cell. Null/undefined (the solver being unavailable, or a failed
 * request) counts as zero progress rather than throwing.
 */
function countForcedDigits(forcedDigitString) {
    if (!forcedDigitString) return 0;
    let count = 0;
    for (let i = 0; i < forcedDigitString.length; i++) {
        if (forcedDigitString[i] !== '0') count++;
    }
    return count;
}

/**
 * Merge away any stage that adds no additional forced digits over the
 * previous *kept* stage (forcedCounts[k] is stage[k]'s total forced-digit
 * count, as measured by the real solver -- this module never solves
 * anything itself, so the counts must come from the caller; see
 * countForcedDigits() above and getForcedDigits()/solve_partial_desc in
 * src/puzzles.js). A structural division can produce a group whose clue
 * doesn't newly pin down any cell on its own -- very common for the
 * very first group (a handful of addition/subtraction cages alone often
 * force nothing) -- and those "boring" early stages are folded into the
 * next one instead of being shown as their own group, so every "digit
 * group" a player unlocks up to the point of full solvability actually
 * teaches them something.
 *
 * `fullForceThreshold` (the puzzle's full cell count, w*w) changes this
 * once the grid is already completely deducible: per the user's request
 * ("I want each subsequent clue group to reveal 1 extra cage at random
 * if there are unclued cages available"), a stage from that point on is
 * kept *regardless* of whether it changes the forced-digit count at all
 * -- chooseNextStageReveal()'s own "already-solved" fast path only ever
 * adds one still-hidden cage per such stage (purely for the player to
 * see, since there's nothing left to logically deduce), and those
 * cosmetic-only reveals are exactly what this exception is for. Without
 * it, every stage past the point of full solvability would tie at the
 * same forced count and collapse into one, so a puzzle solvable from
 * only 15 of its 25 available clue groups would never show the other
 * 10 cages' clues no matter how many more "Clue" items the player
 * received -- leaving them permanently hidden except via the mandatory
 * full reveal on the world's very last configured stage (see
 * resolveKeenStagePlan()'s isFinalAllowedStage). This world's only
 * caller (resolveKeenStagePlan()) always passes w*w; the parameter is
 * optional (rather than baked in) only so this function's own
 * behavior stays independently testable/describable without requiring
 * a specific puzzle size.
 *
 * Cumulative masked descriptors already contain every earlier stage's
 * cages, so dropping a no-progress stage k is exactly "merge its cages
 * into the next kept stage" -- no re-division needed, just filtering.
 *
 * Returns a filtered stages array (same shape as buildStageDescriptors()'s
 * `stages`), always length >= 1. (A valid Keen puzzle's true full
 * descriptor always forces every cell -- see keen-solve-partial-test.c's
 * verification -- so the last stage always adds progress over an empty
 * start and this can't degenerate to zero real puzzles; the length-1
 * fallback below is just a defensive backstop.)
 */
function mergeNoProgressStages(stages, forcedCounts, fullForceThreshold) {
    if (stages.length !== forcedCounts.length) {
        throw new Error(`stages/forcedCounts length mismatch: ${stages.length} vs ${forcedCounts.length}`);
    }
    const kept = [];
    let lastCount = 0;
    for (let k = 0; k < stages.length; k++) {
        const alreadyFullyForced = fullForceThreshold !== undefined && lastCount >= fullForceThreshold;
        if (forcedCounts[k] > lastCount || alreadyFullyForced) {
            kept.push(stages[k]);
            lastCount = forcedCounts[k];
        }
    }
    if (kept.length === 0) {
        kept.push(stages[stages.length - 1]);
    }
    return kept;
}

/**
 * All digit values (1..w) that could occupy at least one of a clued
 * cage's still-empty cells, considering ONLY that cage's own
 * arithmetic clue -- deliberately ignoring the rest of the board's
 * row/column ("Latin square") constraints entirely, and consistent
 * with whatever digits are already filled into the cage's OTHER
 * cells. Row/column elimination for a specific cell is the caller's
 * job (see handleCellDoubleRightClicked() in puzzles.js) -- this
 * function only ever reasons about the cage in isolation, per the
 * feature's design (double-right-click a clued cage to pencil in its
 * candidates, without being "smart" about anything outside the cage).
 *
 * Cage cells are not distinguished by position: addition/
 * multiplication (any cage size) and subtraction/division (always
 * exactly 2 cells, per Keen's own generator -- never any other size)
 * are all order-independent, so any permutation of a valid multiset
 * across the cage's cells is an equally valid assignment. That means
 * every still-empty cell gets the exact same raw candidate set here --
 * this deliberately does NOT try to narrow one cell's candidates
 * because of what a valid assignment left over for another (e.g. a
 * 2-cell 6x cage with candidates {1,6}/{2,3} always offers "1236" to
 * BOTH empty cells, never inferring "well, if this one's excluded from
 * 1 it must be 6, so exclude 2 and 3 from the other" -- see
 * progress-notes.md for the worked examples this mirrors verbatim).
 *
 * `currentGrid` is a w*w-length digit string, '0' for an empty cell,
 * indexed the same way as cageCells (row*w+col) -- see getCurrentGrid()
 * in puzzles.js. `op`/`value` come straight from the cage's own
 * (always-unmasked) parsed clue token -- see parseKeenDescriptor()
 * above: op is one of 'a' (add), 'm' (multiply), 's' (subtract),
 * 'd' (divide); 'n' (no clue) should never reach here, since the
 * caller only calls this once it's confirmed the cage's clue is
 * actually visible right now.
 *
 * Returns null if the cage is already fully filled (nothing to
 * compute) or if op/n don't admit any valid assignment at all
 * (shouldn't happen for a puzzle that's still solvable, but this
 * fails safe rather than throwing). Otherwise returns
 * { candidates: Set<number>, emptyCells: number[] }.
 */
function cageCandidateDigits(w, cageCells, op, value, currentGrid) {
    const filledCounts = new Map();
    const emptyCells = [];
    for (const cell of cageCells) {
        const ch = currentGrid ? currentGrid[cell] : '0';
        if (ch && ch !== '0') {
            const d = ch.charCodeAt(0) - '0'.charCodeAt(0);
            filledCounts.set(d, (filledCounts.get(d) || 0) + 1);
        } else {
            emptyCells.push(cell);
        }
    }
    if (emptyCells.length === 0) return null;

    const n = cageCells.length;
    if ((op === 's' || op === 'd') && n !== 2) return null;

    const satisfiesClue = (multiset) => {
        if (op === 'a') return multiset.reduce((a, b) => a + b, 0) === value;
        if (op === 'm') return multiset.reduce((a, b) => a * b, 1) === value;
        if (op === 's') return Math.abs(multiset[0] - multiset[1]) === value;
        if (op === 'd') {
            const hi = Math.max(multiset[0], multiset[1]);
            const lo = Math.min(multiset[0], multiset[1]);
            return lo !== 0 && hi % lo === 0 && hi / lo === value;
        }
        return false;
    };

    const countsOf = (multiset) => {
        const counts = new Map();
        for (const v of multiset) counts.set(v, (counts.get(v) || 0) + 1);
        return counts;
    };

    // A multiset is only usable if it has enough of each digit already
    // filled into one of the cage's OTHER cells -- e.g. a cage with one
    // cell already holding a 5 can't be satisfied by a multiset with no
    // 5 in it at all.
    const admitsFilled = (counts) => {
        for (const [d, c] of filledCounts) {
            if ((counts.get(d) || 0) < c) return false;
        }
        return true;
    };

    const candidates = new Set();
    const current = [];

    // Every non-decreasing (i.e. unordered/multiset) sequence of length
    // n from 1..w -- cheap at Keen's cage/grid sizes (at most
    // C(w+n-1, n), comfortably under a thousand even at w=9).
    // A multiset where every cell in the cage (filled or not) would
    // hold the identical digit is excluded outright -- e.g. a 2-cell
    // x10 addition cage's {5,5} option never contributes a "5"
    // candidate, even though {1,9}/{2,8}/{3,7}/{4,6} still do. This is
    // a per-multiset exclusion, independent of admitsFilled/row-column
    // "sees" logic: it's a deliberate simplification (a cage where
    // every cell is the same value is real and legal whenever no two
    // of its cells share a row/column, e.g. the earlier "15" duplicate
    // example's 3-cell x25 cage), applied uniformly because it's the
    // rarer, more confusing case to pencil in and the user asked for
    // it to be left out.
    const isMonochrome = (multiset) => n > 1 && multiset.every((d) => d === multiset[0]);

    const recurse = (start) => {
        if (current.length === n) {
            if (isMonochrome(current)) return;
            if (!satisfiesClue(current)) return;
            const counts = countsOf(current);
            if (!admitsFilled(counts)) return;
            for (const [d, c] of filledCounts) counts.set(d, (counts.get(d) || 0) - c);
            for (const [d, remaining] of counts) {
                if (remaining > 0) candidates.add(d);
            }
            return;
        }
        for (let d = start; d <= w; d++) {
            current.push(d);
            recurse(d);
            current.pop();
        }
    };
    recurse(1);

    if (candidates.size === 0) return null;
    return { candidates, emptyCells };
}

/**
 * Determines, for a single cage, which of its own arithmetic-admissible
 * digit multisets are actually FEASIBLE once each empty cell's own
 * row/column ("sees") exclusions are taken into account -- unlike
 * cageCandidateDigits() above (deliberately "dumb", cage-only, for the
 * double-right-click fill feature), this DOES cross-check row/column
 * information against candidate compositions, because the whole point
 * here is to tell "the cage's digit SET is uniquely pinned down by
 * everything visible so far" apart from "which cell gets which digit
 * is also pinned down" -- e.g. a 2-cell 6x cage ({1,6} or {2,3}) where
 * BOTH empty cells already see a 1 elsewhere in their own row/column:
 * {1,6} can never actually be placed (neither cell could hold the 1),
 * so only {2,3} remains admissible, even though a naive cage-only look
 * would still call the cage ambiguous between the two (user's own
 * example, verified below in verify_order_ambiguity.js).
 *
 * For each cage-arithmetic-admissible multiset (same enumeration and
 * filters as cageCandidateDigits(): satisfies the clue, respects
 * digits already filled in this SAME cage via admitsFilled(), and
 * excludes a fully monochrome multiset), checks every distinct way of
 * assigning its still-needed digits to the cage's empty cells, and
 * discards the multiset entirely if NONE of those assignments avoids
 * every cell's own row/column exclusions. Cage sizes are always <=6
 * (MAXBLK in keen.c), so brute-force permutation here is always cheap.
 *
 * `knownGrid` supplies both which cells already hold a real digit
 * (row*w+col-indexed digit-character string, '0' for undetermined)
 * and, together with `w`, every cell's row/column exclusion set --
 * callers pass whatever grid represents "everything currently known"
 * (e.g. a stage's own solved-so-far forcedDigits, or the player's live
 * entries), exactly the way cageCandidateDigits() already does.
 *
 * Returns null if the cage has no empty cells left. Otherwise
 * { emptyCells: number[], multisetCount: number, perCellCandidates:
 * Map<cell, Set<digit>> }. multisetCount is how many DISTINCT
 * multisets survived the feasibility check -- exactly 1 means the
 * cage's digit COMPOSITION is uniquely known, even if a given cell's
 * own perCellCandidates entry still has more than one digit in it
 * (i.e. the composition is known but which cell gets which digit --
 * the ORDER -- remains ambiguous for that cell). perCellCandidates
 * maps each empty cell to the set of digits it could hold in at least
 * one surviving, feasible assignment, across every surviving multiset
 * -- so a cell whose entry has exactly one digit is fully deducible
 * (forced) regardless of multisetCount, same as a solver's ordinary
 * "naked single", even when the cage's overall composition is NOT
 * uniquely known (see the "2-" worked example in progress-notes.md:
 * composition ambiguous between {2,4}/{4,6}, but one cell is still
 * individually forced to 4 because every surviving multiset's every
 * feasible assignment happens to put a 4 there).
 */
function cageOrderAmbiguity(w, cageCells, op, value, knownGrid) {
    const filledCounts = new Map();
    const emptyCells = [];
    for (const cell of cageCells) {
        const ch = knownGrid ? knownGrid[cell] : '0';
        if (ch && ch !== '0') {
            const d = ch.charCodeAt(0) - '0'.charCodeAt(0);
            filledCounts.set(d, (filledCounts.get(d) || 0) + 1);
        } else {
            emptyCells.push(cell);
        }
    }
    if (emptyCells.length === 0) return null;

    const n = cageCells.length;
    if ((op === 's' || op === 'd') && n !== 2) return null;

    const satisfiesClue = (multiset) => {
        if (op === 'a') return multiset.reduce((a, b) => a + b, 0) === value;
        if (op === 'm') return multiset.reduce((a, b) => a * b, 1) === value;
        if (op === 's') return Math.abs(multiset[0] - multiset[1]) === value;
        if (op === 'd') {
            const hi = Math.max(multiset[0], multiset[1]);
            const lo = Math.min(multiset[0], multiset[1]);
            return lo !== 0 && hi % lo === 0 && hi / lo === value;
        }
        return false;
    };

    const countsOf = (multiset) => {
        const counts = new Map();
        for (const v of multiset) counts.set(v, (counts.get(v) || 0) + 1);
        return counts;
    };

    const admitsFilled = (counts) => {
        for (const [d, c] of filledCounts) {
            if ((counts.get(d) || 0) < c) return false;
        }
        return true;
    };

    const isMonochrome = (multiset) => n > 1 && multiset.every((d) => d === multiset[0]);

    // Row/column exclusion set for one cell, computed from knownGrid --
    // same per-cell independence (never inferred onto another cell)
    // as cageCandidateDigits()'s own caller-side elimination.
    const excludedFor = (cell) => {
        const row = Math.floor(cell / w);
        const col = cell % w;
        const seen = new Set();
        for (let c = 0; c < w; c++) {
            const ch = knownGrid[row * w + c];
            if (c !== col && ch !== '0') seen.add(ch.charCodeAt(0) - '0'.charCodeAt(0));
        }
        for (let r = 0; r < w; r++) {
            const ch = knownGrid[r * w + col];
            if (r !== row && ch !== '0') seen.add(ch.charCodeAt(0) - '0'.charCodeAt(0));
        }
        return seen;
    };
    const exclusions = emptyCells.map(excludedFor);

    // Every distinct permutation of a (possibly-repeating) digit list,
    // without generating duplicate permutations for repeated values --
    // cage sizes are always <=6, so this stays cheap even in the
    // worst case (6! = 720).
    const distinctPermutations = (digits) => {
        const results = [];
        const used = new Array(digits.length).fill(false);
        const current = [];
        const sorted = [...digits].sort((a, b) => a - b);
        const recurse = () => {
            if (current.length === sorted.length) {
                results.push([...current]);
                return;
            }
            for (let i = 0; i < sorted.length; i++) {
                if (used[i]) continue;
                if (i > 0 && sorted[i] === sorted[i - 1] && !used[i - 1]) continue;
                used[i] = true;
                current.push(sorted[i]);
                recurse();
                current.pop();
                used[i] = false;
            }
        };
        recurse();
        return results;
    };

    let multisetCount = 0;
    const perCellCandidates = new Map();
    for (const cell of emptyCells) perCellCandidates.set(cell, new Set());

    const current = [];
    const recurseMultisets = (start) => {
        if (current.length === n) {
            if (isMonochrome(current)) return;
            if (!satisfiesClue(current)) return;
            const counts = countsOf(current);
            if (!admitsFilled(counts)) return;
            for (const [d, c] of filledCounts) counts.set(d, (counts.get(d) || 0) - c);
            const remaining = [];
            for (const [d, c] of counts) {
                for (let i = 0; i < c; i++) remaining.push(d);
            }

            let feasible = false;
            for (const perm of distinctPermutations(remaining)) {
                let ok = true;
                for (let i = 0; i < perm.length; i++) {
                    if (exclusions[i].has(perm[i])) { ok = false; break; }
                }
                if (ok) {
                    feasible = true;
                    for (let i = 0; i < perm.length; i++) {
                        perCellCandidates.get(emptyCells[i]).add(perm[i]);
                    }
                }
            }
            if (feasible) multisetCount++;
            return;
        }
        for (let d = start; d <= w; d++) {
            current.push(d);
            recurseMultisets(d);
            current.pop();
        }
    };
    recurseMultisets(1);

    return { emptyCells, multisetCount, perCellCandidates };
}

module.exports = {
    parseKeenDescriptor,
    buildMaskedDescriptor,
    touchingCagesByLine,
    divideCages,
    buildStageDescriptors,
    rowColStartCandidates,
    allLines,
    lineKey,
    combinations,
    seededShuffleCopy,
    countForcedDigits,
    mergeNoProgressStages,
    cageCandidateDigits,
    cageOrderAmbiguity,
    _hashStringToSeed: hashStringToSeed,
    _mulberry32: mulberry32,
};
