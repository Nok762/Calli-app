// app.js — point d'entrée : ouvre la base, importe le seed, dérive les skills,
// démarre le routeur et enregistre le service worker.

import { ouvrirDB, getReglage } from './db.js';
import { importerSeed, chargerExercices, chargerConfigSkills } from './seed.js';
import { deriverSkills } from './skills.js';
import { demarrerRouteur } from './router.js';

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

  demarrerRouteur();

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
