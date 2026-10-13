# AGENTS.md : règles pour toute IA qui travaille sur filo

Ce fichier est lu en premier, par n'importe quelle IA (Claude, Codex, Gemini…).
`CLAUDE.md` ne fait que renvoyer ici. L'état du projet, son architecture, ses
décisions et ses problèmes connus sont dans **`ETAT_PROJET.md`** : le lire
ensuite, en entier, avant de toucher au code.

---

## Règles de développement (projets de Noar)

### Contexte
- Noar est monteur et technicien vidéo, pas développeur. Il travaille uniquement sur Mac.
- Ses applications doivent tourner sur Mac et Windows (et sur Linux quand le projet le prévoit).
- Il publie lui-même sur GitHub : le code à partir du ZIP fourni, et les builds dans les Releases.

### 1. Périmètre : rien en dehors de la demande
- Ne modifier que ce qui est demandé.
- Pour tout le reste (outillage, scripts de build, dépendances, organisation des fichiers,
  comportements par défaut) : proposer, expliquer l'impact, puis attendre un « oui » explicite.
  Jamais d'initiative silencieuse.

### 2. Communication
- Répondre en français, simplement, sans jargon.
- Expliquer en quelques phrases ce que fait le code et pourquoi cette méthode plutôt qu'une autre.
- Signaler les conséquences concrètes : ce qui peut casser plus tard, ce qui sera difficile
  à modifier, les limites de la solution, les impacts sur le coût, la sécurité, la maintenance
  et les performances.
- Pas de flatterie. Si Noar se trompe, le lui dire et expliquer pourquoi.

### 3. Builds
- Chaque projet contient des scripts `build_*.command` qui génèrent depuis le Mac
  la version Mac, la version Windows et, selon le projet, les versions Linux (.deb, AppImage).
- Si un build Windows ou Linux depuis le Mac n'est pas réaliste, le dire clairement
  et proposer une autre solution.
- Ces scripts sont créés au démarrage du projet. Toute modification qui n'a pas été demandée
  suit la règle 1.

### 4. Versions
- Aucun bump sans que Noar ait confirmé explicitement le numéro.
- Procédure : proposer un numéro, attendre la confirmation, mettre à jour tous les emplacements
  listés dans `ETAT_PROJET.md` (section « Emplacements de la version »), puis vérifier
  qu'aucun n'a été oublié.
- Format : X.Y.Z.

### 5. Livraison : le ZIP
- À chaque bump, fournir `NomDuProjet_vX.Y.Z.zip` (ici `filo_v0.7.1.zip`).
- Une fois décompressé, le ZIP correspond exactement à ce que Noar pousse sur GitHub :
  sources, scripts de build, documentation et fichiers de suivi.
- Le ZIP ne contient pas :
  - les builds, qui vont dans les Releases ;
  - les dossiers générés (node_modules, dist, build…) ;
  - aucun secret (mot de passe, clé API, certificat de signature).
- Le ZIP doit suffire à lui seul pour que n'importe quelle IA, pas seulement Claude,
  reprenne le développement.

### 6. Fichiers de suivi (dans le ZIP, à jour à chaque bump)
- `README.md` : ce que fait l'app et comment la builder.
- `AGENTS.md` : ces règles, lisibles par toute IA. `CLAUDE.md` renvoie vers `AGENTS.md`.
- `ETAT_PROJET.md` : état actuel, architecture en bref, décisions prises et leurs raisons,
  problèmes connus, prochaines étapes, emplacements de la version.
- `CHANGELOG.md` : historique des versions.

### 7. Publication sur GitHub : scripts/push_github.command
- Chaque projet contient `scripts/push_github.command`. Noar décompresse le ZIP et
  double-clique ce script dans le dossier obtenu : GitHub devient exactement le
  contenu du dossier (ajouts, modifications et fichiers retirés). Jamais d'envoi
  par l'upload web de GitHub (il ne supprime rien et perd les droits d'exécution).
- Sous Windows : `scripts/push_github.bat` (double-clic), qui lance
  `scripts/push_github.ps1`. Mêmes étapes et mêmes refus ; il garde les fins de
  ligne telles quelles et marque les `.command` / `.sh` exécutables sur GitHub.
  Les deux scripts doivent rester équivalents : toute modification de l'un
  se reporte sur l'autre.
- Le script travaille dans une copie temporaire du dépôt, affiche la liste des
  changements et attend un « y ». Jamais d'envoi forcé.
- Chaque envoi porte une nouvelle version : le script refuse d'envoyer si la version
  de `version.json` n'est pas strictement supérieure à celle publiée sur GitHub, ou si
  `version.json` et `package.json` ne disent pas le même numéro.
- `version.json` part en dernier : tant que la Release et ses binaires ne sont pas
  publiés, le script garde l'ancien sur GitHub ; on le relance ensuite pour l'envoyer.
