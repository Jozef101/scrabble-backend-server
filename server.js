// server/server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Používame CORS, aby frontend (bežiaci na inom porte/doméne) mohol komunikovať so serverom
app.use(cors({
    origin: '*', // Povoliť všetky domény pre jednoduchosť testovania. V produkcii by ste chceli obmedziť na doménu vášho frontendu.
    methods: ['GET', 'POST']
}));

// Inicializácia Socket.IO servera
const io = socketIo(server, {
    cors: {
        origin: '*', // Rovnako ako pre Express, povoliť všetky domény
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 4000;

// ====================================================================
// Herný stav (držaný v pamäti servera - pre jednoduché testovanie)
// V plnej implementácii by toto bolo v databáze
// ====================================================================
let game = {
    // Používame pevné sloty pre hráčov, aby sme zabezpečili konzistentné indexy
    // game.players[0] pre Hráča 0, game.players[1] pre Hráča 1
    players: [null, null], // null znamená voľný slot, objekt { id: socket.id, playerIndex: X } znamená obsadený
    playerSockets: {}, // Mapa pre rýchly prístup k objektom socketov podľa ich ID
    gameState: null, // Bude obsahovať celý stav hry (board, racks, bag, scores, currentPlayerIndex)
    gameId: 'scrabble-game-1', // Jednoduché ID pre jednu hru
    // chatMessages: [], // Odstránené, ak nechceme chat históriu
    // gameLogHistory: [], // Odstránené, ak nechceme herný denník
    isGameStarted: false,
};

// Pomocná funkcia na vytvorenie vrecúška s písmenami
const LETTER_VALUES = {
    'A': 1, 'Á': 4, 'Ä': 10, 'B': 4, 'C': 4, 'Č': 5, 'D': 2, 'Ď': 8, 'E': 1, 'É': 7,
    'F': 8, 'G': 8, 'H': 4, 'I': 1, 'Í': 5, 'J': 3, 'K': 2, 'L': 2, 'Ľ': 7, 'Ĺ': 10,
    'M': 2, 'N': 1, 'Ň': 8, 'O': 1, 'Ô': 8, 'Ó': 10, 'P': 2, 'Q': 10, 'R': 1, 'Ŕ': 10,
    'S': 1, 'Š': 5, 'T': 1, 'Ť': 7, 'U': 3, 'Ú': 7, 'V': 1, 'W': 5, 'X': 10, 'Y': 4, 'Ý': 5,
    'Z': 4, 'Ž': 5, '': 0
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

function createLetterBag() {
    const bag = [];
    let idCounter = 0;
    LETTER_DISTRIBUTION.forEach(item => {
        for (let i = 0; i < item.count; i++) {
            bag.push({ id: `letter-${idCounter++}`, letter: item.letter, value: LETTER_VALUES[item.letter] });
        }
    });
    // Zamiešame vrecúško
    for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    return bag;
}

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
    socket.on('joinGame', () => {
        let playerIndex = -1; // Predvolená hodnota, ktorá signalizuje, že hráč nebol priradený

        // 1. Skontrolujeme, či sa klient už pripojil (rekonexia)
        if (game.players[0] && game.players[0].id === socket.id) {
            playerIndex = 0;
            console.log(`Klient ${socket.id} sa znovu pripojil ako Hráč 1.`);
        } else if (game.players[1] && game.players[1].id === socket.id) {
            playerIndex = 1;
            console.log(`Klient ${socket.id} sa znovu pripojil ako Hráč 2.`);
        } else {
            // 2. Ak nie je rekonexia, priradíme nový slot, ak je k dispozícii
            if (game.players[0] === null) {
                playerIndex = 0;
                console.log(`Klient ${socket.id} sa pripojil ako Hráč 1.`);
            } else if (game.players[1] === null) {
                playerIndex = 1;
                console.log(`Klient ${socket.id} sa pripojil ako Hráč 2.`);
            } else {
                // 3. Ak sú oba sloty obsadené a nie je to rekonexia, hra je plná
                socket.emit('gameError', 'Hra je už plná.');
                console.log(`Klient ${socket.id} sa nemohol pripojiť, hra je plná.`);
                return;
            }
        }

        // Uložíme informácie o hráčovi do príslušného slotu
        game.players[playerIndex] = { id: socket.id, playerIndex: playerIndex };
        game.playerSockets[socket.id] = socket; // Uložíme referenciu na socket
        socket.playerIndex = playerIndex; // Priradíme playerIndex priamo k objektu socketu pre jednoduchší prístup

        // Oznámime klientovi jeho priradený playerIndex
        socket.emit('playerAssigned', playerIndex);

        // Debug: Skontrolujte aktuálny stav game.players po priradení
        console.log("Aktuálny stav game.players:", game.players.map(p => p ? `Hráč ${p.playerIndex + 1} (${p.id})` : 'Voľný'));

        // Logika pre spustenie/pokračovanie hry
        const activePlayersCount = game.players.filter(p => p !== null).length;
        if (activePlayersCount === 2 && !game.isGameStarted) {
            // Dvaja hráči pripojení a hra ešte nezačala, inicializujeme ju
            console.log('Dvaja hráči pripojení, inicializujem hru!');
            game.isGameStarted = true;
            initializeGame(); // Inicializujeme herný stav na serveri
            io.emit('gameStateUpdate', game.gameState); // Pošleme počiatočný stav všetkým
        } else if (game.isGameStarted && game.gameState) {
            // Hra už beží, pošleme aktuálny stav pripájajúcemu sa (alebo znovu pripájajúcemu sa) hráčovi
            socket.emit('gameStateUpdate', game.gameState);
        } else {
            // Pripojený len jeden hráč, alebo hra ešte nezačala a čaká sa na druhého
            console.log(`Čaká sa na druhého hráča. Aktuálni hráči: ${activePlayersCount}`);
            // Neposielame plný herný stav, len informáciu o čakaní
            io.emit('waitingForPlayers', 'Čaká sa na druhého hráča...'); // Nový event pre klienta
        }
    });

    // Klient posiela akciu (ťah, výmena, pass)
    socket.on('playerAction', (action) => {
        // Overenie, či je na ťahu správny hráč
        // Akcia updateGameState a assignJoker môže prísť aj mimo ťahu pre UI synchronizáciu
        if (game.gameState && action.type !== 'updateGameState' && action.type !== 'assignJoker' && (game.gameState.currentPlayerIndex !== socket.playerIndex)) {
            socket.emit('gameError', 'Nie je váš ťah!');
            console.warn(`Hráč ${socket.playerIndex + 1} sa pokúsil o akciu ${action.type}, ale nie je na ťahu.`);
            return;
        }

        console.log(`Akcia od Hráča ${socket.playerIndex + 1}: ${action.type}`);

        switch (action.type) {
            case 'updateGameState':
                // Klient posiela celý aktuálny stav. Server by mal ideálne validovať a aktualizovať len povolené časti.
                // Pre jednoduchosť testovania prijmeme celý payload.
                if (game.gameState) {
                    game.gameState = { ...game.gameState, ...action.payload };
                    io.emit('gameStateUpdate', game.gameState);
                }
                break;
            // Prípadné ďalšie typy akcií (confirmTurn, exchangeLetters, passTurn, assignJoker)
            // by mali byť spracované tu na serveri s plnou validáciou a aktualizáciou game.gameState
            // a následným io.emit('gameStateUpdate', game.gameState);
            // Ak tieto akcie posiela klient ako 'updateGameState' s rôznymi payloadmi,
            // potom by server mal parsovať 'payload' a podľa toho aktualizovať.
            // Váš App.js posiela updateGameState pre všetky akcie, takže to takto necháme.
            default:
                console.warn(`Neznámy typ akcie: ${action.type}`);
                break;
        }
    });

    // Klient posiela chatovú správu (táto časť je zakomentovaná, ak nechceme chat)
    /*
    socket.on('chatMessage', (message) => {
        const fullMessage = { senderId: socket.id, senderIndex: socket.playerIndex, text: message, timestamp: Date.now() };
        game.chatMessages.push(fullMessage);
        io.emit('receiveChatMessage', fullMessage);
        console.log(`Chat správa od Hráča ${socket.playerIndex + 1}: ${message}`);
    });
    */

    // Odpojenie klienta
    socket.on('disconnect', () => {
        console.log(`Klient odpojený: ${socket.id}`);
        const disconnectedPlayerIndex = socket.playerIndex;

        // Vyčistíme slot odpojeného hráča
        if (disconnectedPlayerIndex !== undefined && game.players[disconnectedPlayerIndex]?.id === socket.id) {
            game.players[disconnectedPlayerIndex] = null;
            delete game.playerSockets[socket.id]; // Odstránime referenciu na socket
            console.log(`Hráč ${disconnectedPlayerIndex + 1} (${socket.id}) bol odstránený zo slotu.`);
        }

        const activePlayersCount = game.players.filter(p => p !== null).length;
        // Ak hra prebiehala a teraz je menej ako 2 aktívni hráči, resetujeme hru
        if (game.isGameStarted && activePlayersCount < 2) {
            console.log('Hra bola prerušená, resetujem stav.');
            resetGame(); // Použijeme novú funkciu na reset
            io.emit('gameReset', 'Jeden z hráčov sa odpojil. Hra bola resetovaná.');
        } else if (activePlayersCount === 0) {
            // Ak sa odpojí posledný hráč, vyčistíme úplne stav
            console.log('Všetci hráči odpojení, herný stav vyčistený.');
            resetGame(); // Použijeme novú funkciu na reset
        }
        // Debug: Skontrolujte aktuálny stav game.players po odpojení
        console.log("Aktuálny stav game.players po odpojení:", game.players.map(p => p ? `Hráč ${p.playerIndex + 1} (${p.id})` : 'Voľný'));
    });
});

// Funkcia na inicializáciu stavu hry
function initializeGame() {
    const initialBag = createLetterBag();
    const { drawnLetters: player0Rack, remainingBag: bagAfterP0 } = drawLetters(initialBag, 7);
    const { drawnLetters: player1Rack, remainingBag: finalBag } = drawLetters(bagAfterP0, 7);

    game.gameState = {
        playerRacks: [player0Rack, player1Rack],
        board: Array(15).fill(null).map(() => Array(15).fill(null)),
        letterBag: finalBag,
        playerScores: [0, 0],
        currentPlayerIndex: 0,
        boardAtStartOfTurn: Array(15).fill(null).map(() => Array(15).fill(null)),
        isFirstTurn: true,
        isBagEmpty: finalBag.length === 0, // Skutočný stav, či je vrecúško prázdne
        exchangeZoneLetters: [],
        hasPlacedOnBoardThisTurn: false,
        hasMovedToExchangeZoneThisTurn: false,
        consecutivePasses: 0,
        isGameOver: false,
    };
    console.log("Počiatočný herný stav inicializovaný na serveri.");
    console.log("Rack Hráča 1:", game.gameState.playerRacks[0].map(l => l.letter));
    console.log("Rack Hráča 2:", game.gameState.playerRacks[1].map(l => l.letter));
}

// NOVÁ FUNKCIA: Resetuje herný stav na počiatočné hodnoty
function resetGame() {
    game = {
        players: [null, null], // Reset na prázdne sloty
        playerSockets: {}, // Vyčistíme referencie na sockety
        gameState: null,
        gameId: 'scrabble-game-1',
        // chatMessages: [], // Odstránené
        // gameLogHistory: [], // Odstránené
        isGameStarted: false,
    };
    console.log("Herný stav bol resetovaný.");
}

// Spustenie servera
server.listen(PORT, () => {
    console.log(`Server beží na porte ${PORT}`);
});
