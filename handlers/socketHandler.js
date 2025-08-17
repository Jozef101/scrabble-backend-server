//backend/handlers/socketHandler.js
import { games, gameTimeouts, createNewGameInstance, generateInitialGameState, updateEloRatings } from '../game/gameManager.js';
import { INACTIVITY_TIMEOUT_MS } from '../config/constants.js';
import { resetGameInstance } from '../game/gameManager.js';

// NOVÁ FUNKCIA: Počíta, koľko políčok na doske obsahuje písmeno
const countTilesOnBoard = (board) => {
    let count = 0;
    if (board && Array.isArray(board)) {
        for (const row of board) {
            for (const tile of row) {
                // Počítame len políčka, ktoré majú pridelené písmeno
                if (tile && tile.letter && tile.letter !== '') {
                    count++;
                }
            }
        }
    }
    return count;
};

export default function initializeSocket(io, dbAdmin) {
    io.on('connection', (socket) => {
        console.log(`Nový klient pripojený: ${socket.id}`);

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
                console.log(`Vytvorená nová inštancia hry v pamäti s ID: ${gameIdFromClient}`);
            }
            socket.join(gameIdFromClient);

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
                        console.log(`Prezývka a ELO pre užívateľa ${userId} neboli nájdené vo Firestore. Používam defaultné hodnoty.`);
                    }
                } catch (e) {
                    console.error(`Chyba pri načítaní prezývky a ELO pre užívateľa ${userId}:`, e);
                }
            }

            if (dbAdmin) {
                try {
                    const gamePlayersDocRef = dbAdmin.collection('scrabbleGames').doc(gameIdFromClient).collection('players').doc('data');
                    const docSnap = await gamePlayersDocRef.get();

                    if (docSnap.exists && docSnap.data() && docSnap.data().players) {
                        gameInstance.players = JSON.parse(docSnap.data().players);
                    } else {
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
                    gameInstance.players[i].elo = playerElo;
                    console.log(`Klient ${socket.id} (User: ${userId}) sa znovu pripojil k hre ${gameIdFromClient} ako Hráč ${playerIndex + 1}.`);
                    break;
                }
            }

            if (playerIndex === -1) {
                if (gameInstance.players[0] === null || (gameInstance.players[0] && gameInstance.players[0].socketId === null)) {
                    playerIndex = 0;
                    gameInstance.players[0] = { userId: userId, playerIndex: 0, socketId: socket.id, nickname: playerNickname, elo: playerElo };
                    console.log(`Klient ${socket.id} (User: ${userId}) sa pripojil k hre ${gameIdFromClient} ako Hráč 1.`);
                } else if (gameInstance.players[1] === null || (gameInstance.players[1] && gameInstance.players[1].socketId === null)) {
                    playerIndex = 1;
                    gameInstance.players[1] = { userId: userId, playerIndex: 1, socketId: socket.id, nickname: playerNickname, elo: playerElo };
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
                    const gamePlayersDocRef = dbAdmin.collection('scrabbleGames').doc(gameIdFromClient).collection('players').doc('data');
                    await gamePlayersDocRef.set({ players: JSON.stringify(gameInstance.players) }, { merge: true });
                } catch (e) {
                    console.error(`Chyba pri ukladaní stavu hráčov ${gameIdFromClient} do Firestore po pripojení:`, e);
                }
            }

            socket.emit('playerAssigned', playerIndex);

            if (dbAdmin) {
                try {
                    const gameStateDocRef = dbAdmin.collection('scrabbleGames').doc(gameIdFromClient).collection('gameStates').doc('state');
                    const docSnap = await gameStateDocRef.get();

                    if (docSnap.exists && docSnap.data() && docSnap.data().gameState) {
                        const loadedState = JSON.parse(docSnap.data().gameState);
                        gameInstance.gameState = loadedState;
                        gameInstance.isGameStarted = true;
                    } else {
                        gameInstance.gameState = generateInitialGameState();
                        gameInstance.isGameStarted = true;
                        await gameStateDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                        console.log(`Nový stav hry ${gameIdFromClient} inicializovaný a uložený do Firestore.`);
                    }

                    const chatMessagesCollectionRef = dbAdmin.collection('scrabbleGames').doc(gameIdFromClient).collection('chatMessages');
                    const q = chatMessagesCollectionRef.orderBy('timestamp');
                    const querySnapshot = await q.get();
                    const chatHistory = [];
                    querySnapshot.forEach((doc) => {
                        chatHistory.push(doc.data());
                    });
                    gameInstance.chatMessages = chatHistory;
                    socket.emit('chatHistory', chatHistory);
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
                gameInstance.gameState.players = gameInstance.players;
                
                io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                const connectedPlayersCount = gameInstance.players.filter(p => p !== null && p.socketId !== null).length;

                if (connectedPlayersCount < 2) {
                    io.to(gameInstance.gameId).emit('waitingForPlayers', 'Čaká sa na druhého hráča...');
                    console.log(`Server: Hra ${gameIdFromClient}: Čaká sa na druhého hráča. Aktuálni pripojení hráči: ${connectedPlayersCount}`);
                } else {
                    console.log(`Server: Hra ${gameIdFromClient}: Všetci hráči pripojení. Hra môže začať.`);

                    if (dbAdmin) {
                        try {
                            const gameDocRef = dbAdmin.collection('scrabbleGames').doc(gameIdFromClient);
                            await gameDocRef.set({
                                status: 'in-progress',
                                currentPlayerIndex: gameInstance.gameState.currentPlayerIndex,
                                progress: 0, // Na začiatku je progres 0
                                players: gameInstance.players
                                    .filter(p => p !== null)
                                    .map(p => ({
                                        id: p.userId,
                                        nickname: p.nickname,
                                        playerIndex: p.playerIndex
                                    }))
                            }, { merge: true });
                        } catch (e) {
                            console.error(`Chyba pri ukladaní počiatočného stavu hry ${gameIdFromClient} do Firestore po pripojení druhého hráča:`, e);
                        }
                    }

                }
            } else {
                console.error(`Server: Kritická chyba: GameState pre hru ${gameIdFromClient} je stále null po všetkých pokusoch o inicializáciu.`);
                socket.emit('gameError', 'Kritická chyba: Nepodarilo sa inicializovať stav hry.');
            }
        });

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
                action.type !== 'turnSubmitted' &&
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
                        
                        // ZMENA: Namiesto balíka počítame písmená na doske
                        const tilesOnBoardCount = countTilesOnBoard(gameInstance.gameState.board);
                        
                        // Skontrolujeme, či hra práve skončila
                        if (gameInstance.gameState && !gameInstance.gameState.isGameOver && action.payload && action.payload.isGameOver) {
                            console.log(`Hra ${gameInstance.gameId} skončila. Začínam výpočet ELO.`);
                            
                            const player1 = gameInstance.players.find(p => p.playerIndex === 0);
                            const player2 = gameInstance.players.find(p => p.playerIndex === 1);
                            const player1Score = action.payload.playerScores[0];
                            const player2Score = action.payload.playerScores[1];

                            if (player1Score > player2Score) {
                                await updateEloRatings(player1.userId, player2.userId);
                            } else if (player2Score > player1Score) {
                                await updateEloRatings(player2.userId, player1.userId);
                            } else {
                                console.log(`Hra ${gameInstance.gameId} skončila remízou. ELO skóre sa nemení.`);
                            }
                        }

                        if (dbAdmin) {
                            try {
                                const gameStateDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId).collection('gameStates').doc('state');
                                await gameStateDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });

                                // ZMENA: Uložíme počet položených písmen do hlavného dokumentu hry
                                const gameDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId);
                                await gameDocRef.update({
                                    progress: tilesOnBoardCount,
                                    currentPlayerIndex: gameInstance.gameState.currentPlayerIndex,
                                    players: gameInstance.players
                                    .filter(p => p !== null)
                                    .map(p => ({
                                        id: p.userId,
                                        nickname: p.nickname,
                                        playerIndex: p.playerIndex
                                    }))
                                });

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
                        if (dbAdmin) {
                            try {
                                const gameStateDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId).collection('gameStates').doc('state');
                                await gameStateDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                            } catch (e) {
                                console.error(`Chyba pri ukladaní inicializovaného stavu hry ${gameInstance.gameId} do Firestore:`, e);
                            }
                        }
                        io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                    }
                    break;
                case 'chatMessage':
                    const senderPlayer = gameInstance.players.find(p => p?.playerIndex === socket.playerIndex);
                    const senderNickname = senderPlayer?.nickname || `Hráč ${socket.playerIndex + 1}`;
                    const senderUserId = senderPlayer?.userId || socket.userId;

                    const fullMessage = {
                        gameId: gameInstance.gameId,
                        senderId: senderUserId,
                        senderIndex: socket.playerIndex,
                        senderNickname: senderNickname,
                        text: action.payload,
                        timestamp: Date.now(),
                        seen: {}
                    };

                    // Odosielateľ už správu videl
                    fullMessage.seen[socket.playerIndex] = true;

                    // Ostatní hráči
                    gameInstance.players
                        .filter(p => p && p.playerIndex !== socket.playerIndex)
                        .forEach(p => {
                            fullMessage.seen[p.playerIndex] = false;
                        });
                    
                    gameInstance.chatMessages = gameInstance.chatMessages || [];
                    gameInstance.chatMessages.push(fullMessage);

                    io.to(gameInstance.gameId).emit('receiveChatMessage', fullMessage);

                    if (dbAdmin) {
                        try {
                            const chatMessagesCollectionRef = dbAdmin
                                .collection('scrabbleGames')
                                .doc(gameInstance.gameId)
                                .collection('chatMessages');
                            await chatMessagesCollectionRef.add(fullMessage);
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
                                    const gameStateDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId).collection('gameStates').doc('state');
                                    await gameStateDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
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
                            gameInstance.gameState.players = gameInstance.players;
                            io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                        }
                    }
                    break;
                case 'turnSubmitted':
                    if (!dbAdmin) {
                        console.warn('Firestore Admin SDK nie je k dispozícii. Log ťahu nebude uložený.');
                        return;
                    }
                    if (!gameInstance.gameId || !action.payload) {
                        console.error('Neplatné dáta pre akciu turnSubmitted:', { gameId: gameInstance.gameId, turnDetails: action.payload });
                        return;
                    }

                    try {
                        const turnLogCollectionRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId).collection('turnLogs');
                        await turnLogCollectionRef.add(action.payload);
                    } catch (error) {
                        console.error(`CHYBA PRI UKLADANÍ LOGU ŤAHU PRE HRU ${gameInstance.gameId}:`, error);
                    }
                    if (gameInstance.gameState) {
                        io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                    }
                    break;
                case 'gameOver':
                    if (!action.payload || !action.payload.winnerId || !action.payload.loserId) {
                     console.error('Neplatné dáta pre akciu gameOver:', action.payload);
                     return;
                     }
                     console.log(`Hra ${gameInstance.gameId} skončila. Aktualizujem ELO pre víťaza ${action.payload.winnerId} a porazeného ${action.payload.loserId}.`);
                     await updateEloRatings(action.payload.winnerId, action.payload.loserId);
                     
                     if (dbAdmin) {
                        try {
                            const gameDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId);
                            await gameDocRef.set({ status: 'finished', endedAt: new Date() }, { merge: true });
                        } catch (e) {
                            console.error(`Chyba pri aktualizácii stavu hry ${gameInstance.gameId} na 'finished':`, e);
                        }
                    }
                     
                     break;
                default:
                    console.warn(`Neznámy typ akcie: ${action.type}`);
                    break;
            }
        });

        socket.on('markMessagesSeen', async ({ gameId, playerIndex }) => {
            const game = games.get(gameId);

    if (!game) {
        console.warn(`Hra s ID ${gameId} nebola nájdená pre markMessagesSeen.`);
        return;
    }

    game.chatMessages = game.chatMessages || [];
    
    if (dbAdmin) {
        try {
            const chatMessagesCollectionRef = dbAdmin.collection('scrabbleGames').doc(gameId).collection('chatMessages');

            // Nájdeme a prejdeme všetky správy, ktoré neboli prečítané
            const q = chatMessagesCollectionRef.where(`seen.${playerIndex}`, '==', false);
            const querySnapshot = await q.get();

            if (querySnapshot.empty) {
                return;
            }

            const batch = dbAdmin.batch();
            querySnapshot.forEach(doc => {
                const messageData = doc.data();
                const docRef = doc.ref;

                // Označíme správu ako prečítanú aj v pamäti servera, aby bola konzistentná
                // Hľadáme správu v pamäti na základe timestampu (alebo inej unikátnej vlastnosti)
                const msgInCache = game.chatMessages.find(msg => msg.timestamp === messageData.timestamp);
                if (msgInCache) {
                    if (typeof msgInCache.seen !== 'object' || msgInCache.seen === null) {
                        msgInCache.seen = {};
                    }
                    msgInCache.seen[playerIndex] = true;
                }
                
                // Pripravíme zmenu pre batch update v databáze
                batch.update(docRef, { [`seen.${playerIndex}`]: true });
            });
            await batch.commit();
        } catch (e) {
            console.error(`Chyba pri aktualizácii 'seen' do Firestore pre hru ${gameId}:`, e);
        }
    }

    // Odošleme potvrdenie späť klientovi
    socket.emit('messagesMarkedAsSeen', { gameId, playerIndex });
});

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
                        const gamePlayersDocRef = dbAdmin.collection('scrabbleGames').doc(gameId).collection('players').doc('data');
                        await gamePlayersDocRef.set({ players: JSON.stringify(gameInstance.players) }, { merge: true });
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
                const timeoutId = setTimeout(async () => {
                    await resetGameInstance(gameInstance);
                    games.delete(gameId);
                    gameTimeouts.delete(gameId);
                    console.log(`Hra ${gameId} bola vymazaná z pamäte servera a dát z Firestore po neaktivite.`);
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