'use strict';
/**
 * Parser/reconstructor for the save-file format produced by
 * `get_save_file()` (Simon Tatham midend's `midend_serialise`, see
 * `midend.c`). This lets us read back the *current* grid contents (which
 * definite digits the player has entered so far) purely in JS, with no
 * native/WASM changes -- `get_save_file()` is already exposed and callable
 * at any time via the existing `savePuzzleData()` message round-trip.
 *
 * File format (midend.c's midend_serialise): a sequence of lines, each
 * `<8-char left-justified header>:<byte length of content>:<content>\n`.
 * Relevant headers for our purposes:
 *   DESC       - the game description in effect for state 0
 *   NSTATES    - total number of states ever visited (including redoable
 *                "future" ones)
 *   STATEPOS   - 1-indexed index of the CURRENT state (states[statepos-1])
 *   MOVE/SOLVE/RESTART - one per state transition (i=1..nstates-1, in
 *                order), giving the move string that produced state i from
 *                state i-1
 *
 * Only the transitions up to (and not past) STATEPOS are part of the
 * current grid -- anything after that is only reachable via redo.
 */

/**
 * Splits raw save-file text into {header, content} records, per the
 * `<header>:<len>:<content>\n` framing. Uses the declared byte length
 * rather than splitting on newlines, since content is allowed to contain
 * anything (including newlines) as long as the length matches.
 */
function parseRecords(text) {
    const records = [];
    let pos = 0;
    const n = text.length;

    while (pos < n) {
        // Skip a lone trailing newline/whitespace at EOF.
        if (text.slice(pos).trim() === '') break;

        const firstColon = text.indexOf(':', pos);
        if (firstColon === -1) throw new Error(`Malformed save file: missing ':' after header at offset ${pos}`);
        const header = text.slice(pos, firstColon).trim();

        const secondColon = text.indexOf(':', firstColon + 1);
        if (secondColon === -1) throw new Error(`Malformed save file: missing length field for header "${header}"`);
        const lenStr = text.slice(firstColon + 1, secondColon);
        const len = parseInt(lenStr, 10);
        if (!Number.isFinite(len) || len < 0) {
            throw new Error(`Malformed save file: bad length "${lenStr}" for header "${header}"`);
        }

        const contentStart = secondColon + 1;
        const contentEnd = contentStart + len;
        if (contentEnd > n) throw new Error(`Malformed save file: declared length ${len} for "${header}" exceeds remaining data`);
        const content = text.slice(contentStart, contentEnd);

        // Expect (and skip) the trailing newline, if present.
        let next = contentEnd;
        if (text[next] === '\n') next++;
        else if (text[next] === '\r' && text[next + 1] === '\n') next += 2;

        records.push({ header, content });
        pos = next;
    }

    return records;
}

/**
 * Parses a Keen (or generically, any Simon Tatham puzzle) save file into
 * its structured fields.
 *
 * @returns {{
 *   desc: string|null,
 *   nstates: number,
 *   statepos: number,
 *   transitions: {type: 'MOVE'|'SOLVE'|'RESTART', str: string}[],
 * }}
 */
function parseSaveFile(text) {
    const records = parseRecords(text);

    let desc = null;
    let nstates = null;
    let statepos = null;
    const transitions = [];

    for (const { header, content } of records) {
        switch (header) {
            case 'DESC':
                desc = content;
                break;
            case 'NSTATES':
                nstates = parseInt(content, 10);
                break;
            case 'STATEPOS':
                statepos = parseInt(content, 10);
                break;
            case 'MOVE':
                transitions.push({ type: 'MOVE', str: content });
                break;
            case 'SOLVE':
                transitions.push({ type: 'SOLVE', str: content });
                break;
            case 'RESTART':
                transitions.push({ type: 'RESTART', str: content });
                break;
            default:
                // Ignore everything else (SAVEFILE, VERSION, GAME, PARAMS,
                // CPARAMS, SEED/HEXSEED, PRIVDESC, AUXINFO, UI, TIME, ...) --
                // not needed to reconstruct the grid.
                break;
        }
    }

    if (nstates === null) throw new Error('Save file missing NSTATES');
    if (statepos === null) throw new Error('Save file missing STATEPOS');
    if (statepos < 1 || statepos > nstates) {
        throw new Error(`Save file has out-of-range STATEPOS ${statepos} (NSTATES ${nstates})`);
    }
    if (transitions.length !== nstates - 1) {
        throw new Error(
            `Save file has ${transitions.length} move transitions but NSTATES=${nstates} implies ${nstates - 1}`
        );
    }

    return { desc, nstates, statepos, transitions };
}

