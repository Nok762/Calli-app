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

import { compatibleMateriel, zonesEnConflit } from './adaptation.js';

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
  MIN_FORCE: 2,       // au moins 2 exercices de force par séance, même très courte
  SKILL_FREQ_MAX: 3,  // pratique d'un skill : ≤ 3×/sem (tissus conjonctifs, fraîcheur)
  SKILL_PAR_JOUR_MAX: 2, // ≤ 2 skills par séance (le travail de qualité se fait frais)
  SEMAINES_ROTATION: 6, // âge d'un programme au-delà duquel on propose un nouveau cycle
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// --- Profils d'objectif -------------------------------------------------------------
// L'objectif global de l'utilisateur module la PRESCRIPTION (fourchettes de reps,
// séries, repos, densité), pas la structure de fond (splits, skill d'abord,
// équilibre des patterns — valables pour tous) :
// - muscle : zone hypertrophie 8-15, 4 séries, repos modérés, priorité aux reps ;
// - skills : identique à forme côté force (le travail spécifique est le bloc
//   skill, obligatoire dans ce mode) ;
// - gras : densité (repos courts, plus d'exercices) + un finisher métabolique —
//   l'entraînement préserve le muscle, le déficit se joue dans l'assiette ;
// - forme : les valeurs historiques de REGLES.
export const PROFILS = {
  forme: {
    nom: 'Forme générale',
    repMin: 5, repMax: 12, setsForce: 3,
    reposCompose: 150, reposAccessoire: 90,
    minParExo: 9, bonusReps: 0, finisher: false,
  },
  muscle: {
    nom: 'Prise de muscle',
    repMin: 8, repMax: 15, setsForce: 4,
    reposCompose: 120, reposAccessoire: 75,
    minParExo: 10, bonusReps: 1.5, finisher: false,
  },
  skills: {
    nom: 'Skills',
    repMin: 5, repMax: 12, setsForce: 3,
    reposCompose: 150, reposAccessoire: 90,
    minParExo: 9, bonusReps: 0, finisher: false,
  },
  gras: {
    nom: 'Perte de gras',
    repMin: 10, repMax: 20, setsForce: 3,
    reposCompose: 75, reposAccessoire: 45,
    minParExo: 6, bonusReps: .5, finisher: true,
  },
};

// Exercices à haute demande métabolique (connaissance moteur, le seed reste pur) :
// candidats du finisher de fin de séance en mode perte de gras.
const FINISHERS = ['sq_burpees', 'sq_fentes_sautees', 'sq_squat_saute', 'ax_mountain_climbers', 'ax_hollow_rocks'];

// Patterns éligibles par TYPE de jour. Full-body : tout est possible chaque jour
// (la répartition hebdo équilibre). Haut/bas (4 j) : les jours hauts n'accueillent
// que poussées/tirages, les jours bas que jambes ; le gainage va partout.
const PATTERNS_HAUT = ['tirage_vertical', 'tirage_horizontal', 'poussee_horizontale', 'poussee_verticale', 'gainage_anti_extension', 'gainage_anti_rotation'];
const PATTERNS_BAS = ['squat', 'hinge', 'gainage_anti_rotation', 'gainage_anti_extension'];
const PATTERNS_TOUS = [...PATTERNS_HAUT, 'squat', 'hinge'];

// Splits par fréquence : full-body jusqu'à 3 j/sem, haut/bas à 4 j/sem (chaque
// muscle ~2×/sem). Le champ `patterns` liste ce qu'un jour PEUT accueillir ; le
// VOLUME réel est réparti par repartirPatterns (poids ci-dessous), pas par cette
// liste. La logique ne lit jamais le `nom` (libellés évocateurs, modifiables).
const SPLITS = {
  2: [
    { nom: 'Socle', patterns: PATTERNS_TOUS },
    { nom: 'Charpente', patterns: PATTERNS_TOUS },
  ],
  3: [
    { nom: 'Socle', patterns: PATTERNS_TOUS },
    { nom: 'Charpente', patterns: PATTERNS_TOUS },
    { nom: 'Aplomb', patterns: PATTERNS_TOUS },
  ],
  4: [
    { nom: 'Cime', patterns: PATTERNS_HAUT },
    { nom: 'Piliers', patterns: PATTERNS_BAS },
    { nom: 'Suspension', patterns: PATTERNS_HAUT },
    { nom: 'Ancrage', patterns: PATTERNS_BAS },
  ],
};

