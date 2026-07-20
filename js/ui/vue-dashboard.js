// vue-dashboard.js — feature 6 : tableau de bord (route d'accueil).
// Hiérarchisé autour d'UNE action : la prochaine séance (rotation du programme).
// Puis : jauge de la semaine, suggestions du moteur, objectifs (paliers en
// approche), calendrier de régularité sur 8 semaines, PR récents.

import { ctx } from '../app.js';
import { dbGetAll, getReglage, setReglage } from '../db.js';
import { getEtatSkill, texteCritere } from '../skills.js';
import { getPR } from '../pr.js';
import { suggestionsPalier, suggestionsDeload, suggestionsPlateau } from '../moteur/adaptation.js';
import { prochainJour, REGLES } from '../moteur/generateur.js';
import { afficherChecklist, echapper } from './composants.js';
import { vueOnboarding } from './vue-onboarding.js';

// Clé de date en heure LOCALE (toISOString est en UTC : à minuit heure de
// Paris, le jour UTC est encore la veille — faux marquage du calendrier).
const cleLocale = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function vueAccueil(el) {
  const [sessions, prs, programmes, brouillon] = await Promise.all([
    dbGetAll('sessions'),
    dbGetAll('pr'),
    dbGetAll('programmes'),
    getReglage('seance_en_cours'),
  ]);

  // Premier lancement (rien : ni programme, ni séance, ni onboarding passé) :
  // l'Accueil devient le parcours d'accueil — trois questions, un plan prêt.
  if (!programmes.length && !sessions.length && !brouillon
      && !(await getReglage('onboarding_fait'))) {
    return vueOnboarding(el, () => vueAccueil(el));
  }

  const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const progGenere = programmes.find((p) => p.genere);

  // Prochaine séance : jour « à suivre » de la rotation du programme généré,
  // sinon premier jour non vide d'un programme manuel.
  let hero = null;
  if (progGenere) {
    const j = prochainJour(progGenere, sessions);
    if (progGenere.jours[j]?.exercices.length) hero = { prog: progGenere, jour: progGenere.jours[j], j };
  }
  if (!hero) {
    for (const p of programmes) {
      const j = p.jours.findIndex((x) => x.exercices.length);
      if (j >= 0) { hero = { prog: p, jour: p.jours[j], j }; break; }
    }
  }

  // Suggestions du moteur (recalculées à chaque affichage, jamais stockées).
  const etats = new Map();
  for (const skill of ctx.skills) etats.set(skill.id, await getEtatSkill(skill));
  const suggPaliers = suggestionsPalier(sessions, ctx.skills, etats);
  const suggDeloads = suggestionsDeload(sessions, ctx.exercices);
  const suggPlateaux = suggestionsPlateau(sessions, ctx.exercices);

  // Étirements de la dernière séance : récupérables quelques heures (au cas où
  // la feuille de fin de séance a été fermée trop vite).
  const dernEtir = await getReglage('derniersEtirements');
  const etirRecents = dernEtir && Date.now() - new Date(dernEtir.date) < 6 * 3600000 ? dernEtir : null;

  const paliers = await prochainsPaliers();
  const recents = prRecents(prs);
  const nbSemaine = seancesCetteSemaine(sessions);
  const cibleSemaine = progGenere?.genere.frequence || null;
  const streak = streakSemaines(sessions);
  const pctSemaine = cibleSemaine
    ? Math.min(100, (nbSemaine / cibleSemaine) * 100)
    : (nbSemaine ? 100 : 0);

  el.innerHTML = `
    <div class="accueil-tete">
      <div class="accueil-date">${date}</div>
      <a class="lien-reglages" href="#/reglages" aria-label="Réglages" title="Réglages">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </a>
    </div>
    <h1>Aujourd'hui</h1>

    ${brouillon ? `
      <a class="carte accent" href="#/seance" style="display:block">
        <div class="hero-label">Séance en cours</div>
        <div class="hero-titre">Reprendre</div>
        <div class="texte-2">Là où tu en étais · le chrono t'attend.</div>
      </a>` : heroHtml(hero, sessions.length === 0)}

    ${etirRecents ? '<button class="carte-fine btn-etirements" id="btn-etirements">Étirements de la dernière séance</button>' : ''}

    <div class="carte" style="margin-top:10px">
      <div class="jauge-tete">
        <h3 style="margin:0">Cette semaine</h3>
        <span class="jauge-val">${nbSemaine}${cibleSemaine ? '/' + cibleSemaine : ''} séance${nbSemaine > 1 ? 's' : ''}${streak > 1 ? ' · ' + streak + ' sem. d\'affilée' : ''}</span>
      </div>
      <div class="ligne rail"><div style="width:${pctSemaine}%"></div></div>
    </div>

    ${suggPaliers.length || suggDeloads.length || suggPlateaux.length ? `
      <h3>Suggestions du moteur</h3>
      <div class="liste">
        ${suggPaliers.map((s) => `
          <a class="carte accent" href="#/skills/${s.skill.id}">
            <strong>${s.skill.nom} : palier atteignable !</strong>
            <div class="texte-2">Critère de « ${s.etape.exercice.nom} » (${texteCritere(s.etape.critere)})
              atteint sur ${s.nb} séances · valide l'étape.</div>
          </a>`).join('')}
        ${suggDeloads.map((s) => `
          <a class="carte" href="#/exercices/${(s.regression || s.exercice).id}">
            <strong>${s.exercice.nom} : ${s.motif}</strong>
            <div class="texte-2">${s.regression
              ? `Essaie la régression « ${s.regression.nom} » le temps de récupérer.`
              : 'Réduis le volume le temps de récupérer.'}</div>
          </a>`).join('')}
        ${suggPlateaux.map((s) => `
          <a class="carte" href="#/exercices/${(s.levier.exercice || s.exercice).id}">
            <strong>${s.exercice.nom} : plateau</strong>
            <div class="texte-2">${textePlateau(s)}</div>
          </a>`).join('')}
      </div>` : ''}

    ${paliers.length ? `
      <h3>Objectifs</h3>
      <div class="carte">
        ${paliers.map((p) => `
          <a class="objectif-item" href="#/skills/${p.skill.id}">
            <div class="objectif-tete">
              <strong>${p.skill.nom} · ${p.etape.exercice.nom}</strong>
              <span class="jauge-val">${p.record}/${p.etape.critere.valeur}${p.etape.exercice.type === 'hold' ? ' s' : ''}</span>
            </div>
            <div class="ligne"><div style="width:${p.ratio * 100}%"></div></div>
          </a>`).join('')}
      </div>` : ''}

    <h3>Régularité · 8 semaines</h3>
    <div class="carte">
      <div class="cal-grille">${calendrier(sessions)}</div>
    </div>

    ${recents.length ? `
      <h3>PR récents</h3>
      <div class="liste">
        ${recents.map((r) => `
          <div class="ligne-detail carte-fine">
            <span>${r.nom}</span>
            <span><strong>${r.texte}</strong> <span class="texte-2">· ${new Date(r.date).toLocaleDateString('fr-FR')}</span></span>
          </div>`).join('')}
      </div>` : ''}`;

  el.querySelectorAll('[data-template]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const [programmeId, jourIdx] = btn.dataset.template.split(':');
      await setReglage('template_a_demarrer', { programmeId, jourIdx: Number(jourIdx) });
      location.hash = '#/seance';
    }));

  el.querySelector('[data-generer]')?.addEventListener('click', () => {
    location.hash = '#/programmes/generer';
  });

  el.querySelector('#btn-etirements')?.addEventListener('click', () =>
    afficherChecklist({
      titre: 'Étirements · récupération',
      note: 'Respiration lente, on ne force jamais — juste une tension confortable.',
      items: etirRecents.liste,
    }));
}

