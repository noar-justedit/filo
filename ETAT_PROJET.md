# ETAT_PROJET.md : état de filo

À lire après `AGENTS.md`. Mis à jour à chaque version.

---

## 1. État actuel

- **0.8.1 (14/10/2026)** : correctif du speedtest sur NAS (« Permission denied » :
  la racine du serveur n'est pas inscriptible). Bookmark sur la racine : filo
  demande un dossier (sélecteur « Folder for the speed test », via IPC
  `speedtest-list`, une connexion courte par navigation). Bookmark avec dossier :
  sonde d'écriture (petit fichier créé puis supprimé) ; refus : choix entre
  test en réception seule (lit les plus gros fichiers du dossier, n'écrit rien,
  `readOnly`) et annuler. Codes d'erreur du moteur : `PICK_DIR`, `READONLY`,
  `NO_FILE`. Tests : **732 (+18 FTP réels)** verts, un passage complet ; flux
  mot de passe, choix de dossier et test complet manipulés dans l'app réelle.
  Pas essayé sur le vrai NAS de Noar ni sur FTP / FTPS ; la fenêtre « Read-only
  folder » n'a été testée que côté logique. Le dossier choisi n'est pas mémorisé
  dans le bookmark (à proposer à Noar si besoin). Un profil enregistré après un
  test en réception seule garde l'ancien chiffre d'envoi (même réseau).
- **0.8.0 (13/10/2026)** : speedtest des bookmarks (profil de vitesse),
  connexion visible (étapes, chrono, CANCEL), onglets en haut de fenêtre
  (BOOKMARKS en icône, FTP MODE, LIVE SYNC MODE) à la place du rail, SITES
  devient BOOKMARKS. Tests : **720 (+18 FTP réels)** verts, un passage complet ;
  le speedtest, la connexion lente et le CANCEL ont été manipulés dans l'app
  réelle (Playwright, serveur SFTP, relais avec délai). Voir la section
  « Speedtest, connexion visible et en-tête (0.8.0) ». Pas essayé sur un vrai
  serveur FTP / FTPS (aucun dans l'environnement de test).
- **0.7.2 (13/10/2026)** : bookmarks LIVE SYNC dans SITES, SESSION ID (le
  SLAVE crée la session et l'offre, le MASTER la lie seul), l'anneau seul et
  l'icône de barre des menus / notification, DISCONNECT, queue SYNCTHING
  qui se vide ; revue A à E : rien de local perdu (téléchargement toujours
  en `.filopart`, fichier remplacé par la synchro S-FTP dans `.filo-trash`,
  préférences reprises du `.bak`), attente du MASTER corrigée, textes
  harmonisés (voir « Prochaines étapes », point 0000). Tests : **672 (+18
  FTP réels)** verts, deux passages complets ; maquette cliquable faite sur
  l'app réelle (Playwright). Pas encore essayé entre deux vrais filo : le
  parcours SESSION ID.
- **0.7.1 (13/10/2026)** : raccourcis du panneau local (Bureau,
  Téléchargements, menu des disques ; voir « Prochaines étapes », point 000).
  Tests : **652 (+18 FTP réels)** verts.
- **0.7.0 (13/10/2026)** : rail latéral (TRANSFER / LIVE SYNC / SITES /
  SETTINGS), départ programmé de la queue, commande après la queue,
  vérification contre l'autre côté, dossiers favoris, Quick Look, et pour
  LIVE SYNC : fichier en cours dans l'anneau, PAUSE de la queue SYNCTHING,
  ordre alphabétique, alerte ntfy. Détail : CHANGELOG et la section
  « Prochaines étapes » (point 00). Tests : **650 (+18 FTP réels)** verts ;
  chaque ajout manipulé dans l'app (Playwright, vrai serveur SFTP).
- **0.6.4 (12/10/2026)** : gestionnaire de sites revu (section suivante).
  Tests : **608 (+18 FTP réels)** verts ; le gestionnaire a été manipulé dans l'app
  (menus, nouveau dossier, renommage, duplication et suppression d'un
  dossier, glisser vers la zone vide et dans un dossier, réouverture après
  un redémarrage), pas par un test automatique.

### Speedtest, connexion visible et en-tête (0.8.0, demandes de Noar)
- **En-tête** : `#t-tabs` dans `#titlebar` (les boutons gardent leurs
  identifiants : `#q-sites` icône seule, `#mode-client` « FTP MODE »,
  `#btn-sync` « LIVE SYNC MODE »). `#rail` n'existe plus ; la pastille du
  serveur (`#conn-pill`) et `#btn-settings` (icône) sont dans `.t-actions`.
  Le mode réduit (anneau seul) cache toujours la barre de titre.
- **Connexion visible** : les backends envoient leurs étapes par
  `opts.onStep` (`resolve`, `open`, `secure`, `login`, `folder`), main les
  transmet (`connect-step`), le renderer les affiche (`cu`, `connStart`,
  `connStep`, `connEnd`, `renderConnecting`) : pastille orange, barre
  `#cp-bar`, panneau `#cp-pan` (seulement s'il n'y a pas de connexion en
  cours d'usage). Plus de 8 s sur une étape : « slow ». CANCEL :
  `connect-cancel` → `remote.close()`, qui coupe aussi une connexion SFTP
  encore en train de s'ouvrir (`_pending`). SFTP : l'étape `secure` écoute
  `conn._sock` d'ssh2 (champ interne, protégé par try/catch ; à revoir si
  ssh2 est mis à jour). FTP sans TLS n'a pas d'étape `secure`.
- **Speedtest** (`core/speedtest.js`, `core/netid.js`, fenêtre dans app.js
  `openSpeedTest`) : ouvre jusqu'à 8 connexions (moins si le site a une
  limite ou si le serveur refuse : `maxOpen`, `capped`), puis des paliers
  1, 2, 4, 8 (et le dernier nombre ouvert) en OUT puis en IN, plus un fichier
  unique en 4 segments en SFTP (`canSegment`). OUT envoie des octets
  aléatoires dans des fichiers `.filo-speedtest-<id>-…` (512 Mo au plus par
  connexion et par palier) du dossier de login (`home()`), IN les relit.
  Débit = octets / temps réel du palier. Suggestion : le plus petit nombre de
  connexions dont aucun voisin plus grand ne gagne 10 % (`better` d'Auto) ;
  segments ON si le fichier en segments va 10 % plus vite qu'une connexion.
  Fichiers supprimés dans tous les cas (fin, échec, annulation).
- **Profil** (`site.speed` : `at`, `net`, `netLabel`, `out`/`in` =
  `{conn, seg, mbps, src}`, `latencyMs`, `maxOpen`) : enregistré par SAVE
  (`speedtest-save`), jamais exporté, effacé si l'hôte, le port, le protocole
  ou l'utilisateur du site changent. Le réseau (`netid.js`) = sous-réseau +
  passerelle + adresse matérielle de la passerelle quand le système la donne
  (relu chaque minute). Pas de réseau reconnu : le profil n'est jamais appliqué.
- **Application** : `TransferQueue.opts.speedProfile(endpointId, dir)` (main,
  seulement sur le même réseau). En Auto : `AutoTuner.preset(conn)` une fois
  par run, au premier fichier (remplace les départs « segments » de `boost` /
  `startLow`) ; Auto continue de mesurer (un palier de plus doit gagner 10 %).
  `seg === false` : le fichier est envoyé entier (`settings.segments = false`
  dans l'unité). Concurrence fixe : le profil n'agit pas.
- **Mise à jour par un vrai transfert** : `summary.profile` (un serveur, un
  sens, 100 Mo et 10 s au moins, Auto a mesuré) → `sites.learnFromTransfer` :
  remplace conn et débit du sens seulement si le débit réel dépasse de plus de
  5 % celui du profil ; ne crée jamais un profil, ne baisse jamais.
- **Limites connues** : le test utilise les flux JavaScript, pas le moteur
  Rust (les débits réels peuvent être plus hauts ; les nombres de connexions
  restent un bon départ, Auto corrige) ; un serveur qui met en cache ou
  compresse peut flatter l'IN ; deux réseaux au même sous-réseau, même
  passerelle et sans adresse matérielle lisible se confondent ; les
  commandes `route`, `ip`, `arp` sont appelées avec un délai de 1,5 s ;
  FTP / FTPS : la mesure passe par `upload` / `download` de basic-ftp, essayée
  sur le serveur SFTP de test seulement.

### Gestionnaire de sites (12/10/2026, Noar, validé sur une simulation)
- **Vue retrouvée** : `openSites` reprend le site choisi (`ui.sitesSel`), les
  dossiers ouverts (`ui.sitesOpen`) et le défilement (`ui.sitesScroll`) ;
  `selectSite(id, { expand })` ne déplie que si un site précis est demandé
  depuis ailleurs.
- **Clic droit** : zone vide (New site, New folder), dossier (Rename,
  Expand, Collapse, Duplicate, Delete… avec confirmation), site (Rename,
  Duplicate, Delete…). Renommage dans la liste (`sm.renaming`, `#sm-ren`).
  DELETE et DUPLICATE retirés du bas du formulaire. Bouton NEW FOLDER
  (`#sm-new-folder`).
- **Dossiers enregistrés pour eux-mêmes** : un dossier vide reste ; ils
  vivent dans `siteFolderOrder` (ordre et existence). Migration unique
  (`siteFoldersOwn`) : les anciens chemins sans site sont retirés, pour ne
  pas faire réapparaître des dossiers vidés autrefois.
- **Supprimer un dossier supprime ses sites** et leurs mots de passe
  (`sites-delete-folder`, la confirmation dit combien). **Dupliquer un
  dossier** copie ses sites, mots de passe compris, dans « nom (copy) »
  (`sites-duplicate-folder`).
- **Glisser-déposer** : ligne droite avec un rond au début (pseudo-éléments,
  plus d'ombre intérieure qui suivait l'arrondi) ; dossier cible teinté ;
  toute la zone vide sous les rangées = racine (`.sm-drop-end` occupe la
  hauteur restante).
- Dossier créé à l'import d'une session avec serveur : « LIVE SYNC » (au lieu
  de « Shared »).

- **0.6.3 (12/10/2026)** : navigation synchronisée avec les différences
  entre les deux côtés (section suivante). Tests : **602 (+18 FTP réels)** verts.

### Navigation synchronisée : les différences (12/10/2026, Noar)
- Codes de FileZilla, deux couleurs seulement : **jaune** (`--yellow
  #f2c94c`, réservé à cet usage) = présent seulement de ce côté ; **vert** =
  plus récent de ce côté (ou autre taille à la même date). Seul le **nom**
  est surligné, pas la ligne (Noar). Identique, ou plus ancien ici : rien.
- `diffWith(panel)` compare les deux dossiers affichés (nom, type, taille,
  date à 2 s près, ou à la minute pour un serveur qui ne donne que les
  minutes) ; pas de comparaison du contenu des sous-dossiers (lent sur un
  NAS) ni des octets. Recalculée à chaque liste d'un côté (`_apply` refait
  l'autre), et à l'activation / l'arrêt (`refreshDiff`).
- Pied de chaque panneau : « N only here · N newer here ». Bouton filtre
  (icône, à côté du chemin, visible seulement pendant la navigation
  synchronisée, `body.syncb`) : DIFFERENCES ONLY par panneau.
- Non fait : « Select differences » dans le clic droit (proposé, pas
  demandé).

- **0.6.2 (12/10/2026), première publication prévue sur GitHub** : revue
  globale du code (sécurité, bugs, couleurs, interface, noms), détail
  ci-dessous. Tests : **602 (+18 FTP réels)** verts.

### Revue 0.6.2 (12/10/2026, « review globale », trois relectures en parallèle)
- **DUAL SYNC devient une synchro à trois** (décision de Noar, 12/10/2026 :
  « si un dossier est posé manuellement sur le NAS : master et slave doivent
  le récupérer. C'est une synchro 3 ways en quelque sorte »). `mirrorPlan`
  (option `pull`, vraie quand le MASTER reçoit : 2 WAYS ou REMOTE → LOCAL) :
  posé sur le serveur à la main ou modifié seulement là-bas → ramené sur le
  MASTER, puis Syncthing l'emmène au SLAVE ; modifié des deux côtés → la
  version du MASTER part, celle du serveur est gardée à côté
  (`*.sync-conflict-<date>-from-server.*`) ; effacé sur le MASTER (déjà vu
  des deux côtés) → effacé sur le serveur ; effacé seulement sur le serveur
  → renvoyé. Un MASTER LOCAL → REMOTE ne ramène rien.
- **Sécurité du backup** : n'est effacé sur le serveur que ce que la session
  connaît (vu sur ce Mac) ; ce que filo n'a jamais vu ici est ramené, jamais
  effacé, donc un dossier de backup mal choisi n'est jamais vidé. Racine du
  serveur refusée (`prepareSave` et `_mirror`). Dossier local vide alors que
  le serveur a des fichiers connus : rien n'est effacé ni ramené (disque non
  monté). Lecture locale stricte (`local.walk` option `strict`) : une entrée
  illisible arrête la passe ; rien n'est touché sous un dossier atteint deux
  fois par un lien (`partial`).
- **Noms venus d'un serveur** : `localJoin` partout dans `syncer.js`
  (chemins locaux de LIVE SYNC, renommage de conflit, corbeille) ; la liste
  FTP écarte les noms avec `\` ou NUL ; le nom de partie d'un relais
  (`info.json`) doit être un nom simple (`bareName`).
- **`.filo-session` sur le serveur** : le SLAVE n'en prend plus que le nom ;
  sens et filtre seulement par le dossier de contrôle Syncthing (lien
  authentifié). `takeSession(p, o, 'from the server')`.
- **Syncthing laissé par un filo précédent** : `_isSyncthing(port)` (santé
  sans clé + en-tête `X-Syncthing-Version`) avant d'envoyer la clé.
- **Bascule vers le serveur** : Syncthing ne renvoie un état que s'il change ;
  après un premier regard manqué, `emitStatus` regarde de nouveau 15 s plus
  tard (`missRecheckMs`), sinon la bascule n'arrivait jamais sur un dossier
  calme.
- **DUAL SYNC** : `plan()` ne fait plus de copie de conflit quand les deux
  côtés ont changé vers le même fichier (même taille, session hybride) ;
  `mirrorPlan` solde l'attente `pend: 'l'` laissée par `plan()` (plus de
  renvoi du même fichier) ; état de dossier `pend` tant qu'il n'est pas créé.
- **Copies retenues** : marquées sur l'élément de file (`sync.held`, gardé
  après un redémarrage) ; seules celles-là repartent (jamais une pause faite
  à la main) ; relâchées quand l'autre ordinateur s'en va ; S-FTP BACKUP
  coupé ou session supprimée : ses copies s'arrêtent (`stopPairItems`). Une
  passe qui trouve Syncthing reparti retient ses copies. Avant d'effacer un
  chemin, les copies en file vers ce chemin sont retirées. L'état quitte
  « mirror » quand les copies sont finies (`watchMirror`), ou dit combien ont
  échoué.
- **Interface** : S-FTP BACKUP partout (plus de « Failsafe »), « MODE ▾ → »
  dans toutes les aides, AUTO, « Connections » aussi dans les réglages,
  « LIVE SYNC “nom” : » dans le journal (et la raison d'un passage dite en
  clair), « New session » par défaut ; couleurs uniquement de la palette
  (`--folder` ajouté), erreurs en rouge ; boutons des en-têtes de panneau à
  30 px, onglets de session à 32 px, coins `--r-field` ; survols et
  aria-label manquants ajoutés ; CSS et code morts retirés (`.lv-title`,
  `.lv-mode`, `sparkPath`…).
- **Relais par segments** : l'échec intermittent du test « segment relay »
  était un vrai bug : un segment lisait la partie `.filopart` au moment où
  l'émetteur la renommait ; l'erreur est maintenant réessayée depuis le nom
  final (`transfer.js`, `runSegment`). 6 passages sur 6 verts ensuite.
- **Couleurs des modes partout** (Noar : « les couleurs des modes
  influencent la ring bar, la progress bar etc. ») : anneau en dégradé
  bleu → violet pour DUAL SYNC (classe `hy`, dégradé SVG `#lv-hy`) ; la
  file prend la couleur de ce qu'elle transfère (`queueMode`,
  `QUEUE_COLORS` : client vert, SYNCTHING bleu, S-FTP violet, DUAL SYNC
  dégradé ; variables `--q-color`, `--q-fill`, `--q-glow`), y compris le
  badge SPEED ; la file Syncthing aussi. La vérification des checksums ne
  passe plus la file en bleu.
- **Logo turquoise #19C9B4** (choix de Noar, au lieu du rouge FileZilla trop
  proche du magenta de Presto) : `--accent`, `scripts/make-icon-svg.py`,
  icônes régénérées (`gen-icons.py` : PNG, .ico, .icns). Le dessin reste le
  mot « filo » (les pistes d'icône A/B/C n'ont pas été retenues pour
  l'instant). La capture du README montre encore l'ancien logo.

- **0.6.1 (12/10/2026)** : statuts UP TO DATE / ALL UP TO DATE dans
  l'anneau, graphes de débit fluides (détail dans « Retouches après l'essai
  de la 0.5.0 » ci-dessous), barre de connexion avec MODE, en-tête de file
  refait (section suivante). Tests : **586 (+18 FTP réels)** verts.

### Barre de connexion et en-tête de file (12/10/2026, demandes de Noar)
- **0.7.0 : MODE n'existe plus**, remplacé par le rail latéral (0.8.0 : le rail est remplacé à son tour par les onglets de la barre de titre, mêmes identifiants ; `#rail` :
  `#mode-client` TRANSFER, `#btn-sync` LIVE SYNC, `#q-sites` SITES,
  `#btn-settings` SETTINGS ; `placeMode()` ne fait plus que colorer la vue
  affichée). Le menu LIVE SYNC : clic sur LIVE SYNC quand sa vue est
  affichée, ou clic droit. Le paragraphe suivant décrit l'état 0.6.x.
- **MODE** (`#mode-f`, à gauche de la barre de connexion) : CLIENT / LIVE
  SYNC bascule entre le client FTP et la vue LIVE SYNC ; ▾ ouvre le menu
  LIVE SYNC (New session, Import, Connect / Disconnect, Sessions…). Le
  même bloc est déplacé par `placeMode()` dans la tête de la vue LIVE SYNC,
  à la même place (le titre « LIVE SYNC » de la vue est retiré). Clic sur
  LIVE SYNC sans session connectée : le menu. Le bouton LIVE SYNC de la
  barre de titre n'existe plus ; les lignes « Show the file panels / LIVE
  SYNC view » du menu sont retirées (MODE les remplace).
- **Bouton de connexion** à droite de PASSWORD, titre « CONNECT », largeur
  du titre (titre et case alignés).
- **En-tête de file** : START, STOP, CLEAR (balai ; dans l'onglet LOG, il
  copie le journal) à gauche, alignés sur le badge QUEUE ; sous le titre, le
  % global en gros (couleur de la file) et le temps écoulé ; barre de
  progression fine (4 px) sur toute la largeur. Retirés : le petit anneau,
  la vitesse et le PEAK au-dessus de la courbe (en double), le point devant
  le titre, le bouton texte Clear. Badges : SPEED, PEAK, TIME LEFT, LEFT.
  « AUTO » en majuscules ; CHECKSUM vert activé, gris désactivé.
- **Icône et couleur du logo** : propositions faites (A le fil, B le f qui
  envoie, C le chas) ; turquoise retenu en 0.6.2, dessin inchangé.
- **0.6.0 (12/10/2026)** (la 0.5.0 n'a jamais été publiée) :
  SYNCTHING FAILSAFE devient **DUAL SYNC** avec la sauvegarde S-FTP BACKUP
  (miroir strict écrit par le MASTER une fois Syncthing fini), file d'attente
  Syncthing dans le panneau de file, menu LIVE SYNC, filtre en puces,
  retouches de la fenêtre des sessions et de la vue LIVE SYNC. Essayé par
  Noar en 0.5.0 : « La synchro Syncthing se fait ». Tests : **586 (+18 FTP réels)**
  verts (voir section 10 pour le test intermittent du relais).
- **0.5.0 (12/10/2026), jamais publiée** : LIVE SYNC entre deux filo
  (Syncthing embarqué), avec ou sans failsafe S-FTP, MASTER / SLAVE,
  corbeille, nouvelle vue LIVE SYNC ; revue de code complète. Sections
  ci-dessous, de la plus récente à la plus ancienne. Deux scénarios de bout
  en bout pilotés ici (deux filo, deux profils) : config par fichier avec
  failsafe et liaison par SYNCTHING ID (400 Mo reçus).
  **Pas encore essayé** : entre le Mac et le PC de Noar à travers deux box,
  build Mac signé et notarisé avec Syncthing, DUAL SYNC avec un vrai NAS.

### DUAL SYNC et S-FTP BACKUP (12/10/2026, décisions de Noar)
- **Nom** : SYNCTHING FAILSAFE s'appelle **DUAL SYNC** ; sa partie serveur
  **S-FTP BACKUP** (« pour que ça tienne dans le ring »). Le code garde
  `via: 'hybrid'` et `fsAuto` (interrupteur de la partie serveur).
- **Principe** : Syncthing d'abord (plus rapide). Quand les deux ordinateurs
  sont à jour (état `insync`, autre ordinateur connecté) depuis 30 s, le
  MASTER fait du dossier serveur une **copie exacte** de son dossier.
  Déclencheurs : passage à `insync` (`direct-app.js` `mirrorWatch`, rappel
  `onMirror` dans `main.js`), puis l'intervalle et la surveillance du dossier
  habituels (`syncer.run` choisit le miroir quand `mirrorReady` est vrai).
- **Miroir strict** (choix de Noar, « puisque nous avons une corbeille en
  local ») : ce qui n'est plus chez le MASTER est **effacé pour de bon** sur
  le serveur (pas de corbeille côté serveur) ; un dossier disparu part en
  entier, y compris les fichiers filtrés qu'il contenait. Garde-fou : dossier
  local vide et serveur non vide, rien n'est effacé (journal). **Depuis la
  0.6.2 : synchro à trois** (voir « Revue 0.6.2 ») : seul ce que la session
  connaît est effacé, ce qui est posé sur le serveur arrive sur le MASTER.
- **Un seul écrivain : le MASTER.** Le SLAVE reste en attente tant que
  l'autre ordinateur est joignable.
- **Syncthing redevient actif** (`syncing`, autre ordinateur connecté) : les
  copies du miroir passent en pause (`syncer.holdMirror`), puis reprennent.
  L'autre ordinateur disparaît : elles reprennent aussitôt et la partie
  serveur fait le relais à double sens comme avant (jamais d'effacement dans
  ce cas).
- **Logique pure** : `mirrorPlan` dans `core/syncplan.js` (même format d'état
  que `plan`, pour que le relais reparte de là). Première comparaison :
  même taille des deux côtés = même fichier ; ensuite suivi par taille et
  date.
- **Affichage** : pendant la copie, l'anneau dit « S-FTP BACKUP » (violet,
  flèches sortantes) et le panneau de file montre la file de filo à la place
  de la file Syncthing ; carte serveur : « copying to the backup », « backup
  up to date », « waits for Syncthing to finish ».
- **Coût** : la connexion montante du MASTER sert deux fois (vers l'autre
  ordinateur, puis vers le serveur).

### Retouches après l'essai de la 0.5.0 (12/10/2026, demandes de Noar)
- Anneau : EST. TIME en MM:SS ou H:MM:SS sans « ~ » (`fmtEta`) ; anneau
  estompé au repos. **IDLE remplacé en 0.6.1** (« ne veut pas dire grand chose ») :
  **UP TO DATE** (les deux Syncthing synchros ; en S-FTP, dernier passage
  sans rien à copier ni conflit), **ALL UP TO DATE** (DUAL SYNC : les deux
  ordinateurs et le S-FTP BACKUP). Le backup cesse d'être « à jour » dès que
  Syncthing retransfère (`syncer.staleMirror`). IDLE ne reste que si filo ne
  sait pas encore (session S-FTP jamais vérifiée).
- **Graphes de débit fluides (0.6.1)** (anneau et file) : une seule boucle
  `requestAnimationFrame` (`animGraphs`), active seulement pendant un
  transfert. File : chaque point placé selon son âge, le dernier tronçon
  tend vers la vitesse lue, échelle adoucie. Anneau : la nouvelle barre
  entre par la droite (dessinée une place hors du disque, `ringFrame` fait
  glisser le groupe), échelle adoucie par `scale`, valeur lissée à moitié
  vers la nouvelle (Syncthing ne donne un débit que toutes les 2 s).
  Conséquence : le graphe de l'anneau a environ 1 s de retard ; les chiffres
  restent instantanés.
- Bascule vue LIVE SYNC / panneaux : **gardée dans le menu du bouton LIVE
  SYNC** (choix de Noar), pour utiliser filo en client FTP pendant une
  synchro.
- **File d'attente Syncthing** dans le panneau de file (`direct.js`
  `_pairQueue`, événement `live-queue`, `renderStQueue`) : fichiers en cours
  avec leur %, en attente, derniers arrivés ou envoyés. Événements Syncthing
  DownloadProgress / RemoteDownloadProgress, `progressUpdateIntervalS: 2`.
