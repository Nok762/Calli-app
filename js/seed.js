// seed.js — import de la bibliothèque d'exercices vers IndexedDB.
//
// data/exercices.seed.json reste LA source de vérité : l'app ne modifie jamais
// le store 'exercices', elle le réimporte intégralement quand meta.version
// change. Le seed étant précaché par le service worker, le fetch fonctionne
// aussi hors ligne.

import { dbGetAll, dbPut, dbVider, getReglage, setReglage } from './db.js';

export async function importerSeed() {
  let seed = null;
  try {
    const rep = await fetch('data/exercices.seed.json');
    seed = await rep.json();
  } catch {
    // Pas de réseau et pas de cache (ne peut arriver qu'avant la toute
    // première installation) : on continue avec ce qui est déjà en base.
    return;
  }
  const versionEnBase = await getReglage('seedVersion');
  if (versionEnBase === seed.meta.version) return;

  await dbVider('exercices');
  for (const ex of seed.exercices) await dbPut('exercices', ex);
  await setReglage('seedVersion', seed.meta.version);
  // Les énumérations (équipement, zones…) servent aux formulaires de l'app.
  await setReglage('seedMeta', seed.meta);
}

export async function chargerExercices() {
  const liste = await dbGetAll('exercices');
  return new Map(liste.map((ex) => [ex.id, ex]));
}

export async function chargerConfigSkills() {
  const rep = await fetch('data/skills.config.json');
  return rep.json();
}
