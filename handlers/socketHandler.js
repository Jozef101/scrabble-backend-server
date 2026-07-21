//backend/handlers/socketHandler.js
import {
    games,
    gameTimeouts,
    createNewGameInstance,
    generateInitialGameState,
    updateEloRatings,
    activeTimers,
} from '../game/gameManager.js';
import { drawLetters } from '../utils/gameUtils.js';
import { LETTER_VALUES } from '../config/constants.js';
import { dbAdmin } from '../config/firebase.js';

const BOARD_COLS = 'ABCDEFGHIJKLMNO';

/**
 * Zapíše jeden riadok do konzoly s čitateľným ISO časom na začiatku — bez
 * ohľadu na to, či beží server lokálne (node bez hostingového wrapperu, ktorý
 * by čas pridal sám) alebo nasadený, log je vždy sám o sebe čitateľný a
 * chronologicky zoraditeľný.
 */
function logAction(type, gameId, playerIndex, payload) {
    console.log(
        `[${new Date().toISOString()}] [PLAYER_ACTION] game=${gameId} player=${playerIndex} type=${type} payload=${JSON.stringify(payload)}`
    );
}

/**
 * Konvertuje internú 2D dosku (board[x][y]) na Firestore objekt s chess kľúčmi (A1–O15).
 * Ukladajú sa len obsadené políčka.
 */
function boardToFirestore(board) {
    const result = {};
    for (let x = 0; x < board.length; x++) {
        for (let y = 0; y < board[x].length; y++) {
            if (board[x][y] !== null) {
                result[`${BOARD_COLS[y]}${x + 1}`] = board[x][y];
            }
        }
    }
    return result;
}

/**
 * Konvertuje Firestore chess objekt (A1–O15) späť na internú 2D dosku.
 */
function firestoreToBoard(boardObj, size = 15) {
    const board = Array(size).fill(null).map(() => Array(size).fill(null));
    for (const [key, value] of Object.entries(boardObj || {})) {
        const y = BOARD_COLS.indexOf(key[0]);
        const x = parseInt(key.slice(1)) - 1;
        if (y !== -1 && x >= 0 && x < size) {
            board[x][y] = value;
        }
    }
    return board;
}

/**
 * Vráti kópiu stavu hry prispôsobenú pre daného hráča:
 * - súperov rack má skryté písmená
 * - ak je rad súpera a hra prebieha, hráč nevidí dočasne položené písmená (board diff + exchangeZone)
 *   ani zmeny v počte písmen v súperovom racku
 */
function maskStateForPlayer(gameState, playerIndex) {
    if (playerIndex === null || playerIndex === undefined || !gameState.playerRacks) {
        return gameState;
    }
    const opponentIndex = 1 - playerIndex;

    // Počas ťahu súpera (in_progress) skryjeme jeho rozložené písmená na doske a vo výmennej zóne.
    // Počas AWAITING_WORD_VALIDATION ich naopak ukázať musíme, aby druhý hráč mohol schváliť/zamietnuť.
    const opponentIsPlaying =
        gameState.gameStatus === 'in_progress' &&
        gameState.currentPlayerIndex === opponentIndex &&
        gameState.boardAtStartOfTurn;

    // Ak súper práve hrá, spočítame koľko písmen presunul z racku (board diff + exchange zone)
    // a doplníme ich späť do jeho maskovaného racku ako { hidden: true }
    let movedFromRack = 0;
    if (opponentIsPlaying) {
        for (let x = 0; x < gameState.board.length; x++) {
            for (let y = 0; y < gameState.board[x].length; y++) {
                if (gameState.board[x][y] !== null && gameState.boardAtStartOfTurn[x][y] === null) {
                    movedFromRack++;
                }
            }
        }
        movedFromRack += gameState.exchangeZoneLetters.length;
    }

    const maskedRacks = gameState.playerRacks.map((rack, idx) => {
        if (idx !== opponentIndex || !rack) return rack;
        let nullsToFill = movedFromRack;
        return rack.map(letter => {
            if (letter !== null) return { hidden: true };
            // Doplníme prázdny slot ak tam súper presunul písmeno
            if (nullsToFill > 0) {
                nullsToFill--;
                return { hidden: true };
            }
            return null;
        });
    });

    return {
        ...gameState,
        playerRacks: maskedRacks,
        board: opponentIsPlaying ? gameState.boardAtStartOfTurn.map(row => [...row]) : gameState.board,
        exchangeZoneLetters: opponentIsPlaying ? [] : gameState.exchangeZoneLetters,
        hasPlacedOnBoardThisTurn: opponentIsPlaying ? false : gameState.hasPlacedOnBoardThisTurn,
        hasMovedToExchangeZoneThisTurn: opponentIsPlaying ? false : gameState.hasMovedToExchangeZoneThisTurn,
    };
}

/**
 * Emituje gameStateUpdate každému pripojenému hráčovi s jeho personalizovaným stavom.
 */
function emitGameStateToAll(io, gameInstance) {
    gameInstance.players.forEach((player, idx) => {
        if (player && player.socketId) {
            io.to(player.socketId).emit('gameStateUpdate', maskStateForPlayer(gameInstance.gameState, idx));
        }
    });
}

/**
 * Uloží kompletný stav hry ako štruktúrované polia do hlavného dokumentu scrabbleGames/{gameId}.
 * @param {object} gameInstance - Aktuálna inštancia hry.
 * @param {object} db - Inštancia Firestore admin.
 * @param {object} extraFields - Voliteľné extra polia (napr. endedAt, winnerId...).
 */
async function saveGameState(gameInstance, db, extraFields = {}) {
    if (!db || !gameInstance.gameState) return;
    const { gameState } = gameInstance;

    // Zaznamenáme, kedy sa ťah naposledy prepol na iného hráča — bez ohľadu na to,
    // ktorá akcia to spôsobila (schválenie, zamietnutie, bežný ťah, losovanie...).
    // Slúži na zoradenie "mojich rozohraných hier" v Lobby podľa toho, ako dlho už čakajú na môj ťah.
    if (gameInstance._lastKnownCurrentPlayerIndex !== gameState.currentPlayerIndex) {
        gameState.turnStartedAt = Date.now();
        gameInstance._lastKnownCurrentPlayerIndex = gameState.currentPlayerIndex;
    }

    const playersData = gameInstance.players
        .filter((p) => p !== null)
        .map((p) => ({
            id: p.userId,
            nickname: p.nickname,
            playerIndex: p.playerIndex,
            elo: p.elo,
            score: gameState.playerScores[p.playerIndex],
            rack: gameState.playerRacks[p.playerIndex],
        }));

    const connectedPlayerCount = gameInstance.players.filter(p => p !== null).length;
    const firestoreStatus = gameState.isGameOver
        ? 'finished'
        : gameState.gameStatus === 'AWAITING_WORD_VALIDATION'
        ? 'AWAITING_WORD_VALIDATION'
        : connectedPlayerCount < 2
        ? 'waiting'
        : 'in-progress';

    try {
        await db.collection('scrabbleGames').doc(gameInstance.gameId).set({
            board: boardToFirestore(gameState.board),
            boardAtStartOfTurn: boardToFirestore(gameState.boardAtStartOfTurn),
            letterBag: gameState.letterBag,
            playerRack0: gameState.playerRacks[0] ?? [],
            playerRack1: gameState.playerRacks[1] ?? [],
            playerScores: gameState.playerScores,
            scores: gameState.playerScores,
            playerTimes: gameState.playerTimes ?? null,
            currentPlayerIndex: gameState.currentPlayerIndex,
            isFirstTurn: gameState.isFirstTurn,
            isBagEmpty: gameState.isBagEmpty,
            exchangeZoneLetters: gameState.exchangeZoneLetters,
            hasPlacedOnBoardThisTurn: gameState.hasPlacedOnBoardThisTurn,
            hasMovedToExchangeZoneThisTurn: gameState.hasMovedToExchangeZoneThisTurn,
            consecutivePasses: gameState.consecutivePasses,
            isGameOver: gameState.isGameOver,
            gameStatus: gameState.gameStatus,
            turnDraw: gameState.turnDraw,
            highlightedLetters: gameState.highlightedLetters,
            turnNumber: gameState.turnNumber ?? 0,
            winnerIndex: gameState.winnerIndex ?? null,
            pendingTurn: gameState.pendingTurn ?? null,
            progress: countTilesOnBoard(gameState.board),
            status: firestoreStatus,
            players: playersData,
            turnStartedAt: gameState.turnStartedAt ?? null,
            ...extraFields,
        }, { merge: true });
    } catch (e) {
        console.error(`Chyba pri ukladaní stavu hry ${gameInstance.gameId}:`, e);
    }
}

/**
 * Načíta stav hry zo štruktúrovaných polí hlavného dokumentu scrabbleGames/{gameId}.
 * @param {string} gameId - ID hry.
 * @param {object} db - Inštancia Firestore admin.
 * @returns {object|null} Stav hry alebo null ak neexistuje.
 */
async function loadGameState(gameId, db) {
    try {
        const docSnap = await db.collection('scrabbleGames').doc(gameId).get();
        if (!docSnap.exists) return null;
        const data = docSnap.data();

        if (data.board !== undefined) {
            // Nový formát — štruktúrované polia v hlavnom dokumente
            // board môže byť chess objekt (A1–O15) alebo starší nested array
            const boardToLoad = Array.isArray(data.board)
                ? data.board
                : firestoreToBoard(data.board);
            const boardAtStartToLoad = Array.isArray(data.boardAtStartOfTurn)
                ? data.boardAtStartOfTurn
                : firestoreToBoard(data.boardAtStartOfTurn);
            return {
                board: boardToLoad,
                boardAtStartOfTurn: boardAtStartToLoad,
                letterBag: data.letterBag,
                playerRacks: data.playerRack0 !== undefined
                    ? [data.playerRack0, data.playerRack1 ?? []]
                    : (data.playerRacks ?? [[], []]),
                playerScores: data.playerScores,
                playerTimes: data.playerTimes ?? null,
                currentPlayerIndex: data.currentPlayerIndex,
                isFirstTurn: data.isFirstTurn,
                isBagEmpty: data.isBagEmpty,
                exchangeZoneLetters: data.exchangeZoneLetters ?? [],
                hasPlacedOnBoardThisTurn: data.hasPlacedOnBoardThisTurn ?? false,
                hasMovedToExchangeZoneThisTurn: data.hasMovedToExchangeZoneThisTurn ?? false,
                consecutivePasses: data.consecutivePasses ?? 0,
                isGameOver: data.isGameOver ?? false,
                gameStatus: data.gameStatus ?? 'in_progress',
                turnDraw: data.turnDraw ?? { 0: null, 1: null },
                highlightedLetters: data.highlightedLetters ?? [],
                turnNumber: data.turnNumber ?? 0,
                winnerIndex: data.winnerIndex ?? null,
                pendingTurn: data.pendingTurn ?? null,
                turnStartedAt: data.turnStartedAt ?? null,
                gameMode: data.gameMode,
                hasInitialGameStateReceived: true,
                playerNicknames: {},
            };
        }

        // Starý formát — fallback na gameStates/state subkolekciu
        console.log(`Hra ${gameId}: board nenájdený v hlavnom dokumente, skúšam starý formát...`);
        const legacySnap = await db
            .collection('scrabbleGames')
            .doc(gameId)
            .collection('gameStates')
            .doc('state')
            .get();

        if (legacySnap.exists && legacySnap.data()?.gameState) {
            const loadedState = JSON.parse(legacySnap.data().gameState);
            console.log(`Hra ${gameId}: načítaná zo starého formátu.`);
            return loadedState;
        }

        return null;
    } catch (e) {
        console.error(`Chyba pri načítaní stavu hry ${gameId}:`, e);
        return null;
    }
}