- Bouton LIVE SYNC : un menu (New session, Import session as SLAVE,
  Connect / Disconnect, bascule vue / panneaux, Sessions…).
- Fenêtre des sessions : icône de suppression par session, 2 WAYS par
  défaut, « Import session », badge MASTER MODE / SLAVE MODE, descriptions
  réduites, REMOTE COMPUTER = nom + ID + COPY.
- Vue LIVE SYNC : badge de rôle à côté du nom ; SLAVE vert connecté, rouge
  avec icône sinon ; LINK simplifié ; SYNC = SEND / RECEIVE / 2 WAYS.
  Le bouton de bascule vers les panneaux a été retiré de la vue (la bascule
  reste dans le menu LIVE SYNC).
- **Filtre de fichiers** propre à chaque session, en puces avec × et un champ
  ADD (`aep` ou `.aep` → `*.aep`). Liste par défaut réduite
  (`DEFAULT_SYNC_EXCLUDE`) ; les fichiers de travail de filo
  (`SYNC_ALWAYS_EXCLUDE` : `*.filopart, *.filoold, .*.filoparts`) ne sont
  plus affichés et sont toujours exclus (S-FTP et Syncthing). Séparateurs
  acceptés : virgule, point-virgule, `|`, retour à la ligne.

### Noms, couleurs, vue épurée, liaison par ID (12/10/2026, décisions de Noar)
- **DIRECT s'appelle SYNCTHING** dans toute l'interface, les messages, les
  scripts de build et la doc publique ; DIRECT + S-FTP FAILSAFE s'appelle
  **SYNCTHING FAILSAFE**. Le code garde `via: 'direct' | 'hybrid' | 'server'`
  et les noms internes (`direct.js`, `direct-app.js`, `filo-direct:`,
  `FILO_DIRECT_BUILD`) : rien à migrer. Les sections plus anciennes de ce
  fichier disent encore DIRECT.
