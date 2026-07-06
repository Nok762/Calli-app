// db.js — wrapper IndexedDB minimaliste, promisifié.
//
// IndexedDB expose une API asynchrone à base d'événements (onsuccess/onerror) ;
// on enveloppe chaque requête dans une Promise pour pouvoir écrire tout le
// reste de l'app en async/await, sans dépendance externe.

const DB_NOM = 'callisthenie-db';
const DB_VERSION = 1;

let dbInstance = null;

export function ouvrirDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOM, DB_VERSION);

    // onupgradeneeded ne se déclenche qu'à la création de la base ou quand
    // DB_VERSION augmente : c'est le SEUL endroit où l'on peut créer des stores.
    req.onupgradeneeded = () => {
      const db = req.result;
      const stores = [
        ['exercices', 'id'],      // copie du seed (la source de vérité reste le JSON)
        ['etat_skills', 'skill'], // progression utilisateur par skill
        ['sessions', 'id'],       // séances loggées
        ['pr', 'exerciceId'],     // records matérialisés (recalculables depuis sessions)
        ['poids', 'date'],        // log de poids de corps
        ['programmes', 'id'],     // templates de séances (phase 2)
        ['reglages', 'cle'],      // clé-valeur : version du seed, durée de repos, brouillon…
      ];
      for (const [nom, keyPath] of stores) {
        if (!db.objectStoreNames.contains(nom)) db.createObjectStore(nom, { keyPath });
      }
    };

    req.onsuccess = () => { dbInstance = req.result; resolve(dbInstance); };
    req.onerror = () => reject(req.error);
  });
}

// Exécute une action sur un store dans une transaction, et promisifie le résultat.
async function requete(store, mode, action) {
  const db = await ouvrirDB();
  return new Promise((resolve, reject) => {
    const r = action(db.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const dbGet = (store, cle) => requete(store, 'readonly', (s) => s.get(cle));
export const dbGetAll = (store) => requete(store, 'readonly', (s) => s.getAll());
export const dbPut = (store, valeur) => requete(store, 'readwrite', (s) => s.put(valeur));
export const dbSupprimer = (store, cle) => requete(store, 'readwrite', (s) => s.delete(cle));
export const dbVider = (store) => requete(store, 'readwrite', (s) => s.clear());

// Raccourcis pour le store clé-valeur « reglages ».
export async function getReglage(cle, defaut = null) {
  const r = await dbGet('reglages', cle);
  return r?.valeur ?? defaut;
}
export const setReglage = (cle, valeur) => dbPut('reglages', { cle, valeur });