// Poids de VOLUME hebdomadaire par pattern (relatifs). Encodent les partis pris
// étayés : léger biais TIRAGE (santé d'épaule ; les skills de poussée type planche
// ajoutent déjà du volume de poussée), jambes équilibrées squat≈hinge (l'ancien
// 3 jours ne travaillait le hinge qu'1×/sem, sous le seuil), gainage modéré.
const POIDS_VOLUME = {
  tirage_vertical: 2, tirage_horizontal: 2,          // tirage = 4
  poussee_horizontale: 2, poussee_verticale: 1.5,    // poussée = 3,5 → léger biais tirage
  squat: 2, hinge: 2,                                // jambes équilibrées
  gainage_anti_extension: 1, gainage_anti_rotation: 1,
};
const COMPOUNDS = ['tirage_vertical', 'tirage_horizontal', 'poussee_horizontale', 'poussee_verticale', 'squat', 'hinge'];

// Répartit le budget hebdomadaire de créneaux de force sur les jours, selon les
// poids de volume, le type de chaque jour (un pattern ne va que sur un jour qui
// le liste) et la CAPACITÉ de chaque jour (temps dispo). Vise ainsi ~le volume
// efficace par muscle plutôt que « un exercice par pattern ». Retourne, pour
// chaque jour, la liste ORDONNÉE des patterns à remplir (compounds d'abord).
function repartirPatterns(split, capacites) {
  const joursPat = split.map((d) => new Set(d.patterns));
  const tous = [...new Set(split.flatMap((d) => d.patterns))];
  const poids = (p) => POIDS_VOLUME[p] || 1;
  const budgetSem = capacites.reduce((a, b) => a + b, 0);
  const poidsTotal = tous.reduce((t, p) => t + poids(p), 0);

  // Créneaux hebdo par pattern ∝ poids, avec un plancher de 1 aux compounds.
  const cible = {}, slots = {};
  for (const p of tous) {
    cible[p] = (poids(p) / poidsTotal) * budgetSem;
    slots[p] = Math.max(COMPOUNDS.includes(p) ? 1 : 0, Math.floor(cible[p]));
  }
  // Distribuer le reste aux plus gros écarts (cible − attribué), sous deux
  // contraintes structurelles que la granularité des petits budgets violait :
  // - équilibre intra-groupe : |horizontal − vertical| ≤ 1 (sinon, à 4 j/sem,
  //   la poussée horizontale prenait 3 créneaux et la verticale 1) ;
  // - biais tirage borné : tirage ≤ poussée + 1 exo (le léger biais reste,
  //   sans dériver à 2:1 comme au split 2 jours).
  const JUMEAUX = {
    tirage_vertical: 'tirage_horizontal', tirage_horizontal: 'tirage_vertical',
    poussee_horizontale: 'poussee_verticale', poussee_verticale: 'poussee_horizontale',
    squat: 'hinge', hinge: 'squat',
    gainage_anti_extension: 'gainage_anti_rotation', gainage_anti_rotation: 'gainage_anti_extension',
  };
  const total = (prefixe) => tous.filter((p) => p.startsWith(prefixe)).reduce((t, p) => t + slots[p], 0);
  // Capacité par groupe d'éligibilité : les patterns limités aux MÊMES jours ne
  // peuvent pas dépasser, ensemble, la capacité de ces jours (à 4 j/sem le haut
  // n'a que 2 jours — sans ce garde-fou l'allocation déborde et le placement
  // perd des créneaux, toujours au détriment du poids le plus faible).
  const cleElig = (p) => split.map((_d, j) => (joursPat[j].has(p) ? j : '')).join(',');
  const capParCle = {};
  for (const p of tous) {
    const cle = cleElig(p);
    capParCle[cle] = capParCle[cle]
      ?? split.reduce((t, _d, j) => t + (joursPat[j].has(p) ? capacites[j] : 0), 0);
  }
  const groupePlein = (p) => {
    const cle = cleElig(p);
    const attribue = tous.filter((x) => cleElig(x) === cle).reduce((t, x) => t + slots[x], 0);
    return attribue + 1 > capParCle[cle];
  };
  const admissible = (p) => {
    if (groupePlein(p)) return false;
    const jumeau = JUMEAUX[p];
    if (jumeau && tous.includes(jumeau) && slots[p] + 1 - slots[jumeau] > 1) return false;
    if (p.startsWith('tirage') && total('tirage') + 1 - total('poussee') > 1) return false;
    if (p.startsWith('poussee') && total('poussee') + 1 - total('tirage') > 1) return false;
    return true;
  };
  let reste = budgetSem - tous.reduce((t, p) => t + slots[p], 0);
  while (reste > 0) {
    const candidats = tous.filter(admissible);
    const pool = candidats.length ? candidats : tous; // jamais bloqué
    const p = pool.reduce((b, x) => (cible[x] - slots[x] > cible[b] - slots[b] ? x : b), pool[0]);
    slots[p] += 1; reste -= 1;
  }

  // Poser chaque créneau sur le jour éligible le moins chargé (≤ capacité, ≤ 2×/jour).
  const parJour = split.map(() => []);
  const compte = split.map(() => ({}));
  for (const p of tous.slice().sort((a, b) => poids(b) - poids(a))) {
    for (let n = 0; n < slots[p]; n++) {
      let best = -1, charge = Infinity;
      for (let j = 0; j < split.length; j++) {
        if (!joursPat[j].has(p) || parJour[j].length >= capacites[j] || (compte[j][p] || 0) >= 2) continue;
        if (parJour[j].length < charge) { charge = parJour[j].length; best = j; }
      }
      if (best < 0) break;
      parJour[best].push(p);
      compte[best][p] = (compte[best][p] || 0) + 1;
    }
  }
  const prio = (p) => (COMPOUNDS.includes(p) ? 0 : 1);
  return parJour.map((pats) => pats.sort((a, b) => prio(a) - prio(b) || poids(b) - poids(a)));
}

