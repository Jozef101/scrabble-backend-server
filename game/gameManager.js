// backend/game/gameManager.js
import { BOARD_SIZE, RACK_SIZE } from '../config/constants.js';
import { createLetterBag, drawLetters } from '../utils/gameUtils.js';
import { dbAdmin } from '../config/firebase.js';
import admin from 'firebase-admin';

// Globálny manažér hier (uchováva viacero herných inštancií)
export const games = new Map();
export const gameTimeouts = new Map();

// Tabuľka očakávaných výsledkov pre ELO systém.
const EXPECTED_SCORE_TABLE = [
    { diff: 3, prob: 0.50 }, { diff: 10, prob: 0.51 }, { diff: 17, prob: 0.52 }, { diff: 25, prob: 0.53 },
    { diff: 32, prob: 0.54 }, { diff: 40, prob: 0.55 }, { diff: 47, prob: 0.56 }, { diff: 54, prob: 0.57 },
    { diff: 61, prob: 0.58 }, { diff: 69, prob: 0.59 }, { diff: 76, prob: 0.60 }, { diff: 83, prob: 0.61 },
    { diff: 91, prob: 0.62 }, { diff: 98, prob: 0.63 }, { diff: 106, prob: 0.64 }, { diff: 113, prob: 0.65 },
    { diff: 121, prob: 0.66 }, { diff: 129, prob: 0.67 }, { diff: 137, prob: 0.68 }, { diff: 145, prob: 0.69 },
    { diff: 153, prob: 0.70 }, { diff: 162, prob: 0.71 }, { diff: 170, prob: 0.72 }, { diff: 179, prob: 0.73 },
    { diff: 188, prob: 0.74 }, { diff: 197, prob: 0.75 }, { diff: 206, prob: 0.76 }, { diff: 215, prob: 0.77 },
    { diff: 225, prob: 0.78 }, { diff: 236, prob: 0.79 }, { diff: 246, prob: 0.80 }, { diff: 257, prob: 0.81 },
    { diff: 268, prob: 0.82 }, { diff: 279, prob: 0.83 }, { diff: 291, prob: 0.84 }, { diff: 303, prob: 0.85 },
    { diff: 316, prob: 0.86 }, { diff: 329, prob: 0.87 }, { diff: 345, prob: 0.88 }, { diff: 358, prob: 0.89 },
    { diff: 375, prob: 0.90 }, { diff: 392, prob: 0.91 }, { diff: 412, prob: 0.92 }, { diff: 433, prob: 0.93 },
    { diff: 457, prob: 0.94 }, { diff: 485, prob: 0.95 }, { diff: 518, prob: 0.96 }, { diff: 560, prob: 0.97 },
    { diff: 620, prob: 0.98 }, { diff: 735, prob: 0.99 }, { diff: Infinity, prob: 1.00 }
];

/**
 * Vypočíta očakávaný výsledok (pravdepodobnosť výhry) na základe ELO rozdielu.
 * @param {number} eloDifference Rozdiel ELO skóre medzi dvoma hráčmi.
 * @returns {number} Očakávané skóre (pravdepodobnosť výhry, hodnota od 0 do 1).
 */
function calculateExpectedScore(eloDifference) {
    for (const item of EXPECTED_SCORE_TABLE) {
        if (eloDifference <= item.diff) {
            return item.prob;
        }
    }
    return 0.5;
}

/**
 * Vypočíta nové ELO skóre pre víťaza a porazeného na základe nových pravidiel.
 * @param {object} winner Objekty s ID, ELO a počtom odohraných hier.
 * @param {object} loser Objekty s ID, ELO a počtom odohraných hier.
 * @returns {object} Objekt s novým ELO skóre pre víťaza a porazeného.
 */
function calculateNewElo(winner, loser) {
    const eloDifference = winner.elo - loser.elo;
    const expectedWinnerScore = calculateExpectedScore(eloDifference);

    const kFactorWinner = winner.gamesPlayed < 51 ? 30 : 16;
    const kFactorLoser = loser.gamesPlayed < 51 ? 30 : 16;

    const actualWinnerScore = 1;
    const actualLoserScore = 0;

    let ratingChangeWinner = (actualWinnerScore - expectedWinnerScore) * kFactorWinner;
    let ratingChangeLoser = (actualLoserScore - (1 - expectedWinnerScore)) * kFactorLoser;

    if (winner.gamesPlayed < 51 && ratingChangeWinner > 5) {
        const accelerationPoints = ratingChangeWinner - 5;
        ratingChangeWinner += accelerationPoints;
        console.log(`Hráč ${winner.userId} získal ${accelerationPoints} akceleračných bodov.`);
    }

    const newWinnerElo = winner.elo + ratingChangeWinner;
    const newLoserElo = loser.elo + ratingChangeLoser;

    return {
        newWinnerElo: Math.round(newWinnerElo),
        newLoserElo: Math.round(newLoserElo)
    };
}

/**
 * Načíta ELO skóre a počet odohraných hier používateľa z Firestore.
 * Ak neexistuje, vráti počiatočné hodnoty.
 * @param {string} userId ID používateľa.
 * @returns {Promise<object>} Sľub s ELO skóre a počtom hier.
 */
