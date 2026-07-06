// composants.js — composants UI partagés : toast, bip sonore, chrono de repos,
// graphique en ligne sur canvas (sans lib), libellés d'affichage, picker
// d'exercice (avec filtre « matériel du jour » quand des contraintes sont
// fournies).

import { compatibleMateriel, verifierExercice } from '../moteur/adaptation.js';

// Libellés : déplacés dans js/libelles.js (partagés avec le moteur, qui
// construit des explications lisibles). Ré-exportés ici pour les vues.
export { libelle } from '../libelles.js';

// --- Toast -------------------------------------------------------------------
export function toast(message, duree = 2800) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duree);
}

// --- Son + vibration ----------------------------------------------------------
// Bip généré en WebAudio : aucun fichier audio à embarquer (donc rien à cacher
// dans le service worker). La vibration prend le relais si l'audio est bloqué.
let audioCtx = null;
export function bip(nb = 3) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < nb; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 880;
      const t = audioCtx.currentTime + i * 0.35;
      gain.gain.setValueAtTime(0.4, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.start(t);
      osc.stop(t + 0.3);
    }
  } catch { /* audio indisponible */ }
  navigator.vibrate?.([200, 100, 200, 100, 400]);
}

// --- Chrono de repos -----------------------------------------------------------
// Bandeau fixé au-dessus de la nav : compte à rebours ajustable (±15 s),
// son + vibration à la fin. Un seul chrono actif à la fois.
let chronoInterval = null;

export function chronoRepos(secondes) {
  arreterChrono();
  let restant = secondes;

  const el = document.createElement('div');
  el.className = 'chrono-repos';
  el.innerHTML = `
    <button data-act="-15">−15s</button>
    <span class="chrono-temps"></span>
    <button data-act="+15">+15s</button>
    <button data-act="stop" class="chrono-stop">Passer</button>`;
  document.body.appendChild(el);

  const affiche = () => {
    const m = Math.floor(restant / 60);
    const s = restant % 60;
    el.querySelector('.chrono-temps').textContent = `${m}:${String(s).padStart(2, '0')}`;
  };
  affiche();

  el.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === '+15') { restant += 15; affiche(); }
    if (act === '-15') { restant = Math.max(0, restant - 15); affiche(); }
    if (act === 'stop') arreterChrono();
  });

  chronoInterval = setInterval(() => {
    restant--;
    if (restant <= 0) {
      arreterChrono();
      bip();
      toast('Repos terminé — au boulot 💪');
    } else {
      affiche();
    }
  }, 1000);
}

export function arreterChrono() {
  clearInterval(chronoInterval);
  chronoInterval = null;
  document.querySelector('.chrono-repos')?.remove();
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
