'use strict';
const assert = require('assert');
const { parseSaveFile, reconstructKeenGrid } = require('./keenSaveFile.js');

// Mirrors midend.c's wr() macro: 8-char left-justified header, ':',
// byte length, ':', content, '\n'.
function wr(header, content) {
    const h = header.padEnd(8, ' ');
    return `${h}:${content.length}:${content}\n`;
}

function buildSaveFile({ desc, nstates, statepos, transitions }) {
    let out = '';
    out += wr('SAVEFILE', 'Simon Tatham\'s Portable Puzzle Collection');
    out += wr('VERSION', '1');
    out += wr('GAME', 'Keen');
    out += wr('PARAMS', '4de');
    out += wr('CPARAMS', '4de');
    out += wr('SEED', '12345');
    out += wr('DESC', desc);
    out += wr('NSTATES', String(nstates));
    out += wr('STATEPOS', String(statepos));
    for (const t of transitions) out += wr(t.type, t.str);
    return out;
}

const w = 4;
const desc = '_aa_9a_3aa__,a1a5a6a7a5a6a1a3a3a2a1'; // from test_keenDescriptor.js fixture

// 1. No moves yet: grid is all zeros.
{
    const text = buildSaveFile({ desc, nstates: 1, statepos: 1, transitions: [] });
    const parsed = parseSaveFile(text);
    assert.strictEqual(parsed.desc, desc);
    assert.strictEqual(parsed.nstates, 1);
    assert.strictEqual(parsed.statepos, 1);
    assert.strictEqual(parsed.transitions.length, 0);

    const grid = reconstructKeenGrid(w, parsed);
    assert.deepStrictEqual(grid, new Array(w * w).fill(0));
}

// 2. A few moves applied, all "current" (statepos == nstates).
{
    const transitions = [
        { type: 'MOVE', str: 'R0,0,1' },
        { type: 'MOVE', str: 'P1,0,3' }, // pencil mark, should NOT show up as a definite digit
        { type: 'MOVE', str: 'R2,0,3' },
    ];
    const text = buildSaveFile({ desc, nstates: 4, statepos: 4, transitions });
    const parsed = parseSaveFile(text);
    const grid = reconstructKeenGrid(w, parsed);

    const idx = (r, c) => r * w + c;
    assert.strictEqual(grid[idx(0, 0)], 1);
    assert.strictEqual(grid[idx(0, 1)], 0, 'pencil mark must not appear as a definite digit');
    assert.strictEqual(grid[idx(0, 2)], 3);
    assert.strictEqual(grid.filter(v => v !== 0).length, 2);
}

// 3. Undo in effect: STATEPOS points before the end of the move list, so
//    later moves (only reachable via redo) must NOT be applied.
{
    const transitions = [
        { type: 'MOVE', str: 'R0,0,1' },
        { type: 'MOVE', str: 'R2,0,3' }, // this one has been undone
    ];
    // nstates=3 (state0, state1, state2), statepos=2 -> only transitions[0] applied
    const text = buildSaveFile({ desc, nstates: 3, statepos: 2, transitions });
    const parsed = parseSaveFile(text);
    const grid = reconstructKeenGrid(w, parsed);

    const idx = (r, c) => r * w + c;
    assert.strictEqual(grid[idx(0, 0)], 1);
    assert.strictEqual(grid[idx(0, 2)], 0, 'undone move must not be applied');
}

// 4. Clearing a cell (R x,y,0) actually clears it.
{
    const transitions = [
        { type: 'MOVE', str: 'R0,0,1' },
        { type: 'MOVE', str: 'R0,0,0' },
    ];
    const text = buildSaveFile({ desc, nstates: 3, statepos: 3, transitions });
    const parsed = parseSaveFile(text);
    const grid = reconstructKeenGrid(w, parsed);
    assert.strictEqual(grid[0], 0);
}

// 5. RESTART resets the grid to empty, discarding all moves before it.
{
    const transitions = [
        { type: 'MOVE', str: 'R0,0,1' },
        { type: 'MOVE', str: 'R2,0,3' },
        { type: 'RESTART', str: '' },
        { type: 'MOVE', str: 'R3,3,1' },
    ];
    const text = buildSaveFile({ desc, nstates: 5, statepos: 5, transitions });
    const parsed = parseSaveFile(text);
    const grid = reconstructKeenGrid(w, parsed);
    const idx = (r, c) => r * w + c;
    assert.strictEqual(grid[idx(0, 0)], 0, 'restart must wipe earlier moves');
    assert.strictEqual(grid[idx(0, 2)], 0);
    assert.strictEqual(grid[idx(3, 3)], 1, 'moves after restart still apply');
}

// 6. A SOLVE transition fills the whole grid at once.
{
    const solveDigits = '1234' + '3412' + '2143' + '4321';
    const transitions = [{ type: 'SOLVE', str: 'S' + solveDigits }];
    const text = buildSaveFile({ desc, nstates: 2, statepos: 2, transitions });
    const parsed = parseSaveFile(text);
    const grid = reconstructKeenGrid(w, parsed);
    assert.deepStrictEqual(grid, solveDigits.split('').map(Number));
}

// 7. Malformed save files are rejected loudly.
{
    assert.throws(() => parseSaveFile('garbage no colons here'), /Malformed save file/);

    // NSTATES/transition count mismatch
    const badText = buildSaveFile({ desc, nstates: 3, statepos: 2, transitions: [{ type: 'MOVE', str: 'R0,0,1' }] });
    assert.throws(() => parseSaveFile(badText), /move transitions/);
}

console.log('ALL TESTS PASSED');
