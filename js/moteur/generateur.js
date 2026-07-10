// moteur/generateur.js — génération et évolution de programmes long terme.
//
// Les règles encodent les principes les mieux établis de la recherche en
// entraînement de force / hypertrophie :
// - FRÉQUENCE : chaque groupe musculaire ≥ 2×/semaine fait mieux que 1×
//   (méta-analyse Schoenfeld et al. 2016) → full-body pour 2-3 j/sem,
//   haut/bas pour 4 j/sem (jamais de split « 1 muscle par semaine »).
// - VOLUME : relation dose-réponse, ~10-20 séries dures/groupe/semaine
//   (Schoenfeld et al. 2017) → 3-4 séries par exercice, patterns équilibrés.
// - INTENSITÉ : s'arrêter à 1-3 reps de l'échec (RPE 7-8) est aussi efficace
//   que l'échec systématique et fatigue moins (Helms et al., Grgic et al.)
//   → cibles calibrées à ~75-80 % du record, progression seulement si RPE ≤ 8.
// - REPOS : ≥ 2 min sur les exercices exigeants améliore la performance des
//   séries suivantes (Schoenfeld et al. 2016) → repos suggéré par exercice.
// - SURCHARGE PROGRESSIVE : double progression (reps 5→12, puis exercice plus
//   dur — l'équivalent poids-du-corps de « rajouter du poids »).
// - SKILL : le travail technique (tenues) se fait frais, en début de séance,
//   loin de l'échec (~60 % du critère par série) et souvent — l'apprentissage
//   moteur répond à la fréquence, pas à l'épuisement.
// - DELOAD / REPRISE : semaine allégée toutes les 4 semaines ; après ≥ 2
//   semaines d'arrêt, reprise à charge réduite (la désadaptation commence
//   vers 2-3 semaines d'inactivité).
//
// Tout est en fonctions pures ; les seuils sont regroupés dans REGLES.

import { compatibleMateriel } from './adaptation.js';

