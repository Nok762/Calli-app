# Callisthénie — PWA offline-first

Tracker de callisthénie personnel : progressions de skills (planche, front lever,
muscle-up…), log de séances (reps **et** tenues isométriques), programmes
générés et adaptatifs, moteur de substitution intelligent. 100 % hors ligne,
aucun backend.

## Stack

Vanilla HTML / CSS / JS (ES modules), IndexedDB, service worker + manifest
(installable). Aucune dépendance, aucune étape de build.

## Lancer en local

```
python -m http.server 8123
```

puis ouvrir <http://localhost:8123>. (N'importe quel serveur statique convient ;
le service worker exige HTTPS ou localhost.)

## Déployer

Contenu 100 % statique : pousser tel quel sur GitHub Pages ou Netlify.
**À chaque mise à jour déployée, incrémenter `VERSION` dans `sw.js`** pour
invalider le cache des clients.

## Structure

- `data/exercices.seed.json` — bibliothèque d'exercices, **source de vérité**
  (voir `CLAUDE.md` avant d'y toucher).
- `data/skills.config.json` — critères de déblocage des étapes de skills.
- `js/moteur/` — moteur d'adaptation (substitutions, deload, auto-progression)
  et générateur de programmes ; fonctions pures, seuils dans `SEUILS`/`REGLES`.
- `js/ui/` — les vues (dashboard, skills, séance, suivi, exercices, programmes).
- `js/db.js` — wrapper IndexedDB maison ; `sw.js` — service worker offline-first.

Le cahier des charges est dans `BRIEF.md`, les règles de travail dans `CLAUDE.md`.
