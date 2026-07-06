# CLAUDE.md — Règles permanentes du projet

Ce fichier définit les règles à respecter en permanence sur ce projet.
Le cahier des charges des fonctionnalités est dans `BRIEF.md`.

## Contraintes techniques non négociables
- Vanilla HTML / CSS / JS. Aucun framework, aucune étape de build.
- PWA offline-first : manifest + service worker, installable, fonctionne 100 % hors ligne.
- Persistance en IndexedDB (wrapper propre, ou `idb` via CDN). Jamais de dépendance à un backend.
- Mobile-first, déployable en statique (GitHub Pages / Netlify).

## Bibliothèque d'exercices : source de vérité
- `data/exercices.seed.json` est LA source de vérité de la bibliothèque.
- NE PAS générer d'exercices de ton côté ni improviser des métadonnées.
- Si un exercice manque et doit être ajouté : respecter EXACTEMENT le schéma existant
  (mêmes champs, mêmes valeurs d'énumération listées dans `meta.enums`) et vérifier
  que chaque lien `regression` / `progression` / `equivalence` pointe vers un `id`
  qui existe réellement dans le fichier. Aucun lien cassé.

## Méthode de travail
- Toujours garder l'app fonctionnelle à chaque étape. Pas de commit qui casse tout.
- Build incrémental : une fonctionnalité complète à la fois, pas de demi-fonctionnalités.
- Commenter les parties délicates : IndexedDB, service worker, logique du moteur d'adaptation.
- Avant de coder une nouvelle grosse partie, proposer l'approche et attendre validation.

## Critères de validation (l'app est "bonne" si)
- Elle s'installe en PWA et fonctionne hors ligne.
- On peut logger une séance avec des exercices en reps ET en tenue (secondes).
- On peut valider une étape de skill et débloquer la suivante.
- On retrouve son historique et ses PR.
- Le moteur propose des alternatives cohérentes quand un exercice n'est pas réalisable
  (matériel absent, zone douloureuse, trop dur / trop facile), et chaque suggestion est
  explicable et modifiable manuellement.

## Style de communication attendu
- Direct et concret. Signaler les vrais problèmes techniques plutôt que contourner en silence.
