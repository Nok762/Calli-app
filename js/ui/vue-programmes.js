// vue-programmes.js — feature 3 : programmes / routines réutilisables.
// Un programme = des jours nommés, chaque jour = des exercices avec une cible
// (sets × reps ou secondes). « Démarrer » un jour pré-remplit une séance.

import { ctx } from '../app.js';
import { dbGet, dbGetAll, dbPut, dbSupprimer, setReglage } from '../db.js';
import { getEtatSkill } from '../skills.js';
import { genererProgramme, semaineCourante, REGLES, PROFILS } from '../moteur/generateur.js';
import { toast, choisirExercice, libelle, confirmer, echapper } from './composants.js';

export async function vueProgrammes(el, params) {
  if (params[0] === 'generer') return assistant(el);
  if (params[0]) return editerProgramme(el, params[0]);
  return listeProgrammes(el);
}

async function listeProgrammes(el) {
  const programmes = await dbGetAll('programmes');
  el.innerHTML = `
    <h1>Programmes</h1>
    <div class="liste">
      ${programmes.map((p) => `
        <a class="carte" href="#/programmes/${p.id}">
          <strong>${echapper(p.nom)}</strong>
          <div class="texte-2">${p.jours.map((j) => `${echapper(j.nom)} (${j.exercices.length})`).join(' · ') || 'vide'}</div>
        </a>`).join('') || '<p class="texte-2 centre">Aucun programme.<br>Crée ton premier template (Push/Pull/Legs, journée skill…) 👇</p>'}
    </div>
    <button class="btn btn-accent btn-large" id="btn-generer">✨ Générer mon programme</button>
    <button class="btn btn-large" id="btn-nouveau">+ Nouveau programme vide</button>`;

  el.querySelector('#btn-generer').addEventListener('click', () => {
    location.hash = '#/programmes/generer';
  });

  el.querySelector('#btn-nouveau').addEventListener('click', async () => {
    const prog = {
      id: 'p_' + Date.now().toString(36),
      nom: 'Nouveau programme',
      jours: [{ nom: 'Jour 1', exercices: [] }],
    };
    await dbPut('programmes', prog);
    location.hash = '#/programmes/' + prog.id;
  });
}

async function editerProgramme(el, id) {
  const prog = await dbGet('programmes', id);
  if (!prog) {
    el.innerHTML = '<a class="retour" href="#/programmes">← Programmes</a><p>Programme introuvable.</p>';
    return;
  }
  const sauver = () => dbPut('programmes', prog);

  el.innerHTML = `
    <a class="retour" href="#/programmes">← Programmes</a>
    <input id="prog-nom" class="input-titre" value="${echapper(prog.nom)}">
    ${prog.genere ? carteGenere(prog) : ''}
    <div class="liste">
      ${prog.jours.map((jour, j) => `
        <div class="carte">
          <div class="carte-exo-tete">
            <input class="inp-jour" data-j="${j}" value="${echapper(jour.nom)}">
            <button class="btn-x" data-suppr-jour="${j}">×</button>
          </div>
          ${jour.echauffement?.length ? `
            <details class="echauffement">
              <summary>🔥 Échauffement · ${jour.echauffement.length} étapes</summary>
              <ul>${jour.echauffement.map((e) => `<li>${e}</li>`).join('')}</ul>
            </details>` : ''}
          ${jour.exercices.map((e, k) => ligneExo(e, j, k)).join('') ||
            '<p class="texte-2">Aucun exercice pour l\'instant.</p>'}
          ${jour.etirements?.length ? `
            <details class="echauffement">
              <summary>🧘 Étirements post-séance · ${jour.etirements.length}</summary>
              <ul>${jour.etirements.map((e) => `<li>${e}</li>`).join('')}</ul>
            </details>` : ''}
          <div class="ligne-2">
            <button class="btn" data-add-exo="${j}">+ Exercice</button>
            <button class="btn btn-accent" data-demarrer="${j}">▶ Démarrer</button>
          </div>
        </div>`).join('')}
    </div>
    <button class="btn btn-large" id="btn-add-jour">+ Ajouter un jour</button>
    <button class="btn btn-danger btn-large" id="btn-suppr-prog">Supprimer le programme</button>`;

  el.querySelector('#prog-nom').addEventListener('change', (e) => {
    prog.nom = e.target.value.trim() || 'Programme';
    sauver();
  });

  el.querySelectorAll('.inp-jour').forEach((inp) =>
    inp.addEventListener('change', () => {
      prog.jours[Number(inp.dataset.j)].nom = inp.value.trim() || 'Jour';
      sauver();
    }));

  // Cibles (sets × valeur) éditables en ligne.
  el.querySelectorAll('.inp-cible').forEach((inp) =>
    inp.addEventListener('change', () => {
      const [j, k] = inp.dataset.jk.split(':').map(Number);
      prog.jours[j].exercices[k].cible[inp.dataset.champ] = Math.max(1, Number(inp.value) || 1);
      sauver();
    }));

  el.querySelectorAll('[data-suppr-exo-prog]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const [j, k] = btn.dataset.supprExoProg.split(':').map(Number);
      prog.jours[j].exercices.splice(k, 1);
      await sauver();
      editerProgramme(el, id);
    }));

  el.querySelectorAll('[data-suppr-jour]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const j = Number(btn.dataset.supprJour);
      if (prog.jours[j].exercices.length && !(await confirmer(`Supprimer ${prog.jours[j].nom} et ses exercices ?`, { oui: 'Supprimer', danger: true }))) return;
      prog.jours.splice(j, 1);
      await sauver();
      editerProgramme(el, id);
    }));

  el.querySelectorAll('[data-add-exo]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const j = Number(btn.dataset.addExo);
      choisirExercice({
        exercices: ctx.exercices,
        onChoisi: async (exId) => {
          const ex = ctx.exercices.get(exId);
          prog.jours[j].exercices.push({
            exerciceId: exId,
            // Cible par défaut raisonnable, modifiable en ligne ensuite.
            cible: { sets: 3, valeur: ex.type === 'hold' ? 15 : 8 },
          });
          await sauver();
          editerProgramme(el, id);
        },
      });
    }));

  el.querySelectorAll('[data-demarrer]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const j = Number(btn.dataset.demarrer);
      if (!prog.jours[j].exercices.length) {
        toast('Ajoute d\'abord des exercices à ce jour.');
        return;
      }
      await setReglage('template_a_demarrer', { programmeId: prog.id, jourIdx: j });
      location.hash = '#/seance';
    }));

  el.querySelector('#btn-add-jour').addEventListener('click', async () => {
    prog.jours.push({ nom: 'Jour ' + (prog.jours.length + 1), exercices: [] });
    await sauver();
    editerProgramme(el, id);
  });

  el.querySelector('#btn-suppr-prog').addEventListener('click', async () => {
    if (!(await confirmer('Supprimer ce programme ?', { oui: 'Supprimer', danger: true }))) return;
    await dbSupprimer('programmes', id);
    location.hash = '#/programmes';
  });
}

