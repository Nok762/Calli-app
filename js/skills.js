// skills.js — dérivation des arbres de skills + logique de progression.
//
// Les skills ne sont PAS stockés en base : on les dérive au chargement depuis
// les exercices du seed qui portent les champs `skill` + `step`, triés par
// step. Seul l'état utilisateur (étape courante, validations) est persisté
// dans le store 'etat_skills'.

import { dbGet, dbPut } from './db.js';

export function deriverSkills(exercices, config) {
  const parSkill = new Map();
  for (const ex of exercices.values()) {
    if (!ex.skill) continue;
    if (!parSkill.has(ex.skill)) parSkill.set(ex.skill, []);
    parSkill.get(ex.skill).push(ex);
  }

  const skills = [];
  for (const [id, exos] of parSkill) {
    exos.sort((a, b) => a.step - b.step);
    skills.push({
      id,
      nom: config.noms[id] || id,
      etapes: exos.map((ex) => ({
        step: ex.step,
        exercice: ex,
        critere: config.criteres.find((c) => c.skill === id && c.step === ex.step)?.critere || null,
      })),
    });
  }

  const ordre = config.ordre || [];
  skills.sort((a, b) => ordre.indexOf(a.id) - ordre.indexOf(b.id));
  return skills;
}

export async function getEtatSkill(skill) {
  const etat = await dbGet('etat_skills', skill.id);
  return etat || {
    skill: skill.id,
    etapeCourante: skill.etapes[0].step,
    validations: [],
    termine: false,
  };
}

// Valide une étape : enregistre la perf réalisée et débloque la suivante.
export async function validerEtape(skill, step, perf) {
  const etat = await getEtatSkill(skill);
  // Revalidation d'une étape déjà validée : on remplace l'entrée existante.
  etat.validations = etat.validations.filter((v) => v.step !== step);
  etat.validations.push({ step, date: new Date().toISOString(), perf });

  const steps = skill.etapes.map((e) => e.step);
  const i = steps.indexOf(step);
  if (i < steps.length - 1) {
    etat.etapeCourante = steps[i + 1];
    etat.termine = false;
  } else {
    etat.etapeCourante = step;
    etat.termine = true;
  }
  await dbPut('etat_skills', etat);
  return etat;
}

// Override manuel : l'utilisateur garde toujours le dernier mot sur l'étape
// qu'il travaille (revenir en arrière ou sauter une étape).
export async function reglerEtapeCourante(skill, step) {
  const etat = await getEtatSkill(skill);
  etat.etapeCourante = step;
  etat.termine = false;
  await dbPut('etat_skills', etat);
  return etat;
}

export function texteCritere(critere) {
  if (!critere) return 'critère libre';
  return critere.type === 'hold' ? `tenir ${critere.valeur} s` : `${critere.valeur} rep${critere.valeur > 1 ? 's' : ''}`;
}