- Tout projet doit avoir un `version.json` (le script y lit la version, et l'adresse
  GitHub si `package.json` ne la donne pas).

---

## Propre à filo

### Langues
- À Noar : français. Code, commentaires, messages de commit, interface, README,
  CHANGELOG et notes de release : **anglais**.

### Interdits et réflexes
1. **L'IA ne pousse jamais sur GitHub.** La publication passe par
   `scripts/push_github.command`, lancé par Noar.
2. **Avant d'écrire une note de release, demander à Noar quelle version est en
   ligne sur GitHub.** Ne jamais le déduire.
3. **Aucun mot de passe en clair nulle part.** Trousseau macOS, Gestionnaire
   d'identifiants Windows, libsecret sous Linux, via `safeStorage`
   (`src/main/secrets.js`). Sous Linux, le backend `basic_text` est refusé. Les
   exports de sites n'emportent jamais de mot de passe. La fenêtre ne reçoit
   jamais un mot de passe enregistré (seulement le fait qu'il existe).
4. **Jamais faire confiance en silence à un serveur inconnu.** Clé SSH ou
   certificat FTPS inconnu : on montre l'empreinte, l'utilisateur décide. Une
   empreinte qui change est refusée, et rien n'est envoyé avant la vérification.
5. **Un fichier ne prend son vrai nom qu'une fois complet et vérifié**
   (`.filopart`). Ne pas écrire directement sous le nom final sauf si le réglage
   « Temporary name while sending » est coupé.
6. **Ne pas lancer `npm audit fix`** (les alertes viennent des outils de build).
7. **Ne pas lancer l'application sur le Mac de Noar sans le prévenir**
   (`npm run dev`) : elle ouvre son vrai profil (sites, file d'attente).
8. **Ne jamais ajouter `npm test` (ni rien d'autre) aux scripts de build** sans
   accord.
9. **Ne jamais inventer une option de ligne de commande** : vérifier la page de
   manuel (`notarytool`, `sha256sum`, commandes FTP…).
10. **Le moteur Rust (`engine/`) est en place depuis la 0.4.0** (Noar avait
    d'abord écarté Rust le 09/10/2026, puis l'a lancé le 10/10). Voir
    `ETAT_PROJET.md`, Décisions.
11. **Licences.** filo est sous GPL-3.0-or-later. Avant d'ajouter une
    dépendance (npm, crate Rust) ou d'embarquer un programme externe
    (Syncthing…), vérifier que sa licence est compatible avec la GPL v3 et le
    dire à Noar. Compatibles : MIT, ISC, BSD, Apache-2.0, BSL-1.0, Unlicense,
    Zlib, MPL-2.0, LGPL, GPL v3. **Incompatibles** : GPL-2.0 seule (sans « or
    later »), AGPL (sauf accord de Noar, elle change les obligations), SSPL,
    licences « non commerciales » ou propriétaires. Après tout changement de
    dépendance : `node scripts/third-party-notices.js`, puis livrer le
    `THIRD_PARTY_NOTICES.md` regénéré dans le ZIP.

### Commandes

```bash
npm install                            # dépendances (une fois)
npm test                               # suite complète (~1 min, serveur SFTP dans le processus)
node test/run-tests.js segments        # seulement les sections dont le nom contient "segments"
npm run dev                            # lance l'app sans build (vrai profil !)
FILO_LANES=inline npm run dev          # transferts dans le processus principal (débogage)
node scripts/syncthing-fetch.js        # Syncthing (mode SYNCTHING) pour npm run dev / npm test (les builds le font seuls)
node scripts/third-party-notices.js    # regénère THIRD_PARTY_NOTICES.md après un changement de dépendance
./build_mac.command                    # Mac arm64 .dmg, signé + notarisé (double-clic)
./build_windows.command                # Windows x64 depuis le Mac (double-clic)
build_on_windows.bat                   # Windows x64 sur un PC Windows (double-clic), sans Wine
bash scripts/build-linux.sh            # AppImage + .deb, sur une machine Linux uniquement
./build.sh --sign-check                # rapport de signature sans build
scripts/push_github.command            # publication, par Noar (double-clic, Mac)
scripts/push_github.bat / .ps1         # la même chose sous Windows
python3 scripts/make-icon-svg.py       # réécrit build-resources/icon.svg (pip install fonttools)
python3 scripts/gen-icons.py           # PNG / ICO / ICNS depuis icon.svg (pip install cairosvg pillow)
```

### Méthode de travail
- **Reproduire avant de corriger**, même quand la cause paraît évidente.
- **Chaque défaut corrigé a son test** dans `test/run-tests.js`.
- **Vérifier un test en le cassant** : remettre l'ancien code, constater que le
  test passe au rouge, remettre en état.
- Ce qui touche aux transferts se teste aussi contre de **vrais serveurs**
  (OpenSSH, vsftpd en FTP / FTPS explicite / implicite) et avec une **latence
  simulée** : voir `ETAT_PROJET.md`, Tests.
