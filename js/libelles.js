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
};

export function libelle(valeur) {
  return LIBELLES[valeur] || String(valeur).replace(/_/g, ' ');
}
