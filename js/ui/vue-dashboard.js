// vue-dashboard.js — feature 6 : tableau de bord (route d'accueil).
// Séance en cours à reprendre, streak, plan du jour (démarrage de programme
// en un tap), prochains paliers de skills, PR récents.

import { ctx } from '../app.js';
import { dbGetAll, getReglage, setReglage } from '../db.js';
import { getEtatSkill, texteCritere } from '../skills.js';
import { getPR } from '../pr.js';
import { suggestionsPalier, suggestionsDeload } from '../moteur/adaptation.js';
import { prochainJour } from '../moteur/generateur.js';

export async function vueAccueil(el) {
  const [sessions, prs, programmes, brouillon] = await Promise.all([
    dbGetAll('sessions'),
    dbGetAll('pr'),
    dbGetAll('programmes'),
    getReglage('seance_en_cours'),
  ]);

  const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  // Rotation des programmes générés : le jour « à suivre » est celui qui suit
  // le dernier effectué — pas de calendrier fixe, une séance ratée ne casse rien.
  const jours = programmes.flatMap((p) => {
    const suivant = p.genere ? prochainJour(p, sessions) : null;
    return p.jours
      .map((jour, j) => ({ prog: p, jour, j, suivant: j === suivant }))
      .filter(({ jour }) => jour.exercices.length);
  }).sort((a, b) => (b.suivant ? 1 : 0) - (a.suivant ? 1 : 0));
  const paliers = await prochainsPaliers();
  const recents = prRecents(prs);
  const nbSemaine = seancesCetteSemaine(sessions);
  const streak = streakSemaines(sessions);

  // Suggestions du moteur (recalculées à chaque affichage, jamais stockées :
  // elles disparaissent d'elles-mêmes quand la situation évolue).
  const etats = new Map();
  for (const skill of ctx.skills) etats.set(skill.id, await getEtatSkill(skill));
  const suggPaliers = suggestionsPalier(sessions, ctx.skills, etats);
  const suggDeloads = suggestionsDeload(sessions, ctx.exercices);

  el.innerHTML = `
    <h1>Aujourd'hui</h1>
    <p class="texte-2 sous-titre">${date}</p>

    ${brouillon ? `
      <a class="carte accent" href="#/seance">
        <strong>⏳ Séance en cours</strong>
        <div class="texte-2">Touche pour reprendre là où tu en étais.</div>
      </a>` : ''}

    <div class="ligne-2">
      <div class="carte carte-stat"><div class="stat-val">${nbSemaine}</div>
        <div class="texte-2">séance${nbSemaine > 1 ? 's' : ''} cette semaine</div></div>
      <div class="carte carte-stat"><div class="stat-val">${streak > 0 ? streak + ' 🔥' : '—'}</div>
        <div class="texte-2">semaine${streak > 1 ? 's' : ''} d'affilée</div></div>
    </div>

    ${suggPaliers.length || suggDeloads.length ? `
      <h3>Suggestions du moteur</h3>
      <div class="liste">
        ${suggPaliers.map((s) => `
          <a class="carte accent" href="#/skills/${s.skill.id}">
            <strong>💡 ${s.skill.nom} : palier atteignable !</strong>
            <div class="texte-2">Critère de « ${s.etape.exercice.nom} » (${texteCritere(s.etape.critere)})
              atteint sur ${s.nb} séances → valide l'étape.</div>
          </a>`).join('')}
        ${suggDeloads.map((s) => `
          <a class="carte" href="#/exercices/${(s.regression || s.exercice).id}">
            <strong>💡 ${s.exercice.nom} : ${s.motif}</strong>
            <div class="texte-2">${s.regression
              ? `Essaie la régression « ${s.regression.nom} » le temps de récupérer.`
              : 'Réduis le volume le temps de récupérer.'}</div>
          </a>`).join('')}
      </div>` : ''}

    <h3>Plan du jour</h3>
    ${jours.length ? `
      <div class="chips">
        ${jours.map(({ prog, jour, j, suivant }) =>
          `<button class="chip-lien ${suivant ? 'chip-actif' : ''}" data-template="${prog.id}:${j}">▶ ${prog.nom} · ${jour.nom}${suivant ? ' · à suivre' : ''}</button>`).join('')}
      </div>` : `
      <p class="texte-2">Pas encore de programme. <a href="#/programmes">Crée un template</a>
      ou lance une <a href="#/seance">séance libre</a>.</p>`}

    ${paliers.length ? `
      <h3>Prochains paliers</h3>
      <div class="liste">
        ${paliers.map((p) => `
          <a class="carte" href="#/skills/${p.skill.id}">
            <div class="carte-skill-tete">
              <strong>${p.skill.nom} — ${p.etape.exercice.nom}</strong>
              <span class="badge">${p.record}/${p.etape.critere.valeur}${p.etape.exercice.type === 'hold' ? ' s' : ''}</span>
            </div>
            <div class="barre-prog"><div style="width:${p.ratio * 100}%"></div></div>
            <div class="texte-2">Objectif : ${texteCritere(p.etape.critere)}${p.ratio >= 0.85 ? ' — presque ! 💪' : ''}</div>
          </a>`).join('')}
      </div>` : ''}

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

// --- Streak hebdomadaire ------------------------------------------------------
// Clé de semaine = minuit local du lundi. On passe par setDate (et non par une
// soustraction de millisecondes) pour rester juste lors des changements d'heure.
function cleSemaine(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7); // recule au lundi
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