// Échauffement adapté aux patterns du jour : cardio léger + mobilité articulaire
// (universels, cruciaux pour les tissus conjonctifs en callisthénie), activation
// scapulaire si haut du corps, activation bas si jambes, puis prépa mouvement.
// Standard proche de la r/bwf Recommended Routine. Renvoie des étapes affichables.
// `straight_arm` (planche, front lever…) compte comme haut du corps.
function genererEchauffement(patterns) {
  const haut = patterns.some((p) => p.startsWith('poussee') || p.startsWith('tirage') || p === 'straight_arm');
  const bas = patterns.some((p) => p === 'squat' || p === 'hinge');
  const etapes = [
    '2-3 min de cardio léger (corde à sauter, montées de genoux)',
    'Mobilité articulaire : poignets, coudes, épaules, hanches, genoux — 5 cercles par sens',
  ];
  if (haut) etapes.push('Activation scapulaire : 10 tractions scapulaires + 10 pompes scapulaires');
  if (bas) etapes.push('Activation bas du corps : 10 ponts fessiers + 10 squats à vide');
  etapes.push('Prépa : 5 répétitions faciles de chaque exercice principal avant la 1re série lourde');
  return etapes;
}

// Étirements POST-séance adaptés aux patterns travaillés (statiques : à faire
// après l'effort — avant, ils réduisent la force ; après, ils entretiennent la
// mobilité, clé en callisthénie). 20-30 s par position, sans forcer. Exporté :
// la séance les génère depuis les patterns réellement travaillés du jour.
// `straight_arm` sollicite poignets/biceps/épaules → couvre poussée + tirage.
export function genererEtirements(patterns) {
  const pousse = patterns.some((p) => p.startsWith('poussee') || p === 'straight_arm');
  const tire = patterns.some((p) => p.startsWith('tirage') || p === 'straight_arm');
  const squat = patterns.includes('squat');
  const hinge = patterns.includes('hinge');

  const etirements = [];
  if (pousse || tire) etirements.push('Poignets : fléchisseurs puis extenseurs, à genoux mains au sol — 20 s par sens');
  if (pousse) etirements.push('Pectoraux + épaules : avant-bras sur l\'encadrement de porte, buste qui avance — 30 s');
  if (pousse) etirements.push('Triceps : coude au plafond, main entre les omoplates — 20 s par bras');
  if (tire) etirements.push('Dorsaux : child pose bras tendus, mains loin devant — 30 s');
  if (tire) etirements.push('Biceps + avant-bras : bras tendu, paume au mur doigts vers le bas — 20 s par bras');
  if (squat) etirements.push('Quadriceps : debout, talon vers la fesse, genoux serrés — 30 s par jambe');
  if (squat || hinge) etirements.push('Fessiers : figure 4 allongé (cheville sur le genou opposé) — 30 s par côté');
  if (hinge) etirements.push('Ischios : penché avant jambes tendues, dos long — 30 s');
  if (hinge) etirements.push('Fléchisseurs de hanche : fente basse, bassin qui avance, buste haut — 30 s par côté');
  if (patterns.some((p) => p.startsWith('gainage'))) {
    etirements.push('Dos + abdos : cobra doux au sol, bassin ancré — 20 s');
  }
  return etirements;
}

