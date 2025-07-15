// server/server.js
// import { BOARD_SIZE, RACK_SIZE } from '../src/utils/constants.js'; // Importujeme BOARD_SIZE a RACK_SIZE z constants.js

// const express = require('express');
import express from 'express';
// const http = require('http');
import http from 'http';
// const socketIo = require('socket.io');
import { Server } from 'socket.io';
// const cors = require('cors');
import cors from 'cors';

const app = express();
const server = http.createServer(app);
const allowedOrigins = ['http://localhost:3000', 'https://skrebl.vercel.app']; // Frontend URL, ktorý bude komunikovať so serverom

const BOARD_SIZE = 15;
const RACK_SIZE = 7;

// Používame CORS, aby frontend (bežiaci na inom porte/doméne) mohol komunikovať so serverom
app.use(cors({
    origin: allowedOrigins, // Povoliť všetky domény pre jednoduchosť testovania. V produkcii by ste chceli obmedziť na doménu vášho frontendu.
    methods: ['GET', 'POST']
}));

// Inicializácia Socket.IO servera
// const io = socketIo(server, {
//     cors: {
//         origin: '*', // Rovnako ako pre Express, povoliť všetky domény
//         methods: ['GET', 'POST']
//     }
// });

const io = new Server(server, {
    cors: { 
        origin: allowedOrigins,
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
    console.log(`Server beží na porte ${PORT}`);
});

// ====================================================================
// Globálny manažér hier (uchováva viacero herných inštancií)
// ====================================================================
const games = new Map(); // Bude uchovávať všetky aktívne hry

// Pomocné konštanty a funkcie (pre Scrabble logiku)
const LETTER_VALUES = {
    'A': 1, 'Á': 4, 'Ä': 10, 'B': 4, 'C': 4, 'Č': 5, 'D': 2, 'Ď': 8, 'E': 1, 'É': 7,
    'F': 8, 'G': 8, 'H': 4, 'I': 1, 'Í': 5, 'J': 3, 'K': 2, 'L': 2, 'Ľ': 7, 'Ĺ': 10,
    'M': 2, 'N': 1, 'Ň': 8, 'O': 1, 'Ô': 8, 'Ó': 10, 'P': 2, 'Q': 10, 'R': 1, 'Ŕ': 10,
    'S': 1, 'Š': 5, 'T': 1, 'Ť': 7, 'U': 3, 'Ú': 7, 'V': 1, 'W': 5, 'X': 10, 'Y': 4, 'Ý': 5,
    'Z': 4, 'Ž': 5, '': 0 // Žolík má hodnotu 0
};

const LETTER_DISTRIBUTION = [
    { letter: 'A', count: 9 }, { letter: 'Á', count: 1 }, { letter: 'Ä', count: 1 },
    { letter: 'B', count: 2 }, { letter: 'C', count: 1 }, { letter: 'Č', count: 1 },
    { letter: 'D', count: 3 }, { letter: 'Ď', count: 1 }, { letter: 'E', count: 8 },
    { letter: 'É', count: 1 }, { letter: 'F', count: 1 }, { letter: 'G', count: 1 },
    { letter: 'H', count: 1 }, { letter: 'I', count: 5 }, { letter: 'Í', count: 1 },
    { letter: 'J', count: 2 }, { letter: 'K', count: 3 }, { letter: 'L', count: 3 },
    { letter: 'Ľ', count: 1 }, { letter: 'Ĺ', count: 1 }, { letter: 'M', count: 4 },
    { letter: 'N', count: 5 }, { letter: 'Ň', count: 1 }, { letter: 'O', count: 9 },
    { letter: 'Ô', count: 1 }, { letter: 'Ó', count: 1 }, { letter: 'P', count: 3 },
    { letter: 'R', count: 4 }, { letter: 'Ŕ', count: 1 }, { letter: 'S', count: 4 },
    { letter: 'Š', count: 1 }, { letter: 'T', count: 4 }, { letter: 'Ť', count: 1 },
    { letter: 'U', count: 2 }, { letter: 'Ú', count: 1 }, { letter: 'V', count: 4 },
    { letter: 'X', count: 1 }, { letter: 'Y', count: 1 }, { letter: 'Ý', count: 1 },
    { letter: 'Z', count: 1 }, { letter: 'Ž', count: 1 },
    { letter: '', count: 2 } // Dva žolíky (blank tiles)
];

/**
 * Vytvorí novú, prázdnu inštanciu herného objektu pre dané ID.
 * @param {string} gameId Unikátne ID pre novú hru.
 * @returns {object} Nová inštancia hry.
 */
function createNewGameInstance(gameId) {
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
 * @param {object} gameInstance Objekt hernej inštancie, ktorú chceme inicializovať.
 */
function initializeGameInstance(gameInstance) {
    const initialBag = createLetterBag();
    const { drawnLetters: player0Rack, remainingBag: bagAfterP0 } = drawLetters(initialBag, RACK_SIZE);
    const { drawnLetters: player1Rack, remainingBag: finalBag } = drawLetters(bagAfterP0, RACK_SIZE);

    gameInstance.gameState = {
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
        hasInitialGameStateReceived: true, // Klient teraz vie, že dostal počiatočný stav
    };
    console.log(`Počiatočný herný stav pre hru ${gameInstance.gameId} inicializovaný na serveri.`);
    console.log("Rack Hráča 1:", gameInstance.gameState.playerRacks[0].map(l => l.letter));
    console.log("Rack Hráča 2:", gameInstance.gameState.playerRacks[1].map(l => l.letter));
}

/**
 * Resetuje stav danej hernej inštancie na počiatočné hodnoty.
 * @param {object} gameInstance Objekt hernej inštancie, ktorú chceme resetovať.
 */
function resetGameInstance(gameInstance) {
    gameInstance.players = [null, null]; // Reset na prázdne sloty
    gameInstance.playerSockets = {}; // Vyčistíme referencie na sockety
    gameInstance.gameState = null;
    gameInstance.isGameStarted = false;
    console.log(`Herný stav pre hru ${gameInstance.gameId} bol resetovaný.`);
}

/**
 * Vytvorí zamiešané vrecúško s písmenami podľa distribúcie.
 * @returns {Array<object>} Zoznam objektov písmen (s ID, písmenom a hodnotou).
 */
function createLetterBag() {
    const bag = [];
    let idCounter = 0;
    LETTER_DISTRIBUTION.forEach(item => {
        for (let i = 0; i < item.count; i++) {
            bag.push({ id: `letter-${idCounter++}`, letter: item.letter, value: LETTER_VALUES[item.letter] });
        }
    });
    // Zamiešame vrecúško (Fisher-Yates shuffle)
    for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    return bag;
}

/**
 * Vytiahne písmená z vrecúška.
 * @param {Array<object>} currentBag Aktuálne vrecúško s písmenami.
 * @param {number} numToDraw Počet písmen, ktoré sa majú vytiahnuť.
 * @returns {object} Objekt obsahujúci vytiahnuté písmená, zostávajúce vrecúško a flag, či je vrecúško prázdne.
 */
function drawLetters(currentBag, numToDraw) {
    const drawn = [];
    const tempBag = [...currentBag]; // Pracujeme s kópiou vrecúška
    let bagEmpty = false;

    for (let i = 0; i < numToDraw; i++) {
        if (tempBag.length > 0) {
            drawn.push(tempBag.pop()); // Odoberieme písmeno z konca (ako z vrchu kopy)
        } else {
            console.warn("Vrecúško je prázdne, nedá sa ťahať viac písmen.");
            bagEmpty = true;
            break;
        }
    }
    return { drawnLetters: drawn, remainingBag: tempBag, bagEmpty: bagEmpty };
}


// ====================================================================
// Socket.IO pripojenia a logika hry
// ====================================================================
io.on('connection', (socket) => {
    console.log(`Nový klient pripojený: ${socket.id}`);

    // Pripojenie hráča k hre
    // Teraz 'joinGame' očakáva gameIdFromClient
    socket.on('joinGame', (gameIdFromClient) => {
        if (!gameIdFromClient) {
            // Použijeme generické ID, ak klient neposkytne žiadne.
            // V reálnej aplikácii by ste chceli, aby si užívatelia vyberali/vytvárali ID.
            gameIdFromClient = 'default-scrabble-game';
            console.log(`Klient ${socket.id} sa pokúsil pripojiť bez ID hry. Priradené defaultné ID: ${gameIdFromClient}`);
        }

        let gameInstance = games.get(gameIdFromClient);
        if (!gameInstance) {
            // Ak hra s daným ID neexistuje, vytvoríme novú
            gameInstance = createNewGameInstance(gameIdFromClient);
            games.set(gameIdFromClient, gameInstance);
            console.log(`Vytvorená nová hra s ID: ${gameIdFromClient}`);
            // Klient, ktorý vytvoril hru, sa k nej aj pripojí do "miestnosti"
            socket.join(gameIdFromClient);
        } else {
            // Ak hra existuje, skúsime sa pripojiť k jej miestnosti
            socket.join(gameIdFromClient);
        }

        // Priradíme gameInstance k objektu socketu pre jednoduchší prístup v budúcich eventoch
        socket.gameInstance = gameInstance;

        let playerIndex = -1;

        // 1. Skontrolujeme, či sa klient už pripojil (rekonexia) k TEJTO HRE
        if (gameInstance.players[0] && gameInstance.players[0].id === socket.id) {
            playerIndex = 0;
            console.log(`Klient ${socket.id} sa znovu pripojil k hre ${gameIdFromClient} ako Hráč 1.`);
        } else if (gameInstance.players[1] && gameInstance.players[1].id === socket.id) {
            playerIndex = 1;
            console.log(`Klient ${socket.id} sa znovu pripojil k hre ${gameIdFromClient} ako Hráč 2.`);
        } else {
            // 2. Ak nie je rekonexia, priradíme nový slot, ak je k dispozícii v TEJTO HRE
            if (gameInstance.players[0] === null) {
                playerIndex = 0;
                console.log(`Klient ${socket.id} sa pripojil k hre ${gameIdFromClient} ako Hráč 1.`);
            } else if (gameInstance.players[1] === null) {
                playerIndex = 1;
                console.log(`Klient ${socket.id} sa pripojil k hre ${gameIdFromClient} ako Hráč 2.`);
            } else {
                // 3. Ak sú oba sloty obsadené v TEJTO HRE a nie je to rekonexia, hra je plná
                socket.emit('gameError', 'Hra je už plná.'); // Táto chyba je teraz špecifická pre dané ID hry
                console.log(`Klient ${socket.id} sa nemohol pripojiť k hre ${gameIdFromClient}, hra je plná.`);
                return;
            }
        }

        // Uložíme informácie o hráčovi do príslušného slotu TEJTO HRY
        gameInstance.players[playerIndex] = { id: socket.id, playerIndex: playerIndex };
        gameInstance.playerSockets[socket.id] = socket; // Uložíme referenciu na socket
        socket.playerIndex = playerIndex; // Priradíme playerIndex priamo k objektu socketu pre jednoduchší prístup
        socket.gameId = gameIdFromClient; // Uložíme ID hry na socket pre jednoduchší prístup pri odpojení

        // Oznámime klientovi jeho priradený playerIndex
        socket.emit('playerAssigned', playerIndex);

        console.log(`Aktuálny stav players pre hru ${gameIdFromClient}:`, gameInstance.players.map(p => p ? `Hráč ${p.playerIndex + 1} (${p.id})` : 'Voľný'));

        // Logika pre spustenie/pokračovanie hry
        const activePlayersCount = gameInstance.players.filter(p => p !== null).length;
        if (activePlayersCount === 2 && !gameInstance.isGameStarted) {
            // Dvaja hráči pripojení a hra ešte nezačala, inicializujeme ju
            console.log(`Hra ${gameIdFromClient}: Dvaja hráči pripojení, inicializujem hru!`);
            gameInstance.isGameStarted = true;
            initializeGameInstance(gameInstance); // Používame novú funkciu s gameInstance
            io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState); // Emitujeme len hráčom TEJTO hry
        } else if (gameInstance.isGameStarted && gameInstance.gameState) {
            // Hra už beží, pošleme aktuálny stav pripájajúcemu sa (alebo znovu pripájajúcemu sa) hráčovi
            socket.emit('gameStateUpdate', gameInstance.gameState);
        } else {
            // Pripojený len jeden hráč, alebo hra ešte nezačala a čaká sa na druhého
            console.log(`Hra ${gameIdFromClient}: Čaká sa na druhého hráča. Aktuálni hráči: ${activePlayersCount}`);
            // Emitujeme iba do miestnosti danej hry
            io.to(gameInstance.gameId).emit('waitingForPlayers', 'Čaká sa na druhého hráča...'); 
        }
    });

    // Klient posiela akciu (ťah, výmena, pass)
    socket.on('playerAction', (action) => {
        const gameInstance = socket.gameInstance; // Získame inštanciu hry z objektu socketu
        if (!gameInstance) {
            socket.emit('gameError', 'Nie ste pripojený k žiadnej hre.');
            console.warn(`Hráč ${socket.id} sa pokúsil o akciu ${action.type}, ale nie je pripojený k žiadnej hre.`);
            return;
        }

        // Overenie, či je na ťahu správny hráč
        // Akcia updateGameState a assignJoker môže prísť aj mimo ťahu pre UI synchronizáciu,
        // preto ich vynecháme z kontroly ťahu.
        if (gameInstance.gameState && action.type !== 'updateGameState' && action.type !== 'assignJoker' && (gameInstance.gameState.currentPlayerIndex !== socket.playerIndex)) {
            socket.emit('gameError', 'Nie je váš ťah!');
            console.warn(`Hráč ${socket.playerIndex + 1} sa pokúsil o akciu ${action.type}, ale nie je na ťahu v hre ${gameInstance.gameId}.`);
            return;
        }

        console.log(`Akcia od Hráča ${socket.playerIndex + 1} v hre ${gameInstance.gameId}: ${action.type}`);

        switch (action.type) {
            case 'updateGameState':
                if (gameInstance.gameState) {
                    // Aktualizujeme celý stav hry. Pre komplexnejšie hry by sa tu vykonávala validácia.
                    gameInstance.gameState = { ...gameInstance.gameState, ...action.payload };
                    // Emitujeme aktualizovaný stav len hráčom v danej miestnosti hry
                    io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState); 
                }
                break;
            case 'chatMessage': // Ak sa rozhodnete spracovať chat na serveri
                const fullMessage = { senderId: socket.id, senderIndex: socket.playerIndex, text: action.payload, timestamp: Date.now() };
                // História chatu by mala byť uložená v gameInstance, ak chceme, aby bola špecifická pre hru
                // if (!gameInstance.chatMessages) gameInstance.chatMessages = [];
                // gameInstance.chatMessages.push(fullMessage);
                io.to(gameInstance.gameId).emit('receiveChatMessage', fullMessage);
                console.log(`Chat správa v hre ${gameInstance.gameId} od Hráča ${socket.playerIndex + 1}: ${action.payload}`);
                break;
            default:
                console.warn(`Neznámy typ akcie: ${action.type}`);
                break;
        }
    });

    // Odpojenie klienta
    socket.on('disconnect', () => {
        console.log(`Klient odpojený: ${socket.id}`);
        const gameInstance = socket.gameInstance; // Získame inštanciu hry z objektu socketu
        const disconnectedPlayerIndex = socket.playerIndex;
        const gameId = socket.gameId; // Získame ID hry z objektu socketu

        if (!gameInstance || !gameId) {
            console.log(`Odpojený klient ${socket.id} nebol pripojený k žiadnej hre.`);
            return;
        }

        // Opustíme miestnosť
        socket.leave(gameId);

        // Vyčistíme slot odpojeného hráča v TEJTO HRE
        if (disconnectedPlayerIndex !== undefined && gameInstance.players[disconnectedPlayerIndex]?.id === socket.id) {
            gameInstance.players[disconnectedPlayerIndex] = null;
            delete gameInstance.playerSockets[socket.id];
            console.log(`Hráč ${disconnectedPlayerIndex + 1} (${socket.id}) bol odstránený zo slotu hry ${gameInstance.gameId}.`);
        }

        const activePlayersCount = gameInstance.players.filter(p => p !== null).length;

        // Ak hra prebiehala a teraz je menej ako 2 aktívni hráči, resetujeme hru
        if (gameInstance.isGameStarted && activePlayersCount < 2) {
            console.log(`Hra ${gameId} bola prerušená, resetujem stav.`);
            resetGameInstance(gameInstance); // Použijeme funkciu na reset pre konkrétnu hru
            io.to(gameId).emit('gameReset', 'Jeden z hráčov sa odpojil. Hra bola resetovaná.');
            // Ak už nikto nie je pripojený k tejto hre, môžeme ju odstrániť z mapy hier
            if (activePlayersCount === 0) {
                games.delete(gameId);
                console.log(`Hra ${gameId} bola odstránená, pretože sú všetci odpojení.`);
            }
        } else if (activePlayersCount === 0) {
            // Ak sa odpojí posledný hráč, vyčistíme úplne stav a odstránime hru
            console.log(`Hra ${gameId}: Všetci hráči odpojení, herný stav vyčistený a hra odstránená.`);
            resetGameInstance(gameInstance);
            games.delete(gameId);
        }
        console.log(`Aktuálny stav players pre hru ${gameId} po odpojení:`, gameInstance.players.map(p => p ? `Hráč ${p.playerIndex + 1} (${p.id})` : 'Voľný'));
    });
});

// Spustenie servera
server.listen(PORT, () => {
    console.log(`Server beží na porte ${PORT}`);
});