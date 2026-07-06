// pr.js — records personnels par exercice.
//
// Les PR sont matérialisés dans le store 'pr' pour un affichage instantané,
// mais restent entièrement recalculables depuis l'historique des sessions.
// Un exercice `reps` alimente maxReps, un exercice `hold` alimente maxHold.

import { dbGet, dbPut } from './db.js';

// Met à jour les PR après la sauvegarde d'une séance.
// Retourne la liste des nouveaux records (pour pouvoir les annoncer).
export async function majPRDepuisSession(session, exercices) {
  const nouveaux = [];
  for (const entree of session.entrees) {
    const ex = exercices.get(entree.exerciceId);
    if (!ex) continue;

    const valeurs = entree.sets.filter((s) => !s.echec && s.valeur > 0).map((s) => s.valeur);
    if (!valeurs.length) continue;
    const meilleure = Math.max(...valeurs);

    const champ = ex.type === 'hold' ? 'maxHold' : 'maxReps';
    const pr = (await dbGet('pr', entree.exerciceId)) || { exerciceId: entree.exerciceId };
    if (!pr[champ] || meilleure > pr[champ].valeur) {
      pr[champ] = { valeur: meilleure, date: session.dateDebut, sessionId: session.id };
      await dbPut('pr', pr);
      nouveaux.push({ exercice: ex, valeur: meilleure });
    }
  }
  return nouveaux;
}

export const getPR = (exerciceId) => dbGet('pr', exerciceId);
