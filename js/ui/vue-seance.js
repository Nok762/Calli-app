// vue-seance.js — feature 2 : log de séance en direct, pensé pour être utilisé
// PENDANT l'entraînement :
// - barre de chrono fixe toujours visible : repos en un tap (durées rapides),
//   chrono de tenue avec décompte de préparation (on se met en place, bips
//   3-2-1, signal GO, le vrai chrono démarre) ;
// - écran maintenu allumé (Wake Lock) tant que la séance est ouverte ;
// - saisie rapide : valeur pré-remplie, steppers ±, RPE en boutons ;
// - fiche express d'un exercice (consignes, erreurs) sans quitter la séance.
// Intègre aussi templates (feature 3) et moteur d'adaptation (feature 5).
// Le brouillon est persisté : une séance en cours survit à un rechargement.

import { ctx } from '../app.js';
import { dbGet, dbGetAll, dbPut, getReglage, setReglage } from '../db.js';
import { majPRDepuisSession, getPR } from '../pr.js';
import { getEtatSkill } from '../skills.js';
import {
  verifierExercice, proposerAlternatives, texteCause,
  suggestionsPalier, suggestionsDeload, suggestionsPlateau, evaluerReadiness,
} from '../moteur/adaptation.js';
import {
  evoluerCibles, modulationSeance, proposerSeanceRaccourcie, genererEtirements, cibleSkill,
} from '../moteur/generateur.js';
import { toast, bip, tick, go, libelle, choisirExercice, confirmer, afficherChecklist } from './composants.js';

const EQUIPEMENT_DEFAUT = ['barre', 'anneaux', 'parallettes', 'elastiques', 'surface_surelevee'];
const ZONES_DEFAUT = ['poignets', 'epaules', 'coudes', 'lombaires', 'genoux'];
const PREPA_DEFAUT = 5;    // secondes de mise en place avant le chrono de tenue

let seance = null;   // séance en cours (miroir du brouillon persisté en base)
let chargee = false; // le brouillon a-t-il déjà été lu depuis IndexedDB ?
let focusIndex = 0;  // exercice affiché en mode Focus (player)
let modeListe = false; // false = player plein écran (défaut), true = vue d'ensemble
let animerProchainRendu = false; // joue le décompte de démarrage au prochain player
let reposDefaut = 90;  // durée de repos imposée par défaut (réglable)
let prepaDefaut = PREPA_DEFAUT;

export async function vueSeance(el) {
  if (!chargee) {
    seance = await getReglage('seance_en_cours');
    chargee = true;
  }
  if (seance) return seanceEnCours(el);
  return formulaireDemarrage(el);
}

const persister = () => setReglage('seance_en_cours', seance);

// Template sélectionné (depuis un programme ou les raccourcis du dashboard) :
// référence stockée en réglage pour survivre à la navigation entre vues.
async function chargerTemplate() {
  const ref = await getReglage('template_a_demarrer');
  if (!ref) return null;
  const prog = await dbGet('programmes', ref.programmeId);
  const jour = prog?.jours[ref.jourIdx];
  if (!jour) {
    await setReglage('template_a_demarrer', null);
    return null;
  }
  // Un programme généré doit programmer l'étape COURANTE de chaque skill : si un
  // palier a été validé depuis la génération, on resynchronise (sinon on
  // continuerait de programmer l'ancienne étape jusqu'à régénération complète).
  const changements = await synchroniserEtapesSkills(prog);
  if (changements.length) {
    await dbPut('programmes', prog);
    toast(`Programme suivi : ${changements.join(' · ')}`);
  }
  return { prog, jour, jourIdx: ref.jourIdx };
}

// Remplace, dans les blocs skill d'un programme généré (entrées marquées
// `skill`), l'exercice programmé par celui de l'étape courante, cible
// recalculée. Idempotent : aucune écriture si tout est déjà à jour.
// Les programmes générés avant le marquage `skill` sont couverts par un repli :
// toute entrée dont l'exercice appartient à l'arbre du skill objectif.
async function synchroniserEtapesSkills(prog) {
  if (!prog?.genere) return [];
  const changements = [];
  // Le repli « programme d'avant le marquage » se décide au niveau du programme
  // entier : dans un programme neuf, une entrée force jamais marquée ne doit pas
  // être confondue avec un bloc skill.
  const aMarquage = prog.jours.some((j) => j.exercices.some((e) => e.skill));
  for (const skillId of prog.genere.objectifs) {
    const skill = ctx.skills.find((s) => s.id === skillId);
    if (!skill) continue;
    const etat = await getEtatSkill(skill);
    const step = etat.termine ? skill.etapes[skill.etapes.length - 1].step : etat.etapeCourante;
    const etape = skill.etapes.find((e) => e.step === step);
    if (!etape) continue;
    const idsEtapes = new Set(skill.etapes.map((e) => e.exercice.id));

    let change = false;
    for (const jour of prog.jours) {
      for (const exo of jour.exercices) {
        const estBlocSkill = aMarquage ? exo.skill === skillId
          : idsEtapes.has(exo.exerciceId); // repli anciens programmes
        if (!estBlocSkill || exo.exerciceId === etape.exercice.id) continue;
        exo.exerciceId = etape.exercice.id;
        exo.cible = cibleSkill(etape);
        exo.skill = skillId;
        change = true;
      }
    }
    if (change) changements.push(`${skill.nom} → ${etape.exercice.nom}`);
  }
  if (changements.length) {
    const date = new Date().toISOString().slice(0, 10);
    prog.genere.journal = [
      ...changements.map((texte) => ({ date, texte: `étape courante : ${texte}` })),
      ...(prog.genere.journal || []),
    ].slice(0, 20);
  }
  return changements;
}

// --- Écran de démarrage : contraintes du jour --------------------------------