- **Couleurs** : LIVE SYNC bleu (bouton qui respire, titre, badges de rôle) ;
  mode SYNCTHING bleu, S-FTP violet, SYNCTHING FAILSAFE dégradé bleu / violet
  (`--hybrid`). États : vert connecté, orange empêché / avertissement, rouge
  déconnecté. Les couleurs des protocoles du gestionnaire de sites (SFTP,
  FTPS, FTP) n'ont pas changé.
- **Un seul dessin de badge** dans toute l'appli, sur le modèle de l'ancien
  badge MODE (11 px, graisse 900, espacement .12em, 4 px 9 px, rayon 7 px ;
  règle commune en tête de `index.html`, couleur par classe). Les compteurs
  chiffrés (onglets de la file, etc.) ne sont pas des badges.
- **Vue LIVE SYNC épurée**, quatre lectures, une place chacune :
  client FTP ou autosync (l'écran lui-même ; bouton LIVE SYNC bleu qui
  respire si une autosync tourne derrière les panneaux) ; quel mode (badge en
  haut à gauche de la carte centrale, `modeBadge`) ; connecté ou non (icône
  du même badge : prise verte, orange, débranchée rouge ; détail par côté :
  REMOTE COMPUTER et S-FTP FAILSAFE avec CONNECTED / DISCONNECTED, NOT LINKED
  YET en orange) ; MASTER ou SLAVE (badge sur THIS COMPUTER seulement). En
  haut, seulement LIVE SYNC et le nom de la session ; plus d'interrupteurs à
  droite (le clic sur le badge de mode connecte en un clic, déconnecte après
  confirmation ; SYNCTHING FAILSAFE ouvre ses deux interrupteurs) ; la
  pastille « Not connected » du client FTP est masquée dans la vue ; dans
  l'anneau, seulement « VIA S-FTP » quand une session failsafe passe par le
  serveur.
- **Flèches de sens** de part et d'autre de l'anneau pendant une synchro
  (`liveFlow`) : droite = envoi, gauche = réception. Syncthing : débits, un
  sens ne compte qu'au-dessus de 32 Ko/s et d'un quart de l'autre (le
  receveur envoie ses petites demandes). S-FTP : copies de la session en
  cours dans la file.
