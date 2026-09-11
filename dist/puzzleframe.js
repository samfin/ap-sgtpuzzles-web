var solved = false;
var genre = "";
var puzzleId = "";
var allowNewGame = true;

window.onload = function() {
    let queryFragment = new URLSearchParams(window.location.search);

    genre = queryFragment.get("g");

    if (queryFragment.has("i")) {
        puzzleId = queryFragment.get("i");
    }

    if (queryFragment.has("s")) {
        allowNewGame = false;
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

function getForcedCells(paramsStr, descStr) {
    // defined in {genre}.js via cwrap (see emccpre-ap.js); only
    // callable once a genre has actually been loaded via loadPuzzle().
    var ptr = get_forced_cells_for_desc(paramsStr, descStr);
    var result = UTF8ToString(ptr);
    free_forced_cells(ptr);

    sendMessage("getForcedCellsCallback", result);
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
}

// ---------------------------------------------------------------------
// "Highlight next solvable cells" overlay -- the set of cell indices
// required to complete the next not-yet-checked digit group (the one the
// player should be working on right now), all tinted the same single
// color regardless of whether the player has already filled any of them
// in. Deliberately not fill-state-aware: this must never indicate whether
// an entered digit is correct, only which cells matter for the next
// unlock, so it can't be used to guess-and-check.
// This is pure DOM/CSS on top of the puzzle canvas, not a native drawing
// change: #hintoverlay is an absolutely-positioned, pointer-events:none
// div sitting on top of #puzzlecanvas (see puzzleframe.html), and each
// highlighted cell gets its own child div positioned/sized to match that
// cell's on-screen rectangle.
//
// Geometry: Keen's own C code (keen.c) draws cell (x,y) at physical-pixel
// rect [x*TILESIZE+BORDER, y*TILESIZE+BORDER, TILESIZE, TILESIZE] with
// BORDER = TILESIZE/2, so the whole grid spans (w+1)*TILESIZE physical
// pixels (when TILESIZE is even, which it normally is) -- i.e. exactly
// canvas.width (the canvas's physical backing-store size, which is what
// the native code sizes to). Since CSS-displayed size is just that
// physical size uniformly scaled by canvas.clientWidth/canvas.width, the
// same proportions hold in CSS-pixel space: a CSS "tile size" of
// canvas.clientWidth/(w+1) reproduces the real per-cell rects without
// needing to know the actual physical tilesize or devicePixelRatio at
// all. (When TILESIZE is odd this is off by a fraction of a CSS pixel --
// invisible in practice.)
// ---------------------------------------------------------------------

let hintGridWidth = 0;
let hintCellIndices = [];
let hintResizeObserver = null;

function setHintCells(gridWidth, cellIndices) {
    hintGridWidth = gridWidth;
    hintCellIndices = cellIndices || [];
    ensureHintResizeObserver();
    renderHintOverlay();
}

function renderHintOverlay() {
    const overlay = document.getElementById("hintoverlay");
    const canvas = document.getElementById("puzzlecanvas");
    if (!overlay || !canvas) return;

    overlay.innerHTML = "";

    if (!hintGridWidth || hintCellIndices.length === 0 || !canvas.clientWidth) {
        overlay.style.width = "0px";
        overlay.style.height = "0px";
        return;
    }

    const w = hintGridWidth;
    const cssSize = canvas.clientWidth; // Keen's grid is always square
    overlay.style.width = cssSize + "px";
    overlay.style.height = canvas.clientHeight + "px";

    const tileSize = cssSize / (w + 1);
    const border = tileSize / 2;

    const fragment = document.createDocumentFragment();
    for (const cell of hintCellIndices) {
        const x = cell % w;
        const y = Math.floor(cell / w);
        const div = document.createElement("div");
        div.className = "hint-cell";
        div.style.left = (x * tileSize + border) + "px";
        div.style.top = (y * tileSize + border) + "px";
        div.style.width = tileSize + "px";
        div.style.height = tileSize + "px";
        fragment.appendChild(div);
    }
    overlay.appendChild(fragment);
}

// The puzzle canvas can change size (window resize, or dragging
// #resizehandle) without any message from the parent, so watch it
// directly rather than relying on being told.
function ensureHintResizeObserver() {
    if (hintResizeObserver || typeof ResizeObserver === "undefined") return;
    const canvas = document.getElementById("puzzlecanvas");
    if (!canvas) return;
    hintResizeObserver = new ResizeObserver(() => renderHintOverlay());
    hintResizeObserver.observe(canvas);
}

const messageHandlers = {
    loadPuzzle, setPreset, showPreferences,
    puzzleFromId, puzzleFromSeed,
    newPuzzle, restartPuzzle, undoPuzzle, redoPuzzle, solvePuzzle,
    dialogReturnString, dialogReturnInt, dialogConfirm, dialogCancel,
    setNewGameEnabled,
    savePuzzleData, loadPuzzleData, getForcedCells,
    setHintCells
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