// --- Assistant de génération (moteur/generateur.js) --------------------------

async function assistant(el) {
  const programmes = await dbGetAll('programmes');
  const existant = programmes.find((p) => p.genere);
  // Matériel pré-coché depuis la dernière séance loggée.
  const sessions = await dbGetAll('sessions');
  const derniere = sessions.sort((a, b) => b.dateDebut.localeCompare(a.dateDebut))[0];
  const dernierMateriel = derniere?.contraintes.materiel || [];
  const equip = (ctx.meta?.enums.equipement || ['barre', 'anneaux', 'parallettes', 'elastiques', 'surface_surelevee'])
    .filter((e) => e !== 'aucun');

  el.innerHTML = `
    <a class="retour" href="#/programmes">← Programmes</a>
    <h1>✨ Générer un programme</h1>
    <p class="texte-2">Un plan long terme construit sur tes objectifs, ton niveau (PR) et ton matériel,
      qui évolue tout seul séance après séance.</p>
    ${existant ? `<p class="texte-attention">⚠ Remplacera « ${echapper(existant.nom)} ». Tes programmes créés à la main ne sont pas touchés.</p>` : ''}
    <div class="carte">
      <h3>Objectif principal</h3>
      <div class="chips" id="chips-objectif-global">
        ${[['muscle', '💪 Prendre du muscle'], ['skills', '🤸 Maîtriser des skills'], ['gras', '🔥 Perdre du gras'], ['forme', '⚖️ Forme générale']]
          .map(([id, nom]) => `<label class="chip"><input type="radio" name="objectif-global" value="${id}" ${id === 'skills' ? 'checked' : ''}><span>${nom}</span></label>`).join('')}
      </div>
      <p class="texte-2" id="note-objectif"></p>
      <h3 id="titre-skills">Skills à travailler</h3>
      <div class="chips" id="chips-objectifs">
        ${ctx.skills.map((s) => `<label class="chip"><input type="checkbox" value="${s.id}"><span>${s.nom}</span></label>`).join('')}
      </div>
      <div class="ligne-2">
        <label>Séances / semaine
          <select id="sel-frequence">
            <option value="2">2</option>
            <option value="3" selected>3</option>
            <option value="4">4</option>
          </select></label>
        <label>Durée d'une séance
          <select id="sel-duree">
            <option value="30">30 min</option>
            <option value="45" selected>45 min</option>
            <option value="60">60 min</option>
          </select></label>
      </div>
      <h3>Matériel habituel</h3>
      <div class="chips" id="chips-materiel-gen">
        ${equip.map((e) => `<label class="chip"><input type="checkbox" value="${e}" ${dernierMateriel.includes(e) ? 'checked' : ''}><span>${libelle(e)}</span></label>`).join('')}
      </div>
      <button class="btn btn-accent btn-large" id="btn-lancer-generation">Générer</button>
    </div>`;

  // Note contextuelle sous l'objectif principal (mise à jour au changement).
  const NOTES = {
    muscle: 'Zone hypertrophie : 4 séries de 8-15, repos modérés, priorité aux mouvements en répétitions. Skills en option.',
    skills: 'Le travail technique ouvre chaque séance, à froid. Choisis 1 à 3 skills ci-dessous.',
    gras: 'Séances denses (repos courts) + un finisher métabolique. L\'entraînement préserve le muscle — le déficit se joue surtout dans l\'assiette.',
    forme: 'Équilibre général : force, skills optionnels, volume réparti sur tout le corps.',
  };
  const majNote = () => {
    const val = el.querySelector('input[name="objectif-global"]:checked').value;
    el.querySelector('#note-objectif').textContent = NOTES[val];
    el.querySelector('#titre-skills').textContent =
      val === 'skills' ? 'Skills à travailler (1 à 3)' : 'Skills à travailler (optionnel, 3 max)';
  };
  majNote();
  el.querySelectorAll('input[name="objectif-global"]').forEach((r) => r.addEventListener('change', majNote));

  el.querySelector('#btn-lancer-generation').addEventListener('click', async () => {
    const objectifGlobal = el.querySelector('input[name="objectif-global"]:checked').value;
    const objectifs = [...el.querySelectorAll('#chips-objectifs input:checked')].map((i) => i.value);
    if (objectifGlobal === 'skills' && !objectifs.length) {
      toast('En mode skills, choisis 1 à 3 skills à travailler.');
      return;
    }
    if (objectifs.length > 3) {
      toast('3 skills maximum — concentre le travail technique.');
      return;
    }
    const materiel = [...el.querySelectorAll('#chips-materiel-gen input:checked')].map((i) => i.value);

    const etats = new Map();
    for (const skill of ctx.skills) etats.set(skill.id, await getEtatSkill(skill));
    const prs = new Map((await dbGetAll('pr')).map((p) => [p.exerciceId, p]));

    const prog = genererProgramme({
      objectifs,
      objectifGlobal,
      frequence: Number(el.querySelector('#sel-frequence').value),
      materiel,
      dureeMin: Number(el.querySelector('#sel-duree').value),
    }, { exercices: ctx.exercices, skills: ctx.skills, etats, prs });

    if (existant) {
      if (!(await confirmer(`Remplacer « ${existant.nom} » par le nouveau programme ?`, { oui: 'Remplacer' }))) return;
      await dbSupprimer('programmes', existant.id);
    }
    await dbPut('programmes', prog);
    toast('Programme généré ✨');
    location.hash = '#/programmes/' + prog.id;
  });
}

