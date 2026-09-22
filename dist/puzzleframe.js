var solved = false;
var genre = "";
var puzzleId = "";
var allowNewGame = true;
// A manually-resized window size to apply once the puzzle boots, read
// directly from this iframe's own query string (set by the parent's
// loadPuzzle() -- see persistedPuzzleSize there) rather than replayed
// via a postMessage round trip, so it's available synchronously before
// the injected genre script's post_init() runs (see the end of
// post_init() in emccpre-ap.js, which reads these two vars directly --
// same cross-script global-scope sharing as sendMessage etc.).
var resizeW = null, resizeH = null;

window.onload = function() {
    let queryFragment = new URLSearchParams(window.location.search);

    genre = queryFragment.get("g");

    if (queryFragment.has("i")) {
        puzzleId = queryFragment.get("i");
    }

    if (queryFragment.has("s")) {
        allowNewGame = false;
    }

    if (queryFragment.has("rw") && queryFragment.has("rh")) {
        resizeW = Number(queryFragment.get("rw"));
        resizeH = Number(queryFragment.get("rh"));
    }

    if (genre) {
        loadPuzzle(genre);
    }

    window.parent.postMessage(["ready"]);
}

//
// Event handlers from messages from parent frame
//

function loadPuzzle(genre) {
    let elem = document.createElement("script")
    elem.setAttribute("src", `res/${genre}.js`)
    document.head.appendChild(elem)
}

function puzzleFromId() {
    command(0);
}

function puzzleFromSeed() {
    command(1);
}

function newPuzzle() {
    solved = false;
    command(5);
}

function restartPuzzle() {
    command(6);
    // command(6) (native "Restart", see emcc-ap.c) is synchronous, but
    // it reconstructs the puzzle from the *original* game descriptor
    // (see midend_restart_game() in midend.c, which deliberately
    // rebuilds from me->desc rather than reusing states[0] -- upstream
    // behaviour, not specific to this fork) -- and that descriptor is
    // whatever mask was baked in when this puzzle was first loaded,
    // before any clues were revealed live via revealClues(). So a
    // restart silently wipes any clue reveals that happened since load
    // (see restartPuzzle() in src/puzzles.js, which re-reveals
    // whatever should currently be visible once it hears this back).
    sendMessage("restartPuzzleCallback");
}

function undoPuzzle() {
    command(7);
}

function redoPuzzle() {
    command(8);
}

function solvePuzzle() {
    command(9);
}

function setPreset(id) {
    menuform.elements["preset"].value = id;
    command(2);
}

function setNewGameEnabled(allow) {
    set_allowed_shortcuts(allow, allow, true)
}

function dialogReturnString(index, val) {
    dlg_return_sval(index, val);
}

function dialogReturnInt(index, val) {
    dlg_return_ival(index, val);
}

function dialogConfirm() {
    command(3);
}

function dialogCancel() {
    command(4);
}

function showPreferences() {
    command(10);
}

function savePuzzleData() {
    var savefile_ptr = get_save_file(); // defined in {genre}.js
    var savefile_text = UTF8ToString(savefile_ptr);
    free_save_file(savefile_ptr);

    sendMessage("savePuzzleDataCallback", savefile_text);
}

function loadPuzzleData(data) {
    // Encode data as UTF-8 Uint8Array
    let encoder = new TextEncoder();
    let dataArray = encoder.encode(data);

    let pos = 0;

    savefile_read_callback = function(buf, len) {
        if (pos + len > dataArray.length)
            return false;
        writeArrayToMemory(
            dataArray.slice(pos, pos + len), buf);
        pos += len;
        return true;
    }
    load_game(); // defined in {genre}.js
    savefile_read_callback = null;

    // load_game() above (see its definition in emcc-ap.c) ends by
    // calling resize() itself, using whatever the *current* on-screen
    // size of containing_div happens to be. That's a problem
    // specifically when the player has a manually-resized/persisted
    // size in effect for this load (resizeW/resizeH, set from this
    // iframe's own query string -- see the top of this file, and
    // post_init() in emccpre-ap.js, which reapplies that size once
    // already, earlier in boot): containing_div wraps snugly around
    // the canvas, so by the time load_game() re-measures it, it
    // reflects whatever size post_init() just set the canvas to, and
    // asking again based on that measurement can land on something
    // bigger than what was actually persisted (confirmed live: a
    // persisted 592x545 correctly produced 538, then this exact call
    // pushed it to 769 -- a real, reproducible overshoot, not a
    // one-off). post_init()'s own reapply can't fix this on its own:
    // it runs *before* this function does (loadPuzzleData() is only
    // invoked once the parent has heard back that post_init() already
    // ran -- see js_post_init() in src/puzzles.js), so this is the
    // last point in the normal boot sequence where a stray resize()
    // can happen, and therefore the last point where we can still put
    // our target back. (An earlier attempt fixed this by reapplying on
    // this document's "load" event instead, on the theory that a
    // delayed containing_div remeasurement there was the culprit; live
    // debug logging showed that event never actually fires between the
    // correct apply and the overshoot, disproving that theory -- this
    // load_game() call is the actual, and only, second offender.)
    if (typeof resize_puzzle === "function" &&
        resizeW !== null && resizeH !== null) {
        resize_puzzle(resizeW, resizeH);
    }

    // Let the parent know the restore has actually landed (load_game()
    // above is synchronous), so it can safely run any post-restore
    // logic that depends on the restored state actually being live --
    // e.g. checking whether a progressive Keen puzzle's clue set needs
    // catching up to clues unlocked since this save was made.
    sendMessage("loadPuzzleDataCallback");
}