async function formulaireDemarrage(el) {
  const equip = (ctx.meta?.enums.equipement || EQUIPEMENT_DEFAUT).filter((e) => e !== 'aucun');
  const zones = ctx.meta?.enums.zones_a_risque || ZONES_DEFAUT;
  const template = await chargerTemplate();
  const programmes = template ? [] : await dbGetAll('programmes');
  const jours = programmes.flatMap((p) =>
    p.jours.map((jour, j) => ({ prog: p, jour, j })).filter(({ jour }) => jour.exercices.length));

  el.innerHTML = `
    <h1>Séance</h1>
    ${template ? `
      <div class="carte accent carte-template">
        <div><strong>📋 ${template.prog.nom} — ${template.jour.nom}</strong>
          <div class="texte-2">${template.jour.exercices.length} exercices pré-remplis</div></div>
        <button class="btn-x" id="btn-annuler-template">×</button>
      </div>
      ${template.jour.echauffement?.length ? `
        <details class="echauffement">
          <summary>🔥 Échauffement · ${template.jour.echauffement.length} étapes</summary>
          <ul>${template.jour.echauffement.map((e) => `<li>${e}</li>`).join('')}</ul>
        </details>` : ''}` : ''}
    ${jours.length ? `
      <h3>Depuis un programme</h3>
      <div class="chips">
        ${jours.map(({ prog, jour, j }) =>
          `<button class="chip-lien" data-template="${prog.id}:${j}">▶ ${prog.nom} · ${jour.nom}</button>`).join('')}
      </div>` : ''}
    <div class="carte">
      <h2>Contraintes du jour</h2>
      <p class="texte-2">10 secondes à renseigner — elles alimentent le filtre matériel et le moteur d'adaptation.</p>
      <h3>Matériel dispo</h3>
      <div class="chips" id="chips-materiel">${equip.map((e) => chip(e)).join('')}</div>
      <h3>Douleurs / zones à ménager</h3>
      <div class="chips" id="chips-douleurs">${zones.map((z) => chip(z)).join('')}</div>
      <div class="ligne-2">
        <label>Temps dispo (min)
          <input id="inp-temps" type="number" inputmode="numeric" placeholder="45"></label>
        <label>Énergie
          <select id="sel-energie">
            <option value="normale">Normale</option>
            <option value="faible">Faible</option>
            <option value="haute">Haute</option>
          </select></label>
      </div>
      <button class="btn btn-accent btn-large" id="btn-demarrer">Démarrer la séance</button>
    </div>
    <p class="centre"><a href="#/programmes">Gérer mes programmes →</a></p>`;

  el.querySelector('#btn-annuler-template')?.addEventListener('click', async () => {
    await setReglage('template_a_demarrer', null);
    formulaireDemarrage(el);
  });

  el.querySelectorAll('[data-template]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const [programmeId, jourIdx] = btn.dataset.template.split(':');
      await setReglage('template_a_demarrer', { programmeId, jourIdx: Number(jourIdx) });
      formulaireDemarrage(el);
    }));

  el.querySelector('#btn-demarrer').addEventListener('click', async () => {
    const sessions = await dbGetAll('sessions');
    // Modulation (deload planifié / reprise après pause) pour un programme
    // généré : appliquée à la SÉANCE uniquement — le programme garde ses
    // cibles canoniques, et la bannière permet de rétablir.
    const modulation = template?.prog.genere ? modulationSeance(template.prog, sessions) : null;
    const contraintes = {
      materiel: cochees('#chips-materiel'),
      douleurs: cochees('#chips-douleurs'),
      tempsDispo: Number(el.querySelector('#inp-temps').value) || null,
      energie: el.querySelector('#sel-energie').value,
    };
    // Autorégulation « forme du jour » : verdict figé au démarrage (comme la
    // modulation), consommé ensuite par la bannière readiness.
    const readiness = evaluerReadiness(contraintes, sessions);
    const entrees = template
      ? template.jour.exercices.map((e) => {
          const entree = { exerciceId: e.exerciceId, sets: [], cible: { ...e.cible } };
          if (modulation) {
            entree.cibleOrigine = { ...e.cible };
            entree.cible.valeur = Math.max(1, Math.round(entree.cible.valeur * modulation.facteur));
          }
          return entree;
        })
      : [];
    seance = {
      id: 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      dateDebut: new Date().toISOString(),
      programme: template
        ? { id: template.prog.id, nom: template.prog.nom, jour: template.jour.nom, jourIdx: template.jourIdx }
        : null,
      contraintes,
      entrees,
      modulation,
      readiness,
      echauffement: template?.jour.echauffement || null,
      ajustements: {},
    };
    await setReglage('template_a_demarrer', null);
    await persister();
    // « Quelque chose se lance » : plein écran (best-effort, geste utilisateur)
    // + décompte 3·2·1·GO au premier rendu du player.
    focusIndex = 0;
    modeListe = false;
    animerProchainRendu = true;
    demanderFullscreen();
    vueSeance(el);
  });
}

const chip = (valeur) =>
  `<label class="chip"><input type="checkbox" value="${valeur}"><span>${libelle(valeur)}</span></label>`;

const cochees = (sel) =>
  [...document.querySelectorAll(`${sel} input:checked`)].map((i) => i.value);

// --- Séance en cours : dispatcher player (défaut) / vue liste --------------------

async function seanceEnCours(el) {
  reposDefaut = await getReglage('dureeRepos', 90);
  prepaDefaut = await getReglage('dureePrepa', PREPA_DEFAUT);
  if (chrono.mode === 'idle') chrono.pending = chrono.pending || reposDefaut;
  return modeListe ? rendreListe(el) : rendrePlayer(el);
}

// --- Mode Focus : un exercice par écran, plein écran, gros timer en bas -----------

