# ETAT_PROJET.md : état de filo

À lire après `AGENTS.md`. Mis à jour à chaque version.

---

## 1. État actuel

- **Version du code : 0.3.4** (10/10/2026) : renommage sur place, barre de
  connexion refaite (CONNECT / DISCONNECT, protocole en menu, connexions
  récentes avec les sites, adresse dans la barre de titre), réglages en
  catégories, puis revue complète du code avant GitHub (sécurité, aucun
  remplacement de fichier sans la règle, reprise). **Première version publiée
  sur GitHub** : 0.1.0 à 0.3.3 ne l'ont jamais été.
- **Tests : 393 vérifications, toutes vertes** (`npm test`, ~130 s), plus 18 avec
  de vrais serveurs FTP / FTPS (voir section 8).
- Versions des outils : Electron 43.7.9, electron-builder 26.15.x, Node ≥ 20.19
  (22 LTS conseillé). Dépendances d'exécution : `ssh2`, `basic-ftp` 6,
  `hash-wasm` — rien à compiler.
- **Premier essai de Noar sous Windows (09/10/2026)** : connexion OK ; deux
  défauts corrigés dans la même 0.1.0 (jamais publiée) :
  1. **Réception impossible vers S:\ (un SSD M.2 interne chez Noar)** :
     « EPERM, mkdir 'S:\' ». `fs.mkdir(…, { recursive: true })` de Node demande
     la racine du lecteur, que Windows refuse. `ensureLocalDir` remonte
     maintenant jusqu'au premier dossier existant et crée les manquants un par
     un. Le message d'erreur brut d'un fichier local est traduit (« filo is not
     allowed to write to … on this computer »), y compris depuis un fil de
     transfert, et n'est jamais réessayé. Le résumé de fin ne liste plus que
     les échecs de la passe qui vient de finir.
  2. **Changer de lecteur** obligeait à taper « D: » : un bouton **Browse**
     (icône seule, à gauche du chemin local) ouvre le sélecteur de dossier du
     système, qui atteint tous les disques et partages ; « .. » depuis la racine
     d'un lecteur mène à **This PC** (la liste des lecteurs, un lecteur réseau
     endormi marqué « not answering » au bout de 1,5 s) ; taper « D: » ou
     « This PC » dans le chemin fonctionne.
  À revérifier sur le PC.