// Determine what a (possibly partial) params/desc pair already forces,
// using the game's own unmodified solver. Independent of whichever
// puzzle is actually loaded/displayed right now -- window.solve_partial_desc
// is a pure function of its two string arguments.
function getForcedDigits(paramsStr, desc) {
    if (typeof solve_partial_desc !== "function") {
        // Current genre doesn't implement solve_partial (e.g. not Keen).
        sendMessage("getForcedDigitsCallback", null);
        return;
    }

    var ptr = solve_partial_desc(paramsStr, desc); // defined in {genre}.js
    var result = ptr ? UTF8ToString(ptr) : null;
    if (ptr) free_solve_partial(ptr);

    sendMessage("getForcedDigitsCallback", result);
}

// Read the currently-displayed puzzle's actual entered digits (not its
// solution) as a digit string, same '0'..'9' convention as
// getForcedDigits()/solve_partial. Unlike getForcedDigits(), this DOES
// depend on whatever's currently loaded and live in this iframe's
// midend -- it's not a pure function of anything passed in. Used by
// checkDigitGroupProgress() in src/puzzles.js to detect when a digit
// group's cells have all been correctly filled in, so it can send that
// group's Archipelago location check.
function getCurrentGrid() {
    if (typeof get_current_grid !== "function") {
        // Current genre doesn't implement current_grid (e.g. not Keen).
        sendMessage("getCurrentGridCallback", null);
        return;
    }

    var ptr = get_current_grid(); // defined in {genre}.js
    var result = ptr ? UTF8ToString(ptr) : null;
    if (ptr) free_current_grid(ptr);

    sendMessage("getCurrentGridCallback", result);
}

// Same as getCurrentGrid() above, but for the live, currently-
// displayed puzzle's PENCIL marks -- a comma-separated string of
// decimal bitmasks, one per cell (see keen_current_pencil() in
// keen.c). Used by the "double-right-click a clued cage" feature in
// src/puzzles.js to tell whether the double-right-clicked cell
// already has any pencil marks in it before overwriting them.
function getCurrentPencil() {
    if (typeof get_current_pencil !== "function") {
        // Current genre doesn't implement current_pencil (e.g. not Keen).
        sendMessage("getCurrentPencilCallback", null);
        return;
    }

    var ptr = get_current_pencil(); // defined in {genre}.js
    var result = ptr ? UTF8ToString(ptr) : null;
    if (ptr) free_current_pencil(ptr);

    sendMessage("getCurrentPencilCallback", result);
}

// Push newly-unlocked clues into the live, currently-loaded puzzle in
// place, without reloading the frame -- see reveal_clues()'s doc
// comment (emcc-ap.c/puzzles.h/keen.c) for the full contract. `desc`
// is a full "block structure,clues" descriptor for the SAME puzzle
// already loaded; only some cages' clues may newly be un-masked
// relative to what's already showing. Used by liveRevealClues() in
// src/puzzles.js so an already-open puzzle updates immediately on
// receiving a new Archipelago item, rather than requiring the player
// to back out and reselect it.
function revealClues(desc) {
    if (typeof reveal_clues !== "function") {
        // Current genre doesn't implement reveal_clues (e.g. not Keen).
        sendMessage("revealCluesCallback", "Not supported for this game");
        return;
    }

    var err = reveal_clues(desc); // defined in {genre}.js; a 'string' cwrap, no pointer to free
    sendMessage("revealCluesCallback", err || null);
}

