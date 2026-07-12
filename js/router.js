// router.js — mini-routeur par hash : #/route/param1/param2
// Le hash permet un déploiement statique sans configuration serveur.

import { vueAccueil } from './ui/vue-dashboard.js';
import { vueSkills } from './ui/vue-skills.js';
import { vueSeance } from './ui/vue-seance.js';
import { vueHistorique } from './ui/vue-historique.js';
import { vueExercices } from './ui/vue-exercices.js';
import { vueProgrammes } from './ui/vue-programmes.js';
import { vueReglages } from './ui/vue-reglages.js';

const routes = {
  accueil: vueAccueil,
  skills: vueSkills,
  seance: vueSeance,
  historique: vueHistorique,
  exercices: vueExercices,
  programmes: vueProgrammes,
  reglages: vueReglages,
};

export function demarrerRouteur() {
  window.addEventListener('hashchange', rendre);
  rendre();
}

let timerEntree = null;

async function rendre() {
  const segments = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
    .split('/')
    .filter(Boolean);
  const nom = routes[segments[0]] ? segments[0] : 'accueil';

  document.querySelectorAll('#nav a').forEach((a) =>
    a.classList.toggle('actif', a.dataset.route === nom));

  // Orchestration d'entrée (« la Ligne se dessine ») : la classe ne vit que le
  // temps de l'animation, pour que les re-rendus INTERNES d'une vue (ajout d'un
  // set, coche d'un chip…) ne rejouent pas l'entrée.
  const vue = document.getElementById('vue');
  clearTimeout(timerEntree);
  vue.classList.remove('vue-entree');
  void vue.offsetWidth; // force le reflow : les animations peuvent rejouer
  vue.classList.add('vue-entree');
  timerEntree = setTimeout(() => vue.classList.remove('vue-entree'), 700);

  await routes[nom](vue, segments.slice(1));
  window.scrollTo(0, 0);
}
