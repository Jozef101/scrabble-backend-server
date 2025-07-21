// server/server.js
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
// Firebase Admin SDK Imports
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

// ====================================================================
// Firebase Admin SDK Initialization
// Potrebujete nastaviť váš Firebase Service Account Key ako premennú prostredia
// na Render.com (napr., FIREBASE_SERVICE_ACCOUNT_KEY).
// Tento kľúč by mal byť JSON reťazec.
// ====================================================================
let serviceAccount;
try {
    // Pokus o parsovanie z premennej prostredia
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    } else {
        console.warn("Premenná prostredia FIREBASE_SERVICE_ACCOUNT_KEY nebola nájdená. Firebase Admin SDK nebude inicializované.");
        // Fallback pre lokálny vývoj, ak nechcete okamžite nastavovať premenné prostredia
        // Pre lokálne testovanie môžete umiestniť svoj JSON súbor servisného účtu a importovať ho:
        // serviceAccount = require('./path/to/your/serviceAccountKey.json');
        // ALEBO, ak chcete spustiť lokálne bez perzistencie Firestore, môžete to preskočiť.
    }
} catch (e) {
    console.error("Chyba pri parsovaní FIREBASE_SERVICE_ACCOUNT_KEY:", e);
    serviceAccount = null;
}

let dbAdmin;
// Inicializácia Firebase Admin SDK, ak je kľúč servisného účtu dostupný
if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    dbAdmin = getFirestore();
    console.log("Firebase Admin SDK inicializované.");
} else {
    console.error("Firebase Admin SDK nebolo inicializované z dôvodu chýbajúceho alebo neplatného kľúča servisného účtu.");
}


const app = express();
const server = http.createServer(app);
const allowedOrigins = ['http://localhost:3000', 'https://skrebl.vercel.app'];

const BOARD_SIZE = 15;
const RACK_SIZE = 7;

app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST']
}));

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 4000;

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
 * @returns {object} Inicializovaný stav hry.
 */
function generateInitialGameState() {
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
        hasInitialGameStateReceived: true, // Klient teraz vie, že dostal počiatočný stav
    };
}


/**
 * Resetuje stav danej hernej inštancie na počiatočné hodnoty.
 * @param {object} gameInstance Objekt hernej inštancie, ktorú chceme resetovať.
 */