export const REGLES = {
  REP_MIN: 5, REP_MAX: 12,      // fourchette de double progression (reps)
  HOLD_MIN: 10, HOLD_MAX: 60,   // fourchette pour les tenues « force » (s)
  RPE_CIBLE_MAX: 8,             // au-delà, pas de progression (RIR < 2)
  INC_REPS: 1, INC_HOLD: 2,     // incréments de double progression
  FRACTION_TENUE: 0.6,          // % du critère par série de tenue skill
  SETS_SKILL: 4, SETS_FORCE: 3,
  SEMAINE_DELOAD: 4, FACTEUR_DELOAD: 0.6,
  JOURS_REPRISE: 14, FACTEUR_REPRISE: 0.8,
  REPOS_COMPOSE: 150, REPOS_ACCESSOIRE: 90, // secondes
  MIN_EXOS: 3, MAX_EXOS: 7, MIN_PAR_EXO: 9, // ~9 min par exercice (séries + repos)
  TRANSITION_EXO: 45, // secondes de mise en place entre deux exercices
  SEC_PAR_REP: 3,     // durée approximative d'une répétition (tempo contrôlé)
  MARGE_TEMPS: 3,     // tolérance (min) avant de proposer de raccourcir
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Splits par fréquence. Full-body jusqu'à 3 j/sem et haut/bas à 4 j/sem :
// chaque pattern est ainsi travaillé au moins 2×/semaine.
//
// Les noms sont ÉVOCATEURS (pas « Full body A/B ») — vocabulaire d'architecture
// du corps, cohérent avec l'identité graphite/acier. La logique ne dépend jamais
// du `nom` (elle lit `patterns`), donc ces libellés sont libres et modifiables.
// Full-body → socle / charpente / aplomb ; 4 j/sem : Cime = haut poussée,
// Suspension = haut tirage, Piliers = bas dominante squat, Ancrage = bas hinge.
const SPLITS = {
  2: [
    { nom: 'Socle', patterns: ['poussee_horizontale', 'tirage_vertical', 'squat', 'gainage_anti_extension'] },
    { nom: 'Charpente', patterns: ['poussee_verticale', 'tirage_horizontal', 'hinge', 'gainage_anti_rotation'] },
  ],
  3: [
    { nom: 'Socle', patterns: ['poussee_horizontale', 'tirage_vertical', 'squat', 'gainage_anti_extension'] },
    { nom: 'Charpente', patterns: ['poussee_verticale', 'tirage_horizontal', 'hinge', 'gainage_anti_rotation'] },
    { nom: 'Aplomb', patterns: ['poussee_horizontale', 'tirage_horizontal', 'squat', 'gainage_anti_extension'] },
  ],
  4: [
    { nom: 'Cime', patterns: ['poussee_horizontale', 'tirage_vertical', 'poussee_verticale', 'gainage_anti_extension'] },
    { nom: 'Piliers', patterns: ['squat', 'hinge', 'gainage_anti_rotation', 'gainage_anti_extension'] },
    { nom: 'Suspension', patterns: ['tirage_horizontal', 'poussee_verticale', 'tirage_vertical', 'gainage_anti_rotation'] },
    { nom: 'Ancrage', patterns: ['hinge', 'squat', 'gainage_anti_extension', 'gainage_anti_rotation'] },
  ],
};

// --- Génération ------------------------------------------------------------------

// params : { objectifs: [skillId], frequence: 2|3|4, materiel: [...], dureeMin }
// donnees : { exercices: Map, skills: [dérivés], etats: Map skillId→état, prs: Map exerciceId→pr }
export function genererProgramme(params, donnees) {
  const { objectifs, frequence, materiel, dureeMin } = params;
  const { exercices, skills, etats, prs } = donnees;

  const objSkills = objectifs.map((id) => skills.find((s) => s.id === id)).filter(Boolean);
  const niveau = estimerNiveau(prs, exercices);
  const nbExos = clamp(Math.round(dureeMin / REGLES.MIN_PAR_EXO), REGLES.MIN_EXOS, REGLES.MAX_EXOS);
  const split = SPLITS[frequence] || SPLITS[3];
  const usage = new Map(); // variété : pénalise un exercice déjà utilisé un autre jour

  // Exercices « transfert direct » vers les objectifs (bonus de sélection).
  const bonusIds = new Set();
  for (const skill of objSkills) {
    for (const etape of skill.etapes) {
      bonusIds.add(etape.exercice.id);
      for (const id of [...etape.exercice.regression, ...etape.exercice.equivalence]) bonusIds.add(id);
    }
  }

  // Étape courante de chaque skill objectif : c'est elle qu'on programme.
  const etapesCourantes = objSkills.map((skill) => {
    const etat = etats.get(skill.id);
    const step = etat?.termine
      ? skill.etapes[skill.etapes.length - 1].step
      : (etat?.etapeCourante ?? skill.etapes[0].step);
    return { skill, etape: skill.etapes.find((e) => e.step === step) };
  }).filter(({ etape }) => etape);

  const jours = split.map((defJour) => {
    // À 4 j/sem, les skills de jambes (pistol, nordic) vont sur les jours bas,
    // les autres sur les jours haut. En full-body : pratique à chaque séance.
    const estJourBas = defJour.patterns.filter((p) => p === 'squat' || p === 'hinge').length >= 2;
    const skillsDuJour = frequence <= 3 ? etapesCourantes
      : etapesCourantes.filter(({ etape }) =>
          ['squat', 'hinge'].includes(etape.exercice.pattern) === estJourBas);

    // Bloc skill en premier (travail de qualité, système nerveux frais).
    const exosSkill = skillsDuJour.map(({ etape }) => ({
      exerciceId: etape.exercice.id,
      cible: cibleSkill(etape),
    }));
    const pris = new Set(exosSkill.map((e) => e.exerciceId));

    // Bloc force : un exercice par pattern, dans la limite du temps dispo.
    const budget = Math.max(2, nbExos - exosSkill.length);
    const exosForce = [];
    for (const pattern of defJour.patterns) {
      if (exosForce.length >= budget) break;
      const ex = choisirForce(pattern, { exercices, materiel, niveau, prs, bonusIds, pris, usage });
      if (!ex) continue;
      pris.add(ex.id);
      usage.set(ex.id, (usage.get(ex.id) || 0) + 1);
      exosForce.push({ exerciceId: ex.id, cible: cibleForce(ex, prs) });
    }

    return { nom: defJour.nom, exercices: [...exosSkill, ...exosForce] };
  });

  return {
    id: 'p_' + Date.now().toString(36),
    nom: '✨ ' + (objSkills.map((s) => s.nom).join(' + ') || 'Programme'),
    jours,
    genere: {
      objectifs, frequence, materiel, dureeMin,
      dateDebut: new Date().toISOString(),
      journal: [], // trace des évolutions de cibles, chacune expliquée
    },
  };
}

// Niveau force estimé depuis les PR existants (difficulté moyenne des
// exercices maîtrisés). Sans historique : difficulté 3 (débutant/intermédiaire).
function estimerNiveau(prs, exercices) {
  const diffs = [];
  for (const [id, pr] of prs) {
    const ex = exercices.get(id);
    if (!ex) continue;
    if ((pr.maxReps?.valeur ?? 0) >= 5 || (pr.maxHold?.valeur ?? 0) >= 15) diffs.push(ex.difficulte);
  }
  return diffs.length ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length) : 3;
}