- **Deuxième retour de Noar (09/10/2026), toujours dans la 0.1.0** :
  - Interface : bouton Browse local ; bouton **SYNC BROWSING** à droite de la
    connexion rapide (n'existait pas avant) ; lignes de file **sur le modèle
    d'ingesto** (anneau de progression autour du sens, nom, taille → destination,
    badge d'état, %, boutons **pause / reprise, stop, réessayer** par fichier,
    aussi au clic droit ; barre fine ; ligne d'origine et débit) ; débit, reste
    et durée en **badges** dans la barre d'onglets ; « AUTO · 4 » remplacé par
    **CONNECTIONS [Auto · 4] ▾**, cliquable (Auto, 1 à 10) ; **play / pause et
    stop** pour toute la file, en icônes ; dossiers du gestionnaire de sites
    **dépliables** (arbre, état retenu, clic droit : tout déplier / replier).
  - **Défaut grave trouvé en le faisant : Pause n'arrêtait rien.** La file
    appelait `abort()` sur la fiche de la connexion (`u.lane`) au lieu de la
    connexion (`u.lane.impl`) : l'erreur était avalée, les fichiers continuaient
    jusqu'au bout. Les tests ne le voyaient pas (petits fichiers, segments de
    1 Mo). Corrigé, avec deux défauts qu'il cachait : un segment arrêté par
    Pause qui finissait après le Start suivant remettait « à faire » un segment
    déjà refait (`_ownSeg`) ; au Start, des segments partaient de l'ancienne
    liste pendant que le fichier la refaisait. Tests ajoutés (fichiers de 16 Mo
    à débit limité, sans segments, envoi et réception, voies internes et
    workers : l'arrêt doit prendre moins de 2 s).
  - **Débit de 4-5 Mo/s en réception depuis son NAS** : pas filo. FileZilla et
    File Station (HTTPS) donnent pareil, l'envoi vers le NAS fait 50-65 Mo/s
    avec filo (19-20 avec FileZilla). Seul le sens NAS → internet est lent :
    suspect principal, l'adaptateur USB 2,5G en émission (pilote tiers), à
    tester sur le port 1 Gb d'origine. Rien à corriger dans filo.
- **Revue de code 0.2.0 (09/10/2026)**, faite par quatre relecteurs séparés
  (processus principal et pont, protocoles, moteur de transfert, interface).
  Aucune faille critique. Corrigé : rebond PASV vers un autre hôte, certificat
  non vérifié sur les connexions de données FTPS, mode actif ouvert si
  l'adresse du serveur est inconnue, mémoire de lecture SFTP non bornée et
  lecture sans délai maximal, guillemets du shell pour `sha256sum` (fish),
  « faire confiance » accepté pour une empreinte jamais montrée, action de fin
  décidée par la fenêtre, reprise d'envoi SFTP sur un trou, fichier partiel de
  filo pris pour un fichier de l'utilisateur, boucle de reconnexion, fichier
  retiré bloqué, questions « déjà présent » orphelines, une vingtaine de
  défauts d'interface. Détail dans `CHANGELOG.md`.
  Réponses de Noar aux trois propositions (09/10/2026) :
  - **Marquer les fichiers reçus comme venant d'internet** (quarantaine Mac,
    `Zone.Identifier` Windows) : **non**. Un fichier téléchargé par filo
    s'ouvre donc sans contrôle Gatekeeper / SmartScreen. Ne pas le refaire
    sans qu'il le redemande.
  - **Fuses Electron** : **oui**. `electronFuses` dans `electron-builder.yml`
    (pris en charge par electron-builder 26, aucune dépendance ajoutée).
    `grantFileProtocolExtraPrivileges` reste **activé** : coupé, la page
    `file://` de filo ne se charge plus (écran d'erreur, vérifié).
    Vérifié ici : build Linux empaquetée lancée avec les fuses, connexion,
    réception de 300 Mo avec checksum serveur, fichier identique ;
    `ELECTRON_RUN_AS_NODE=1` ne lance plus Node. Build Windows : fuses posés
    et ressource d'intégrité de l'asar ajoutée sans Wine. **À vérifier sur le
    PC et sur le Mac** : que l'app démarre (l'intégrité de l'asar refuse de
    démarrer si l'archive a été modifiée après le build).
  - **Écritures disque groupées en réception** (`LocalSink._writev`, tampon
    de 8 Mo) : **oui**.
- **Jamais lancé sur un Mac** à ce jour : tout a été
  vérifié sous Linux (moteur, interface sous Xvfb, application empaquetée, build
  Windows `.zip`). Voir Prochaines étapes.

## 2. Le produit

Client FTP / FTPS / SFTP à deux panneaux, sur le modèle de FileZilla (dont le
code a servi de référence, pas de base), avec l'interface de syncto. Public :
monteurs, DIT, techniciens vidéo. Usage principal de Noar : échanger avec son
NAS Synology DS920+ (SFTP, carte 2,5 Gb/s, fibre Free 8 Gb/s) et avec les
serveurs SFTP de clients, souvent depuis l'étranger sur des fibres 8–10 Gb/s.
**Objectif fixé par Noar : les meilleurs débits possibles.**

| Zone | Contenu |
|---|---|
| Barre de titre | logo, connexion en cours (badges « Not encrypted », « Server checksums »), déconnexion, action de fin, réglages |
| Connexion rapide | SITES, protocole (SFTP / FTPS / FTPS-i / FTP), hôte (accepte une URL collée), port, utilisateur, mot de passe, CONNECT, historique |
| Connexion rapide (suite) | **SYNC BROWSING** : ouvrir un dossier d'un côté ouvre le dossier du même nom de l'autre, remonter remonte des deux ; se coupe (avec un message) si l'autre côté n'a pas ce dossier, si on tape un chemin, Browse, dossier de connexion, déconnexion |
| Deux panneaux | LOCAL et SERVER : Browse (local, à gauche du chemin), chemin éditable, parent, rafraîchir, nouveau dossier, dossier de connexion (serveur), filtre, tri, glisser-déposer, menus contextuels |
| File d'attente | anneau général + titre de phase (TRANSFERRING vert, VERIFYING bleu, PAUSED, FINISHED), CONNECTIONS (Auto · n, menu), **interrupteur CHECKSUM**, play / pause et stop de toute la file ; onglets Queue, Failed, Done, Log + badges SPEED, LEFT, ETA ; lignes façon ingesto (% en vert à gauche, barre fine, ligne d'origine et débit) avec pause / reprise, stop, réessayer par fichier |
| Fenêtres | gestionnaire de sites, réglages, confiance (empreinte), mot de passe, fichier déjà présent, résumé d'erreurs, compte à rebours de fin |

## 3. Décisions de Noar (et pourquoi)

- **Nom : filo. Version de départ : 0.1.0. Plateformes : Mac + Windows + Linux.**
- **Protocoles : SFTP, FTPS explicite, FTPS implicite, FTP.** FTP signalé « Not
  encrypted » partout (mot de passe et fichiers en clair).
- **Mots de passe « comme syncto »** : `safeStorage` (clé dans le Trousseau /
  DPAPI / libsecret), pas de module natif (keytar) ni de 1Password/Bitwarden —
  pour garder le build Windows depuis le Mac.
- **Transferts simultanés : Auto par défaut** (09/10/2026), et Auto doit valoir
  pour les petits fichiers aussi : il mesure Mo/s **et** fichiers/s.
- **Le checksum est dans la fenêtre principale**, pas dans les réglages,
  désactivable à la volée (09/10/2026). Le « comment » (checksum serveur,
  relecture) reste dans les réglages. Un fichier déjà en route garde son mode ;
  ceux qui démarrent après le clic suivent le nouveau.
- **Corriger les points où FileZilla était meilleur** (09/10/2026) : fait — mode
  FTP actif, profondeur de lecture SFTP adaptative, fuseau horaire des listings
  LIST, limite de connexions par site, limite de vitesse, cache des listings.
- **Rust : plus tard.** Gains réels seulement en SFTP au-delà de ~3 Gb/s ; coût :
  le build Windows depuis le Mac. Si un jour le processeur du Mac limite, la
  piste est de remplacer **seulement le moteur de transfert** par un module Rust.
