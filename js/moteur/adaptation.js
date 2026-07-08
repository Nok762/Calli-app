// moteur/adaptation.js — le moteur d'adaptation.
//
// Tout est en fonctions pures (aucune dépendance UI ni IndexedDB) : elles
// reçoivent les exercices, les contraintes du jour et l'historique, et
// retournent des structures que les vues affichent. Chaque suggestion est
// EXPLICABLE (elle porte sa raison en texte) et OVERRIDABLE (l'UI ne fait
// que proposer, l'utilisateur décide).

import { libelle } from '../libelles.js';

// Seuils du moteur, regroupés ici pour être faciles à retoucher après usage réel.
export const SEUILS = {
  SEANCES_STABLES: 2,      // séances avec critère atteint → suggérer de valider l'étape
  RPE_DELOAD: 9,           // RPE moyen à partir duquel une séance compte comme « difficile »
  RPE_FRAIS: 7,            // RPE moyen en dessous duquel les séances récentes sont « confortables »
  SEANCES_DELOAD: 2,       // apparitions difficiles consécutives → suggérer une régression
  DECALAGE_DIFFICULTE: 2,  // décalage de difficulté cible pour « trop dur » / « trop facile »
  MAX_ALTERNATIVES: 3,     // nombre d'alternatives proposées
  REPOS_COURT_H: 18,       // moins de repos que ça depuis la dernière séance → récup incomplète
};

// --- Faisabilité ---------------------------------------------------------------

// Un exercice est faisable côté matériel si AU MOINS UNE de ses options
// d'équipement est disponible. Dans le seed, `equipement` liste les options
// possibles (ex. dips : ["parallettes","barre"]) ; "aucun" signifie
// « réalisable sans rien » et est donc toujours disponible.
export function compatibleMateriel(ex, materiel = []) {
  return ex.equipement.includes('aucun') || ex.equipement.some((e) => materiel.includes(e));
}

// Zones à risque de l'exercice qui croisent les douleurs déclarées du jour.
export function zonesEnConflit(ex, douleurs = []) {
  return ex.zones_a_risque.filter((z) => douleurs.includes(z));
}

// Vérifie un exercice contre les contraintes du jour.
// Retourne { ok, raisons } — les raisons sont des textes affichables tels quels.
export function verifierExercice(ex, contraintes) {
  const raisons = [];
  if (contraintes && !compatibleMateriel(ex, contraintes.materiel)) {
    raisons.push('matériel manquant');
  }
  const zones = contraintes ? zonesEnConflit(ex, contraintes.douleurs) : [];
  if (zones.length) raisons.push('zone signalée : ' + zones.join(', '));
  return { ok: raisons.length === 0, raisons };
}

// --- Substitution (cœur du moteur) ------------------------------------------------

// Texte expliquant POURQUOI on remplace (affiché tel quel dans l'UI et tracé
// dans la session) : « pas de barre », « poignets signalés », « trop dur »…
export function texteCause(cause, exercice, contraintes) {
  if (cause === 'trop_dur') return 'trop dur';
  if (cause === 'trop_facile') return 'trop facile';
  const morceaux = [];
  if (!compatibleMateriel(exercice, contraintes?.materiel || [])) {
    const options = exercice.equipement.filter((e) => e !== 'aucun').map(libelle);
    morceaux.push('pas de ' + options.join(' ni '));
  }
  const zones = contraintes ? zonesEnConflit(exercice, contraintes.douleurs) : [];
  if (zones.length) morceaux.push(zones.map(libelle).join(' + ') + ' à ménager');
  return morceaux.join(' · ') || 'préférence du jour';
}

// Propose les meilleurs remplaçants pour un exercice, selon la cause :
// 'contrainte' (matériel/douleur), 'trop_dur' ou 'trop_facile'.
//
// Vivier par priorité : equivalence (substituts pré-validés du seed) →
// regression/progression (si la cause est la difficulté) → tout exercice de
// même pattern avec muscles primaires recouvrants.
// Filtres durs : matériel du jour compatible, aucune zone douloureuse sollicitée.
// Score : bonus du vivier + même pattern (+2) + muscles primaires communs (+1
// chacun) − 0,5 par point d'écart avec la difficulté cible.
export function proposerAlternatives(exercice, exercices, contraintes, cause = 'contrainte') {
  const cibleDiff = exercice.difficulte
    + (cause === 'trop_dur' ? -SEUILS.DECALAGE_DIFFICULTE : 0)
    + (cause === 'trop_facile' ? SEUILS.DECALAGE_DIFFICULTE : 0);

  const candidats = new Map(); // id -> { exercice, score, lien }

  const ajouter = (id, bonus, lien) => {
    const ex = exercices.get(id);
    if (!ex || ex.id === exercice.id) return;
    if (!compatibleMateriel(ex, contraintes?.materiel || [])) return;
    if (contraintes && zonesEnConflit(ex, contraintes.douleurs).length) return;

    let score = bonus - 0.5 * Math.abs(ex.difficulte - cibleDiff);
    if (ex.pattern === exercice.pattern) score += 2;
    score += ex.muscles_primaires.filter((m) => exercice.muscles_primaires.includes(m)).length;

    const existant = candidats.get(id);
    if (!existant || existant.score < score) candidats.set(id, { exercice: ex, score, lien });
  };

  for (const id of exercice.equivalence) ajouter(id, 3, 'équivalent direct');
  if (cause === 'trop_dur') for (const id of exercice.regression) ajouter(id, 2.5, 'régression');
  if (cause === 'trop_facile') for (const id of exercice.progression) ajouter(id, 2.5, 'progression');
  for (const ex of exercices.values()) {
    if (ex.pattern === exercice.pattern
        && ex.muscles_primaires.some((m) => exercice.muscles_primaires.includes(m))) {
      ajouter(ex.id, 0, 'même pattern');
    }
  }

  return [...candidats.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, SEUILS.MAX_ALTERNATIVES);
}

