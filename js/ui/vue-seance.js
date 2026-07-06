// vue-seance.js — feature 2 : log de séance en direct (+ démarrage depuis un
// template, feature 3, et intégration du moteur d'adaptation, feature 5) :
// filtre matériel, avertissements explicables, remplacement d'exercice par
// alternatives classées, bannières d'ajustement énergie / temps.
// Le brouillon est persisté : une séance en cours survit à un rechargement.

import { ctx } from '../app.js';
import { dbGet, dbGetAll, dbPut, getReglage, setReglage } from '../db.js';
import { majPRDepuisSession } from '../pr.js';
import { getEtatSkill } from '../skills.js';
import {
  verifierExercice, proposerAlternatives, texteCause,
  suggestionsPalier, suggestionsDeload,
} from '../moteur/adaptation.js';
import { evoluerCibles, modulationSeance } from '../moteur/generateur.js';
import { toast, chronoRepos, arreterChrono, libelle, choisirExercice } from './composants.js';

const EQUIPEMENT_DEFAUT = ['barre', 'anneaux', 'parallettes', 'elastiques', 'surface_surelevee'];
const ZONES_DEFAUT = ['poignets', 'epaules', 'coudes', 'lombaires', 'genoux'];
const TEMPS_COURT = 30; // minutes en dessous desquelles on propose de prioriser

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
    // Depuis un template : les exercices sont pré-remplis avec leur cible.
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
    <label class="ligne-repos">Repos :
      <input id="inp-repos" type="number" inputmode="numeric" value="${dureeRepos}"> s
      <span class="texte-2">(chrono auto après chaque set)</span></label>`;

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
    arreterChrono();
    vueSeance(el);
  });

  el.querySelector('#inp-repos').addEventListener('change', (e) => {
    setReglage('dureeRepos', Number(e.target.value) || 90);
  });

  // Bannières d'ajustement (énergie faible / temps court) : appliquer ou ignorer.
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

  // Ajout d'un set (recharge la vue puis lance le chrono de repos).
  el.querySelectorAll('[data-add-set]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.addSet);
      const form = el.querySelector(`.form-set[data-i="${i}"]`);
      const valeur = Number(form.querySelector('.inp-valeur').value);
      if (!valeur || valeur <= 0) {
        toast('Renseigne une valeur (reps ou secondes).');
        return;
      }
      seance.entrees[i].sets.push({
        valeur,
        rpe: Number(form.querySelector('.sel-rpe').value) || null,
        echec: form.querySelector('.inp-echec').checked,
      });
      await persister();
      await seanceEnCours(el);
      // Repos suggéré par le programme pour cet exercice, sinon réglage global.
      chronoRepos(seance.entrees[i].cible?.repos
        || Number(el.querySelector('#inp-repos').value) || 90);
    }));

  // Chrono de tenue pour les isométriques (démarrer / arrêter → remplit le champ).
  el.querySelectorAll('[data-chrono]').forEach((btn) =>
    btn.addEventListener('click', () => toggleTenue(el, Number(btn.dataset.chrono))));

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
  // Avertissement non bloquant si l'exercice entre en conflit avec les
  // contraintes du jour (matériel absent, zone douloureuse sollicitée).
  const verif = verifierExercice(ex, seance.contraintes);
  const prevu = entree.remplace ? ctx.exercices.get(entree.remplace.exerciceIdPrevu) : null;

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
          <strong>${ex.nom}</strong> <span class="badge">${estHold ? 'tenue' : 'reps'}</span>
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
        <input type="number" min="1" inputmode="numeric" placeholder="${unite}" class="inp-valeur">
        ${estHold ? `<button class="btn btn-chrono" data-chrono="${i}">⏱</button>` : ''}
        <select class="sel-rpe">
          <option value="">RPE</option>
          ${Array.from({ length: 10 }, (_, k) => `<option>${k + 1}</option>`).join('')}
        </select>
        <label class="chk-echec"><input type="checkbox" class="inp-echec">échec</label>
        <button class="btn btn-accent" data-add-set="${i}">OK</button>
      </div>
    </div>`;
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

// --- Chrono de tenue (compte vers le haut, remplit le champ valeur) -------------

let tenue = null; // { i, debut, interval }

function toggleTenue(el, i) {
  const form = el.querySelector(`.form-set[data-i="${i}"]`);
  const btn = form.querySelector('[data-chrono]');
  if (tenue && tenue.i === i) {
    const s = Math.max(1, Math.round((Date.now() - tenue.debut) / 1000));
    clearInterval(tenue.interval);
    tenue = null;
    form.querySelector('.inp-valeur').value = s;
    btn.textContent = '⏱';
    btn.classList.remove('actif');
  } else if (!tenue) {
    tenue = {
      i,
      debut: Date.now(),
      interval: setInterval(() => {
        btn.textContent = Math.round((Date.now() - tenue.debut) / 1000) + 's';
      }, 250),
    };
    btn.classList.add('actif');
  }
}

// --- Fin de séance ------------------------------------------------------------------

async function terminer() {
  arreterChrono();
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