function rendrePlayer(el) {
  document.body.classList.add('mode-seance');
  initSeanceGlobalListeners();
  const n = seance.entrees.length;

  // Séance libre sans exercice : inviter à en ajouter.
  if (!n) {
    el.innerHTML = `
      <div class="player">
        <div class="player-tete">
          <div class="player-prog"><div class="player-prog-txt">${seance.programme ? seance.programme.jour : 'Séance libre'}</div></div>
          <button class="btn-x" data-liste title="Vue liste">☰</button>
        </div>
        <div class="player-corps">
          <p class="texte-2 centre">Aucun exercice.<br>Ajoute ton premier mouvement 👇</p>
          <button class="btn btn-accent btn-large" data-ajouter>+ Ajouter un exercice</button>
        </div>
      </div>`;
    el.querySelector('[data-liste]').addEventListener('click', () => { modeListe = true; seanceEnCours(el); });
    el.querySelector('[data-ajouter]').addEventListener('click', () => ajouterExercice(el));
    return;
  }

  focusIndex = Math.max(0, Math.min(focusIndex, n - 1));
  const i = focusIndex;
  const entree = seance.entrees[i];
  const ex = ctx.exercices.get(entree.exerciceId);
  const estHold = ex.type === 'hold';
  const unite = estHold ? 's' : 'reps';
  const target = entree.cible?.sets || 1;
  const faits = entree.sets.length;
  const atteint = faits >= target;
  const estDernier = i === n - 1;
  const verif = verifierExercice(ex, seance.contraintes);
  const prevu = entree.remplace ? ctx.exercices.get(entree.remplace.exerciceIdPrevu) : null;
  const dernier = entree.sets[entree.sets.length - 1];
  const valeurDefaut = dernier?.valeur ?? entree.cible?.valeur ?? '';

  const nbDots = Math.max(target, faits);
  const dots = Array.from({ length: nbDots }, (_, k) =>
    `<span class="dot ${k < faits ? 'faite' : ''}"></span>`).join('');
  const recap = entree.sets.map((s) =>
    `<span class="mini-set ${s.echec ? 'echec' : ''}">${s.valeur}${estHold ? 's' : ''}${s.rpe ? '·' + s.rpe : ''}</span>`).join('');

  // Le gros bouton s'adapte : valider tant que la cible n'est pas atteinte,
  // puis passer à l'exercice suivant (ou terminer sur le dernier).
  let grosLabel;
  let grosAct;
  if (faits < target) { grosLabel = 'Valider la série'; grosAct = 'valider'; }
  else if (!estDernier) { grosLabel = 'Exercice suivant ▶'; grosAct = 'suivant'; }
  else { grosLabel = 'Terminer ▶'; grosAct = 'terminer'; }

  el.innerHTML = `
    <div class="player">
      <div class="player-tete">
        <button class="btn-x" data-nav="prec" ${i === 0 ? 'disabled' : ''}>←</button>
        <div class="player-prog">
          <div class="player-prog-txt">Exercice ${i + 1} / ${n}</div>
          <div class="ligne"><div style="width:${((i + 1) / n) * 100}%"></div></div>
        </div>
        <button class="btn-x" data-nav="suiv" ${estDernier ? 'disabled' : ''}>→</button>
        ${seance.echauffement?.length ? '<button class="btn-x" data-echauffement title="Échauffement">🔥</button>' : ''}
        <button class="btn-x" data-liste title="Vue liste">☰</button>
      </div>

      <div class="player-corps">
        <button class="player-nom" data-fiche>${ex.nom}</button>
        <div class="chips-mini">
          <span class="badge">${estHold ? 'tenue' : 'reps'}</span>
          ${entree.cible ? `<span class="badge badge-accent">objectif ${entree.cible.sets}×${entree.cible.valeur}${estHold ? ' s' : ''}</span>` : ''}
        </div>
        ${prevu ? `<div class="texte-2">⇄ remplace ${prevu.nom} · ${entree.remplace.raison}</div>` : ''}
        ${verif.ok ? '' : `<div class="texte-attention">⚠ ${verif.raisons.join(' · ')}</div>`}
        <div class="player-dots">${dots}</div>
        <div class="player-serie-num">${atteint ? `${faits} série${faits > 1 ? 's' : ''} ✓` : `Série ${faits + 1} / ${target}`}</div>
        <div class="player-recap">${recap}</div>

        <div class="player-saisie">
          <button class="btn btn-step" data-step="-1">−</button>
          <div class="player-val">
            <input type="number" min="1" inputmode="numeric" class="inp-valeur" value="${valeurDefaut}">
            <span class="player-unite">${unite}</span>
          </div>
          <button class="btn btn-step" data-step="1">+</button>
        </div>
        ${estHold ? '<button class="btn btn-chrono-grand" data-chrono>⏱ Chrono de tenue</button>' : ''}
        <div class="ligne-rpe">
          <span class="texte-2">RPE</span>
          ${[6, 7, 8, 9, 10].map((v) => `<button class="rpe-btn" data-rpe="${v}">${v}</button>`).join('')}
          <button class="rpe-btn chip-echec" data-echec>échec</button>
        </div>
      </div>

      <div class="player-actions">
        <button class="btn btn-accent btn-large player-primary" data-gros="${grosAct}">${grosLabel}</button>
        ${atteint ? '<button class="btn-lien" data-plus-serie>+ une série</button>' : ''}
        <button class="btn-lien" data-remplacer>⇄ Remplacer l'exercice</button>
      </div>

      <div class="espace-barre"></div>
      <div id="barre-chrono" class="barre-chrono"></div>
    </div>`;

  // Navigation entre exercices.
  el.querySelectorAll('[data-nav]').forEach((btn) =>
    btn.addEventListener('click', () => {
      focusIndex += btn.dataset.nav === 'suiv' ? 1 : -1;
      rendrePlayer(el);
    }));
  el.querySelector('[data-liste]').addEventListener('click', () => { modeListe = true; seanceEnCours(el); });
  el.querySelector('[data-echauffement]')?.addEventListener('click', () =>
    afficherChecklist({ titre: '🔥 Échauffement', items: seance.echauffement }));
  el.querySelector('[data-fiche]').addEventListener('click', () => ouvrirFiche(ex));
  el.querySelector('[data-remplacer]').addEventListener('click', () => ouvrirRemplacement(el, i));

  // Steppers ±.
  el.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const inp = el.querySelector('.inp-valeur');
      inp.value = Math.max(1, (Number(inp.value) || 0) + Number(btn.dataset.step));
    }));

  // RPE + échec (toggles).
  el.querySelectorAll('[data-rpe]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const actif = btn.classList.contains('actif');
      el.querySelectorAll('[data-rpe]').forEach((x) => x.classList.remove('actif'));
      if (!actif) btn.classList.add('actif');
    }));
  el.querySelector('[data-echec]').addEventListener('click', (e) => e.target.classList.toggle('actif'));

  // Chrono de tenue : prépa → GO → compte, re-tap = stop + remplit.
  el.querySelector('[data-chrono]')?.addEventListener('click', () => {
    if (chrono.mode === 'tenue' && chrono.exoIndex === i) arreterTenueEtRemplir();
    else if (chrono.mode === 'idle' || chrono.mode === 'repos') demarrerPrepa(i, prepaDefaut);
  });

  // Gros bouton + « une série ».
  el.querySelector('[data-gros]').addEventListener('click', async () => {
    const act = el.querySelector('[data-gros]').dataset.gros;
    if (act === 'valider') return validerSerie(el, i);
    if (act === 'suivant') { focusIndex++; return rendrePlayer(el); }
    if (act === 'terminer') {
      if (!seance.entrees.some((e) => e.sets.length)) { toast('Logge au moins une série avant de terminer.'); return; }
      if (await confirmer('Terminer et enregistrer la séance ?', { oui: 'Terminer' })) await terminer();
    }
  });
  el.querySelector('[data-plus-serie]')?.addEventListener('click', () => validerSerie(el, i));

  // Swipe gauche/droite pour changer d'exercice.
  brancherSwipe(el.querySelector('.player-corps'), (dir) => {
    const cible = focusIndex + (dir === 'gauche' ? 1 : -1);
    if (cible >= 0 && cible < n) { focusIndex = cible; rendrePlayer(el); }
  });

  brancherBarre(el);
  barreEtat = '';
  majBarre();
  verrouillerEcran();

  if (animerProchainRendu) {
    animerProchainRendu = false;
    animerDemarrage();
  }
}

