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
  suggestionsPalier, suggestionsDeload,
} from '../moteur/adaptation.js';
import { evoluerCibles, modulationSeance } from '../moteur/generateur.js';
import { toast, bip, tick, go, libelle, choisirExercice } from './composants.js';

const EQUIPEMENT_DEFAUT = ['barre', 'anneaux', 'parallettes', 'elastiques', 'surface_surelevee'];
const ZONES_DEFAUT = ['poignets', 'epaules', 'coudes', 'lombaires', 'genoux'];
const TEMPS_COURT = 30;    // minutes en dessous desquelles on propose de prioriser
const PREPA_DEFAUT = 5;    // secondes de mise en place avant le chrono de tenue
const REPOS_RAPIDES = [60, 90, 120, 180]; // durées à un tap dans la barre

let seance = null;   // séance en cours (miroir du brouillon persisté en base)
let chargee = false; // le brouillon a-t-il déjà été lu depuis IndexedDB ?

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
  return { prog, jour, jourIdx: ref.jourIdx };
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
      </div>` : ''}
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
    // Modulation (deload planifié / reprise après pause) pour un programme
    // généré : appliquée à la SÉANCE uniquement — le programme garde ses
    // cibles canoniques, et la bannière permet de rétablir.
    const modulation = template?.prog.genere
      ? modulationSeance(template.prog, await dbGetAll('sessions'))
      : null;
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
      contraintes: {
        materiel: cochees('#chips-materiel'),
        douleurs: cochees('#chips-douleurs'),
        tempsDispo: Number(el.querySelector('#inp-temps').value) || null,
        energie: el.querySelector('#sel-energie').value,
      },
      entrees,
      modulation,
      ajustements: {},
    };
    await setReglage('template_a_demarrer', null);
    await persister();
    vueSeance(el);
  });
}

const chip = (valeur) =>
  `<label class="chip"><input type="checkbox" value="${valeur}"><span>${libelle(valeur)}</span></label>`;

const cochees = (sel) =>
  [...document.querySelectorAll(`${sel} input:checked`)].map((i) => i.value);

// --- Séance en cours -----------------------------------------------------------

async function seanceEnCours(el) {
  const dureeRepos = await getReglage('dureeRepos', 90);
  const dureePrepa = await getReglage('dureePrepa', PREPA_DEFAUT);
  const heure = new Date(seance.dateDebut).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  el.innerHTML = `
    <div class="entete-seance">
      <h1>${seance.programme ? seance.programme.nom + ' — ' + seance.programme.jour : 'Séance en cours'}</h1>
      <span class="texte-2">démarrée à ${heure}</span>
    </div>
    ${resumeContraintes()}
    ${bannieresAjustement()}
    <div class="liste">${seance.entrees.map(carteEntree).join('') ||
      '<p class="texte-2 centre">Ajoute un premier exercice 👇</p>'}</div>
    <button class="btn btn-large" id="btn-ajouter-exo">+ Ajouter un exercice</button>
    <div class="ligne-2">
      <button class="btn btn-accent btn-large" id="btn-terminer">Terminer la séance</button>
      <button class="btn btn-danger btn-large" id="btn-abandonner">Abandonner</button>
    </div>
    <label class="ligne-repos">Repos auto
      <input id="inp-repos" type="number" inputmode="numeric" value="${dureeRepos}"> s ·
      Prépa tenue <input id="inp-prepa" type="number" inputmode="numeric" value="${dureePrepa}"> s
    </label>
    <div class="espace-barre"></div>
    <div id="barre-chrono" class="barre-chrono"></div>`;

  el.querySelector('#btn-ajouter-exo').addEventListener('click', () =>
    choisirExercice({
      exercices: ctx.exercices,
      contraintes: seance.contraintes,
      onChoisi: async (id) => {
        seance.entrees.push({ exerciceId: id, sets: [] });
        await persister();
        seanceEnCours(el);
      },
    }));

  el.querySelector('#btn-terminer').addEventListener('click', async () => {
    if (!seance.entrees.some((e) => e.sets.length)) {
      toast('Logge au moins un set avant de terminer.');
      return;
    }
    if (confirm('Terminer et enregistrer la séance ?')) await terminer();
  });

  el.querySelector('#btn-abandonner').addEventListener('click', async () => {
    if (!confirm('Abandonner la séance ? Rien ne sera enregistré.')) return;
    seance = null;
    await setReglage('seance_en_cours', null);
    stopChrono();
    libererEcran();
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
      if (type === 'energie' && action === 'appliquer') {
        for (const e of seance.entrees) if (e.cible) e.cible.sets = Math.max(1, e.cible.sets - 1);
        toast('Cibles réduites d\'un set ✓');
      }
      if (type === 'temps' && action === 'appliquer') {
        // Les exercices liés à un skill passent en premier (tri stable).
        seance.entrees.sort((a, b) =>
          (ctx.exercices.get(b.exerciceId)?.skill ? 1 : 0)
          - (ctx.exercices.get(a.exerciceId)?.skill ? 1 : 0));
        toast('Exercices de skill priorisés ✓');
      }
      seance.ajustements[type] = action;
      await persister();
      seanceEnCours(el);
    }));

  // Remplacement d'un exercice par une alternative du moteur.
  el.querySelectorAll('[data-remplacer]').forEach((btn) =>
    btn.addEventListener('click', () => ouvrirRemplacement(el, Number(btn.dataset.remplacer))));

  // Fiche express : consignes et erreurs sans quitter la séance.
  el.querySelectorAll('[data-fiche]').forEach((btn) =>
    btn.addEventListener('click', () =>
      ouvrirFiche(ctx.exercices.get(seance.entrees[Number(btn.dataset.fiche)].exerciceId))));

  // Steppers ± autour du champ valeur.
  el.querySelectorAll('[data-step]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [i, delta] = btn.dataset.step.split(':').map(Number);
      const inp = el.querySelector(`.form-set[data-i="${i}"] .inp-valeur`);
      inp.value = Math.max(1, (Number(inp.value) || 0) + delta);
    }));

  // RPE en boutons (tap pour sélectionner, re-tap pour désélectionner) + échec.
  el.querySelectorAll('[data-rpe]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const actif = btn.classList.contains('actif');
      btn.closest('.ligne-rpe').querySelectorAll('[data-rpe]').forEach((x) => x.classList.remove('actif'));
      if (!actif) btn.classList.add('actif');
    }));
  el.querySelectorAll('[data-echec]').forEach((btn) =>
    btn.addEventListener('click', () => btn.classList.toggle('actif')));

  // Ajout d'un set → recharge la vue puis lance le repos automatiquement.
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
      // Repos suggéré par le programme pour cet exercice, sinon réglage global.
      demarrerRepos(seance.entrees[i].cible?.repos || (await getReglage('dureeRepos', 90)));
    }));

  // Chrono de tenue : prépa (mise en place) → GO → compte, tap = stop + remplit.
  el.querySelectorAll('[data-chrono]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.chrono);
      if (chrono.mode === 'tenue' && chrono.exoIndex === i) {
        arreterTenueEtRemplir();
      } else if (chrono.mode === 'idle' || chrono.mode === 'repos') {
        demarrerPrepa(i, await getReglage('dureePrepa', PREPA_DEFAUT));
      }
    }));

  // Suppression d'un set ou d'un exercice.
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
      if (seance.entrees[i].sets.length && !confirm(`Retirer ${ex?.nom} et ses sets ?`)) return;
      seance.entrees.splice(i, 1);
      await persister();
      seanceEnCours(el);
    }));

  // Barre de chrono : délégation (le contenu est re-rendu par majBarre).
  el.querySelector('#barre-chrono').addEventListener('click', (e) => {
    const d = e.target.dataset;
    if (d.repos) { demarrerRepos(Number(d.repos)); return; }
    if (!d.chronoAct) return;
    if (d.chronoAct === 'moins') ajusterRepos(-15);
    if (d.chronoAct === 'plus') ajusterRepos(15);
    if (d.chronoAct === 'pause') basculerPause();
    if (d.chronoAct === 'stop') stopChrono();
    if (d.chronoAct === 'go') demarrerTenue(chrono.exoIndex);
    if (d.chronoAct === 'stopTenue') arreterTenueEtRemplir();
  });

  barreEtat = '';
  majBarre();
  verrouillerEcran(); // l'écran reste allumé pendant toute la séance
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

  if (c.energie === 'faible' && !seance.ajustements.energie) {
    const aCibles = seance.entrees.some((e) => e.cible && e.cible.sets > 1);
    bans.push(`
      <div class="carte banniere">
        <span>💡 Énergie faible → ${aCibles ? 'réduire les cibles d\'un set ?' : 'vise un set de moins que d\'habitude.'}</span>
        <span class="banniere-actions">
          ${aCibles ? '<button class="btn btn-accent" data-ajust="energie-appliquer">−1 set</button>' : ''}
          <button class="btn" data-ajust="energie-ignorer">OK</button>
        </span>
      </div>`);
  }

  if (c.tempsDispo && c.tempsDispo <= TEMPS_COURT && !seance.ajustements.temps && seance.entrees.length > 1) {
    bans.push(`
      <div class="carte banniere">
        <span>💡 ${c.tempsDispo} min → prioriser les exercices de skill ?</span>
        <span class="banniere-actions">
          <button class="btn btn-accent" data-ajust="temps-appliquer">Réordonner</button>
          <button class="btn" data-ajust="temps-ignorer">OK</button>
        </span>
      </div>`);
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
      ${prevu ? `<div class="texte-2">⇄ remplace ${prevu.nom} — ${entree.remplace.raison}</div>` : ''}
      ${verif.ok ? '' : `<div class="texte-attention">⚠ ${verif.raisons.join(' · ')} — touche ⇄ pour une alternative</div>`}
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
  const form = document.querySelector(`.form-set[data-i="${chrono.exoIndex}"]`);
  form?.querySelector('.inp-valeur') && (form.querySelector('.inp-valeur').value = secondes);
  stopChrono();
  toast(`Tenue : ${secondes} s — valide le set avec OK`);
}

function stopChrono() {
  chrono = { mode: 'idle' };
  clearInterval(chronoTimer);
  chronoTimer = null;
  majBarre();
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
      toast('Repos terminé — au boulot 💪');
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
      barre.className = 'barre-chrono';
      barre.innerHTML = `
        <span class="barre-label">Repos</span>
        ${REPOS_RAPIDES.map((s) => `<button class="barre-chip" data-repos="${s}">${fmt(s)}</button>`).join('')}`;
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
        <span class="barre-label">Prépa — ${nomExo}</span>
        <span class="barre-temps grand"></span>
        <button data-chrono-act="go">GO direct</button>
        <button data-chrono-act="stop">✕</button>`;
    } else if (chrono.mode === 'tenue') {
      barre.className = 'barre-chrono barre-tenue';
      barre.innerHTML = `
        <span class="barre-label">Tenue — ${nomExo}</span>
        <span class="barre-temps grand"></span>
        <button class="btn-stop-tenue" data-chrono-act="stopTenue">■ Stop</button>`;
    }
  }

  // Mise à jour légère (temps + ligne de progression) sans reconstruire le DOM.
  const temps = barre.querySelector('.barre-temps');
  if (chrono.mode === 'repos') {
    const restantMs = chrono.pause !== null ? chrono.pause : chrono.fin - Date.now();
    const restant = Math.max(0, Math.ceil(restantMs / 1000));
    temps.textContent = fmt(restant);
    const ligne = barre.querySelector('.barre-ligne');
    if (ligne) ligne.style.width = `${100 * (1 - restant / chrono.total)}%`;
  } else if (chrono.mode === 'prepa') {
    temps.textContent = Math.max(0, Math.ceil((chrono.fin - Date.now()) / 1000));
  } else if (chrono.mode === 'tenue') {
    temps.textContent = fmt(Math.max(0, Math.round((Date.now() - chrono.debut) / 1000)));
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

function ouvrirRemplacement(el, i) {
  const entree = seance.entrees[i];
  const ex = ctx.exercices.get(entree.exerciceId);
  const verif = verifierExercice(ex, seance.contraintes);
  let cause = verif.ok ? 'trop_dur' : 'contrainte';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const rendre = () => {
    const causeTxt = texteCause(cause, ex, seance.contraintes);
    const alts = proposerAlternatives(ex, ctx.exercices, seance.contraintes, cause);

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
  seance.dateFin = new Date().toISOString();
  // On ne garde que les entrées réellement travaillées.
  seance.entrees = seance.entrees.filter((e) => e.sets.length);
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

  // Le moteur a-t-il des suggestions (palier atteint, deload) à montrer ?
  const sessions = await dbGetAll('sessions');
  const etats = new Map();
  for (const skill of ctx.skills) etats.set(skill.id, await getEtatSkill(skill));
  const nbSuggestions = suggestionsPalier(sessions, ctx.skills, etats).length
    + suggestionsDeload(sessions, ctx.exercices).length;

  let message = nouveauxPR.length
    ? `Séance enregistrée — ${nouveauxPR.length} nouveau${nouveauxPR.length > 1 ? 'x' : ''} PR 🎉`
    : 'Séance enregistrée ✓';
  if (nbEvolutions) message += ` · ${nbEvolutions} cible${nbEvolutions > 1 ? 's' : ''} du programme ajustée${nbEvolutions > 1 ? 's' : ''}`;
  if (nbSuggestions) message += ' · 💡 suggestions sur l\'Accueil';
  toast(message, 3600);
  location.hash = '#/accueil';
}