// Phrase du levier proposé pour sortir d'un plateau.
function textePlateau(s) {
  const u = s.exercice.type === 'hold' ? ' s' : ' reps';
  const base = `Bloqué à ${s.valeur}${u} depuis ${s.nb} séances sans forcer`;
  if (s.levier.type === 'progression') return `${base} → passe à « ${s.levier.exercice.nom} » pour relancer.`;
  if (s.levier.type === 'variation') return `${base} → change pour « ${s.levier.exercice.nom} » ou ajoute une rép.`;
  return `${base} → ajoute une répétition ou ralentis le tempo.`;
}

// Carte hero : LA décision du jour, un seul gros bouton.
function heroHtml(hero, premiereSeance) {
  if (!hero) {
    return `
      <div class="carte accent">
        <div class="hero-label">Par où commencer</div>
        <div class="hero-titre">Ton premier programme</div>
        <div class="texte-2">Un plan construit sur tes objectifs et ton matériel, qui évolue tout seul.</div>
        <button class="btn btn-accent btn-large" data-generer>Générer mon programme</button>
        <p class="texte-2 centre" style="padding:8px 0 0; margin:0">ou <a href="#/seance">séance du jour</a></p>
      </div>`;
  }
  const duree = Math.round((hero.jour.exercices.length * REGLES.MIN_PAR_EXO) / 5) * 5;
  const autres = hero.prog.jours
    .map((jour, j) => ({ jour, j }))
    .filter(({ jour, j }) => j !== hero.j && jour.exercices.length);
  return `
    <div class="carte accent">
      <div class="hero-label">${premiereSeance ? 'Ta première séance' : 'Prochaine séance'}</div>
      <div class="hero-titre">${echapper(hero.jour.nom)}</div>
      <div class="texte-2">${echapper(hero.prog.nom)} · ${hero.jour.exercices.length} exercices · ~${duree} min</div>
      <button class="btn btn-accent btn-large" data-template="${hero.prog.id}:${hero.j}">▶ Démarrer</button>
      <p class="texte-2 centre" style="padding:8px 0 0; margin:0">
        ${autres.map(({ jour, j }) => `<button class="btn-lien" data-template="${hero.prog.id}:${j}">${echapper(jour.nom)}</button>`).join(' · ')}${autres.length ? ' · ' : ''}<a href="#/seance">séance du jour</a>
      </p>
    </div>`;
}

