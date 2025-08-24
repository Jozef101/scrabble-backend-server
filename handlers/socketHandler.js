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

/**
 * Aplikuje presun písmena na daný stav hry.
 * Toto je server-side verzia logiky, ktorá bola predtým na klientovi.
 * @param {object} gameState Aktuálny stav hry.
 * @param {object} payload Dáta z akcie { letterData, source, target }.
 * @param {number} playerIndex Index hráča, ktorý akciu vykonal.
 * @returns {object} Nový, upravený stav hry.
 */
function applyMoveLetter(gameState, payload, playerIndex) {
    const { letterData, source, target } = payload;

    let newPlayerRacks = gameState.playerRacks.map(rack => rack ? [...rack] : null);
    let newBoard = gameState.board.map(row => [...row]);
    let newExchangeZoneLetters = [...gameState.exchangeZoneLetters];

    // Špeciálny prípad: presun v rámci stojana
    if (source.type === 'rack' && target.type === 'rack') {
        const fromIndex = source.index;
        const toIndex = target.index;

        if (newPlayerRacks[playerIndex][toIndex] === null) {
            newPlayerRacks[playerIndex][toIndex] = newPlayerRacks[playerIndex][fromIndex];
            newPlayerRacks[playerIndex][fromIndex] = null;
        } else {
            const [movedLetter] = newPlayerRacks[playerIndex].splice(fromIndex, 1);
            newPlayerRacks[playerIndex].splice(toIndex, 0, movedLetter);
        }
        return { ...gameState, playerRacks: newPlayerRacks };
    }

    // Nájdenie a odstránenie písmena zo zdroja
    let letterToMove = null;
    if (source.type === 'board') {
        letterToMove = { ...newBoard[source.x][source.y] };
        newBoard[source.x][source.y] = null;
        if (letterToMove.letter === '') letterToMove.assignedLetter = null;
    } else if (source.type === 'rack') {
        letterToMove = { ...letterData };
        newPlayerRacks[playerIndex][source.index] = null;
    } else if (source.type === 'exchangeZone') {
        const index = newExchangeZoneLetters.findIndex(l => l.id === letterData.id);
        if (index !== -1) {
            [letterToMove] = newExchangeZoneLetters.splice(index, 1);
            if (letterToMove.letter === '') letterToMove.assignedLetter = null;
        }
    }

    if (!letterToMove) return gameState; // Ak sa písmeno nenašlo, vrátime pôvodný stav

    // Umiestnenie písmena na cieľ
     if (target.type === 'rack') {
        const targetRack = newPlayerRacks[playerIndex];
        if (targetRack) {
            // PRIORITA 1: Umiestniť na konkrétny voľný slot, kam hráč ťahal.
            if (target.index !== undefined && targetRack[target.index] === null) {
                targetRack[target.index] = letterToMove;
            }
            // PRIORITA 2: Vrátiť na pôvodné miesto (pre pravé kliknutie).
            else if (letterToMove.originalRackIndex !== undefined && targetRack[letterToMove.originalRackIndex] === null) {
                targetRack[letterToMove.originalRackIndex] = letterToMove;
            }
            // PRIORITA 3: Ak všetko ostatné zlyhá, nájsť prvé voľné miesto.
            else {
                const firstEmptyIndex = targetRack.findIndex(l => l === null);
                if (firstEmptyIndex !== -1) {
                    targetRack[firstEmptyIndex] = letterToMove;
                }
            }
        }
    } else if (target.type === 'board') {
        newBoard[target.x][target.y] = { ...letterToMove, originalRackIndex: letterData.originalRackIndex };
    } else if (target.type === 'exchangeZone') {
        newExchangeZoneLetters.push(letterToMove);
    }
    
    // Vypočítame pomocné stavy, podobne ako na klientovi
    const placedLettersCount = newBoard.flat().filter(tile => tile !== null).length - gameState.boardAtStartOfTurn.flat().filter(tile => tile !== null).length;

    return {
        ...gameState,
        playerRacks: newPlayerRacks,
        board: newBoard,
        exchangeZoneLetters: newExchangeZoneLetters,
        hasPlacedOnBoardThisTurn: placedLettersCount > 0,
        hasMovedToExchangeZoneThisTurn: newExchangeZoneLetters.length > 0,
    };
}

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

            if (dbAdmin) {
                try {
                    const gameDocRef = dbAdmin.collection('scrabbleGames').doc(gameIdFromClient);
                    const gameDocSnap = await gameDocRef.get();

                    if (gameDocSnap.exists) {
                        const gameData = gameDocSnap.data();
                        if (gameData.players && Array.isArray(gameData.players)) {
                            // Prekopíruj hráčov z DB do našej in-memory inštancie
                            gameData.players.forEach(playerFromDb => {
                                if (playerFromDb && playerFromDb.playerIndex !== undefined) {
                                    // Uložíme základné info, socketId sa doplní, keď sa hráč pripojí
                                    gameInstance.players[playerFromDb.playerIndex] = {
                                        userId: playerFromDb.id,
                                        nickname: playerFromDb.nickname,
                                        playerIndex: playerFromDb.playerIndex,
                                        socketId: null // Dôležité: socketId zatiaľ nie je známe
                                    };
                                }
                            });
                            console.log(`Hráči inicializovaní z Firestore pre hru ${gameIdFromClient}:`, gameInstance.players.map(p => p?.userId));
                        }
                    }
                } catch (e) {
                    console.error(`Chyba pri inicializácii hráčov z Firestore pre hru ${gameIdFromClient}:`, e);
                }
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
           
            if (!gameInstance.players || gameInstance.players.length === 0) {
                gameInstance.players = [null, null];
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
                if (gameInstance.players[0] === null) {
                    playerIndex = 0;
                    gameInstance.players[0] = { userId: userId, playerIndex: 0, socketId: socket.id, nickname: playerNickname, elo: playerElo };
                    console.log(`Klient ${socket.id} (User: ${userId}) sa pripojil k hre ${gameIdFromClient} ako Hráč 1.`);
                } else if (gameInstance.players[1] === null) {
                    playerIndex = 1;
                    gameInstance.players[1] = { userId: userId, playerIndex: 1, socketId: socket.id, nickname: playerNickname, elo: playerElo };
                    console.log(`Klient ${socket.id} (User: ${userId}) sa pripojil k hre ${gameIdFromClient} ako Hráč 2.`);
                } else {
                    // OBA SLOTY SÚ PLNÉ - POUŽÍVATEĽ SA PRIPÁJA AKO DIVÁK
                    socket.role = 'spectator';
                    playerIndex = null; // Divák nemá index hráča
                    console.log(`Klient ${socket.id} (User: ${userId}) sa pripojil k plnej hre ${gameIdFromClient} ako DIVÁK.`);
                    // Nevysielame 'gameError', pretože je to v poriadku. Kód pokračuje ďalej,
                    // aby aj divák dostal aktuálny stav hry.
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
                    const gameDocRef = dbAdmin.collection('scrabbleGames').doc(gameIdFromClient);
                    const gameDocSnap = await gameDocRef.get();
                    const gameData = gameDocSnap.data();

                    // Načítaj aktuálny progress z hlavného dokumentu
                    const progressFromDB = gameData?.progress ?? 0;

                    // Skontroluj, či hlavný dokument hry obsahuje aj skóre. Ak nie, pridaj ich
                    if (!gameData || !gameData.scores || gameData.scores.length === 0) {
                        await gameDocRef.set({ scores: [0, 0] }, { merge: true });
                    }
                    
                    // Načítaj stav hry z podkolekcie
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

                    // Získaj stav progresu priamo z dát.
                    // const actualProgress = countTilesOnBoard(gameInstance.gameState.board);

                    // Uložíme aktuálny progress do hlavného dokumentu po pripojení hráča
                    // await gameDocRef.update({ progress: actualProgress }, { merge: true });

                    // Odoslanie stavu hry klientovi
                    const playerNicknamesMap = {};
                    gameInstance.players.forEach(p => {
                        if (p) {
                            playerNicknamesMap[p.playerIndex] = p.nickname || `Hráč ${p.playerIndex + 1}`;
                        }
                    });
                    gameInstance.gameState.playerNicknames = playerNicknamesMap;
                    gameInstance.gameState.players = gameInstance.players;
                    
                    io.to(gameInstance.gameId).emit('gameStateUpdate', gameInstance.gameState);
                    
                    // Načítanie a odoslanie chatovej histórie
                    try {
                        const chatHistoryCollectionRef = dbAdmin.collection('scrabbleGames').doc(gameIdFromClient).collection('chatMessages');
                        const querySnapshot = await chatHistoryCollectionRef.orderBy('timestamp').get();
                        
                        const chatHistory = [];
                        querySnapshot.forEach(doc => {
                            chatHistory.push(doc.data());
                        });
                        
                        // Uloženie do pamäte servera pre rýchly prístup
                        gameInstance.chatMessages = chatHistory;

                        // Odoslanie histórie chatu iba TOMUTO klientovi, ktorý sa práve pripojil
                        socket.emit('chatHistory', chatHistory);
                        console.log(`Odoslaná história chatu pre hru ${gameIdFromClient} klientovi ${socket.id}. Správ: ${chatHistory.length}`);
                    } catch (e) {
                        console.error(`Chyba pri načítavaní chatovej histórie pre hru ${gameIdFromClient} z Firestore:`, e);
                    }

                    // Pošleme aj informáciu o progres bare do lobby
                    const gameDetails = {
                        id: gameIdFromClient,
                        currentPlayerIndex: gameInstance.gameState.currentPlayerIndex,
                        // progress: actualProgress, // Posielame skutočný progress
                        scores: gameInstance.gameState.playerScores || [0, 0] // Ak skóre chýba, inicializujeme na [0, 0]
                    };

                    // Toto by mal zachytiť front-end komponent, ktorý zobrazuje lobby
                    io.to(gameIdFromClient).emit('gameProgressUpdate', gameDetails);

                    // ... (zvyšok tvojho kódu)

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
                            // Vytvoríme pole hráčov s ich aktuálnym ELO, ktoré sa uloží do dokumentu hry
                            const playersWithElo = gameInstance.players
                                .filter(p => p !== null)
                                .map(p => ({
                                    id: p.userId,
                                    nickname: p.nickname,
                                    playerIndex: p.playerIndex,
                                    elo: p.elo // Pridáme ELO hráča v momente štartu
                                }));

                            const gameDocRef = dbAdmin.collection('scrabbleGames').doc(gameIdFromClient);
                            await gameDocRef.set({
                                status: 'in-progress',
                                currentPlayerIndex: gameInstance.gameState?.currentPlayerIndex ?? 0,
                                players: playersWithElo // Uložíme hráčov aj s ich "zmrazeným" ELO
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
                case 'moveLetter':
                    if (gameInstance.gameState) {
                        // Aplikujeme zmenu pomocou našej novej funkcie
                        const newGameState = applyMoveLetter(gameInstance.gameState, action.payload, socket.playerIndex);
                        gameInstance.gameState = newGameState;

                        // Uložíme nový stav do DB a rozošleme všetkým
                        if (dbAdmin) {
                            try {
                                const gameStateDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId).collection('gameStates').doc('state');
                                await gameStateDocRef.set({ gameState: JSON.stringify(gameInstance.gameState) }, { merge: true });
                            } catch (e) {
                                console.error(`Chyba pri ukladaní stavu hry ${gameInstance.gameId} do Firestore z akcie moveLetter:`, e);
                            }
                        }
                        io.to(gameInstance.gameId).emit('moveLetter', {
                            ...action.payload,
                            playerIndex: socket.playerIndex
                        });
                    }
                    break;
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
                                        playerIndex: p.playerIndex,
                                        elo: p.elo,
                                        score: gameInstance.gameState.playerScores ? gameInstance.gameState.playerScores[p.playerIndex] : 0
                                    })),
                                    scores: gameInstance.gameState.playerScores || [0, 0]
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
                case 'surrender':
                    if (gameInstance.gameState && !gameInstance.gameState.isGameOver) {
                        const { surrenderingPlayerIndex } = action.payload;
                        const loserIndex = surrenderingPlayerIndex;
                        const winnerIndex = loserIndex === 0 ? 1 : 0;

                        const loser = gameInstance.players.find(p => p.playerIndex === loserIndex);
                        const winner = gameInstance.players.find(p => p.playerIndex === winnerIndex);

                        if (!loser || !winner) {
                            console.error(`Chyba pri vzdávaní hry ${gameInstance.gameId}: Nenašiel sa víťaz alebo porazený.`);
                            return;
                        }

                        // Aktualizujeme ELO hodnotenia
                        await updateEloRatings(winner.userId, loser.userId);

                        // Pripravíme finálny stav hry
                        const finalGameState = {
                            ...gameInstance.gameState,
                            isGameOver: true,
                            winnerIndex: winnerIndex, // Uložíme index víťaza
                            // Môžeme pridať aj dôvod ukončenia pre zobrazenie na UI
                            gameOverReason: `${loser.nickname} sa vzdal(a).` 
                        };
                        gameInstance.gameState = finalGameState;

                        // Aktualizujeme hlavný dokument hry vo Firestore
                        if (dbAdmin) {
                            try {
                                const gameDocRef = dbAdmin.collection('scrabbleGames').doc(gameInstance.gameId);
                                await gameDocRef.set({
                                    status: 'finished',
                                    endedAt: new Date(),
                                    winnerId: winner.userId,
                                    loserId: loser.userId,
                                    gameOverReason: 'surrender'
                                }, { merge: true });
                            } catch (e) {
                                console.error(`Chyba pri aktualizácii stavu hry ${gameInstance.gameId} na 'finished' po vzdaní sa:`, e);
                            }
                        }

                        // Odošleme finálny stav hry všetkým v miestnosti
                        io.to(gameInstance.gameId).emit('gameStateUpdate', finalGameState);
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
                        socket.emit('messagesMarkedAsSeen', { gameId, playerIndex });
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
                    io.to(gameId).emit('chatHistory', game.chatMessages);
                    console.log(`Správy pre hru ${gameId} boli označené ako prečítané pre hráča ${playerIndex}. Odoslaná aktualizácia chatu všetkým klientom.`);
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