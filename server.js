// server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';

// Import refaktorovaných modulov
import { dbAdmin } from './config/firebase.js';
import { PORT, allowedOrigins } from './config/constants.js';
import initializeSocket from './handlers/socketHandler.js';

// ====================================================================
// Express a Socket.IO nastavenia
// ====================================================================
const app = express();
const server = http.createServer(app);
app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST']
}));

const io = new SocketIOServer(server, {
    cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST']
    }
});

// Inicializácia Socket.IO handlera a prepojenie s ostatnými modulmi
initializeSocket(io, dbAdmin);

// ====================================================================
// Endpointy
// ====================================================================
app.get('/ping', (req, res) => {
    res.send('pong');
});

// ====================================================================
// Spustenie servera
// ====================================================================
server.listen(PORT, () => {
    console.log(`Server beží na porte ${PORT}`);
});
