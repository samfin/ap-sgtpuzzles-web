'use strict';
/**
 * Parsing and stage-descriptor construction for Keen puzzle description
 * strings, as produced/consumed by Simon Tatham's Portable Puzzle
 * Collection's `keen.c` (see `encode_block_structure` / `parse_block_structure`
 * / `new_game_desc` / `validate_desc`).
 *
 * This module does NOT reimplement any puzzle-solving logic (that's
 * keenSolver.js) -- it only knows how to turn a Keen descriptor string into
 * a structured {cages} list, and how to turn that back into a *partial*
 * descriptor string with some cages' clues masked out as 'n' (Keen's
 * legitimate "no clue" marker), for progressive reveal.
 *
 * Descriptor format (the part after the ':' in a full puzzle id
 * "<params>:<description>"):
 *
 *   <block-structure-encoding>,<per-cage-clue>*
 *
 * The block-structure part encodes which of the w*(w-1) internal vertical
 * and w*(w-1) internal horizontal grid lines are "walls" (cage boundaries)
 * vs. absent (cells in the same cage), as a run-length-encoded list of gaps
 * between walls. The clue list has one entry per cage (in order of each
 * cage's minimum cell index), each either 'n' (no clue) or one of
 * a/s/m/d (add/sub/mul/div) followed by the target value.
 */

/**
 * Union-find where the representative ("find") of any set is always its
 * minimum member -- this matches Simon Tatham's `dsf_new_min` semantics,
 * which `keen.c` relies on to determine cage enumeration order (cages are
 * emitted, and their clues read back, in order of increasing minimum cell
 * index).
 */
class MinDSF {
    constructor(n) {
        this.parent = new Int32Array(n);
        for (let i = 0; i < n; i++) this.parent[i] = i;
    }

    find(x) {
        let root = x;
        while (this.parent[root] !== root) root = this.parent[root];
        while (this.parent[x] !== root) {
            const next = this.parent[x];
            this.parent[x] = root;
            x = next;
        }
        return root;
    }

    merge(a, b) {
        let ra = this.find(a);
        let rb = this.find(b);
        if (ra === rb) return;
        if (ra < rb) {
            this.parent[rb] = ra;
        } else {
            this.parent[ra] = rb;
        }
    }
}

/**
 * Port of keen.c's parse_block_structure(). Consumes characters from `str`
 * starting at `pos` until (but not including) the first ',' outside of a
 * repeat-count run, merging cells in `dsf` accordingly.
 *
 * @returns {{dsf: MinDSF, endPos: number}} endPos points at the ',' (or end
 *   of string, though a valid descriptor always has the comma).
 */
function parseBlockStructure(gridWidth, str, pos) {
    const a = gridWidth * gridWidth;
    const dsf = new MinDSF(a);
    const wallSlots = 2 * gridWidth * (gridWidth - 1);

    let i = pos;
    let slotPos = 0;
    let repc = 0;
    let repn = 0;

    while (i < str.length && (repn > 0 || str[i] !== ',')) {
        let c;
        if (repn > 0) {
            repn--;
            c = repc;
        } else if (str[i] === '_' || (str[i] >= 'a' && str[i] <= 'z')) {
            c = str[i] === '_' ? 0 : str.charCodeAt(i) - 'a'.charCodeAt(0) + 1;
            i++;
            let numStr = '';
            while (i < str.length && str[i] >= '0' && str[i] <= '9') {
                numStr += str[i];
                i++;
            }
            if (numStr) {
                repc = c;
                repn = parseInt(numStr, 10) - 1;
            }
        } else {
            throw new Error(`Invalid character in game description at offset ${i}`);
        }

        const adv = c !== 25; // 'z' is a special case: 25 non-walls, no following wall

        while (c-- > 0) {
            if (slotPos >= wallSlots) {
                throw new Error('Too much data in block structure specification');
            }
            let p0, p1;
            if (slotPos < gridWidth * (gridWidth - 1)) {
                const y = Math.floor(slotPos / (gridWidth - 1));
                const x = slotPos % (gridWidth - 1);
                p0 = y * gridWidth + x;
                p1 = y * gridWidth + x + 1;
            } else {
                const x = Math.floor(slotPos / (gridWidth - 1)) - gridWidth;
                const y = slotPos % (gridWidth - 1);
                p0 = y * gridWidth + x;
                p1 = (y + 1) * gridWidth + x;
            }
            dsf.merge(p0, p1);
            slotPos++;
        }
        if (adv) {
            slotPos++;
            if (slotPos > wallSlots + 1) {
                throw new Error('Too much data in block structure specification');
            }
        }
    }

    if (slotPos !== wallSlots + 1) {
        throw new Error('Not enough data in block structure specification');
    }

    return { dsf, endPos: i };
}

