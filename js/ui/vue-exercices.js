// vue-exercices.js — bibliothèque d'exercices consultable (source : le seed).
// Liste filtrable (recherche, pattern, équipement) + fiche détaillée avec les
// liens régression / progression / équivalence navigables.

import { ctx } from '../app.js';
import { libelle } from './composants.js';
import { getPR } from '../pr.js';

export async function vueExercices(el, params) {
  if (params[0]) return detailExercice(el, params[0]);
  return listeExercices(el);
}

// Filtres conservés en mémoire pour survivre aux allers-retours liste/détail.
const filtres = { q: '', muscle: '', equipement: '' };

function listeExercices(el) {
  const patterns = ctx.meta?.enums.pattern || [...new Set([...ctx.exercices.values()].map((e) => e.pattern))];
  const equips = ctx.meta?.enums.equipement || [];
  // Zones ciblées : dérivées du seed (pas d'énumération dédiée dans meta).
  const muscles = [...new Set([...ctx.exercices.values()].flatMap((e) => e.muscles_primaires))]
    .sort((a, b) => libelle(a).localeCompare(libelle(b)));

  el.innerHTML = `
    <h1>Exercices</h1>
    <div class="filtres">
      <input type="search" id="f-q" placeholder="Chercher…" value="${filtres.q}">
      <div class="ligne-2">
        <select id="f-muscle">
          <option value="">Toutes zones ciblées</option>
          ${muscles.map((m) => `<option value="${m}" ${filtres.muscle === m ? 'selected' : ''}>${libelle(m)}</option>`).join('')}
        </select>
        <select id="f-equip">
          <option value="">Tout équipement</option>
          ${equips.map((e) => `<option value="${e}" ${filtres.equipement === e ? 'selected' : ''}>${libelle(e)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="liste-exos"></div>`;

  const rendre = () => {
    const exos = [...ctx.exercices.values()]
      .filter((ex) => !filtres.q || ex.nom.toLowerCase().includes(filtres.q.toLowerCase()))
      .filter((ex) => !filtres.muscle || ex.muscles_primaires.includes(filtres.muscle))
      .filter((ex) => !filtres.equipement || ex.equipement.includes(filtres.equipement))
      .sort((a, b) => a.difficulte - b.difficulte || a.nom.localeCompare(b.nom));

    const carte = (ex) => `
      <a class="carte carte-exo-liste" href="#/exercices/${ex.id}">
        <div><strong>${ex.nom}</strong>${ex.skill ? ' <span class="badge badge-accent">skill</span>' : ''}</div>
        <div class="texte-2">${ex.muscles_primaires.map(libelle).join(', ')} · ${ex.type === 'hold' ? 'tenue' : 'reps'} · difficulté ${ex.difficulte}/10</div>
      </a>`;

    // Rangés par famille de mouvement : chaque exercice appartient à UN pattern
    // (un regroupement par muscle dupliquerait les fiches), et le filtre
    // « zone ciblée » ci-dessus croise les groupes.
    el.querySelector('#liste-exos').innerHTML = patterns
      .map((p) => ({ p, groupe: exos.filter((ex) => ex.pattern === p) }))
      .filter(({ groupe }) => groupe.length)
      .map(({ p, groupe }) => `
        <h3>${libelle(p)} · ${groupe.length}</h3>
        <div class="liste">${groupe.map(carte).join('')}</div>`)
      .join('') || '<p class="texte-2 centre">Aucun exercice ne correspond.</p>';
  };
  rendre();

  el.querySelector('#f-q').addEventListener('input', (e) => { filtres.q = e.target.value; rendre(); });
  el.querySelector('#f-muscle').addEventListener('change', (e) => { filtres.muscle = e.target.value; rendre(); });
  el.querySelector('#f-equip').addEventListener('change', (e) => { filtres.equipement = e.target.value; rendre(); });
}

async function detailExercice(el, id) {
  const ex = ctx.exercices.get(id);
  if (!ex) {
    el.innerHTML = '<a class="retour" href="#/exercices">← Exercices</a><p>Exercice introuvable.</p>';
    return;
  }
  const pr = await getPR(id);

  const liens = (titre, ids) => ids?.length ? `
    <h3>${titre}</h3>
    <div class="chips">
      ${ids.map((i) => {
        const cible = ctx.exercices.get(i);
        return cible ? `<a class="chip-lien" href="#/exercices/${i}">${cible.nom}</a>` : '';
      }).join('')}
    </div>` : '';

  const perfs = [];
  if (pr?.maxReps) perfs.push(`${pr.maxReps.valeur} reps`);
  if (pr?.maxHold) perfs.push(`${pr.maxHold.valeur} s`);

  el.innerHTML = `
    <a class="retour" href="#/exercices">← Exercices</a>
    <h1>${ex.nom}</h1>
    <div class="chips">
      <span class="chip-info">${ex.type === 'hold' ? 'isométrique (s)' : 'reps'}</span>
      <span class="chip-info">${libelle(ex.pattern)}</span>
      <span class="chip-info">difficulté ${ex.difficulte}/10</span>
      <span class="chip-info">${ex.lateralite}</span>
      ${ex.skill ? `<a class="chip-lien" href="#/skills/${ex.skill}">skill : ${ctx.config.noms[ex.skill] || ex.skill} — étape ${ex.step}</a>` : ''}
    </div>
    ${perfs.length ? `<div class="carte accent">PR : ${perfs.join(' · ')}</div>` : ''}
    <div class="carte">
      <h3>Consignes</h3>
      <p>${ex.consignes}</p>
      <h3>Erreurs fréquentes</h3>
      <ul>${ex.erreurs_frequentes.map((e) => `<li>${e}</li>`).join('')}</ul>
      <h3>Muscles</h3>
      <p class="texte-2">${ex.muscles_primaires.map(libelle).join(', ')}<br>
        secondaires : ${ex.muscles_secondaires.map(libelle).join(', ') || '—'}</p>
      <h3>Équipement</h3>
      <div class="chips">${ex.equipement.map((e) => `<span class="chip-info">${libelle(e)}</span>`).join('')}</div>
      <h3>Zones sollicitées à surveiller</h3>
      <div class="chips">${ex.zones_a_risque.map((z) => `<span class="chip-attention">${libelle(z)}</span>`).join('')}</div>
    </div>
    ${liens('Plus facile (régression)', ex.regression)}
    ${liens('Plus dur (progression)', ex.progression)}
    ${liens('Équivalents', ex.equivalence)}`;
}
