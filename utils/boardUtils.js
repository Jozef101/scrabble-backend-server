// src/utils/boardUtils.js

// Definovanie typov bonusov
export const BONUS_TYPES = {
  DOUBLE_LETTER: 'DL', // Dvojnásobná hodnota písmena
  TRIPLE_LETTER: 'TL', // Trojnásobná hodnota písmena
  DOUBLE_WORD: 'DW',   // Dvojnásobná hodnota slova
  TRIPLE_WORD: 'TW',   // Trojnásobná hodnota slova
  START_SQUARE: 'SS',  // Stredové políčko (zvyčajne 2x slovo v origináli, my si ho len označíme)
};

// Mapa bonusových políčok podľa súradníc [riadok, stĺpec]
// Toto je štandardné rozloženie Scrabble dosky.
export const bonusSquares = {
  // Trojnásobok hodnoty slova (červené)
  '0,0': BONUS_TYPES.TRIPLE_WORD,
  '0,7': BONUS_TYPES.TRIPLE_WORD,
  '0,14': BONUS_TYPES.TRIPLE_WORD,
  '7,0': BONUS_TYPES.TRIPLE_WORD,
  '7,14': BONUS_TYPES.TRIPLE_WORD,
  '14,0': BONUS_TYPES.TRIPLE_WORD,
  '14,7': BONUS_TYPES.TRIPLE_WORD,
  '14,14': BONUS_TYPES.TRIPLE_WORD,

  // Dvojnásobok hodnoty slova (ružové)
  '1,1': BONUS_TYPES.DOUBLE_WORD,
  '2,2': BONUS_TYPES.DOUBLE_WORD,
  '3,3': BONUS_TYPES.DOUBLE_WORD,
  '4,4': BONUS_TYPES.DOUBLE_WORD,
  '7,7': BONUS_TYPES.START_SQUARE, // Stredové políčko
  '1,13': BONUS_TYPES.DOUBLE_WORD,
  '2,12': BONUS_TYPES.DOUBLE_WORD,
  '3,11': BONUS_TYPES.DOUBLE_WORD,
  '4,10': BONUS_TYPES.DOUBLE_WORD,
  '10,4': BONUS_TYPES.DOUBLE_WORD,
  '11,3': BONUS_TYPES.DOUBLE_WORD,
  '12,2': BONUS_TYPES.DOUBLE_WORD,
  '13,1': BONUS_TYPES.DOUBLE_WORD,
  '10,10': BONUS_TYPES.DOUBLE_WORD,
  '11,11': BONUS_TYPES.DOUBLE_WORD,
  '12,12': BONUS_TYPES.DOUBLE_WORD,
  '13,13': BONUS_TYPES.DOUBLE_WORD,
  
  // Dvojnásobok hodnoty písmena (svetlomodré)
  '0,3': BONUS_TYPES.DOUBLE_LETTER,
  '0,11': BONUS_TYPES.DOUBLE_LETTER,
  '2,6': BONUS_TYPES.DOUBLE_LETTER,
  '2,8': BONUS_TYPES.DOUBLE_LETTER,
  '3,0': BONUS_TYPES.DOUBLE_LETTER,
  '3,7': BONUS_TYPES.DOUBLE_LETTER,
  '3,14': BONUS_TYPES.DOUBLE_LETTER,
  '6,2': BONUS_TYPES.DOUBLE_LETTER,
  '6,6': BONUS_TYPES.DOUBLE_LETTER,
  '6,8': BONUS_TYPES.DOUBLE_LETTER,
  '6,12': BONUS_TYPES.DOUBLE_LETTER,
  '7,3': BONUS_TYPES.DOUBLE_LETTER,
  '7,11': BONUS_TYPES.DOUBLE_LETTER,
  '8,2': BONUS_TYPES.DOUBLE_LETTER,
  '8,6': BONUS_TYPES.DOUBLE_LETTER,
  '8,8': BONUS_TYPES.DOUBLE_LETTER,
  '8,12': BONUS_TYPES.DOUBLE_LETTER,
  '11,0': BONUS_TYPES.DOUBLE_LETTER,
  '11,7': BONUS_TYPES.DOUBLE_LETTER,
  '11,14': BONUS_TYPES.DOUBLE_LETTER,
  '12,6': BONUS_TYPES.DOUBLE_LETTER,
  '12,8': BONUS_TYPES.DOUBLE_LETTER,
  '14,3': BONUS_TYPES.DOUBLE_LETTER,
  '14,11': BONUS_TYPES.DOUBLE_LETTER,
  
  // Trojnásobok hodnoty písmena (tmavomodré)
  '1,5': BONUS_TYPES.TRIPLE_LETTER,
  '1,9': BONUS_TYPES.TRIPLE_LETTER,
  '5,1': BONUS_TYPES.TRIPLE_LETTER,
  '5,5': BONUS_TYPES.TRIPLE_LETTER,
  '5,9': BONUS_TYPES.TRIPLE_LETTER,
  '5,13': BONUS_TYPES.TRIPLE_LETTER,
  '9,1': BONUS_TYPES.TRIPLE_LETTER,
  '9,5': BONUS_TYPES.TRIPLE_LETTER,
  '9,9': BONUS_TYPES.TRIPLE_LETTER,
  '9,13': BONUS_TYPES.TRIPLE_LETTER,
  '13,5': BONUS_TYPES.TRIPLE_LETTER,
  '13,9': BONUS_TYPES.TRIPLE_LETTER,
};

// Funkcia na získanie typu bonusu pre dané súradnice
export const getBonusType = (x, y) => {
  return bonusSquares[`${x},${y}`] || null;
};