async function resetGameInstance(gameInstance) {
    gameInstance.players = [null, null]; // Reset na prázdne sloty
    gameInstance.playerSockets = {}; // Vyčistíme referencie na sockety
    gameInstance.gameState = null;
    gameInstance.isGameStarted = false;
    console.log(`Herný stav pre hru ${gameInstance.gameId} bol resetovaný.`);

    // KLÚČOVÁ ZMENA: Odstránime stav hry z Firestore pri resete
    if (dbAdmin) {
        try {
            // Používame pevne dané appId 'default-app-id' pre cestu v Firestore
            const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gameStates').doc(gameInstance.gameId);
            await gameDocRef.delete();
            console.log(`Stav hry ${gameInstance.gameId} odstránený z Firestore.`);
        } catch (e) {
            console.error(`Chyba pri odstraňovaní stavu hry ${gameInstance.gameId} z Firestore:`, e);
        }
    }
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
    socket.on('joinGame', async (gameIdFromClient) => { // Zmenené na async
        if (!gameIdFromClient) {
            gameIdFromClient = 'default-scrabble-game';
            console.log(`Klient ${socket.id} sa pokúsil pripojiť bez ID hry. Priradené defaultné ID: ${gameIdFromClient}`);
        }

        let gameInstance = games.get(gameIdFromClient);
        if (!gameInstance) {
            gameInstance = createNewGameInstance(gameIdFromClient);
            games.set(gameIdFromClient, gameInstance);
            console.log(`Vytvorená nová hra s ID: ${gameIdFromClient}`);
            socket.join(gameIdFromClient);
        } else {
            socket.join(gameIdFromClient);
        }

        socket.gameInstance = gameInstance;

        let playerIndex = -1;

        // Skontrolujeme, či sa klient už pripojil (rekonexia)
        if (gameInstance.players[0] && gameInstance.players[0].id === socket.id) {
            playerIndex = 0;
            console.log(`Klient ${socket.id} sa znovu pripojil k hre ${gameIdFromClient} ako Hráč 1.`);
        } else if (gameInstance.players[1] && gameInstance.players[1].id === socket.id) {
            playerIndex = 1;
            console.log(`Klient ${socket.id} sa znovu pripojil k hre ${gameIdFromClient} ako Hráč 2.`);
        } else {
            // Ak nie je rekonexia, priradíme nový slot
            if (gameInstance.players[0] === null) {
                playerIndex = 0;
                console.log(`Klient ${socket.id} sa pripojil k hre ${gameIdFromClient} ako Hráč 1.`);
            } else if (gameInstance.players[1] === null) {
                playerIndex = 1;
                console.log(`Klient ${socket.id} sa pripojil k hre ${gameIdFromClient} ako Hráč 2.`);
            } else {
                socket.emit('gameError', 'Hra je už plná.');
                console.log(`Klient ${socket.id} sa nemohol pripojiť k hre ${gameIdFromClient}, hra je plná.`);
                return;
            }
        }

        gameInstance.players[playerIndex] = { id: socket.id, playerIndex: playerIndex };
        gameInstance.playerSockets[socket.id] = socket;
        socket.playerIndex = playerIndex;
        socket.gameId = gameIdFromClient;

        socket.emit('playerAssigned', playerIndex);

        console.log(`Aktuálny stav players pre hru ${gameIdFromClient}:`, gameInstance.players.map(p => p ? `Hráč ${p.playerIndex + 1} (${p.id})` : 'Voľný'));

        const activePlayersCount = gameInstance.players.filter(p => p !== null).length;

        // KLÚČOVÁ ZMENA: Načítanie stavu hry z Firestore pri pripojení
        if (dbAdmin) {
            try {
                // Používame pevne dané appId 'default-app-id' pre cestu v Firestore
                const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gameStates').doc(gameIdFromClient);
                const docSnap = await gameDocRef.get();
                if (docSnap.exists() && docSnap.data() && docSnap.data().gameState) {
                    const loadedState = JSON.parse(docSnap.data().gameState);
                    gameInstance.gameState = loadedState;
                    gameInstance.isGameStarted = true; // Ak sa stav načíta, hra už beží
                    console.log(`Stav hry ${gameIdFromClient} načítaný z Firestore.`);
                } else {
                    console.log(`Žiadny uložený stav hry pre ${gameIdFromClient} vo Firestore. Inicializujem nový.`);
                    // Ak neexistuje, inicializujeme nový stav
                    gameInstance.gameState = generateInitialGameState();
                    gameInstance.isGameStarted = true; // Nová hra začína
                    // Uložíme nový stav do Firestore
                    await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                    console.log(`Nový stav hry ${gameIdFromClient} inicializovaný a uložený do Firestore.`);
                }
            } catch (e) {
                console.error(`Chyba pri načítaní/inicializácii stavu hry ${gameIdFromClient} z Firestore:`, e);
                // V prípade chyby môžeme fallbackovať na generovanie nového stavu,
                // ale už ho nebudeme ukladať, aby sme predišli nekonečným chybám.
                if (!gameInstance.gameState) {
                     gameInstance.gameState = generateInitialGameState();
                     console.log("Fallback: Inicializovaný nový stav hry kvôli chybe Firestore.");
                }
            }
        } else {
            // Ak dbAdmin nie je k dispozícii, fallback na in-memory inicializáciu
            if (!gameInstance.gameState) {
                gameInstance.gameState = generateInitialGameState();
                console.log("Fallback: Inicializovaný nový stav hry (bez Firestore) pre hru:", gameIdFromClient);
            }
        }


        if (gameInstance.isGameStarted && gameInstance.gameState) {
            io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState); // Emitujeme aktualizovaný stav všetkým v miestnosti
        } else {
            console.log(`Hra ${gameIdFromClient}: Čaká sa na druhého hráča. Aktuálni hráči: ${activePlayersCount}`);
            io.to(gameInstance.gameId).emit('waitingForPlayers', 'Čaká sa na druhého hráča...');
        }
    });

    // Klient posiela akciu (ťah, výmena, pass)
    socket.on('playerAction', async (action) => { // Zmenené na async
        const gameInstance = socket.gameInstance;
        if (!gameInstance) {
            socket.emit('gameError', 'Nie ste pripojený k žiadnej hre.');
            console.warn(`Hráč ${socket.id} sa pokúsil o akciu ${action.type}, ale nie je pripojený k žiadnej hre.`);
            return;
        }

        if (gameInstance.gameState &&
            action.type !== 'updateGameState' &&
            action.type !== 'assignJoker' &&
            action.type !== 'chatMessage' &&
            (gameInstance.gameState.currentPlayerIndex !== socket.playerIndex)) {
            socket.emit('gameError', 'Nie je váš ťah!');
            console.warn(`Hráč ${socket.playerIndex + 1} sa pokúsil o akciu ${action.type}, ale nie je na ťahu v hre ${gameInstance.gameId}.`);
            return;
        }

        console.log(`Akcia od Hráča ${socket.playerIndex + 1} v hre ${gameInstance.gameId}: ${action.type}`);

        switch (action.type) {
            case 'updateGameState':
                if (gameInstance.gameState) {
                    gameInstance.gameState = { ...gameInstance.gameState, ...action.payload };
                    // KLÚČOVÁ ZMENA: Uložíme stav do Firestore po každej aktualizácii
                    if (dbAdmin) {
                        try {
                            // Používame pevne dané appId 'default-app-id' pre cestu v Firestore
                            const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gameStates').doc(gameInstance.gameId);
                            await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                            console.log(`Stav hry ${gameInstance.gameId} uložený do Firestore z playerAction.`);
                        } catch (e) {
                            console.error(`Chyba pri ukladaní stavu hry ${gameInstance.gameId} do Firestore z playerAction:`, e);
                        }
                    }
                    io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                }
                break;
            case 'initializeGame': // KLÚČOVÁ ZMENA: Spracovanie 'initializeGame'
                if (!gameInstance.gameState) {
                    gameInstance.gameState = generateInitialGameState();
                    gameInstance.isGameStarted = true;
                    console.log(`Herný stav pre hru ${gameInstance.gameId} inicializovaný serverom na žiadosť klienta.`);
                    if (dbAdmin) {
                        try {
                            // Používame pevne dané appId 'default-app-id' pre cestu v Firestore
                            const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gameStates').doc(gameInstance.gameId);
                            await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                            console.log(`Inicializovaný stav hry ${gameInstance.gameId} uložený do Firestore.`);
                        } catch (e) {
                            console.error(`Chyba pri ukladaní inicializovaného stavu hry ${gameInstance.gameId} do Firestore:`, e);
                        }
                    }
                    io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                }
                break;
            case 'chatMessage':
                const fullMessage = { senderId: socket.id, senderIndex: socket.playerIndex, text: action.payload, timestamp: Date.now() };
                io.to(gameInstance.gameId).emit('receiveChatMessage', fullMessage);
                console.log(`Chat správa v hre ${gameInstance.gameId} od Hráča ${socket.playerIndex + 1}: ${action.payload}`);
                break;
            default:
                console.warn(`Neznámy typ akcie: ${action.type}`);
                break;
        }
    });

    // Odpojenie klienta
    socket.on('disconnect', async () => { // Zmenené na async
        console.log(`Klient odpojený: ${socket.id}`);
        const gameInstance = socket.gameInstance;
        const disconnectedPlayerIndex = socket.playerIndex;
        const gameId = socket.gameId;

        if (!gameInstance || !gameId) {
            console.log(`Odpojený klient ${socket.id} nebol pripojený k žiadnej hre.`);
            return;
        }

        socket.leave(gameId);

        if (disconnectedPlayerIndex !== undefined && gameInstance.players[disconnectedPlayerIndex]?.id === socket.id) {
            gameInstance.players[disconnectedPlayerIndex] = null;
            delete gameInstance.playerSockets[socket.id];
            console.log(`Hráč ${disconnectedPlayerIndex + 1} (${socket.id}) bol odstránený zo slotu hry ${gameInstance.gameId}.`);
        }

        const activePlayersCount = gameInstance.players.filter(p => p !== null).length;

        // Ak už nikto nie je pripojený k tejto hre, môžeme ju odstrániť z mapy hier a z Firestore
        if (activePlayersCount === 0) {
            console.log(`Hra ${gameId}: Všetci hráči odpojení, herný stav vyčistený a hra odstránená.`);
            await resetGameInstance(gameInstance); // Resetujeme aj vo Firestore
            games.delete(gameId);
        } else if (gameInstance.isGameStarted && activePlayersCount < 2) {
            console.log(`Hra ${gameId} bola prerušená, ale zostáva v pamäti pre možnú rekonexiu.`);
            // Tu by sme mohli zvážiť timeout na reset, ak sa nikto nepripojí po určitom čase
        }
        console.log(`Aktuálny stav players pre hru ${gameId} po odpojení:`, gameInstance.players.map(p => p ? `Hráč ${p.playerIndex + 1} (${p.id})` : 'Voľný'));
    });
});

// Spustenie servera
server.listen(PORT, () => {
    console.log(`Server beží na porte ${PORT}`);
});

app.get('/ping', (req, res) => {
    res.send('pong');
});