// Valide la série courante depuis le player : lit la saisie, enregistre, relance
// la vue, et lance le repos imposé automatiquement.
async function validerSerie(el, i) {
  const valeur = Number(el.querySelector('.inp-valeur').value);
  if (!valeur || valeur <= 0) { toast('Renseigne une valeur (reps ou secondes).'); return; }
  const rpeBtn = el.querySelector('[data-rpe].actif');
  seance.entrees[i].sets.push({
    valeur,
    rpe: rpeBtn ? Number(rpeBtn.dataset.rpe) : null,
    echec: el.querySelector('[data-echec]').classList.contains('actif'),
  });
  await persister();
  await seanceEnCours(el);
  demarrerRepos(seance.entrees[i].cible?.repos || reposDefaut);
}

function ajouterExercice(el) {
  choisirExercice({
    exercices: ctx.exercices,
    contraintes: seance.contraintes,
    onChoisi: async (id) => {
      seance.entrees.push({ exerciceId: id, sets: [] });
      focusIndex = seance.entrees.length - 1;
      await persister();
      seanceEnCours(el);
    },
  });
}

// Détecte un balayage horizontal net (et pas un scroll vertical).
function brancherSwipe(zone, onSwipe) {
  if (!zone) return;
  let x0 = null;
  let y0 = null;
  zone.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  zone.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 'gauche' : 'droite');
    x0 = null;
  }, { passive: true });
}

// Décompte de démarrage 3·2·1·GO (sons réutilisés) — l'impression que « ça part ».
function animerDemarrage() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ov = document.createElement('div');
  ov.className = 'demarrage-overlay';
  document.body.appendChild(ov);
  const etapes = ['3', '2', '1', 'GO'];
  let k = 0;
  const fin = () => { clearInterval(timer); ov.remove(); };
  const montre = () => {
    ov.innerHTML = `<div class="demarrage-num">${etapes[k]}</div><button class="btn demarrage-skip">Passer</button>`;
    ov.querySelector('.demarrage-skip').addEventListener('click', fin);
    etapes[k] === 'GO' ? go() : tick();
    k++;
  };
  montre();
  const timer = setInterval(() => {
    if (k >= etapes.length) { clearInterval(timer); setTimeout(fin, 350); return; }
    montre();
  }, 750);
}

function demanderFullscreen() {
  document.documentElement.requestFullscreen?.().catch(() => {});
}
function quitterFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

// Filet de sécurité : si l'utilisateur quitte la route séance autrement que par
// Terminer/Abandonner, on rétablit la nav et on sort du plein écran.
let seanceListenersInit = false;
function initSeanceGlobalListeners() {
  if (seanceListenersInit) return;
  seanceListenersInit = true;
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#/seance')) {
      document.body.classList.remove('mode-seance');
      quitterFullscreen();
    }
  });
}

// --- Vue liste (repli) : vue d'ensemble de toute la séance -------------------------

function rendreListe(el) {
  document.body.classList.remove('mode-seance'); // la nav réapparaît
  const heure = new Date(seance.dateDebut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  el.innerHTML = `
    <div class="entete-seance">
      <h1>${seance.programme ? seance.programme.nom + ' — ' + seance.programme.jour : 'Séance en cours'}</h1>
      <span class="texte-2">démarrée à ${heure}</span>
    </div>
    ${resumeContraintes()}
    ${bannieresAjustement()}
    ${seance.echauffement?.length ? '<button class="chip-lien" id="btn-echauffement-liste">🔥 Échauffement</button>' : ''}
    <button class="btn btn-accent btn-large" id="btn-plein-ecran">▶ Reprendre en plein écran</button>
    <div class="liste">${seance.entrees.map(carteEntree).join('') ||
      '<p class="texte-2 centre">Ajoute un premier exercice 👇</p>'}</div>
    <button class="btn btn-large" id="btn-ajouter-exo">+ Ajouter un exercice</button>
    <div class="ligne-2">
      <button class="btn btn-accent btn-large" id="btn-terminer">Terminer la séance</button>
      <button class="btn btn-danger btn-large" id="btn-abandonner">Abandonner</button>
    </div>
    <label class="ligne-repos">Repos auto
      <input id="inp-repos" type="number" inputmode="numeric" value="${reposDefaut}"> s ·
      Prépa tenue <input id="inp-prepa" type="number" inputmode="numeric" value="${prepaDefaut}"> s
    </label>
    <div class="espace-barre"></div>
    <div id="barre-chrono" class="barre-chrono"></div>`;

  el.querySelector('#btn-plein-ecran').addEventListener('click', () => {
    modeListe = false;
    demanderFullscreen();
    seanceEnCours(el);
  });

  el.querySelector('#btn-ajouter-exo').addEventListener('click', () => ajouterExercice(el));

  el.querySelector('#btn-echauffement-liste')?.addEventListener('click', () =>
    afficherChecklist({ titre: '🔥 Échauffement', items: seance.echauffement }));

  el.querySelector('#btn-terminer').addEventListener('click', async () => {
    if (!seance.entrees.some((e) => e.sets.length)) {
      toast('Logge au moins un set avant de terminer.');
      return;
    }
    if (await confirmer('Terminer et enregistrer la séance ?', { oui: 'Terminer' })) await terminer();
  });

  el.querySelector('#btn-abandonner').addEventListener('click', async () => {
    if (!(await confirmer('Abandonner la séance ? Rien ne sera enregistré.', { oui: 'Abandonner', danger: true }))) return;
    seance = null;
    await setReglage('seance_en_cours', null);
    stopChrono();
    libererEcran();
    quitterFullscreen();
    vueSeance(el);
  });

  el.querySelector('#inp-repos').addEventListener('change', (e) => {
    setReglage('dureeRepos', Number(e.target.value) || 90);
  });
  el.querySelector('#inp-prepa').addEventListener('change', (e) => {
    setReglage('dureePrepa', Math.max(0, Number(e.target.value) || 0));
  });

  // Bannières d'ajustement (modulation / énergie / temps) : appliquer ou ignorer.
  el.querySelectorAll('[data-ajust]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const [type, action] = btn.dataset.ajust.split('-');
      if (type === 'modulation' && action === 'retablir') {
        for (const e of seance.entrees) if (e.cibleOrigine) e.cible = { ...e.cibleOrigine };
        toast('Cibles normales rétablies ✓');
      }
      if (type === 'readiness' && action === 'moins') {
        for (const e of seance.entrees) if (e.cible && e.cible.sets > 1) e.cible.sets -= 1;
        toast('Cibles allégées d\'un set ✓');
      }
      if (type === 'readiness' && action === 'plus') {
        for (const e of seance.entrees) {
          const ex = ctx.exercices.get(e.exerciceId);
          if (e.cible && !ex?.skill && e.cible.sets < 5) e.cible.sets += 1;
        }
        toast('Un set ajouté sur la force ✓');
      }
      if (type === 'temps' && action === 'appliquer') {
        const plan = proposerSeanceRaccourcie(seance.entrees, ctx.exercices, seance.contraintes.tempsDispo);
        if (plan) {
          const garder = new Set(plan.garder);
          seance.entrees = seance.entrees.filter((_, i) => garder.has(i));
          toast(`Séance raccourcie · ${plan.nomsRetires.length} exo(s) retiré(s) ✓`);
        }
      }
      seance.ajustements[type] = action;
      await persister();
      seanceEnCours(el);
    }));

  el.querySelectorAll('[data-remplacer]').forEach((btn) =>
    btn.addEventListener('click', () => ouvrirRemplacement(el, Number(btn.dataset.remplacer))));

  el.querySelectorAll('[data-fiche]').forEach((btn) =>
    btn.addEventListener('click', () =>
      ouvrirFiche(ctx.exercices.get(seance.entrees[Number(btn.dataset.fiche)].exerciceId))));

  el.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [i, delta] = btn.dataset.step.split(':').map(Number);
      const inp = el.querySelector(`.form-set[data-i="${i}"] .inp-valeur`);
      inp.value = Math.max(1, (Number(inp.value) || 0) + delta);
    }));

  el.querySelectorAll('[data-rpe]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const actif = btn.classList.contains('actif');
      btn.closest('.ligne-rpe').querySelectorAll('[data-rpe]').forEach((x) => x.classList.remove('actif'));
      if (!actif) btn.classList.add('actif');
    }));
  el.querySelectorAll('[data-echec]').forEach((btn) =>
    btn.addEventListener('click', () => btn.classList.toggle('actif')));

  el.querySelectorAll('[data-add-set]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.addSet);
      const carte = btn.closest('.carte-exo');
      const valeur = Number(carte.querySelector('.inp-valeur').value);
      if (!valeur || valeur <= 0) {
        toast('Renseigne une valeur (reps ou secondes).');
        return;
      }
      seance.entrees[i].sets.push({
        valeur,
        rpe: Number(carte.querySelector('[data-rpe].actif')?.dataset.rpe.split(':')[1]) || null,
        echec: carte.querySelector('[data-echec]').classList.contains('actif'),
      });
      await persister();
      await seanceEnCours(el);
      demarrerRepos(seance.entrees[i].cible?.repos || reposDefaut);
    }));

  el.querySelectorAll('[data-chrono]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.chrono);
      if (chrono.mode === 'tenue' && chrono.exoIndex === i) arreterTenueEtRemplir();
      else if (chrono.mode === 'idle' || chrono.mode === 'repos') demarrerPrepa(i, prepaDefaut);
    }));

  el.querySelectorAll('[data-suppr-set]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const [i, j] = btn.dataset.supprSet.split(':').map(Number);
      seance.entrees[i].sets.splice(j, 1);
      await persister();
      seanceEnCours(el);
    }));

  el.querySelectorAll('[data-suppr-exo]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.supprExo);
      const ex = ctx.exercices.get(seance.entrees[i].exerciceId);
      if (seance.entrees[i].sets.length && !(await confirmer(`Retirer ${ex?.nom} et ses sets ?`, { oui: 'Retirer', danger: true }))) return;
      seance.entrees.splice(i, 1);
      await persister();
      seanceEnCours(el);
    }));

  brancherBarre(el);
  barreEtat = '';
  majBarre();
  verrouillerEcran();
}

