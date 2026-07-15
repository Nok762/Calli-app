// app.js — point d'entrée : ouvre la base, importe le seed, dérive les skills,
// démarre le routeur et enregistre le service worker.

import { ouvrirDB, getReglage, dbGetAll, dbPut } from './db.js';
import { importerSeed, chargerExercices, chargerConfigSkills } from './seed.js';
import { deriverSkills } from './skills.js';
import { demarrerRouteur } from './router.js';
import { setSonActif } from './ui/composants.js';

// Contexte global en lecture, partagé par toutes les vues.
export const ctx = {
  exercices: new Map(), // id -> exercice (copie du seed)
  skills: [],           // arbres de progression dérivés
  config: null,         // data/skills.config.json (critères, noms, ordre)
  meta: null,           // meta du seed (énumérations pour les formulaires)
};

async function boot() {
  await ouvrirDB();
  await importerSeed();
  ctx.exercices = await chargerExercices();
  ctx.config = await chargerConfigSkills();
  ctx.meta = await getReglage('seedMeta');
  ctx.skills = deriverSkills(ctx.exercices, ctx.config);
  setSonActif(await getReglage('son', true));

  // Migration douce : les programmes générés avant la refonte « Obsidienne »
  // portaient un préfixe « ✨ » dans leur nom. On le retire des données une
  // fois pour toutes (best-effort, ne bloque jamais le boot).
  try {
    for (const prog of await dbGetAll('programmes')) {
      if (prog.nom?.startsWith('✨ ')) {
        prog.nom = prog.nom.slice(2);
        await dbPut('programmes', prog);
      }
    }
  } catch { /* base plus ancienne que le store : rien à migrer */ }

  demarrerRouteur();

  // Stockage persistant : demande au navigateur de ne pas purger l'IndexedDB
  // (sans ça, iOS/Chrome peuvent évincer les données sous pression disque).
  // Best-effort : l'état est visible dans Réglages.
  navigator.storage?.persist?.().catch(() => {});

  // Service worker : rend l'app installable et 100 % hors ligne.
  // (Échoue silencieusement en file:// ou navigateur sans support.)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot().catch((err) => {
  document.getElementById('vue').innerHTML =
    `<div class="carte erreur">Erreur au démarrage : ${err.message}</div>`;
});
