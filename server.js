// server/server.js
import 'dotenv/config'; // Dôležité pre načítanie premenných prostredia z .env súboru
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io'; // Zmenené na SocketIOServer pre jasnosť
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
        // Pre lokálne testovanie, ak nechcete nastavovať premenné prostredia,
        // môžete odkomentovať nasledujúci riadok a nahradiť cestu k vášmu JSON súboru servisného účtu.
        // UISTITE SA, ŽE TENTO SÚBOR NIKDY NECOMMITNETE DO VEREJNÉHO REPOZITÁRA!
        // serviceAccount = require('./path/to/your/serviceAccountKey.json');
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

const io = new SocketIOServer(server, { // Zmenené na SocketIOServer
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
const gameTimeouts = new Map(); // Mapa na sledovanie timeoutov hier

// Doba neaktivity pred vymazaním hry z pamäte (v milisekundách)
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 60 minút

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
        highlightedLetters: [],
        hasInitialGameStateReceived: true, // Klient teraz vie, že dostal počiatočný stav
        playerNicknames: {}, // Dôležité: Inicializujeme playerNicknames v stave hry
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

            // NOVÉ: Odstránime aj chatové správy pre túto hru
            const chatMessagesCollectionRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('chatMessages');
            // KLÚČOVÁ ZMENA: Používame metódy Admin SDK pre query a get
            const q = chatMessagesCollectionRef.where('gameId', '==', gameInstance.gameId).orderBy('timestamp'); // Pridané orderBy pre konzistentnosť pri odstraňovaní
            const querySnapshot = await q.get();
            const deletePromises = [];
            querySnapshot.forEach((doc) => {
                // KLÚČOVÁ ZMENA: Používame metódu .delete() na DocumentReference
                deletePromises.push(doc.ref.delete());
            });
            await Promise.all(deletePromises);
            console.log(`Chatové správy pre hru ${gameInstance.gameId} odstránené z Firestore.`);

            // KLÚČOVÁ ZMENA: Odstránime aj stav hráčov pre túto hru
            const gamePlayersDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gamePlayers').doc(gameInstance.gameId);
            await gamePlayersDocRef.delete();
            console.log(`Stav hráčov pre hru ${gameInstance.gameId} odstránený z Firestore.`);

        } catch (e) {
            console.error(`Chyba pri odstraňovaní stavu hry/chatu/hráčov ${gameInstance.gameId} z Firestore:`, e);
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
    socket.on('joinGame', async ({ gameId: gameIdFromClient, userId }) => {
        if (!gameIdFromClient) {
            gameIdFromClient = 'default-scrabble-game';
            console.log(`Klient ${socket.id} sa pokúsil pripojiť bez ID hry. Priradené defaultné ID: ${gameIdFromClient}`);
        }

        if (!userId) {
            socket.emit('gameError', 'Pre pripojenie k hre je potrebné ID používateľa.');
            console.warn(`Klient ${socket.id} sa pokúsil pripojiť k hre ${gameIdFromClient} bez ID používateľa.`);
            return;
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

        // Ak existuje aktívny timeout pre túto hru, zrušíme ho
        if (gameTimeouts.has(gameIdFromClient)) {
            clearTimeout(gameTimeouts.get(gameIdFromClient));
            gameTimeouts.delete(gameIdFromClient);
            console.log(`Timeout pre hru ${gameIdFromClient} zrušený (hráč sa pripojil).`);
        }

        socket.gameInstance = gameInstance;
        socket.gameId = gameIdFromClient;
        socket.userId = userId; // Uložíme userId na socket pre ľahší prístup

        let playerIndex = -1;
        let playerNickname = userId; // Predvolená prezývka je userId

        // KLÚČOVÁ ZMENA: Načítanie prezývky používateľa z Firestore
        if (dbAdmin) {
            try {
                const userDocRef = dbAdmin.collection('users').doc(userId); // Predpokladáme kolekciu 'users'
                const userDocSnap = await userDocRef.get();
                if (userDocSnap.exists && userDocSnap.data() && userDocSnap.data().nickname) {
                    playerNickname = userDocSnap.data().nickname;
                    console.log(`Načítaná prezývka pre užívateľa ${userId}: ${playerNickname}`);
                } else {
                    console.log(`Prezývka pre užívateľa ${userId} nebola nájdená vo Firestore. Používam userId ako prezývku.`);
                }
            } catch (e) {
                console.error(`Chyba pri načítaní prezývky pre užívateľa ${userId} z Firestore:`, e);
            }
        }

        // Načítanie stavu hráčov z Firestore pri pripojení
        if (dbAdmin) {
            try {
                const gamePlayersDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gamePlayers').doc(gameIdFromClient);
                const docSnap = await gamePlayersDocRef.get();
                
                if (docSnap.exists && docSnap.data() && docSnap.data().players) {
                    gameInstance.players = JSON.parse(docSnap.data().players);
                    console.log(`Stav hráčov pre hru ${gameIdFromClient} načítaný z Firestore.`);
                } else {
                    console.log(`Žiadny uložený stav hráčov pre ${gameIdFromClient} vo Firestore. Inicializujem prázdne sloty.`);
                    gameInstance.players = [null, null]; // Inicializácia prázdnych slotov
                    // Uložíme inicializovaný stav hráčov do Firestore
                    await gamePlayersDocRef.set({ players: JSON.stringify(gameInstance.players) }, { merge: true });
                }
            } catch (e) {
                console.error(`Chyba pri načítaní/inicializácii stavu hráčov ${gameIdFromClient} z Firestore:`, e);
                gameInstance.players = [null, null]; // Fallback na prázdne sloty
            }
        } else {
            // Ak dbAdmin nie je k dispozícii, použijeme in-memory stav (ktorý môže byť resetovaný)
            if (!gameInstance.players || gameInstance.players.length === 0) {
                gameInstance.players = [null, null];
            }
        }

        // 1. Skontrolujeme, či sa klient s daným userId už pripojil (rekonexia) k TEJTO HRY
        for (let i = 0; i < gameInstance.players.length; i++) {
            if (gameInstance.players[i] && gameInstance.players[i].userId === userId) { // Check by userId
                playerIndex = i;
                // Aktualizujeme socketId a nickname pre rekonexiu
                gameInstance.players[i].socketId = socket.id;
                gameInstance.players[i].nickname = playerNickname; // KLÚČOVÁ ZMENA: Aktualizujeme aj prezývku
                console.log(`Klient ${socket.id} (User: ${userId}) sa znovu pripojil k hre ${gameIdFromClient} ako Hráč ${playerIndex + 1}.`);
                break;
            }
        }

        // 2. Ak nie je rekonexia, priradíme nový slot, ak je k dispozícii v TEJTO HRY
        if (playerIndex === -1) { // Ak sa nenašiel existujúci slot
            // Hľadáme prázdny slot alebo slot s odpojeným hráčom (socketId: null)
            if (gameInstance.players[0] === null || (gameInstance.players[0] && gameInstance.players[0].socketId === null)) {
                playerIndex = 0;
                gameInstance.players[0] = { userId: userId, playerIndex: 0, socketId: socket.id, nickname: playerNickname }; // KLÚČOVÁ ZMENA: Ukladáme prezývku
                console.log(`Klient ${socket.id} (User: ${userId}) sa pripojil k hre ${gameIdFromClient} ako Hráč 1.`);
            } else if (gameInstance.players[1] === null || (gameInstance.players[1] && gameInstance.players[1].socketId === null)) {
                playerIndex = 1;
                gameInstance.players[1] = { userId: userId, playerIndex: 1, socketId: socket.id, nickname: playerNickname }; // KLÚČOVÁ ZMENA: Ukladáme prezývku
                console.log(`Klient ${socket.id} (User: ${userId}) sa pripojil k hre ${gameIdFromClient} ako Hráč 2.`);
            } else {
                // 3. Ak sú oba sloty obsadené v TEJTO HRY a nie je to rekonexia, hra je plná
                socket.emit('gameError', 'Hra je už plná.');
                console.log(`Klient ${socket.id} (User: ${userId}) sa nemohol pripojiť k hre ${gameIdFromClient}, hra je plná.`);
                return;
            }
        }

        gameInstance.playerSockets[socket.id] = socket;
        socket.playerIndex = playerIndex; // Uložíme playerIndex na socket

        // Uložíme aktualizovaný stav hráčov do Firestore po pripojení/rekonexii
        if (dbAdmin) {
            try {
                const gamePlayersDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gamePlayers').doc(gameIdFromClient);
                await gamePlayersDocRef.set({ players: JSON.stringify(gameInstance.players) }, { merge: true });
                console.log(`Stav hráčov pre hru ${gameIdFromClient} uložený do Firestore po pripojení.`);
            } catch (e) {
                console.error(`Chyba pri ukladaní stavu hráčov ${gameIdFromClient} do Firestore po pripojení:`, e);
            }
        }

        socket.emit('playerAssigned', playerIndex);

        console.log(`Aktuálny stav players pre hru ${gameIdFromClient}:`, gameInstance.players.map(p => p ? `Hráč ${p.playerIndex + 1} (User: ${p.userId}, Socket: ${p.socketId}, Nickname: ${p.nickname})` : 'Voľný'));

        // Načítanie stavu hry z Firestore pri pripojení
        if (dbAdmin) {
            try {
                const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gameStates').doc(gameIdFromClient);
                const docSnap = await gameDocRef.get();
                
                if (docSnap.exists && docSnap.data() && docSnap.data().gameState) {
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

                // NOVÉ: Načítanie histórie chatu z Firestore
                const chatMessagesCollectionRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('chatMessages');
                // KLÚČOVÁ ZMENA: Používame metódy Admin SDK pre query a get
                const q = chatMessagesCollectionRef.where('gameId', '==', gameIdFromClient).orderBy('timestamp');
                const querySnapshot = await q.get();
                const chatHistory = [];
                querySnapshot.forEach((doc) => {
                    chatHistory.push(doc.data());
                });
                socket.emit('chatHistory', chatHistory); // Odošleme históriu chatu len pripájajúcemu sa klientovi
                // DEBUG LOG: Počet načítaných správ
                console.log(`Server: História chatu pre hru ${gameIdFromClient} načítaná z Firestore (${chatHistory.length} správ) a odoslaná klientovi.`);

            } catch (e) {
                console.error(`Chyba pri načítaní/inicializácii stavu hry alebo chatu ${gameIdFromClient} z Firestore:`, e);
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

        if (gameInstance.gameState) {
            // KLÚČOVÁ ZMENA: Vytvoríme mapu prezývok z aktuálnych hráčov a pridáme ju do gameState
            const playerNicknamesMap = {};
            gameInstance.players.forEach(p => {
                if (p) {
                    playerNicknamesMap[p.playerIndex] = p.nickname || `Hráč ${p.playerIndex + 1}`;
                }
            });
            gameInstance.gameState.playerNicknames = playerNicknamesMap;

            io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState); // Emitujeme aktualizovaný stav všetkým v miestnosti
            const connectedPlayersCount = gameInstance.players.filter(p => p !== null && p.socketId !== null).length;

            if (connectedPlayersCount < 2) {
                io.to(gameInstance.gameId).emit('waitingForPlayers', 'Čaká sa na druhého hráča...');
                console.log(`Server: Hra ${gameIdFromClient}: Čaká sa na druhého hráča. Aktuálni pripojení hráči: ${connectedPlayersCount}`);
            } else {
                console.log(`Server: Hra ${gameIdFromClient}: Všetci hráči pripojení. Hra môže začať.`);
            }
        } else {
            console.error(`Server: Kritická chyba: GameState pre hru ${gameIdFromClient} je stále null po všetkých pokusoch o inicializáciu.`);
            socket.emit('gameError', 'Kritická chyba: Nepodarilo sa inicializovať stav hry.');
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
                    // KLÚČOVÁ ZMENA: Server preberá celý stav hry, vrátane highlightedLetters a playerNicknames
                    gameInstance.gameState = { ...gameInstance.gameState, ...action.payload };
                    // Uložíme stav do Firestore po každej aktualizácii
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
            case 'initializeGame': // Spracovanie 'initializeGame'
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
                // KLÚČOVÁ ZMENA: Získame prezývku odosielateľa z gameInstance.players
                const senderPlayer = gameInstance.players.find(p => p && p.playerIndex === socket.playerIndex);
                const senderNickname = senderPlayer ? senderPlayer.nickname : `Hráč ${socket.playerIndex + 1}`;

                const fullMessage = {
                    gameId: gameInstance.gameId, // Pridáme gameId k správe pre filtrovanie vo Firestore
                    senderId: socket.id,
                    senderIndex: socket.playerIndex,
                    senderNickname: senderNickname, // KLÚČOVÁ ZMENA: Pridávame prezývku odosielateľa
                    text: action.payload,
                    timestamp: Date.now()
                };
                io.to(gameInstance.gameId).emit('receiveChatMessage', fullMessage);
                console.log(`Chat správa v hre ${gameInstance.gameId} od ${senderNickname}: ${action.payload}`);

                // NOVÉ: Uložíme chatovú správu do Firestore
                if (dbAdmin) {
                    try {
                        const chatMessagesCollectionRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('chatMessages');
                        // KLÚČOVÁ ZMENA: Používame .add() metódu na CollectionReference
                        await chatMessagesCollectionRef.add(fullMessage);
                        // DEBUG LOG: Ukladanie správy
                        console.log(`Server: Ukladám chat správu pre hru ${gameInstance.gameId} do Firestore.`);
                    } catch (e) {
                        console.error(`Chyba pri ukladaní chatovej správy pre hru ${gameInstance.gameId} do Firestore:`, e);
                    }
                }
                break;
            case 'assignJoker': // Pridaná logika pre priradenie žolíka na serveri
                if (gameInstance.gameState) {
                    const { x, y, assignedLetter } = action.payload;
                    const newBoard = gameInstance.gameState.board.map(row => [...row]);
                    if (newBoard[x][y] && newBoard[x][y].letter === '') {
                        newBoard[x][y] = { ...newBoard[x][y], assignedLetter: assignedLetter };
                        gameInstance.gameState = { ...gameInstance.gameState, board: newBoard };
                        // Uložíme stav do Firestore po aktualizácii žolíka
                        if (dbAdmin) {
                            try {
                                const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gameStates').doc(gameInstance.gameId);
                                await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                                console.log(`Stav hry ${gameInstance.gameId} uložený do Firestore po priradení žolíka.`);
                            } catch (e) {
                                console.error(`Chyba pri ukladaní stavu hry ${gameInstance.gameId} do Firestore po priradení žolíka:`, e);
                            }
                        }
                        // KLÚČOVÁ ZMENA: Pri emitovaní gameStateUpdate zabezpečíme, že playerNicknames je aktuálne
                        const playerNicknamesMap = {};
                        gameInstance.players.forEach(p => {
                            if (p) {
                                playerNicknamesMap[p.playerIndex] = p.nickname || `Hráč ${p.playerIndex + 1}`;
                            }
                        });
                        gameInstance.gameState.playerNicknames = playerNicknamesMap;
                        io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                    }
                }
                break;
            default:
                console.warn(`Neznámy typ akcie: ${action.type}`);
                break;
        }
    });

    // Odpojenie klienta
    socket.on('disconnect', async () => {
        console.log(`Klient odpojený: ${socket.id}`);
        const gameInstance = socket.gameInstance;
        const gameId = socket.gameId;
        const userId = socket.userId; // Získame userId z objektu socketu

        if (!gameInstance || !gameId || !userId) { // Pridaná kontrola pre userId
            console.log(`Odpojený klient ${socket.id} nebol pripojený k žiadnej hre alebo nemal priradené userId.`);
            return;
        }

        socket.leave(gameId);

        // Nastavíme socketId hráča na null, ale ponecháme userId, playerIndex a nickname
        const playerSlot = gameInstance.players.find(p => p && p.userId === userId);
        if (playerSlot) {
            playerSlot.socketId = null; // Označíme, že tento userId už nemá aktívny socket
            delete gameInstance.playerSockets[socket.id]; // Odstránime referenciu na starý socket
            console.log(`Hráč (User: ${userId}, Nickname: ${playerSlot.nickname}) bol odpojený zo slotu hry ${gameId}.`); // KLÚČOVÁ ZMENA: Logujeme aj prezývku

            // Uložíme aktualizovaný stav hráčov do Firestore po odpojení
            if (dbAdmin) {
                try {
                    const gamePlayersDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gamePlayers').doc(gameId);
                    await gamePlayersDocRef.set({ players: JSON.stringify(gameInstance.players) }, { merge: true });
                    console.log(`Stav hráčov pre hru ${gameId} uložený do Firestore po odpojení.`);
                } catch (e) {
                    console.error(`Chyba pri ukladaní stavu hráčov ${gameId} do Firestore po odpojení:`, e);
                }
            }

        } else {
            console.warn(`Odpojený klient ${socket.id} (User: ${userId}) nebol nájdený v playerSlots pre hru ${gameId}.`);
        }

        // Počet pripojených hráčov teraz kontroluje, či majú priradený socketId
        const connectedPlayersCount = gameInstance.players.filter(p => p !== null && p.socketId !== null).length;

        if (connectedPlayersCount === 0) {
            console.log(`Hra ${gameId}: Všetci klienti odpojení. Nastavujem timeout pre vymazanie z pamäte.`);
            const timeoutId = setTimeout(() => {
                games.delete(gameId);
                gameTimeouts.delete(gameId);
                console.log(`Hra ${gameId} bola vymazaná z pamäte servera po neaktivite.`);
            }, INACTIVITY_TIMEOUT_MS);
            gameTimeouts.set(gameId, timeoutId);
        } else {
            // Ak sa odpojil hráč a zostal len jeden, pošleme správu o čakaní
            if (connectedPlayersCount === 1) {
                io.to(gameInstance.gameId).emit('waitingForPlayers', 'Čaká sa na druhého hráča...');
                console.log(`Server: Hra ${gameId}: Zostal len jeden hráč. Čaká sa na druhého.`);
            }
            console.log(`Hra ${gameId} má stále ${connectedPlayersCount} pripojených klientov.`);
        }
        
        console.log(`Aktuálny stav players pre hru ${gameId} po odpojení:`, gameInstance.players.map(p => p ? `Hráč ${p.playerIndex + 1} (User: ${p.userId}, Socket: ${p.socketId}, Nickname: ${p.nickname})` : 'Voľný'));
    });
});

// Spustenie servera
server.listen(PORT, () => {
    console.log(`Server beží na porte ${PORT}`);
});

app.get('/ping', (req, res) => {
    res.send('pong');
});