// --- Mobilité ------------------------------------------------------------------------
// Option transversale « + Mobilité » : un bloc de travail de mobilité ACTIVE en
// fin de séance (muscles chauds), distinct des étirements de récupération —
// positions tenues plus longtemps, avec intention. Ciblé d'abord sur les
// besoins des skills objectifs (le handstand bute sur épaules/poignets, le
// pistol sur hanches/chevilles…), complété par les patterns du jour.
const DRILLS_MOBILITE = {
  poignets: [
    'Poignets : cercles chargés à quatre pattes, paumes puis dos de main — 45 s',
    'Extension de poignets : doigts vers les genoux, recul progressif du poids — 45 s',
  ],
  epaules: [
    'Épaules : allongé sur le ventre, bras tendus derrière, décoller les mains (ou german hang léger) — 45 s',
    'Ouverture d\'épaules : mains sur un support, buste qui plonge, dos plat — 45 s',
  ],
  hanches: [
    'Squat profond : tenir en bas, coudes qui écartent les genoux — 60 s',
    'Pancake : assis jambes écartées, marcher les mains vers l\'avant — 60 s',
  ],
  chevilles: [
    'Chevilles : genou vers le mur, pied à plat, talon au sol — 45 s par côté',
  ],
  colonne: [
    'Extension thoracique : cobra haut ou pont sur les épaules, ouvrir la poitrine — 45 s',
  ],
  ischios: [
    'Pike actif : penché avant jambes tendues, tirer le buste vers les jambes sans rebond — 60 s',
  ],
};