// Cible d'un exercice de skill : ~60 % du critère par série, plusieurs séries,
// repos long — accumuler du temps de qualité, jamais aller à l'échec technique.
function cibleSkill(etape) {
  const critere = etape.critere;
  const estHold = etape.exercice.type === 'hold';
  const base = critere
    ? Math.max(1, Math.round(critere.valeur * REGLES.FRACTION_TENUE))
    : (estHold ? 10 : 3);
  return {
    sets: REGLES.SETS_SKILL,
    valeur: estHold ? Math.max(5, base) : base,
    repos: REGLES.REPOS_COMPOSE,
  };
}

// Cible d'un exercice de force : ~75-80 % du record (≈ RPE 7-8), sinon défaut.
function cibleForce(ex, prs) {
  const pr = prs.get(ex.id);
  const repos = ex.difficulte >= 5 ? REGLES.REPOS_COMPOSE : REGLES.REPOS_ACCESSOIRE;
  if (ex.type === 'hold') {
    const record = pr?.maxHold?.valeur;
    return {
      sets: REGLES.SETS_FORCE,
      valeur: record ? clamp(Math.round(record * 0.8), REGLES.HOLD_MIN, REGLES.HOLD_MAX) : 20,
      repos,
    };
  }
  const record = pr?.maxReps?.valeur;
  return {
    sets: REGLES.SETS_FORCE,
    valeur: record ? clamp(Math.round(record * 0.75), REGLES.REP_MIN, REGLES.REP_MAX) : 8,
    repos,
  };
}

// Meilleur exercice de force pour un pattern : difficulté proche du niveau,
// bonus s'il transfère vers un objectif ou s'il est déjà calibré par un PR,
// pénalité s'il est déjà utilisé un autre jour (variété).
function choisirForce(pattern, { exercices, materiel, niveau, prs, bonusIds, pris, usage }) {
  let meilleur = null;
  for (const ex of exercices.values()) {
    if (ex.pattern !== pattern || pris.has(ex.id)) continue;
    if (!compatibleMateriel(ex, materiel)) continue;
    let score = -Math.abs(ex.difficulte - niveau);
    if (bonusIds.has(ex.id)) score += 1.5;
    if (prs.has(ex.id)) score += 0.5;
    score -= 0.75 * (usage.get(ex.id) || 0);
    if (!meilleur || score > meilleur.score) meilleur = { ex, score };
  }
  return meilleur ? meilleur.ex : null;
}

