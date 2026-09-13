'use strict';
/*
 * Regression test for a real reported bug: a Keen puzzle whose configured
 * digit_group_count exceeds its natural stage count (planClueGroups()'s
 * clamp fallback -- see planNaturalStages() in puzzles.js) can be fully,
 * correctly solved with FEWER "Clue Set" items than digit_group_count,
 * since every real cage is already visible once the natural stage count is
 * reached. The remaining, trailing "virtual" Digit Group locations only
 * become reachable once later, independently-granted Clue Set items arrive
 * for that puzzle -- which can easily happen while the player has switched
 * to a different puzzle. Before this fix, syncAPStatus() only ever
 * re-checked stage completion for the puzzle currently live in the shared
 * puzzleframe (via a real get_save_file() round trip) -- a background
 * puzzle's clueSetCount getting bumped updated the count but never
 * re-examined its already-solved grid, so those trailing locations (and
 * the "solved" state that depends on all of them being checked) never
 * fired at all.
 *
 * This extracts the REAL, VERBATIM source of syncAPStatus() out of
 * puzzles.js (via extract_fns.js's brace counting -- never a hand-retyped
 * copy) and re-hosts it via new Function(...) with every global it touches
 * mocked: Alpine (a tiny store shim), client (items/room/check), gamesaves
 * (per-puzzle stored saves), and the save-file/id helper functions. Puzzle
 * list entries are plain duck-typed mock objects -- syncAPStatus() only
 * ever calls methods/reads fields on them, never `instanceof`s the real
 * ArchipelagoPuzzle class -- with a spy-able _checkStagesForGrid() that
 * records what it was called with, so the test can assert the exact fix
 * under review actually fires, with the right grid, for a puzzle that is
 * NOT the one currently selected.
 */
const fs = require('fs');
const { extractFunction } = require('./extract_fns.js');

const PUZZLES_JS = '/mnt/user-data/uploads/apworld/ap-sgtpuzzles-web/src/puzzles.js';
const source = fs.readFileSync(PUZZLES_JS, 'utf8');
const syncAPStatusSrc = extractFunction(source, 'syncAPStatus');

function makeMockEntry({ index, clueSetCount, digitGroupCount, checkedStages, resolvedW }) {
    return {
        genre: 'keen',
        index,
        clueSetCount,
        digitGroupCount,
        checkedStages: new Set(checkedStages),
        resolved: { w: resolvedW },
        locked: false,
        solved: false,
        collected: false,
        _reloadChain: Promise.resolve(),
        updateState() {},
        async reloadAtCurrentStage() {},
        _checkStagesForGridCalls: [],
        _checkStagesForGrid(grid) {
            this._checkStagesForGridCalls.push(grid);
        },
    };
}

/*
 * Builds a fresh syncAPStatus() bound to mocked Alpine/client/gamesaves.
 * `receivedOverride` is {puzzleIndex -> "true" total Clue Set items
 * received}, used instead of each entry's own (stale) clueSetCount so a
 * jump of more than one item in a single pass (several items granted in a
 * burst while a different puzzle is open) can be simulated directly.
 */
function makeHarness({ currentEntry, entries, checkedLocations, storedSaves, receivedOverride }) {
    const stores = {
        puzzleList: { entries, current: currentEntry, resort() {} },
        gamesaves: {
            current: {
                async getPuzzleSave(index) {
                    return storedSaves.has(index) ? storedSaves.get(index) : null;
                },
            },
        },
    };
    const Alpine = { store: (name) => stores[name] };
    function isApReady() { return true; }

    const received = [];
    for (const [index, count] of receivedOverride) {
        const id = `item:Puzzle ${index} Clue Set`;
        for (let i = 0; i < count; i++) received.push({ id });
    }
    const client = {
        items: { received },
        room: { checkedLocations: [...checkedLocations] },
        check(locationId) {},
        players: { self: { team: 0, slot: 1 } },
        storage: {
            prepare() {
                return {
                    update() { return this; },
                    commit() {},
                };
            },
        },
    };
    function itemNameToId(name) { return `item:${name}`; }
    function locationNameToId(name) { return `loc:${name}`; }
    function parseSaveFile(text) { return { __raw: text }; }
    function reconstructKeenGrid(w, parsed) { return parsed.__raw.grid; }
    function savePuzzleData() {}

    const factory = new Function(
        'Alpine', 'isApReady', 'client', 'itemNameToId', 'locationNameToId',
        'parseSaveFile', 'reconstructKeenGrid', 'savePuzzleData',
        'hasItem', 'remoteSolved',
        `${syncAPStatusSrc}\nreturn syncAPStatus;`
    );
    const syncAPStatus = factory(
        Alpine, isApReady, client, itemNameToId, locationNameToId,
        parseSaveFile, reconstructKeenGrid, savePuzzleData,
        () => false, {}
    );
    return { syncAPStatus };
}

let tests = 0, passed = 0;
function check(name, cond) {
    tests++;
    if (cond) { passed++; console.log(`PASS: ${name}`); }
    else console.log(`FAIL: ${name}`);
}