/**
 * Builds the ordered cage list (cage j = j-th cell, in increasing index
 * order, that is the minimum member of its own equivalence class) from a
 * parsed block-structure DSF. This ordering is exactly the order Keen's
 * clue list is written in/read from.
 */
function cagesFromDsf(dsf, gridWidth) {
    const a = gridWidth * gridWidth;
    const rootToCageIndex = new Map();
    const cages = [];

    for (let i = 0; i < a; i++) {
        if (dsf.find(i) === i) {
            rootToCageIndex.set(i, cages.length);
            cages.push({ cells: [] });
        }
    }

    for (let i = 0; i < a; i++) {
        const cageIdx = rootToCageIndex.get(dsf.find(i));
        cages[cageIdx].cells.push(i);
    }

    return cages;
}

const OP_CHAR_TO_NAME = { a: 'add', s: 'sub', m: 'mul', d: 'div' };
const OP_NAME_TO_CHAR = { add: 'a', sub: 's', mul: 'm', div: 'd' };

/**
 * Parses the clue list (the part of the descriptor after the comma),
 * expecting exactly `numCages` entries, in order.
 *
 * @returns {{clueTokens: string[], endPos: number}} clueTokens[j] is the
 *   raw source text for cage j's clue (e.g. "a7", "n"), preserved verbatim
 *   so re-emitting an unmodified cage's clue is a byte-for-byte no-op.
 */
function parseClueList(str, pos, numCages) {
    const clueTokens = [];
    let i = pos;

    for (let k = 0; k < numCages; k++) {
        const start = i;
        const opChar = str[i];
        if (opChar === undefined) {
            throw new Error('Too few clues for block structure');
        }
        i++;

        if (opChar !== 'n') {
            if (!(opChar in OP_CHAR_TO_NAME)) {
                throw new Error(`Unrecognised clue type '${opChar}'`);
            }
            while (i < str.length && str[i] >= '0' && str[i] <= '9') i++;
        }

        clueTokens.push(str.slice(start, i));
    }

    if (i < str.length) {
        throw new Error('Too many clues for block structure');
    }

    return { clueTokens, endPos: i };
}

function clueTokenToOpValue(token) {
    if (token === 'n') return { op: 'none', value: null };
    const opChar = token[0];
    const value = parseInt(token.slice(1), 10);
    return { op: OP_CHAR_TO_NAME[opChar], value };
}

/**
 * Parses a full Keen descriptor (the part after the ':' in a puzzle id) into
 * a structured cage list plus the raw pieces needed to reconstruct partial
 * ("some cages hidden") versions of it later.
 *
 * @param {number} gridWidth
 * @param {string} desc - e.g. "a_b3,,a7s2m12..." (block structure, comma,
 *   clue list)
 * @returns {{
 *   cages: {cells: number[], op: string, value: number|null}[],
 *   blockPart: string,       // includes the trailing comma
 *   clueTokens: string[],    // raw per-cage clue text, in cage order
 * }}
 */
function parseKeenDescriptor(gridWidth, desc) {
    const { dsf, endPos: commaPos } = parseBlockStructure(gridWidth, desc, 0);
    if (desc[commaPos] !== ',') {
        throw new Error("Expected ',' after block structure description");
    }
    const blockPart = desc.slice(0, commaPos + 1);

    const cages = cagesFromDsf(dsf, gridWidth);
    const { clueTokens, endPos } = parseClueList(desc, commaPos + 1, cages.length);

    if (endPos !== desc.length) {
        throw new Error('Trailing data after clue list');
    }

    for (let j = 0; j < cages.length; j++) {
        const { op, value } = clueTokenToOpValue(clueTokens[j]);
        if ((op === 'sub' || op === 'div') && cages[j].cells.length !== 2) {
            throw new Error('Subtraction and division cages must have area 2');
        }
        cages[j].op = op;
        cages[j].value = value;
    }

    return { cages, blockPart, clueTokens };
}

/**
 * Extracts the grid width from a Keen params string (e.g. "6de", "9dxm").
 * Mirrors keen.c's decode_params: the width is just the leading digits.
 */
function parseKeenParamsWidth(paramsStr) {
    const match = /^(\d+)/.exec(paramsStr);
    if (!match) throw new Error(`Could not parse grid width from params "${paramsStr}"`);
    return parseInt(match[1], 10);
}

