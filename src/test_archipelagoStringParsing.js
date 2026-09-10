'use strict';
/**
 * Regression test for the "genre prefix" contract between the Python world
 * (worlds/sgtkeen/__init__.py's self.puzzles, always "keen:<spec>") and
 * the web client's ArchipelagoPuzzle.fromArchipelagoString, which splits on
 * the first ":" to get genre vs. the rest. This doesn't import puzzles.js
 * directly (it depends on the DOM/archipelago.js/alpine/jquery/config, none
 * of which exist in this sandbox) -- it re-implements just the regex/branch
 * logic being tested, copied verbatim from the reviewed source, so a future
 * edit to that logic in puzzles.js should have this test's expectations
 * re-derived from the real file rather than trusted blindly.
 */
const assert = require('assert');

function parseArchipelagoString(genreAndParams) {
    const archipelagoStringRegex = /^(?<genre>[^:\n]*)(:(?<params>[^:#\n]*)((?<separator>[:#])?(?<seedOrId>.*)))?$/;
    const m = archipelagoStringRegex.exec(genreAndParams);
    const { genre, params, separator, seedOrId } = m.groups;

    const options = { genre, params };
    if (separator === ':') {
        options.puzzleId = `${params}:${seedOrId}`;
    } else if (separator === '#') {
        options.puzzleSeed = `${params}#${seedOrId}`;
    } else {
        options.puzzleSeed = `${params}#<auto>`;
    }
    return options;
}

// 1. Bare preset params (the common case: freshly-generated, no fixed seed/id).
{
    const r = parseArchipelagoString('keen:6de');
    assert.strictEqual(r.genre, 'keen');
    assert.strictEqual(r.params, '6de');
    assert.strictEqual(r.puzzleId, undefined);
    assert(r.puzzleSeed.startsWith('6de#'), 'bare params must auto-generate a seed');
}

// 2. Explicit seed (a Fixed Puzzle given as "6de#12345").
{
    const r = parseArchipelagoString('keen:6de#12345');
    assert.strictEqual(r.genre, 'keen');
    assert.strictEqual(r.params, '6de');
    assert.strictEqual(r.puzzleId, undefined);
    assert.strictEqual(r.puzzleSeed, '6de#12345', 'explicit "#seed" must become puzzleSeed, not puzzleId');
}

// 3. Explicit descriptor id (a Fixed Puzzle given as "6de:c494").
{
    const r = parseArchipelagoString('keen:6de:c494');
    assert.strictEqual(r.genre, 'keen');
    assert.strictEqual(r.params, '6de');
    assert.strictEqual(r.puzzleSeed, undefined);
    assert.strictEqual(r.puzzleId, '6de:c494', 'explicit ":id" must become puzzleId, not puzzleSeed');
}

// 4. A bare (un-prefixed) puzzle string -- what Python emitted BEFORE the
//    "keen:" prefix fix -- must NOT be mistaken for genre "keen". This
//    documents the bug that made the fix necessary: without a "keen:"
//    prefix, the whole string is swallowed as the genre.
{
    const r = parseArchipelagoString('6de');
    assert.notStrictEqual(r.genre, 'keen', 'un-prefixed puzzle strings are parsed as genre="6de", not "keen" -- this is why Python must emit "keen:<spec>"');
}

console.log('ALL TESTS PASSED');
