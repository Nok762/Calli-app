// composants.js — composants UI partagés : toast, bip sonore, chrono de repos,
// graphique en ligne sur canvas (sans lib), libellés d'affichage, picker
// d'exercice (avec filtre « matériel du jour » quand des contraintes sont
// fournies).

import { compatibleMateriel, verifierExercice } from '../moteur/adaptation.js';

// Libellés : déplacés dans js/libelles.js (partagés avec le moteur, qui
// construit des explications lisibles). Ré-exportés ici pour les vues.
export { libelle } from '../libelles.js';

// --- Confirmation maison ---------------------------------------------------------
// Remplace window.confirm : les dialogues natifs sortent du plein écran (mode
// Focus) et cassent l'immersion. Message inséré en textContent (pas d'injection).
export function confirmer(message, { oui = 'OK', non = 'Annuler', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="feuille feuille-confirm">
        <p></p>
        <div class="ligne-2">
          <button class="btn" data-non></button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-accent'}" data-oui></button>
        </div>
      </div>`;
    overlay.querySelector('p').textContent = message;
    overlay.querySelector('[data-non]').textContent = non;
    overlay.querySelector('[data-oui]').textContent = oui;
    document.body.appendChild(overlay);
    const fermer = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('[data-non]').addEventListener('click', () => fermer(false));
    overlay.querySelector('[data-oui]').addEventListener('click', () => fermer(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fermer(false); });
  });
}

// --- Checklist en feuille ----------------------------------------------------------
// Liste cochable (échauffement, étirements) : chaque ligne se coche, « Terminé »
// ferme. Contenus insérés en textContent.
export function afficherChecklist({ titre, note = '', items }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="feuille">
      <div class="feuille-tete">
        <strong></strong>
        <button class="btn-x" data-fermer>×</button>
      </div>
      ${note ? '<p class="texte-2" style="margin:0 0 10px"></p>' : ''}
      <div class="picker-liste">
        ${items.map(() => '<label class="etirement-item"><input type="checkbox"><span></span></label>').join('')}
      </div>
      <button class="btn btn-accent btn-large" data-fermer>Terminé</button>
    </div>`;
  overlay.querySelector('strong').textContent = titre;
  if (note) overlay.querySelector('p.texte-2').textContent = note;
  [...overlay.querySelectorAll('.etirement-item span')].forEach((sp, i) => { sp.textContent = items[i]; });
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-fermer]')) overlay.remove();
  });
}

// --- Toast -------------------------------------------------------------------
export function toast(message, duree = 2800) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duree);
}

// --- Sons + vibration -----------------------------------------------------------
// Générés en WebAudio : aucun fichier audio à embarquer (donc rien à cacher
// dans le service worker). La vibration prend le relais si l'audio est bloqué.
// Coupables globalement depuis Réglages (flag chargé au boot).
let audioCtx = null;
let sonActif = true;

export function setSonActif(actif) { sonActif = actif; }

function jouer(freq, duree, gain, delai = 0) {
  if (!sonActif) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.frequency.value = freq;
    const t = audioCtx.currentTime + delai;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duree);
    osc.start(t);
    osc.stop(t + duree + 0.05);
  } catch { /* audio indisponible */ }
}

// Fin de repos : triple bip appuyé.
export function bip(nb = 3) {
  for (let i = 0; i < nb; i++) jouer(880, 0.25, 0.4, i * 0.35);
  if (sonActif) navigator.vibrate?.([200, 100, 200, 100, 400]);
}

// Décompte de préparation (3… 2… 1…) : bip bref et grave.
export function tick() {
  jouer(660, 0.12, 0.3);
  if (sonActif) navigator.vibrate?.(60);
}

// Signal de départ d'une tenue : bip haut et long, impossible à confondre.
export function go() {
  jouer(990, 0.4, 0.5);
  if (sonActif) navigator.vibrate?.([120, 60, 240]);
}

