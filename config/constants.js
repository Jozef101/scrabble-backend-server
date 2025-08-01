// config/constants.js
export const PORT = process.env.PORT || 4000;
export const allowedOrigins = ['http://localhost:3000', 'https://skrebl.vercel.app'];

export const BOARD_SIZE = 15;
export const RACK_SIZE = 7;
export const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 60 minút

export const LETTER_VALUES = {
    'A': 1, 'Á': 4, 'Ä': 10, 'B': 4, 'C': 4, 'Č': 5, 'D': 2, 'Ď': 8, 'E': 1, 'É': 7,
    'F': 8, 'G': 8, 'H': 4, 'I': 1, 'Í': 5, 'J': 3, 'K': 2, 'L': 2, 'Ľ': 7, 'Ĺ': 10,
    'M': 2, 'N': 1, 'Ň': 8, 'O': 1, 'Ô': 8, 'Ó': 10, 'P': 2, 'Q': 10, 'R': 1, 'Ŕ': 10,
    'S': 1, 'Š': 5, 'T': 1, 'Ť': 7, 'U': 3, 'Ú': 7, 'V': 1, 'W': 5, 'X': 10, 'Y': 4, 'Ý': 5,
    'Z': 4, 'Ž': 5, '': 0 // Žolík má hodnotu 0
};

export const LETTER_DISTRIBUTION = [
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
