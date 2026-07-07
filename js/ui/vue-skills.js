// vue-skills.js — feature 1 : arbres de progression de skills.
// Liste des skills avec avancement, détail en échelle d'étapes, validation
// d'une étape (perf à l'appui) qui débloque la suivante, override manuel.

import { ctx } from '../app.js';
import { getEtatSkill, validerEtape, reglerEtapeCourante, texteCritere } from '../skills.js';
import { getPR } from '../pr.js';
import { toast } from './composants.js';

export async function vueSkills(el, params) {
  if (params[0]) return detailSkill(el, params[0]);
  return listeSkills(el);
}

async function listeSkills(el) {
  const cartes = [];
  for (const skill of ctx.skills) {
    const etat = await getEtatSkill(skill);
    const validees = etat.validations.length;
    const total = skill.etapes.length;
    const courante = skill.etapes.find((e) => e.step === etat.etapeCourante) || skill.etapes[0];
    cartes.push(`
      <a class="carte carte-skill" href="#/skills/${skill.id}">
        <div class="carte-skill-tete">
          <strong>${skill.nom}</strong>
          <span class="badge">${etat.termine ? 'Terminé ✓' : `${validees}/${total}`}</span>
        </div>
        <div class="barre-prog"><div style="width:${(validees / total) * 100}%"></div></div>
        <div class="texte-2">${etat.termine ? 'Skill débloqué 🎉' : `Étape ${courante.step} — ${courante.exercice.nom}`}</div>
      </a>`);
  }
  el.innerHTML = `<h1>Skills</h1><div class="liste">${cartes.join('')}</div>`;
}

async function detailSkill(el, skillId) {
  const skill = ctx.skills.find((s) => s.id === skillId);
  if (!skill) {
    el.innerHTML = '<a class="retour" href="#/skills">← Skills</a><p>Skill introuvable.</p>';
    return;
  }
  const etat = await getEtatSkill(skill);

  const lignes = [];
  for (const etape of skill.etapes) {
    const validation = etat.validations.find((v) => v.step === etape.step);
    const courante = etape.step === etat.etapeCourante && !etat.termine;
    const pr = await getPR(etape.exercice.id);
    const record = etape.exercice.type === 'hold' ? pr?.maxHold : pr?.maxReps;
    const unite = etape.exercice.type === 'hold' ? 's' : 'reps';
    const statut = validation ? 'validee' : courante ? 'courante' : 'verrouillee';

    lignes.push(`
      <div class="etape etape-${statut}">
        <div class="etape-pastille">${validation ? '✓' : etape.step}</div>
        <div class="etape-corps">
          <a href="#/exercices/${etape.exercice.id}"><strong>${etape.exercice.nom}</strong></a>
          <div class="texte-2">Objectif : ${texteCritere(etape.critere)}${record ? ` · record : ${record.valeur} ${unite}` : ''}</div>
          ${courante && etape.critere ? `<div class="ligne"><div style="width:${Math.min(100, ((record?.valeur || 0) / etape.critere.valeur) * 100)}%"></div></div>` : ''}
          ${validation ? `<div class="texte-2">Validée le ${new Date(validation.date).toLocaleDateString('fr-FR')} (${validation.perf.valeur} ${unite})</div>` : ''}
          ${courante ? formulaireValidation(etape, record) : ''}
          ${!courante ? `<button class="btn-lien" data-reprendre="${etape.step}">Reprendre ici</button>` : ''}
        </div>
      </div>`);
  }

  el.innerHTML = `
    <a class="retour" href="#/skills">← Skills</a>
    <h1>${skill.nom}</h1>
    ${etat.termine ? `<div class="carte accent">Skill débloqué 🎉 — continue à l'entretenir.</div>` : ''}
    <div class="echelle">${lignes.join('')}</div>`;

  el.querySelector('[data-valider]')?.addEventListener('click', async () => {
    const valeur = Number(el.querySelector('#perf-valid').value);
    if (!valeur || valeur <= 0) {
      toast('Renseigne ta perf pour valider.');
      return;
    }
    const etape = skill.etapes.find((e) => e.step === etat.etapeCourante);
    const derniere = etape.step === skill.etapes[skill.etapes.length - 1].step;
    await validerEtape(skill, etape.step, { type: etape.exercice.type, valeur });
    toast(derniere ? '🎉 Skill terminé, bravo !' : 'Étape validée — suivante débloquée 💪');
    detailSkill(el, skillId);
  });

  el.querySelectorAll('[data-reprendre]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await reglerEtapeCourante(skill, Number(btn.dataset.reprendre));
      detailSkill(el, skillId);
    }));
}

function formulaireValidation(etape, record) {
  const unite = etape.exercice.type === 'hold' ? 'secondes' : 'reps';
  return `
    <div class="form-validation">
      <input id="perf-valid" type="number" min="1" inputmode="numeric"
             placeholder="${unite}" value="${record?.valeur ?? ''}">
      <button class="btn btn-accent" data-valider>Valider l'étape</button>
    </div>`;
}