// Câble la barre de chrono (délégation ; contenu re-rendu par majBarre).
function brancherBarre(el) {
  el.querySelector('#barre-chrono').addEventListener('click', (e) => {
    const act = e.target.dataset.chronoAct;
    if (!act) return;
    if (act === 'moins') ajusterOuPending(-15);
    else if (act === 'plus') ajusterOuPending(15);
    else if (act === 'demarrer') demarrerRepos(chrono.pending || reposDefaut);
    else if (act === 'pause') basculerPause();
    else if (act === 'stop') stopChrono();
    else if (act === 'go') demarrerTenue(chrono.exoIndex);
    else if (act === 'stopTenue') arreterTenueEtRemplir();
  });
}

function resumeContraintes() {
  const c = seance.contraintes;
  const morceaux = [
    c.materiel.length ? 'Matériel : ' + c.materiel.map(libelle).join(', ') : 'Sans matériel',
  ];
  if (c.douleurs.length) morceaux.push('⚠ ' + c.douleurs.map(libelle).join(', '));
  if (c.tempsDispo) morceaux.push(c.tempsDispo + ' min');
  morceaux.push('énergie ' + c.energie);
  return `<div class="texte-2 resume-contraintes">${morceaux.join(' · ')}</div>`;
}

// Suggestions d'ajustement du volume / de l'ordre, jamais imposées.
function bannieresAjustement() {
  const c = seance.contraintes;
  seance.ajustements = seance.ajustements || {};
  const bans = [];

  if (seance.modulation && !seance.ajustements.modulation) {
    bans.push(`
      <div class="carte banniere">
        <span>💡 ${seance.modulation.raison} → cibles à ${Math.round(seance.modulation.facteur * 100)} %</span>
        <span class="banniere-actions">
          <button class="btn" data-ajust="modulation-retablir">Rétablir</button>
          <button class="btn btn-accent" data-ajust="modulation-garder">OK</button>
        </span>
      </div>`);
  }

  // Autorégulation « forme du jour » : module le VOLUME dans les deux sens.
  const r = seance.readiness;
  if (r && r.niveau !== 'normale' && !seance.ajustements.readiness) {
    const pourquoi = r.raisons.join(' + ');
    if (r.niveau === 'basse') {
      const aCibles = seance.entrees.some((e) => e.cible && e.cible.sets > 1);
      bans.push(`
        <div class="carte banniere">
          <span>💡 Forme en baisse (${pourquoi}) → ${aCibles ? 'alléger d\'un set et viser RPE ≤ 8 ?' : 'vise un set de moins et RPE ≤ 8.'}</span>
          <span class="banniere-actions">
            ${aCibles ? '<button class="btn btn-accent" data-ajust="readiness-moins">−1 set</button>' : ''}
            <button class="btn" data-ajust="readiness-ignorer">OK</button>
          </span>
        </div>`);
    } else {
      const aForce = seance.entrees.some((e) => e.cible && !ctx.exercices.get(e.exerciceId)?.skill);
      bans.push(`
        <div class="carte banniere">
          <span>💡 Bonne forme (${pourquoi}) → ${aForce ? 'ajouter un set sur le travail de force ?' : 'tu peux pousser un peu plus que d\'habitude.'}</span>
          <span class="banniere-actions">
            ${aForce ? '<button class="btn btn-accent" data-ajust="readiness-plus">+1 set</button>' : ''}
            <button class="btn" data-ajust="readiness-ignorer">OK</button>
          </span>
        </div>`);
    }
  }

  if (c.tempsDispo && !seance.ajustements.temps && seance.entrees.length > 1) {
    const plan = proposerSeanceRaccourcie(seance.entrees, ctx.exercices, c.tempsDispo);
    if (plan) {
      bans.push(`
        <div class="carte banniere">
          <span>💡 ~${plan.dureeAvant} min prévues pour ${c.tempsDispo} dispo → retirer ${plan.nomsRetires.join(', ')} et garder le skill + les compounds (~${plan.dureeApres} min) ?</span>
          <span class="banniere-actions">
            <button class="btn btn-accent" data-ajust="temps-appliquer">Raccourcir</button>
            <button class="btn" data-ajust="temps-ignorer">OK</button>
          </span>
        </div>`);
    }
  }

  return bans.join('');
}