/**
 * Vypočíta finálne skóre, vytvorí záznam o konci hry a uloží ho do DB.
 * @param {object} gameInstance - Aktuálna inštancia hry.
 * @param {object} dbAdmin - Inštancia Firestore admin.
 * @param {object} details - Objekt s detailmi o konci hry { reason, winnerIndex, loserIndex, finishingPlayerIndex }.
 */
async function calculateAndLogFinalScores(gameInstance, dbAdmin, details) {
    const { reason, winnerIndex, finishingPlayerIndex = null } = details;
    const initialScores = [...gameInstance.gameState.playerScores];
    const finalRacks = gameInstance.gameState.playerRacks;

    let deductions = { 0: 0, 1: 0 };
    let bonus = 0;
    let finalScores = [...initialScores];
    let calculatedWinnerIndex = winnerIndex; // Predvolený víťaz (napr. pri vzdaní sa)

    // Výpočet skóre sa robí len pri štandardnom konci alebo po pasovaní
    if (reason === 'standard_end' || reason === 'pass_end') {
        // Vypočítame odpočítané body pre každého hráča
        finalRacks.forEach((rack, index) => {
            if (rack) {
                rack.forEach((letter) => {
                    if (letter)
                        deductions[index] += LETTER_VALUES[letter.letter] || 0;
                });
            }
        });

        // Ak hru niekto ukončil minutím všetkých písmen, pripočítame mu body súpera
        if (
            finishingPlayerIndex !== null &&
            finishingPlayerIndex !== undefined
        ) {
            const opponentIndex = 1 - finishingPlayerIndex;
            bonus = deductions[opponentIndex];
            finalScores[finishingPlayerIndex] += bonus;
        }

        // Odpočítame body obom hráčom z ich skóre
        finalScores[0] -= deductions[0];
        finalScores[1] -= deductions[1];

        // Určíme víťaza na základe finálneho skóre
        if (finalScores[0] > finalScores[1]) {
            calculatedWinnerIndex = 0;
        } else if (finalScores[1] > finalScores[0]) {
            calculatedWinnerIndex = 1;
        } else {
            calculatedWinnerIndex = null; // Remíza
        }
    }

    // DÔLEŽITÉ: Aktualizujeme gameState finálnym skóre
    gameInstance.gameState.playerScores = finalScores;
    gameInstance.gameState.winnerIndex = calculatedWinnerIndex;

    // Vytvoríme finálny záznam do denníka
    const logEntry = {
        actionType: 'game_over',
        reason: reason,
        initialScores,
        finalScores,
        deductions,
        bonus,
        winnerIndex: calculatedWinnerIndex,
        finishingPlayerIndex: finishingPlayerIndex,
        timestamp: Date.now(),
    };

    try {
        const turnLogCollectionRef = dbAdmin
            .collection('scrabbleGames')
            .doc(gameInstance.gameId)
            .collection('turnLogs');
        await turnLogCollectionRef.add(logEntry);
    } catch (e) {
        console.error("Chyba pri ukladaní záznamu 'game_over':", e);
    }
}

/**
 * Vráti políčka, ktoré boli počas aktuálneho ťahu položené na dosku (diff oproti boardAtStartOfTurn).
 * Každý záznam obsahuje { x, y, id, letter, ... } (skopírované z obsahu políčka).
 */
function getPlacedLettersFromBoardDiff(board, boardAtStartOfTurn) {
    const placed = [];
    for (let x = 0; x < board.length; x++) {
        for (let y = 0; y < board[x].length; y++) {
            if (board[x][y] !== null && boardAtStartOfTurn[x][y] === null) {
                placed.push({ x, y, ...board[x][y] });
            }
        }
    }
    return placed;
}

// NOVÁ FUNKCIA: Počíta, koľko políčok na doske obsahuje písmeno
const countTilesOnBoard = (board) => {
    let count = 0;
    if (board && Array.isArray(board)) {
        for (const row of board) {
            for (const tile of row) {
                // Počítame len políčka, ktoré majú pridelené písmeno
                if (tile != null) {
                    count++;
                }
            }
        }
    }
    return count;
};

/**
 * Aplikuje presun písmena na daný stav hry.
 * Toto je server-side verzia logiky, ktorá bola predtým na klientovi.
 * @param {object} gameState Aktuálny stav hry.
 * @param {object} payload Dáta z akcie { letterData, source, target }.
 * @param {number} playerIndex Index hráča, ktorý akciu vykonal.
 * @returns {object} Nový, upravený stav hry.
 */
function applyMoveLetter(gameState, payload, playerIndex) {
    const { letterData, source, target } = payload;

    let newPlayerRacks = gameState.playerRacks.map((rack) =>
        rack ? [...rack] : null
    );
    let newBoard = gameState.board.map((row) => [...row]);
    let newExchangeZoneLetters = [...gameState.exchangeZoneLetters];

    // Špeciálny prípad: presun v rámci stojana
    if (source.type === 'rack' && target.type === 'rack') {
        const fromIndex = source.index;
        const toIndex = target.index;

        if (newPlayerRacks[playerIndex][toIndex] === null) {
            newPlayerRacks[playerIndex][toIndex] =
                newPlayerRacks[playerIndex][fromIndex];
            newPlayerRacks[playerIndex][fromIndex] = null;
        } else {
            const [movedLetter] = newPlayerRacks[playerIndex].splice(
                fromIndex,
                1
            );
            newPlayerRacks[playerIndex].splice(toIndex, 0, movedLetter);
        }
        return { ...gameState, playerRacks: newPlayerRacks };
    }

    // Nájdenie a odstránenie písmena zo zdroja
    let letterToMove = null;
    if (source.type === 'board') {
        letterToMove = { ...newBoard[source.x][source.y] };
        newBoard[source.x][source.y] = null;
        if (letterToMove.letter === '') letterToMove.assignedLetter = null;
    } else if (source.type === 'rack') {
        // Nedôverujeme klientovmu letterData ako takému — použijeme skutočný
        // obsah racku na danom indexe. Ak sa nezhoduje s ID, ktoré klient tvrdí,
        // že tam presúva (napr. kvôli stale closure na klientovi), ťah zahodíme
        // namiesto toho, aby sme na cieľ skopírovali cudzie/duplicitné písmeno.
        const rackLetter = newPlayerRacks[playerIndex]?.[source.index];
        if (rackLetter && rackLetter.id === letterData?.id) {
            letterToMove = { ...rackLetter };
            newPlayerRacks[playerIndex][source.index] = null;
        }
    } else if (source.type === 'exchangeZone') {
        const index = newExchangeZoneLetters.findIndex(
            (l) => l.id === letterData.id
        );
        if (index !== -1) {
            [letterToMove] = newExchangeZoneLetters.splice(index, 1);
            if (letterToMove.letter === '') letterToMove.assignedLetter = null;
        }
    }

    if (!letterToMove) return gameState; // Ak sa písmeno nenašlo, vrátime pôvodný stav

    // Umiestnenie písmena na cieľ
    if (target.type === 'rack') {
        const targetRack = newPlayerRacks[playerIndex];
        if (targetRack) {
            // PRIORITA 1: Umiestniť na konkrétny voľný slot, kam hráč ťahal.
            if (
                target.index !== undefined &&
                targetRack[target.index] === null
            ) {
                targetRack[target.index] = letterToMove;
            }
            // PRIORITA 2: Vrátiť na pôvodné miesto (pre pravé kliknutie).
            else if (
                letterToMove.originalRackIndex !== undefined &&
                targetRack[letterToMove.originalRackIndex] === null
            ) {
                targetRack[letterToMove.originalRackIndex] = letterToMove;
            }
            // PRIORITA 3: Ak všetko ostatné zlyhá, nájsť prvé voľné miesto.
            else {
                const firstEmptyIndex = targetRack.findIndex((l) => l === null);
                if (firstEmptyIndex !== -1) {
                    targetRack[firstEmptyIndex] = letterToMove;
                }
            }
        }
    } else if (target.type === 'board') {
        const { originalRackIndex, ...letterWithoutOriginalIndex } = letterToMove;
        newBoard[target.x][target.y] = letterData.originalRackIndex !== undefined
            ? { ...letterWithoutOriginalIndex, originalRackIndex: letterData.originalRackIndex }
            : letterWithoutOriginalIndex;
    } else if (target.type === 'exchangeZone') {
        newExchangeZoneLetters.push(letterToMove);
    }

    // Vypočítame pomocné stavy, podobne ako na klientovi
    const placedLettersCount =
        newBoard.flat().filter((tile) => tile !== null).length -
        gameState.boardAtStartOfTurn.flat().filter((tile) => tile !== null)
            .length;

    return {
        ...gameState,
        playerRacks: newPlayerRacks,
        board: newBoard,
        exchangeZoneLetters: newExchangeZoneLetters,
        hasPlacedOnBoardThisTurn: placedLettersCount > 0,
        hasMovedToExchangeZoneThisTurn: newExchangeZoneLetters.length > 0,
    };
}

// --- LOGIKA PRE ČASOVAČ ---

/**
 * Zastaví existujúci časovač pre danú hru.
 * @param {string} gameId ID hry.
 */
function stopTimer(gameId) {
    if (activeTimers.has(gameId)) {
        clearInterval(activeTimers.get(gameId));
        activeTimers.delete(gameId);
    }
}

/**
 * Spracuje jeden "tik" časovača každú sekundu.
 * @param {string} gameId ID hry.
 * @param {object} io Inštancia Socket.IO.
 */
