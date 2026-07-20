// vue-onboarding.js — premier lancement : trois questions, un programme prêt.
// L'Accueil délègue ici tant que l'utilisateur n'a ni programme, ni séance,
// ni explicitement passé l'onboarding. Trois étapes lues sur un rail gradué
// (le motif signature) ; chaque réponse alimente directement le générateur et
// les réglages durables : matériel habituel (pré-coché ensuite à chaque
// séance) et zones sensibles chroniques.

import { ctx } from '../app.js';
import { dbGetAll, dbPut, setReglage } from '../db.js';
import { getEtatSkill } from '../skills.js';
import { genererProgramme } from '../moteur/generateur.js';
import { toast, libelle } from './composants.js';

const EQUIP_DEFAUT = ['barre', 'anneaux', 'parallettes', 'elastiques', 'surface_surelevee'];

// État du parcours : module-level pour survivre aux re-rendus d'étape,
// volontairement PAS persisté (un onboarding interrompu recommence à zéro).
const reponses = {
  etape: 1,
  objectifGlobal: 'skills',
  objectifs: [],
  materiel: [],
  zones: [],
  frequence: 3,
  duree: 45,
  mobilite: false,
};

const NOTES_OBJECTIF = {
  forme: 'Équilibré : force, gainage, régularité — la base durable.',
  muscle: 'Volume d\'hypertrophie, fourchettes de reps, repos moyens.',
  skills: 'Planche, front lever… le travail technique passe en premier, frais.',
  gras: 'Séances denses, repos courts, finisher métabolique.',
};

