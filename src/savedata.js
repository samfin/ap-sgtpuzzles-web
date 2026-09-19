/**
 * @template T
 * @param {{result: T}} transaction 
 * @returns {Promise<T>}
 */
function asPromise(transaction) {
    return new Promise(function (resolve, reject) {
        transaction.onsuccess = (e => resolve(transaction.result));
        transaction.onerror = (e => reject(transaction.error));
    })
}

/**
 * template T
 * @param {IDBRequest<IDBCursor | null>} transaction
 */
async function* asIterator(transaction) {
    let cursor;
    do {
        cursor = await asPromise(transaction);

        if (cursor) {
            yield cursor;

            cursor.continue();
        }
    } while (cursor)
}

/**
 * @type {IDBDatabase}
 */
let db;

export class GameSave {
    constructor(options) {
        options ??= {};

        this.id = options.id ?? null;
        this.filename = options.filename ?? null;
        this.host = options.host ?? "";
        this.port = options.port ?? 0;
        this.player = options.player ?? "";
        this.password = options.password ?? "";
        this.baseSeed = "" + (options.baseSeed ?? "");

        this.description = "";
        this.finished = options.finished ?? false;

        this.solveTarget = options.solveTarget ?? null;

        /**
         * List of puzzle parameter strings, as provided by the Archipelago world.
         * @type {string[]}
         */
        this.puzzles = options.puzzles ?? [];

        /**
         * Solved status of puzzles.
         * @type {boolean[]}
         */
        this.puzzleSolved = options.puzzleSolved ?? Array(this.puzzles.length).fill(false)

        /**
         * Locked status of puzzles, as last written by syncAPStatus(). Not
         * actually read back anywhere -- loadFileData() recomputes each
         * puzzle's locked state fresh every time from startingPuzzleCount
         * (see there), since that's robust to the YAML's starting_puzzles
         * option changing between sessions on the same save file, which a
         * trusted persisted flag wouldn't be. Kept around for save-file
         * shape compatibility.
         * @type {boolean[]}
         */
        this.puzzleLocked = options.puzzleLocked ?? Array(this.puzzles.length).fill(false)

        /**
         * Number of puzzles (by index, 0-based) accessible from the start,
         * from the Archipelago world's slot_data (starting_puzzle_count).
         * Every puzzle at or beyond this count needs its own "Puzzle N" item
         * received before any of its Digit Group locations are reachable at
         * all (see loadFileData()/syncAPStatus() in puzzles.js). Defaults to
         * "every puzzle is a starting puzzle" (nothing locked) for save files
         * written before this field existed, or while there's no live
         * connection to refresh it from -- the same fail-open philosophy
         * already used for a stale digitGroupCounts.
         * @type {number}
         */
        this.startingPuzzleCount = options.startingPuzzleCount ?? this.puzzles.length

        /**
         * Target number of clue-group stages ("Digit Group" locations) for
         * each puzzle, from the Archipelago world's slot_data
         * (digit_group_counts). This is "N" per puzzle in the
         * progressive-reveal design; the client-side division algorithm
         * (keenDivision.js) may achieve fewer (K < N) if a puzzle doesn't
         * have enough distinct cages to support N stages.
         * @type {number[]}
         */
        this.digitGroupCounts = options.digitGroupCounts ?? Array(this.puzzles.length).fill(1)

        this.updateDescription();
    }

    async save() {
        if (this.id == -1) return;

        const transaction = db.transaction("gamesave", "readwrite");
        const gamesave = transaction.objectStore("gamesave");

        let obj = this.toObject();
        if (obj.id === null) {
            delete obj.id;
        }

        let key = await asPromise(gamesave.put(obj));

        if (this.id === null) {
            this.id = key
        }

        transaction.commit();
    }

    async getPuzzleSave(puzzleId) {
        if (this.id == -1) return;

        const transaction = db.transaction("puzzlesave");
        const puzzlesave = transaction.objectStore("puzzlesave");

        let obj = await asPromise(puzzlesave.get([this.id, puzzleId]));

        if (obj) {
            return obj.data;
        } else {
            return null;
        }
    }

    async setPuzzleSave(puzzleId, data) {
        if (this.id == -1) return;

        const transaction = db.transaction("puzzlesave", "readwrite");
        const puzzlesave = transaction.objectStore("puzzlesave");

        let obj = {gameId: this.id, puzzleId: puzzleId, data: data};

        await asPromise(puzzlesave.put(obj));

        return;
    }

    async deletePuzzleSave(puzzleId) {
        if (this.id == -1) return;

        const transaction = db.transaction("puzzlesave", "readwrite");
        const puzzlesave = transaction.objectStore("puzzlesave");

        await asPromise(puzzlesave.delete([this.id, puzzleId]));

        return;
    }

    async deleteFile() {
        if (this.id == -1) return;

        const transaction = db.transaction(["gamesave","puzzlesave"], "readwrite");
        const gamesave = transaction.objectStore("gamesave");
        const puzzlesave = transaction.objectStore("puzzlesave");

        let toAwait = [];

        const puzzlesByGameId = puzzlesave.index("gameId")

        let puzzleIterator = asIterator(puzzlesByGameId.openCursor(this.id))

        for await (let cursor of puzzleIterator) {
            toAwait.push(cursor.delete());
        }

        toAwait.push(asPromise(gamesave.delete(this.id)));

        transaction.commit();

        await Promise.allSettled(toAwait);

        return;
    }

    updateDescription() {
        this.description = this.toString();
    }

    toString() {
        return this.filename ?? `${this.player} (${this.host}:${this.port}${this.password ? '*' : ''}), ${this.puzzles.length} puzzles`;
    }

    toObject() {
        return {
            id: this.id,
            fliename: this.filename,
            host: this.host,
            port: this.port,
            player: this.player,
            password: this.password,
            baseSeed: this.baseSeed,
            finished: this.finished,
            puzzles: this.puzzles.slice(),
            puzzleSolved: this.puzzleSolved.slice(),
            puzzleLocked: this.puzzleLocked.slice(),
            startingPuzzleCount: this.startingPuzzleCount,
            digitGroupCounts: this.digitGroupCounts.slice(),
            solveTarget: this.solveTarget
        };
    }

    static fromObject(obj) {
        return new GameSave(obj);
    }
}

export async function openDatabase() {
    let dbOpenReq = indexedDB.open("ap-puzzles", 1);

    dbOpenReq.onupgradeneeded = function(event) {
        let db = dbOpenReq.result;

        console.log("Creating indexedDB stores")

        if (event.oldVersion < 1) {
            let gamesave = db.createObjectStore("gamesave", {keyPath: "id", autoIncrement: true});
            let puzzlesave = db.createObjectStore("puzzlesave", {keyPath: ["gameId","puzzleId"]});

            puzzlesave.createIndex("gameId", "gameId")
        }
    };

    db = await asPromise(dbOpenReq);
}

export async function getFileList() {
    let transaction = db.transaction("gamesave");
    let gamesave = transaction.objectStore("gamesave");

    let fileList = await asPromise(gamesave.getAll());

    fileList = fileList.map(e => GameSave.fromObject(e));

    return fileList;
}

export async function getFile(id) {
    return new GameSave.fromObject();
}