async function handleTimeTick(gameId, io) {
    const gameInstance = games.get(gameId);
    if (
        !gameInstance ||
        !gameInstance.gameState ||
        gameInstance.gameState.isGameOver
    ) {
        stopTimer(gameId);
        return;
    }

    const { gameState } = gameInstance;
    const playerIndex = gameState.currentPlayerIndex;

    // Znížime čas a skontrolujeme, či nevypršal
    if (gameState.playerTimes && gameState.playerTimes[playerIndex] > 0) {
        gameState.playerTimes[playerIndex]--;

        if (gameState.playerTimes[playerIndex] <= 0) {
            // ČAS VYPRŠAL
            stopTimer(gameId);
            console.log(
                `Hráčovi ${playerIndex + 1} v hre ${gameId} vypršal čas.`
            );

            const winnerIndex = 1 - playerIndex;
            const loserIndex = playerIndex;
            const winner = gameInstance.players.find(
                (p) => p.playerIndex === winnerIndex
            );
            const loser = gameInstance.players.find(
                (p) => p.playerIndex === loserIndex
            ); // Vypočítame finálne skóre a ELO

            if (winner && loser) {
                await calculateAndLogFinalScores(gameInstance, dbAdmin, {
                    reason: 'timeout',
                    winnerIndex,
                    loserIndex,
                });
                try {
                    const gameDocRef = dbAdmin.collection('scrabbleGames').doc(gameId);
                    const gameDoc = await gameDocRef.get();
                    if (gameDoc.exists && gameDoc.data().gameMode === 'competitive') {
                        await updateEloRatings(winner.userId, loser.userId);
                    }
                } catch (e) {
                    console.error(`Chyba pri finalizácii hry ${gameId} po vypršaní času:`, e);
                }
                await saveGameState(gameInstance, dbAdmin, {
                    endedAt: new Date(),
                    winnerId: winner.userId,
                    loserId: loser.userId,
                    gameOverReason: 'timeout',
                });
            }

            gameState.isGameOver = true;
            gameState.gameOverReason = `Hráčovi ${
                loser.nickname || loserIndex + 1
            } vypršal čas.`;
            emitGameStateToAll(io, gameInstance);
            return;
        }
    } // Pošleme aktualizáciu o čase všetkým hráčom v miestnosti

    io.to(gameId).emit('timeUpdate', { playerTimes: gameState.playerTimes });
}

/**
 * Spustí časovač pre aktuálneho hráča v danej hre.
 * @param {string} gameId ID hry.
 * @param {object} io Inštancia Socket.IO.
 */
function startTimer(gameId, io) {
    const gameInstance = games.get(gameId);
    if (
        !gameInstance ||
        !gameInstance.gameState ||
        !gameInstance.gameState.playerTimes
    ) {
        return; // Hra nemá časovač
    }

    stopTimer(gameId); // Najprv zastavíme akýkoľvek predchádzajúci časovač pre istotu

    const intervalId = setInterval(() => {
        handleTimeTick(gameId, io);
    }, 1000);

    activeTimers.set(gameId, intervalId);
}