// Besoins de mobilité par skill (les prérequis articulaires réels de chaque arbre).
const MOBILITE_PAR_SKILL = {
  planche: ['epaules', 'poignets'],
  handstand: ['epaules', 'poignets'],
  front_lever: ['epaules'],
  back_lever: ['epaules'],
  muscle_up: ['epaules'],
  one_arm_pull_up: ['epaules'],
  pistol: ['hanches', 'chevilles'],
  l_sit: ['ischios', 'hanches'],
  v_sit: ['ischios', 'hanches'],
  dragon_flag: ['colonne', 'epaules'],
  nordic: ['ischios'],
};
const MAX_DRILLS_MOBILITE = 5;

export function genererMobilite(patterns, skillIds = []) {
  const zones = [];
  const ajouter = (z) => { if (z && !zones.includes(z)) zones.push(z); };
  // 1) Les besoins des skills objectifs priment.
  for (const id of skillIds) for (const z of MOBILITE_PAR_SKILL[id] || []) ajouter(z);
  // 2) Complément selon les patterns du jour.
  const haut = patterns.some((p) => p.startsWith('poussee') || p.startsWith('tirage') || p === 'straight_arm');
  const bas = patterns.some((p) => p === 'squat' || p === 'hinge');
  if (haut) { ajouter('epaules'); ajouter('poignets'); }
  if (bas) { ajouter('hanches'); ajouter('ischios'); }
  ajouter('colonne');

  const drills = [];
  for (const z of zones) {
    for (const d of DRILLS_MOBILITE[z]) {
      if (drills.length >= MAX_DRILLS_MOBILITE) return drills;
      drills.push(d);
    }
  }
  return drills;
}

// --- Génération ------------------------------------------------------------------

