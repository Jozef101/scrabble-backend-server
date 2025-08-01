// game/gameManager.js
import { BOARD_SIZE, RACK_SIZE, INACTIVITY_TIMEOUT_MS } from '../config/constants.js';
import { createLetterBag, drawLetters } from '../utils/gameUtils.js';
import { dbAdmin } from '../config/firebase.js';

// Globálny manažér hier (uchováva viacero herných inštancií)
export const games = new Map();
export const gameTimeouts = new Map();

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
            const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gameStates').doc(gameInstance.gameId);
            await gameDocRef.delete();
            console.log(`Stav hry ${gameInstance.gameId} odstránený z Firestore.`);

            const chatMessagesCollectionRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('chatMessages');
            const q = chatMessagesCollectionRef.where('gameId', '==', gameInstance.gameId).orderBy('timestamp');
            const querySnapshot = await q.get();
            const deletePromises = [];
            querySnapshot.forEach((doc) => {
                deletePromises.push(doc.ref.delete());
            });
            await Promise.all(deletePromises);
            console.log(`Chatové správy pre hru ${gameInstance.gameId} odstránené z Firestore.`);

            const gamePlayersDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gamePlayers').doc(gameInstance.gameId);
            await gamePlayersDocRef.delete();
            console.log(`Stav hráčov pre hru ${gameInstance.gameId} odstránený z Firestore.`);

        } catch (e) {
            console.error(`Chyba pri odstraňovaní stavu hry/chatu/hráčov ${gameInstance.gameId} z Firestore:`, e);
        }
    }
}
