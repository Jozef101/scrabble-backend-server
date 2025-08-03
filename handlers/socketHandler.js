// handlers/socketHandler.js
import { games, gameTimeouts, createNewGameInstance, generateInitialGameState, saveTurnLogToFirestore } from '../game/gameManager.js';
import { INACTIVITY_TIMEOUT_MS } from '../config/constants.js';

export default function initializeSocket(io, dbAdmin) {
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

            if (gameTimeouts.has(gameIdFromClient)) {
                clearTimeout(gameTimeouts.get(gameIdFromClient));
                gameTimeouts.delete(gameIdFromClient);
                console.log(`Timeout pre hru ${gameIdFromClient} zrušený (hráč sa pripojil).`);
            }

            socket.gameInstance = gameInstance;
            socket.gameId = gameIdFromClient;
            socket.userId = userId;

            let playerIndex = -1;
            let playerNickname = userId;

            if (dbAdmin) {
                try {
                    const userDocRef = dbAdmin.collection('users').doc(userId);
                    const userDocSnap = await userDocRef.get();
                    if (userDocSnap.exists && userDocSnap.data() && userDocSnap.data().nickname) {
                        playerNickname = userDocSnap.data().nickname;
                        console.log(`Načítaná prezývka pre užívateľa ${userId}: ${playerNickname}`);
                    } else {
                        console.log(`Prezývka pre užívateľa ${userId} nebola nájdená vo Firestore.`);
                    }
                } catch (e) {
                    console.error(`Chyba pri načítaní prezývky pre užívateľa ${userId}:`, e);
                }
            }

            // --- KĽÚČOVÁ ZMENA 1: Načítavanie a ukladanie celého stavu hry pod jedným dokumentom ---
            const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('games').doc(gameIdFromClient);
            const gameDocSnap = await gameDocRef.get();

            if (gameDocSnap.exists && gameDocSnap.data()) {
                const gameData = gameDocSnap.data();
                // Opravený riadok: Ak sú dáta už objekt (nie reťazec), netreba ich parsovať
                gameInstance.players = gameData.players && typeof gameData.players === 'string' ? JSON.parse(gameData.players) : (gameData.players || [null, null]);
                gameInstance.gameState = gameData.gameState && typeof gameData.gameState === 'string' ? JSON.parse(gameData.gameState) : (gameData.gameState || generateInitialGameState());
                gameInstance.isGameStarted = true;
                console.log(`Stav hry ${gameIdFromClient} načítaný z hlavnej kolekcie 'games'.`);
            } else {
                console.log(`Žiadny uložený stav pre ${gameIdFromClient} v 'games'. Inicializujem novú hru.`);
                gameInstance.players = [null, null];
                gameInstance.gameState = generateInitialGameState();
                gameInstance.isGameStarted = true;
                await gameDocRef.set({
                    players: JSON.stringify(gameInstance.players),
                    gameState: JSON.stringify(gameInstance.gameState),
                }, { merge: true });
                console.log(`Nový stav hry ${gameIdFromClient} inicializovaný a uložený do 'games'.`);
            }
            
            for (let i = 0; i < gameInstance.players.length; i++) {
                if (gameInstance.players[i] && gameInstance.players[i].userId === userId) {
                    playerIndex = i;
                    gameInstance.players[i].socketId = socket.id;
                    gameInstance.players[i].nickname = playerNickname;
                    console.log(`Klient ${socket.id} (User: ${userId}) sa znovu pripojil k hre ${gameIdFromClient} ako Hráč ${playerIndex + 1}.`);
                    break;
                }
            }

            if (playerIndex === -1) {
                if (gameInstance.players[0] === null || (gameInstance.players[0] && gameInstance.players[0].socketId === null)) {
                    playerIndex = 0;
                    gameInstance.players[0] = { userId: userId, playerIndex: 0, socketId: socket.id, nickname: playerNickname };
                    console.log(`Klient ${socket.id} (User: ${userId}) sa pripojil k hre ${gameIdFromClient} ako Hráč 1.`);
                } else if (gameInstance.players[1] === null || (gameInstance.players[1] && gameInstance.players[1].socketId === null)) {
                    playerIndex = 1;
                    gameInstance.players[1] = { userId: userId, playerIndex: 1, socketId: socket.id, nickname: playerNickname };
                    console.log(`Klient ${socket.id} (User: ${userId}) sa pripojil k hre ${gameIdFromClient} ako Hráč 2.`);
                } else {
                    socket.emit('gameError', 'Hra je už plná.');
                    console.log(`Klient ${socket.id} (User: ${userId}) sa nemohol pripojiť k hre ${gameIdFromClient}, hra je plná.`);
                    return;
                }
            }

            gameInstance.playerSockets[socket.id] = socket;
            socket.playerIndex = playerIndex;

            // --- KĽÚČOVÁ ZMENA 2: Uloženie hráčov po zmene do nového miesta ---
            if (dbAdmin) {
                await gameDocRef.set({ players: JSON.stringify(gameInstance.players) }, { merge: true });
                console.log(`Stav hráčov pre hru ${gameIdFromClient} uložený do hlavnej kolekcie 'games' po pripojení.`);
            }

            socket.emit('playerAssigned', playerIndex);
            console.log(`Aktuálny stav players pre hru ${gameIdFromClient}:`, gameInstance.players.map(p => p ? `Hráč ${p.playerIndex + 1} (User: ${p.userId}, Socket: ${p.socketId}, Nickname: ${p.nickname})` : 'Voľný'));

            // --- KĽÚČOVÁ ZMENA 3: Načítanie chatu z novej subkolekcie ---
            if (dbAdmin) {
                try {
                    const chatMessagesCollectionRef = gameDocRef.collection('chatMessages');
                    const q = chatMessagesCollectionRef.orderBy('timestamp');
                    const querySnapshot = await q.get();
                    const chatHistory = [];
                    querySnapshot.forEach((doc) => {
                        chatHistory.push(doc.data());
                    });
                    socket.emit('chatHistory', chatHistory);
                    console.log(`Server: História chatu pre hru ${gameIdFromClient} načítaná z novej subkolekcie 'chatMessages' (${chatHistory.length} správ) a odoslaná klientovi.`);
                } catch (e) {
                    console.error(`Chyba pri načítaní chatu pre hru ${gameIdFromClient} z novej štruktúry:`, e);
                }
            }

            if (gameInstance.gameState) {
                const playerNicknamesMap = {};
                gameInstance.players.forEach(p => {
                    if (p) {
                        playerNicknamesMap[p.playerIndex] = p.nickname || `Hráč ${p.playerIndex + 1}`;
                    }
                });
                gameInstance.gameState.playerNicknames = playerNicknamesMap;

                io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
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

        // Hráč posiela akciu (ťah, výmena, pass)
        socket.on('playerAction', async (action) => {
            const gameInstance = socket.gameInstance;
            if (!gameInstance || !gameInstance.gameState) {
                socket.emit('gameError', 'Nie ste pripojený k žiadnej hre alebo hra nemá inicializovaný stav.');
                console.warn(`Hráč ${socket.id} sa pokúsil o akciu ${action.type}, ale nie je pripojený k žiadnej hre.`);
                return;
            }

            if (
                action.type !== 'chatMessage' &&
                action.type !== 'updateGameState' &&
                (gameInstance.gameState.currentPlayerIndex !== socket.playerIndex)
            ) {
                socket.emit('gameError', 'Nie je váš ťah!');
                console.warn(`Hráč ${socket.playerIndex + 1} sa pokúsil o akciu ${action.type}, ale nie je na ťahu v hre ${gameInstance.gameId}.`);
                return;
            }

            console.log(`Akcia od Hráča ${socket.playerIndex + 1} v hre ${gameInstance.gameId}: ${action.type}`);

            const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('games').doc(gameInstance.gameId);

            switch (action.type) {
                case 'turnSubmitted':
                    const turnDetails = {
                        ...action.payload,
                        gameId: gameInstance.gameId,
                        turnNumber: gameInstance.gameState.turnNumber,
                        playerIndex: socket.playerIndex,
                        timestamp: Date.now(),
                    };

                    await saveTurnLogToFirestore(gameInstance.gameId, turnDetails);

                    const nextPlayerIndex = (gameInstance.gameState.currentPlayerIndex + 1) % gameInstance.players.filter(p => p).length;

                    if (action.payload.updatedGameState) {
                        gameInstance.gameState = { ...action.payload.updatedGameState,
                            currentPlayerIndex: nextPlayerIndex,
                            turnNumber: gameInstance.gameState.turnNumber + 1
                        };
                    } else {
                        gameInstance.gameState.currentPlayerIndex = nextPlayerIndex;
                        gameInstance.gameState.turnNumber++;
                    }

                    // --- KĽÚČOVÁ ZMENA 4: Ukladanie stavu hry do nového miesta po ťahu ---
                    if (dbAdmin) {
                        try {
                            await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                            console.log(`Stav hry ${gameInstance.gameId} uložený do hlavnej kolekcie 'games' po ťahu hráča.`);
                        } catch (e) {
                            console.error(`Chyba pri ukladaní stavu hry ${gameInstance.gameId} do 'games' po ťahu:`, e);
                        }
                    }

                    io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                    break;

                case 'updateGameState':
                    if (gameInstance.gameState) {
                        gameInstance.gameState = { ...gameInstance.gameState, ...action.payload };
                        // --- KĽÚČOVÁ ZMENA 5: Ukladanie stavu hry do nového miesta ---
                        if (dbAdmin) {
                            try {
                                await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                            } catch (e) {
                                console.error(`Chyba pri ukladaní stavu hry ${gameInstance.gameId} do 'games' z playerAction:`, e);
                            }
                        }
                        io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                    }
                    break;

                case 'initializeGame':
                    if (!gameInstance.gameState) {
                        gameInstance.gameState = generateInitialGameState();
                        gameInstance.isGameStarted = true;
                        console.log(`Herný stav pre hru ${gameInstance.gameId} inicializovaný serverom na žiadosť klienta.`);
                        // --- KĽÚČOVÁ ZMENA 6: Ukladanie inicializovaného stavu do nového miesta ---
                        if (dbAdmin) {
                            try {
                                await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                                console.log(`Inicializovaný stav hry ${gameInstance.gameId} uložený do hlavnej kolekcie 'games'.`);
                            } catch (e) {
                                console.error(`Chyba pri ukladaní inicializovaného stavu hry ${gameInstance.gameId} do 'games':`, e);
                            }
                        }
                        io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                    }
                    break;

                case 'chatMessage':
                    const senderPlayer = gameInstance.players.find(p => p && p.playerIndex === socket.playerIndex);
                    const senderNickname = senderPlayer ? senderPlayer.nickname : `Hráč ${socket.playerIndex + 1}`;

                    const fullMessage = {
                        gameId: gameInstance.gameId,
                        senderId: socket.id,
                        senderIndex: socket.playerIndex,
                        senderNickname: senderNickname,
                        text: action.payload,
                        timestamp: Date.now()
                    };
                    io.to(gameInstance.gameId).emit('receiveChatMessage', fullMessage);
                    console.log(`Chat správa v hre ${gameInstance.gameId} od ${senderNickname}: ${action.payload}`);

                    // --- KĽÚČOVÁ ZMENA 7: Ukladanie chatovej správy do novej subkolekcie ---
                    if (dbAdmin) {
                        try {
                            const chatMessagesCollectionRef = gameDocRef.collection('chatMessages');
                            await chatMessagesCollectionRef.add(fullMessage);
                            console.log(`Server: Ukladám chat správu pre hru ${gameInstance.gameId} do novej subkolekcie 'chatMessages'.`);
                        } catch (e) {
                            console.error(`Chyba pri ukladaní chatovej správy pre hru ${gameInstance.gameId} do 'games':`, e);
                        }
                    }
                    break;

                case 'assignJoker':
                    if (gameInstance.gameState) {
                        const { x, y, assignedLetter } = action.payload;
                        const newBoard = gameInstance.gameState.board.map(row => [...row]);
                        if (newBoard[x][y] && newBoard[x][y].letter === '') {
                            newBoard[x][y] = { ...newBoard[x][y], assignedLetter: assignedLetter };
                            gameInstance.gameState = { ...gameInstance.gameState, board: newBoard };
                            // --- KĽÚČOVÁ ZMENA 8: Ukladanie stavu hry do nového miesta ---
                            if (dbAdmin) {
                                try {
                                    await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                                    console.log(`Stav hry ${gameInstance.gameId} uložený do hlavnej kolekcie 'games' po priradení žolíka.`);
                                } catch (e) {
                                    console.error(`Chyba pri ukladaní stavu hry ${gameInstance.gameId} do 'games' po priradení žolíka:`, e);
                                }
                            }
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
            const userId = socket.userId;

            if (!gameInstance || !gameId || !userId) {
                console.log(`Odpojený klient ${socket.id} nebol pripojený k žiadnej hre alebo nemal priradené userId.`);
                return;
            }

            socket.leave(gameId);

            const playerSlot = gameInstance.players.find(p => p && p.userId === userId);
            if (playerSlot) {
                playerSlot.socketId = null;
                delete gameInstance.playerSockets[socket.id];
                console.log(`Hráč (User: ${userId}, Nickname: ${playerSlot.nickname}) bol odpojený zo slotu hry ${gameId}.`);

                // --- KĽÚČOVÁ ZMENA 9: Ukladanie stavu hráčov po odpojení do nového miesta ---
                if (dbAdmin) {
                    try {
                        const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('games').doc(gameId);
                        await gameDocRef.set({ players: JSON.stringify(gameInstance.players) }, { merge: true });
                        console.log(`Stav hráčov pre hru ${gameId} uložený do hlavnej kolekcie 'games' po odpojení.`);
                    } catch (e) {
                        console.error(`Chyba pri ukladaní stavu hráčov ${gameId} do 'games' po odpojení:`, e);
                    }
                }
            } else {
                console.warn(`Odpojený klient ${socket.id} (User: ${userId}) nebol nájdený v playerSlots pre hru ${gameId}.`);
            }

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
                if (connectedPlayersCount === 1) {
                    io.to(gameInstance.gameId).emit('waitingForPlayers', 'Čaká sa na druhého hráča...');
                    console.log(`Server: Hra ${gameId}: Zostal len jeden hráč. Čaká sa na druhého.`);
                }
                console.log(`Hra ${gameId} má stále ${connectedPlayersCount} pripojených klientov.`);
            }

            console.log(`Aktuálny stav players pre hru ${gameId} po odpojení:`, gameInstance.players.map(p => p ? `Hráč ${p.playerIndex + 1} (User: ${p.userId}, Socket: ${p.socketId}, Nickname: ${p.nickname})` : 'Voľný'));
        });
    });
}