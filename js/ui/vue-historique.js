// vue-historique.js — feature 4 : suivi de progression.
// Trois onglets : historique des séances (+ volume), PR par exercice
// (+ courbe de progression au tap), log de poids de corps (+ courbe).

import { ctx } from '../app.js';
import { dbGetAll, dbPut, dbSupprimer } from '../db.js';
import { recalculerTousPR } from '../pr.js';
import { toast, graphiqueLigne, confirmer, libelle } from './composants.js';

export async function vueHistorique(el, params) {
  const onglet = params[0] || 'seances';
  const rendu = { seances: ongletSeances, volume: ongletVolume, pr: ongletPR, poids: ongletPoids }[onglet] || ongletSeances;

  el.innerHTML = `
    <h1>Suivi</h1>
    <div class="onglets">
      ${[['seances', 'Séances'], ['volume', 'Volume'], ['pr', 'PR'], ['poids', 'Poids']]
        .map(([id, nom]) => `<a href="#/historique/${id}" class="${id === onglet ? 'actif' : ''}">${nom}</a>`)
        .join('')}
    </div>
    <div id="onglet-contenu"></div>`;

  await rendu(el.querySelector('#onglet-contenu'));
}

// --- Onglet Séances ---------------------------------------------------------

async function ongletSeances(el) {
  const sessions = (await dbGetAll('sessions')).sort((a, b) => b.dateDebut.localeCompare(a.dateDebut));
  if (!sessions.length) {
    el.innerHTML = '<p class="texte-2 centre">Aucune séance loggée pour l\'instant.<br>Lance-toi depuis l\'onglet Séance.</p>';
    return;
  }

  const points = sessions.slice().reverse().map((s) => ({ x: s.dateDebut, y: volumeSession(s) }));
  el.innerHTML = `
    <div class="carte">
      <h3>Volume par séance <span class="texte-2">(reps + secondes)</span></h3>
      <canvas class="graphe" id="graphe-volume"></canvas>
    </div>
    <div class="liste">${sessions.map(carteSession).join('')}</div>`;

  graphiqueLigne(el.querySelector('#graphe-volume'), points);
  el.querySelectorAll('.carte-session').forEach((c) =>
    c.addEventListener('click', (e) => {
      if (e.target.closest('[data-suppr-session]')) return; // le bouton gère
      c.classList.toggle('ouverte');
    }));

  // Suppression d'une séance erronée + recalcul des PR (sinon un record
  // fantôme resterait et fausserait cibles, paliers et suggestions).
  el.querySelectorAll('[data-suppr-session]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const s = sessions.find((x) => x.id === btn.dataset.supprSession);
      const quand = new Date(s.dateDebut).toLocaleDateString('fr-FR');
      if (!(await confirmer(`Supprimer la séance du ${quand} (${s.entrees.length} exo${s.entrees.length > 1 ? 's' : ''}) ? Les PR seront recalculés.`, { oui: 'Supprimer', danger: true }))) return;
      await dbSupprimer('sessions', s.id);
      await recalculerTousPR(ctx.exercices);
      toast('Séance supprimée · PR recalculés ✓');
      ongletSeances(el);
    }));
}

const volumeSession = (s) =>
  s.entrees.reduce((t, e) => t + e.sets.reduce((v, set) => v + (set.echec ? 0 : set.valeur), 0), 0);

function carteSession(s) {
  const date = new Date(s.dateDebut);
  const duree = s.dateFin ? Math.round((new Date(s.dateFin) - date) / 60000) : null;

  const detail = s.entrees.map((e) => {
    const ex = ctx.exercices.get(e.exerciceId);
    const unite = ex?.type === 'hold' ? 's' : '';
    const sets = e.sets
      .map((set) => `${set.valeur}${unite}${set.rpe ? '@' + set.rpe : ''}${set.echec ? '✗' : ''}`)
      .join(' · ');
    return `<div class="ligne-detail"><span>${ex?.nom || e.exerciceId}</span><span>${sets}</span></div>`;
  }).join('');

  return `
    <div class="carte carte-session">
      <div class="carte-session-tete">
        <strong>${date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
        <span class="texte-2">${s.entrees.length} exo${s.entrees.length > 1 ? 's' : ''}${duree ? ' · ' + duree + ' min' : ''}</span>
      </div>
      <div class="carte-session-detail">
        ${detail}
        <button class="btn btn-danger" data-suppr-session="${s.id}" style="margin-top:10px">Supprimer cette séance</button>
      </div>
    </div>`;
}