// --- Vie du programme --------------------------------------------------------------

export function semaineCourante(programme) {
  return Math.floor((Date.now() - new Date(programme.genere.dateDebut)) / 604800000) + 1;
}

// Prochain jour de la rotation : celui qui suit le dernier jour effectué.
// Pas de calendrier fixe → une séance ratée ne « casse » rien, le plan glisse.
export function prochainJour(programme, sessions) {
  const duProgramme = sessions
    .filter((s) => s.programme?.id === programme.id && Number.isInteger(s.programme.jourIdx))
    .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
  if (!duProgramme.length) return 0;
  return (duProgramme[duProgramme.length - 1].programme.jourIdx + 1) % programme.jours.length;
}

// Modulation à appliquer à la séance du jour (les cibles du PROGRAMME restent
// intactes, seule l'instance de séance est réduite) :
// - reprise après une longue pause (prioritaire) ;
// - semaine de deload planifiée (toutes les SEMAINE_DELOAD semaines).
export function modulationSeance(programme, sessions) {
  if (sessions.length) {
    const derniere = sessions.map((s) => s.dateDebut).sort().pop();
    const joursDepuis = (Date.now() - new Date(derniere)) / 86400000;
    if (joursDepuis >= REGLES.JOURS_REPRISE) {
      return {
        facteur: REGLES.FACTEUR_REPRISE,
        raison: `reprise après ${Math.round(joursDepuis)} jours de pause`,
      };
    }
  }
  const semaine = semaineCourante(programme);
  if (semaine % REGLES.SEMAINE_DELOAD === 0) {
    return { facteur: REGLES.FACTEUR_DELOAD, raison: `semaine ${semaine} : deload planifié` };
  }
  return null;
}

// Double progression après une séance issue d'un programme généré :
// - toutes les séries à la cible, sans échec, RPE ≤ 8 → cible +1 rep / +2 s ;
// - au plafond de la fourchette → suggérer l'exercice plus dur (pas de +reps infini) ;
// - échec ou RPE moyen ≥ 9 → cible réduite (autorégulation).
// Chaque changement est journalisé avec sa raison. Retourne les changements.
export function evoluerCibles(programme, session, exercices) {
  const jour = programme.jours[session.programme?.jourIdx];
  if (!jour) return [];
  const changements = [];

  for (const exoProg of jour.exercices) {
    const entree = session.entrees.find((e) => e.exerciceId === exoProg.exerciceId);
    if (!entree || !entree.sets.length) continue;
    const ex = exercices.get(exoProg.exerciceId);
    if (!ex) continue;

    const cible = exoProg.cible;
    const rpes = entree.sets.map((s) => s.rpe).filter(Boolean);
    const rpeMax = rpes.length ? Math.max(...rpes) : null;
    const rpeMoyen = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null;
    const echec = entree.sets.some((s) => s.echec);

    // Réussite jugée contre la cible du PROGRAMME (une semaine de deload,
    // jouée à 60 %, ne déclenche donc pas de progression artificielle).
    const reussi = !echec
      && entree.sets.length >= cible.sets
      && entree.sets.every((s) => s.valeur >= cible.valeur)
      && (rpeMax === null || rpeMax <= REGLES.RPE_CIBLE_MAX);
    const enDifficulte = echec || (rpeMoyen !== null && rpeMoyen >= 9);

    const estHold = ex.type === 'hold';
    const inc = estHold ? REGLES.INC_HOLD : REGLES.INC_REPS;
    const plafond = estHold ? REGLES.HOLD_MAX : REGLES.REP_MAX;

    if (reussi && cible.valeur < plafond) {
      const avant = cible.valeur;
      cible.valeur = Math.min(plafond, cible.valeur + inc);
      changements.push(`${ex.nom} : ${cible.sets}×${avant} → ${cible.sets}×${cible.valeur} (cibles atteintes, RPE ≤ ${REGLES.RPE_CIBLE_MAX})`);
    } else if (reussi) {
      changements.push(`${ex.nom} : plafond ${plafond}${estHold ? ' s' : ' reps'} atteint → passe à la progression (⇄ en séance)`);
    } else if (enDifficulte && cible.valeur > 1) {
      const avant = cible.valeur;
      cible.valeur = Math.max(1, cible.valeur - inc);
      changements.push(`${ex.nom} : ${cible.sets}×${avant} → ${cible.sets}×${cible.valeur} (échec ou RPE ≥ 9)`);
    }
  }

  if (changements.length) {
    const date = session.dateDebut.slice(0, 10);
    programme.genere.journal = [
      ...changements.map((texte) => ({ date, texte })),
      ...(programme.genere.journal || []),
    ].slice(0, 20);
  }
  return changements;
}

