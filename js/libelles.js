// libelles.js — libellés d'affichage des valeurs d'énumération du seed.
// Module partagé entre l'UI et le moteur d'adaptation (qui construit des
// explications lisibles : « pas de barre → … »).

const LIBELLES = {
  aucun: 'aucun', barre: 'barre', anneaux: 'anneaux', parallettes: 'parallettes',
  elastiques: 'élastiques', surface_surelevee: 'surface surélevée',
  poignets: 'poignets', epaules: 'épaules', coudes: 'coudes',
  lombaires: 'lombaires', genoux: 'genoux',
  poussee_horizontale: 'poussée horizontale', poussee_verticale: 'poussée verticale',
  tirage_vertical: 'tirage vertical', tirage_horizontal: 'tirage horizontal',
  squat: 'squat', hinge: 'hinge',
  gainage_anti_extension: 'gainage anti-extension',
  gainage_anti_rotation: 'gainage anti-rotation',
  straight_arm: 'straight-arm',
  // Muscles (zones ciblées, filtre de la bibliothèque d'exercices).
  pectoraux: 'pectoraux', dorsaux: 'dorsaux', trapezes: 'trapèzes',
  deltoides: 'deltoïdes', deltoides_anterieurs: 'deltoïdes antérieurs',
  biceps: 'biceps', triceps: 'triceps', avant_bras: 'avant-bras',
  quadriceps: 'quadriceps', ischios: 'ischios', fessiers: 'fessiers',
  fléchisseurs_hanche: 'fléchisseurs de hanche',
  gainage: 'gainage', obliques: 'obliques',
};

export function libelle(valeur) {
  return LIBELLES[valeur] || String(valeur).replace(/_/g, ' ');
}

// Échappement HTML pour toute valeur SAISIE PAR L'UTILISATEUR injectée dans un
// template innerHTML (noms de programmes/jours) : un « " » dans un nom cassait
// l'attribut value, un « < » cassait le balisage.
const ECHAPPEMENTS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function echapper(valeur) {
  return String(valeur ?? '').replace(/[&<>"']/g, (c) => ECHAPPEMENTS[c]);
}