- Charte UI commune (syncto / ingesto) : fonds page / carte / creux, aucune
  bordure de structure, quatre couleurs d'état.
- **Icône et logo (choix de Noar, 09/10/2026)** : le mot « filo », seul le « o »
  en couleur, **le rouge de FileZilla `#BF0000`** (tiré de son logo). Gabarit
  de la famille : carré noir, dessin blanc, un élément de la couleur de l'app.
  Le SVG est produit par `scripts/make-icon-svg.py` (lettres de Poppins Bold
  converties en contours), puis `scripts/gen-icons.py`. Ce rouge ne vit que sur
  le logo : dans l'interface, le rouge reste la couleur des suppressions et des
  échecs (`--red #f2555a`, plus clair).

Principes repris de syncto : une fenêtre qui travaille sans rien afficher passe
pour plantée ; ne jamais afficher une progression qu'on ne sait pas calculer ;
un code système (`ECONNREFUSED`, `530`) dans un message est un défaut
d'interface (voir `core/errors.js`).

## 4. Architecture en bref

1. **Moteur** (`src/main/core`, `src/main/proto`) : aucune dépendance à
   Electron, testable avec `node` seul.
2. **Processus principal** (`src/main/main.js`) : fenêtre, menus, IPC, profil,
   mots de passe, connexion de navigation, file d'attente, notifications, action
   de fin, vérification de mise à jour (`version.json` sur GitHub).
3. **Fenêtre** (`src/renderer/index.html` + `app.js`, sans framework) :
   sandboxée, CSP stricte, tout passe par `src/main/preload.js` (`window.filo`).
4. **Fils de transfert** : chaque connexion de la file tourne dans un *worker
   thread* (`core/lane-worker.js`), donc sur son propre cœur.

| Fichier | Rôle |
|---|---|
| `proto/index.js` | `createRemote(endpoint)`, `parseUrl`, `describe` (jamais de mot de passe) |
| `proto/sftp.js` + `sftp-pipe.js` | SFTP (ssh2) repris de syncto : file de requêtes avec délai, flux pipelinés ; **plus** : reprise à un décalage, plages (segments), profondeur de lecture et fenêtre de réception adaptatives, checksum par `sha256sum` / `shasum` / `md5sum` lancé par SSH |
| `proto/ftp.js` | FTP / FTPS (basic-ftp) : vérification du certificat **avant** le login, MLST / SIZE+MDTM, MFMT, HASH / XSHA256 / XSHA1 / XMD5 / XCRC, APPE pour reprendre un envoi, fuseau des listings mesuré par MDTM |
| `proto/ftp-passive.js` | mode passif (EPSV puis PASV) : on ne garde que le port, connexion toujours vers l'adresse du serveur (NAT, pas de rebond) |
| `proto/ftp-active.js` | mode actif (PORT / EPRT), TLS sur la connexion de données, seule l'adresse du serveur peut se connecter |
| `proto/local.js` | disque local : listings, `LocalSink` (écritures positionnées, `fsync` avant « fini »), volumes / lecteurs |
| `core/transfer.js` | un fichier de bout en bout (cible, `.filopart`, reprise, vérification, renommage, date) ; **segments** : préparation, un segment, finalisation |
| `core/queue.js` | la file : unités (fichier, segment, finalisation), voies, Auto, reprises, pause, persistance, progression |
| `core/lane.js` / `lane-worker.js` / `runner.js` | une voie = une connexion dans un worker (ou dans le processus, `FILO_LANES=inline`) |
| `core/autotune.js` | Auto : paliers de connexions mesurés (Mo/s et fichiers/s), limite apprise du serveur |
| `core/hash.js` | SHA-256 / SHA-1 / MD5 natifs (OpenSSL), xxHash64 / CRC32 (hash-wasm), plages |
| `core/throttle.js` | limite de vitesse (seau à jetons) |
| `core/existing.js` | règles « fichier déjà présent » |
| `core/sites.js` | sites : forme normalisée, import / export filo JSON et FileZilla XML (petit lecteur XML maison) |
| `core/scan.js` | parcours d'un dossier serveur, suppression récursive, noms sûrs pour Windows |
| `core/errors.js` | `RemoteError` : `network` (on réessaie), `fatal` (inutile), messages lisibles |
| `config.js` | `preferences.json` (réglages, sites, serveurs connus, historique) et `queue.json` |
| `secrets.js` / `notify.js` / `power.js` | repris de syncto : mots de passe, ntfy, veille / extinction / quitter |
| `test/run-tests.js` / `sftp-server.js` | la suite ; vrai serveur SFTP dans le processus (latence, plafond de sessions) |

### Un transfert, dans l'ordre (`core/transfer.js`)
1. La source existe ? (sinon échec définitif.)
2. La cible : absente, ou présente → règle (demander, écraser, si plus récent, si
   taille différente, reprendre, garder les deux, ignorer).
3. Écriture dans `nom.filopart`. Si un `.filopart` existe **et** que la source a
   la même taille et la même date qu'au départ → reprise à sa taille.