// Apply an arbitrary move string to the live, currently-displayed
// puzzle as a normal, undoable move -- see apply_move()/
// midend_apply_move()'s doc comments (emcc-ap.c/midend.c) for the full
// contract. Used by the "double-right-click a clued cage to pencil in
// candidates" feature: handleCellDoubleRightClicked() in
// src/puzzles.js computes the move string (an "F..." bulk pencil-set
// move -- see execute_move() in keen.c) and just needs somewhere to
// hand it in.
function applyMove(movestr) {
    if (typeof apply_move !== "function") {
        // Current genre doesn't implement this move type (e.g. not Keen).
        sendMessage("applyMoveCallback", "Not supported for this game");
        return;
    }

    var err = apply_move(movestr); // defined in {genre}.js; a 'string' cwrap, no pointer to free
    sendMessage("applyMoveCallback", err || null);
}

// Show or clear the "highlight next digit group" overlay (see
// toggleNextGroupHighlight() in src/puzzles.js, which computes which
// cells to highlight -- this function only knows how to draw them).
// `cells` is a flat array of cell indices (row*w + col); passing
// null/undefined clears the overlay. Cell rectangles are positioned as
// percentages of the overlay's own box, which always exactly matches
// the on-screen canvas (see the CSS comment on #digitGroupHighlight in
// puzzleframe.html) -- this only works because Keen's canvas is always
// exactly square, (w+1) cell-widths per side (BORDER == TILESIZE/2 on
// both ends of every row/column -- see keen.c's SIZE()/COORD() macros),
// so it needs no information from the WASM module at all, and stays
// correct regardless of zoom, window resizing, or device pixel ratio.
function setDigitGroupHighlight(cells, w) {
    const overlay = document.getElementById("digitGroupHighlight");
    if (!overlay) return;

    overlay.innerHTML = "";
    if (!cells || !w) return;

    const cellPercent = 100 / (w + 1);
    for (const cell of cells) {
        const row = Math.floor(cell / w);
        const col = cell % w;

        const div = document.createElement("div");
        div.className = "digit-group-highlight-cell";
        div.style.left = `${(col + 0.5) * cellPercent}%`;
        div.style.top = `${(row + 0.5) * cellPercent}%`;
        div.style.width = `${cellPercent}%`;
        div.style.height = `${cellPercent}%`;
        overlay.appendChild(div);
    }
}

// Show or clear the "grey out extra clues" overlay (see
// toggleExtraClueGreyOut() in src/puzzles.js, which computes which
// currently-visible cells belong to cages not needed for the next
// unsolved digit group -- this function only knows how to draw them).
// Deliberately its own sibling overlay div/CSS class rather than
// reusing #digitGroupHighlight, so the two toggles have independent
// clear/redraw lifecycles and can be shown together -- otherwise
// turning one off would wipe out the other's boxes too, since both
// call overlay.innerHTML = "" on every redraw. Same cell-to-percentage
// geometry as setDigitGroupHighlight() above; see its comment for why
// that needs no pixel measurement or WASM export call.
function setExtraClueGreyOut(cells, w) {
    const overlay = document.getElementById("extraClueGreyOut");
    if (!overlay) return;

    overlay.innerHTML = "";
    if (!cells || !w) return;

    const cellPercent = 100 / (w + 1);
    for (const cell of cells) {
        const row = Math.floor(cell / w);
        const col = cell % w;

        const div = document.createElement("div");
        div.className = "extra-clue-greyout-cell";
        div.style.left = `${(col + 0.5) * cellPercent}%`;
        div.style.top = `${(row + 0.5) * cellPercent}%`;
        div.style.width = `${cellPercent}%`;
        div.style.height = `${cellPercent}%`;
        overlay.appendChild(div);
    }
}

const messageHandlers = {
    loadPuzzle, setPreset, showPreferences,
    puzzleFromId, puzzleFromSeed,
    newPuzzle, restartPuzzle, undoPuzzle, redoPuzzle, solvePuzzle,
    dialogReturnString, dialogReturnInt, dialogConfirm, dialogCancel,
    setNewGameEnabled,
    savePuzzleData, loadPuzzleData,
    getForcedDigits, setDigitGroupHighlight, setExtraClueGreyOut, getCurrentGrid, getCurrentPencil,
    revealClues, applyMove
}

function processMessage(message) {
    if (!message.data[Symbol.iterator]) return;

    let [command, ...args] = message.data

    if (command) {
        let handler = messageHandlers[command]
        if (handler) {
            handler(...args)
        } else {
            console.warn("No handler found for message", message.data[0])
        }
    }
}

window.onmessage = processMessage

//
// Event handlers for events from puzzle JS
//

function sendMessage(command, ...args) {
    // Kludge to listen for post-init
    if (command == "js_post_init") {
        if (!allowNewGame) {
            setNewGameEnabled(false)
        }
    }

    window.parent.postMessage([command, ...args], "*")
}

function setBackgroundColor(colorString) {
    document.getElementById("puzzle").style.backgroundColor = colorString
}

function onSolve() {
    if (!solved) {
        solved = true;
        sendMessage("onSolve")
    }
}