// En-tête d'un programme généré : semaine courante, règles, journal d'évolution.
function carteGenere(prog) {
  const g = prog.genere;
  const noms = g.objectifs.map((id) => ctx.config.noms[id] || id).join(', ');
  const profilNom = PROFILS[g.objectifGlobal]?.nom || PROFILS.forme.nom;
  return `
    <div class="carte accent">
      <strong>✨ Programme généré · semaine ${semaineCourante(prog)}</strong>
      <div class="texte-2">${profilNom}${noms ? ' · skills : ' + noms : ''} · ${g.frequence} séances/sem · deload 1 semaine sur ${REGLES.SEMAINE_DELOAD}.
        Les cibles évoluent seules après chaque séance (double progression) et restent modifiables ici.</div>
      ${g.journal?.length ? `
        <h3>Dernières évolutions</h3>
        ${g.journal.slice(0, 5).map((jl) =>
          `<div class="texte-2">${new Date(jl.date).toLocaleDateString('fr-FR')} — ${jl.texte}</div>`).join('')}` : ''}
    </div>`;
}

function ligneExo(e, j, k) {
  const ex = ctx.exercices.get(e.exerciceId);
  const unite = ex?.type === 'hold' ? 's' : 'reps';
  return `
    <div class="set">
      <span class="set-meta">${ex?.nom || e.exerciceId}</span>
      <input class="inp-cible" type="number" min="1" inputmode="numeric"
             data-jk="${j}:${k}" data-champ="sets" value="${e.cible.sets}">
      <span class="texte-2">×</span>
      <input class="inp-cible" type="number" min="1" inputmode="numeric"
             data-jk="${j}:${k}" data-champ="valeur" value="${e.cible.valeur}">
      <span class="texte-2">${unite}</span>
      <button class="btn-x" data-suppr-exo-prog="${j}:${k}">×</button>
    </div>`;
}