// params : { objectifs: [skillId], objectifGlobal: 'forme'|'muscle'|'skills'|'gras',
//            frequence: 2|3|4, materiel: [...], dureeMin }
// donnees : { exercices: Map, skills: [dérivés], etats: Map skillId→état, prs: Map exerciceId→pr }
export function genererProgramme(params, donnees) {
  const { objectifs, frequence, materiel, dureeMin } = params;
  const { exercices, skills, etats, prs } = donnees;
  const profil = PROFILS[params.objectifGlobal] || PROFILS.forme;
  // Zones chroniquement sensibles (profil) : la sélection dé-priorise les
  // exercices qui les chargent — sans jamais bloquer si le pattern n'a pas
  // d'alternative (l'utilisateur garde le dernier mot en séance).
  const zonesFragiles = params.zonesFragiles || [];
  // Rotation de mésocycle : exercices du programme précédent à éviter.
  const eviterIds = new Set(params.eviterIds || []);

  const objSkills = objectifs.map((id) => skills.find((s) => s.id === id)).filter(Boolean);
  const niveaux = estimerNiveaux(prs, exercices);
  // Densité pilotée par le profil : repos courts → plus d'exercices par séance.
  const nbExos = clamp(Math.round(dureeMin / profil.minParExo), REGLES.MIN_EXOS, REGLES.MAX_EXOS);
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

  // 1) Skills par jour : rotation + bornes (≤ SKILL_FREQ_MAX/sem par skill,
  // ≤ SKILL_PAR_JOUR_MAX par séance — fraîcheur + tissus conjonctifs). Plusieurs
  // objectifs tournent (le moins pratiqué passe en premier) au lieu de s'entasser.
  const skillSem = new Map(); // skillId -> apparitions cette semaine
  const skillParJour = split.map((defJour) => {
    // À 4 j/sem, les skills de jambes (pistol, nordic) vont sur les jours bas.
    const estJourBas = defJour.patterns.filter((p) => p === 'squat' || p === 'hinge').length >= 2;
    const candidats = (frequence <= 3 ? etapesCourantes
      : etapesCourantes.filter(({ etape }) =>
          ['squat', 'hinge'].includes(etape.exercice.pattern) === estJourBas))
      .filter(({ skill }) => (skillSem.get(skill.id) || 0) < REGLES.SKILL_FREQ_MAX)
      .sort((a, b) => (skillSem.get(a.skill.id) || 0) - (skillSem.get(b.skill.id) || 0))
      .slice(0, REGLES.SKILL_PAR_JOUR_MAX);
    for (const { skill } of candidats) skillSem.set(skill.id, (skillSem.get(skill.id) || 0) + 1);
    return candidats;
  });

  // 2) Répartition du VOLUME de force sur la semaine : capacité de chaque jour =
  // créneaux restants après les skills, puis répartition par pattern (poids +
  // type de jour + capacité).
  const capacites = split.map((_defJour, j) => Math.max(REGLES.MIN_FORCE, nbExos - skillParJour[j].length));
  const patternsParJour = repartirPatterns(split, capacites);

  // 3) Construire chaque jour : skill en premier (frais), puis la force répartie.
  const jours = split.map((defJour, j) => {
    // `skill` marque l'entrée comme bloc skill : la resynchronisation d'étape
    // (vue-seance) ne touche que ces entrées, jamais un exo de force qui serait
    // par hasard une étape de l'arbre (le bonus de transfert le permet).
    const exosSkill = skillParJour[j].map(({ skill, etape }) => ({
      exerciceId: etape.exercice.id,
      cible: cibleSkill(etape),
      skill: skill.id,
    }));
    const pris = new Set(exosSkill.map((e) => e.exerciceId));

    const exosForce = [];
    for (const pattern of patternsParJour[j]) {
      const ex = choisirForce(pattern, { exercices, materiel, niveau: niveaux.niveauPattern(pattern), prs, bonusIds, pris, usage, profil, zonesFragiles, eviterIds });
      if (!ex) continue;
      pris.add(ex.id);
      usage.set(ex.id, (usage.get(ex.id) || 0) + 1);
      exosForce.push({ exerciceId: ex.id, cible: cibleForce(ex, prs, profil) });
    }

    // Finisher métabolique (perte de gras) : un exercice à haute demande en fin
    // de séance, repos très court. Rotation entre séances via `usage`.
    if (profil.finisher) {
      const exFin = FINISHERS.map((id) => exercices.get(id))
        .filter((ex) => ex && !pris.has(ex.id) && compatibleMateriel(ex, materiel))
        .sort((a, b) => (zonesEnConflit(a, zonesFragiles).length - zonesEnConflit(b, zonesFragiles).length)
          || ((usage.get(a.id) || 0) - (usage.get(b.id) || 0)))[0];
      if (exFin) {
        pris.add(exFin.id);
        usage.set(exFin.id, (usage.get(exFin.id) || 0) + 1);
        exosForce.push({
          exerciceId: exFin.id,
          cible: { sets: 3, valeur: exFin.type === 'hold' ? 30 : 15, repos: 30 },
          finisher: true,
        });
      }
    }

    // Patterns du jour = skills + force (l'échauffement et les étirements doivent
    // couvrir aussi le travail de skill, ex. pistol un jour sans force jambes).
    const patsJour = [...new Set([
      ...skillParJour[j].map(({ etape }) => etape.exercice.pattern),
      ...patternsParJour[j],
    ])];
    return {
      nom: defJour.nom,
      echauffement: genererEchauffement(patsJour),
      etirements: genererEtirements(patsJour),
      ...(params.mobilite ? { mobilite: genererMobilite(patsJour, objectifs) } : {}),
      exercices: [...exosSkill, ...exosForce],
    };
  });

  return {
    id: 'p_' + Date.now().toString(36),
    nom: '✨ ' + (objSkills.map((s) => s.nom).join(' + ') || profil.nom),
    jours,
    genere: {
      objectifs, frequence, materiel, dureeMin,
      objectifGlobal: params.objectifGlobal || 'forme',
      mobilite: !!params.mobilite,
      zonesFragiles,
      dateDebut: new Date().toISOString(),
      journal: [], // trace des évolutions de cibles, chacune expliquée
    },
  };
}