- **Un seul sens pour monter une session : le MASTER envoie, le SLAVE
  importe.** Par fichier de config (SYNCTHING ou FAILSAFE), ou, SYNCTHING
  seul, par le SYNCTHING ID du MASTER (affiché dans sa carte REMOTE COMPUTER
  tant que personne n'est lié) : le SLAVE fait IMPORT A CONFIG → PASTE A
  SYNCTHING ID (`direct-app.join` : ID vérifié par ses caractères de
  contrôle Luhn mod 32, `parseDeviceId`, puis l'ordinateur est accepté et
  Syncthing démarre) ; le MASTER voit « X wants to connect », accepte et coche
  la session à partager (`accept(dev, share)` → `shareTo`, la seule session
  en attente déjà cochée) ; le SLAVE accepte la session offerte et choisit
  son dossier (rôle SLAVE). Le nom de l'autre ordinateur arrive tout seul
  (Syncthing remplit le nom vide à la connexion : événement `peername`).
  FAILSAFE seulement par fichier : un ID ne porte pas le serveur.

### MASTER / SLAVE, corbeille, config par fichier (11/10/2026, décisions de Noar)
- **MASTER = la machine qui crée la session** (`role` de la paire, `master`
  par défaut ; `slave` à l'import d'une config ou à l'acceptation d'une offre).
- **Conflit (DIRECT)** : la version du MASTER gagne, l'autre est gardée à
  côté sous `nom.sync-conflict-<date>-from-<machine>.ext`. Syncthing garde la
  plus récente et son étiquette dans le nom n'est pas fiable pour savoir de
  quelle machine vient une copie (constaté) : `Direct.masterWins` interroge
  l'index de Syncthing (`/rest/db/file`, `modifiedBy`) 3 s et 12 s après
  chaque fichier reçu ; une copie créée sur le MASTER contient sa version :
  échange des deux noms, et la version du MASTER prend la date du moment
  (sinon Syncthing redonnerait la main à la plus récente : constaté). Seul le
  MASTER renomme. Test : « the MASTER's version wins on both computers ».
- **Conflit (FAILSAFE, sur le serveur)** : `plan({ prefer })` (`'l'` sur le
  MASTER, `'r'` sur le SLAVE) ; la copie marquée `master` est précédée d'un
  renommage de la version perdante (sur le serveur côté MASTER, en local côté
  SLAVE), jamais perdue.
- **Le SLAVE suit le MASTER** (nom, direction inversée, filtre) : en DIRECT par
  un petit dossier de contrôle Syncthing (`filoctl-…`, dans le profil,
  `userData/direct/ctl/<folderId>/session.json`, toujours dans les deux sens
  car le dossier de la session peut être en envoi seul ou réception seule) ;
  en FAILSAFE aussi par `.filo-session` sur le serveur (`syncer.sessionExchange`).
  Réglages d'une autre machine ignorés (`masterId` vérifié). Sur le SLAVE,
  nom, direction et filtre sont grisés dans le formulaire.
- **Suppressions (DIRECT)** : propagées, mais dans la corbeille de l'autre
  côté : versioning `trashcan` de Syncthing vers `<dossier>/.filo-trash`
  (même disque : un déplacement, pas une copie), conservation illimitée,
  jamais synchronisée (ligne `/.filo-trash` ajoutée d'office au `.stignore`).
  Aussi : un fichier remplacé par une version venue de l'autre machine y va.
  S-FTP : toujours aucune suppression ; la corbeille n'est jamais envoyée sur
  le serveur (`NEVER_SYNCED` dans `syncer.js` : `.stfolder`, `.stignore`,
  `.stversions`, `.filo-trash`, `.filo-session`).
- **Config par fichier seulement** : SAVE CONFIG FILE… (plus de copier-coller,
  plus de mail : un lien mail ne joint pas de fichier). Côté SLAVE : LIVE
  SYNC sans session → CREATE A SESSION / IMPORT A CONFIG ; IMPORT A CONFIG →
  OPEN THE CONFIG FILE… ou FIND ON A SERVER… (bookmark + dossier, lit
  `.filo-session`). Mot de passe du serveur jamais dans le fichier : tapé à
  l'import.
- **`.filo-session` sur le serveur** : accepté par Noar pour les sessions
  FAILSAFE seulement (exception à « aucun fichier de filo chez un client »).
- **Deux interrupteurs CONNECT** dans la vue (SYNCTHING : `auto` ; FAILSAFE :
  `fsAuto` ; S-FTP seul : `auto`) : vert connecté, orange connecté mais
  empêché (autre ordinateur injoignable, serveur en erreur), rouge
  déconnecté, chaque clic confirmé. Une session est « active » si l'un des deux l'est.
- **Bouton LIVE SYNC** : rouge si aucune session active, vert respirant si
  une l'est, orange si problème ou machine en attente de réponse.
- **Directions** dans l'ordre 2 WAYS, LOCAL → REMOTE, REMOTE → LOCAL.
- Vérifié de bout en bout ici (deux filo + un serveur SFTP de test, interface
  pilotée) : création FAILSAFE sur le MASTER, fichier de config enregistré,
  `.filo-session` écrit sur le serveur, le SLAVE trouve la session sur le
  serveur, l'importe, est accepté, reçoit par Syncthing ; le SLAVE fermé, le
  MASTER passe en S-FTP et envoie sur le serveur.

### Revue de code avant la 0.5.0 (11/10/2026, « tous les lots en une fois »)
Trois relectures (processus principal et sécurité, DIRECT / FAILSAFE,
interface), chaque point vérifié dans le code avant d'être corrigé.
- **Sécurité** : `takeSession` exige le `masterId` du MASTER (avant : un
  `.filo-session` sans `masterId` était accepté) ; l'import revalide la partie
  serveur (`parseShare`) ; `toIgnore` retire les marques propres à Syncthing
  (`!`, `(?d)`, `#include`, `//`) et met `(?i)` (filtres insensibles à la
  casse, comme en S-FTP) ; `push_github.command` refuse sans `.gitignore` et
  retire toujours `.env`, certificats et clés.
- **FAILSAFE** : `directFirst` renvoie `false` si SYNCTHING est coupé
  (`auto`) ; `onFailover` et `syncer.run` respectent `fsAuto` (seul CHECK
  NOW passe outre) ; bascule seulement après deux relevés manqués
  (`emitStatus`, `miss`) ; un fichier absent ici mais présent dans
  `.filo-trash` n'est pas redescendu du serveur (compté « respected ») ;
  `prefer: 'r'` (SLAVE) ne joue plus au premier regard (le serveur peut être
  en retard), seulement pour un vrai conflit depuis le dernier passage.
- **Syncthing** : dossier créé en pause, `.stignore` posé, puis remis en
  route ; boucle de relevés à génération (`pollGen`) ; une boucle
  d'événements par processus ; `quit` : plus de redémarrage pendant l'arrêt ;
  un redémarrage raté s'affiche en erreur ; copie de conflit perdante jamais
  écrasée (suffixe `-2`…).
- **Processus principal** : réponses IPC LIVE SYNC toujours `{ ok, error }`
  (`guard`) ; règle « déjà là » inconnue = `skip` ; fichier local fermé sur
  erreur réseau ; connexion du sélecteur de dossier sérialisée ; plusieurs
  listings en cours annulables ; noms `.`/`..` refusés côté serveur ; casse
  respectée sous Linux pour « dossier dans lui-même » ; erreurs
  d'enregistrement des réglages dans le journal ; CLI : une requête par
  connexion ; `waitItems` limité à 4 relevés/s ; message clair si l'API
  GitHub ne répond pas (60 requêtes/heure).
- **Interface** : `isOn(p)` partout (liste, bouton, mode) ; interrupteurs
  vert / orange (activé mais ne peut pas travailler) / rouge ; carte FAILSAFE
  « OFF » ; SHARE caché sur un SLAVE ; dossier S-FTP grisé sur un SLAVE ;
  textes alignés (IMPORT A CONFIG, DIRECT + S-FTP FAILSAFE, corbeille à
  l'import) ; vue live réécrite seulement si elle change (`setHTML`,
  `renderMid` met à jour l'anneau sans le recréer) ; progression des
  suppressions serveur ; code et CSS morts retirés (`syncShareEmail`,
  `disconnectSync`, `live-item`…).
- **Gardé tel quel, exprès** : CANCEL dans la fenêtre LIVE SYNC (demandé par
  Noar) ; bouton LIVE SYNC rouge même sans session (« rouge quand pas
  actif ») ; 2 WAYS en bleu (couleur de syncto) ; type « DIRECT » et mode
  « SYNCTHING » (le mode dit par où passent les fichiers).

### LIVE SYNC réorganisé (11/10/2026, demande de Noar : « L'UI Live Sync est incompréhensible »)
- **Bouton LIVE SYNC** : ouvre la fenêtre des sessions (liste à gauche,
  IMPORT et THIS COMPUTER en bas). Sans session : directement le choix
  « New LIVE SYNC session » en trois cartes : **DIRECT**, **DIRECT + S-FTP
  FAILSAFE**, **S-FTP**. Si une session est connectée et que l'on regarde les
  panneaux (SHOW FILES), le bouton ramène la vue LIVE SYNC.
- **Formulaires** (mots de Noar) : DIRECT = nom de session, direction,
  local folder (BROWSE), FILE FILTER. S-FTP = nom, bookmark (menu des sites),
  direction, local folder, S-FTP FOLDER (saisie + BROWSE : petit navigateur de
  dossiers sur le bookmark, sa propre connexion fermée après 1 min), AUTO
  WATCH (interrupteur + intervalle en liste de 1 min à 2 h, ou Custom… en
  minutes), FILE FILTER. FAILSAFE = les deux. Boutons : CANCEL, SAVE, SAVE &
  CONNECT ; DELETE et SHARE à gauche pour une session existante (hors
  demande : gardés, sinon on ne peut plus supprimer une session ni partager
  une session S-FTP avec une autre équipe). USE PANEL retiré (il prenait le
  dossier ouvert dans le panneau de gauche : caché derrière la fenêtre, et
  rien ne se passait quand ce panneau montrait la liste des lecteurs).
- **CONNECT** (DIRECT pas encore lié) : fenêtre « Send this to the other
  computer » : résumé (session, de qui, sens pour l'autre, serveur du
  failsafe sans mot de passe) + le code, en texte à copier (COPY), EXPORT…
  (fichier `.filosync`), EMAIL. L'import accepte le texte entier.
- **Vue LIVE SYNC** (fenêtre principale, `#live`, `renderLive()`) : remplace
  la barre de connexion et les deux panneaux tant qu'une session est
  connectée ; la file reste dessous. « LIVE SYNC » en grand avec un point qui
  pulse, onglets si plusieurs sessions, **MODE : SYNCTHING ou S-FTP**. À
  gauche cette machine (nom, système, IP, dossier, contenu, rôle, version de
  filo) ; au centre le sens, l'état, la progression, les débits, les fichiers
  reçus ; à droite l'autre machine (nom, système, IP, lien, ID, ce qu'elle a)
  ou le serveur S-FTP (bookmark, serveur, dossier, vérifications), et pour
  FAILSAFE le serveur en dessous (STANDBY / IN USE). DISCONNECT en un clic ;
  SHOW FILES ; SETTINGS. Les demandes « wants to connect » s'affichent en haut
  de la vue.
- **Système de l'autre machine** : Syncthing ne transmet qu'un nom ; filo
  nomme donc chaque machine « nom · système » (`deviceName()` dans
  `direct.js`), et la vue sépare les deux.
- **Connecté** = `auto` de la paire. Nouveau champ `watch` (AUTO WATCH :
  surveiller le dossier local), vrai par défaut.
- **FAILSAFE** (`via: 'hybrid'`) : la paire est à la fois une paire DIRECT
  (Syncthing, `direct-app.js`) et une paire S-FTP (`syncer.js`). Avant chaque
  passe S-FTP, `syncer` demande `directFirst(pair)` : l'autre filo est joint →
  rien côté serveur (état `standby`) ; DIRECT démarre encore (moins de 2 min)
  → on regarde dans 1 min ; sinon la passe S-FTP a lieu. Quand l'autre filo
  se déconnecte, la passe S-FTP part aussitôt (`onFailover`). Vérifié ici :
  deux filo + un serveur SFTP de test, un fichier passé par Syncthing, l'autre
  filo fermé, le fichier suivant monte sur le serveur, la vue passe en MODE
  S-FTP. Un fichier identique des deux côtés (arrivé par le serveur) n'est ni
  recopié ni vu comme un conflit par Syncthing (essayé). Le code d'une
  session FAILSAFE contient le serveur (comme une synchro S-FTP partagée :
  jamais de mot de passe ; l'import le demande).
- **Retouches du 11/10 (après « modifs en vrac »)** : écran de choix et
  directions dans le style des boutons de mode de syncto (icône sur un creux
  teinté, choisi = contour de sa couleur + coche verte). Couleurs : DIRECT
  vert, FAILSAFE violet (`--violet` de syncto), S-FTP bleu ; sens unique =
  vert (l'UPDATE de syncto : ajoute, ne supprime jamais), 2 WAYS = bleu.
  Centre de la vue : **l'anneau de Presto** (repris de Presto 2.2.8,
  `renderer/styles.css` et `index.html`, fourni par Noar) : état au-dessus du
  chiffre, pourcentage en grand, octets dessous, vitesse dans l'anneau avec
  les 40 dernières secondes en barres (un point par seconde, `sampleLive`),
  puis LEFT / FILES LEFT / EST. TIME LEFT. Vert = Syncthing, bleu = S-FTP,
  orange = erreur, gris = autre machine injoignable. L'anneau de la file est
  caché dans la vue LIVE SYNC.
- **Icônes plutôt que texte** (Noar : « de manière générale, privilégie des
  icônes ») dans LIVE SYNC, chacune avec son infobulle : afficher les
  fichiers, réglages, DISCONNECT (rouge), copier / mail / exporter un ID,
  choisir un dossier, parcourir le serveur, changer de type, supprimer,
  partager, oublier une machine. Gardés en texte : les actions principales
  des fenêtres (CANCEL, SAVE, SAVE & CONNECT, ACCEPT, REFUSE…), où une icône
  seule serait ambiguë ; IMPORT et THIS COMPUTER ont icône + mot.
- **L'anneau remplit la case centrale** (Noar, 11/10, après avoir écarté le
  bandeau « chemin des fichiers » : alignements pas soignés, texte sous
  l'anneau trop gros). Tout est dans l'anneau (`midCard`, tailles en unités
  de conteneur `cqw` pour rester proportionnées) : état (IDLE,
  SYNCHRONIZING, SCANNING, CHECKING, FILES SETTLING, WAITING, NOT REACHABLE,
  ERROR), pastille SYNCTHING (vert) / S-FTP (bleu), %, octets faits / total,
  vitesse sans intitulé, FILES LEFT et EST. TIME (chiffre grand, intitulé
  petit gris). Le graphe de débit est dessiné dans le disque intérieur
  (`clipPath` r 79, l'anneau est à r 86) : il ne déborde jamais. Erreur =
  anneau orange fermé ; rien ne peut passer = anneau gris vide ; détails
  d'un problème dans l'infobulle de l'anneau. Côté envoi Syncthing, les
  fichiers restants viennent de `needItems` de `/rest/db/completion`.
  Comportement FINISHING du failsafe validé par Noar.
- **Failsafe « FINISHING »** : des copies déjà mises en file par le failsafe
  finissent même quand DIRECT revient (le serveur garde sa copie pour la
  prochaine absence) ; la carte l'affiche au lieu de STANDBY. ID DIRECT entiers dans les deux cartes, avec
  COPY / EMAIL / EXPORT… (IPC `direct-id-share`). « Other computer » devient
  « remote computer » partout ; sens LOCAL → REMOTE / REMOTE → LOCAL.
- Corrigé au passage : les fichiers reçus par DIRECT n'arrivaient jamais au
  journal (le flux d'événements filtré de Syncthing numérote ses événements
  lui-même : il faut partir de 0).

### DIRECT (LIVE SYNC entre deux filo, sans serveur)
- **Quoi** : une paire LIVE SYNC « Through : DIRECT (another filo) » au lieu
  d'un site. Syncthing v2.1.5 (MPL-2.0), livré tel quel à côté de filo
  (`resources/syncthing/` avec `LICENSE.txt`, `AUTHORS.txt`, `SOURCE.txt`),
  lancé et piloté par filo via son API REST locale. L'utilisateur ne voit
  jamais Syncthing.
- **Fichiers** : `src/main/direct.js` (le programme : démarrage, configuration,
  état, journal), `src/main/direct-app.js` (côté filo : paires, appareils
  acceptés, code `filo-direct:`, offres), branché dans `main.js` (IPC
  `direct-*`, `sync-*` qui aiguillent), `syncer.js` ignore les paires DIRECT,
  fenêtre : `app.js` (formulaire, demandes, THIS COMPUTER), `config.js`
  (`via`, `peer`, `folderId`, `directDevices`).
- **Première rencontre** : A enregistre, SHARE donne un code (ID de A, dossier,
  sens pour B ; aucun secret, aucun n'est nécessaire) ; B l'importe et choisit
  son dossier ; A voit « B wants to connect » avec l'ID de B : ACCEPT. Ensuite
  les deux filo sont liés : une nouvelle paire de l'un est **offerte** à
  l'autre (ACCEPT… et choix du dossier), sans code.
- **Règles LIVE SYNC tenues** (mises à jour plus haut, MASTER / SLAVE et
  corbeille) : à l'origine `ignoreDelete` sur chaque dossier ; modifié des
  deux côtés : **les deux versions gardées** (`nom.sync-conflict-<date>-<appareil>.ext`,
  `maxConflicts` illimité, décision de Noar) ; sens par paire (sendonly /
  receiveonly / sendreceive) ; exclusions de filo traduites en `.stignore`.
- **Dans le dossier de l'utilisateur** : Syncthing y met `.stfolder` (repère
  qui l'empêche de prendre un disque débranché pour un dossier vidé) et
  `.stignore` (exclusions). Dit dans le formulaire.
- **Sécurité** : interface web de Syncthing sur 127.0.0.1, port nouveau à
  chaque lancement, verrouillée par un mot de passe aléatoire oublié ; filo
  utilise la clé API de `config.xml` (fichier de cet utilisateur), passée par
  l'environnement (`STGUIAPIKEY`), jamais en ligne de commande. Pas de mise à
  jour automatique (`STNOUPGRADE`), pas de rapport d'usage.
- **Réseau** : découverte globale + locale, relais publics, UPnP / NAT-PMP.
  Port 22000, ou le suivant libre si un Syncthing de l'utilisateur l'a déjà
  (gardé dans `direct/filo-port`).
- **Vie du programme** : démarre seulement s'il existe une paire DIRECT (ou
  THIS COMPUTER) ; relancé 3 fois au plus en 10 min s'il s'arrête ; à la
  fermeture, arrêt propre par l'API (base de données fermée) avant que filo
  quitte ; un Syncthing laissé par un filo planté est arrêté au lancement
  suivant (par l'API, avec notre clé). Deux processus (moniteur + travail),
  normal pour Syncthing.
- **Build** : `scripts/syncthing-fetch.js`, appelé par le hook `beforePack`
  (`engine-build.js`) : télécharge une fois la release officielle (cache
  `vendor/syncthing/`, hors dépôt), **SHA-256 vérifié** contre la valeur écrite
  dans le script (copiée du `sha256sum.txt.asc` signé de la release), sinon
  refusé. Sans internet : app construite sans DIRECT (message en fin de
  build). Mac : binaire arm64 (28 Mo), signé avec l'app par electron-builder.
  Windows depuis le Mac : rien à compiler, réaliste.
- **Débit mesuré ici** (même machine, boucle locale) : 200 Mo en 3,5 s. Entre
  deux vrais ordinateurs : à mesurer par Noar (réseau local, puis à travers
  les box ; par relais, lent par nature).
- **Version du code : 0.4.0** (11/10/2026, numéro confirmé par Noar) :
  moteur Rust pour SFTP (section suivante), intégré aux builds ; demandes
  d'interface du 11/10 (ci-dessous) ; Auto démarre un envoi en segments sur
  une connexion. Mesuré dans l'app sur le DS920+, fichier de 21,8 Go, puis
  FileZilla juste après sur le même fichier : réception 2'12" (FileZilla
  3'13"), envoi 1'53" sur une connexion (FileZilla 2'01" ; Auto à 4
  connexions : 2'42"). Tests : **481** verts avec le moteur, **466** sans
  (`FILO_ENGINE=0`). Test instable connu : « one file at a time … a running
  file stopped » a échoué une fois sur une dizaine de passages (minutage),
  sans le moteur ; repassé vert 5 fois de suite.
- **0.3.5** (10/10/2026) :
  déplacement par glisser dans un panneau, HOME, graphe visible seulement
  pendant un transfert, double-clic sur un fichier = menu, Entrée = renommer,
  bouton NOT CONNECTED / CONNECTED, clic droit sur QUEUE / FAILED / DONE ;
  **LIVE SYNC** (ex AUTO SYNC ; `syncer.js`, `core/syncplan.js`, `core/filter.js`),
  **partage d'une synchro** (`.filosync` / ligne `filo-sync:`), **relais par
  segments** entre deux filo (SFTP), **ligne de commande** (`cli.js`,
  `docs/CLI.md`), réglages **POST COMMAND**, `scripts/bench-nas.command`.
  **Défaut grave corrigé** : les sites à **clé SSH** ne pouvaient rien
  transférer (voir Pièges). **Débit SFTP** : fenêtre de réception agrandie,
  requêtes de 32 Ko en réception (les grosses requêtes étaient jusqu'à 3 fois
  plus lentes sur un vrai fichier) ; sur le DS920+, fichier de 20 Go, Auto :
  envoi 2'29", réception 2'30" (FileZilla 3'04" et 2'40"). Tests : **463**,
  tous verts.
- **Chantier suivant (décidé par Noar le 10/10/2026)** : un moteur de
  transfert en **Rust**, « pour pulvériser FileZilla, pas juste le battre ».
  Limite actuelle : le moteur SSH de filo (ssh2, en JavaScript) ; OpenSSH
  fait ~185-206 Mo/s sur **une** connexion vers le même NAS, filo ~75-125
  (4 connexions : ~145). Voir Prochaines étapes.
- **Demandes de Noar du 11/10/2026 (0.4.0)** :
  1. QUEUE / FAILED / DONE : heure d'ajout ou de départ, heure de fin, durée
     et débit moyen par fichier (`timesOf()` dans `renderer/app.js` ;
     `addedAt`, `startedAt`, `finishedAt` exposés par `queue._public`). La
     durée part du dernier départ du fichier (après pause ou reprise : ce
     dernier passage).
  2. Bouton de connexion : icône et couleur seules (vert branché, rouge
     débranché), le texte est dans l'infobulle et `aria-label`.
  3. **AUTO SYNC renommée LIVE SYNC** partout où l'utilisateur la voit
     (bouton, fenêtre, messages, docs) et en ligne de commande :
     `filo livesync` (`filo sync` accepté, ancien nom). **Gardés tels quels,
     exprès** : les noms internes du code (`syncer.js`, `syncPairs`, IPC
     `sync-*`), le fichier `.filosync` et la ligne `filo-sync:` (déjà
     partagés : les changer casserait les partages existants).
  4. En-tête de la file : **temps restant** (grand, données restantes ÷
     débit moyen des 10 dernières secondes, `avgSpark`) et temps écoulé
     depuis le début du passage (`#q-times`). Le badge ETA est retiré.
  5. Ligne d'un fichier en cours : transféré / total, débit, temps écoulé,
     temps restant ; pour un fichier en segments, le nombre de transferts
     simultanés seul (pastille `.par`, détail dans l'infobulle). « N at once »
     et « N of M done » retirés.
  6. **Auto, envoi en segments : départ à 1 connexion** (`startLow`,
     `SEGMENT_UP_START` dans `core/autotune.js`), puis Auto monte seulement
     s'il mesure un gain. Raison : 4 connexions écrivant le même fichier à
     4 endroits freinent les disques du NAS (21,8 Go : 1'53" à 1, 2'42" à 4).
     La réception démarre toujours à 4.
- **Moteur Rust (0.4.0)** :
  `engine/` (programme `filo-engine`, Rust, choix validés par Noar le
  10/10/2026). **Étape 1** : prototype mesuré sur le DS920+ (bench R du
  10/10, 20 Go) : réception 4 connexions 1'41" (filo 0.3.5 : 2'30",
  FileZilla : 2'40") ; envoi 2'22" (filo 2'29", FileZilla 3'04", limité par
  les disques du NAS occupés à 85 %). **Étape 2 faite** (« go chantier ») :
  intégré au moteur de transfert pour SFTP, et aux builds (« go » de Noar).
  - Rôle : uniquement les octets d'un fichier ou d'un segment (disque ↔
    réseau, empreinte xxHash64 au passage) et la relecture de vérification.
    Tout le reste (file, décisions, `.filopart`, renommage, checksum serveur,
    relais, navigation, FTP) reste en JavaScript.
  - Un processus `filo-engine serve` par connexion de la file, lancé à la
    première donnée à déplacer, avec sa propre connexion SSH (même compte,
    **même empreinte serveur** que celle vérifiée par filo, sinon refus).
    Dialogue : une ligne JSON par message sur stdin / stdout ; le mot de
    passe ou la clé passent par le tuyau, jamais par la ligne de commande.
    Connexion : mot de passe puis keyboard-interactive (Synology), ou clé
    (OpenSSH, PEM ; une clé PuTTY `.ppk` est lue par ssh2 et passée en PEM).
  - Côté filo : `proto/sftp-engine.js` (lancement, dialogue, erreurs en
    RemoteError), `SftpRemote.engineJob()` (`proto/sftp.js`),
    `engineMove()` dans `core/transfer.js` (fichier entier, segments, relecture
    `readBackHash` et relecture de segment). `main.js` donne le chemin du
    programme une fois l'app empaquetée (`FILO_ENGINE_PATH`, `resources/`).
  - **Limite de débit** : appliquée par le moteur (seau à jetons, comme
    `core/throttle.js`) ; `Limiter.watch()` lui transmet chaque changement
    pendant un transfert (op `rate`).
  - **Repli sur le moteur JavaScript** (comme avant) : `FILO_ENGINE=0`,
    programme absent, connexion ou identité refusée par le moteur (une fois
    par connexion, écrit dans le journal « Rust engine not used… »).
  - Règles tenues : réception écrite **dans l'ordre** (le fichier partiel est
    toujours un préfixe exact, la reprise sur sa taille reste juste) ; en
    envoi, le moteur dit ce que le serveur a confirmé sans trou (`kept`),
    utilisé pour reprendre un segment ; profondeur d'envoi 64 × taille
    d'écriture = la marge de reprise de filo (`resumeMargin`), à garder
    égales. Un arrêt demandé pendant le démarrage du moteur n'est pas perdu
    (le moteur a sa propre connexion, qu'un arrêt de filo ne coupe pas).
  - **Builds** : `scripts/engine-build.js`, appelé par electron-builder avant
    chaque empaquetage (`beforePack`), compile le moteur pour la plateforme
    visée dans `engine/dist/<mac|win|linux>/` (vidé avant), repris par
    `extraResources` (par plateforme dans `electron-builder.yml`). Mac :
    `aarch64-apple-darwin` (signé avec l'app). Windows depuis le Mac :
    `x86_64-pc-windows-gnu`, cible ajoutée par `rustup`, compilateur
    `brew install mingw-w64`. Windows sur PC : Rust (MSVC). Linux : sur
    Linux. **Sans Rust (ou sans MinGW pour Windows), l'app est construite
    quand même, sans le moteur, et le build le dit.** `FILO_ENGINE_BUILD=0`
    l'empêche exprès. Vérifié ici : build Linux empaquetée, le moteur est dans
    `resources/`, 4 processus `filo-engine serve` pendant un téléchargement en
    segments, fichiers identiques dans les deux sens. **11/10/2026, build sur
    le PC de Noar** (`build_on_windows.bat`, Rust MSVC) : moteur compilé et
    inclus (« Rust engine: included »). Piège trouvé : sous Windows la
    variable s'appelle `Path` ; le script ajoutait une seconde `PATH` et
    Windows gardait l'ancienne, d'où « Rust is not installed » avec Rust
    installé. `engine-build.js` réutilise la bonne clé et cherche d'abord
    `cargo` dans `~/.cargo/bin`. **Pas encore vérifié** : le moteur au travail
    dans l'app Windows (ligne « Rust engine: » du journal), build Mac
    (signature, notarisation), Windows depuis le Mac (MinGW).
  - Tests : **478 verts avec le moteur** (section « rust engine » : octets
    bien passés par le moteur, segments, limite de débit, repli) **et 463
    sans** (`FILO_ENGINE=0 npm test`, la section est sautée). Défauts
    trouvés et corrigés en route : un segment entièrement confirmé puis arrêté
    avant sa fin faisait planter la reprise ; un arrêt pendant le démarrage du
    moteur pouvait être perdu.
  - **Reste à faire** : essai réel sur le Mac (app construite) avec le
    DS920+, chronos contre FileZilla ; build Windows et essai sur le PC ;
    ensuite seulement, retirer le transport JavaScript des octets SFTP
    (`sftp-pipe.js`), selon les critères donnés à Noar le 10/10/2026.
- **0.3.4** (10/10/2026) : renommage sur place, barre de
  connexion refaite (CONNECT / DISCONNECT, protocole en menu, connexions
  récentes avec les sites, adresse dans la barre de titre), réglages en
  catégories, puis revue complète du code avant GitHub (sécurité, aucun
  remplacement de fichier sans la règle, reprise). Prévue comme première version publiée,
  jamais publiée : c'est la 0.3.5 qui le sera.
- **Tests (0.3.4) : 393 vérifications, toutes vertes** (`npm test`, ~130 s), plus 18 avec
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
  en couleur, **le rouge de FileZilla `#BF0000`** (tiré de son logo), **turquoise `#19C9B4` depuis la 0.6.2** (choix de Noar). Gabarit
  de la famille : carré noir, dessin blanc, un élément de la couleur de l'app.
  Le SVG est produit par `scripts/make-icon-svg.py` (lettres de Poppins Bold
  converties en contours), puis `scripts/gen-icons.py`. Ce rouge ne vit que sur
  le logo : dans l'interface, le rouge reste la couleur des suppressions et des
  échecs (`--red #f2555a`, plus clair).

- **LIVE SYNC (10/10/2026, nommée AUTO SYNC jusqu'au 11/10)** : par paire (un dossier local, un dossier
  serveur, un site) ; surveillance du dossier local + intervalle pour le
  serveur ; **jamais de suppression** ; une suppression d'un côté est
  respectée (pas renvoyée) et signalée ; modifié des deux côtés = conflit
  signalé, rien n'est écrasé ; un fichier part seulement quand il est stable
  (deux regards à 10 s).
- **Partage entre équipes** : un fichier `.filosync` ou une ligne
  `filo-sync:` ; jamais de mot de passe dedans ; l'empreinte du serveur y est ;
  le sens est inversé pour celui qui reçoit.
- **Ligne de commande** : pilote le filo ouvert (le lance au besoin), jamais de
  mot de passe sur la ligne ; une section **POST COMMAND** dans les réglages
  avec un bouton (i) qui liste les commandes.
- **Checksum serveur sur le NAS** : Noar ne l'active pas sur son NAS (« Juste
  ne pas l'activer sur mon NAS ») ; rien ne change dans filo.
- **Mode DIRECT (fait le 11/10/2026, non publié)** : « version A » : Syncthing
  embarqué et piloté par filo (API REST), pair à pair entre deux filo à
  travers les box, transparent pour l'utilisateur ; le Synology n'est pas
  concerné. Conflits : **garder les deux versions**. Secours : fait autrement
  que « la nuit » : session DIRECT + S-FTP FAILSAFE (11/10), le serveur prend
  le relais dès que l'autre filo n'est pas joignable. Choix faits sans demander (à valider) :
  appairage par code + ACCEPT ; Syncthing seulement si une paire DIRECT
  existe ; binaire arm64 sur Mac.

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
| `config.js` | `preferences.json` (réglages, sites, serveurs connus, historique, paires de synchro) et `queue.json` |
| `core/syncplan.js` | LIVE SYNC : quoi copier, décidé à partir des deux listings et de l'état de la dernière passe (logique pure, testée) |
| `core/filter.js` | exclusions d'une synchro (`PathFilter`, repris de syncto) |
| `syncer.js` | LIVE SYNC : passes, surveillance du dossier, intervalles, état dans `userData/sync/<id>.json.gz`, suivi du relais |
| `direct.js` / `direct-app.js` | DIRECT : Syncthing (démarrage, configuration écrite par filo, état, journal) ; côté filo (paires DIRECT, appareils acceptés, code `filo-direct:`, offres) |
| `cli.js` | ligne de commande : lecture des arguments, canal local (socket / tube nommé + jeton), client ; les commandes elles-mêmes sont dans `main.js` (`handleCli`) |
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
- **DS920+ de Noar (2,5 Gb/s), fichier de 20 Go, 10/10/2026** : app en Auto
  (4 connexions, segments) : envoi 2'29" (~144 Mo/s), réception 2'30"
  (~143 Mo/s) ; FileZilla 3.71 : 3'04" et 2'40". Une seule connexion :
  OpenSSH 184-209 Mo/s, stable ; filo 45-250 selon le passage (le NAS attend
  filo : son sshd à 25-45 % d'un cœur quand filo est lent). Un fichier qui
  tient dans la RAM du NAS (3 Go) fausse tout : tout réglage y fait ~250.

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
- Texte de la Release en cours et liste de contrôle :
  `docs/RELEASE-0.7.1.md` (0.1.0 à 0.6.1 n'ont jamais été publiées ; la
  0.3.5 était la première prévue sur GitHub). Tag `vX.Y.Z` sur `main` (c'est ce que
  `push_github.command` attend pour envoyer `version.json`).
- Fichiers de la Release : `filo-X.Y.Z-mac-arm64.dmg`, `filo-Setup-X.Y.Z.exe`,
  `filo-X.Y.Z-win-x64.zip`, `filo_X.Y.Z_amd64.deb`,
  `filo-X.Y.Z-linux-x86_64.AppImage`.
- Fichiers propres à GitHub : `README.md` (section Download), `SECURITY.md`
  (signalement par e-mail, ce que filo protège, limites dites franchement),
  `CONTRIBUTING.md` (GPL, aucun code de FileZilla, tests obligatoires),
  `LICENSE` (GPL-3.0-or-later), `.gitignore` (certificats, `.env`, logs).
- **Licences des composants** (11/10/2026, demandé par Noar : « sois vigilant
  sur les licences ») : toutes compatibles avec la GPL v3, la licence de filo
  ne change pas. `THIRD_PARTY_NOTICES.md` liste chaque composant d'un build
  (184 crates Rust, 7 paquets npm, icônes Lucide, police Poppins, Electron)
  avec sa licence et son texte. Il est généré par
  `scripts/third-party-notices.js` (lit `engine/Cargo.toml` via `cargo
  metadata` et `package-lock.json` + `node_modules`, ne télécharge rien) et
  copié à côté de l'app dans chaque build (`extraResources` de mac, win et
  linux dans `electron-builder.yml`). Electron ajoute de lui-même
  `LICENSE.electron.txt` et `LICENSES.chromium.html`. **À regénérer à chaque
  changement de dépendance** (AGENTS.md, réflexe 11). Points notés : Apache-2.0
  (russh) impose la GPL v3, pas v2, donc garder le « or-later » ; quelques
  crates (russh, delegate, pageant, r-efi) n'ont pas de fichier de licence,
  le script les renvoie au texte standard. Syncthing (MPL-2.0), quand il sera
  embarqué : programme séparé, livré avec son `LICENSE` et un `SOURCE.txt`
  (lien et version exacte du code source), ajouté à la main dans
  `THIRD_PARTY_NOTICES.md` ; ne pas utiliser son nom ni son logo comme marque
  de filo.
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
- Un canal `ipcMain.handle` déclaré deux fois fait échouer le démarrage de
  `main.js` sans message visible : tous les canaux suivants manquent et la
  fenêtre ne peut même plus se connecter. Le test « preload bridge » le
  vérifie désormais (canaux et méthodes du pont uniques).
- Renommage sur place (0.3.4) : le champ `.ren` est posé dans le
  `spacer` du panneau, **pas** dans la ligne (les lignes sont réutilisées et
  réécrites au défilement) ; `placeRename()` le recale à chaque `render()`.
  Ses événements clavier et souris ne doivent pas remonter à la liste (sinon
  flèches, Retour arrière, lasso et glisser agissent pendant la saisie).
  `cancelRename()` vide `_ren` **avant** de retirer le champ : Chrome envoie un
  `blur` au retrait, qui sinon validerait le renommage.
- Auto : `AutoTuner.boost()` ne joue qu'**une fois** par tuner (premier
  fichier en segments) ; ensuite la mesure décide seule.

- **Une clé SSH envoyée à un fil de transfert** arrive en `Uint8Array`, pas en
  `Buffer` : ssh2 ne la prend pas et tente la connexion **sans** clé
  (« wrong user name, password or key »). Les sites à clé pouvaient parcourir
  (processus principal) mais aucun transfert ne passait, jusqu'à la version
  qui suit la 0.3.4. `lane-worker.js` refait un `Buffer`. Test : « key login
  through the transfer threads » (le serveur de test accepte une clé avec
  `clientKey`).
- **Profondeur de lecture SFTP mesurée sur le temps de réponse MOYEN** : il
  contient la file des requêtes déjà parties, donc grandit avec la profondeur
  elle-même ; la profondeur se doublait chaque seconde jusqu'à 1024, même en
  local, et une connexion tombait de ~450 à 130-220 Mo/s. On prend le temps
  de réponse **le plus court** des 10 dernières secondes (`sftp-pipe.js`).
  C'était l'écart principal avec FileZilla au bench du 10/10/2026.
- **Ligne de commande en développement** : le filo lancé par une commande doit
  recevoir `--no-sandbox` si la commande l'avait (Linux en root).
- **Un serveur qui refuse le compte arrête toute la file** : une commande
  `--wait` doit le voir (`queue.blocked`) et finir avec le code 3, sinon elle
  attend pour toujours.

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
- **Windows, ligne de commande** : `filo.exe` est un programme à fenêtre ;
  tapé dans une invite de commandes, Windows n'attend pas sa fin et
  `%ERRORLEVEL%` n'est pas son code (dans un `.bat` ou depuis un programme,
  tout est normal). Piste proposée, pas faite : un petit `filo.cmd` installé à
  côté de `filo.exe`.
- Fermer la fenêtre sur macOS laisse la file tourner (convention Mac) ; quitter
  (⌘Q) demande confirmation si des transferts tournent.
- **Tests intermittents (11/10/2026)** : une fois, dans la suite complète
  juste après des essais d'interface lourds, « auto sync with a real server »
  (supprimé sur le serveur, renvoyé) et « segment relay between two filo »
  ont échoué ; verts seuls deux fois chacun, puis la suite complète verte
  (535). Probablement du minutage sous charge ; à surveiller.
- **DIRECT** : les deux filo doivent être ouverts en même temps (sinon :
  session FAILSAFE). Syncthing refuse de travailler si le disque du profil de
  filo a moins de 1 % de libre (message clair dans la session). Par relais (aucun chemin direct entre les deux
  box), c'est lent. Au premier lancement, macOS / Windows demandent
  d'autoriser les connexions entrantes de Syncthing. Un filo tué de force
  laisse Syncthing tourner jusqu'au prochain lancement de filo. Le sens se
  règle sur le MASTER (le SLAVE suit). `filo livesync --wait` n'attend pas une paire DIRECT. Nom de
  l'ordinateur = nom réseau de la machine.
- **DUAL SYNC** : le miroir ne se fait que si filo est ouvert sur le MASTER ;
  les effacements sur le serveur sont définitifs (la corbeille est locale) ;
  ce qui est sur le serveur sans avoir jamais été vu sur le MASTER est ramené,
  jamais effacé (depuis 0.6.2) ;
  un fichier modifié chez le MASTER pendant que filo était fermé, de même
  taille que celui du serveur et jamais vu avant, n'est pas renvoyé au
  premier passage.
- **Offre DIRECT d'une session FAILSAFE** (le MASTER choisit un ordinateur
  déjà lié) : acceptée de l'autre côté comme DIRECT seul, sans serveur ; le
  journal du SLAVE le signale. Pour le failsafe : importer le fichier de
  config.
- **Filtre « fichiers seulement »** (`/x.txt:`) : Syncthing n'a pas cet
  équivalent, la règle s'applique aussi à un dossier du même nom en DIRECT.
- Le sens choisi à la création est dans l'ID du dossier ; si le MASTER le
  change avant que l'autre accepte une offre, l'autre part brièvement avec
  l'ancien, puis prend le bon (dossier de contrôle).

## 11. Prochaines étapes

0000. **Livré en 0.7.2** (Noar, 13/10) :
   queue SYNCTHING sur une ligne par fichier (`.strow` : %, sens SEND →
   ou ← RECEIVE avec le nom de l'autre ordinateur, nom, dossier, taille,
   état, barre fine), et elle se vide au fur et à mesure (les fichiers finis
   ne sont plus affichés, seulement comptés « done lately ») ; les copies
   LIVE SYNC de la file FTP disent SEND / RECEIVE et S-FTP BACKUP ou SERVER ;
   **l'anneau seul** (bouton de la tête de la vue LIVE SYNC, `body.mini`,
   IPC `win-mini` : fenêtre de 300 × 330, épingle au-dessus des autres,
   retour à la fenêtre d'avant) ; **icône dans la barre des menus / zone de
   notification** sur les trois systèmes (`Tray`, `src/main/tray/` :
   modèle noir sur Mac, anneau turquoise ailleurs ; menu : ouvrir, sessions
   LIVE SYNC et leur état, l'anneau seul, cacher dans la barre, quitter).
   Fermer la fenêtre garde le comportement d'avant.
   Fenêtres simplifiées : « Import session » n'a plus que ses boutons
   (PASTE, IMPORT CONFIG, FIND, CANCEL ; l'explication au survol) ; après un
   SESSION ID collé : « Waiting for MASTER approval… » (le SLAVE choisit son
   dossier pendant l'attente, étapes et chrono).
   **SESSION ID** (`ID/filo-both-xxxx`, `direct-app.js` sessionId / join /
   joinState / joinSession) : le SLAVE crée la session tout de suite et
   l'offre au MASTER, qui la lie seul, même pour un ordinateur déjà accepté
   (cause de « l'invitation ne vient jamais ») ; le MASTER ouvre de lui-même
   la demande d'accord d'un nouvel ordinateur. Bouton **DISCONNECT** rouge
   dans la tête de la vue LIVE SYNC ; bouton « fin de queue » dans la barre
   de titre (comme syncto). **Bookmarks LIVE SYNC** : dans SITES, un dossier
   « LIVE SYNC » toujours en tête liste chaque session (fabriqué à partir des
   sessions, rien de stocké ; clé interne `\u0000live`) ; double-clic : la
   session dans la vue LIVE SYNC (connexion proposée si elle est coupée) ;
   clic droit : ouvrir, parcourir son dossier S-FTP, réglages.
   **Revue du 13/10** (Noar a validé A à E) :
   A. alignements : `.inline` et `.m-btns` centrés, DISCONNECT aligné.
   B. LIVE SYNC : l'attente du MASTER s'arrête vraiment à CANCEL (drapeau
   `over`, fenêtre marquée `join` : elle ne ferme plus une autre fenêtre) ;
   le SESSION ID est redemandé tant que SYNCTHING n'a pas son ID (il restait
   sur « … ») ; « Session open » seulement quand le MASTER partage le dossier
   (`remoteState` de `/rest/db/completion`, `peerShares`, sinon état
   `waiting`) ; un SYNCTHING ID seul ne retombe plus sur une ancienne session ;
   le MASTER journalise un second ordinateur qui colle le SESSION ID d'une
   session déjà liée ; l'anneau seul ne s'enregistre plus comme taille de
   fenêtre (et une taille trop petite est remontée au minimum), `miniPrev`
   remis à zéro à la fermeture ; SAVE d'une DUAL SYNC n'allume plus SYNCTHING.
   C. sécurité : un téléchargement passe **toujours** par `.filopart` (le
   réglage « temporary files » ne concerne plus que l'envoi : sinon une
   coupure détruisait le fichier local) ; `preferences.json` et `queue.json`
   écrits avec fsync, gardés en `.bak` au démarrage, un fichier abîmé est mis
   de côté (`.corrupt-<date>`) et le `.bak` repris ; `sync-delete` refuse un
   identifiant inconnu.
   D. LIVE SYNC S-FTP : un fichier local remplacé par la synchro part d'abord
   dans `.filo-trash` du dossier de la session (`nom~AAAAMMJJ-HHMMSS.ext`,
   mêmes sous-dossiers ; `keepOldLocal` dans transfer.js, `sync.trash` posé
   par syncer.js). Un téléchargement manuel remplace comme demandé. La
   corbeille n'est jamais vidée par filo (comme celle de SYNCTHING).
   E. textes : DISCONNECT = toute la session, confirmé, comme le menu (le
   badge de mode garde le choix voie par voie) ; SESSION ID partout où le
   SLAVE colle ; plus de « MODE ▾ » dans les fichiers envoyés ; SYNCTHING en
   capitales pour le mode (Syncthing seulement pour le programme) ; SLAVE en
   contour, MASTER plein ; onglet violet pour une session S-FTP ; icône
   « cacher dans la barre » ; infobulles REFUSE / NOT NOW.
   Aussi : débit sous 1 KB/s arrondi (`fmtSize` affichait
   « 359.3333333333333 B/s » sur un petit fichier ; Noar, 13/10).
   Reste de la revue, non traité : tray « The ring alone » quand la fenêtre
   n'existe pas, double-clic sur l'anneau (zone de déplacement, à tester sur
   Mac), alerte téléphone d'une DUAL SYNC dont le backup prend le relais,
   mode mini qui revient en plein écran à la déconnexion, build sans
   Syncthing (DUAL SYNC en ERROR), dossier changé d'une session SYNCTHING
   (même folderId), règles « Resume » / « newer » qui écrasent plus que leur
   nom, `config.xml` de Syncthing non atomique.

000. **Livré en 0.7.1** : raccourcis du panneau
   local (Noar, 13/10) : Bureau, Téléchargements et menu des disques à côté
   du bouton de choix de dossier (`.p-places`, IPC `local-places` :
   `app.getPath('desktop' | 'downloads')`, donc le dossier du système quelle
   que soit la langue ; disques par `local.roots()` : `/Volumes` sur Mac,
   lettres de lecteur et « This PC » sur Windows, `/`, `/media/<user>`,
   `/run/media/<user>` et `/mnt` sur Linux).

00. **Livré en 0.7.0** (au départ prévu en 0.6.5) : FINISHED 5 s puis IDLE ; captures du README refaites en 0.7.0 ; dossiers Syncthing en ordre
   alphabétique (`order: 'alphabetic'`, la queue du SLAVE avançait dans le
   désordre et restait figée en haut) ; fichier en cours dans le ring
   (`ringFile`) ; PAUSE / RESUME de la queue SYNCTHING (`Direct.hold`, état
   `held`, non gardé au redémarrage) ; boutons MODE colorés, texte seul ;
   notification de mise à jour sur le modèle de syncto / ingesto / archivo
   (fenêtre NEW VERSION AVAILABLE, LATER / GET IT, version refusée retenue
   dans `ui.updateDismissedVersion` ; le lien du pied de page est retiré).
   **Rail latéral (piste C, choisie par Noar)** : TRANSFER / LIVE SYNC /
   SITES / SETTINGS à gauche (`#rail`, ids d'avant gardés) ; barre de
   connexion sans étiquettes au-dessus (nom du champ en gris dedans) ;
   navigation synchronisée sur le séparateur des panneaux ; « fin de queue »
   à côté de START / STOP / CLEAR ; menu LIVE SYNC : clic sur LIVE SYNC
   quand sa vue est ouverte, ou clic droit.
   **Ajouts validés par Noar** (le rapport de livraison a été refusé : « pas
   besoin ») : dossiers favoris par serveur (étoile de la barre du serveur,
   `ui.favFolders` par adresse) ; alerte ntfy quand une session LIVE SYNC
   est en panne depuis N minutes puis quand elle repart
   (`src/main/core/syncalert.js`, réglage ntfy `syncAlert` /
   `syncAlertMin`, coupé par défaut).
   **Lot suivant (validé par Noar, 12/10)** : démarrer la queue à une heure
   (clic droit sur START, `queue-schedule` dans main.js, tant que filo est
   ouvert ; ajouter des fichiers ne lance pas la queue) ; vérifier contre
   l'autre côté (clic droit dans un panneau, `src/main/core/compare.js` :
   checksum calculé par le serveur, sinon relecture après accord ; rien
   n'est transféré) ; Quick Look sur la barre espace (Mac, fichier local) ;
   commande après la queue (Réglages › After the queue,
   `src/main/core/hook.js`, modèle ingesto : sans shell, variables
   remplacées argument par argument, jamais dans le programme ; filo attend
   sa fin, 30 min au plus, avant l'action de fin). Piste 7 (ignorePerms
   exFAT) : Noar n'a pas encore testé.
   **Proposé, pas validé** : activer `ignorePerms` tout seul quand le dossier
   local est sur exFAT / FAT / NTFS / SMB. Piste de la lenteur de Noar
   (Pop!_OS, build .deb, disque exFAT, MASTER Mac Studio) : le chmod refusé
   par l'exFAT fait échouer puis réessayer chaque fichier. À confirmer par
   des lignes « operation not permitted » dans le journal. Mesure en labo
   (Linux, SSD) : Syncthing fait 120 à 200 petits fichiers par seconde.

0a. **DUAL SYNC, essai par Noar avec la 0.6.2** : une session DUAL SYNC
   Mac (MASTER) ↔ PC avec le NAS ; vérifier qu'après « IDLE » l'anneau passe
   à « S-FTP BACKUP » et que le dossier du NAS devient identique (fichier
   ajouté, modifié, effacé sur le Mac) ; ajouter un fichier pendant la copie
   (pause puis reprise) ; fermer filo sur le PC (relais par le NAS).
0. **SYNCTHING (ex DIRECT), premier essai par Noar avec la 0.5.0** (fait en
   partie : « La synchro Syncthing se fait ») : build
   Mac et Windows (le build télécharge Syncthing une fois : internet
   nécessaire), une paire Mac → PC sur le réseau local, puis à travers deux
   box (journal : « DIRECT: ready », l'état « direct, through the internet »
   ou « through a relay »), un gros fichier, une modification des deux côtés
   (deux versions gardées), puis une session FAILSAFE avec le NAS : fermer
   filo sur le PC, vérifier que le Mac envoie sur le NAS, rouvrir le PC.

1. **Premier essai sur le Mac** : build, signature, notarisation, Trousseau
   (enregistrer un site avec mot de passe, relancer filo, se connecter sans
   retaper).
2. **Mesures réelles** : Mac Studio ↔ DS920+ (SFTP), puis un serveur client
   distant : une connexion vs Auto vs segments. Dire si le processeur du Mac
   limite (sinon, rien à faire côté Rust). **10/10/2026** : FileZilla fait
   ~240 Mo/s dans les deux sens en SFTP en local avec le DS920+ (fichier de
   90 Go) ; le premier bench filo donnait 135–167 Mo/s (envoi relu en entier
   faute de checksum serveur). Donc le chiffrement du NAS **ne limite pas** à
   ~100 Mo/s (conclusion précédente fausse). Bench du 10/10 (dossier
   `/homes/noar/_TRANSIT/TEST`) : 1 connexion 134 Mo/s en réception, Auto +
   segments 142-189 ; cause trouvée (profondeur de lecture, voir Pièges) et
   corrigée. Attendre le nouveau bench (test 6b = comme FileZilla)
   (`scripts/bench-nas.command`, dossier `/homes/noar/_TRANSIT`) et chercher
   où filo perd du débit s'il reste sous FileZilla en réception ou au test 6.
   **Ce que fait FileZilla 3.71 (lu dans ses sources et celles de fzssh
   1.4.0, 10/10/2026)** : blocs de 32 Ko comme filo ; fenêtre de réception
   de 4 Go avec un serveur OpenSSH (2 Mo chez filo / ssh2) ; en réception,
   nombre de requêtes en route réglé pour viser ~500 ms d'attente, de 16
   jusqu'à 16 384 ; en envoi, aucune limite de requêtes non confirmées : il
   envoie tant que la fenêtre SSH le permet. À comparer aux lignes P du bench
   (P2 = envoi plus profond, P7/P8 = réception plus profonde) avant de
   changer filo : chez ssh2, 1024 requêtes en réception s'effondrent en local.
   **Bench rapide (lignes P) du 10/10, 14 h 05** : envoi seul (moteur SFTP)
   174-227 Mo/s, donc près du lien ; réception 32 Ko × 64 : 150, avec
   fenêtre 16 Mo et 256 requêtes : 215, **255 Ko × 64 + fenêtre 32 Mo : 260**
   (OpenSSH 216). Appliqué : taille de requête annoncée par le serveur
   (`_chunk` dans `sftp.js`), fenêtre dès la première requête, plafonnée à
   32 Mo (au-delà ssh2 ralentit). L'envoi de fichiers par la file (64-81 Mo/s
   au bench complet) reste plus lent que le moteur seul : suspect, l'écriture
   soutenue du NAS une fois son cache plein (les tests du bench complet
   s'enchaînent sur ~60 Go). À confirmer.
   **Bench du 10/10, 15 h 54, fichier de 20 Go** (`~/filo-bench/probe.bin`,
   une connexion) : le réglage de 14 h 05 était **faux** sur un vrai
   fichier. Réception : 254 Ko adaptatif 45-56 Mo/s, 32 Ko adaptatif 173,
   OpenSSH 184, FileZilla 125 (2'40"). Envoi : filo 128-173 (instable d'un
   passage à l'autre), 32 Ko × 256 : 142, 255 Ko × 128 : 108, OpenSSH 209,
   FileZilla ~109 (3'04"). Corrigé (TEST g) : en réception, requêtes de
   32 Ko au plus (`_chunk` dans `sftp.js`), la profondeur adaptative et la
   fenêtre restent ; l'envoi est inchangé. Ce jour-là le NAS était plus lent
   qu'au bench du matin (FileZilla 240 → 110-125) : ne comparer que les
   lignes d'un même passage. À confirmer par le bench TEST g : P5/P12 doivent
   approcher ~170, P6 (désormais l'ancien réglage 254 Ko) rester bas.
2a. **Moteur Rust** : intégré et dans les builds (voir section 1). À faire :
   Noar construit l'app sur le Mac (Rust installé) et le build Windows
   (`brew install mingw-w64` une fois), vérifie dans le journal la ligne
   « Rust engine: … », refait ses chronos 20 Go contre FileZilla ; puis
   numéro de version à confirmer et ZIP.
2b. **Mode DIRECT** (Syncthing embarqué, version A) puis secours SFTP par le
   NAS la nuit.
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
   `docs/RELEASE-0.7.1.md` (push, Release v0.7.1 avec les cinq fichiers, push
   de `version.json`).
8. Noar doit tester la réception depuis son NAS sur le port 1 Gb d'origine
   (sans l'adaptateur USB 2,5G).
9. Pistes non commencées : glisser de filo vers le Finder ; comparaison de
   dossiers (marquer ce qui diffère entre les deux panneaux) ; segments en FTP
   pour la réception (REST + coupure).

## 12. Historique des versions

| Version | Date | Tests | Contenu principal |
|---|---|---|---|
| 0.8.1 | 14/10 | 732 (+18 FTP réels) | Speedtest sur NAS : racine du serveur => sélecteur de dossier ; dossier en lecture seule => test en réception seule ou annuler |
| 0.8.0 | 13/10 | 720 (+18 FTP réels) | Speedtest des bookmarks (profil par réseau, Auto part de là, mise à jour par un vrai transfert plus rapide) ; connexion visible (étapes, chrono, CANCEL, « slow ») ; onglets BOOKMARKS / FTP MODE / LIVE SYNC MODE en haut à la place du rail ; SITES devient BOOKMARKS |
| 0.7.2 | 13/10 | 672 (+18 FTP réels) | Bookmarks LIVE SYNC dans SITES ; SESSION ID (invitation qui ne venait pas) ; l'anneau seul et icône de barre des menus ; DISCONNECT ; queue SYNCTHING qui se vide ; revue : téléchargement toujours en `.filopart`, fichier remplacé par LIVE SYNC S-FTP dans `.filo-trash`, préférences reprises du `.bak`, attente du MASTER, textes et alignements |
| 0.7.1 | 13/10 | 652 (+18 FTP réels) | Panneau local : Bureau, Téléchargements et menu des disques montés (chemins donnés par le système, toutes langues) |
| 0.7.0 | 13/10 | 650 (+18 FTP réels) | Rail latéral TRANSFER / LIVE SYNC / SITES / SETTINGS ; barre de connexion allégée ; départ de la queue à une heure ; commande après la queue (sans shell, modèle ingesto) ; vérification contre l'autre côté par checksum ; dossiers favoris par serveur ; Quick Look ; LIVE SYNC : fichier en cours dans l'anneau, PAUSE SYNCTHING, ordre alphabétique, alerte ntfy ; FINISHED puis IDLE ; notification de mise à jour comme les autres apps ; « Command line » |
| 0.6.4 | 12/10 | 608 (+18 FTP réels) | Gestionnaire de sites : vue retrouvée, clic droit (nouveau, renommer, dupliquer, supprimer), bouton NEW FOLDER, dossiers vides, ligne de dépôt droite, zone vide = racine ; dossier « LIVE SYNC » |
| 0.6.3 | 12/10 | 602 (+18 FTP réels) | Navigation synchronisée : différences surlignées (jaune : seulement ici, vert : plus récent ici), compte sous chaque panneau, filtre DIFFERENCES ONLY |
| 0.6.2 | 12/10 | 602 (+18 FTP réels) | DUAL SYNC à trois (ce qui est posé sur le NAS arrive sur les deux ordinateurs) ; couleurs des modes sur l'anneau et la file ; logo turquoise ; revue globale : le S-FTP BACKUP n'efface que ce que la session connaît, racine refusée, lecture locale stricte ; noms de serveur sans sortie du dossier ; `.filo-session` du serveur sans autorité sur sens et filtre ; bascule vers le serveur sur dossier calme ; copies retenues fiables ; noms, couleurs et détails d'interface |
| 0.6.1 | 12/10 | 586 (+18 FTP réels) | Anneau : UP TO DATE / ALL UP TO DATE à la place de IDLE ; graphes de débit (anneau et file) fluides ; MODE CLIENT / LIVE SYNC dans la barre de connexion, bouton de connexion à droite du mot de passe ; en-tête de file refait (%, barre de progression, START / STOP / balai, badges PEAK et TIME LEFT) |
| 0.6.0 | 12/10 | 586 (+18 FTP réels) | DUAL SYNC (ex SYNCTHING FAILSAFE) : S-FTP BACKUP, copie exacte du dossier du MASTER sur le serveur une fois Syncthing fini, pause quand Syncthing reprend ; file d'attente Syncthing dans le panneau de file ; menu LIVE SYNC ; filtre en puces, liste par défaut réduite ; retouches de la fenêtre des sessions et de la vue LIVE SYNC (badges, EST. TIME) |
| 0.5.0 | 12/10 | 569 (dont 62 SYNCTHING / FAILSAFE ; +18 FTP réels) | LIVE SYNC entre deux filo par Syncthing embarqué (SYNCTHING), avec failsafe par un serveur (SYNCTHING FAILSAFE) ; MASTER / SLAVE (le MASTER gagne les conflits, le SLAVE suit ses réglages) ; corbeille `.filo-trash` ; config par fichier ou SYNCTHING ID, toujours du MASTER vers le SLAVE ; nouvelle vue LIVE SYNC (anneau, flèches de sens, badge de mode) ; un seul dessin de badge ; revue de code (sécurité, failsafe, interface) ; `THIRD_PARTY_NOTICES.md` |
| 0.4.0 | 11/10 | 481 avec le moteur, 466 sans (+18 FTP réels) | Moteur Rust pour SFTP (octets, relecture, limite de débit, clés PuTTY, repli JavaScript) et dans les builds ; Auto : envoi en segments à 1 connexion au départ ; temps restant / écoulé dans l'en-tête et sur chaque fichier, horaires dans QUEUE / FAILED / DONE ; bouton de connexion icône seule ; AUTO SYNC renommée LIVE SYNC (`filo livesync`). DS920+, 21,8 Go : réception 2'12", envoi 1'53" (FileZilla 3'13" / 2'01") |
| 0.3.5 | 10/10 | 463 (+18 FTP réels) | AUTO SYNC et partage de synchro (`.filosync`), relais par segments entre deux filo, ligne de commande et POST COMMAND, déplacement par glisser, bouton NOT CONNECTED / CONNECTED ; sites à clé SSH réparés ; SFTP : profondeur de lecture sur l'aller-retour le plus court, fenêtre agrandie, requêtes de 32 Ko en réception (20 Go sur le DS920+ : envoi 2'29", réception 2'30", FileZilla 3'04" / 2'40") ; bench NAS |
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
