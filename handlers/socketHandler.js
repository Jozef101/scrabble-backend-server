// handlers/socketHandler.js
import { games, gameTimeouts, createNewGameInstance, generateInitialGameState } from '../game/gameManager.js';
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

            if (dbAdmin) {
                try {
                    const gamePlayersDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gamePlayers').doc(gameIdFromClient);
                    const docSnap = await gamePlayersDocRef.get();

                    if (docSnap.exists && docSnap.data() && docSnap.data().players) {
                        gameInstance.players = JSON.parse(docSnap.data().players);
                        console.log(`Stav hráčov pre hru ${gameIdFromClient} načítaný z Firestore.`);
                    } else {
                        console.log(`Žiadny uložený stav hráčov pre ${gameIdFromClient} vo Firestore. Inicializujem prázdne sloty.`);
                        gameInstance.players = [null, null];
                        await gamePlayersDocRef.set({ players: JSON.stringify(gameInstance.players) }, { merge: true });
                    }
                } catch (e) {
                    console.error(`Chyba pri načítaní/inicializácii stavu hráčov ${gameIdFromClient} z Firestore:`, e);
                    gameInstance.players = [null, null];
                }
            } else {
                if (!gameInstance.players || gameInstance.players.length === 0) {
                    gameInstance.players = [null, null];
                }
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

            if (dbAdmin) {
                try {
                    const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gameStates').doc(gameIdFromClient);
                    const docSnap = await gameDocRef.get();

                    if (docSnap.exists && docSnap.data() && docSnap.data().gameState) {
                        const loadedState = JSON.parse(docSnap.data().gameState);
                        gameInstance.gameState = loadedState;
                        gameInstance.isGameStarted = true;
                        console.log(`Stav hry ${gameIdFromClient} načítaný z Firestore.`);
                    } else {
                        console.log(`Žiadny uložený stav hry pre ${gameIdFromClient} vo Firestore. Inicializujem nový.`);
                        gameInstance.gameState = generateInitialGameState();
                        gameInstance.isGameStarted = true;
                        await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                        console.log(`Nový stav hry ${gameIdFromClient} inicializovaný a uložený do Firestore.`);
                    }

                    const chatMessagesCollectionRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('chatMessages');
                    const q = chatMessagesCollectionRef.where('gameId', '==', gameIdFromClient).orderBy('timestamp');
                    const querySnapshot = await q.get();
                    const chatHistory = [];
                    querySnapshot.forEach((doc) => {
                        chatHistory.push(doc.data());
                    });
                    socket.emit('chatHistory', chatHistory);
                    console.log(`Server: História chatu pre hru ${gameIdFromClient} načítaná z Firestore (${chatHistory.length} správ) a odoslaná klientovi.`);
                } catch (e) {
                    console.error(`Chyba pri načítaní/inicializácii stavu hry alebo chatu ${gameIdFromClient} z Firestore:`, e);
                    if (!gameInstance.gameState) {
                        gameInstance.gameState = generateInitialGameState();
                        console.log("Fallback: Inicializovaný nový stav hry kvôli chybe Firestore.");
                    }
                }
            } else {
                if (!gameInstance.gameState) {
                    gameInstance.gameState = generateInitialGameState();
                    console.log("Fallback: Inicializovaný nový stav hry (bez Firestore) pre hru:", gameIdFromClient);
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

        // Klient posiela akciu (ťah, výmena, pass)
        socket.on('playerAction', async (action) => {
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
                        if (dbAdmin) {
                            try {
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
                case 'initializeGame':
                    if (!gameInstance.gameState) {
                        gameInstance.gameState = generateInitialGameState();
                        gameInstance.isGameStarted = true;
                        console.log(`Herný stav pre hru ${gameInstance.gameId} inicializovaný serverom na žiadosť klienta.`);
                        if (dbAdmin) {
                            try {
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

                    if (dbAdmin) {
                        try {
                            const chatMessagesCollectionRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('chatMessages');
                            await chatMessagesCollectionRef.add(fullMessage);
                            console.log(`Server: Ukladám chat správu pre hru ${gameInstance.gameId} do Firestore.`);
                        } catch (e) {
                            console.error(`Chyba pri ukladaní chatovej správy pre hru ${gameInstance.gameId} do Firestore:`, e);
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
                            if (dbAdmin) {
                                try {
                                    const gameDocRef = dbAdmin.collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('gameStates').doc(gameInstance.gameId);
                                    await gameDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                                    console.log(`Stav hry ${gameInstance.gameId} uložený do Firestore po priradení žolíka.`);
                                } catch (e) {
                                    console.error(`Chyba pri ukladaní stavu hry ${gameInstance.gameId} do Firestore po priradení žolíka:`, e);
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
