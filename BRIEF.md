# BRIEF.md — Application de callisthénie

> Les règles de travail permanentes et les contraintes techniques sont dans `CLAUDE.md`.
> Ce fichier décrit QUOI construire. Commence par lire `CLAUDE.md` et
> `data/exercices.seed.json`, puis propose l'arborescence de fichiers + le modèle de
> données, et attends ma validation AVANT de coder.

# Objectif
Une PWA de callisthénie, offline-first, pour usage perso. Deux choses la distinguent
d'un tracker fitness générique :
1. Les PROGRESSIONS DE SKILLS (planche, front lever, muscle-up, handstand, pistol…),
   avec gestion des exercices ISOMÉTRIQUES (secondes de tenue, pas seulement des reps).
2. Un MOTEUR D'ADAPTATION intelligent qui ajuste la séance aux contraintes de
   l'utilisateur — matérielles et physiques — et propose les meilleures alternatives.

Ces deux features reposent sur une même fondation : une bibliothèque d'exercices
richement structurée (fournie dans `data/exercices.seed.json`).

# Stack technique
Voir `CLAUDE.md`. En résumé : vanilla HTML/CSS/JS, PWA offline-first, IndexedDB,
mobile-first, déployable en statique. Pas de framework, pas de backend.

# Fonctionnalités, par ordre de priorité

## 1. Progressions de skills (feature centrale)
- Bibliothèque de skills organisés en arbres de progression (données : voir seed,
  champs `skill` + `step` sur les exercices concernés).
- Chaque étape a un critère de déblocage (X secondes de tenue OU Y reps).
- L'utilisateur voit son étape actuelle, la valide, débloque la suivante.
- Skills couverts par le seed : planche, front lever, back lever, muscle-up, handstand,
  pistol, L-sit, V-sit, dragon flag, nordic curl, one-arm pull-up.

## 2. Log de séance
- Créer et logger une séance en direct.
- Gérer les DEUX types d'exercices : reps × séries ET isométriques (secondes de tenue).
- RPE par série. Chrono de repos entre séries (configurable, avec son + vibration).

## 3. Programmes / routines
- Templates réutilisables (Push/Pull/Legs, journée skill, etc.).
- Démarrer une séance depuis un template en un tap.

## 4. Suivi de progression
- Historique par exercice, PR (reps max / tenue max en secondes).
- Log de poids de corps + graphiques (poids, volume, tenues max dans le temps).

## 5. Tags d'équipement
- Chaque exercice est taggé (voir champ `equipement` du seed).
- Filtre "matériel dispo aujourd'hui" pour construire une séance sans matériel.

## 6. Dashboard
- Plan du jour, streak, PR récents, prochain palier de skill à débloquer.

# Bibliothèque d'exercices (fondation du moteur)
La bibliothèque est fournie dans `data/exercices.seed.json` — c'est la source de vérité
(voir `CLAUDE.md`, ne pas l'improviser). Chaque exercice porte les métadonnées qui
permettent au moteur de choisir les bons exercices et alternatives :

- `id`, `nom`
- `type` : `reps` | `hold` (isométrique)
- `pattern` : pattern de mouvement (poussée horizontale/verticale, tirage vertical/
  horizontal, squat, hinge, gainage anti-extension, anti-rotation, straight-arm)
- `muscles_primaires` + `muscles_secondaires`
- `equipement` : aucun / barre / anneaux / parallettes / élastiques / surface surélevée
- `difficulte` : échelle 1–10
- `skill` + `step` : si l'exercice appartient à un arbre de progression
- `lateralite` : bilatéral / unilatéral
- `zones_a_risque` : poignets, épaules, coudes, lombaires, genoux
  (pour écarter un exercice si l'utilisateur signale une douleur)
- `regression` (variantes plus faciles) / `progression` (plus dures)
- `equivalence` : substituts directs (même pattern + mêmes muscles primaires)
- `consignes` + `erreurs_frequentes`

Le bloc `meta` du seed contient les énumérations et une note sur la logique de substitution.

# Moteur d'adaptation intelligent
L'app s'adapte aux contraintes de l'utilisateur, matérielles ET physiques.
Elle tourne uniquement sur les données de l'app + les contraintes déclarées
(pas d'intégration santé externe).

## Entrées (demandées avant la séance, rapides à renseigner)
- Matériel dispo aujourd'hui (toggles : barre, anneaux, parallettes, élastiques, aucun).
- Zones de douleur / contraintes actives (poignet, épaule, coude, lombaires, genou),
  ponctuelles ou persistantes.
- Temps dispo.
- Niveau d'énergie / récup du jour (auto-report simple).
- Historique de performance : RPE, tenues (s), reps, échecs.

## Logique de substitution (cœur)
Quand un exercice prévu n'est pas réalisable — matériel absent, zone douloureuse
sollicitée, trop dur, ou trop facile — proposer le meilleur remplaçant :
1. même `pattern` + `muscles_primaires` recouvrants (via `equivalence` en priorité) ;
2. compatible avec le matériel dispo du jour (`equipement`) ;
3. ne charge pas la zone à éviter (`zones_a_risque`) ;
4. difficulté ajustée via `regression` / `progression`.
Toujours proposer 2-3 alternatives classées, jamais une seule imposée.

## Ajustement de séance
- Volume / intensité modulés selon l'énergie du jour + la tendance RPE.
- Séance raccourcie si temps réduit (prioriser les exercices clés).
- Auto-progression / deload selon les mêmes règles que l'arbre de skills :
  proposer le palier suivant si le critère est atteint de façon stable ;
  suggérer de rester ou reculer si échecs répétés ou RPE trop haut.

## Règles transverses
- Chaque suggestion est EXPLICABLE : afficher pourquoi
  (« pas de barre → rowing sous table », « poignet signalé → pompes sur poings »).
- Chaque suggestion est OVERRIDABLE : l'utilisateur garde toujours le dernier mot.

# Modèle de données (à confirmer avant de coder)
Entités attendues :
- `Exercise` : tel que décrit dans le seed (source de vérité de la bibliothèque).
- `Skill` : dérivé des exercices ayant `skill` + `step` ; suit l'étape courante de l'utilisateur.
- `Program` : jours → liste d'exercices (templates réutilisables).
- `Session` : date, liste de sets (reps OU tenue en s, RPE), contraintes du jour déclarées.
- `BodyweightLog` : date, poids.
- `PR` : par exercice, meilleure perf (reps ou tenue).
- `UserState` : étape courante par skill, préférences, historique de contraintes.

# Design
Mobile-first, dark mode par défaut, épuré et motivant. Une seule couleur d'accent.
Grandes zones tactiles, rapide, zéro superflu.