/**
 * Builds a *display* descriptor where every cage not in `activeCageIndices`
 * has its clue masked out as 'n' (Keen's legitimate "no clue" marker,
 * understood natively by the game engine/solver UI). The block structure
 * (cage shapes) is always fully present -- only which clues are legible
 * changes across stages.
 *
 * @param {string} blockPart - from parseKeenDescriptor
 * @param {string[]} clueTokens - from parseKeenDescriptor (full/true clues)
 * @param {Set<number>|number[]} activeCageIndices
 */
function buildStageDescriptor(blockPart, clueTokens, activeCageIndices) {
    const active = activeCageIndices instanceof Set ? activeCageIndices : new Set(activeCageIndices);
    let clueStr = '';
    for (let j = 0; j < clueTokens.length; j++) {
        clueStr += active.has(j) ? clueTokens[j] : 'n';
    }
    return blockPart + clueStr;
}

/**
 * Convenience wrapper: given a full puzzle id "<params>:<desc>" and the set
 * of cages that should be visible, returns the puzzle id string for that
 * stage.
 */
function buildStagePuzzleId(paramsStr, blockPart, clueTokens, activeCageIndices) {
    return `${paramsStr}:${buildStageDescriptor(blockPart, clueTokens, activeCageIndices)}`;
}

/**
 * Reference re-implementation of keen.c's encode_block_structure(), used
 * ONLY to build fixtures for tests (and, potentially, sanity-checking) --
 * production code never needs to encode a block structure from scratch,
 * since it's always copied verbatim from the puzzle's original full
 * descriptor.
 */
function encodeBlockStructureRef(gridWidth, dsf) {
    const wallSlots = 2 * gridWidth * (gridWidth - 1);
    let out = '';
    let currrun = 0;

    for (let slotPos = 0; slotPos <= wallSlots; slotPos++) {
        let edge;
        if (slotPos === wallSlots) {
            edge = true;
        } else {
            let p0, p1;
            if (slotPos < gridWidth * (gridWidth - 1)) {
                const y = Math.floor(slotPos / (gridWidth - 1));
                const x = slotPos % (gridWidth - 1);
                p0 = y * gridWidth + x;
                p1 = y * gridWidth + x + 1;
            } else {
                const x = Math.floor(slotPos / (gridWidth - 1)) - gridWidth;
                const y = slotPos % (gridWidth - 1);
                p0 = y * gridWidth + x;
                p1 = (y + 1) * gridWidth + x;
            }
            edge = dsf.find(p0) !== dsf.find(p1);
        }

        if (edge) {
            while (currrun > 25) {
                out += 'z';
                currrun -= 25;
            }
            out += currrun ? String.fromCharCode('a'.charCodeAt(0) - 1 + currrun) : '_';
            currrun = 0;
        } else {
            currrun++;
        }
    }

    // Run-length compression pass, matching the C implementation.
    let compressed = '';
    let r = 0;
    while (r < out.length) {
        const c = out[r];
        let runLen = 1;
        while (r + runLen < out.length && out[r + runLen] === c) runLen++;
        if (runLen === 1) {
            compressed += c;
        } else if (runLen === 2) {
            compressed += c + c;
        } else {
            compressed += c + String(runLen);
        }
        r += runLen;
    }

    return compressed;
}

/**
 * Reference-only: builds a full descriptor string from a cage list (each
 * with explicit cells/op/value), for constructing test fixtures.
 */
function encodeKeenDescriptorRef(gridWidth, cages) {
    const a = gridWidth * gridWidth;
    const dsf = new MinDSF(a);
    for (const cage of cages) {
        for (let k = 1; k < cage.cells.length; k++) {
            dsf.merge(cage.cells[0], cage.cells[k]);
        }
    }

    const blockPart = encodeBlockStructureRef(gridWidth, dsf) + ',';

    // Cages must be emitted in order of minimum cell index, matching the
    // real encoder -- sort a copy rather than trusting caller order.
    const sorted = cages.slice().sort((c1, c2) => Math.min(...c1.cells) - Math.min(...c2.cells));

    let clueStr = '';
    for (const cage of sorted) {
        if (cage.op === 'none') {
            clueStr += 'n';
        } else {
            clueStr += OP_NAME_TO_CHAR[cage.op] + String(cage.value);
        }
    }

    return blockPart + clueStr;
}

module.exports = {
    MinDSF,
    parseBlockStructure,
    cagesFromDsf,
    parseClueList,
    parseKeenDescriptor,
    parseKeenParamsWidth,
    buildStageDescriptor,
    buildStagePuzzleId,
    // reference/test-fixture helpers
    encodeBlockStructureRef,
    encodeKeenDescriptorRef,
};
