// router.js — mini-routeur par hash : #/route/param1/param2
// Le hash permet un déploiement statique sans configuration serveur.

import { vueAccueil } from './ui/vue-dashboard.js';
import { vueSkills } from './ui/vue-skills.js';
import { vueSeance } from './ui/vue-seance.js';
import { vueHistorique } from './ui/vue-historique.js';
import { vueExercices } from './ui/vue-exercices.js';
import { vueProgrammes } from './ui/vue-programmes.js';

const routes = {
  accueil: vueAccueil,
  skills: vueSkills,
  seance: vueSeance,
  historique: vueHistorique,
  exercices: vueExercices,
  programmes: vueProgrammes,
};

export function demarrerRouteur() {
  window.addEventListener('hashchange', rendre);
  rendre();
}

async function rendre() {
  const segments = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
    .split('/')
    .filter(Boolean);
  const nom = routes[segments[0]] ? segments[0] : 'accueil';

  document.querySelectorAll('#nav a').forEach((a) =>
    a.classList.toggle('actif', a.dataset.route === nom));

  await routes[nom](document.getElementById('vue'), segments.slice(1));
  window.scrollTo(0, 0);
}