async function getPlayerData(userId) {
    const userDocRef = dbAdmin.collection('users').doc(userId);
    const doc = await userDocRef.get();
    const data = doc.data();
    return {
        userId: userId,
        elo: data && data.elo !== undefined ? data.elo : 1600,
        gamesPlayed: data && data.gamesPlayed !== undefined ? data.gamesPlayed : 0,
    };
}

/**
 * Aktualizuje ELO hodnotenia dvoch hráčov na základe výsledku hry.
 * @param {string} winnerId ID víťaza.
 * @param {string} loserId ID porazeného.
 */
export async function updateEloRatings(winnerId, loserId) {
    if (!dbAdmin) {
        console.warn('Firestore Admin SDK nie je k dispozícii. ELO hodnotenia nebudú aktualizované.');
        return;
    }

    try {
        const [winnerData, loserData] = await Promise.all([getPlayerData(winnerId), getPlayerData(loserId)]);

        const { newWinnerElo, newLoserElo } = calculateNewElo(winnerData, loserData);

        const batch = dbAdmin.batch();
        
        const winnerRef = dbAdmin.collection('users').doc(winnerId);
        batch.update(winnerRef, { elo: newWinnerElo, gamesPlayed: admin.firestore.FieldValue.increment(1) });

        const loserRef = dbAdmin.collection('users').doc(loserId);
        batch.update(loserRef, { elo: newLoserElo, gamesPlayed: admin.firestore.FieldValue.increment(1) });

        await batch.commit();

        console.log(`ELO hodnotenia aktualizované:
        Víťaz ${winnerId}: ${winnerData.elo} -> ${newWinnerElo}
        Porazený ${loserId}: ${loserData.elo} -> ${newLoserElo}`);
    } catch (e) {
        console.error('Chyba pri aktualizácii ELO hodnotení:', e);
    }
}

/**
 * Vytvorí novú, prázdnu inštanciu herného objektu pre dané ID.
 * @param {string} gameId Unikátne ID pre novú hru.
 * @returns {object} Nová inštancia hry.
 */
export function createNewGameInstance(gameId) {
    return {
        players: [null, null], // Dva sloty pre hráčov (null = voľný)
        playerSockets: {}, // Mapa pre rýchly prístup k objektom socketov podľa ich ID
        gameState: null, // Bude obsahovať celý stav hry (board, racks, bag, scores, currentPlayerIndex atď.)
        gameId: gameId, // Unikátne ID pre túto hru
        isGameStarted: false, // Indikátor, či hra začala
    };
}

/**
 * Inicializuje počiatočný stav Scrabble hry pre danú inštanciu.
 * @returns {object} Inicializovaný stav hry.
 */
export function generateInitialGameState() {
    const initialBag = createLetterBag();
    const { drawnLetters: player0Rack, remainingBag: bagAfterP0 } = drawLetters(initialBag, RACK_SIZE);
    const { drawnLetters: player1Rack, remainingBag: finalBag } = drawLetters(bagAfterP0, RACK_SIZE);

    return {
        playerRacks: [player0Rack, player1Rack],
        board: Array(BOARD_SIZE).fill(null).map(() => Array(BOARD_SIZE).fill(null)),
        letterBag: finalBag,
        playerScores: [0, 0],
        currentPlayerIndex: 0,
        boardAtStartOfTurn: Array(BOARD_SIZE).fill(null).map(() => Array(BOARD_SIZE).fill(null)),
        isFirstTurn: true,
        isBagEmpty: finalBag.length === 0,
        exchangeZoneLetters: [],
        hasPlacedOnBoardThisTurn: false,
        hasMovedToExchangeZoneThisTurn: false,
        consecutivePasses: 0,
        isGameOver: false,
        highlightedLetters: [],
        hasInitialGameStateReceived: true,
        playerNicknames: {},
    };
}

/**
 * Resetuje stav danej hernej inštancie na počiatočné hodnoty.
 * @param {object} gameInstance Objekt hernej inštancie, ktorú chceme resetovať.
 */
export async function resetGameInstance(gameInstance) {
    gameInstance.players = [null, null];
    gameInstance.playerSockets = {};
    gameInstance.gameState = null;
    gameInstance.isGameStarted = false;
    console.log(`Herný stav pre hru ${gameInstance.gameId} bol resetovaný.`);

    if (dbAdmin) {
        try {
            const gameStateDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId).collection('gameStates').doc('state');
            await gameStateDocRef.delete();
            console.log(`Stav hry ${gameInstance.gameId} odstránený z Firestore.`);

            const chatMessagesCollectionRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId).collection('chatMessages');
            const q = chatMessagesCollectionRef.orderBy('timestamp');
            const querySnapshot = await q.get();
            const deletePromises = [];
            querySnapshot.forEach((doc) => {
                deletePromises.push(doc.ref.delete());
            });
            await Promise.all(deletePromises);
            console.log(`Chatové správy pre hru ${gameInstance.gameId} odstránené z Firestore.`);

            const gamePlayersDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId).collection('players').doc('data');
            await gamePlayersDocRef.delete();
            console.log(`Stav hráčov pre hru ${gameInstance.gameId} odstránený z Firestore.`);

        } catch (e) {
            console.error(`Chyba pri odstraňovaní stavu hry/chatu/hráčov ${gameInstance.gameId} z Firestore:`, e);
        }
    }
}