/**
 * Applies a single 'MOVE'-type move string (Keen's `interpret_move` output:
 * "R<x>,<y>,<n>" for a definite-digit entry, "P<x>,<y>,<n>" for a pencil
 * mark) to a mutable grid array. Pencil marks don't affect the definite
 * grid and are ignored here.
 */
function applyKeenMoveString(grid, gridWidth, moveStr) {
    const kind = moveStr[0];
    if (kind !== 'R' && kind !== 'P') return; // unrecognised move kind; ignore defensively

    const rest = moveStr.slice(1);
    const parts = rest.split(',');
    if (parts.length !== 3) throw new Error(`Malformed Keen move string "${moveStr}"`);
    const x = parseInt(parts[0], 10);
    const y = parseInt(parts[1], 10);
    const n = parseInt(parts[2], 10);

    if (kind === 'R') {
        if (x < 0 || x >= gridWidth || y < 0 || y >= gridWidth) {
            throw new Error(`Move string "${moveStr}" out of bounds for width ${gridWidth}`);
        }
        grid[y * gridWidth + x] = n; // n === 0 means "cleared"
    }
    // 'P' (pencil) moves don't change definite digits.
}

/**
 * Applies a 'SOLVE'-type move string. Keen's solve() aux data (and hence
 * the move string used to apply a full solve) is "S" followed by exactly
 * w*w digit characters, one per cell in row-major order.
 */
function applyKeenSolveString(grid, gridWidth, moveStr) {
    if (moveStr[0] !== 'S') throw new Error(`Malformed Keen solve string "${moveStr}"`);
    const digits = moveStr.slice(1);
    if (digits.length !== gridWidth * gridWidth) {
        throw new Error(`Solve string has ${digits.length} digits, expected ${gridWidth * gridWidth}`);
    }
    for (let i = 0; i < digits.length; i++) {
        grid[i] = digits.charCodeAt(i) - '0'.charCodeAt(0);
    }
}

/**
 * Reconstructs the current (as of STATEPOS) definite-digit grid for a Keen
 * puzzle from a parsed save file. Cells with no definite digit entered are
 * 0.
 *
 * @param {number} gridWidth
 * @param {ReturnType<typeof parseSaveFile>} parsed
 * @returns {number[]} grid, row-major, length gridWidth*gridWidth
 */
function reconstructKeenGrid(gridWidth, parsed) {
    const a = gridWidth * gridWidth;
    const grid = new Array(a).fill(0);

    // Only transitions up to (not including) STATEPOS are "current" --
    // transitions.length === nstates - 1, and transitions[k] is the move
    // that produced state k+1 from state k. States 0..statepos-1 are
    // applied, i.e. transitions[0 .. statepos-2].
    const appliedCount = parsed.statepos - 1;

    for (let k = 0; k < appliedCount; k++) {
        const { type, str } = parsed.transitions[k];
        if (type === 'MOVE') {
            applyKeenMoveString(grid, gridWidth, str);
        } else if (type === 'SOLVE') {
            applyKeenSolveString(grid, gridWidth, str);
        } else if (type === 'RESTART') {
            grid.fill(0);
        }
    }

    return grid;
}

module.exports = {
    parseRecords,
    parseSaveFile,
    applyKeenMoveString,
    applyKeenSolveString,
    reconstructKeenGrid,
};