function carteEntree(entree, i) {
  const ex = ctx.exercices.get(entree.exerciceId);
  if (!ex) return '';
  const estHold = ex.type === 'hold';
  const unite = estHold ? 's' : 'reps';
  const verif = verifierExercice(ex, seance.contraintes);
  const prevu = entree.remplace ? ctx.exercices.get(entree.remplace.exerciceIdPrevu) : null;
  // Valeur pré-remplie : dernier set (répéter en un tap), sinon la cible.
  const dernier = entree.sets[entree.sets.length - 1];
  const valeurDefaut = dernier?.valeur ?? entree.cible?.valeur ?? '';

  const sets = entree.sets.map((s, j) => `
    <div class="set ${s.echec ? 'set-echec' : ''}">
      <span class="texte-2">Set ${j + 1}</span>
      <strong>${s.valeur} ${unite}</strong>
      <span class="texte-2 set-meta">${s.rpe ? 'RPE ' + s.rpe : ''}${s.echec ? ' · échec' : ''}</span>
      <button class="btn-x" data-suppr-set="${i}:${j}">×</button>
    </div>`).join('');

  return `
    <div class="carte carte-exo">
      <div class="carte-exo-tete">
        <div>
          <button class="lien-nom" data-fiche="${i}">${ex.nom}</button>
          <span class="badge">${estHold ? 'tenue' : 'reps'}</span>
          ${entree.cible ? `<span class="badge badge-accent">objectif ${entree.cible.sets}×${entree.cible.valeur}${estHold ? ' s' : ''}</span>` : ''}
        </div>
        <div>
          <button class="btn-x" data-remplacer="${i}" title="Remplacer par une alternative">⇄</button>
          <button class="btn-x" data-suppr-exo="${i}">×</button>
        </div>
      </div>
      ${prevu ? `<div class="texte-2">⇄ remplace ${prevu.nom} · ${entree.remplace.raison}</div>` : ''}
      ${verif.ok ? '' : `<div class="texte-attention">⚠ ${verif.raisons.join(' · ')} · touche ⇄ pour une alternative</div>`}
      ${sets}
      <div class="form-set" data-i="${i}">
        <button class="btn btn-step" data-step="${i}:-1">−</button>
        <input type="number" min="1" inputmode="numeric" placeholder="${unite}"
               class="inp-valeur" value="${valeurDefaut}">
        <button class="btn btn-step" data-step="${i}:1">+</button>
        ${estHold ? `<button class="btn btn-chrono" data-chrono="${i}">⏱</button>` : ''}
        <button class="btn btn-accent" data-add-set="${i}">OK</button>
      </div>
      <div class="ligne-rpe">
        <span class="texte-2">RPE</span>
        ${[6, 7, 8, 9, 10].map((v) => `<button class="rpe-btn" data-rpe="${i}:${v}">${v}</button>`).join('')}
        <button class="rpe-btn chip-echec" data-echec="${i}">échec</button>
      </div>
    </div>`;
}

// --- Barre de chrono (repos / prépa / tenue) --------------------------------------
// Machine à états unique, toujours visible en bas de l'écran séance.
// Les timers utilisent des horodatages (pas de décrément) : ils restent justes
// même si l'onglet est mis en veille quelques secondes.

let chrono = { mode: 'idle' }; // idle | repos {fin,total,pause} | prepa {fin,exoIndex} | tenue {debut,exoIndex}
let chronoTimer = null;
let barreEtat = ''; // clé du dernier rendu, pour ne reconstruire le DOM qu'au changement de mode

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function demarrerRepos(secondes) {
  chrono = { mode: 'repos', fin: Date.now() + secondes * 1000, total: secondes, pause: null };
  lancerTick();
  majBarre();
}

function demarrerPrepa(i, prepa) {
  if (prepa <= 0) { demarrerTenue(i); return; }
  chrono = { mode: 'prepa', fin: Date.now() + prepa * 1000, exoIndex: i, dernierTick: null };
  lancerTick();
  majBarre();
}

function demarrerTenue(i) {
  chrono = { mode: 'tenue', debut: Date.now(), exoIndex: i };
  go(); // signal sonore + vibration : c'est parti
  lancerTick();
  majBarre();
}

function arreterTenueEtRemplir() {
  const secondes = Math.max(1, Math.round((Date.now() - chrono.debut) / 1000));
  // En player il n'y a qu'un champ ; en liste, celui de l'exercice concerné.
  const champ = document.querySelector('.player .inp-valeur')
    || document.querySelector(`.form-set[data-i="${chrono.exoIndex}"] .inp-valeur`);
  if (champ) champ.value = secondes;
  stopChrono();
  toast(`Tenue : ${secondes} s · valide la série`);
}

function stopChrono() {
  chrono = { mode: 'idle', pending: reposDefaut };
  clearInterval(chronoTimer);
  chronoTimer = null;
  majBarre();
}

// −15/+15 : ajuste le repos en cours, ou la durée « prête » quand on est à l'arrêt.
function ajusterOuPending(delta) {
  if (chrono.mode === 'idle') {
    chrono.pending = Math.max(15, (chrono.pending || reposDefaut) + delta);
    majBarre();
  } else if (chrono.mode === 'repos') {
    ajusterRepos(delta);
  }
}

function ajusterRepos(delta) {
  if (chrono.mode !== 'repos') return;
  if (chrono.pause !== null) chrono.pause = Math.max(0, chrono.pause + delta * 1000);
  else chrono.fin = Math.max(Date.now(), chrono.fin + delta * 1000);
  majBarre();
}