// --- Auto-progression / deload -------------------------------------------------------

// Regroupe, séance par séance, les sets réalisés pour un exercice donné.
function performancesParSession(sessions, exerciceId) {
  return sessions.map((s) => {
    const sets = s.entrees
      .filter((e) => e.exerciceId === exerciceId)
      .flatMap((e) => e.sets);
    return { session: s, sets };
  }).filter((p) => p.sets.length);
}

// Critère de l'étape courante atteint (sans échec) sur assez de séances
// distinctes → suggérer de valider le palier.
// `etats` : Map skillId -> état utilisateur (etapeCourante, termine…).
export function suggestionsPalier(sessions, skills, etats) {
  const out = [];
  for (const skill of skills) {
    const etat = etats.get(skill.id);
    if (etat?.termine) continue;
    const stepCourant = etat?.etapeCourante ?? skill.etapes[0].step;
    const etape = skill.etapes.find((e) => e.step === stepCourant);
    if (!etape?.critere) continue;

    const nb = performancesParSession(sessions, etape.exercice.id).filter(({ sets }) => {
      const valides = sets.filter((x) => !x.echec).map((x) => x.valeur);
      return valides.length && Math.max(...valides) >= etape.critere.valeur;
    }).length;

    if (nb >= SEUILS.SEANCES_STABLES) out.push({ skill, etape, nb });
  }
  return out;
}

// Échecs répétés ou RPE très élevé sur les dernières apparitions d'un
// exercice → suggérer sa régression (ou une baisse de volume à défaut).
export function suggestionsDeload(sessions, exercices) {
  const triees = [...sessions].sort((a, b) => b.dateDebut.localeCompare(a.dateDebut));
  const out = [];

  for (const ex of exercices.values()) {
    const apparitions = performancesParSession(triees, ex.id).slice(0, SEUILS.SEANCES_DELOAD);
    if (apparitions.length < SEUILS.SEANCES_DELOAD) continue;

    const difficiles = apparitions.map(({ sets }) => {
      const echec = sets.some((x) => x.echec);
      const rpes = sets.map((x) => x.rpe).filter(Boolean);
      const rpeMoyen = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null;
      return { echec, rpeEleve: rpeMoyen !== null && rpeMoyen >= SEUILS.RPE_DELOAD };
    });
    if (!difficiles.every((d) => d.echec || d.rpeEleve)) continue;

    const regression = ex.regression.map((r) => exercices.get(r)).find(Boolean) || null;
    out.push({
      exercice: ex,
      regression,
      motif: difficiles.some((d) => d.echec) ? 'échecs répétés' : 'RPE très élevé',
    });
  }
  return out;
}

// --- Autorégulation : « forme du jour » -------------------------------------------
//
// Évalue si l'utilisateur est frais ou fatigué pour MODULER LE VOLUME du jour,
// à partir de trois signaux (aucune intégration santé externe) :
//   1. l'énergie auto-déclarée (le signal le plus direct) ;
//   2. la tendance RPE de la dernière séance (RPE élevé = fatigue résiduelle) ;
//   3. le repos écoulé depuis la dernière séance (trop court = récup incomplète).
// Retourne { niveau: 'basse'|'normale'|'haute', score, raisons[] } — les raisons
// sont des textes affichables tels quels. La décision reste à l'utilisateur.
export function evaluerReadiness(contraintes, sessions = []) {
  const facteurs = []; // { texte, delta } — delta > 0 : frais ; < 0 : fatigué

  const e = contraintes?.energie;
  if (e === 'haute') facteurs.push({ texte: 'énergie haute', delta: 2 });
  else if (e === 'faible') facteurs.push({ texte: 'énergie faible', delta: -2 });

  const derniere = [...sessions].sort((a, b) => b.dateDebut.localeCompare(a.dateDebut))[0];
  if (derniere) {
    const rpes = derniere.entrees.flatMap((en) => en.sets.map((s) => s.rpe).filter(Boolean));
    if (rpes.length) {
      const moyen = rpes.reduce((a, b) => a + b, 0) / rpes.length;
      if (moyen >= SEUILS.RPE_DELOAD) facteurs.push({ texte: `RPE ${Math.round(moyen)} la dernière séance`, delta: -1 });
      else if (moyen <= SEUILS.RPE_FRAIS) facteurs.push({ texte: 'séances récentes confortables', delta: 1 });
    }
    const heures = (Date.now() - new Date(derniere.dateDebut)) / 3600000;
    if (heures < SEUILS.REPOS_COURT_H) facteurs.push({ texte: 'peu de repos depuis la dernière séance', delta: -1 });
  }

  const score = facteurs.reduce((t, f) => t + f.delta, 0);
  const niveau = score >= 2 ? 'haute' : score <= -2 ? 'basse' : 'normale';
  // N'afficher que les raisons cohérentes avec le verdict (pas « bonne forme
  // parce que… peu de repos »).
  const signe = niveau === 'haute' ? 1 : -1;
  const raisons = facteurs.filter((f) => Math.sign(f.delta) === signe).map((f) => f.texte);
  return { niveau, score, raisons };
}
