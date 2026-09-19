const {
    Client, ITEMS_HANDLING_FLAGS, SERVER_PACKET_TYPE, LocationsManager, ReceivedItemsPacket,
    clientStatuses,
    itemsHandlingFlags
} = require("archipelago.js");
const Alpine = require('alpinejs').default;
const $ = require('jquery')
const SaveData = require("./savedata.js");
const {GameSave, getFile, getFileList, openDatabase} = SaveData;
const {config} = require("config")
const {genres, genreInfo} = require("./genres.js")
const {parseKeenDescriptor, buildMaskedDescriptor, touchingCagesByLine, rowColStartCandidates, allLines, seededShuffleCopy, countForcedDigits, mergeNoProgressStages} = require("./keenDivision.js")

document.addEventListener("alpine:init", onInit)

let puzzleframe;
let apReady = false;

// Set to the ArchipelagoPuzzle entry currently being resolved (see
// loadKeenAwarePuzzleEntry() / js_update_permalinks() below) while its
// real descriptor is being discovered via a throwaway, hidden load --
// cleared as soon as js_update_permalinks() reads the result back.
let resolvingKeenEntry = null;

// True for the whole duration of a hidden resolution-pass load (through
// that pass's own js_post_init() call), so js_canvas_set_size() can keep
// the iframe at 0x0 and js_post_init() can skip save-restore/enabling
// controls against a midend that's about to be thrown away. Cleared just
// before the *next* (real, masked-to-the-player) load is kicked off.
let suppressNextReveal = false;

// The exact {w, h} arguments most recently passed to the native
// resize_puzzle(w, h) while the player was dragging the puzzle window's
// resize handle (see puzzleResized below), or null if the player hasn't
// resized (or has right-click-restored to the default size) this
// session. Deliberately module-level rather than per-entry: it survives
// switching puzzles so a manually-chosen size sticks across the whole
// session, matching what the user asked for, but it's in-memory only --
// it does not survive a page reload. Reapplied in js_post_init() after
// every puzzle (re)load, since loadPuzzle() reloads the iframe document
// from scratch each time and so always starts back at the puzzle's
// default size.
let persistedPuzzleSize = null;

/**
 * @type{import("archipelago.js").JSONRecord}
 */
let slotData;

/**
 * @type{Client}
 */
let client;

let remoteSolved = {};

class ArchipelagoPuzzle {
    constructor(options) {
        // Puzzle genre
        this.genre = options.genre;

        // Puzzle generation options (size, difficulty, etc.)
        this.params = options.params;

        // Human-readable puzzle description
        this.desc = "";

        // Puzzle number; also Archipelago region/item number
        this.index = options.index;

        // Puzzle id (params:data)
        this.puzzleId = options.puzzleId;

        // Puzzle seed (genParams#seed)
        this.puzzleSeed = options.puzzleSeed;

        this.solved = options.solved ?? false;
        this.collected = options.collected ?? false;
        this.locked = options.locked ?? false;
        this.item = options.item;
        this.state = "";

        // True when this puzzle isn't solved yet but has at least one
        // unlocked (item-received) Digit Group whose location hasn't
        // been checked -- i.e. there's a clue group the player already
        // has the items for and hasn't finished filling in yet, as
        // opposed to a puzzle that's either fully caught up on
        // everything currently unlocked or hasn't unlocked anything at
        // all. Recomputed in syncAPStatus() (see there for why it only
        // needs item/location state, not this puzzle's own stagePlan).
        // Always false for freeplay puzzles (no digitGroupCount).
        this.hasProgressAvailable = false;

        // Sidebar "(checked/available)" counter: how many of this
        // puzzle's Digit Group locations are checked, and how many are
        // currently reachable at all (checked or not) given "Clue Set"
        // items received so far -- e.g. (5/8) for a puzzle with 5
        // solved groups and 3 more already unlocked but not yet filled
        // in. Recomputed alongside hasProgressAvailable in
        // syncAPStatus(); undefined (shown as nothing) for freeplay
        // puzzles, same as hasProgressAvailable.
        this.checkedGroupCount = 0;
        this.availableGroupCount = 0;

        // Target number of clue-group stages for this puzzle (Archipelago's
        // "N", from slot_data.digit_group_counts); undefined for freeplay
        // puzzles, which have no progressive-reveal concept at all.
        this.digitGroupCount = options.digitGroupCount;

        // Cached client-side division plan for this puzzle instance, filled
        // in once the puzzle's real descriptor is known (see
        // js_update_permalinks handling) -- { achieved, stages } from
        // keenDivision.js's buildStageDescriptors(), plus the resolved full
        // descriptor and grid width it was computed from.
        this.stagePlan = null;

        this.updateDescription();
        this.updateState();
    }

    updateDescription() {
        let name = genreInfo[this.genre].name;

        if (this.params) {
            this.desc = `${name}: ${this.params}`;
        } else {
            this.desc = name;
        }
    }

    updateState() {
        if (this.locked) {
            this.state = "locked";
        } else if (this.solved) {
            this.state = "solved";
        } else {
            this.state = "unlocked";
        }
    }

    onSolve() {
        this.solved = true;
        this.updateState();

        // Sending the actual Archipelago location checks for this puzzle
        // happens in checkDigitGroupProgress() (see js_update_status()),
        // driven by comparing the player's live entered digits against
        // each Digit Group's own solver-forced cells -- not here. This
        // used to call client.check() on a "Puzzle N Reward" location,
        // but no such location exists in Progressive Keen's location table (every
        // location is "Puzzle {i} Digit Group {j}"), so that call was
        // always checking client.check(undefined) and never sent
        // anything.
    }