function basculerPause() {
  if (chrono.mode !== 'repos') return;
  if (chrono.pause !== null) {
    chrono.fin = Date.now() + chrono.pause;
    chrono.pause = null;
  } else {
    chrono.pause = Math.max(0, chrono.fin - Date.now());
  }
  majBarre();
}

function lancerTick() {
  if (chronoTimer) return;
  chronoTimer = setInterval(() => {
    if (chrono.mode === 'repos' && chrono.pause === null && Date.now() >= chrono.fin) {
      stopChrono();
      bip();
      toast('Repos terminé, au boulot 💪');
      return;
    }
    if (chrono.mode === 'prepa') {
      const restant = Math.ceil((chrono.fin - Date.now()) / 1000);
      if (restant <= 3 && restant >= 1 && chrono.dernierTick !== restant) {
        chrono.dernierTick = restant;
        tick(); // décompte 3… 2… 1…
      }
      if (restant <= 0) {
        demarrerTenue(chrono.exoIndex);
        return;
      }
    }
    majBarre();
  }, 200);
}

function majBarre() {
  const barre = document.getElementById('barre-chrono');
  if (!barre) { // plus sur l'écran séance : on coupe le tick
    clearInterval(chronoTimer);
    chronoTimer = null;
    return;
  }

  const nomExo = chrono.exoIndex !== undefined
    ? ctx.exercices.get(seance?.entrees[chrono.exoIndex]?.exerciceId)?.nom || ''
    : '';
  const cle = chrono.mode + (chrono.mode === 'repos' && chrono.pause !== null ? '-pause' : '');

  if (cle !== barreEtat) {
    barreEtat = cle;
    if (chrono.mode === 'idle') {
      // Repos imposé par défaut, ajustable −15/+15, lancé au ▶.
      barre.className = 'barre-chrono';
      barre.innerHTML = `
        <span class="barre-label">Repos</span>
        <button data-chrono-act="moins">−15</button>
        <span class="barre-temps"></span>
        <button data-chrono-act="plus">+15</button>
        <button class="btn-demarrer-repos" data-chrono-act="demarrer">▶</button>`;
    } else if (chrono.mode === 'repos') {
      barre.className = 'barre-chrono barre-active';
      barre.innerHTML = `
        <div class="barre-ligne"></div>
        <button data-chrono-act="moins">−15</button>
        <span class="barre-temps"></span>
        <button data-chrono-act="plus">+15</button>
        <button data-chrono-act="pause">${chrono.pause !== null ? '▶' : '⏸'}</button>
        <button data-chrono-act="stop">✕</button>`;
    } else if (chrono.mode === 'prepa') {
      barre.className = 'barre-chrono barre-active';
      barre.innerHTML = `
        <span class="barre-label">Prépa · ${nomExo}</span>
        <span class="barre-temps grand"></span>
        <button data-chrono-act="go">GO direct</button>
        <button data-chrono-act="stop">✕</button>`;
    } else if (chrono.mode === 'tenue') {
      barre.className = 'barre-chrono barre-tenue';
      barre.innerHTML = `
        <div class="barre-ligne"></div>
        <span class="barre-label">Tenue · ${nomExo}</span>
        <span class="barre-temps grand"></span>
        <button class="btn-stop-tenue" data-chrono-act="stopTenue">■ Stop</button>`;
    }
  }

  // Mise à jour légère (temps + ligne de progression) sans reconstruire le DOM.
  const temps = barre.querySelector('.barre-temps');
  if (chrono.mode === 'idle') {
    if (temps) temps.textContent = fmt(chrono.pending || reposDefaut);
  } else if (chrono.mode === 'repos') {
    const restantMs = chrono.pause !== null ? chrono.pause : chrono.fin - Date.now();
    const restant = Math.max(0, Math.ceil(restantMs / 1000));
    temps.textContent = fmt(restant);
    const ligne = barre.querySelector('.barre-ligne');
    if (ligne) ligne.style.width = `${100 * (1 - restant / chrono.total)}%`;
  } else if (chrono.mode === 'prepa') {
    temps.textContent = Math.max(0, Math.ceil((chrono.fin - Date.now()) / 1000));
  } else if (chrono.mode === 'tenue') {
    const ecoule = Math.max(0, Math.round((Date.now() - chrono.debut) / 1000));
    temps.textContent = fmt(ecoule);
    // La Ligne se remplit vers la cible de tenue du programme (si connue).
    const cible = seance?.entrees[chrono.exoIndex]?.cible;
    const ligne = barre.querySelector('.barre-ligne');
    if (ligne) ligne.style.width = cible ? `${Math.min(100, (ecoule / cible.valeur) * 100)}%` : '0';
  }
}

// --- Wake Lock : l'écran reste allumé pendant la séance ---------------------------

let wakeLock = null;
let wakeLockSurveille = false;

async function verrouillerEcran() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* non supporté ou refusé : sans gravité */ }
  if (!wakeLockSurveille) {
    wakeLockSurveille = true;
    // Le wake lock est libéré par le navigateur quand l'onglet passe en
    // arrière-plan : on le redemande au retour si la séance est toujours là.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && seance) verrouillerEcran();
    });
  }
}

function libererEcran() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// --- Fiche express (consignes sans quitter la séance) ------------------------------

async function ouvrirFiche(ex) {
  if (!ex) return;
  const pr = await getPR(ex.id);
  const record = [];
  if (pr?.maxReps) record.push(pr.maxReps.valeur + ' reps');
  if (pr?.maxHold) record.push(pr.maxHold.valeur + ' s');

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="feuille">
      <div class="feuille-tete">
        <strong>${ex.nom}</strong>
        <button class="btn-x" data-fermer>×</button>
      </div>
      <div class="fiche-express">
        ${record.length ? `<div class="carte accent">Record : ${record.join(' · ')}</div>` : ''}
        <h3>Consignes</h3>
        <p>${ex.consignes}</p>
        <h3>Erreurs fréquentes</h3>
        <ul>${ex.erreurs_frequentes.map((e) => `<li>${e}</li>`).join('')}</ul>
        <h3>Muscles</h3>
        <p class="texte-2">${ex.muscles_primaires.map(libelle).join(', ')}${
          ex.muscles_secondaires.length ? ' · secondaires : ' + ex.muscles_secondaires.map(libelle).join(', ') : ''}</p>
        ${ex.zones_a_risque.length ? `
          <div class="chips">${ex.zones_a_risque.map((z) => `<span class="chip-attention">${libelle(z)}</span>`).join('')}</div>` : ''}
        <a class="btn btn-large" href="#/exercices/${ex.id}">Fiche complète →</a>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-fermer]') || e.target.closest('a')) {
      overlay.remove();
    }
  });
}

