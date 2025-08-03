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
        turnNumber: 1,
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
    console.log(`Herný stav pre hru ${gameInstance.gameId} bol resetovaný v pamäti servera.`);
}

/**
 * Uloží detaily o ťahu do subkolekcie vo Firestore.
 * @param {string} gameId Unikátne ID hry.
 * @param {object} turnDetails Objekt obsahujúci detaily ťahu (napr. kto, aké slová, body, atď.).
 */
export async function saveTurnLogToFirestore(gameId, turnDetails) {
    if (!dbAdmin) {
        console.warn("Firebase Admin SDK nie je inicializované, turn log nebude uložený.");
        return;
    }

    try {
        // --- TOTO JE KĽÚČOVÁ ZMENA: Získanie referencie na subkolekciu 'turnLogs' pod hlavnou kolekciou 'games' ---
        const turnLogsCollectionRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('games').doc(gameId).collection('turnLogs');

        await turnLogsCollectionRef.add({
            ...turnDetails,
            gameId,
            timestamp: Date.now()
        });
        console.log(`Turn log pre hru ${gameId} úspešne uložený do subkolekcie turnLogs.`);
    } catch (e) {
        console.error(`Chyba pri ukladaní turn logu pre hru ${gameId} do Firestore:`, e);
    }
}