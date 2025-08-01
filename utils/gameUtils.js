// utils/gameUtils.js
import { LETTER_DISTRIBUTION, LETTER_VALUES } from '../config/constants.js';

/**
 * Vytvorí zamiešané vrecúško s písmenami podľa distribúcie.
 * @returns {Array<object>} Zoznam objektov písmen (s ID, písmenom a hodnotou).
 */
export function createLetterBag() {
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
export function drawLetters(currentBag, numToDraw) {
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