// --- Onglet Volume : séries dures par muscle, semaine en cours -----------------------
// Rend visible ce que le moteur compte en interne : le volume hebdomadaire par
// muscle (séries hors échec, muscles PRINCIPAUX des exercices réalisés),
// comparé à la zone efficace (~10-20 séries dures/muscle/semaine) et à la
// semaine précédente. C'est de l'auto-coaching : « jambes 3 séries » se voit.

const MUSCLES_MAJEURS = ['dorsaux', 'pectoraux', 'deltoides', 'triceps', 'biceps',
  'quadriceps', 'fessiers', 'ischios', 'gainage'];
const ZONE_MIN = 10, ZONE_MAX = 20; // séries/muscle/semaine (dose-réponse)

// Lundi 00:00 local de la semaine contenant `d` (getDay : dimanche = 0).
function lundiDe(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - (x.getDay() + 6) % 7);
  return x;
}

// Séries (hors échec) par muscle principal sur [de, a[.
function setsParMuscle(sessions, de, a = null) {
  const out = {};
  for (const s of sessions) {
    const t = new Date(s.dateDebut);
    if (t < de || (a && t >= a)) continue;
    for (const e of s.entrees) {
      const ex = ctx.exercices.get(e.exerciceId);
      if (!ex) continue;
      const n = e.sets.filter((x) => !x.echec).length;
      for (const m of ex.muscles_primaires) out[m] = (out[m] || 0) + n;
    }
  }
  return out;
}