// --- Remplacement par une alternative du moteur ----------------------------------

async function ouvrirRemplacement(el, i) {
  const entree = seance.entrees[i];
  const ex = ctx.exercices.get(entree.exerciceId);
  const verif = verifierExercice(ex, seance.contraintes);
  let cause = verif.ok ? 'trop_dur' : 'contrainte';
  // PR connus → le moteur préfère un remplaçant déjà calibré (tie-breaker).
  const prs = new Map((await dbGetAll('pr')).map((p) => [p.exerciceId, p]));

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const rendre = () => {
    const causeTxt = texteCause(cause, ex, seance.contraintes);
    const alts = proposerAlternatives(ex, ctx.exercices, seance.contraintes, cause, prs);

    overlay.innerHTML = `
      <div class="feuille">
        <div class="feuille-tete">
          <strong>Remplacer « ${ex.nom} »</strong>
          <button class="btn-x" data-fermer>×</button>
        </div>
        <div class="chips">
          ${[['contrainte', 'Contrainte du jour'], ['trop_dur', 'Trop dur'], ['trop_facile', 'Trop facile']]
            .map(([id, nom]) => `<button class="chip-lien ${cause === id ? 'chip-actif' : ''}" data-cause="${id}">${nom}</button>`).join('')}
        </div>
        <p class="texte-2">Pourquoi : ${causeTxt}</p>
        <div class="picker-liste">
          ${alts.map((a) => `
            <button class="picker-item" data-alt="${a.exercice.id}">
              <span>${a.exercice.nom}<br>
                <small class="texte-2">${a.lien} · difficulté ${a.exercice.difficulte}/10</small></span>
              <span class="texte-2">${a.exercice.type === 'hold' ? 'tenue' : 'reps'}</span>
            </button>`).join('')
          || '<p class="texte-2 centre">Aucune alternative compatible avec les contraintes du jour.<br>Choisis manuellement via « + Ajouter un exercice ».</p>'}
        </div>
      </div>`;

    overlay.querySelector('[data-fermer]').addEventListener('click', () => overlay.remove());
    overlay.querySelectorAll('[data-cause]').forEach((b) =>
      b.addEventListener('click', () => { cause = b.dataset.cause; rendre(); }));
    overlay.querySelectorAll('[data-alt]').forEach((b) =>
      b.addEventListener('click', async () => {
        await remplacer(i, b.dataset.alt, causeTxt);
        overlay.remove();
        seanceEnCours(el);
      }));
  };
  rendre();
}

async function remplacer(i, altId, raison) {
  const entree = seance.entrees[i];
  const ancien = ctx.exercices.get(entree.exerciceId);
  const alt = ctx.exercices.get(altId);
  // La cible est reprise ; la valeur n'a de sens que si le type ne change pas
  // (reps ↔ secondes), sinon on repart d'une valeur par défaut raisonnable.
  const cible = entree.cible
    ? {
        sets: entree.cible.sets,
        valeur: ancien.type === alt.type ? entree.cible.valeur : (alt.type === 'hold' ? 15 : 8),
        repos: entree.cible.repos,
      }
    : null;
  const nouvelle = {
    exerciceId: altId,
    sets: [],
    cible,
    remplace: { exerciceIdPrevu: ancien.id, raison },
  };
  // Des sets déjà loggés appartiennent à l'ancien exercice : on insère alors
  // le remplaçant à la suite au lieu d'écraser l'historique en cours.
  if (entree.sets.length) seance.entrees.splice(i + 1, 0, nouvelle);
  else seance.entrees[i] = nouvelle;
  await persister();
}

// --- Fin de séance ------------------------------------------------------------------

async function terminer() {
  stopChrono();
  libererEcran();
  document.body.classList.remove('mode-seance');
  quitterFullscreen();
  seance.dateFin = new Date().toISOString();
  // On ne garde que les entrées réellement travaillées.
  seance.entrees = seance.entrees.filter((e) => e.sets.length);
  // Patterns réellement travaillés → étirements post-séance adaptés (capturés
  // avant que `seance` soit remis à null).
  const patternsTravailles = [...new Set(
    seance.entrees.map((e) => ctx.exercices.get(e.exerciceId)?.pattern).filter(Boolean))];
  await dbPut('sessions', seance);
  const nouveauxPR = await majPRDepuisSession(seance, ctx.exercices);

  // Double progression : le programme généré fait évoluer ses cibles selon la
  // séance réalisée (chaque changement est journalisé avec sa raison).
  let nbEvolutions = 0;
  if (seance.programme?.id) {
    const prog = await dbGet('programmes', seance.programme.id);
    if (prog?.genere) {
      const changements = evoluerCibles(prog, seance, ctx.exercices);
      if (changements.length) {
        await dbPut('programmes', prog);
        nbEvolutions = changements.length;
      }
    }
  }

  seance = null;
  await setReglage('seance_en_cours', null);

  // Le moteur a-t-il des suggestions (palier atteint, deload, plateau) à montrer ?
  const sessions = await dbGetAll('sessions');
  const etats = new Map();
  for (const skill of ctx.skills) etats.set(skill.id, await getEtatSkill(skill));
  const nbSuggestions = suggestionsPalier(sessions, ctx.skills, etats).length
    + suggestionsDeload(sessions, ctx.exercices).length
    + suggestionsPlateau(sessions, ctx.exercices).length;

  let message = nouveauxPR.length
    ? `Séance enregistrée · ${nouveauxPR.length} nouveau${nouveauxPR.length > 1 ? 'x' : ''} PR 🎉`
    : 'Séance enregistrée ✓';
  if (nbEvolutions) message += ` · ${nbEvolutions} cible${nbEvolutions > 1 ? 's' : ''} du programme ajustée${nbEvolutions > 1 ? 's' : ''}`;
  if (nbSuggestions) message += ' · 💡 suggestions sur l\'Accueil';
  toast(message, 3600);
  // Étirements post-séance adaptés à ce qui a été travaillé : mémorisés
  // (récupérables depuis l'accueil si la feuille est fermée trop vite),
  // puis affichés par-dessus l'accueil. Jamais bloquant.
  const etirements = genererEtirements(patternsTravailles);
  if (etirements.length) {
    await setReglage('derniersEtirements', { date: new Date().toISOString(), liste: etirements });
  }
  location.hash = '#/accueil';
  if (etirements.length) {
    afficherChecklist({
      titre: '🧘 Étirements · récupération',
      note: 'Respiration lente, on ne force jamais — juste une tension confortable.',
      items: etirements,
    });
  }
}