    static fromArchipelagoString(genreAndParams, baseSeed, index, options) {
        options ??= {};

        const archipelagoStringRegex = /^(?<genre>[^:\n]*)(:(?<params>[^:#\n]*)((?<separator>[:#])?(?<seedOrId>.*)))?$/
        let genreParamsMatch = archipelagoStringRegex.exec(genreAndParams);

        let genre = genreParamsMatch.groups.genre;
        let params = genreParamsMatch.groups.params;
        let separator = genreParamsMatch.groups.separator;
        let seedOrId = genreParamsMatch.groups.seedOrId;

        options.genre = genre;
        options.params = params;
        options.index = index;

        if (separator == ":") {
            options.puzzleSeed = `${params}:${seedOrId}`;
        } else if (separator == "#") {
            options.puzzleId = `${params}#${seedOrId}`;
        } else {
            // Auto-generate seed
            let seedPrefix = ""+index;
            seedPrefix = seedPrefix.padStart(3, "0");
            let seed = `${seedPrefix}${baseSeed}`;
            options.puzzleSeed = `${params}#${seed}`;
        }

        return new ArchipelagoPuzzle(options);
    }

    static fromPuzzlesString(genre, seedOrId, index, options) {
        options ??= {};

        if (seedOrId) {
            let paramsSeparatorMatch = /^([^:#]*)([:#]?)/.exec(seedOrId);

            options.params = paramsSeparatorMatch[1];
            let separator = paramsSeparatorMatch[2];

            if (separator == ":") {
                options.puzzleId = seedOrId;
            } else {
                // also treat string with no separator as seed
                options.puzzleSeed = seedOrId;
            }
        } else {
            options.params = "";
        }

        options.index ??= index;
        options.genre = genre;

        return new ArchipelagoPuzzle(options);
    }
}

function sendMessage(command, ...args) {
    if (puzzleframe) {
        puzzleframe.contentWindow.postMessage([command, ...args])
    }
}

function onInit() {
    console.log("puzzles.html: onInit")

    async function initSaveData() {
        await openDatabase()
        console.log("Savedata open")
        await loadFileList()
        console.log("File list loaded")
    }

    initSaveData();

    initStores()

    // Set up puzzleframe
    puzzleframe = document.getElementById("puzzleframe");

    // puzzleframe will send ["ready"] when initialization is done
}

/**
 * First-time initialization for puzzle data Alpine stores.
 */
function initStores() {
    // List of available puzzles from Archipelago
    Alpine.store("puzzleList", {
        entries: [],
        sortedEntries: [],
        currentIndex: -1,
        current: null,
        solveCount: 0,
        solveTarget: null,
        finished: false,
        sortBySolved: false,
        selectPuzzle(entry) {
            if (!entry) {
                this.currentIndex = -1;
                this.current = null;
                return;
            }

            if ((entry.locked && !Alpine.store("debugMode")) || entry.index == this.currentIndex) {
                return;
            }

            this.currentIndex = entry.index;
            this.current = entry;
            if (entry.puzzleId || entry.puzzleSeed) {
                loadKeenAwarePuzzleEntry(entry);
            } else {
                loadPuzzle(entry.genre, "", false);
            }
        },
        markSolved(puzzle) {
            puzzle ??= this.current

            if (puzzle) {
                puzzle.onSolve();

                if (puzzle == this.current) {
                    savePuzzleData();
                }

                const gamesaves = Alpine.store("gamesaves")

                if (puzzle.index && gamesaves.current) {
                    gamesaves.current.puzzleSolved[puzzle.index-1] = true;
                    gamesaves.current.save();
                    syncAPStatus();
                }

                this.resort();
            }
        },
        resort() {
            // Helper comparison function
            // 0 if a == b; -1 if a < b; 1 if a > b
            // Can be chained with ||
            // Note: this sorts "false" before "true"
            function compare(a,b) {
                if (a < b) return -1;
                else if (a > b) return 1;
                else return 0;
            }

            function sortKey(entry) {
                if (entry.solved) return 1;
                else if (entry.locked) return 2;
                else return 0;
            }

            var sortedEntries = this.entries.slice();
            
            if (this.sortBySolved) {
                sortedEntries.sort((a,b) => compare(sortKey(a), sortKey(b)) || compare(a.id, b.id))
            } else {
                sortedEntries.sort((a,b) => compare(a.id, b.id))
            }

            this.sortedEntries = sortedEntries;

            this.solveCount = this.entries.reduce((a,b) => (b.solved ? a+1 : a), 0)
        },
        onFinishClick() {
            if (this.solveTarget !== null && this.solveCount >= this.solveTarget) {
                client.updateStatus(clientStatuses.goal);
                this.finished = true;
                Alpine.store("gamesaves").markFinished();
            }
        }
    })

    Alpine.store("puzzleList").resort();

    // Various information about the current puzzle
    Alpine.store("puzzleState", {
        onSolve() {
            this.solved = true;
        },
        undoEnabled: false,
        redoEnabled: false,
        solveEnabled: true,
        primaryKeyLabel: "",
        secondaryKeyLabel: "",
        loaded: false,
        solved: false,
        status: 0,
        genre: null,
        genreInfo: genreInfo["none"],
        gameId: "",
        gameSeed: "",
        // Whether the player wants the "highlight next digit group"
        // overlay shown (see toggleNextGroupHighlight()). Deliberately
        // NOT reset by reset() below, so the preference persists across
        // puzzle switches -- a fresh iframe document never carries the
        // previous one's overlay over regardless, so js_post_init()
        // re-sends it for the newly-loaded puzzle whenever this is true
        // (see refreshNextGroupHighlight()).
        highlightingNextGroup: false,
        reset() {
            this.solved = false;
            this.undoEnabled = false;
            this.redoEnabled = false;
            this.solveEnabled = true;
            this.primaryKeyLabel = "";
            this.secondaryKeyLabel = "";
            this.loaded = false;
            this.solved = false;
            this.status = 0;
            this.genre = null;
            this.genreInfo = genreInfo["none"];
            this.gameId = "";
            this.gameSeed = "";
        }
    })

    // A variable to store whether the current puzzle should be played as a fixed puzzle
    // (i.e. disable the Solve button and new game shortcuts)
    Alpine.store("singleMode", false)

    // List of presets for the current puzzle
    // [{id: Int, name: String}]
    Alpine.store("puzzlePresets", [])

    // Dialog box displayed by puzzle midend
    Alpine.store("puzzleDialog", {
        controls: [],
        visible: false,
        addControl(index, type, title, initialValue, choices) {
            if (type == "choice") {
                this.controls.push({index, type, title, value: initialValue, choices})
            } else {
                this.controls.push({index, type, title, value: initialValue})
            }
        },
        confirm: dialogConfirm,
        cancel: dialogCancel,
        dismiss() {
            this.controls = [];
            this.visible = false;
        }
    })

    // Error message displayed by puzzle midend
    Alpine.store("errorMessage", {
        message: "",
        visible: false,
        show(message) {
            this.message = message;
            this.visible = true;
        },
        dismiss() {
            this.visible = false;
        }
    })

    // Puzzle status bar
    Alpine.store("status", {
        message: "",
        visible: false,
        set(value) {
            this.message = value;
            this.visible = true;
        },
        hide() {
            this.message = "";
            this.visible = false;
        }
    })

    // Chat box
    Alpine.store("chatbox", {
        collapsed: true,
        unreadCount: 0,
        composeText: "",
        messages: [],
        messageCount: 0,
        toggleCollapsed() {
            this.collapsed = !this.collapsed;

            if (!this.collapsed) {
                this.scrollToBottom(true)
            }
        },
        appendMessage(message) {
            message.id = this.messageCount++;

            this.messages.push(message)

            const messageLimit = 1000;

            if (this.messages.length > messageLimit) {
                this.messages = this.messages.slice(this.messages.length - messageLimit)
            }

            // TODO: separate notification for priority messages?
            // if (message.highlight || message.type == 'chat') {
            //     this.unreadCount++;
            // }
            this.unreadCount++;
            this.scrollToBottom(false)
        },
        scrollToBottom(force) {
            let isPinned = false;

            if (force) {
                isPinned = true;
            } else {
                let elem = $("#chat-history");
                if (elem.length == 0) return;

                // Check if we are scrolled to the bottom
                const scrollPinHeight = 10
                if (elem.scrollTop() + elem.innerHeight() >= elem[0].scrollHeight - scrollPinHeight) {
                    isPinned = true;
                }
            }

            if (isPinned) {
                this.unreadCount = 0;

                // Wait until next tick so any new messages can render
                Alpine.nextTick(() => {
                    let elem = $("#chat-history");
                    elem.scrollTop(elem[0].scrollHeight);
                })
            }
        },
        appendEcho(text) {
            this.appendMessage({type: 'echo', data: [{text: text}], highlight: false})
        },
        sendChat(text) {
            sendChat(text)
            this.scrollToBottom(true)
            this.composeText = "";
        }
    })

    // Widget to load puzzles on-demand
    // TODO make this with proper UI
    Alpine.store("debugLoader", {
        genre: "net",
        id: "",
        singleMode: false,
        showUnsupported: false,
        load() {
            Alpine.store("puzzleList").selectPuzzle(null);
            loadPuzzle(this.genre, this.id, this.singleMode);
        }
    })

    Alpine.store("connectionInfo", {
        hostname: config.defaultHost,
        port: "38281",
        player: "Player1",
        password: "",
        connect() {
            createFile(this.hostname, +this.port, this.player, this.password);
        },
        replaceConnectionInfo() {
            let currentFile = Alpine.store("gamesaves").current;
            let newConnection = {
                host: this.hostname,
                port: +this.port,
                player: this.player,
                password: this.password
            }
            if (currentFile && currentFile.id != -1) {
                loadFile(currentFile, false, newConnection)
            }
        }
    })

    // TODO a lot of this should be moved to connectionInfo (possibly all of it)
    Alpine.store("gamesaves", {
        list: [],
        current: null,
        apError: false,
        connecting: false,
        connected: false,
        loadFile(file, secretMode) {
            loadFile(file, secretMode);
        },
        deleteFile(file) {
            // TODO proper confirmation dialog
            if (confirm(`${file.toString()}: Delete this file?`)) {
                deleteFile(file)
            }
        },
        markFinished() {
            if (this.current) {
                this.current.finished = true;
                this.current.save();
            }
        }
    })

    Alpine.store("genres", genres)

    Alpine.store("config", config)

    resetPuzzleMetadata();
}

/**
 * Reset all puzzle metadata when loading a new puzzle.
 */
function resetPuzzleMetadata() {
    Alpine.store("puzzleState").reset();
    Alpine.store("puzzlePresets", []);
    Alpine.store("puzzleDialog").dismiss();
    Alpine.store("status").hide();
    Alpine.store("errorMessage").dismiss();
}

/**
 * Number of "Puzzle {index} Clue Set" items received so far for a given
 * puzzle -- i.e. how many clue groups are unlocked for that puzzle. Per
 * rules.py, Digit Group 1 itself requires >= 1 copy, so 0 items means 0
 * clue groups visible (a fully masked puzzle), not "clue group 1 for
 * free"; the client mirrors that literally rather than special-casing
 * the first stage.
 */
function countReceivedClueSets(index) {
    if (!isApReady()) return 0;
    const itemId = itemNameToId(`Puzzle ${index} Clue Set`);
    if (itemId === undefined) return 0;
    return client.items.received.filter(e => e.id === itemId).length;
}

/**
 * Given a resolved stage plan (see resolveKeenStagePlan) and a count of
 * unlocked clue groups, the descriptor to actually display: 'n' for every
 * cage when unlockedCount is 0, otherwise the (achieved-clamped) stage's
 * cumulative masked descriptor.
 */
function keenDescriptorForCount(plan, unlockedCount) {
    if (unlockedCount <= 0) {
        return buildMaskedDescriptor(plan.parsed, []);
    }
    const stageIndex = Math.min(unlockedCount, plan.achieved) - 1;
    return plan.stages[stageIndex].descriptor;
}

/**
 * Decide which additional clues to reveal for the next progressive-
 * reveal stage of a Keen puzzle, given what's visible so far and how
 * many digits that already forces (prevForced). Always prefers
 * whichever candidate forces the FEWEST new digits over prevForced
 * (never just the first one that works), searching in order of
 * increasing granularity -- lines first, individual cages only as a
 * fallback:
 *
 *   1. Every remaining single line (row or column) that isn't already
 *      fully visible -- if any forces a new digit, take whichever one
 *      forces the fewest.
 *   2. Otherwise, every remaining-row + remaining-column pair (mirrors
 *      rowColStartCandidates()'s own stage-1 search, restricted to
 *      lines that aren't already fully visible) -- take whichever
 *      forces the fewest new digits.
 *   3. Otherwise, drop from *lines* down to individual *cages*. A line
 *      always drags along every cage it touches, and some puzzles have
 *      a cage sprawling across most of the grid (or several cages
 *      packed into just a few lines), so a line-sized reveal can
 *      expose far more of the puzzle than was actually needed for even
 *      one new deduction -- this is what a real reported puzzle hit:
 *      the first stage's minimal *line* pick still dragged in 14 of 16
 *      cages. So once no single line or line pair helps at all, search
 *      for the smallest *cage* subset that does: every remaining
 *      single cage, then every remaining cage pair, then (if truly
 *      nothing that small works) add remaining cages one at a time in
 *      random order until something helps or every cage's been added
 *      -- which always finishes the puzzle.
 *
 * Whichever level above found a qualifying candidate, its cage set is
 * then locally minimized before being returned: cages are tried for
 * removal one at a time (from the end backwards), keeping each removal
 * that still leaves the candidate forcing more than prevForced. This
 * matters most for the cage-plateau fallback, whose random incremental
 * order can otherwise land on a wildly non-minimal superset -- for the
 * real reported puzzle above, the plateau's raw result before this
 * step was 15 of 16 cages, even though an exhaustive search found a
 * qualifying 6-cage subset. The shrink pass alone got that puzzle's
 * first stage down to exactly 6 cages. It's not guaranteed to find the
 * true global minimum (it only ever removes cages from whatever
 * candidate a level above already found), but it's cheap -- at most
 * one solve per cage in the candidate -- and it never leaves in a cage
 * that turns out not to matter.
 *
 * If the currently-visible set already forces the entire grid (nothing
 * left for any reveal to gain), skips straight to adding one random
 * remaining line (or, once every line is already fully visible, one
 * random remaining cage) without probing any candidates --
 * mergeNoProgressStages() cleans up the resulting no-op stage
 * afterward regardless of what got picked.
 *
 * Returns { cageIds, forced, forcedDigits, level } for the chosen
 * reveal (cageIds is just the *added* cage ids, not the cumulative
 * visible set), or null if there is nothing left to reveal at all.
 */
async function chooseNextStageReveal(parsed, paramsStr, visible, cagesForLine, prevForced, seedInput) {
    const w = parsed.w;
    const lineFullyVisible = (line) => [...cagesForLine(line)].every(id => visible.has(id));
    const remainingLines = allLines(w).filter(l => !lineFullyVisible(l));
    const remainingCages = parsed.cageOrder.filter(id => !visible.has(id));

    if (remainingLines.length === 0 && remainingCages.length === 0) return null;

    const evaluateCages = async (cageIds) => {
        const candidateVisible = new Set(visible);
        for (const id of cageIds) candidateVisible.add(id);
        const forcedDigits = await getForcedDigits(paramsStr, buildMaskedDescriptor(parsed, candidateVisible));
        return { cageIds, forced: countForcedDigits(forcedDigits), forcedDigits };
    };
    const evaluateLines = async (lines) => {
        const cageIds = [];
        const seen = new Set();
        for (const line of lines) {
            for (const id of cagesForLine(line)) {
                if (!seen.has(id)) { seen.add(id); cageIds.push(id); }
            }
        }
        return await evaluateCages(cageIds);
    };
    // Whatever level found a qualifying candidate, its cage set may
    // still contain cages that weren't actually necessary for the new
    // deduction (a line/pair drags in every cage it touches, and even
    // the cage-plateau's random incremental order can overshoot the
    // true minimal subset by a lot -- a real reported puzzle's minimal
    // qualifying subset was just 6 cages, but the plateau's random
    // order didn't stumble onto a small one until 15 of 16 cages were
    // in). Locally minimize: repeatedly try dropping each cage (from
    // the end backwards) and keep the drop if the remaining set still
    // forces more than prevForced. This can't find the smallest
    // possible subset in general, but it always removes every cage
    // that turns out not to matter for this particular candidate.
    const shrinkCandidate = async (candidate) => {
        let working = candidate.cageIds.slice();
        for (let i = working.length - 1; i >= 0 && working.length > 1; i--) {
            const trial = working.slice(0, i).concat(working.slice(i + 1));
            const outcome = await evaluateCages(trial);
            if (outcome.forced > prevForced) working = trial;
        }
        if (working.length === candidate.cageIds.length) return candidate;
        return await evaluateCages(working);
    };

    if (prevForced >= w * w) {
        if (remainingLines.length > 0) {
            const line = seededShuffleCopy(remainingLines, `${seedInput}:already-solved`)[0];
            return { ...(await evaluateLines([line])), level: 'already-solved' };
        }
        const cageId = seededShuffleCopy(remainingCages, `${seedInput}:already-solved-cage`)[0];
        return { ...(await evaluateCages([cageId])), level: 'already-solved' };
    }

    // Level 1: every remaining single line -- take the smallest reveal.
    let best = null;
    for (const line of seededShuffleCopy(remainingLines, `${seedInput}:line`)) {
        const outcome = await evaluateLines([line]);
        if (outcome.forced > prevForced && (!best || outcome.forced < best.forced)) best = outcome;
    }
    if (best) return { ...(await shrinkCandidate(best)), level: 1 };

    // Level 2: every remaining-row + remaining-column pair.
    const remainingRows = new Set(remainingLines.filter(l => l.type === 'row').map(l => l.index));
    const remainingCols = new Set(remainingLines.filter(l => l.type === 'col').map(l => l.index));
    if (remainingRows.size > 0 && remainingCols.size > 0) {
        const pairCandidates = rowColStartCandidates(parsed, `${seedInput}:pair`)
            .filter(c => remainingRows.has(c.row) && remainingCols.has(c.col));
        for (const cand of pairCandidates) {
            const outcome = await evaluateLines([{ type: 'row', index: cand.row }, { type: 'col', index: cand.col }]);
            if (outcome.forced > prevForced && (!best || outcome.forced < best.forced)) best = outcome;
        }
    }
    if (best) return { ...(await shrinkCandidate(best)), level: 2 };

    // Level 3: no line or line-pair helps at all -- fall back to
    // individual cages, which can never drag in more than what's
    // actually asked for.
    if (remainingCages.length === 0) return null;

    for (const cageId of seededShuffleCopy(remainingCages, `${seedInput}:cage`)) {
        const outcome = await evaluateCages([cageId]);
        if (outcome.forced > prevForced && (!best || outcome.forced < best.forced)) best = outcome;
    }
    if (best) return { ...(await shrinkCandidate(best)), level: '3-cage' };

    for (let i = 0; i < remainingCages.length; i++) {
        for (let j = i + 1; j < remainingCages.length; j++) {
            const outcome = await evaluateCages([remainingCages[i], remainingCages[j]]);
            if (outcome.forced > prevForced && (!best || outcome.forced < best.forced)) best = outcome;
        }
    }
    if (best) return { ...(await shrinkCandidate(best)), level: '3-cage-pair' };

    // Genuine plateau even at cage granularity -- add remaining cages
    // one at a time, in random order, until something helps or
    // everything's been added (which reproduces the full descriptor
    // and therefore always finishes the puzzle).
    const accumulated = [];
    let lastOutcome = null;
    for (const cageId of seededShuffleCopy(remainingCages, `${seedInput}:cage-random`)) {
        accumulated.push(cageId);
        lastOutcome = await evaluateCages(accumulated.slice());
        if (lastOutcome.forced > prevForced) return { ...(await shrinkCandidate(lastOutcome)), level: '3-cage-plateau' };
    }
    return { ...(await shrinkCandidate(lastOutcome)), level: '3-cage-plateau-full' };
}

/**
 * Parse a just-resolved full game id (as reported by js_update_permalinks,
 * "<params>:<descriptor>") and cache this puzzle's clue-group division
 * plan on the entry, so future loads/reveals for this puzzle instance
 * never need another hidden WASM resolution pass -- everything from here
 * on is pure-JS re-masking of the same parsed structure.
 *
 * Each stage's reveal is chosen by chooseNextStageReveal() above (lines
 * first, falling back to individual cages), except the very last stage
 * the world's digit_group_count allows, which always takes every still-
 * hidden cage at once regardless of what a smaller reveal would do --
 * this is what guarantees a player holding every Clue Set item for a
 * puzzle always sees the complete thing, not a partially-clued dead
 * end. mergeNoProgressStages() is still run as a final defensive pass,
 * though by construction every non-final stage here should already
 * strictly increase its forced-digit count over the last.
 */

async function resolveKeenStagePlan(entry, gameId) {
    const colonIndex = gameId.indexOf(':');
    if (colonIndex === -1) {
        throw new Error(`Expected a full game id ("params:desc"), got: ${gameId}`);
    }
    const paramsStr = gameId.slice(0, colonIndex);
    const desc = gameId.slice(colonIndex + 1);
    const widthMatch = /^\d+/.exec(paramsStr);
    if (!widthMatch) {
        throw new Error(`Couldn't read grid width from params string: ${paramsStr}`);
    }
    const w = parseInt(widthMatch[0], 10);

    const parsed = parseKeenDescriptor(desc, w);
    const targetGroups = Math.max(1, Math.floor(entry.digitGroupCount || 1));
    const allCageIds = parsed.cageOrder;

    if (targetGroups <= 1 || allCageIds.length === 0) {
        // No progressive reveal for this puzzle -- one stage, the whole
        // thing, matching divideCages()'s own n<=1 behaviour.
        const fullDescriptor = buildMaskedDescriptor(parsed, allCageIds);
        const fullForcedDigits = await getForcedDigits(paramsStr, fullDescriptor);
        entry.stagePlan = {
            paramsStr, w, parsed, achieved: 1,
            stages: [{ cageIds: new Set(allCageIds), descriptor: fullDescriptor, forcedDigits: fullForcedDigits }],
        };
        return;
    }

    const { rows: touchingByRow, cols: touchingByCol } = touchingCagesByLine(parsed);
    const cagesForLine = (line) => (line.type === 'row' ? touchingByRow[line.index] : touchingByCol[line.index]);

    const visible = new Set();
    const stages = [];
    const forcedCounts = [];

    while (stages.length < targetGroups) {
        const prevForced = forcedCounts.length > 0 ? forcedCounts[forcedCounts.length - 1] : 0;
        const isFinalAllowedStage = stages.length === targetGroups - 1;

        let chosenCageIds, chosenForced, chosenForcedDigits;

        if (isFinalAllowedStage) {
            // The last stage the world's digit_group_count allows must be
            // the complete puzzle regardless of what a smaller reveal
            // would do -- take every still-hidden cage at once,
            // guaranteeing a player holding every Clue Set item for this
            // puzzle always sees the complete thing (see the doc comment
            // on chooseNextStageReveal() above for why this can't be
            // left to the general search).
            const remainingCageIds = allCageIds.filter(id => !visible.has(id));
            if (remainingCageIds.length === 0) break;
            chosenCageIds = remainingCageIds;
            const candidateVisible = new Set(visible);
            for (const id of chosenCageIds) candidateVisible.add(id);
            chosenForcedDigits = await getForcedDigits(paramsStr, buildMaskedDescriptor(parsed, candidateVisible));
            chosenForced = countForcedDigits(chosenForcedDigits);
        } else {
            const outcome = await chooseNextStageReveal(
                parsed, paramsStr, visible, cagesForLine, prevForced, `${gameId}:${stages.length}`);
            if (!outcome) break;
            chosenCageIds = outcome.cageIds;
            chosenForced = outcome.forced;
            chosenForcedDigits = outcome.forcedDigits;
        }

        for (const id of chosenCageIds) visible.add(id);
        stages.push({ cageIds: new Set(visible), descriptor: buildMaskedDescriptor(parsed, visible), forcedDigits: chosenForcedDigits });
        forcedCounts.push(chosenForced);
    }

    const mergedStages = mergeNoProgressStages(stages, forcedCounts);

    entry.stagePlan = { paramsStr, w, parsed, achieved: mergedStages.length, stages: mergedStages };
}

/**
 * The full game id to actually hand to loadPuzzle() for an already-resolved
 * progressive Keen entry: the currently-unlocked cumulative clue set,
 * re-rendered as a full ("params:desc") descriptor so the WASM module
 * displays exactly (and only) what the player has earned so far.
 */
function keenVisibleId(entry) {
    const plan = entry.stagePlan;
    const unlockedCount = isApReady() ? countReceivedClueSets(entry.index) : plan.achieved;
    // Track what's actually been baked into the id just returned, so
    // liveRevealClues() below knows whether an in-place reveal is
    // still needed the next time an item comes in (or can tell it's
    // already caught up and skip doing anything).
    entry.displayedClueCount = Math.min(unlockedCount, plan.achieved);
    return `${plan.paramsStr}:${keenDescriptorForCount(plan, unlockedCount)}`;
}

/**
 * Push any newly-unlocked clues for `entry` into its puzzle frame *in
 * place*, if (and only if) `entry` is the puzzle currently open and
 * new clues have actually arrived since it was last loaded/reveal.
 * Two callers:
 *   - syncAPStatus() (see onReceiveItems()), so an already-open puzzle
 *     updates live the moment a new "Clue Set" item comes in, instead
 *     of requiring the player to back out to the list and reselect
 *     the puzzle to see it (the previous behavior).
 *   - loadPuzzleData(), right after restoring a manual "Save puzzle
 *     progress" save, to catch up a puzzle that was saved (and thus
 *     had fewer clues visible) before more Clue Set items were
 *     unlocked for it elsewhere -- otherwise the just-restored midend
 *     would be stuck showing only whatever was visible at save time
 *     forever, since loadPuzzle() deliberately never sends a fresh
 *     visible id once it sees a save exists (see loadPuzzle()'s
 *     "Don't bother sending ID if save data exists").
 *
 * Deliberately does NOT go through loadPuzzle()/keenVisibleId() --
 * that reloads the whole iframe, which (since there's no *automatic*
 * saving of in-progress digit entries as the player types -- only the
 * explicit "Save puzzle progress" button, or a full solve) would throw
 * away whatever the player has typed since their last manual save.
 * Instead this calls the native reveal_clues() hook (see
 * keen.c/puzzles.h), which updates the live midend's own clue data
 * directly and redraws, leaving the player's entered grid untouched.
 */
async function liveRevealClues(entry) {
    const plan = entry.stagePlan;
    if (!plan) return;

    const unlockedCount = Math.min(countReceivedClueSets(entry.index), plan.achieved);
    if (unlockedCount <= (entry.displayedClueCount || 0)) return;

    const desc = keenDescriptorForCount(plan, unlockedCount);
    const err = await revealClues(desc);
    if (err) {
        console.error(`Failed to reveal new clues for puzzle ${entry.index} in place`, err);
        return;
    }
    entry.displayedClueCount = unlockedCount;
}

/**
 * Entry point for loading any puzzle that might be a progressive-reveal
 * Keen puzzle: freeplay puzzles and non-Keen genres load exactly as
 * before. A Keen puzzle from Archipelago (entry.digitGroupCount is set)
 * whose real descriptor we don't know yet gets a hidden "resolution"
 * pass first (see js_update_permalinks below) -- the seed-based id the
 * server gave us only tells WASM how to *generate* the puzzle, and the
 * clue-division algorithm needs the actual resulting cages, which only
 * exist once that generation has happened once.
 */
function loadKeenAwarePuzzleEntry(entry) {
    const isProgressiveKeen = entry.genre === "keen" && entry.digitGroupCount !== undefined;

    if (!isProgressiveKeen) {
        loadPuzzle(entry.genre, entry.puzzleId || entry.puzzleSeed, true, entry.index);
        return;
    }

    if (entry.stagePlan) {
        loadPuzzle(entry.genre, keenVisibleId(entry), true, entry.index);
        return;
    }

    resolvingKeenEntry = entry;
    suppressNextReveal = true;
    // Deliberately pass no saveKey here (unlike every other
    // loadPuzzle() call in this function): loadPuzzle() skips sending
    // its id whenever it sees a save exists for the given saveKey,
    // trusting that js_post_init()'s loadPuzzleData() will restore the
    // real state right after -- but suppressNextReveal makes
    // js_post_init() return early and skip loadPuzzleData()
    // entirely for this hidden pass. Without this, a puzzle that was
    // saved in an earlier session (so entry.stagePlan hasn't been
    // computed yet *this* session) would have its id silently dropped
    // here, and the hidden pass would resolve a clue-group plan
    // against whatever unrelated random puzzle the WASM module
    // defaults to with no id at all -- permanently corrupting
    // entry.stagePlan for this puzzle for the rest of the session
    // (every later reveal would then be checked against the wrong
    // block structure and rejected). The real save still gets
    // restored correctly by the second, non-hidden loadPuzzle() call
    // below once resolution finishes (see the resolvingKeenEntry
    // branch in js_update_permalinks), which does pass entry.index.
    loadPuzzle(entry.genre, entry.puzzleId || entry.puzzleSeed, true, null);
}

async function loadPuzzle(genre, id, singleMode, saveKey) {
    let debugLoader = Alpine.store("debugLoader");
    let puzzleState = Alpine.store("puzzleState");

    if (!genre) {
        id = undefined;
        singleMode = true;
    }

    resetPuzzleMetadata();
    debugLoader.genre = genre;
    debugLoader.id = id;
    debugLoader.singleMode = !!singleMode;
    puzzleState.genre = genre;
    puzzleState.genreInfo = genreInfo[genre || "none"];

    Alpine.store("singleMode", !!singleMode)

    const puzzleFrameBase = "puzzleframe.html";

    const gamesaves = Alpine.store("gamesaves");

    let hasSave = false;

    if (gamesaves.current && saveKey !== null && saveKey !== undefined) {
        let saveData = await gamesaves.current.getPuzzleSave(saveKey);
        if (saveData) {
            hasSave = true;
        }
    }

    let queryFragments = [];

    if (genre) {
        queryFragments.push({key: "g", value: genre});
    }
    // Don't bother sending ID if save data exists
    if (id && !hasSave) {
        queryFragments.push({key: "i", value: id});
    }
    if (singleMode || !genre) {
        queryFragments.push({key: "s", value: "true"});
    }
    // Thread a manually-resized window size through as query params
    // rather than replaying it via a postMessage round trip after the
    // iframe loads (see puzzleResized()/js_post_init() below for the
    // capture side, which is unchanged). The iframe applies this
    // synchronously, in the same call as its own default-size logic
    // (see the end of post_init() in emccpre-ap.js) -- avoiding a race
    // between "apply the puzzle's own default size" and "apply the
    // persisted size" that a purely message-based replay is exposed to
    // (confirmed by a real report: swapping between two 9x9 puzzles
    // sometimes landed on a size larger than what was persisted,
    // consistent with the default-size message occasionally winning
    // that race instead of the replay).
    if (genre && persistedPuzzleSize) {
        queryFragments.push({key: "rw", value: String(persistedPuzzleSize.w)});
        queryFragments.push({key: "rh", value: String(persistedPuzzleSize.h)});
    }

    let queryString = queryFragments.map(e => `${e.key}=${encodeURIComponent(e.value)}`).join("&");

    puzzleframe.src = null;
    puzzleframe.src = `${puzzleFrameBase}?${queryString}`;
    puzzleframe.width = 0;
    puzzleframe.height = 0;
}

async function clearPuzzle() {
    return await loadPuzzle("");
}

//
// puzzleFrame message handlers
//

function onPuzzleFrameLoad() {
    console.log("puzzles.html: puzzleframe ready")
}

function js_init_puzzle() {
    
}

function js_post_init() {
    if (suppressNextReveal) {
        // Hidden resolution pass (see loadKeenAwarePuzzleEntry): this
        // midend is about to be thrown away and reloaded with the
        // player's actual currently-unlocked clues, so don't restore/save
        // progress or enable controls against it.
        return;
    }
    // A persisted resize (if any) is applied inside the iframe itself,
    // synchronously at boot, from the rw/rh query params loadPuzzle()
    // added above -- see the end of post_init() in emccpre-ap.js. No
    // reply needed from here.
    loadPuzzleData();
    Alpine.store("puzzleState").loaded = true;
    // Re-send the "highlight next digit group" overlay for this
    // freshly-loaded puzzle if the player had it turned on -- see
    // refreshNextGroupHighlight()'s doc comment for why this is needed
    // at all (a fresh iframe never carries the previous one's overlay
    // over, even though the on/off preference itself now persists).
    refreshNextGroupHighlight(Alpine.store("puzzleList").current);
}

// The iframe reports back here (see the puzzleResized sendMessage calls
// added to ap-sgtpuzzles/emccpre-ap.js's resize-handle drag/restore
// handlers) whenever the player finishes dragging the puzzle window's
// resize corner, or right-clicks it to restore the default size. w/h
// are the exact raw arguments the native resize_puzzle(w, h) was just
// called with (not derived/recomputed here), so replaying them via
// js_post_init() above reproduces the same size exactly; null/null
// means "restored to default", i.e. stop persisting a size at all.
function puzzleResized(w, h) {
    persistedPuzzleSize = (w === null || h === null) ? null : {w, h};
}

function js_enable_undo_redo(enableUndo, enableRedo) {
    Alpine.store("puzzleState").undoEnabled = !!enableUndo
    Alpine.store("puzzleState").redoEnabled = !!enableRedo
}

function js_remove_solve_button() {
    Alpine.store("puzzleState").solveEnabled = false;
}

function js_update_permalinks(gameId, gameSeed) {
    let puzzleState = Alpine.store("puzzleState");
    puzzleState.gameId = gameId;
    puzzleState.gameSeed = gameSeed;

    if (resolvingKeenEntry) {
        const entry = resolvingKeenEntry;
        resolvingKeenEntry = null;

        (async () => {
            try {
                await resolveKeenStagePlan(entry, gameId);
            } catch (e) {
                console.error(`Failed to compute clue-group division for puzzle ${entry.index}`, e);
            }

            // suppressNextReveal must stay true until this (hidden,
            // about-to-be-thrown-away) pass's own js_post_init() has
            // already fired -- main() calls update_permalinks() before
            // js_post_init(). Every getForcedDigits() call inside
            // resolveKeenStagePlan() is a real cross-frame postMessage
            // round trip, so by the time we get here (whether that loop
            // ran zero or several iterations) any already-queued
            // js_post_init message from this same pass is guaranteed to
            // have already been delivered and handled.
            suppressNextReveal = false;
            if (entry.stagePlan) {
                loadPuzzle(entry.genre, keenVisibleId(entry), true, entry.index);
            } else {
                // Resolution failed -- fall back to showing the full
                // puzzle rather than getting stuck on a blank frame.
                loadPuzzle(entry.genre, entry.puzzleId || entry.puzzleSeed, true, entry.index);
            }
        })();
    }
}

function js_update_status(newStatus) {
    let puzzleState = Alpine.store("puzzleState");
    puzzleState.status = newStatus;
    if (puzzleState.status == 1 && !puzzleState.solved) {
        console.log("woo hoo")
        puzzleState.solved = true
        Alpine.store("puzzleList").markSolved()
    }

    // Called after every move (including undo/redo, and once right after
    // initial load -- see post_move() in emcc-ap.c), so this is the right
    // hook for sending Digit Group checks the moment the player's live
    // entries actually satisfy them, rather than waiting on the engine's
    // own "fully solved, no errors" signal above (which only fires for a
    // complete, unmasked solve and can't tell individual digit groups
    // apart). Guarded by suppressNextReveal so it never fires during the
    // hidden, throwaway resolution pass used to compute a Keen puzzle's
    // stage plan.
    if (!suppressNextReveal) {
        checkDigitGroupProgress(Alpine.store("puzzleList").current);
    }
}

function js_update_key_labels(pcl, scl) {
    let puzzleState = Alpine.store("puzzleState");
    puzzleState.primaryKeyLabel = pcl;
    puzzleState.secondaryKeyLabel = scl;
}

function js_add_preset(menuId, name, id) {
    let newPreset = {menuId, name, id}
    Alpine.store("puzzlePresets").push(newPreset)
}

function js_add_preset_submenu() {
    // Deal with this later
}

function js_select_preset(id) {
    // idk
}

function js_dialog_init() {
    const dialog = Alpine.store("puzzleDialog");
    dialog.controls = [];
}

function js_dialog_string(index, title, initvalue) {
    Alpine.store("puzzleDialog").addControl(index, "string", title, initvalue)
}

function js_dialog_choices(index, title, choiceStr, initvalue) {
    // Split choiceStr by its first character
    let choices = choiceStr.split(choiceStr[0])
    choices.shift()

    Alpine.store("puzzleDialog").addControl(index, "choice", title, initvalue, choices)
}

function js_dialog_boolean(index, title, initvalue) {
    Alpine.store("puzzleDialog").addControl(index, "boolean", title, !!initvalue)
}

function js_dialog_launch() {
    Alpine.store("puzzleDialog").visible = true;
}

function js_dialog_cleanup() {
    Alpine.store("puzzleDialog").dismiss();
}

function js_canvas_set_statusbar(value) {
    Alpine.store("status").set(value);
}

function js_canvas_remove_statusbar() {
    Alpine.store("status").hide();
}

function js_canvas_set_size(w, h) {
    if (suppressNextReveal) {
        // Hidden resolution pass -- keep the iframe collapsed so the
        // player never sees the fully-clued puzzle this pass generates.
        return;
    }
    puzzleframe.width = w / window.devicePixelRatio;
    puzzleframe.height = h / window.devicePixelRatio;
}

function js_focus_canvas() {

}

function js_error_box(message) {
    Alpine.store("errorMessage").show(message)
}

function savePuzzleDataCallback(data) {
    console.log("Save file ready")
    
    const gamesaves = Alpine.store("gamesaves");
    const puzzleList = Alpine.store("puzzleList");
    if (!gamesaves.current || !puzzleList.current) return;

    gamesaves.current.setPuzzleSave(puzzleList.current.index, data)
}

// Ask the puzzleframe what a (possibly partial) params/desc pair already
// forces, via the game's own unmodified solver (currently implemented
// only for Keen). Returns a promise resolving to a string of w*w digit
// characters ('0' = undetermined), or null if the current genre doesn't
// support this. Only one such request can be in flight at a time, since
// there is a single shared puzzleframe iframe.
let pendingForcedDigitsResolve = null;

function getForcedDigitsCallback(result) {
    if (pendingForcedDigitsResolve) {
        let resolve = pendingForcedDigitsResolve;
        pendingForcedDigitsResolve = null;
        resolve(result);
    }
}

function getForcedDigits(paramsStr, desc) {
    return new Promise((resolve) => {
        pendingForcedDigitsResolve = resolve;
        sendMessage("getForcedDigits", paramsStr, desc);
    });
}

// Same one-request-at-a-time pattern as getForcedDigits() above, for
// reading the live, currently-displayed puzzle's actual entered digits
// (see getCurrentGrid() in static/puzzleframe.js). Used by
// checkDigitGroupProgress() below.
let pendingCurrentGridResolve = null;

function getCurrentGridCallback(result) {
    if (pendingCurrentGridResolve) {
        let resolve = pendingCurrentGridResolve;
        pendingCurrentGridResolve = null;
        resolve(result);
    }
}

function getCurrentGrid() {
    return new Promise((resolve) => {
        pendingCurrentGridResolve = resolve;
        sendMessage("getCurrentGrid");
    });
}

// Same one-request-at-a-time pattern again, for pushing newly-unlocked
// clues into the live, currently-loaded puzzle in place (see
// revealClues() in static/puzzleframe.js). Resolves to null on
// success, or an error string on failure. Used by liveRevealClues()
// below.
let pendingRevealCluesResolve = null;

function revealCluesCallback(result) {
    if (pendingRevealCluesResolve) {
        let resolve = pendingRevealCluesResolve;
        pendingRevealCluesResolve = null;
        resolve(result);
    }
}

function revealClues(desc) {
    return new Promise((resolve) => {
        pendingRevealCluesResolve = resolve;
        sendMessage("revealClues", desc);
    });
}

const messageHandlers = {
    ready: onPuzzleFrameLoad, js_init_puzzle, js_post_init,
    js_update_permalinks, js_enable_undo_redo, js_remove_solve_button, js_update_status, js_update_key_labels,
    js_add_preset, js_add_preset_submenu, js_select_preset,
    js_dialog_init, js_dialog_string, js_dialog_choices, js_dialog_boolean, js_dialog_launch, js_dialog_cleanup,
    js_canvas_set_statusbar, js_canvas_remove_statusbar, js_canvas_set_size, js_error_box, js_focus_canvas,
    savePuzzleDataCallback, getForcedDigitsCallback, getCurrentGridCallback,
    revealCluesCallback, loadPuzzleDataCallback, restartPuzzleCallback, puzzleResized
}

function processMessage(message) {
    if (!message.data[Symbol.iterator]) return;

    let [command, ...args] = message.data

    if (command) {
        let handler = messageHandlers[command]
        if (handler) {
            handler(...args)
        } else {
            console.log("to puzzles.html:", message.data)
            console.warn("No handler found for message", message.data[0])
        }
    }
}

window.onmessage = processMessage

//
// UI functions
//

function showPreferences() {
    sendMessage("showPreferences");
}

function newPuzzle() {
    sendMessage("newPuzzle");
    Alpine.store("puzzleState").solved = false;
}

function puzzleFromId() {
    sendMessage("puzzleFromId")
}

function puzzleFromSeed() {
    sendMessage("puzzleFromSeed")
}

// Resolved once the iframe confirms a just-sent "restartPuzzle" has
// actually landed (see restartPuzzleCallback below) -- needed so
// restartPuzzle() can reliably re-reveal clues only after the restarted
// game state is actually live, not merely dispatched.
let pendingRestartPuzzleResolve = null;

function restartPuzzleCallback() {
    if (pendingRestartPuzzleResolve) {
        let resolve = pendingRestartPuzzleResolve;
        pendingRestartPuzzleResolve = null;
        resolve();
    }
}

async function restartPuzzle() {
    await new Promise((resolve) => {
        pendingRestartPuzzleResolve = resolve;
        sendMessage("restartPuzzle");
    });

    // Bug: native "Restart" reconstructs the puzzle from its original
    // game descriptor (see the comment on restartPuzzle() in
    // static/puzzleframe.js), which is whatever clue mask was baked in
    // when this puzzle was first loaded -- so restarting silently wipes
    // any clues revealed live since then (from receiving items while
    // this puzzle was open, or from catching up a stale save on
    // restore -- see loadPuzzleData() above). Same fix as that: force
    // a fresh check by clearing entry.displayedClueCount, then let
    // liveRevealClues() re-reveal whatever should currently be visible
    // (harmless no-op if nothing was actually lost).
    const entry = Alpine.store("puzzleList").current;
    if (entry?.stagePlan) {
        entry.displayedClueCount = 0;
        await liveRevealClues(entry);
    }
}

function undoPuzzle() {
    sendMessage("undoPuzzle");
}

function redoPuzzle() {
    sendMessage("redoPuzzle");
}

function solvePuzzle() {
    sendMessage("solvePuzzle");

    // Mark puzzle as solved regardless of whether the puzzle was actually solved

    Alpine.store("puzzleList").markSolved()
}

/**
 * The cell indices belonging to Digit Group `groupNumber` (1-indexed)
 * alone -- i.e. newly deducible there compared to the group before it
 * (or an all-undetermined baseline, for group 1) -- using each stage's
 * real solver-forced digit string, precomputed and cached by
 * resolveKeenStagePlan(). This is the one place that decides what a
 * "digit group" actually consists of; both the "highlight next group"
 * UI feature and the Archipelago completion check below build on it,
 * so they can never disagree about it. Returns [] for an out-of-range
 * groupNumber (0, or beyond how many stages this puzzle achieved).
 */
function digitGroupCells(plan, groupNumber) {
    const stageIndex = groupNumber - 1;
    if (stageIndex < 0 || stageIndex >= plan.stages.length) return [];

    const previousForced = stageIndex > 0
        ? plan.stages[stageIndex - 1].forcedDigits
        : "0".repeat(plan.w * plan.w);
    const targetForced = plan.stages[stageIndex].forcedDigits;

    const cells = [];
    for (let i = 0; i < targetForced.length; i++) {
        if (targetForced[i] !== "0" && previousForced[i] === "0") cells.push(i);
    }
    return cells;
}

// The cell indices to highlight for `entry`'s "next digit group" right
// now -- shared by toggleNextGroupHighlight() (turning the overlay on)
// and refreshNextGroupHighlight() below (recomputing it later without
// the player having to toggle anything), so the two can never disagree
// about which group is "next". Returns [] (nothing to highlight) if
// entry has no resolved stagePlan.
//
// "The next digit group" is the earliest unlocked group the player
// hasn't actually solved (checked) yet -- NOT necessarily the
// highest-numbered unlocked group. Items and solving progress are
// independent: nothing stops several "Clue Set" items for a puzzle
// from arriving before the player has caught up on solving the
// earlier groups they unlocked, so `unlockedCount` alone (how many
// items have been received) can overshoot how far the player has
// actually gotten. Walk the unlocked groups in order and highlight
// the first one that isn't already a checked location; if every
// unlocked group is already solved (or there are none), there's
// nothing to highlight -- correctly empty, not an error, same as
// the zero-items case.
function nextGroupHighlightCells(entry) {
    const plan = entry && entry.stagePlan;
    if (!plan) return [];

    const unlockedCount = isApReady() ? countReceivedClueSets(entry.index) : 0;
    const reachableCount = Math.min(unlockedCount, plan.stages.length);

    let targetGroupNumber = 0;
    if (isApReady()) {
        for (let g = 1; g <= reachableCount; g++) {
            const locationId = locationNameToId(`Puzzle ${entry.index} Digit Group ${g}`);
            if (locationId === undefined || !client.room.checkedLocations.includes(locationId)) {
                targetGroupNumber = g;
                break;
            }
        }
    }
    return targetGroupNumber > 0 ? digitGroupCells(plan, targetGroupNumber) : [];
}

/**
 * Re-send the "highlight next digit group" overlay for `entry`, using
 * whatever's currently the next unlocked-but-unsolved group -- but only
 * if the player actually has the highlight turned on
 * (puzzleState.highlightingNextGroup); a harmless no-op otherwise so
 * every call site below can call this unconditionally without checking
 * that itself. Two callers:
 *  - js_post_init(), once a freshly-loaded puzzle is actually ready, so
 *    the setting persists across a puzzle switch instead of just
 *    silently going blank on the new iframe (a fresh iframe document
 *    never carries the previous one's overlay over on its own).
 *  - syncAPStatus(), on every item-receipt/location-check sync, so
 *    finishing the currently-highlighted group's cells moves the
 *    highlight on to the next one immediately, without the player
 *    having to toggle the button off and back on to recompute it.
 */
function refreshNextGroupHighlight(entry) {
    const puzzleState = Alpine.store("puzzleState");
    if (!puzzleState.highlightingNextGroup) return;

    const plan = entry && entry.stagePlan;
    sendMessage("setDigitGroupHighlight", nextGroupHighlightCells(entry), plan && plan.w);
}

/**
 * Toggle a highlight overlay (drawn in the puzzleframe iframe, on top of
 * the puzzle canvas) over every cell in the current "next digit group"
 * -- regardless of whether those cells happen to be filled in or
 * already correct, since the point is to show the player *where* the
 * next group of clues will land, not to grade their current progress.
 * See nextGroupHighlightCells() for exactly which group counts as
 * "next". A no-op (leaves the highlight off) if the current puzzle has
 * no resolved stagePlan: freeplay puzzles and other genres never get
 * one, and neither does a Keen puzzle still mid hidden-resolution-pass.
 *
 * The on/off state this sets (puzzleState.highlightingNextGroup)
 * persists across puzzle switches -- see refreshNextGroupHighlight(),
 * which re-sends the overlay for whatever puzzle is current whenever
 * something might have changed which group is "next", including a
 * fresh puzzle finishing loading.
 */
function toggleNextGroupHighlight() {
    const puzzleState = Alpine.store("puzzleState");

    if (puzzleState.highlightingNextGroup) {
        puzzleState.highlightingNextGroup = false;
        sendMessage("setDigitGroupHighlight", null);
        return;
    }

    const entry = Alpine.store("puzzleList").current;
    if (!entry || !entry.stagePlan) return;

    puzzleState.highlightingNextGroup = true;
    refreshNextGroupHighlight(entry);
}

/**
 * Stage 4: send the Archipelago location check for a digit group as
 * soon as the player has actually, correctly filled in its cells --
 * not when the engine's own "solved" callback fires (js_update_status),
 * which can't be trusted here: a masked puzzle with fewer than the full
 * clue set can have multiple grids that satisfy just the *visible*
 * clues, so "no errors and every cell full" doesn't mean "matches this
 * digit group's actually-forced answer". Instead this compares the
 * player's live entered digits (getCurrentGrid(), read straight off the
 * midend, no solving) against each not-yet-checked group's own forced
 * cells (digitGroupCells() above, backed by the real solve_partial
 * solver) cell by cell.
 *
 * Called after every move (see js_update_status()) for whichever entry
 * is currently loaded, so it naturally also catches a save that was
 * already correctly filled in before this feature existed the moment
 * it's reopened (post_move() fires once right after the initial load
 * too, not just after player input).
 *
 * Also autosaves (savePuzzleData()) the instant any Digit Group location
 * actually gets newly checked here -- previously the only autosave was
 * on a full puzzle solve (markSolved()'s call, triggered by the engine's
 * own "solved" status), so progress on an individual digit group could
 * sit unsaved indefinitely until the player remembered to hit the manual
 * "Save puzzle progress" button or fully solved the puzzle. `entry` here
 * is always whatever's current (the only caller passes
 * Alpine.store("puzzleList").current), so this never saves the wrong
 * puzzle's progress under the current one's name.
 */
async function checkDigitGroupProgress(entry) {
    if (!isApReady()) return;
    const plan = entry && entry.stagePlan;
    if (!plan) return;

    const unlockedCount = countReceivedClueSets(entry.index);
    if (unlockedCount <= 0) return;

    const currentGrid = await getCurrentGrid();
    if (!currentGrid) return;

    let newlyChecked = false;

    // Digit Groups 1..unlockedCount are each individually checkable now
    // (rules.py's access rule), whether or not this client's own
    // line-search happened to land exactly that many *distinct* stages
    // -- targetCount clamps to however many this puzzle actually
    // achieved, same as the highlight above.
    const targetCount = Math.min(unlockedCount, plan.stages.length);
    for (let groupNumber = 1; groupNumber <= targetCount; groupNumber++) {
        const cells = digitGroupCells(plan, groupNumber);
        if (cells.length === 0) continue;
        if (!cells.every(i => currentGrid[i] === plan.stages[groupNumber - 1].forcedDigits[i])) continue;

        const locationId = locationNameToId(`Puzzle ${entry.index} Digit Group ${groupNumber}`);
        if (locationId !== undefined && !client.room.checkedLocations.includes(locationId)) {
            client.check(locationId);
            newlyChecked = true;
        }
    }

    // K < N: this client's search only ever achieves `plan.stages.length`
    // distinct stages, which can be less than the world's configured
    // digitGroupCount when no single line or pair of lines makes
    // progress for long stretches (see Refinement 3's documented
    // trade-off) -- the *final* achieved stage is always the complete
    // puzzle regardless, so once it's correctly and fully filled in,
    // also send every Digit Group location beyond what this client
    // could present as its own separate stage, so none of them are
    // permanently unreachable just because the search couldn't find
    // that many genuine reveals.
    if (targetCount === plan.stages.length) {
        const finalForced = plan.stages[plan.stages.length - 1].forcedDigits;
        const fullySolved = currentGrid.length === finalForced.length
            && [...finalForced].every((d, i) => currentGrid[i] === d);

        if (fullySolved) {
            const totalGroups = Math.max(plan.stages.length, entry.digitGroupCount || plan.stages.length);
            for (let groupNumber = plan.stages.length + 1; groupNumber <= totalGroups; groupNumber++) {
                const locationId = locationNameToId(`Puzzle ${entry.index} Digit Group ${groupNumber}`);
                if (locationId !== undefined && !client.room.checkedLocations.includes(locationId)) {
                    client.check(locationId);
                    newlyChecked = true;
                }
            }

            // "Puzzle {index} Solved" -- a separate location from every Digit
            // Group, added purely to give the world extra location capacity
            // to back "Puzzle N" unlock items (see the AP world's
            // items.py/rules.py). Same completion condition as the puzzle's
            // final Digit Group, so it's safe to check here alongside them.
            const solvedLocationId = locationNameToId(`Puzzle ${entry.index} Solved`);
            if (solvedLocationId !== undefined && !client.room.checkedLocations.includes(solvedLocationId)) {
                client.check(solvedLocationId);
                newlyChecked = true;
            }
        }
    }

    if (newlyChecked) {
        savePuzzleData();
    }
}

function setPreset(id) {
    sendMessage("setPreset", id)
}

function dialogConfirm() {
    let dialog = Alpine.store("puzzleDialog");
    for (let elem of dialog.controls) {
        switch (elem.type) {
            case "string":
                sendMessage("dialogReturnString", elem.index, elem.value); break;
            case "choice":
                sendMessage("dialogReturnInt", elem.index, elem.value); break;
            case "boolean":
                sendMessage("dialogReturnInt", elem.index, elem.value ? 1 : 0); break;
        }
    }
    sendMessage("dialogConfirm")
}

function dialogCancel() {
    sendMessage("dialogCancel")
}

function savePuzzleData() {
    sendMessage("savePuzzleData")
}

function setNewGameEnabled(allowNewGame) {
    sendMessage("setNewGameEnabled", allowNewGame)
}

// Resolved once the iframe confirms a just-sent "loadPuzzleData" save
// has actually finished restoring (see loadPuzzleDataCallback below) --
// needed so loadPuzzleData() can reliably run its post-restore clue
// catch-up only after the restored game state is actually live, not
// merely dispatched.
let pendingLoadPuzzleDataResolve = null;

function loadPuzzleDataCallback() {
    if (pendingLoadPuzzleDataResolve) {
        let resolve = pendingLoadPuzzleDataResolve;
        pendingLoadPuzzleDataResolve = null;
        resolve();
    }
}

async function loadPuzzleData() {
    const gamesaves = Alpine.store("gamesaves");
    const puzzleList = Alpine.store("puzzleList");
    if (!gamesaves.current || !puzzleList.current) return;

    const entry = puzzleList.current;
    let data = await gamesaves.current.getPuzzleSave(entry.index);

    if (data) {
        await new Promise((resolve) => {
            pendingLoadPuzzleDataResolve = resolve;
            sendMessage("loadPuzzleData", data);
        });

        // Bug: a save captures whatever clues were visible *at save
        // time*. If the player since unlocked more "Clue Set" items
        // for this puzzle elsewhere and comes back, loadPuzzle() (see
        // loadKeenAwarePuzzleEntry) deliberately skips sending the
        // freshly-computed visible id whenever a save exists, so the
        // live midend we just restored only knows about the older,
        // smaller clue set baked into the save -- new clues never
        // appear. That earlier keenVisibleId() call already
        // optimistically set entry.displayedClueCount to the current
        // unlocked count on the (false, in this case) assumption its
        // id would actually be what got loaded; clear that back to 0
        // so liveRevealClues() below does a real check against what's
        // actually on screen now, and reveals whatever the save was
        // missing in place (harmless no-op if the save was already
        // fully caught up).
        if (entry.stagePlan) {
            entry.displayedClueCount = 0;
            await liveRevealClues(entry);
        }
    }
}

async function deletePuzzleData(index) {
    const gamesaves = Alpine.store("gamesaves");
    const puzzleList = Alpine.store("puzzleList");

    if (gamesaves.current) {
        index ??= puzzleList.current?.index
    }
    if (index === undefined) return;

    await gamesaves.current.deletePuzzleSave(index);

    return;
}

function hasItem(itemId) {
    return client.items.received.findIndex(e => e.id == itemId) > -1;
}

function syncAPStatus() {
    const puzzleList = Alpine.store("puzzleList");

    if (!isApReady()) {
        puzzleList.resort();
        return;
    };

    const gamesaves = Alpine.store("gamesaves");

    let allSolved = true;
    let currentFile = gamesaves.current;

    let fileDirty = false;

    let newRemoteSolves = {};
    let anyNewRemoteSolves = false;

    for (let entry of puzzleList.entries) {
        let dirty = false;
        let itemId = itemNameToId(`Puzzle ${entry.index}`);

        // "Collected" means every Digit Group location for this puzzle has
        // been checked -- there's no separate "Reward" location in
        // Progressive Keen's location table (every location is
        // "Puzzle {i} Digit Group {j}"), and checkDigitGroupProgress()'s
        // own K<N handling guarantees that once a puzzle is fully and
        // correctly solved, every group up through digitGroupCount gets
        // checked, not just however many distinct stages this client's
        // search happened to produce -- so the *last* group number is a
        // reliable "is this puzzle entirely done" signal.
        let finalGroupNumber = entry.digitGroupCount || 1;
        let locationId = locationNameToId(`Puzzle ${entry.index} Digit Group ${finalGroupNumber}`);

        if (!entry.collected && locationId !== undefined && client.room.checkedLocations.includes(locationId)) {
            entry.collected = true;
            dirty = true;
        } else if (!entry.collected) {
            allSolved = false;
        }

        if (entry.locked && hasItem(itemId)) {
            entry.locked = false;
            dirty = true;

            if (currentFile && currentFile.puzzleLocked[entry.index-1]) {
                currentFile.puzzleLocked[entry.index-1] = false;
                fileDirty = true;
            }
        }

        // Sidebar highlight: does this puzzle have an unlocked Digit
        // Group the player hasn't finished yet? Deliberately keyed
        // purely off item/location state (how many "Clue Set" items
        // have been received, and which "Puzzle N Digit Group G"
        // locations are already checked) rather than this entry's own
        // stagePlan, so it works for every puzzle in the list right
        // away -- including ones never opened this session, whose
        // stagePlan is still null (resolving it just to answer this
        // would mean loading each one into the single shared iframe,
        // which would interrupt whatever puzzle the player currently
        // has open).
        //
        // A still-locked puzzle can have received "Clue Set" items
        // without its "Puzzle N" unlock item (item order isn't
        // guaranteed), but none of its Digit Group locations are
        // actually reachable until it's unlocked (see rules.py), so
        // force both counters to 0 while entry.locked -- using the
        // value just possibly updated above in this same pass.
        if (entry.digitGroupCount !== undefined) {
            const availableCount = entry.locked ? 0 : Math.min(countReceivedClueSets(entry.index), entry.digitGroupCount);
            let checkedCount = 0;
            for (let g = 1; g <= availableCount; g++) {
                const groupLocationId = locationNameToId(`Puzzle ${entry.index} Digit Group ${g}`);
                if (groupLocationId !== undefined && client.room.checkedLocations.includes(groupLocationId)) {
                    checkedCount++;
                }
            }
            entry.checkedGroupCount = checkedCount;
            entry.availableGroupCount = availableCount;
            entry.hasProgressAvailable = checkedCount < availableCount;
        }

        if (dirty) {
            entry.updateState();
        }

        if (entry.solved && !(entry.index in remoteSolved)) {
            newRemoteSolves[entry.index] = 1;
            remoteSolved[entry.index] = 1;
            anyNewRemoteSolves = true;
        }
    }

    // If the puzzle currently open in the frame is a progressive Keen
    // puzzle and this sync was triggered by (among other things) a
    // newly-received "Clue Set" item, reveal it live rather than
    // waiting for the player to back out and reselect the puzzle --
    // see liveRevealClues() above. Fire-and-forget: any failure is
    // logged there and otherwise doesn't affect the rest of this sync.
    if (puzzleList.current && puzzleList.current.stagePlan) {
        liveRevealClues(puzzleList.current);
        // Likewise, if the currently-open puzzle's highlighted group
        // just got checked off (or a new item changed which group is
        // "next"), move the highlight on without making the player
        // toggle it off and back on -- see refreshNextGroupHighlight().
        refreshNextGroupHighlight(puzzleList.current);
    }

    if (anyNewRemoteSolves) {
        console.log("newly solved: ", newRemoteSolves)
        let team = client.players.self.team
        let slot = client.players.self.slot
        let key = `sgtpuzzles_solves_${team}_${slot}`
        client.storage.prepare(key, {})
            .update(newRemoteSolves)
            .commit()
    }

    puzzleList.resort();

    if (fileDirty) {
        currentFile.save();
    }
}

async function createFile(hostname, port, player, password) {
    const gamesaves = Alpine.store("gamesaves")
    gamesaves.connecting = true;

    disconnectAP();

    gamesaves.apError = false;

    try {
        await connectAP(hostname, port, player, password);
    } catch (e) {
        alert("Couldn't connect to Archipelago server.");
        console.error("Couldn't connect to Archipelago server");
        console.error(e);

        gamesaves.apError = true;
        gamesaves.connecting = false;

        return;
    }

    let fileVersion = slotData.file_version ?? 0

    console.log(`file_version = ${slotData.file_version}`)
    console.log(`world_version = ${slotData.world_version}`)

    if (fileVersion > 1) {
        alert(`World is version ${slotData.world_version}, which is not compatible with this web client version. Some features may not work as expected.`)
    }

    let newFile = new GameSave({
        host: hostname,
        port: port,
        player: player,
        password: password,
        puzzles: slotData.puzzles,
        baseSeed: "" + slotData.world_seed,
        solveTarget: slotData.solve_target,
        digitGroupCounts: slotData.digit_group_counts,
        startingPuzzleCount: slotData.starting_puzzle_count
    });

    await clearPuzzle();

    loadFileData(newFile);

    await newFile.save();

    apReady = true;
    gamesaves.connecting = false;
    gamesaves.list.push(newFile);
    gamesaves.current = newFile;
    initRemoteSolves();
    syncAPStatus();
}

/**
 * 
 * @param {SaveData.GameSave} file 
 */
async function loadFile(file, secretMode, newConnection) {
    const gamesaves = Alpine.store("gamesaves")
    gamesaves.connecting = true;
    gamesaves.current = file;

    disconnectAP();

    gamesaves.apError = false;
    let connectOk = false;

    let host, port, player, password;

    if (newConnection) {
        host = newConnection.host ?? file.host;
        port = newConnection.port ?? file.port;
        player = newConnection.player ?? file.player;
        password = newConnection.password ?? file.password;
    } else {
        host = file.host;
        port = file.port;
        player = file.player;
        password = file.password;
    }

    if (host) {
        try {
            await connectAP(host, port, player, password);
            connectOk = true;
        } catch (e) {
            if (newConnection) {
                alert("Couldn't connect to Archipelago server. Reload this file to connect with previous information.")
            } else {
                alert("Couldn't connect to Archipelago server. (You can still solve unlocked puzzles on this file.)")
            }
            gamesaves.apError = true;
            console.error(e);
        }
    }

    if (connectOk) {
        // Verify puzzle list and seed match
        function anyMismatch() {
            if (file.baseSeed != "" + slotData.world_seed) return true;
            if (file.puzzles.length != slotData.puzzles.length) return true;

            for (let i = 0; i < file.puzzles.length; i++) {
                if (file.puzzles[i] != slotData.puzzles[i]) return true;
            }

            return false;
        }

        if (anyMismatch()) {
            if (newConnection) {
                alert("The Archipelago server data doesn't match this save file. Reload this file to connect with previous information.")
            } else {
                alert("The Archipelago server data doesn't match this save file. (You can still solve unlocked puzzles.)")
            }
            disconnectAP();
            connectOk = false;
            gamesaves.apError = true;
        }
    }

    if (connectOk) {
        // Refresh digitGroupCounts (and startingPuzzleCount) from the
        // server on every successful (re)connect, not just brand-new files:
        // a file saved before these fields existed (or before the world's
        // options were what they are now) would otherwise be stuck with
        // GameSave's fail-open defaults forever -- digitGroupCounts's
        // Array(...).fill(1) looks exactly like "every puzzle shows fully
        // revealed" (with N=1, a single-stage division genuinely *is* full
        // reveal), and a stale startingPuzzleCount could leave a
        // now-later-unlocked puzzle looking permanently accessible, or vice
        // versa.
        file.digitGroupCounts = slotData.digit_group_counts;
        file.startingPuzzleCount = slotData.starting_puzzle_count;
    }

    if (newConnection && connectOk) {
        file.host = host;
        file.port = port;
        file.player = player;
        file.password = password;

        file.updateDescription();
        file.save();
    }

    await clearPuzzle();

    loadFileData(file, secretMode);

    if (connectOk) {
        apReady = true;
        gamesaves.connected = true;
        initRemoteSolves();
    }

    gamesaves.connecting = false;
    syncAPStatus();
}

async function deleteFile(file) {
    await file.deleteFile();
    
    const gamesaves = Alpine.store("gamesaves");
    const puzzleList = Alpine.store("puzzleList");

    let index = gamesaves.list.indexOf(file);
    if (index > -1) {
        gamesaves.list.splice(index, 1);
    }

    if (gamesaves.current == file) {
        // TODO extract this
        clearPuzzle();
        gamesaves.current = null;
        loadFileData(null);
    }
}

async function loadFileList() {
    const gamesaves = Alpine.store("gamesaves");
    gamesaves.list = await getFileList();

    let defaultGame = new GameSave({
        id: -1,
        filename: "Freeplay",
        puzzles: genres.filter(e => true),
        puzzleLocked: genres.map(e => false)
    });

    gamesaves.list.unshift(defaultGame);

    gamesaves.loadFile(defaultGame);
}

function onReceiveItems(event) {
    if (isApReady()) {
        syncAPStatus();
    }
}

function logEvent(event) {
    console.log(event);
}

/**
 * @param {import("archipelago.js").PrintJSONPacket} event 
 * @deprecated
 */
function onPrintJson(event) {
    function processMessagePart(part) {
        const itemTypes = {0: 'filler', 1: 'progression', 2: 'useful', 4: 'trap'}
        switch (part.type) {
            case "player_id":
                return {text: playerIdToName(+part.text), detail: part.text, type: "player"}
            case "item_id":
                return {text: itemIdToName(+part.text), detail: part.text, type: "item", itemType: itemTypes[part.flags]}
            case "location_id":
                return {text: locationIdToName(+part.text), detail: part.text, type: "location"}
            default: return part
        }
    }

    const chatbox = Alpine.store("chatbox")
    let mySlot = client.players.self.slot;

    let highlight = false
    if (event.item && event.item.player === mySlot) {
        highlight = true;
    }
    if (event.receiving === mySlot) {
        highlight = true;
    }

    const newMessage = {
        type: (event.type ?? 'unknown').toLowerCase(),
        data: event.data.map(processMessagePart),
        highlight: highlight
    }
    chatbox.appendMessage(newMessage)
}

/**
 * @param {string} text
 * @param {import("archipelago.js").MessageNode[]} nodes 
 */
function onMessage(text, nodes) {
    const chatbox = Alpine.store("chatbox")

    let highlight = false

    /**
     * @param {import("archipelago.js").MessageNode} n
     */
    function processNode(n) {
        let result = {type: n.type, text: n.text, itemType: null};

        if (n.type == "item") {
            result.itemType = n.item.progression ? "progression" : n.item.useful ? "useful" : n.item.trap ? "trap" : "filler"
            result.detail = result.itemType
        }

        if (n.type == "player" && n.player.slot == client.players.self.slot && n.player.team == client.players.self.team) {
            highlight = true
        }

        return result;
    }

    // TODO message pretty printing
    const newMessage = {
        type: "message",
        data: nodes.map(processNode),
        highlight: highlight
    }

    chatbox.appendMessage(newMessage)
}

/**
 * @param {import("archipelago.js").SetReplyPacket} event 
 */
function onSetReply(event) {
    let team = client.players.self.team
    let slot = client.players.self.slot
    let key = `sgtpuzzles_solves_${team}_${slot}`

    if (event.key == key) {
        copyRemoteSolves(event.value)
    }
}

/**
 * @param {import("archipelago.js").RetrievedPacket} event 
 */
function onKeysRetreived(event) {
    let team = client.players.self.team
    let slot = client.players.self.slot
    let key = `sgtpuzzles_solves_${team}_${slot}`

    console.log("KeysRetrieved", event)
    
    if (event.keys[key]) {
        copyRemoteSolves(event.keys[key])
    }
}

function copyRemoteSolves(solves) {
    console.log(solves)
    let puzzleList = Alpine.store("puzzleList")

    let oldRemoteSolved = {};
    Object.assign(oldRemoteSolved, remoteSolved)

    for (let id in solves) {
        if (!(id in oldRemoteSolved)) {
            console.log(`adding remote solve ${id}`)
            remoteSolved[id] = solves[id];
            puzzleList.markSolved(puzzleList.entries[id-1]);
        }
    }
}

function onDisconnected() {
    if (apReady) {
        Alpine.store("gamesaves").apError = true
    }
    apReady = false;
    console.log("disconnected")

    const chatbox = Alpine.store("chatbox")
    chatbox.appendEcho("Disconnected from Archipelago.")
}

function sendChat(text) {
    const chatbox = Alpine.store("chatbox")

    if (!text) return;

    if (text[0] == "/") {
        return handleSlashCommand(text)
    }

    if (!client || !apReady) {
        chatbox.appendEcho("Not connected to Archipelago.")
        return
    }
    client.messages.say(text)
}

async function handleSlashCommand(text) {
    const chatbox = Alpine.store("chatbox")
    const puzzleList = Alpine.store("puzzleList")

    chatbox.appendEcho(text)

    let parts = text.trim().split(/\s+/)
    let command = parts[0] ?? ""

    if (command == "/debugon") {
        Alpine.store("debugMode", true)
        chatbox.appendEcho("Debug mode enabled.")
    } else if (command  == "/debugoff") {
        Alpine.store("debugMode", false)
        chatbox.appendEcho("Debug mode disabled.")
    } else if (command == "/delete_puzzle_data") {
        if (isNaN(parts[1])) {
            chatbox.appendEcho("Specify a puzzle number.")
            return
        }

        let puzzleIndex = +parts[1]
        let puzzle = puzzleList.entries[puzzleIndex-1];
        if (!puzzle) {
            chatbox.appendEcho("No puzzle with that number.")
            return
        }

        await deletePuzzleData(puzzleIndex)
        chatbox.appendEcho(`Deleted save data for "${puzzle.desc}".`)
    } else if (command == "/set_puzzle_seed") {
        if (isNaN(parts[1])) {
            chatbox.appendEcho("Specify a puzzle number.")
        }

        let puzzleIndex = +parts[1]
        let puzzle = puzzleList.entries[puzzleIndex-1];
        if (!puzzle) {
            chatbox.appendEcho("No puzzle with that number.")
        }

        let newSeed = parts[2] ?? "";

        puzzle.puzzleSeed = newSeed
        puzzle.updateDescription()

        chatbox.appendEcho(`Updated seed for "${puzzle.desc}".`)
    } else if (command == "/solve_collected") {
        let solveCount = 0
        for (let puzzle of puzzleList.entries) {
            if (!puzzle.locked && !puzzle.solved && puzzle.collected) {
                puzzleList.markSolved(puzzle)
                solveCount++;
            }
        }
        chatbox.appendEcho(`${solveCount} puzzle(s) marked solved.`)
    } else if (command == "/show_unsupported") {
        Alpine.store("debugLoader").showUnsupported = true;
        chatbox.appendEcho("Unsupported genres are now enabled in Freeplay.")
    } else if (command == "/help") {
        chatbox.appendEcho(
            "These commands are used to cheat or work around generation errors. Use at your own risk:\n\n"+

            "/debugon - Enable debug mode\n"+
            "/debugoff - Disable debug mode\n"+
            "/delete_puzzle_data [num] - Delete save data for a specific puzzle\n"+
            "/set_puzzle_seed [num] [newParameters] - Overwrite the seed for a specific puzzle\n"+
            "/solve_collected - Auto-solve all puzzles whose locations have been checked\n"+
            "/show_unsupported - Display unfinished and unsupported genres in Freeplay"
        )
    } else {
        chatbox.appendEcho("Unknown command. Use /help to see available commands.")
    }
}

async function connectAP(hostname, port, player, password) {
    if (!client) {
        client = new Client();
        window.client = client;

        // TODO probably unnecessary to sync both due to ReceivedItems and RoomUpdate..?
        client.socket.on("receivedPacket", logEvent);
        client.socket.on("receivedItems", onReceiveItems);
        client.socket.on("roomUpdate", syncAPStatus);
        client.socket.on("setReply", onSetReply)
        client.socket.on("retrieved", onKeysRetreived)
        client.socket.on("disconnected", onDisconnected);

        client.messages.on("message", onMessage);
    }

    remoteSolved = {};

    console.log("connecting to AP...");

    const connectionInfo = {
        password: password ?? ""
    };

    let connectionURL = `${hostname}:${port}`
    const game = "Progressive Keen"

    slotData = await client.login(connectionURL, player, game, connectionInfo);

    console.log("connected to AP");

    syncAPStatus();
    
    const chatbox = Alpine.store("chatbox")
    chatbox.appendEcho("Connected to Archipelago.")
}

function isApReady() {
    return apReady && client.authenticated;
}

function initRemoteSolves() {
    let team = client.players.self.team
    let slot = client.players.self.slot
    let key = `sgtpuzzles_solves_${team}_${slot}`

    client.socket.send({cmd:"SetNotify", keys:[key]})
    client.socket.send({cmd:"Get", keys:[key]})
}

function itemIdToName(id) {
    return client.package.findPackage("Progressive Keen").reverseItemTable[id]
}

function itemNameToId(name) {
    return client.package.findPackage("Progressive Keen").itemTable[name]
}

function locationIdToName(id) {
    return client.package.findPackage("Progressive Keen").reverseLocationTable[id]
}

function locationNameToId(name) {
    return client.package.findPackage("Progressive Keen").locationTable[name]
}

function playerIdToName(id) {
    return client.players.slots[id].name
}

/**
 * 
 * @param {SaveData.GameSave} file
 */
function loadFileData(file, secretMode) {
    const puzzleList = Alpine.store("puzzleList");

    if (secretMode) {
        console.log("waow")
    }

    let isFreeplay = (file.id < 0);
    let showUnsupported = Alpine.store("debugLoader").showUnsupported;

    // TODO styling sometimes doesn't update when reconnecting while a puzzle is selected.
    // Seems like a bug with Alpine (or with how I'm using it), I'll probably have to switch to a different
    // UI/reactivity library
    puzzleList.entries = [];
    puzzleList.sortedEntries = [];
    puzzleList.selectPuzzle(null);
    puzzleList.solveTarget = file?.solveTarget ?? null;
    puzzleList.finished = file.finished;
    puzzleList.sortBySolved = !isFreeplay;

    for (let i = 0; i < file.puzzles.length; i++) {
        // A puzzle at or beyond startingPuzzleCount needs its own "Puzzle N"
        // item before it's accessible at all -- assume locked here purely
        // from that structural fact (freeplay puzzles are never gated) and
        // deliberately don't consult hasItem()/client.items.received yet:
        // this runs before the connection is guaranteed fully settled, but
        // syncAPStatus() is always called again immediately after loadFileData()
        // on every connect path, and it will flip this back to false the moment
        // it sees the item already received, so an initial over-lock here is
        // only ever momentary. We deliberately ignore file.puzzleLocked, which
        // is stale by construction if starting_puzzles changed since this file
        // was last saved (see its comment in savedata.js).
        let options = {
            locked: !isFreeplay && (i + 1) > file.startingPuzzleCount,
            solved: file.puzzleSolved[i],
            digitGroupCount: isFreeplay ? undefined : file.digitGroupCounts[i],
        }

        let newEntry;
        if (isFreeplay) {
            newEntry = ArchipelagoPuzzle.fromPuzzlesString(file.puzzles[i], null, i+1)

            if (!showUnsupported && ((genreInfo[newEntry.genre].hidden && !secretMode) || genreInfo[newEntry.genre].evenMoreHidden)) {
                // Skip hidden genres
                continue;
            }
        } else {
            newEntry = ArchipelagoPuzzle.fromArchipelagoString(file.puzzles[i], file.baseSeed, i+1, options)
        }

        puzzleList.entries.push(newEntry);
    }

    puzzleList.resort();
}

function disconnectAP() {
    const gamesaves = Alpine.store("gamesaves")
    apReady = false;
    gamesaves.connected = false;
    if (client && client.socket.connected) {
        console.log("disconnecting from AP...");
        client.socket.disconnect();
    }
}

// Expose UI functions to global scope
// I should probably move these to Alpine
window.showPreferences = showPreferences;
window.newPuzzle = newPuzzle;
window.puzzleFromId = puzzleFromId;
window.puzzleFromSeed = puzzleFromSeed;
window.restartPuzzle = restartPuzzle;
window.undoPuzzle = undoPuzzle;
window.redoPuzzle = redoPuzzle;
window.solvePuzzle = solvePuzzle;
window.toggleNextGroupHighlight = toggleNextGroupHighlight;
window.setPreset = setPreset;
window.savePuzzleData = savePuzzleData;
window.loadPuzzleData = loadPuzzleData;
window.deletePuzzleData = deletePuzzleData;

// Expose some variables to global scope for ease of debugging
window.Alpine = Alpine;
window.store = Alpine.store;
window.client = client;
window.Client = Client;
window.ArchipelagoPuzzle = ArchipelagoPuzzle;
window.syncAPStatus = syncAPStatus;
window.SaveData = SaveData;
window.loadPuzzle = loadPuzzle;

Alpine.start();