async function ongletVolume(el) {
  const sessions = await dbGetAll('sessions');
  const debut = lundiDe(new Date());
  const debutPrec = new Date(debut);
  debutPrec.setDate(debutPrec.getDate() - 7);

  const actuel = setsParMuscle(sessions, debut);
  const precedent = setsParMuscle(sessions, debutPrec, debut);

  // Majeurs toujours affichés (un 0 est une information), puis tout muscle
  // secondaire de la semaine (trapèzes, obliques…) s'il a du volume.
  const muscles = [...MUSCLES_MAJEURS,
    ...Object.keys(actuel).filter((m) => !MUSCLES_MAJEURS.includes(m))]
    .sort((a, b) => (actuel[b] || 0) - (actuel[a] || 0));

  if (!sessions.length) {
    el.innerHTML = '<p class="texte-2 centre">Logge des séances pour voir ton volume par muscle.</p>';
    return;
  }

  const lignes = muscles.map((m) => {
    const n = actuel[m] || 0;
    const p = precedent[m] || 0;
    const delta = n === p ? '' : n > p ? ` <span class="vol-delta">▲ +${n - p}</span>` : ` <span class="vol-delta">▼ −${p - n}</span>`;
    const classe = n === 0 ? 'vol-zero' : n < ZONE_MIN ? 'vol-sous' : n <= ZONE_MAX ? '' : 'vol-trop';
    const statut = n === 0 ? '' : n < ZONE_MIN ? '' : n <= ZONE_MAX ? ' ✓' : ' · beaucoup';
    return `
      <div class="vol-ligne">
        <div class="jauge-tete">
          <span>${libelle(m)}</span>
          <span class="jauge-val">${n} série${n > 1 ? 's' : ''}${statut}${delta}</span>
        </div>
        <div class="ligne vol-rail"><div class="${classe}" style="width:${Math.min(100, (n / ZONE_MAX) * 100)}%"></div></div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="carte">
      <h3 style="margin-top:0">Semaine du ${debut.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</h3>
      ${lignes}
      <p class="texte-2" style="margin-top:14px">Zone efficace : ~${ZONE_MIN} à ${ZONE_MAX} séries dures par muscle et par semaine
        (le trait vertical marque ${ZONE_MIN}). Séries hors échec, muscles principaux des exercices réalisés.</p>
    </div>`;
}

// --- Onglet PR ------------------------------------------------------------------

async function ongletPR(el) {
  const prs = await dbGetAll('pr');
  if (!prs.length) {
    el.innerHTML = '<p class="texte-2 centre">Pas encore de PR — ils apparaîtront après ta première séance.</p>';
    return;
  }

  const lignes = prs
    .map((pr) => ({ pr, ex: ctx.exercices.get(pr.exerciceId) }))
    .filter(({ ex }) => ex)
    .sort((a, b) => a.ex.nom.localeCompare(b.ex.nom))
    .map(({ pr, ex }) => {
      const perfs = [];
      if (pr.maxReps) perfs.push(`<strong>${pr.maxReps.valeur} reps</strong>`);
      if (pr.maxHold) perfs.push(`<strong>${pr.maxHold.valeur} s</strong>`);
      const date = (pr.maxHold || pr.maxReps).date;
      return `
        <div class="carte carte-pr" data-id="${ex.id}">
          <div class="carte-pr-tete"><span>${ex.nom}</span><span>${perfs.join(' · ')}</span></div>
          <div class="texte-2">le ${new Date(date).toLocaleDateString('fr-FR')} · toucher pour la courbe</div>
          <canvas class="graphe graphe-pr" hidden></canvas>
        </div>`;
    }).join('');

  el.innerHTML = `<div class="liste">${lignes}</div>`;

  el.querySelectorAll('.carte-pr').forEach((carte) =>
    carte.addEventListener('click', async () => {
      const canvas = carte.querySelector('canvas');
      if (!canvas.hidden) {
        canvas.hidden = true;
        return;
      }
      canvas.hidden = false; // visible AVANT le dessin pour avoir un clientWidth réel
      graphiqueLigne(canvas, await courbeExercice(carte.dataset.id));
    }));
}

// Meilleure perf par séance pour un exercice → courbe de progression dans le temps.
async function courbeExercice(exerciceId) {
  const sessions = (await dbGetAll('sessions')).sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
  const points = [];
  for (const s of sessions) {
    const valeurs = s.entrees
      .filter((e) => e.exerciceId === exerciceId)
      .flatMap((e) => e.sets.filter((x) => !x.echec).map((x) => x.valeur));
    if (valeurs.length) points.push({ x: s.dateDebut, y: Math.max(...valeurs) });
  }
  return points;
}

// --- Onglet Poids ------------------------------------------------------------------

async function ongletPoids(el) {
  const logs = (await dbGetAll('poids')).sort((a, b) => a.date.localeCompare(b.date));
  const aujourdhui = new Date().toISOString().slice(0, 10);

  el.innerHTML = `
    <div class="carte">
      <div class="form-set">
        <input type="date" id="inp-date-poids" value="${aujourdhui}">
        <input type="number" id="inp-poids" step="0.1" min="1" inputmode="decimal" placeholder="kg">
        <button class="btn btn-accent" id="btn-poids">OK</button>
      </div>
    </div>
    ${logs.length ? `
      <div class="carte">
        <h3>Poids (kg)</h3>
        <canvas class="graphe" id="graphe-poids"></canvas>
      </div>
      <div class="liste">
        ${logs.slice().reverse().slice(0, 20).map((l) => `
          <div class="ligne-detail carte-fine">
            <span>${new Date(l.date).toLocaleDateString('fr-FR')}</span>
            <strong>${l.poidsKg} kg</strong>
          </div>`).join('')}
      </div>`
    : '<p class="texte-2 centre">Logge ton premier poids.</p>'}`;

  if (logs.length) {
    graphiqueLigne(el.querySelector('#graphe-poids'), logs.map((l) => ({ x: l.date, y: l.poidsKg })));
  }

  el.querySelector('#btn-poids').addEventListener('click', async () => {
    const date = el.querySelector('#inp-date-poids').value;
    const poidsKg = Number(el.querySelector('#inp-poids').value);
    if (!date || !poidsKg) {
      toast('Date et poids requis.');
      return;
    }
    await dbPut('poids', { date, poidsKg }); // une entrée par date (mise à jour si existante)
    toast('Poids enregistré ✓');
    ongletPoids(el);
  });
}