// Niveau force estimé depuis les PR existants (difficulté moyenne des exercices
// maîtrisés). Estimé PAR PATTERN : on peut être avancé en tirage et débutant en
// jambes, et le générateur doit choisir en conséquence. Sans historique sur un
// pattern → repli sur le niveau global ; sans aucun historique → 3 (débutant/inter).
function estimerNiveaux(prs, exercices) {
  const global = [];
  const parPattern = new Map(); // pattern -> [difficultés maîtrisées]
  for (const [id, pr] of prs) {
    const ex = exercices.get(id);
    if (!ex) continue;
    if ((pr.maxReps?.valeur ?? 0) >= 5 || (pr.maxHold?.valeur ?? 0) >= 15) {
      global.push(ex.difficulte);
      if (!parPattern.has(ex.pattern)) parPattern.set(ex.pattern, []);
      parPattern.get(ex.pattern).push(ex.difficulte);
    }
  }
  const moyenne = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const niveauGlobal = global.length ? moyenne(global) : 3;
  const niveaux = new Map();
  for (const [p, ds] of parPattern) niveaux.set(p, moyenne(ds));
  return { niveauGlobal, niveauPattern: (pattern) => niveaux.get(pattern) ?? niveauGlobal };
}

// Cible d'un exercice de skill : ~60 % du critère par série, plusieurs séries,
// repos long — accumuler du temps de qualité, jamais aller à l'échec technique.
// Exportée : la resynchronisation d'étape (vue-seance) recalcule la cible.
export function cibleSkill(etape) {
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
// Fourchettes, séries et repos viennent du profil d'objectif.
function cibleForce(ex, prs, profil = PROFILS.forme) {
  const pr = prs.get(ex.id);
  const repos = ex.difficulte >= 5 ? profil.reposCompose : profil.reposAccessoire;
  if (ex.type === 'hold') {
    const record = pr?.maxHold?.valeur;
    return {
      sets: profil.setsForce,
      valeur: record ? clamp(Math.round(record * 0.8), REGLES.HOLD_MIN, REGLES.HOLD_MAX) : 20,
      repos,
    };
  }
  const record = pr?.maxReps?.valeur;
  return {
    sets: profil.setsForce,
    valeur: record ? clamp(Math.round(record * 0.75), profil.repMin, profil.repMax) : clamp(8, profil.repMin, profil.repMax),
    repos,
  };
}

// Meilleur exercice de force pour un pattern : difficulté proche du niveau,
// bonus s'il transfère vers un objectif ou s'il est déjà calibré par un PR,
// pénalité s'il est déjà utilisé un autre jour (variété).
function choisirForce(pattern, { exercices, materiel, niveau, prs, bonusIds, pris, usage, profil, zonesFragiles, eviterIds }) {
  let meilleur = null;
  for (const ex of exercices.values()) {
    if (ex.pattern !== pattern || pris.has(ex.id)) continue;
    if (!compatibleMateriel(ex, materiel)) continue;
    let score = -Math.abs(ex.difficulte - niveau);
    if (bonusIds.has(ex.id)) score += 1.5;
    if (prs.has(ex.id)) score += 0.5;
    // Hypertrophie : les mouvements en reps priment sur les tenues.
    if (profil?.bonusReps && ex.type === 'reps') score += profil.bonusReps;
    // Zones chroniquement sensibles : forte pénalité, jamais un blocage
    // (si tout le pattern charge la zone, on programme quand même le meilleur).
    if (zonesFragiles?.length) score -= 2 * zonesEnConflit(ex, zonesFragiles).length;
    // Rotation de mésocycle : dé-priorise les exercices du cycle précédent.
    if (eviterIds?.has(ex.id)) score -= 2.5;
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
  // Les bornes de progression suivent le profil d'objectif du programme.
  const profil = PROFILS[programme.genere?.objectifGlobal] || PROFILS.forme;
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
    const plafond = estHold ? REGLES.HOLD_MAX : profil.repMax;

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