async function run() {
    // ---- Test 1: a background puzzle's clueSetCount bump triggers a
    // stored-save stage-completion check, not just a bare count update ----
    // Puzzle 3 already has both its real stages checked (digitGroupCount
    // was 2, matching its natural stage count) but digit_group_count is
    // reconfigured/discovered to be 5 (the clamp-fallback scenario), and 3
    // more Clue Set items arrive for it in one burst while puzzle 1 (a
    // different puzzle) is the one actually on screen.
    {
        const bgEntry = makeMockEntry({
            index: 3, clueSetCount: 2, digitGroupCount: 5,
            checkedStages: [0, 1], resolvedW: 6,
        });
        const currentEntry = makeMockEntry({
            index: 1, clueSetCount: 1, digitGroupCount: 1,
            checkedStages: [0], resolvedW: 6,
        });
        const grid = new Array(36).fill(1); // stand-in "fully solved" grid

        const harness = makeHarness({
            currentEntry,
            entries: [currentEntry, bgEntry],
            checkedLocations: [],
            storedSaves: new Map([[3, { grid }]]),
            receivedOverride: new Map([[3, 5], [1, 1]]),
        });

        harness.syncAPStatus();
        await bgEntry._reloadChain; // the clueSetCount bump schedules async work

        check('background puzzle: clueSetCount updated to the new total',
            bgEntry.clueSetCount === 5);
        check('background puzzle: _checkStagesForGrid was invoked (not skipped)',
            bgEntry._checkStagesForGridCalls.length === 1);
        check("background puzzle: _checkStagesForGrid received the puzzle's " +
            "own stored grid, not the current puzzle's",
            bgEntry._checkStagesForGridCalls[0] === grid);
        check("current (selected) puzzle: untouched by the background puzzle's bump",
            currentEntry._checkStagesForGridCalls.length === 0 &&
            currentEntry.clueSetCount === 1);
    }

    // ---- Test 2: the currently-selected puzzle still takes the live
    // reload path, NOT the new background stored-save path ----
    {
        const currentEntry = makeMockEntry({
            index: 1, clueSetCount: 2, digitGroupCount: 5,
            checkedStages: [0, 1], resolvedW: 6,
        });
        let reloadCalls = 0;
        currentEntry.reloadAtCurrentStage = async () => { reloadCalls++; };

        const harness = makeHarness({
            currentEntry,
            entries: [currentEntry],
            checkedLocations: [],
            storedSaves: new Map(), // deliberately empty: the live path must
                                     // never need gamesaves at all
            receivedOverride: new Map([[1, 5]]),
        });

        harness.syncAPStatus();
        await currentEntry._reloadChain;

        check('current puzzle: reloadAtCurrentStage() called via the live path',
            reloadCalls === 1);
        check('current puzzle: _checkStagesForGrid NOT called directly by syncAPStatus ' +
            '(the live get_save_file()/checkStageCompletion() round trip owns that)',
            currentEntry._checkStagesForGridCalls.length === 0);
    }

    // ---- Test 3: a background puzzle with no stored save yet (never
    // actually opened/played) is safely skipped, not crashed on ----
    {
        const bgEntry = makeMockEntry({
            index: 7, clueSetCount: 0, digitGroupCount: 3,
            checkedStages: [], resolvedW: 6,
        });
        const currentEntry = makeMockEntry({
            index: 1, clueSetCount: 1, digitGroupCount: 1,
            checkedStages: [0], resolvedW: 6,
        });

        const harness = makeHarness({
            currentEntry,
            entries: [currentEntry, bgEntry],
            checkedLocations: [],
            storedSaves: new Map(), // no save stored for puzzle 7
            receivedOverride: new Map([[7, 2], [1, 1]]),
        });

        harness.syncAPStatus();
        await bgEntry._reloadChain;

        check('background puzzle with no stored save: does not throw, ' +
            'does not call _checkStagesForGrid',
            bgEntry._checkStagesForGridCalls.length === 0);
        check('background puzzle with no stored save: clueSetCount still updates',
            bgEntry.clueSetCount === 2);
    }

    // ---- Test 4: a background puzzle whose clueSetCount didn't change at
    // all is left completely alone (no spurious re-checks every sync) ----
    {
        const bgEntry = makeMockEntry({
            index: 3, clueSetCount: 5, digitGroupCount: 5,
            checkedStages: [0, 1, 2, 3, 4], resolvedW: 6,
        });
        const currentEntry = makeMockEntry({
            index: 1, clueSetCount: 1, digitGroupCount: 1,
            checkedStages: [0], resolvedW: 6,
        });

        const harness = makeHarness({
            currentEntry,
            entries: [currentEntry, bgEntry],
            checkedLocations: [],
            storedSaves: new Map([[3, { grid: new Array(36).fill(1) }]]),
            receivedOverride: new Map([[3, 5], [1, 1]]), // unchanged from clueSetCount
        });

        harness.syncAPStatus();
        await bgEntry._reloadChain;

        check('unchanged background puzzle: no stage-completion check triggered',
            bgEntry._checkStagesForGridCalls.length === 0);
    }

    console.log(`\n${passed}/${tests} tests passed`);
    process.exit(passed === tests ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