export default function initializeSocket(io, dbAdmin) {
    io.on('connection', (socket) => {
        console.log(`Nový klient pripojený: ${socket.id}`);

        socket.on('joinGame', async ({ gameId: gameIdFromClient, userId }) => {
            logAction('joinGame', gameIdFromClient, '?', { socketId: socket.id, userId });
            if (!gameIdFromClient) {
                gameIdFromClient = 'default-scrabble-game';
                console.log(
                    `Klient ${socket.id} sa pokúsil pripojiť bez ID hry. Priradené defaultné ID: ${gameIdFromClient}`
                );
            }

            if (!userId) {
                socket.emit(
                    'gameError',
                    'Pre pripojenie k hre je potrebné ID používateľa.'
                );
                console.warn(
                    `Klient ${socket.id} sa pokúsil pripojiť k hre ${gameIdFromClient} bez ID používateľa.`
                );
                return;
            }

            let gameInstance = games.get(gameIdFromClient);

            if (!gameInstance) {
                gameInstance = createNewGameInstance(gameIdFromClient);
                games.set(gameIdFromClient, gameInstance);
                console.log(
                    `Vytvorená nová inštancia hry v pamäti s ID: ${gameIdFromClient}`
                );
            }

            let gameDocSnap = null;
            let gameData = null;

            if (dbAdmin) {
                try {
                    const gameDocRef = dbAdmin
                        .collection('scrabbleGames')
                        .doc(gameIdFromClient);
                    gameDocSnap = await gameDocRef.get();

                    if (gameDocSnap.exists) {
                        gameData = gameDocSnap.data();
                        if (
                            gameData.players &&
                            Array.isArray(gameData.players)
                        ) {
                            // Prekopíruj hráčov z DB do našej in-memory inštancie
                            gameData.players.forEach((playerFromDb) => {
                                if (
                                    playerFromDb &&
                                    playerFromDb.playerIndex !== undefined
                                ) {
                                    // Ak je tento hráč už v pamäti (rovnaké userId) a má živý
                                    // socket, zachováme ho — inak by pripojenie/reconnect
                                    // JEDNÉHO hráča vynulovalo socket toho druhého, už pripojeného.
                                    const existing =
                                        gameInstance.players[
                                            playerFromDb.playerIndex
                                        ];
                                    const preservedSocketId =
                                        existing &&
                                        existing.userId === playerFromDb.id
                                            ? existing.socketId
                                            : null;
                                    gameInstance.players[
                                        playerFromDb.playerIndex
                                    ] = {
                                        userId: playerFromDb.id,
                                        nickname: playerFromDb.nickname,
                                        playerIndex: playerFromDb.playerIndex,
                                        elo: playerFromDb.elo,
                                        socketId: preservedSocketId,
                                    };
                                }
                            });
                            console.log(
                                `Hráči inicializovaní z Firestore pre hru ${gameIdFromClient}:`,
                                gameInstance.players.map((p) => p?.userId)
                            );
                        }
                    }
                } catch (e) {
                    console.error(
                        `Chyba pri inicializácii hráčov z Firestore pre hru ${gameIdFromClient}:`,
                        e
                    );
                }
            }

            socket.join(gameIdFromClient);

            if (gameTimeouts.has(gameIdFromClient)) {
                clearTimeout(gameTimeouts.get(gameIdFromClient));
                gameTimeouts.delete(gameIdFromClient);
                console.log(
                    `Timeout pre hru ${gameIdFromClient} zrušený (hráč sa pripojil).`
                );
            }

            socket.gameInstance = gameInstance;
            socket.gameId = gameIdFromClient;
            socket.userId = userId;

            let playerIndex = -1;
            let playerNickname = userId;
            let playerElo = 1600;

            if (dbAdmin) {
                try {
                    const userDocRef = dbAdmin.collection('users').doc(userId);
                    const userDocSnap = await userDocRef.get();
                    if (userDocSnap.exists && userDocSnap.data()) {
                        const userData = userDocSnap.data(); // <<< --- ZMENENÉ, aby sme sa vyhli opakovaniu
                        if (userData.nickname) {
                            playerNickname = userData.nickname;
                        }
                        if (userData.elo) {
                            playerElo = userData.elo;
                        }
                    } else {
                        console.log(
                            `Prezývka a ELO pre užívateľa ${userId} neboli nájdené vo Firestore. Používam defaultné hodnoty.`
                        );
                    }
                } catch (e) {
                    console.error(
                        `Chyba pri načítaní prezývky a ELO pre užívateľa ${userId}:`,
                        e
                    );
                }
            }

            if (!gameInstance.players || gameInstance.players.length === 0) {
                gameInstance.players = [null, null];
            }

            for (let i = 0; i < gameInstance.players.length; i++) {
                if (
                    gameInstance.players[i] &&
                    gameInstance.players[i].userId === userId
                ) {
                    playerIndex = i;
                    gameInstance.players[i].socketId = socket.id;
                    gameInstance.players[i].nickname = playerNickname;
                    gameInstance.players[i].elo = playerElo;
                    console.log(
                        `Klient ${
                            socket.id
                        } (User: ${userId}) sa znovu pripojil k hre ${gameIdFromClient} ako Hráč ${
                            playerIndex + 1
                        }.`
                    );
                    break;
                }
            }

            if (playerIndex === -1) {
                if (gameInstance.players[0] === null) {
                    playerIndex = 0;
                    gameInstance.players[0] = {
                        userId: userId,
                        playerIndex: 0,
                        socketId: socket.id,
                        nickname: playerNickname,
                        elo: playerElo,
                    };
                    console.log(
                        `Klient ${socket.id} (User: ${userId}) sa pripojil k hre ${gameIdFromClient} ako Hráč 1.`
                    );
                } else if (gameInstance.players[1] === null) {
                    playerIndex = 1;
                    gameInstance.players[1] = {
                        userId: userId,
                        playerIndex: 1,
                        socketId: socket.id,
                        nickname: playerNickname,
                        elo: playerElo,
                    };
                    console.log(
                        `Klient ${socket.id} (User: ${userId}) sa pripojil k hre ${gameIdFromClient} ako Hráč 2.`
                    );
                } else {
                    // OBA SLOTY SÚ PLNÉ - POUŽÍVATEĽ SA PRIPÁJA AKO DIVÁK
                    socket.role = 'spectator';
                    playerIndex = null; // Divák nemá index hráča
                    console.log(
                        `Klient ${socket.id} (User: ${userId}) sa pripojil k plnej hre ${gameIdFromClient} ako DIVÁK.`
                    );
                    // Nevysielame 'gameError', pretože je to v poriadku. Kód pokračuje ďalej,
                    // aby aj divák dostal aktuálny stav hry.
                }
            }

            gameInstance.playerSockets[socket.id] = socket;
            socket.playerIndex = playerIndex;

            if (dbAdmin) {
                try {
                    const gamePlayersDocRef = dbAdmin
                        .collection('scrabbleGames')
                        .doc(gameIdFromClient)
                        .collection('players')
                        .doc('data');
                    await gamePlayersDocRef.set(
                        { players: JSON.stringify(gameInstance.players) },
                        { merge: true }
                    );
                } catch (e) {
                    console.error(
                        `Chyba pri ukladaní stavu hráčov ${gameIdFromClient} do Firestore po pripojení:`,
                        e
                    );
                }
            }

            socket.emit('playerAssigned', playerIndex);

            if (dbAdmin) {
                try {
                    const gameDocRef = dbAdmin
                        .collection('scrabbleGames')
                        .doc(gameIdFromClient);
                    const gameDocSnap = await gameDocRef.get();
                    const gameData = gameDocSnap.data();

                    // Načítaj aktuálny progress z hlavného dokumentu
                    const progressFromDB = gameData?.progress ?? 0;

                    // Skontroluj, či hlavný dokument hry obsahuje aj skóre. Ak nie, pridaj ich
                    if (
                        !gameData ||
                        !gameData.scores ||
                        gameData.scores.length === 0
                    ) {
                        await gameDocRef.set(
                            { scores: [0, 0] },
                            { merge: true }
                        );
                    }

                    // Ak v pamäti servera ešte neexistuje stav hry (napr. po reštarte servera),
                    // pokúsime sa ho načítať z databázy.
                    if (!gameInstance.gameState) {
                        console.log(`Stav hry ${gameIdFromClient} nie je v pamäti, načítavam z DB...`);
                        const loadedState = await loadGameState(gameIdFromClient, dbAdmin);

                        if (loadedState) {
                            gameInstance.gameState = loadedState;
                            gameInstance.isGameStarted = true;
                            gameInstance._lastKnownCurrentPlayerIndex = loadedState.currentPlayerIndex;
                            console.log(`Stav hry ${gameIdFromClient} úspešne načítaný z DB.`);
                        } else {
                            gameInstance.gameState = generateInitialGameState();
                            gameInstance.isGameStarted = true;
                            await saveGameState(gameInstance, dbAdmin);
                            console.log(`Nový stav hry ${gameIdFromClient} inicializovaný a uložený do Firestore.`);
                        }
                    }

                    // Získaj stav progresu priamo z dát.
                    // const actualProgress = countTilesOnBoard(gameInstance.gameState.board);

                    // Uložíme aktuálny progress do hlavného dokumentu po pripojení hráča
                    // await gameDocRef.update({ progress: actualProgress }, { merge: true });

                    // Odoslanie stavu hry klientovi
                    const playerNicknamesMap = {};
                    gameInstance.players.forEach((p) => {
                        if (p) {
                            playerNicknamesMap[p.playerIndex] =
                                p.nickname || `Hráč ${p.playerIndex + 1}`;
                        }
                    });
                    gameInstance.gameState.playerNicknames = playerNicknamesMap;
                    gameInstance.gameState.players = gameInstance.players;

                    // Pošleme čerstvý stav VŠETKÝM pripojeným (nielen práve pripojenému
                    // klientovi), aby súper hneď videl, že sa hráč (znovu) pripojil.
                    emitGameStateToAll(io, gameInstance);

                    // Načítanie a odoslanie chatovej histórie
                    try {
                        const chatHistoryCollectionRef = dbAdmin
                            .collection('scrabbleGames')
                            .doc(gameIdFromClient)
                            .collection('chatMessages');
                        const querySnapshot = await chatHistoryCollectionRef
                            .orderBy('timestamp')
                            .get();

                        const chatHistory = [];
                        querySnapshot.forEach((doc) => {
                            chatHistory.push(doc.data());
                        });

                        // Uloženie do pamäte servera pre rýchly prístup
                        gameInstance.chatMessages = chatHistory;

                        // Odoslanie histórie chatu iba TOMUTO klientovi, ktorý sa práve pripojil
                        socket.emit('chatHistory', chatHistory);
                        console.log(
                            `Odoslaná história chatu pre hru ${gameIdFromClient} klientovi ${socket.id}. Správ: ${chatHistory.length}`
                        );
                    } catch (e) {
                        console.error(
                            `Chyba pri načítavaní chatovej histórie pre hru ${gameIdFromClient} z Firestore:`,
                            e
                        );
                    }

                    // Pošleme aj informáciu o progres bare do lobby
                    const gameDetails = {
                        id: gameIdFromClient,
                        currentPlayerIndex:
                            gameInstance.gameState.currentPlayerIndex,
                        // progress: actualProgress, // Posielame skutočný progress
                        scores: gameInstance.gameState.playerScores || [0, 0], // Ak skóre chýba, inicializujeme na [0, 0]
                    };

                    // Toto by mal zachytiť front-end komponent, ktorý zobrazuje lobby
                    io.to(gameIdFromClient).emit(
                        'gameProgressUpdate',
                        gameDetails
                    );

                    // ... (zvyšok tvojho kódu)
                } catch (e) {
                    console.error(
                        `Chyba pri načítaní/inicializácii stavu hry alebo chatu ${gameIdFromClient} z Firestore:`,
                        e
                    );
                    if (!gameInstance.gameState) {
                        gameInstance.gameState = generateInitialGameState();
                        console.log(
                            'Fallback: Inicializovaný nový stav hry kvôli chybe Firestore.'
                        );
                    }
                }
            } else {
                if (!gameInstance.gameState) {
                    gameInstance.gameState = generateInitialGameState();
                    console.log(
                        'Fallback: Inicializovaný nový stav hry (bez Firestore) pre hru:',
                        gameIdFromClient
                    );
                }
            }

            if (gameInstance.gameState) {
                const playerNicknamesMap = {};
                gameInstance.players.forEach((p) => {
                    if (p) {
                        playerNicknamesMap[p.playerIndex] =
                            p.nickname || `Hráč ${p.playerIndex + 1}`;
                    }
                });
                gameInstance.gameState.playerNicknames = playerNicknamesMap;
                gameInstance.gameState.players = gameInstance.players;

                if (gameData && gameData.gameMode) {
                    gameInstance.gameState.gameMode = gameData.gameMode;
                } else {
                    // Predvolená hodnota, ak by v starších hrách chýbala
                    gameInstance.gameState.gameMode = 'competitive';
                }

                // Pošleme čerstvý stav VŠETKÝM pripojeným (nielen práve pripojenému
                // klientovi), aby súper hneď videl, že sa hráč (znovu) pripojil.
                emitGameStateToAll(io, gameInstance);
                const connectedPlayersCount = gameInstance.players.filter(
                    (p) => p !== null && p.socketId !== null
                ).length;

                if (connectedPlayersCount < 2) {
                    io.to(gameInstance.gameId).emit(
                        'waitingForPlayers',
                        'Čaká sa na druhého hráča...'
                    );
                    // console.log(`Server: Hra ${gameIdFromClient}: Čaká sa na druhého hráča. Aktuálni pripojení hráči: ${connectedPlayersCount}`);
                } else {
                    // console.log(`Server: Hra ${gameIdFromClient}: Všetci hráči pripojení. Hra môže začať.`);

                    if (dbAdmin) {
                        try {
                            // Vytvoríme pole hráčov s ich aktuálnym ELO, ktoré sa uloží do dokumentu hry
                            const playersWithElo = gameInstance.players
                                .filter((p) => p !== null)
                                .map((p) => ({
                                    id: p.userId,
                                    nickname: p.nickname,
                                    playerIndex: p.playerIndex,
                                    elo: p.elo, // Pridáme ELO hráča v momente štartu
                                }));

                            const gameDocRef = dbAdmin
                                .collection('scrabbleGames')
                                .doc(gameIdFromClient);
                            // currentPlayerIndex sa NEZAPISUJE tu — jediný zdroj pravdy
                            // pre toto pole je saveGameState(), inak hrozí race condition
                            // pri súbežnom zápise (reconnect vs. spracovanie ťahu), kedy
                            // Firestore môže aplikovať tento starší zápis až po tom novšom.
                            await gameDocRef.set(
                                {
                                    status: 'in-progress',
                                    players: playersWithElo, // Uložíme hráčov aj s ich "zmrazeným" ELO
                                },
                                { merge: true }
                            );
                        } catch (e) {
                            console.error(
                                `Chyba pri ukladaní počiatočného stavu hry ${gameIdFromClient} do Firestore po pripojení druhého hráča:`,
                                e
                            );
                        }
                    }
                }
            } else {
                console.error(
                    `Server: Kritická chyba: GameState pre hru ${gameIdFromClient} je stále null po všetkých pokusoch o inicializáciu.`
                );
                socket.emit(
                    'gameError',
                    'Kritická chyba: Nepodarilo sa inicializovať stav hry.'
                );
            }
        });

        socket.on('playerAction', async (action) => {
            const gameInstance = socket.gameInstance;
            if (!gameInstance) {
                socket.emit('gameError', 'Nie ste pripojený k žiadnej hre.');
                console.warn(
                    `Hráč ${socket.id} sa pokúsil o akciu ${action.type}, ale nie je pripojený k žiadnej hre.`
                );
                return;
            }

            if (
                gameInstance.gameState &&
                action.type !== 'chatMessage' &&
                action.type !== 'turnSubmitted' &&
                action.type !== 'drawForTurn' &&
                action.type !== 'playerLeftGame' &&
                action.type !== 'resolveTurnValidation' &&
                action.type !== 'gameOver' &&
                gameInstance.gameState.currentPlayerIndex !== socket.playerIndex
            ) {
                socket.emit('gameError', 'Nie je váš ťah!');
                console.warn(
                    `Hráč ${socket.playerIndex + 1} sa pokúsil o akciu ${
                        action.type
                    }, ale nie je na ťahu v hre ${gameInstance.gameId}.`
                );
                return;
            }

            if (gameInstance.gameState && gameInstance.gameState.lastTurnInfo) {
                console.log('TOTO CHCEM VIDIET');
                console.log(gameInstance.gameState.lastTurnInfo);
                delete gameInstance.gameState.lastTurnInfo;
            }

            // Kompletný log KAŽDEJ akcie hráča na jednom mieste (nie roztrúsene
            // po jednotlivých case vetvách) — nech sa dá spätne rekonštruovať,
            // čo presne kto poslal a kedy, keď treba dohľadať čo sa pokazilo.
            // Zámerne len console.log (zachytáva hosting v svojich logoch) —
            // nezaťažuje to Firestore zápismi pri každom potiahnutí písmena.
            logAction(action.type, gameInstance.gameId, socket.playerIndex, action.payload);

            switch (action.type) {
                case 'drawForTurn': {
                    if (
                        gameInstance.gameState.gameStatus !== 'drawing_for_turn'
                    ) {
                        return socket.emit(
                            'gameError',
                            'Hra nie je vo fáze losovania.'
                        );
                    }
                    if (
                        gameInstance.gameState.turnDraw[socket.playerIndex] !==
                        null
                    ) {
                        return socket.emit(
                            'gameError',
                            'Už si si vylosoval písmeno.'
                        );
                    }

                    // --- KROK 2: Hráč si potiahne písmeno (zostáva rovnaké) ---
                    const { drawnLetters, remainingBag } = drawLetters(
                        gameInstance.gameState.letterBag,
                        1
                    );
                    if (drawnLetters.length === 0) {
                        return socket.emit(
                            'gameError',
                            'Vo vrecúšku nie sú žiadne písmená na losovanie.'
                        );
                    }
                    const drawnLetter = drawnLetters[0];

                    gameInstance.gameState.turnDraw[socket.playerIndex] =
                        drawnLetter;
                    gameInstance.gameState.letterBag = remainingBag;

                    // --- KROK 3: ULOŽENIE STAVU A ROZHODNUTIE, ČO ĎALEJ ---

                    // Najprv vždy uložíme aktuálny stav po losovaní do DB
                    await saveGameState(gameInstance, dbAdmin);

                    const { turnDraw } = gameInstance.gameState;

                    // Ak ešte nelosoval druhý hráč, len pošleme update a čakáme.
                    if (!turnDraw[0] || !turnDraw[1]) {
                        emitGameStateToAll(io, gameInstance);
                        break;
                    }

                    // Ak sme tu, znamená to, že si práve potiahol druhý hráč. Nasleduje vyhodnotenie.
                    const letter1 = turnDraw[0].letter;
                    const letter2 = turnDraw[1].letter;
                    let startingPlayerIndex = null;

                    if (letter1 === '' && letter2 !== '')
                        startingPlayerIndex = 1;
                    else if (letter2 === '' && letter1 !== '')
                        startingPlayerIndex = 0;
                    else if (letter1.localeCompare(letter2, 'sk') < 0)
                        startingPlayerIndex = 0;
                    else if (letter1.localeCompare(letter2, 'sk') > 0)
                        startingPlayerIndex = 1;

                    if (startingPlayerIndex !== null) {
                        // VÍŤAZ LOSOVANIA
                        gameInstance.gameState.gameStatus = 'turn_draw_reveal';
                        gameInstance.gameState.turnDrawWinner =
                            startingPlayerIndex;
                        emitGameStateToAll(io, gameInstance); // Pošleme výsledok

                        setTimeout(async () => {
                            // --- INICIALIZÁCIA ČASOVAČA ---
                            const { gameState } = gameInstance;
                            let playerTimes = null;
                            if (dbAdmin) {
                                try {
                                    const gameDocRef = dbAdmin
                                        .collection('scrabbleGames')
                                        .doc(gameInstance.gameId);
                                    const gameDoc = await gameDocRef.get();
                                    if (gameDoc.exists) {
                                        const timeLimitMinutes =
                                            gameDoc.data().timeLimitMinutes;
                                        if (timeLimitMinutes) {
                                            // Ak je timeLimit nastavený (nie je null)
                                            const timeInSeconds =
                                                timeLimitMinutes * 60;
                                            playerTimes = [
                                                timeInSeconds,
                                                timeInSeconds,
                                            ];
                                        }
                                    }
                                } catch (e) {
                                    console.error(
                                        'Chyba pri načítaní timeLimitMinutes:',
                                        e
                                    );
                                }
                            }
                            gameInstance.gameState.playerTimes = playerTimes; // -------------------------------
                            try {
                                const logEntry = {
                                    actionType: 'draw_result',
                                    turnNumber: 0, // Špeciálne číslo ťahu pre losovanie
                                    drawnLetters: {
                                        // Uložíme obe písmená pre zobrazenie
                                        0: turnDraw[0],
                                        1: turnDraw[1],
                                    },
                                    winnerIndex: startingPlayerIndex,
                                    timestamp: Date.now(),
                                };

                                const turnLogCollectionRef = dbAdmin
                                    .collection('scrabbleGames')
                                    .doc(gameInstance.gameId)
                                    .collection('turnLogs');
                                await turnLogCollectionRef.add(logEntry);
                            } catch (e) {
                                console.error(
                                    'Chyba pri ukladaní záznamu o losovaní:',
                                    e
                                );
                            }
                            let finalBag = [
                                ...gameInstance.gameState.letterBag,
                                turnDraw[0],
                                turnDraw[1],
                            ];
                            for (let i = finalBag.length - 1; i > 0; i--) {
                                const j = Math.floor(Math.random() * (i + 1));
                                [finalBag[i], finalBag[j]] = [
                                    finalBag[j],
                                    finalBag[i],
                                ];
                            }

                            gameInstance.gameState.letterBag = finalBag;
                            gameInstance.gameState.currentPlayerIndex =
                                startingPlayerIndex;
                            gameInstance.gameState.gameStatus = 'in_progress';
                            gameInstance.gameState.turnDraw = {
                                0: null,
                                1: null,
                            };
                            gameInstance.gameState.turnDrawWinner = null;

                            await saveGameState(gameInstance, dbAdmin);
                            startTimer(gameInstance.gameId, io);
                            emitGameStateToAll(io, gameInstance); // Spustíme hru
                        }, 4000);
                    } else {
                        // REMÍZA
                        let finalBag = [
                            ...gameInstance.gameState.letterBag,
                            turnDraw[0],
                            turnDraw[1],
                        ];
                        for (let i = finalBag.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [finalBag[i], finalBag[j]] = [
                                finalBag[j],
                                finalBag[i],
                            ];
                        }
                        gameInstance.gameState.letterBag = finalBag;
                        gameInstance.gameState.turnDraw = { 0: null, 1: null };

                        await saveGameState(gameInstance, dbAdmin);
                        emitGameStateToAll(io, gameInstance);
                    }
                    break;
                }
                case 'moveLetter':
                    if (gameInstance.gameState) {
                        // Aplikujeme zmenu pomocou našej novej funkcie
                        const newGameState = applyMoveLetter(
                            gameInstance.gameState,
                            action.payload,
                            socket.playerIndex
                        );
                        gameInstance.gameState = newGameState;

                        // Uložíme nový stav do DB a rozošleme všetkým
                        // if (dbAdmin) {
                        //     try {
                        //         const gameStateDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId).collection('gameStates').doc('state');
                        //         await gameStateDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                        //     } catch (e) {
                        //         console.error(`Chyba pri ukladaní stavu hry ${gameInstance.gameId} do Firestore z akcie moveLetter:`, e);
                        //     }
                        // }
                        socket.emit('moveLetter', {
                            ...action.payload,
                            playerIndex: socket.playerIndex,
                        });
                    }
                    break;
                case 'returnAllToRack': {
                    const { gameState } = gameInstance;
                    if (!gameState) break;
                    // Ťah, ktorý čaká na schválenie súperom, sa nesmie dať vziať späť —
                    // currentPlayerIndex je vtedy už prepnutý na súpera (schvaľovateľa).
                    if (gameState.currentPlayerIndex !== socket.playerIndex) break;

                    const newBoard = gameState.board.map(row => [...row]);
                    const newRack = [...(gameState.playerRacks[socket.playerIndex] || [])];
                    let changed = false;

                    for (let x = 0; x < newBoard.length; x++) {
                        for (let y = 0; y < newBoard[x].length; y++) {
                            if (newBoard[x][y] !== null && gameState.boardAtStartOfTurn[x][y] === null) {
                                const slot = newRack.findIndex(s => s === null);
                                if (slot !== -1) {
                                    newRack[slot] = newBoard[x][y];
                                    newBoard[x][y] = null;
                                    changed = true;
                                }
                            }
                        }
                    }

                    for (const letter of gameState.exchangeZoneLetters) {
                        const slot = newRack.findIndex(s => s === null);
                        if (slot !== -1) {
                            newRack[slot] = letter;
                            changed = true;
                        }
                    }

                    if (!changed) break;

                    gameInstance.gameState = {
                        ...gameState,
                        board: newBoard,
                        playerRacks: gameState.playerRacks.map((r, i) => i === socket.playerIndex ? newRack : r),
                        exchangeZoneLetters: [],
                        hasPlacedOnBoardThisTurn: false,
                        hasMovedToExchangeZoneThisTurn: false,
                    };

                    emitGameStateToAll(io, gameInstance);
                    break;
                }
                case 'submitTurnForApproval': {
                    if (gameInstance.gameState) {
                        // Získame všetky dáta z payloadu

                        const {
                            placedLetters,
                            unverifiedWords,
                            turnScore,
                            allFormedWords,
                        } = action.payload;
                        // // Nastavíme nový stav hry
                        gameInstance.gameState.gameStatus =
                            'AWAITING_WORD_VALIDATION';
                        gameInstance.gameState.currentPlayerIndex =
                            1 - socket.playerIndex;

                        // Uložíme si všetky informácie o ťahu
                        gameInstance.gameState.pendingTurn = {
                            playerIndex: socket.playerIndex,
                            placedLetters: placedLetters,
                            unverifiedWords: unverifiedWords,
                            turnScore: turnScore, // Uložíme aj skóre
                            allFormedWords: allFormedWords, // Uložíme aj slová
                        };

                        stopTimer(gameInstance.gameId);

                        // Uložíme zmenený stav hry do DB
                        await saveGameState(gameInstance, dbAdmin);
                        if (dbAdmin) {
                            try {
                                const logEntry = {
                                    actionType: 'turn_validation_pending',
                                    playerIndex: socket.playerIndex,
                                    opponentIndex: 1 - socket.playerIndex,
                                    unverifiedWords: unverifiedWords,
                                    timestamp: Date.now(),
                                };
                                const turnLogCollectionRef = dbAdmin
                                    .collection('scrabbleGames')
                                    .doc(gameInstance.gameId)
                                    .collection('turnLogs');
                                await turnLogCollectionRef.add(logEntry);
                            } catch (e) {
                                console.error(
                                    `Chyba pri ukladaní logu pre hru ${gameInstance.gameId} pri čakaní na schválenie:`,
                                    e
                                );
                            }
                        }

                        // Rozošleme všetkým hráčom nový stav
                        emitGameStateToAll(io, gameInstance);
                    }
                    break;
                }
                case 'resolveTurnValidation': {
                    const { approved } = action.payload;
                    const { gameState } = gameInstance;
                    let saveExtraFields = {};
                    const { pendingTurn } = gameState;

                    // --- Validácia ---
                    if (
                        gameState.gameStatus !== 'AWAITING_WORD_VALIDATION' ||
                        !pendingTurn
                    ) {
                        return socket.emit(
                            'gameError',
                            'Hra nie je v stave čakania na schválenie.'
                        );
                    }
                    const opponentIndex = 1 - pendingTurn.playerIndex;
                    if (socket.playerIndex !== opponentIndex) {
                        return socket.emit(
                            'gameError',
                            'Iba súper môže schváliť alebo zamietnuť ťah.'
                        );
                    }

                    if (approved) {
                        // --- ŤAH SCHVÁLENÝ ---

                        const {
                            playerIndex,
                            placedLetters,
                            turnScore,
                            allFormedWords,
                        } = pendingTurn;

                        gameState.lastTurnInfo = {
                            playerIndex: playerIndex,
                            score: turnScore,
                            words: allFormedWords,
                            type: 'approved', // Typ pre rozlíšenie, že ide o schválený ťah
                        };

                        gameState.playerScores[playerIndex] += turnScore;
                        gameState.isFirstTurn = false;

                        // Rack pred ťahom — zachytíme HO PRED prepočtom nižšie,
                        // nech ho vieme zapísať do logu v tej istej jednotnej
                        // schéme ako priame potvrdenie ťahu (confirmTurn na klientovi).
                        const rackBeforeTurnValidation = gameState.playerRacks[playerIndex];
                        gameState.turnNumber = (gameState.turnNumber || 0) + 1;

                        // Počet položených písmen zo servera (nie z klienta)
                        const serverPlaced = getPlacedLettersFromBoardDiff(
                            gameState.board,
                            gameState.boardAtStartOfTurn
                        );
                        // Filter racku použije server-side IDs aj klientske IDs (dvojitá ochrana)
                        const serverPlacedIds = new Set(serverPlaced.map(p => p.id));
                        const clientPlacedIds = new Set(placedLetters.map(p => p.letterData?.id).filter(Boolean));
                        // Exchange zona môže mať písmená ak frontend pustil confirm pri stale stave — vrátime ich do racku
                        const exchangeInFlightValidation = gameState.exchangeZoneLetters || [];
                        const exchangeIdsValidation = new Set(exchangeInFlightValidation.map(l => l.id));
                        const remainingValidation = gameState.playerRacks[playerIndex].filter(
                            (l) =>
                                l !== null &&
                                !serverPlacedIds.has(l.id) &&
                                !clientPlacedIds.has(l.id) &&
                                !exchangeIdsValidation.has(l.id)
                        );
                        const availableValidation = [...remainingValidation, ...exchangeInFlightValidation];
                        // Dokreslíme presne toľko, aby bol rack plný (max 7)
                        const numToDrawValidation = Math.max(0, Math.min(7 - availableValidation.length, gameState.letterBag.length));
                        const { drawnLetters, remainingBag, bagEmpty } =
                            drawLetters(gameState.letterBag, numToDrawValidation);
                        let newRack = [...availableValidation, ...drawnLetters];

                        // Jednotná schéma pre turnLogs — rovnaká ako pri priamom
                        // potvrdení ťahu (confirmTurn na klientovi), aby sa dal
                        // log naprieč oboma tokmi spracovávať rovnako (napr. pri
                        // spätnej rekonštrukcii/replay-i). Žiadne board/bag
                        // snapshoty — sú redundantné voči placedLetters.
                        const turnDetails = {
                            actionType: 'placeLetters',
                            playerIndex: playerIndex,
                            placedLetters: placedLetters,
                            newWords: allFormedWords,
                            score: turnScore,
                            turnNumber: gameState.turnNumber,
                            timestamp: Date.now(),
                            exchangedLetters: null,
                            rackBeforeTurn: rackBeforeTurnValidation,
                            lettersDrawn: drawnLetters,
                        };
                        try {
                            const approvalLogEntry = {
                                actionType: 'turn_approved',
                                playerIndex: socket.playerIndex,
                                originalPlayerIndex: pendingTurn.playerIndex,
                                timestamp: Date.now() - 1,
                            };
                            const turnLogCollectionRef = dbAdmin
                                .collection('scrabbleGames')
                                .doc(gameInstance.gameId)
                                .collection('turnLogs');
                            await turnLogCollectionRef.add(approvalLogEntry);
                            await turnLogCollectionRef.add(turnDetails);
                        } catch (e) {
                            console.error(
                                `Chyba pri ukladaní schváleného ťahu do logu:`,
                                e
                            );
                        }

                        // --- NOVÁ KONTROLA KONCA HRY ---
                        if (bagEmpty && newRack.length === 0) {
                            // HRA SKONČILA
                            gameState.playerRacks[playerIndex] = newRack.map(
                                () => null
                            );
                            gameState.letterBag = remainingBag;
                            gameState.isBagEmpty = true;
                            gameState.isGameOver = true;

                            await calculateAndLogFinalScores(
                                gameInstance,
                                dbAdmin,
                                {
                                    reason: 'standard_end',
                                    finishingPlayerIndex: playerIndex,
                                }
                            );

                            const winner = gameInstance.players.find(
                                (p) =>
                                    p && p.playerIndex === gameState.winnerIndex
                            );
                            const loser = gameInstance.players.find(
                                (p) =>
                                    p &&
                                    p.playerIndex === 1 - gameState.winnerIndex
                            );

                            if (winner && loser) {
                                try {
                                    const gameDocRef = dbAdmin
                                        .collection('scrabbleGames')
                                        .doc(gameInstance.gameId);
                                    const gameDoc = await gameDocRef.get();
                                    if (gameDoc.exists && gameDoc.data().gameMode === 'competitive') {
                                        await updateEloRatings(winner.userId, loser.userId);
                                    }
                                } catch (e) {
                                    console.error(`Chyba pri finalizácii hry ${gameInstance.gameId}:`, e);
                                }
                                saveExtraFields = {
                                    endedAt: new Date(),
                                    winnerId: winner.userId,
                                    loserId: loser.userId,
                                    gameOverReason: 'standard_end',
                                };
                            }
                        } else {
                            // HRA POKRAČUJE - bežný ťah
                            while (newRack.length < 7) {
                                newRack.push(null);
                            }
                            newRack = newRack.slice(0, 7); // Bezpečnostná poistka — rack nikdy nebude > 7
                            gameState.playerRacks[playerIndex] = newRack;

                            gameState.letterBag = remainingBag;
                            gameState.isBagEmpty = bagEmpty;
                            gameState.boardAtStartOfTurn = gameState.board.map(
                                (row) => [...row]
                            );
                            gameState.currentPlayerIndex = opponentIndex;
                            gameState.consecutivePasses = 0;
                            gameState.hasPlacedOnBoardThisTurn = false;
                            gameState.hasMovedToExchangeZoneThisTurn = false;
                            gameState.exchangeZoneLetters = [];
                            gameState.highlightedLetters = serverPlaced.map(
                                (p) => ({ x: p.x, y: p.y })
                            );
                        }
                    } else {
                        // --- ŤAH ZAMIETNUTÝ ---

                        gameState.lastTurnInfo = {
                            playerIndex: pendingTurn.playerIndex, // Koho ťah bol zamietnutý
                            opponentIndex: socket.playerIndex, // Kto ho zamietol
                            words: pendingTurn.unverifiedWords,
                            type: 'rejected',
                        };

                        const logEntry = {
                            actionType: 'turn_rejected',
                            playerIndex: socket.playerIndex, // Hráč, ktorý zamietol (súper)
                            originalPlayerIndex: pendingTurn.playerIndex, // Hráč, ktorého ťah bol zamietnutý
                            unverifiedWords: pendingTurn.unverifiedWords,
                            timestamp: Date.now(),
                        };
                        if (dbAdmin) {
                            try {
                                const turnLogCollectionRef = dbAdmin
                                    .collection('scrabbleGames')
                                    .doc(gameInstance.gameId)
                                    .collection('turnLogs');
                                await turnLogCollectionRef.add(logEntry);
                            } catch (e) {
                                console.error(
                                    `Chyba pri ukladaní zamietnutého ťahu do logu:`,
                                    e
                                );
                            }
                        }

                        const { playerIndex } = pendingTurn;
                        gameState.currentPlayerIndex = playerIndex;
                    }

                    // Vyčistíme dočasné dáta a vrátime hru do normálu
                    gameState.gameStatus = 'in_progress';
                    delete gameState.pendingTurn;

                    await saveGameState(gameInstance, dbAdmin, saveExtraFields);
                    startTimer(gameInstance.gameId, io);
                    emitGameStateToAll(io, gameInstance);

                    break;
                }
                case 'updateGameState':
                    if (gameInstance.gameState) {
                        // players sa ignoruje — klient posiela vlastnú (zastaranú) kópiu,
                        // ktorá by prepísala živý, serverom udržiavaný zoznam socketId
                        // a navždy "odpojila" gameState.players od skutočných pripojení.
                        const { lastTurnInfo, players, ...restOfPayload } = action.payload;

                        // Zachytíme stav PRED mergom — slúži na server-side výpočet racku a bagu
                        const prevState = gameInstance.gameState;
                        const prevPlayerIndex = prevState.currentPlayerIndex;

                        // Mergujeme nedôveryhodné polia z frontendu (skóre, board, flagy...)
                        gameInstance.gameState = {
                            ...prevState,
                            ...restOfPayload,
                            players: gameInstance.players,
                        };

                        // --- SERVER-SIDE SPRÁVA RACKU A BAGU ---
                        // Server sám vypočíta nový rack a bag, bez ohľadu na to, čo poslal klient.

                        if (prevState.hasPlacedOnBoardThisTurn) {
                            // Ťah s položenými písmenami
                            const placed = getPlacedLettersFromBoardDiff(
                                prevState.board,
                                prevState.boardAtStartOfTurn
                            );
                            const placedIds = new Set(placed.map(p => p.id));
                            // Písmená v exchange zóne (mohli sa tam dostať pri stale-state race condition)
                            // — vrátime ich do racku, nie stratíme
                            const exchangeInFlight = prevState.exchangeZoneLetters || [];
                            const exchangeIds = new Set(exchangeInFlight.map(l => l.id));

                            const rackBeforeFilter = prevState.playerRacks[prevPlayerIndex] || [];
                            // Zostatky z racku (bez položených a bez exchange)
                            const remaining = rackBeforeFilter.filter(
                                l => l !== null && !placedIds.has(l.id) && !exchangeIds.has(l.id)
                            );
                            // Exchange písmená sa vracajú do racku
                            const availableNow = [...remaining, ...exchangeInFlight];

                            // Dokreslíme presne toľko, aby bol rack plný (max 7) — nie len placed.length.
                            // Tak sa nikdy nestane, že hráčovi zmiznú písmená kvôli bug-u.
                            const numToDraw = Math.max(0, Math.min(7 - availableNow.length, prevState.letterBag.length));
                            const { drawnLetters, remainingBag, bagEmpty } =
                                drawLetters(prevState.letterBag, numToDraw);

                            // --- DEBUG LOG ---
                            console.log(`[updateGameState DEBUG] hra=${gameInstance.gameId} hráč=${prevPlayerIndex}`);
                            console.log(`  placed (${placed.length}):`, placed.map(p => `${p.letter}(${p.id})`).join(', '));
                            if (exchangeInFlight.length > 0) {
                                console.log(`  exchangeInFlight (${exchangeInFlight.length}):`, exchangeInFlight.map(l => `${l.letter}(${l.id})`).join(', '));
                            }
                            console.log(`  remaining (${remaining.length}):`, remaining.map(l => `${l.letter}(${l.id})`).join(', '));
                            console.log(`  numToDraw: ${numToDraw}, drawn:`, drawnLetters.map(l => `${l.letter}(${l.id})`).join(', '));
                            // -----------------

                            let rack = [...availableNow, ...drawnLetters];
                            while (rack.length < 7) rack.push(null);
                            rack = rack.slice(0, 7);

                            console.log(`  finalRack:`, rack.map(l => l ? `${l.letter}(${l.id})` : 'null').join(', '));

                            gameInstance.gameState.playerRacks = prevState.playerRacks.map(
                                (r, i) => i === prevPlayerIndex ? rack : r
                            );
                            gameInstance.gameState.letterBag = remainingBag;
                            gameInstance.gameState.isBagEmpty = bagEmpty;
                            gameInstance.gameState.exchangeZoneLetters = [];
                            // Highlights zo serverového diffu (nie z klienta)
                            gameInstance.gameState.highlightedLetters = placed.map(p => ({ x: p.x, y: p.y }));

                        } else if (prevState.hasMovedToExchangeZoneThisTurn) {
                            // Výmena písmen: server pozná exchangeZoneLetters pred vymazaním
                            const exchanged = prevState.exchangeZoneLetters;
                            const { drawnLetters, remainingBag } =
                                drawLetters(prevState.letterBag, exchanged.length);

                            let bag = [...remainingBag, ...exchanged];
                            for (let i = bag.length - 1; i > 0; i--) {
                                const j = Math.floor(Math.random() * (i + 1));
                                [bag[i], bag[j]] = [bag[j], bag[i]];
                            }

                            const exchangedIds = new Set(exchanged.map(e => e.id));
                            let rack = (prevState.playerRacks[prevPlayerIndex] || [])
                                .filter(l => l !== null && !exchangedIds.has(l.id));
                            rack = [...rack, ...drawnLetters];
                            while (rack.length < 7) rack.push(null);
                            rack = rack.slice(0, 7);

                            gameInstance.gameState.playerRacks = prevState.playerRacks.map(
                                (r, i) => i === prevPlayerIndex ? rack : r
                            );
                            gameInstance.gameState.letterBag = bag;
                            gameInstance.gameState.isBagEmpty = bag.length === 0;
                            // Výmena sa dosky netýka — nedôverujeme klientovej kópii, mohla by
                            // niesť nepotvrdené písmená z nedokončeného ťahu (pozri nižšie).
                            gameInstance.gameState.board = prevState.boardAtStartOfTurn;
                            gameInstance.gameState.boardAtStartOfTurn = prevState.boardAtStartOfTurn;

                        } else {
                            // Pasovanie: rack ani bag sa nemenia — server zachová svoje hodnoty
                            gameInstance.gameState.playerRacks = prevState.playerRacks;
                            gameInstance.gameState.letterBag = prevState.letterBag;
                            gameInstance.gameState.isBagEmpty = prevState.isBagEmpty;
                            // Ochrana pred nepotvrdenými písmenami na doske: ak hráč pasuje,
                            // doska sa vôbec nesmie zmeniť. Klient by ju mala poslať nezmenenú,
                            // ale kvôli prípadnému rozjazdu hasPlacedOnBoardThisTurn na klientovi
                            // (napr. race condition s prichádzajúcim broadcastom) radšej doske
                            // nedôverujeme a natvrdo ju vrátime na stav pred ťahom.
                            gameInstance.gameState.board = prevState.boardAtStartOfTurn;
                            gameInstance.gameState.boardAtStartOfTurn = prevState.boardAtStartOfTurn;
                        }

                        // Skontrolujeme, či hra práve skončila (záchranná sieť pre staré cesty)
                        if (
                            !prevState.isGameOver &&
                            action.payload?.isGameOver
                        ) {
                            console.log(
                                `Hra ${gameInstance.gameId} skončila. Vypočítavam finálne skóre a vytváram záznam.`
                            );

                            const finishingPlayerIndex =
                                gameInstance.gameState.playerRacks[prevPlayerIndex]?.every(
                                    (l) => l === null
                                )
                                    ? prevPlayerIndex
                                    : null;

                            await calculateAndLogFinalScores(
                                gameInstance,
                                dbAdmin,
                                {
                                    reason:
                                        action.payload.consecutivePasses >= 6
                                            ? 'pass_end'
                                            : 'standard_end',
                                    finishingPlayerIndex: finishingPlayerIndex,
                                }
                            );

                            try {
                                const gameDocRef = dbAdmin
                                    .collection('scrabbleGames')
                                    .doc(gameInstance.gameId);
                                const gameDoc = await gameDocRef.get();
                                if (
                                    gameDoc.exists &&
                                    gameDoc.data().gameMode === 'competitive'
                                ) {
                                    const finalScores =
                                        gameInstance.gameState.playerScores;
                                    const player1 = gameInstance.players.find(
                                        (p) => p && p.playerIndex === 0
                                    );
                                    const player2 = gameInstance.players.find(
                                        (p) => p && p.playerIndex === 1
                                    );

                                    if (player1 && player2) {
                                        if (finalScores[0] > finalScores[1]) {
                                            await updateEloRatings(
                                                player1.userId,
                                                player2.userId
                                            );
                                        } else if (
                                            finalScores[1] > finalScores[0]
                                        ) {
                                            await updateEloRatings(
                                                player2.userId,
                                                player1.userId
                                            );
                                        }
                                    }
                                }
                            } catch (e) {
                                console.error(
                                    `Chyba pri aktualizácii ELO pre hru ${gameInstance.gameId}:`,
                                    e
                                );
                            }
                        }

                        await saveGameState(gameInstance, dbAdmin);
                        startTimer(gameInstance.gameId, io);
                        emitGameStateToAll(io, gameInstance);
                    }
                    break;
                case 'initializeGame':
                    if (!gameInstance.gameState) {
                        gameInstance.gameState = generateInitialGameState();
                        gameInstance.isGameStarted = true;
                        await saveGameState(gameInstance, dbAdmin);
                        emitGameStateToAll(io, gameInstance);
                    }
                    break;
                case 'chatMessage':
                    const senderPlayer = gameInstance.players.find(
                        (p) => p?.playerIndex === socket.playerIndex
                    );
                    const senderNickname =
                        senderPlayer?.nickname ||
                        `Hráč ${socket.playerIndex + 1}`;
                    const senderUserId = senderPlayer?.userId || socket.userId;

                    const fullMessage = {
                        gameId: gameInstance.gameId,
                        senderId: senderUserId,
                        senderIndex: socket.playerIndex,
                        senderNickname: senderNickname,
                        text: action.payload,
                        timestamp: Date.now(),
                        seen: {},
                    };

                    // Odosielateľ už správu videl
                    fullMessage.seen[socket.playerIndex] = true;

                    // Ostatní hráči
                    gameInstance.players
                        .filter(
                            (p) => p && p.playerIndex !== socket.playerIndex
                        )
                        .forEach((p) => {
                            fullMessage.seen[p.playerIndex] = false;
                        });

                    gameInstance.chatMessages = gameInstance.chatMessages || [];
                    gameInstance.chatMessages.push(fullMessage);

                    io.to(gameInstance.gameId).emit(
                        'receiveChatMessage',
                        fullMessage
                    );

                    if (dbAdmin) {
                        try {
                            const chatMessagesCollectionRef = dbAdmin
                                .collection('scrabbleGames')
                                .doc(gameInstance.gameId)
                                .collection('chatMessages');
                            await chatMessagesCollectionRef.add(fullMessage);
                        } catch (e) {
                            console.error(
                                `Chyba pri ukladaní chatovej správy pre hru ${gameInstance.gameId} do Firestore:`,
                                e
                            );
                        }
                    }
                    break;
                case 'assignJoker':
                    if (gameInstance.gameState) {
                        const { x, y, assignedLetter } = action.payload;
                        const newBoard = gameInstance.gameState.board.map(
                            (row) => [...row]
                        );
                        if (newBoard[x][y] && newBoard[x][y].letter === '') {
                            newBoard[x][y] = {
                                ...newBoard[x][y],
                                assignedLetter: assignedLetter,
                            };
                            gameInstance.gameState = {
                                ...gameInstance.gameState,
                                board: newBoard,
                            };
                            await saveGameState(gameInstance, dbAdmin);
                            const playerNicknamesMap = {};
                            gameInstance.players.forEach((p) => {
                                if (p) {
                                    playerNicknamesMap[p.playerIndex] =
                                        p.nickname ||
                                        `Hráč ${p.playerIndex + 1}`;
                                }
                            });
                            gameInstance.gameState.playerNicknames =
                                playerNicknamesMap;
                            gameInstance.gameState.players =
                                gameInstance.players;
                            emitGameStateToAll(io, gameInstance);
                        }
                    }
                    break;
                case 'turnSubmitted':
                    if (!dbAdmin) {
                        console.warn(
                            'Firestore Admin SDK nie je k dispozícii. Log ťahu nebude uložený.'
                        );
                        return;
                    }
                    if (!gameInstance.gameId || !action.payload) {
                        console.error(
                            'Neplatné dáta pre akciu turnSubmitted:',
                            {
                                gameId: gameInstance.gameId,
                                turnDetails: action.payload,
                            }
                        );
                        return;
                    }

                    try {
                        // Jednotná schéma turnLogs — zapisujeme len tieto polia,
                        // nič iné (napr. staré klienty by ešte mohli posielať
                        // boardBeforeTurn/boardAfterTurn/letterBag*, tie zahodíme).
                        const {
                            actionType,
                            placedLetters = null,
                            newWords = null,
                            score = null,
                            turnNumber = null,
                            playerIndex = null,
                            timestamp = Date.now(),
                            exchangedLetters = null,
                            rackBeforeTurn = null,
                            lettersDrawn = null,
                        } = action.payload;

                        const turnLogCollectionRef = dbAdmin
                            .collection('scrabbleGames')
                            .doc(gameInstance.gameId)
                            .collection('turnLogs');
                        await turnLogCollectionRef.add({
                            actionType,
                            placedLetters,
                            newWords,
                            score,
                            turnNumber,
                            playerIndex,
                            timestamp,
                            exchangedLetters,
                            rackBeforeTurn,
                            lettersDrawn,
                        });
                    } catch (error) {
                        console.error(
                            `CHYBA PRI UKLADANÍ LOGU ŤAHU PRE HRU ${gameInstance.gameId}:`,
                            error
                        );
                    }
                    break;
                case 'surrender':
                    if (
                        gameInstance.gameState &&
                        !gameInstance.gameState.isGameOver
                    ) {
                        // Nedôverujeme surrenderingPlayerIndex z payloadu — inak by
                        // hráč mohol poslať index súpera a prinútiť ho prehrať.
                        // Vzdať sa môže len ten, kto akciu skutočne odoslal.
                        const loserIndex = socket.playerIndex;
                        const winnerIndex = loserIndex === 0 ? 1 : 0;

                        const loser = gameInstance.players.find(
                            (p) => p.playerIndex === loserIndex
                        );
                        const winner = gameInstance.players.find(
                            (p) => p.playerIndex === winnerIndex
                        );

                        if (!loser || !winner) {
                            console.error(
                                `Chyba pri vzdávaní hry ${gameInstance.gameId}: Nenašiel sa víťaz alebo porazený.`
                            );
                            return;
                        }

                        await calculateAndLogFinalScores(
                            gameInstance,
                            dbAdmin,
                            {
                                reason: 'surrender',
                                winnerIndex: winner.playerIndex,
                                loserIndex: loser.playerIndex,
                            }
                        );

                        // Aktualizujeme ELO hodnotenia
                        try {
                            const gameDocRef = dbAdmin
                                .collection('scrabbleGames')
                                .doc(gameInstance.gameId);
                            const gameDoc = await gameDocRef.get();
                            if (
                                gameDoc.exists &&
                                gameDoc.data().gameMode === 'competitive'
                            ) {
                                console.log(
                                    `Hra ${gameInstance.gameId} je kompetitívna. Aktualizujem ELO po vzdaní sa.`
                                );
                                await updateEloRatings(
                                    winner.userId,
                                    loser.userId
                                );
                            } else {
                                console.log(
                                    `Hra ${gameInstance.gameId} je priateľská. ELO sa po vzdaní sa nemení.`
                                );
                            }
                        } catch (e) {
                            console.error(
                                `Chyba pri kontrole typu hry ${gameInstance.gameId} pre výpočet ELO po vzdaní sa:`,
                                e
                            );
                        }

                        // Pripravíme finálny stav hry
                        gameInstance.gameState.isGameOver = true;
                        gameInstance.gameState.gameOverReason = `${loser.nickname} sa vzdal(a).`;

                        await saveGameState(gameInstance, dbAdmin, {
                            endedAt: new Date(),
                            winnerId: winner.userId,
                            loserId: loser.userId,
                            gameOverReason: 'surrender',
                        });

                        // Odošleme finálny stav hry všetkým v miestnosti
                        emitGameStateToAll(io, gameInstance);
                    }
                    break;
                case 'gameOver': {
                    // Klient tu predtým posielal hotové finalScores/winnerId/winnerIndex
                    // a server im slepo veril — škodlivý klient si mohol vymyslieť
                    // ľubovoľný výsledok a nechať si podľa neho upraviť ELO.
                    // Namiesto toho si dôvod aj skóre určí a prepočíta server sám
                    // z vlastného autoritatívneho stavu (rovnaká logika ako pri
                    // surrender/resolveTurnValidation), klientovým dátam nedôverujeme.
                    if (!gameInstance.gameState || gameInstance.gameState.isGameOver) {
                        break;
                    }

                    const gs = gameInstance.gameState;
                    let reason = null;
                    let finishingPlayerIndex = null;

                    if (gs.consecutivePasses >= 6) {
                        reason = 'pass_end';
                    } else {
                        const emptyRackIndex = gs.playerRacks.findIndex(
                            (rack) => rack && rack.every((l) => l === null)
                        );
                        if (gs.isBagEmpty && emptyRackIndex !== -1) {
                            reason = 'standard_end';
                            finishingPlayerIndex = emptyRackIndex;
                        }
                    }

                    if (!reason) {
                        console.warn(
                            `Hra ${gameInstance.gameId}: klient poslal 'gameOver', ale serverový stav to nepotvrdzuje (consecutivePasses=${gs.consecutivePasses}, isBagEmpty=${gs.isBagEmpty}). Akcia ignorovaná.`
                        );
                        break;
                    }

                    await calculateAndLogFinalScores(gameInstance, dbAdmin, {
                        reason,
                        finishingPlayerIndex,
                    });

                    const finalWinnerIndex = gameInstance.gameState.winnerIndex;
                    const winner = finalWinnerIndex !== null
                        ? gameInstance.players.find((p) => p && p.playerIndex === finalWinnerIndex)
                        : null;
                    const loser = finalWinnerIndex !== null
                        ? gameInstance.players.find((p) => p && p.playerIndex === 1 - finalWinnerIndex)
                        : null;

                    if (winner && loser) {
                        try {
                            const gameDocRef = dbAdmin
                                .collection('scrabbleGames')
                                .doc(gameInstance.gameId);
                            const gameDoc = await gameDocRef.get();
                            if (
                                gameDoc.exists &&
                                gameDoc.data().gameMode === 'competitive'
                            ) {
                                await updateEloRatings(winner.userId, loser.userId);
                            }
                        } catch (e) {
                            console.error(
                                `Chyba pri aktualizácii ELO pre hru ${gameInstance.gameId}:`,
                                e
                            );
                        }
                    }

                    gameInstance.gameState.isGameOver = true;

                    await saveGameState(gameInstance, dbAdmin, {
                        endedAt: new Date(),
                        winnerId: winner?.userId || null,
                        loserId: loser?.userId || null,
                        gameOverReason: reason,
                    });

                    emitGameStateToAll(io, gameInstance);
                    break;
                }
                case 'playerLeftGame':
                    // Skutočné upratanie (odstránenie zo slotu, notifikácia súpera)
                    // vykoná handler 'disconnect', ktorý klient vyvolá hneď po tejto akcii.
                    break;
                default:
                    console.warn(`Neznámy typ akcie: ${action.type}`);
                    break;
            }
        });

        socket.on('markMessagesSeen', async ({ gameId, playerIndex }) => {
            const game = games.get(gameId);

            if (!game) {
                console.warn(
                    `Hra s ID ${gameId} nebola nájdená pre markMessagesSeen.`
                );
                return;
            }

            game.chatMessages = game.chatMessages || [];

            if (dbAdmin) {
                try {
                    const chatMessagesCollectionRef = dbAdmin
                        .collection('scrabbleGames')
                        .doc(gameId)
                        .collection('chatMessages');

                    // Nájdeme a prejdeme všetky správy, ktoré neboli prečítané
                    const q = chatMessagesCollectionRef.where(
                        `seen.${playerIndex}`,
                        '==',
                        false
                    );
                    const querySnapshot = await q.get();

                    if (querySnapshot.empty) {
                        socket.emit('messagesMarkedAsSeen', {
                            gameId,
                            playerIndex,
                        });
                        return;
                    }

                    const batch = dbAdmin.batch();
                    querySnapshot.forEach((doc) => {
                        const messageData = doc.data();
                        const docRef = doc.ref;

                        // Označíme správu ako prečítanú aj v pamäti servera, aby bola konzistentná
                        // Hľadáme správu v pamäti na základe timestampu (alebo inej unikátnej vlastnosti)
                        const msgInCache = game.chatMessages.find(
                            (msg) => msg.timestamp === messageData.timestamp
                        );
                        if (msgInCache) {
                            if (
                                typeof msgInCache.seen !== 'object' ||
                                msgInCache.seen === null
                            ) {
                                msgInCache.seen = {};
                            }
                            msgInCache.seen[playerIndex] = true;
                        }

                        // Pripravíme zmenu pre batch update v databáze
                        batch.update(docRef, { [`seen.${playerIndex}`]: true });
                    });
                    await batch.commit();
                    io.to(gameId).emit('chatHistory', game.chatMessages);
                    console.log(
                        `Správy pre hru ${gameId} boli označené ako prečítané pre hráča ${playerIndex}. Odoslaná aktualizácia chatu všetkým klientom.`
                    );
                } catch (e) {
                    console.error(
                        `Chyba pri aktualizácii 'seen' do Firestore pre hru ${gameId}:`,
                        e
                    );
                }
            }

            // Odošleme potvrdenie späť klientovi
            socket.emit('messagesMarkedAsSeen', { gameId, playerIndex });
        });

        socket.on('disconnect', async () => {
            logAction('disconnect', socket.gameId, socket.playerIndex, { socketId: socket.id, userId: socket.userId });
            const gameInstance = socket.gameInstance;
            const gameId = socket.gameId;
            const userId = socket.userId;

            if (!gameInstance || !gameId || !userId) {
                console.log(
                    `Odpojený klient ${socket.id} nebol pripojený k žiadnej hre alebo nemal priradené userId.`
                );
                return;
            }

            socket.leave(gameId);

            const playerSlot = gameInstance.players.find(
                (p) => p && p.userId === userId
            );
            if (playerSlot) {
                playerSlot.socketId = null;
                delete gameInstance.playerSockets[socket.id];
                console.log(
                    `Hráč (User: ${userId}, Nickname: ${playerSlot.nickname}) bol odpojený zo slotu hry ${gameId}.`
                );

                if (dbAdmin) {
                    try {
                        const gamePlayersDocRef = dbAdmin
                            .collection('scrabbleGames')
                            .doc(gameId)
                            .collection('players')
                            .doc('data');
                        await gamePlayersDocRef.set(
                            { players: JSON.stringify(gameInstance.players) },
                            { merge: true }
                        );
                    } catch (e) {
                        console.error(
                            `Chyba pri ukladaní stavu hráčov ${gameId} do Firestore po odpojení:`,
                            e
                        );
                    }
                }
            } else {
                console.warn(
                    `Odpojený klient ${socket.id} (User: ${userId}) nebol nájdený v playerSlots pre hru ${gameId}.`
                );
            }

            // Pošleme zostávajúcim pripojeným hráčom čerstvý stav, aby hneď videli,
            // že súper odišiel od stola (namiesto toho, aby to zistili až pri ďalšom ťahu).
            if (gameInstance.gameState) {
                gameInstance.gameState.players = gameInstance.players;
                emitGameStateToAll(io, gameInstance);
            }

            const connectedPlayersCount = gameInstance.players.filter(
                (p) => p !== null && p.socketId !== null
            ).length;

            if (connectedPlayersCount === 0) {
                // console.log(`Hra ${gameId}: Všetci klienti odpojení. Nastavujem timeout pre vymazanie z pamäte.`);
                // const timeoutId = setTimeout(async () => {
                //     await resetGameInstance(gameInstance);
                //     games.delete(gameId);
                //     gameTimeouts.delete(gameId);
                //     console.log(`Hra ${gameId} bola vymazaná z pamäte servera a dát z Firestore po neaktivite.`);
                // }, INACTIVITY_TIMEOUT_MS);
                // gameTimeouts.set(gameId, timeoutId);
            } else {
                if (connectedPlayersCount === 1) {
                    io.to(gameInstance.gameId).emit(
                        'waitingForPlayers',
                        'Čaká sa na druhého hráča...'
                    );
                    console.log(
                        `Server: Hra ${gameId}: Zostal len jeden hráč. Čaká sa na druhého.`
                    );
                }
                console.log(
                    `Hra ${gameId} má stále ${connectedPlayersCount} pripojených klientov.`
                );
            }

            console.log(
                `Aktuálny stav players pre hru ${gameId} po odpojení:`,
                gameInstance.players.map((p) =>
                    p
                        ? `Hráč ${p.playerIndex + 1} (User: ${
                              p.userId
                          }, Socket: ${p.socketId}, Nickname: ${p.nickname})`
                        : 'Voľný'
                )
            );
        });
    });
}