// 8 semaines × 7 jours : un carré par jour, ambre si au moins une séance.
function calendrier(sessions) {
  const faits = new Set(sessions.map((s) => cleLocale(new Date(s.dateDebut))));
  const auj = cleLocale(new Date());
  const debut = new Date();
  debut.setHours(0, 0, 0, 0);
  debut.setDate(debut.getDate() - (debut.getDay() + 6) % 7 - 49); // lundi, 7 semaines en arrière

  const cases = [];
  const d = new Date(debut);
  for (let i = 0; i < 56; i++) {
    const cle = cleLocale(d);
    const classes = ['cal-jour'];
    if (faits.has(cle)) classes.push('fait');
    if (cle === auj) classes.push('aujourdhui');
    if (cle > auj) classes.push('futur');
    cases.push(`<span class="${classes.join(' ')}"></span>`);
    d.setDate(d.getDate() + 1);
  }
  return cases.join('');
}

// Les 3 étapes de skill les plus proches d'être débloquées (record vs critère).
async function prochainsPaliers() {
  const paliers = [];
  for (const skill of ctx.skills) {
    const etat = await getEtatSkill(skill);
    if (etat.termine) continue;
    const etape = skill.etapes.find((e) => e.step === etat.etapeCourante);
    if (!etape?.critere) continue;
    const pr = await getPR(etape.exercice.id);
    const record = (etape.exercice.type === 'hold' ? pr?.maxHold : pr?.maxReps)?.valeur || 0;
    paliers.push({ skill, etape, record, ratio: Math.min(1, record / etape.critere.valeur) });
  }
  return paliers.sort((a, b) => b.ratio - a.ratio).slice(0, 3);
}

function prRecents(prs) {
  const items = [];
  for (const pr of prs) {
    const ex = ctx.exercices.get(pr.exerciceId);
    if (!ex) continue;
    if (pr.maxReps) items.push({ nom: ex.nom, texte: pr.maxReps.valeur + ' reps', date: pr.maxReps.date });
    if (pr.maxHold) items.push({ nom: ex.nom, texte: pr.maxHold.valeur + ' s', date: pr.maxHold.date });
  }
  return items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
}

// --- Semaine et streak ------------------------------------------------------
// Clé de semaine = minuit local du lundi. On passe par setDate (et non par une
// soustraction de millisecondes) pour rester juste lors des changements d'heure.
function cleSemaine(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return date.getTime();
}

function semainePrecedente(cle) {
  const d = new Date(cle);
  d.setDate(d.getDate() - 7);
  return d.getTime();
}

function seancesCetteSemaine(sessions) {
  const semaine = cleSemaine(Date.now());
  return sessions.filter((s) => cleSemaine(s.dateDebut) === semaine).length;
}

function streakSemaines(sessions) {
  const semaines = new Set(sessions.map((s) => cleSemaine(s.dateDebut)));
  let cur = cleSemaine(Date.now());
  // La semaine en cours, encore incomplète, ne casse pas le streak.
  if (!semaines.has(cur)) cur = semainePrecedente(cur);
  let n = 0;
  while (semaines.has(cur)) {
    n++;
    cur = semainePrecedente(cur);
  }
  return n;
}