// `surSortie` : rappel vers l'Accueil normal (après création ou « plus tard »).
export function vueOnboarding(el, surSortie) {
  const chip = (type, nom, valeur, texte, coche) => `
    <label class="chip"><input type="${type}" name="${nom}" value="${valeur}" ${coche ? 'checked' : ''}><span>${texte}</span></label>`;

  const etapes = {
    1: () => `
      <h3>Ton objectif</h3>
      <div class="chips" id="onb-objectif">
        ${[['skills', 'Maîtriser des skills'], ['muscle', 'Prendre du muscle'], ['forme', 'Forme générale'], ['gras', 'Perdre du gras']]
          .map(([id, nom]) => chip('radio', 'onb-obj', id, nom, reponses.objectifGlobal === id)).join('')}
      </div>
      <p class="texte-2">${NOTES_OBJECTIF[reponses.objectifGlobal]}</p>
      ${reponses.objectifGlobal === 'skills' ? `
        <h3>Quels skills ?</h3>
        <div class="chips" id="onb-skills">
          ${ctx.skills.map((s) => chip('checkbox', 'onb-skill', s.id, s.nom, reponses.objectifs.includes(s.id))).join('')}
        </div>` : ''}`,
    2: () => `
      <h3>Ton matériel habituel</h3>
      <p class="texte-2">Coche ce que tu as sous la main en temps normal — tu pourras
        toujours ajuster au jour le jour avant chaque séance.</p>
      <div class="chips" id="onb-materiel">
        ${(ctx.meta?.enums.equipement || EQUIP_DEFAUT).filter((e) => e !== 'aucun')
          .map((e) => chip('checkbox', 'onb-mat', e, libelle(e), reponses.materiel.includes(e))).join('')}
      </div>
      <h3>Zones sensibles (chroniques)</h3>
      <p class="texte-2">Douleurs récurrentes : la génération évitera les exercices qui les chargent.</p>
      <div class="chips" id="onb-zones">
        ${(ctx.meta?.enums.zones_a_risque || [])
          .map((z) => chip('checkbox', 'onb-zone', z, libelle(z), reponses.zones.includes(z))).join('')}
      </div>`,
    3: () => `
      <h3>Ton rythme</h3>
      <div class="chips" id="onb-frequence">
        ${[2, 3, 4].map((f) => chip('radio', 'onb-freq', f, `${f} séances / sem.`, reponses.frequence === f)).join('')}
      </div>
      <h3>Durée d'une séance</h3>
      <div class="chips" id="onb-duree">
        ${[30, 45, 60].map((d) => chip('radio', 'onb-dur', d, `~${d} min`, reponses.duree === d)).join('')}
      </div>
      <div class="chips">
        ${chip('checkbox', 'onb-mob', 'oui', '+ Mobilité (5-8 min/séance)', reponses.mobilite)}
      </div>`,
  };

  el.innerHTML = `
    <div class="accueil-date">Bienvenue</div>
    <h1>On construit ton plan</h1>
    <div class="onb-prog">
      <div class="player-prog-txt">Étape ${reponses.etape} / 3</div>
      <div class="ligne rail"><div style="width:${(reponses.etape / 3) * 100}%"></div></div>
    </div>
    <div class="carte">
      ${etapes[reponses.etape]()}
      <button class="btn btn-accent btn-large" id="onb-suivant">
        ${reponses.etape < 3 ? 'Continuer' : 'Créer mon programme'}</button>
      ${reponses.etape > 1 ? '<button class="btn btn-large" id="onb-retour">← Retour</button>' : ''}
    </div>
    <p class="centre texte-2">Trois questions, c'est tout — le plan évoluera ensuite tout seul,
      séance après séance.<br><a href="#" id="onb-passer">Explorer l'app d'abord</a></p>`;

  // Lit les choix de l'étape affichée dans `reponses` (avant tout re-rendu).
  const lire = () => {
    if (reponses.etape === 1) {
      reponses.objectifGlobal = el.querySelector('[name=onb-obj]:checked')?.value || 'skills';
      reponses.objectifs = [...el.querySelectorAll('[name=onb-skill]:checked')].map((i) => i.value);
      if (reponses.objectifGlobal !== 'skills') reponses.objectifs = [];
    }
    if (reponses.etape === 2) {
      reponses.materiel = [...el.querySelectorAll('[name=onb-mat]:checked')].map((i) => i.value);
      reponses.zones = [...el.querySelectorAll('[name=onb-zone]:checked')].map((i) => i.value);
    }
    if (reponses.etape === 3) {
      reponses.frequence = Number(el.querySelector('[name=onb-freq]:checked')?.value || 3);
      reponses.duree = Number(el.querySelector('[name=onb-dur]:checked')?.value || 45);
      reponses.mobilite = !!el.querySelector('[name=onb-mob]:checked');
    }
  };

  // Changer d'objectif re-rend l'étape 1 (la liste de skills apparaît/disparaît).
  el.querySelector('#onb-objectif')?.addEventListener('change', () => {
    lire();
    vueOnboarding(el, surSortie);
  });

  el.querySelector('#onb-retour')?.addEventListener('click', () => {
    lire();
    reponses.etape--;
    vueOnboarding(el, surSortie);
  });

  el.querySelector('#onb-passer').addEventListener('click', async (e) => {
    e.preventDefault();
    await setReglage('onboarding_fait', true);
    surSortie();
  });

  el.querySelector('#onb-suivant').addEventListener('click', async () => {
    lire();
    if (reponses.etape < 3) {
      reponses.etape++;
      vueOnboarding(el, surSortie);
      return;
    }
    // Étape finale : réglages durables + génération du premier programme.
    await setReglage('materielHabituel', reponses.materiel);
    await setReglage('zonesFragiles', reponses.zones);
    await setReglage('onboarding_fait', true);
    const etats = new Map();
    for (const skill of ctx.skills) etats.set(skill.id, await getEtatSkill(skill));
    const prs = new Map((await dbGetAll('pr')).map((p) => [p.exerciceId, p]));
    const prog = genererProgramme({
      objectifs: reponses.objectifs,
      objectifGlobal: reponses.objectifGlobal,
      frequence: reponses.frequence,
      materiel: reponses.materiel,
      dureeMin: reponses.duree,
      mobilite: reponses.mobilite,
      zonesFragiles: reponses.zones,
    }, { exercices: ctx.exercices, skills: ctx.skills, etats, prs });
    await dbPut('programmes', prog);
    toast('Programme créé — ta première séance t\'attend');
    surSortie();
  });
}
