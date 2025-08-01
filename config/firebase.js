// config/firebase.js
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    } else {
        console.warn("Premenná prostredia FIREBASE_SERVICE_ACCOUNT_KEY nebola nájdená.");
    }
} catch (e) {
    console.error("Chyba pri parsovaní FIREBASE_SERVICE_ACCOUNT_KEY:", e);
    serviceAccount = null;
}

let dbAdmin;
if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    dbAdmin = getFirestore();
    console.log("Firebase Admin SDK inicializované.");
} else {
    console.error("Firebase Admin SDK nebolo inicializované.");
}

export { dbAdmin };
