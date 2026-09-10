'use strict';
const assert = require('assert');
const {
    parseKeenDescriptor, parseKeenParamsWidth, buildStageDescriptor, buildStagePuzzleId,
    encodeKeenDescriptorRef,
} = require('./keenDescriptor.js');

// Same 4x4 fixture as test_keenSolver.js: solution grid
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
const fullDesc = encodeKeenDescriptorRef(w, cages);
console.log('encoded fixture descriptor:', fullDesc);

// 1. Round-trip: parsing the encoded descriptor recovers the same cages,
//    in the same (minimum-cell-index) order, with the same clues.
{
    const parsed = parseKeenDescriptor(w, fullDesc);
    assert.strictEqual(parsed.cages.length, cages.length);

    // cages must be sorted by min cell index to match encode order
    const expectedOrder = cages.slice().sort((a, b) => Math.min(...a.cells) - Math.min(...b.cells));

    for (let j = 0; j < expectedOrder.length; j++) {
        const exp = expectedOrder[j];
        const got = parsed.cages[j];
        assert.deepStrictEqual(got.cells.slice().sort((a, b) => a - b), exp.cells.slice().sort((a, b) => a - b),
            `cage ${j} cells mismatch`);
        assert.strictEqual(got.op, exp.op, `cage ${j} op mismatch`);
        assert.strictEqual(got.value, exp.value, `cage ${j} value mismatch`);
    }

    // every cell must belong to exactly one cage
    const seen = new Set();
    for (const cage of parsed.cages) {
        for (const c of cage.cells) {
            assert(!seen.has(c), `cell ${c} covered twice`);
            seen.add(c);
        }
    }
    assert.strictEqual(seen.size, w * w);
}

// 2. parseKeenParamsWidth extracts grid width from a params prefix.
{
    assert.strictEqual(parseKeenParamsWidth('4de'), 4);
    assert.strictEqual(parseKeenParamsWidth('6dnm'), 6);
    assert.strictEqual(parseKeenParamsWidth('9dx'), 9);
}

// 3. buildStageDescriptor masks out inactive cages as 'n', leaves the block
//    structure and active cages' clues byte-for-byte identical, and the
//    result is itself a valid, re-parseable descriptor whose *shape*
//    (cage cell membership) is unchanged.
{
    const parsed = parseKeenDescriptor(w, fullDesc);
    const activeCageIndices = new Set([0, 1, 10]); // matches solver test 3

    const stageDesc = buildStageDescriptor(parsed.blockPart, parsed.clueTokens, activeCageIndices);

    assert(stageDesc.startsWith(parsed.blockPart), 'block structure part must be preserved verbatim');

    const reparsed = parseKeenDescriptor(w, stageDesc);
    assert.strictEqual(reparsed.cages.length, parsed.cages.length);

    for (let j = 0; j < parsed.cages.length; j++) {
        // cage shape (cells) is always identical
        assert.deepStrictEqual(
            reparsed.cages[j].cells.slice().sort((a, b) => a - b),
            parsed.cages[j].cells.slice().sort((a, b) => a - b),
            `cage ${j} shape must survive masking`
        );

        if (activeCageIndices.has(j)) {
            assert.strictEqual(reparsed.cages[j].op, parsed.cages[j].op, `cage ${j} should keep its real clue`);
            assert.strictEqual(reparsed.cages[j].value, parsed.cages[j].value);
        } else {
            assert.strictEqual(reparsed.cages[j].op, 'none', `cage ${j} should be masked`);
            assert.strictEqual(reparsed.cages[j].value, null);
        }
    }
}

// 4. buildStagePuzzleId glues params + descriptor into the "params:desc"
//    form the web client's ArchipelagoPuzzle/loadPuzzle already expect.
{
    const parsed = parseKeenDescriptor(w, fullDesc);
    const puzzleId = buildStagePuzzleId(paramsStr, parsed.blockPart, parsed.clueTokens, [0]);
    assert.strictEqual(puzzleId, `${paramsStr}:${parsed.blockPart}${parsed.clueTokens.map((t, j) => j === 0 ? t : 'n').join('')}`);
    assert(puzzleId.startsWith(`${paramsStr}:`));
}

// 5. Every clue visible (all cages active) round-trips to the exact
//    original descriptor.
{
    const parsed = parseKeenDescriptor(w, fullDesc);
    const allActive = new Set(cages.map((_, j) => j));
    const stageDesc = buildStageDescriptor(parsed.blockPart, parsed.clueTokens, allActive);
    assert.strictEqual(stageDesc, fullDesc, 'fully-active stage descriptor must equal the original');
}

// 6. Malformed descriptors are rejected loudly rather than silently
//    misparsed.
{
    assert.throws(() => parseKeenDescriptor(w, '!garbage,a1'), /Invalid character/);
    assert.throws(() => parseKeenDescriptor(w, fullDesc.slice(0, -2)), /Too few clues/);
}

console.log('ALL TESTS PASSED');