4. Taille vérifiée, puis checksum (section 5).
5. Seulement alors : renommage en `nom` (l'ancien est mis de côté puis supprimé
   — jamais d'instant sans fichier sous le vrai nom), puis date.

### Segments (SFTP, fichiers ≥ 64 Mo)
Taille adaptative depuis la 0.3.2 (Noar : « le maître mot est la performance
globale, fais le meilleur choix ») : environ 16 segments par fichier, de 32 à
256 Mo chacun (`segmentSizeFor`). Avant : 256 Mo fixes à partir de 512 Mo, et
un fichier de 1 Go n'utilisait que 4 connexions. Mesuré ici (serveur local,
proxy 80 ms d'aller-retour, 8 connexions, fichier de 400 Mo) : **envoi 12 →
47 Mo/s** (un envoi seul est plafonné par la fenêtre de 2 Mo du serveur),
réception 56 → 65 Mo/s. Avec Auto et un seul fichier de 400 Mo, la réception a
été un peu plus lente (43 contre 57 Mo/s) : Auto part de 2 connexions et le
fichier finit avant qu'il monte. Piste : faire partir Auto plus haut quand un
fichier est segmenté. Ces mesures viennent d'une machine à 2 cœurs où le
serveur, le proxy et filo se partagent le processeur : à refaire sur le vrai
matériel.
Anciennement « tranches de 256 Mo ». `prepareSegments` crée le `.filopart` vide et la liste ;
la file donne la tranche suivante à chaque voie libre (tranches d'un fichier
déjà commencé d'abord) ; chaque tranche est écrite à sa place (jamais de
troncature) et vérifiée sur place si le serveur ne sait pas calculer de
checksum ; une voie finalise (taille, checksum serveur du fichier entier,
renommage, date). Les tranches finies sont enregistrées avec la file ; une
tranche coupée repart de son début. Pas de segments en FTP (le protocole ne
permet pas d'écrire un fichier à plusieurs endroits à la fois).

### Ce que filo écrit chez l'utilisateur et sur les serveurs
- `nom.filopart` pendant un transfert (visible exprès : c'est un fichier
  incomplet) ; `nom.filoold` une fraction de seconde pendant un remplacement.
- Profil : `app.getPath('userData')/preferences.json` et `queue.json` (écrits
  atomiquement, droits 600). **Une seule instance** (`requestSingleInstanceLock`) :
  deux filo réécriraient la même file.

## 5. Vérification (checksum)

Interrupteur dans la file. Ordre de préférence :
- **server** : le serveur calcule (FTP `HASH` ou `XSHA256`…, SFTP `sha256sum`
  par SSH) et filo calcule le même sur le fichier local. Bout en bout, sans
  second transfert. Les comptes « SFTP seul » (chroot, hébergeurs) n'ont pas de
  shell : on passe au suivant.
- **received** (réception) : la copie sur disque est relue et comparée à ce qui
  est arrivé (xxHash64).
- **readback** (envoi) : le fichier est relu depuis le serveur et comparé
  (xxHash64) — le prix est un second transfert ; réglage « Otherwise, read the
  file back ».
- **size** : taille seulement (interrupteur coupé, ou rien d'autre possible).
Un fichier repris qui ne correspond pas est refait depuis zéro, une fois, sans
rien demander. Le badge de la ligne dit quel niveau a été atteint.

## 6. Performances (mesures)

Machine de test : 2 cœurs cloud, serveur sur la même machine.
- SFTP, une connexion, sans vérification : ~380 Mo/s en réception, ~300 Mo/s en
  envoi, un cœur à 90–100 % → d'où les worker threads.
- SFTP, un fichier, 100 ms d'aller-retour : 8 Mo/s avec 64 requêtes fixes →
  44 Mo/s avec la profondeur adaptative (réception).
- SFTP, envoi de 200 Mo à 120 ms : 16,8 s sur une connexion → 9,9 s en 8
  segments (vérification comprise ; la machine de test limite, pas filo).
- SHA-256 natif ~880 Mo/s ici (bien plus sur Apple silicon), xxHash64 ~2,2 Go/s.
- Coût par petit fichier en SFTP : ~8 allers-retours (ouvrir, écrire, fermer,
  taille, checksum, renommer, date). À 120 ms, c'est ce qui limite un dossier de
  milliers de petits fichiers ; Auto compense par le nombre de connexions.
- Auto, un seul fichier de 400 Mo en segments, 80 ms d'aller-retour : 43 Mo/s
  quand Auto démarrait à 2 connexions, 56–57 Mo/s depuis la 0.3.3 (démarrage
  à 4 pour un fichier en segments), autant que le meilleur réglage fixe.

## 7. Build, signature, publication

- **Mac (arm64)** : `build_mac.command`. Signe avec le certificat « Developer ID
  Application », notarise (profil `filo-notarization` ; **réutilise
  `syncto-notarization` s'il existe**, même compte Apple), agrafe le `.dmg`,
  vérifie avec `spctl`. `FILO_SKIP_SIGN=1` : build non signé.
- **Windows x64 depuis le Mac** : `build_windows.command`. Réaliste (rien à
  compiler) ; vérifié ici : `filo-0.1.0-win-x64.zip` se construit. `.exe` NSIS
  si Wine est installé. Non signé : SmartScreen avertit.
- **Windows x64 sur un PC Windows** : `build_on_windows.bat` (demandé par Noar
  le 09/10/2026), double-clic. Vérifie Node (≥ 20.19), installe les dépendances
  si besoin, construit l'installeur NSIS (pas de Wine sous Windows) et le `.zip`
  portable, ouvre `dist`. Fichier en ASCII et fins de ligne Windows (CRLF) :
  la console Windows lit les `.bat` dans un vieux jeu de caractères, et un `.bat`
  en fins de ligne Unix peut casser ses sauts (`goto`). **Pas encore essayé sur
  un vrai PC.** Piège connu d'electron-builder sous Windows : une erreur de
  « symbolic link / privilege » à l'extraction de ses outils — le script dit
  d'activer le mode développeur.
- **Linux** (0.3.0, demandé par Noar : « le build se fera sur Linux ») :
  `./build_linux.sh` à la racine (ou `./build.sh` lancé sur Linux, qui
  passe la main), qui appelle `scripts/build-linux.sh`, copié de syncto. Sur une
  machine Linux, en utilisateur normal (jamais `sudo`) ; il faut Node ≥ 20.19,
  `dpkg` et `fakeroot`. Sortie : `dist/filo-X.Y.Z-linux-x86_64.AppImage` et
  `dist/filo_X.Y.Z_amd64.deb`. Pourquoi pas depuis le Mac : le `.deb` fait sur
  Mac n'est pas valide (constaté sur ingesto).
  **Vérifié ici le 09/10/2026 sur Ubuntu 24.04** : build complet par le
  script, `.deb` installé avec `apt` (menu, icône, commande `filo`,
  `chrome-sandbox` réglé par electron-builder, profil AppArmor posé sur les
  Ubuntu 24.04+ où AppArmor est actif), `.deb` et AppImage lancés : connexion
  SFTP, réception de 300 Mo, checksum serveur, fichier identique.
  Ce qui ne s'essaie pas ici : un vrai bureau (GNOME / KDE), un trousseau
  réel, l'AppImage sur un Ubuntu 24.04 avec AppArmor actif (peut refuser de
  s'ouvrir : le README conseille le `.deb`), l'extinction par `systemctl`.
- **Publication** : `scripts/push_github.command` sur Mac, `scripts/push_github.bat` (+ `.ps1`) sous Windows, ajouté en 0.3.4 et essayé avec PowerShell 7 contre un dépôt local (première publication, version identique refusée, `version.json` retenu puis envoyé, droits d'exécution, fins de ligne LF gardées) ; pas encore sur un vrai Windows (PowerShell 5.1) (AGENTS.md, règle 7). Ajout par
  rapport à syncto : un dépôt **vide** (première publication) est accepté —
  la branche `main` est créée, et `version.json` part tout de suite (aucune
  copie installée à prévenir).
- Les worker threads se chargent depuis l'archive `app.asar` (vérifié avec
  l'application Linux empaquetée).
- `publish: null` dans `electron-builder.yml` (0.3.0) : electron-builder ne
  publie jamais rien et n'écrit plus `latest-*.yml` / `app-update.yml` ; filo
  n'a pas de mise à jour automatique, seulement l'alerte via `version.json`.

### GitHub (préparé en 0.3.0, dépôt pas encore créé)

- Dépôt prévu : `noar-justedit/filo`, **public** : l'alerte de mise à jour lit
  `https://raw.githubusercontent.com/noar-justedit/filo/main/version.json`.
  Un dépôt privé la rend muette (sans erreur visible).
- La 0.3.4 est la **première version publiée** (0.1.0 à 0.3.3 ne l'ont
  jamais été). Texte de la Release et liste de contrôle :
  `docs/RELEASE-0.3.4.md`. Tag `vX.Y.Z` sur `main` (c'est ce que
  `push_github.command` attend pour envoyer `version.json`).
- Fichiers de la Release : `filo-X.Y.Z-mac-arm64.dmg`, `filo-Setup-X.Y.Z.exe`,
  `filo-X.Y.Z-win-x64.zip`, `filo_X.Y.Z_amd64.deb`,
  `filo-X.Y.Z-linux-x86_64.AppImage`.
- Fichiers propres à GitHub : `README.md` (section Download), `SECURITY.md`
  (signalement par e-mail, ce que filo protège, limites dites franchement),
  `CONTRIBUTING.md` (GPL, aucun code de FileZilla, tests obligatoires),
  `LICENSE` (GPL-3.0-or-later), `.gitignore` (certificats, `.env`, logs).
- **Proposé, en attente du « oui » de Noar** (outillage, règle 1) : une
  GitHub Action qui lance `npm test` à chaque envoi ; des modèles d'issue
  (bug / idée) ; Dependabot pour les mises à jour de sécurité des
  dépendances. Rien de cela n'est en place.

## 8. Tests

`npm test` = `node test/run-tests.js` (~45 s). Sections : URLs, dates FTP,
règles « déjà présent », sites + import/export FileZilla, noms Windows, Auto,
limite de vitesse, checksums, erreurs, réglages, **pont preload** (chaque
argument transmis, chaque canal a son handler), SFTP de base (clé changée
refusée, plages, écriture sans troncature), file en voies internes et en
**worker threads**, **segments**, **pause / reprise** (avec et sans segments), **pause, stop, reprise d'un
fichier et stop de toute la file** (l'arrêt doit être immédiat),
fichier déjà présent (ignorer, renommer, demander via un worker, reprendre),
**limite de connexions apprise**, corruption détectée par relecture.

Vrais serveurs (faits le 09/10/2026, à refaire après toute modification de
`proto/`) :
- OpenSSH (`sha256sum` disponible) : envoi / réception, reprise, segments, Auto,
  checksum serveur ; latence simulée par un proxy TCP (60 ms par sens).
- vsftpd : FTP, FTPS explicite, FTPS implicite, en passif **et en actif** :
  ```bash
  FILO_TEST_FTP=hôte:port FILO_TEST_FTPS=hôte:port FILO_TEST_FTPS_IMPLICIT=hôte:port \
  FILO_TEST_FTP_USER=… FILO_TEST_FTP_PASS=… node test/run-tests.js ftp
  ```
- Interface : pilotée sous Xvfb avec Playwright (connexion, confiance, envoi d'un
  dossier, gestionnaire de sites, réglages, « déjà présent »).

Ne se teste que sur un vrai Mac / PC : signature, notarisation, Trousseau,
Apple events (extinction), pare-feu macOS en mode actif, installeur NSIS,
SmartScreen, débits réels.

## 9. Pièges connus (ce qui a déjà coûté du temps)

- ssh2 garde sa fenêtre de réception à 2 Mo, en dur : filo la remonte lui-même
  (`SftpRemote._installWindow`) en interceptant `sftp.push`. Une mise à jour
  majeure de ssh2 peut casser ça : refaire le test de latence.
- En **envoi** SFTP, c'est le serveur qui fixe la fenêtre (2 Mo chez OpenSSH) :
  impossible à agrandir côté client, d'où les segments.
- `LocalSink` doit tronquer en fin de fichier normal (un `.filopart` plus long
  que la source) mais **jamais** pour un segment.
- basic-ftp : une commande à la fois par connexion (`_q`), sinon « User launched
  a task while another one is still running ». `downloadTo` termine le flux de
  destination lui-même.
- `page.waitForFunction` de Playwright est bloqué par la CSP (pas d'`eval`) :
  boucler sur `textContent`.
- Un `pkill -f` dont le motif apparaît dans la commande tue le shell lui-même.
- Dans la file, `u.lane` est la **fiche** de la connexion (`{ impl, busy,
  dead }`) ; la connexion elle-même est `u.lane.impl`. Un `try {} catch {}`
  autour d'un appel sur la mauvaise a caché pendant toute la 0.1.0 que Pause
  n'arrêtait rien.
- Une unité arrêtée peut finir **après** le Start suivant : elle ne touche plus
  un segment qui n'est plus à elle (`c.by`, `_ownSeg`), et l'état « en pause /
  arrêté » d'un fichier est posé quand sa dernière unité s'en va (`_settle`),
  pas dans le gestionnaire d'erreur de chaque unité.
- Une ligne de la file **ne doit jamais être redessinée entière** à chaque
  tick de progression (`_skey` dans `renderQueue`) : les boutons sous le
  pointeur étaient remplacés entre l'appui et le relâchement, et STOP / PAUSE
  ne marchaient pas. Seuls le %, la barre et la ligne du bas sont mis à jour.
- Liste des sites : un clic la redessine (sélection), donc le double-clic
  natif n'arrive jamais ; il est détecté à la main (`sm.lastClick`).
- **Reprise à l'intérieur d'un segment** (après la 0.3.1) : `c.got` = ce qui
  est en place depuis le début du segment. Le segment le signale en
  s'arrêtant (`segkeep`, envoyé tout de suite par le worker) : réception =
  exactement ce que `LocalSink` a écrit (écritures dans l'ordre) ; envoi = ce
  qui est parti moins 6 Mo (écritures en vol dans le désordre). Une erreur de
  checksum remet le segment à zéro. Vérification d'un segment repris : la
  partie reçue relue sur le disque (réception) ; tout le segment relu sur le
  serveur et comparé au fichier local (envoi).
- `compression: normal` (après la 0.3.1, demandé par Noar : build Windows
  « extrêmement long ») : 91 s au lieu de 618 s pour le zip Windows, 0,3 % plus
  gros. `maximum` passe tout le contenu dans 7-Zip au plus fort, sur un seul
  cœur, pour presque rien (Electron est déjà compressé).
- **Ajouter de nouveau un fichier** déjà dans la file (même sens, serveur,
  chemins) : s'il attend, tourne ou est en pause, il n'est pas ajouté deux fois ;
  s'il est stoppé / en échec, c'est **le même élément** qui revient (avec son
  fichier partiel et son relevé de reprise), et la fenêtre demande « Resume or
  start again? ». Avant, un nouvel élément repartait de zéro sans prévenir
  (signalé par Noar le 09/10/2026). Un fichier partiel sans élément dans la file
  (file perdue) n'est toujours pas repris : rien ne dit de quelle version de la
  source il vient.
- Fichiers cachés : `isHiddenName` (renderer) — noms en point, `._x`, et la
  liste `OS_HIDDEN` (Thumbs.db, desktop.ini, $RECYCLE.BIN…). L'attribut
  « caché » de Windows n'est pas lu (Node ne le donne pas).
- L'ordre des sites est leur ordre dans `sites` (preferences.json) ; l'ordre
  des dossiers est `siteFolderOrder` (chemins complets). Plus de tri A→Z.
- Fuses : ne **jamais** couper `grantFileProtocolExtraPrivileges` (la page
  est chargée en `file://`, elle ne s'affiche plus). Une build empaquetée
  refuse `--inspect` : Playwright `_electron.launch` ne s'y attache plus ; la
  piloter avec `--remote-debugging-port=9333` puis
  `chromium.connectOverCDP('http://127.0.0.1:9333')`.
- Les fenêtres de dialogue passent **une à la fois** (`dialogWait`) : en
  ouvrir une ne doit jamais répondre à celle qui est ouverte. La question
  « déjà présent » porte un `tag` (`ask:<id>`) pour être fermée quand son
  fichier ne demande plus rien ; Échap ne lui répond pas.
- Un envoi SFTP repris repart 2 Mo avant la fin du fichier partiel
  (`resumeMargin`) : les écritures en vol peuvent arriver dans le désordre.
  Les tests de reprise doivent donc utiliser des fichiers de plus de 2 Mo.
- Les tests de pause doivent utiliser des fichiers qui ne finissent pas tout
  seuls pendant l'attente (débit limité), sinon un arrêt qui ne marche pas passe
  inaperçu.
- **basic-ftp 6 et le mode passif** : par défaut, la version 6 lève une erreur
  (« PASV returned another host ») quand la réponse PASV donne une autre
  adresse que celle du serveur, ce qui casse tous les serveurs derrière une box
  en NAT qui annoncent leur adresse privée. filo remplace donc toujours
  `client.prepareTransfer` : `proto/ftp-passive.js` (EPSV puis PASV, on ne
  garde que le port, connexion toujours vers l'adresse du serveur) ou
  `proto/ftp-active.js`. Ne pas revenir à la stratégie par défaut. Essai avec
  vsftpd et `pasv_address=10.123.45.67` : filo liste, basic-ftp seul échoue.
- **Ne jamais remplacer sans la règle** (0.3.4) : juste avant que le
  `.filopart` prenne le vrai nom, `recheckTarget()` regarde à nouveau si le
  nom était libre au départ (le cache de listing d'une connexion a jusqu'à
  60 s et ne voit pas ce qu'une autre connexion vient d'écrire ; un RNTO FTP
  remplace souvent sans prévenir). `restartFromZero` ne force l'écrasement
  que si `ownTarget`. `queue.add()` refuse un deuxième fichier pour la même
  destination (`conflict`).
- Les actions de navigation en plusieurs étapes passent un `browserSession()`
  à `withBrowser` : si le panneau change de serveur, elles s'arrêtent
  (`SERVER_CHANGED`) au lieu de continuer sur le nouveau.
- Renommage sur place (0.3.4) : le champ `.ren` est posé dans le
  `spacer` du panneau, **pas** dans la ligne (les lignes sont réutilisées et
  réécrites au défilement) ; `placeRename()` le recale à chaque `render()`.
  Ses événements clavier et souris ne doivent pas remonter à la liste (sinon
  flèches, Retour arrière, lasso et glisser agissent pendant la saisie).
  `cancelRename()` vide `_ren` **avant** de retirer le champ : Chrome envoie un
  `blur` au retrait, qui sinon validerait le renommage.
- Auto : `AutoTuner.boost()` ne joue qu'**une fois** par tuner (premier
  fichier en segments) ; ensuite la mesure décide seule.

## 10. Problèmes connus / limites

- **FTP : pas de segments**, parallélisme entre fichiers seulement.
- Retirer un **envoi** non terminé laisse son `.filopart` sur le serveur (seul
  le partiel local d'une réception est supprimé).
- Le test ntfy envoie aux réglages tapés, même non enregistrés, et accepte un
  serveur en `http://` (le sujet, qui sert de secret, passe alors en clair).
- La liste d'un dossier SFTP n'a pas de taille maximale (FTP : 40 Mo).
- L'icône « agrandir » de la fenêtre ne change pas d'aspect quand la fenêtre
  est agrandie.
- **Test intermittent** : une fois sur une quinzaine d'exécutions (pendant un
  build Linux qui chargeait la machine), « one file at a time », cas envoi en
  worker : un fichier stoppé n'a pas lâché sa connexion en 5 s. Les 14 autres
  passages sont verts ; cause non trouvée. Si cela se reproduit sur une
  machine calme, chercher l'étape de l'envoi où `token.onAbort` est vide.
- **Mode actif derrière une box (NAT)** : le serveur ne peut pas joindre le
  client ; et le pare-feu macOS peut demander l'autorisation d'accepter des
  connexions entrantes.
- Les dates des listings FTP sans MLSD sont à la minute (ou au jour pour les
  fichiers anciens) ; les décisions « plus récent » utilisent MDTM/MLST, exacts.
- Pas d'export de fichiers depuis filo vers le Finder par glisser-déposer (seul
  le sens Finder → filo existe).
- Un site importé de FileZilla avec un mot de passe protégé par son mot de passe
  principal est importé sans mot de passe (demandé à la connexion).
- Fermer la fenêtre sur macOS laisse la file tourner (convention Mac) ; quitter
  (⌘Q) demande confirmation si des transferts tournent.

## 11. Prochaines étapes

1. **Premier essai sur le Mac** : build, signature, notarisation, Trousseau
   (enregistrer un site avec mot de passe, relancer filo, se connecter sans
   retaper).
2. **Mesures réelles** : Mac Studio ↔ DS920+ (SFTP), puis un serveur client
   distant : une connexion vs Auto vs segments. Dire si le processeur du Mac
   limite (sinon, rien à faire côté Rust).
3. Vérifier sur le Synology que `sha256sum` est accessible au compte utilisé
   (sinon : relecture, ou activer le shell pour ce compte).
4. Premier essai Windows : `build_on_windows.bat` sur le PC, puis le zip
   portable et l'installeur : panneaux, lecteurs, envoi, extinction.
5. Premier essai Linux sur une vraie machine : `./build_linux.sh`, installer
   le `.deb`, ouvrir l'AppImage (Ubuntu 24.04+ : vérifier qu'elle s'ouvre),
   un site avec mot de passe (trousseau GNOME / KWallet), « Show in file
   manager », corbeille, extinction en fin de file.
6. Vérifier sur le Mac et le PC que les builds avec fuses démarrent.
7. Créer le dépôt GitHub `noar-justedit/filo` **public** et vide, puis suivre
   `docs/RELEASE-0.3.4.md` (push, Release v0.3.4 avec les cinq fichiers, push
   de `version.json`).
8. Noar doit tester la réception depuis son NAS sur le port 1 Gb d'origine
   (sans l'adaptateur USB 2,5G).
9. Pistes non commencées : glisser de filo vers le Finder ; comparaison de
   dossiers (marquer ce qui diffère entre les deux panneaux) ; segments en FTP
   pour la réception (REST + coupure).

## 12. Historique des versions

| Version | Date | Tests | Contenu principal |
|---|---|---|---|
| 0.3.4 | 10/10 | 393 (+18 FTP réels) | Renommage sur place ; barre de connexion (CONNECT/DISCONNECT, protocole en menu, connexions récentes avec les sites, bouton de fin de file déplacé) ; adresse dans la barre de titre ; réglages en catégories, un seul interrupteur de vérification, QR Android/iPhone, recherche des serveurs connus. Revue : TLS en FTPS actif, actions de navigation liées à leur serveur, mot de passe jamais dans le log, plus de remplacement sans la règle (nom pris pendant le transfert, deux fichiers pour une destination, START AGAIN), reprise de segment et après relance |
| 0.3.3 | 09/10 | 380 (+18 FTP réels) | Sélection au lasso dans les deux panneaux, « appliquer à : ce fichier / toute la file » (reprise et « déjà présent »), Auto démarre à 4 pour un fichier en segments (43 → 56 Mo/s mesurés), basic-ftp 6.2.3 (faille corrigée) avec mode passif maison compatible NAT |
| 0.3.2 | 09/10 | 371 (+18 FTP réels) | 2e série de tests de Noar : segments adaptatifs (16 par fichier, 32–256 Mo, dès 64 Mo), reprise dans un segment, barre de segments façon qBittorrent, `compression: normal` (build 7× plus rapide), barres et anneaux précis, débit instantané, colonnes redimensionnables, rafraîchissement après un stop, dossiers des sites repliables |
| 0.3.1 | 09/10 | 360 (+18 FTP réels) | 1re série de tests de Noar : glisser-déposer des sites, bouton fichiers cachés, fichier ajouté de nouveau repris au lieu de repartir de zéro, « reprendre ou recommencer », graphe de débit, STOP / PAUSE des lignes en cours et double-clic sur un site réparés |
| 0.3.0 | 09/10 | 334 (+18 FTP réels) | Linux (`.deb` + AppImage construits et essayés sur Ubuntu 24.04), préparation GitHub (README Download, SECURITY, CONTRIBUTING, texte de Release), `publish: null` |
| 0.2.0 | 09/10 | 334 (+18 FTP réels) | fuses Electron, écritures disque groupées ; retouches d'interface (file façon ingesto, contrôles, sites en arbre) ; revue de code : sécurité FTP/FTPS/SFTP, reprise d'envoi, questions « déjà présent », fenêtres en file d'attente |
| 0.1.0 | 09/10 | 327 (+35 FTP réels) | première version : 4 protocoles, deux panneaux, file en worker threads, Auto, segments SFTP, checksums, sites + import FileZilla, ntfy, action de fin |

Le détail est dans `CHANGELOG.md`.

## 13. Emplacements de la version

À mettre à jour **tous** à chaque bump, puis vérifier avec
`grep -rn "X.Y.Z" package.json package-lock.json version.json CHANGELOG.md ETAT_PROJET.md` :

1. `package.json` : champ `"version"` ; l'app l'affiche (pied de fenêtre).
2. `package-lock.json` : les **deux** champs `"version"` en tête (lignes 3 et 9).
3. `version.json` : champ `"version"` (déclenche l'alerte de mise à jour chez
   tous les utilisateurs une fois sur GitHub ; `push_github.command` le retient
   jusqu'à la Release).
4. `CHANGELOG.md` : titre `## [X.Y.Z] — AAAA-MM-JJ`.
5. `ETAT_PROJET.md` : sections 1 (état actuel) et 12 (historique).
6. `AGENTS.md` : le nom du ZIP donné en exemple (règle 5).
7. `README.md` : la légende de la capture d'écran.
8. `docs/RELEASE-X.Y.Z.md` : à renommer, et les noms de fichiers dedans,
   tant que la première Release n'est pas publiée.