// --- Graphique en ligne (canvas) -----------------------------------------------
// points : [{ x: Date|string|timestamp, y: Number }] triés par x croissant.
export function graphiqueLigne(canvas, points) {
  const dpr = window.devicePixelRatio || 1;
  const larg = canvas.clientWidth || 320;
  const haut = canvas.clientHeight || 170;
  canvas.width = larg * dpr;
  canvas.height = haut * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);

  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#3ddc97';
  const texte2 = css.getPropertyValue('--texte-2').trim() || '#8a94a3';
  const bord = css.getPropertyValue('--bord').trim() || '#232d38';

  g.clearRect(0, 0, larg, haut);
  if (!points.length) {
    g.fillStyle = texte2;
    g.font = '13px system-ui';
    g.textAlign = 'center';
    g.fillText('Pas encore de données', larg / 2, haut / 2);
    return;
  }

  const xs = points.map((p) => +new Date(p.x));
  const ys = points.map((p) => p.y);
  let minX = Math.min(...xs), maxX = Math.max(...xs);
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  // Évite les divisions par zéro quand il n'y a qu'un point ou une valeur unique.
  if (minX === maxX) { minX -= 86400000; maxX += 86400000; }
  if (minY === maxY) { minY = Math.max(0, minY - 1); maxY += 1; }

  const marge = { g: 38, d: 12, h: 10, b: 22 };
  const X = (v) => marge.g + ((v - minX) / (maxX - minX)) * (larg - marge.g - marge.d);
  const Y = (v) => haut - marge.b - ((v - minY) / (maxY - minY)) * (haut - marge.h - marge.b);

  // Grille horizontale + libellés (min, milieu, max).
  g.strokeStyle = bord;
  g.lineWidth = 1;
  g.fillStyle = texte2;
  g.font = '11px system-ui';
  for (const v of [minY, (minY + maxY) / 2, maxY]) {
    g.beginPath();
    g.moveTo(marge.g, Y(v));
    g.lineTo(larg - marge.d, Y(v));
    g.stroke();
    g.textAlign = 'right';
    g.fillText(String(Math.round(v * 10) / 10), marge.g - 6, Y(v) + 4);
  }

  // Libellés X : première et dernière date.
  const dateCourte = (ts) => new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  g.textAlign = 'left';
  g.fillText(dateCourte(Math.min(...xs)), marge.g, haut - 6);
  g.textAlign = 'right';
  g.fillText(dateCourte(Math.max(...xs)), larg - marge.d, haut - 6);

  // Courbe + points.
  g.strokeStyle = accent;
  g.lineWidth = 2;
  g.beginPath();
  points.forEach((p, i) => {
    const x = X(+new Date(p.x)), y = Y(p.y);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
  g.fillStyle = accent;
  for (const p of points) {
    g.beginPath();
    g.arc(X(+new Date(p.x)), Y(p.y), 3, 0, Math.PI * 2);
    g.fill();
  }
}

// --- Picker d'exercice -----------------------------------------------------------
// Feuille de sélection réutilisée par la séance et l'éditeur de programmes.
// Si `contraintes` est fourni (séance en cours), un filtre « matériel du jour »
// est proposé (actif par défaut) et les conflits douleur/matériel sont signalés
// sur chaque ligne — mais jamais bloqués : l'utilisateur garde le dernier mot.
export function choisirExercice({ exercices, contraintes = null, onChoisi }) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="feuille">
      <div class="feuille-tete">
        <input type="search" id="picker-recherche" placeholder="Chercher un exercice…">
        <button class="btn-x" id="picker-fermer">×</button>
      </div>
      ${contraintes ? `
        <label class="chip chip-filtre">
          <input type="checkbox" id="picker-filtre" checked><span>Matériel du jour</span>
        </label>` : ''}
      <div class="picker-liste" id="picker-liste"></div>
    </div>`;
  document.body.appendChild(overlay);

  const exos = [...exercices.values()].sort((a, b) => a.nom.localeCompare(b.nom));
  const rendre = () => {
    const f = overlay.querySelector('#picker-recherche').value.toLowerCase();
    const filtreMat = overlay.querySelector('#picker-filtre')?.checked;
    overlay.querySelector('#picker-liste').innerHTML = exos
      .filter((ex) => ex.nom.toLowerCase().includes(f))
      .filter((ex) => !filtreMat || compatibleMateriel(ex, contraintes.materiel))
      .map((ex) => {
        const verif = contraintes ? verifierExercice(ex, contraintes) : { ok: true, raisons: [] };
        return `
          <button class="picker-item" data-id="${ex.id}">
            <span>${ex.nom}${verif.ok ? '' : `<br><small class="texte-attention">⚠ ${verif.raisons.join(' · ')}</small>`}</span>
            <span class="texte-2">${ex.type === 'hold' ? 'tenue' : 'reps'} · diff. ${ex.difficulte}</span>
          </button>`;
      }).join('') || '<p class="texte-2 centre">Aucun résultat</p>';
  };
  rendre();

  overlay.querySelector('#picker-recherche').addEventListener('input', rendre);
  overlay.querySelector('#picker-filtre')?.addEventListener('change', rendre);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'picker-fermer') {
      overlay.remove();
      return;
    }
    const item = e.target.closest('.picker-item');
    if (item) {
      overlay.remove();
      onChoisi(item.dataset.id);
    }
  });
}
