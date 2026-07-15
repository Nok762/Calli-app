// vue-reglages.js — réglages + sauvegarde des données.
//
// L'app est 100 % offline : TOUTES les données vivent dans l'IndexedDB de CE
// navigateur. L'export/import JSON est donc la seule assurance-vie de
// l'historique (téléphone perdu, navigateur réinitialisé, éviction iOS).

import { ctx } from '../app.js';
import { dbGetAll, dbVider, dbPut, getReglage, setReglage } from '../db.js';
import { recalculerTousPR } from '../pr.js';
import { toast, setSonActif, confirmer, libelle } from './composants.js';

// Stores exportés/importés. 'exercices' est exclu : le seed reste la source de
// vérité et se réimporte tout seul. 'reglages' inclut seedVersion : si le seed
// importé est plus vieux que celui de l'app, la réimport se déclenche d'elle-même.
const STORES_DONNEES = ['etat_skills', 'sessions', 'pr', 'poids', 'programmes', 'reglages'];

export async function vueReglages(el) {
  const [repos, prepa, son, zonesFragiles] = await Promise.all([
    getReglage('dureeRepos', 90),
    getReglage('dureePrepa', 5),
    getReglage('son', true),
    getReglage('zonesFragiles', []),
  ]);
  const zones = ctx.meta?.enums.zones_a_risque || ['poignets', 'epaules', 'coudes', 'lombaires', 'genoux'];

  // État du stockage : persistant = le navigateur s'engage à ne pas purger.
  let persistant = null;
  let usage = null;
  try {
    persistant = await navigator.storage?.persisted?.();
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) usage = Math.round(est.usage / 1024);
  } catch { /* API indisponible : on affiche juste moins d'infos */ }

  const nbSessions = (await dbGetAll('sessions')).length;

  el.innerHTML = `
    <a class="retour" href="#/accueil">← Accueil</a>
    <h1>Réglages</h1>

    <div class="carte">
      <h3>Séance</h3>
      <div class="ligne-2">
        <label>Repos auto (s)
          <input id="reg-repos" type="number" inputmode="numeric" min="15" value="${repos}"></label>
        <label>Prépa tenue (s)
          <input id="reg-prepa" type="number" inputmode="numeric" min="0" value="${prepa}"></label>
      </div>
      <div class="chips" style="margin-top:10px">
        <label class="chip"><input type="checkbox" id="reg-son" ${son ? 'checked' : ''}><span>Son + vibration</span></label>
      </div>
    </div>

    <div class="carte">
      <h3>Zones sensibles (chroniques)</h3>
      <p class="texte-2">Douleurs ou fragilités récurrentes : la génération de programmes évite les
        exercices qui les chargent, et elles seront pré-cochées au démarrage de chaque séance.</p>
      <div class="chips" id="chips-zones-fragiles">
        ${zones.map((z) => `<label class="chip"><input type="checkbox" value="${z}" ${zonesFragiles.includes(z) ? 'checked' : ''}><span>${libelle(z)}</span></label>`).join('')}
      </div>
    </div>

    <div class="carte">
      <h3>Sauvegarde des données</h3>
      <p class="texte-2">Ton historique (${nbSessions} séance${nbSessions > 1 ? 's' : ''}) vit uniquement dans ce navigateur.
        Exporte régulièrement — c'est la seule copie.</p>
      <p class="texte-2">${persistant === true ? 'Stockage persistant accordé.'
        : persistant === false ? 'Stockage non persistant : le navigateur peut purger les données — exporte souvent, ou installe l\'app (PWA).'
        : ''}${usage != null ? ` · ${usage} Ko utilisés` : ''}</p>
      <div class="ligne-2">
        <button class="btn btn-accent" id="btn-exporter">Exporter</button>
        <button class="btn" id="btn-importer">Importer</button>
      </div>
      <input type="file" id="inp-import" accept="application/json,.json" hidden>
      <button class="btn btn-lien" id="btn-recalc-pr">Recalculer les PR depuis l'historique</button>
    </div>

    <div class="carte erreur">
      <h3>Zone sensible</h3>
      <button class="btn btn-danger btn-large" id="btn-reset" style="margin-top:0">Tout effacer (irréversible)</button>
    </div>`;

  el.querySelector('#reg-repos').addEventListener('change', (e) => {
    setReglage('dureeRepos', Math.max(15, Number(e.target.value) || 90));
  });
  el.querySelector('#reg-prepa').addEventListener('change', (e) => {
    setReglage('dureePrepa', Math.max(0, Number(e.target.value) || 0));
  });
  el.querySelector('#reg-son').addEventListener('change', async (e) => {
    await setReglage('son', e.target.checked);
    setSonActif(e.target.checked);
  });

  el.querySelector('#chips-zones-fragiles').addEventListener('change', () => {
    const cochees = [...el.querySelectorAll('#chips-zones-fragiles input:checked')].map((i) => i.value);
    setReglage('zonesFragiles', cochees);
  });

  // --- Export : un fichier JSON autoportant, daté. --------------------------------
  el.querySelector('#btn-exporter').addEventListener('click', async () => {
    const stores = {};
    for (const nom of STORES_DONNEES) stores[nom] = await dbGetAll(nom);
    const sauvegarde = {
      app: 'callisthenie',
      formatVersion: 1,
      date: new Date().toISOString(),
      stores,
    };
    const blob = new Blob([JSON.stringify(sauvegarde)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calli-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Sauvegarde exportée');
  });

  // --- Import : remplace les données par celles du fichier. ------------------------
  el.querySelector('#btn-importer').addEventListener('click', () =>
    el.querySelector('#inp-import').click());

  el.querySelector('#inp-import').addEventListener('change', async (e) => {
    const fichier = e.target.files?.[0];
    if (!fichier) return;
    e.target.value = ''; // permet de réimporter le même fichier plus tard
    let sauvegarde;
    try {
      sauvegarde = JSON.parse(await fichier.text());
    } catch {
      toast('Fichier illisible — ce n\'est pas un JSON valide.');
      return;
    }
    if (sauvegarde?.app !== 'callisthenie' || !sauvegarde.stores) {
      toast('Ce fichier n\'est pas une sauvegarde de l\'app.');
      return;
    }
    const nb = sauvegarde.stores.sessions?.length ?? 0;
    if (!(await confirmer(`Remplacer les données actuelles par la sauvegarde du ${new Date(sauvegarde.date).toLocaleDateString('fr-FR')} (${nb} séances) ?`, { oui: 'Remplacer', danger: true }))) return;

    for (const nom of STORES_DONNEES) {
      if (!Array.isArray(sauvegarde.stores[nom])) continue;
      await dbVider(nom);
      for (const item of sauvegarde.stores[nom]) await dbPut(nom, item);
    }
    toast('Import terminé — rechargement…');
    setTimeout(() => location.reload(), 800);
  });

  el.querySelector('#btn-recalc-pr').addEventListener('click', async () => {
    const nb = await recalculerTousPR(ctx.exercices);
    toast(`PR reconstruits depuis ${nb} séance${nb > 1 ? 's' : ''} ✓`);
  });

  // --- Reset total ------------------------------------------------------------------
  el.querySelector('#btn-reset').addEventListener('click', async () => {
    if (!(await confirmer('Effacer TOUTES les données (séances, PR, skills, programmes) ?', { oui: 'Effacer', danger: true }))) return;
    if (!(await confirmer('Vraiment sûr ? Il n\'y a pas de retour en arrière sans export.', { oui: 'Tout effacer', danger: true }))) return;
    for (const nom of STORES_DONNEES) await dbVider(nom);
    toast('Données effacées — rechargement…');
    setTimeout(() => location.reload(), 800);
  });
}