// --- Durée estimée / séance raccourcie ---------------------------------------------

// Durée estimée d'une séance (minutes), à partir des cibles et du type d'exo.
// Par exercice : sets × (travail + repos), moins le dernier repos (inutile),
// plus une transition de mise en place. Tolère les entrées sans cible (défauts).
export function estimerDureeSeance(entrees, exercices) {
  let sec = 0;
  for (const e of entrees) {
    const ex = exercices.get(e.exerciceId);
    const c = e.cible || {};
    const sets = c.sets || REGLES.SETS_FORCE;
    const repos = c.repos || (ex && ex.difficulte >= 5 ? REGLES.REPOS_COMPOSE : REGLES.REPOS_ACCESSOIRE);
    // Travail par série : une tenue dure ses secondes ; des reps ≈ SEC_PAR_REP chacune.
    const travail = ex?.type === 'hold' ? (c.valeur || 20) : (c.valeur || 10) * REGLES.SEC_PAR_REP;
    sec += sets * travail + Math.max(0, sets - 1) * repos + REGLES.TRANSITION_EXO;
  }
  return Math.round(sec / 60);
}

// Sélectionne les exercices à garder pour tenir dans le temps dispo :
// priorité au skill (le but de la séance), puis aux compounds (difficulté haute),
// on retire les accessoires les moins prioritaires jusqu'à rentrer. Le skill
// n'est jamais retiré, même s'il dépasse à lui seul. Retourne null si ça rentre déjà.
export function proposerSeanceRaccourcie(entrees, exercices, tempsDispoMin) {
  const dureeAvant = estimerDureeSeance(entrees, exercices);
  if (!tempsDispoMin || dureeAvant <= tempsDispoMin + REGLES.MARGE_TEMPS) return null;

  const estSkill = (i) => !!exercices.get(entrees[i].exerciceId)?.skill;
  const diff = (i) => exercices.get(entrees[i].exerciceId)?.difficulte ?? 0;
  const ordre = entrees.map((_, i) => i)
    .sort((a, b) => (estSkill(b) - estSkill(a)) || (diff(b) - diff(a)));

  const garder = [];
  for (const i of ordre) {
    const duree = estimerDureeSeance([...garder, i].map((k) => entrees[k]), exercices);
    if (duree <= tempsDispoMin || estSkill(i)) garder.push(i);
  }
  garder.sort((a, b) => a - b); // rétablir l'ordre d'origine
  const garderSet = new Set(garder);
  const retirer = entrees.map((_, i) => i).filter((i) => !garderSet.has(i));
  if (!retirer.length) return null;

  return {
    garder, retirer,
    dureeAvant,
    dureeApres: estimerDureeSeance(garder.map((k) => entrees[k]), exercices),
    nomsRetires: retirer.map((i) => exercices.get(entrees[i].exerciceId)?.nom || '').filter(Boolean),
  };
}
