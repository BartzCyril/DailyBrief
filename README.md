# DailyBrief

Veille quotidienne personnelle, en TypeScript strict. Bun 1.4.2, Express 5,
React 19.3, Vite 8, Prisma 6 et PostgreSQL 17. Docker avec Compose est requis.

```sh
git clone -b main https://github.com/BartzCyril/DailyBrief.git
cd DailyBrief
cp .env.example .env
bun install --frozen-lockfile
bun run env:prepare
bun run --cwd backend playwright install --with-deps chromium
bun run services:up
bun run db:generate
bun run db:migrate
bun run dev:backend
# Dans un second terminal :
bun run dev:worker
# Dans un troisième terminal :
bun run dev:frontend
```

Le frontend utilise un proxy Vite `/api` vers Express (port 3000).
`GET /health` renvoie HTTP 200. `bun run typecheck` vérifie les deux applications,
`bun run build` construit le frontend. `bun run services:down` arrête les services
sans supprimer leurs volumes. Les valeurs de `.env.example` sont réservées au
développement local : choisissez des identifiants propres et ne versionnez jamais `.env`.

## Authentification et sources

`bun run services:up` démarre PostgreSQL et Redis. Générez un secret de session
avec `bun -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`
et placez-le dans `.env` (`SESSION_SECRET`). Le navigateur utilise un cookie
HTTP-only, SameSite=Lax ; les sessions sont stockées dans Redis. En production,
servez frontend et API sous une même origine HTTPS et configurez `NODE_ENV=production`,
`FRONTEND_ORIGIN` et le reverse proxy de confiance (un seul saut).

Les mots de passe ont au moins 12 caractères, une majuscule, une minuscule et un
chiffre. Les routes `POST /auth/register`, `/auth/login`, `/auth/logout` et
`GET /auth/me` gèrent le compte. Les routes `/sources` nécessitent une session.
`POST /sources/rss/test` attend `{url}` ; `/sources/scraping/test` attend
`{url, config}`. `POST /sources` accepte `RSS` ou `SCRAPING` avec `scrapingConfig`.
`GET /sources` liste les sources du compte ; `PATCH /sources/:id` accepte `{enabled}`
ou `{url?, scrapingConfig?}` pour modifier son adresse et sa configuration.
L'ancien champ `urlTemplate` reste accepté avec `url` pour les clients précédents.
`DELETE /sources/:id` supprime une source du compte et ses articles associés.

Le lecteur RSS/Atom normalise les espaces et BOM avant la déclaration XML ainsi
que les esperluettes et entités HTML non échappées. Les corrections apparaissent
dans l'aperçu du flux et le journal de collecte. Les liens RSS doublés par un
champ Dublin Core (`dc:link`) restent utilisables, et les descriptions/dates
Dublin Core sont prises en charge. Les balises mal fermées et les documents
tronqués restent refusés avec une ligne/colonne de diagnostic. Une page HTML
renvoyée à la place du flux a un message distinct. Les déclarations DTD et
d'entités XML sont refusées ; les CDATA et commentaires restent inchangés.

Les requêtes RSS et Playwright refusent les adresses privées (y compris IPv6),
épinglent les résultats DNS, contrôlent les redirections et limitent les réponses
à 2 Mio avant et après décompression. Le transport décode gzip, deflate, Brotli
et zstd avant de lire le texte, même si un site compresse malgré la demande
`Accept-Encoding: identity`. Il tient compte du charset HTTP, de la déclaration
XML et des BOM UTF-8/UTF-16. Les réponses compressées corrompues et les encodages
invalides ont des erreurs distinctes du XML mal formé.
Playwright bloque WebSockets, service workers et mutations HTTP. Le
scraping utilise au maximum 2 navigateurs simultanés. La pagination continue
jusqu'à une page sans article, sans plafond de pages, d'articles par page ou
d'articles au total. Une page déjà rencontrée (même si l'ordre change) arrête
la pagination avec un avertissement pour éviter une boucle. Les chevauchements
entre pages sont dédupliqués ; une erreur réseau ou un sélecteur de titre sans
résultat dans des blocs présents provoque une erreur, pas un aperçu partiel.
Une réponse HTTP 404 ou 410 sur la page demandée après des pages ayant fourni des
articles termine la pagination avec un avertissement et conserve les résultats.
Une erreur sur la première page, une redirection vers une autre page absente ou
un autre statut HTTP reste un échec. Le message précise le statut et l'URL en erreur.
Les anciens `maxPages` enregistrés sont acceptés puis ignorés ; aucune migration
de base n'est nécessaire. La page de départ peut être 0 selon le site.
Chaque navigation garde son délai de 15 secondes ; la durée totale de pagination
n'est pas plafonnée. Le mode scroll conserve ses 8 scrolls et ses 45 secondes.
Le mode « Bouton charger plus » (`LOAD_MORE`) attend un sélecteur CSS de bouton
et un délai maximum de chargement par clic (1 à 60 secondes, 15 secondes par défaut).
Exemple : `loadMore: { buttonSelector: ".load-more", waitTimeoutMs: 15000 }`.
Il clique sans limite de nombre jusqu'à disparition ou désactivation du bouton,
en conservant et dédupliquant les articles même si le site remplace la liste.
Après chaque clic, il attend la fin des requêtes AJAX, la stabilisation des articles
et la libération du bouton (`fetching`, `loading`, `is-loading`, `aria-busy` ou
`data-loading`). Un thème peut maintenir ce verrou après l’affichage des articles :
le clic suivant attend alors que le bouton soit disponible.
Si aucun nouvel article n'apparaît dans le délai, il s'arrête avec un avertissement
et conserve les résultats. Un bouton absent dès le départ est également signalé.
Les chargements JavaScript/AJAX sont pris en charge, y compris les requêtes POST
sur le même site ; les requêtes et redirections conservent la validation des adresses
publiques. Les POST vers un autre site sont bloqués ; une requête annexe, comme une
mesure d'audience, ne fait pas échouer la collecte. Si aucun article n'apparaît
après le clic, les résultats précédents sont conservés et un avertissement décrit
l'absence de progrès. Le diagnostic précise si aucune requête AJAX vers le site
n'a été observée, les éventuelles erreurs JavaScript et les POST externes bloqués,
sans attribuer automatiquement l'arrêt à ces services annexes. Les erreurs de
chargement AJAX restent des échecs de collecte.
Seuls des sites accessibles sans connexion sont pris en charge.

Installez Chromium avec `bun run browser:install`. Si le CDN Playwright est
indisponible, `bun run browser:prepare` extrait la distribution npm Chromium ;
configurez `CHROMIUM_EXECUTABLE_PATH` avec le chemin affiché. Le fallback contient
uniquement le navigateur ; une machine Linux doit également disposer de ses
bibliothèques système. Aucun contrôle TLS ou checksum n'est désactivé.

Les migrations SQL Prisma sont versionnées. `bun run db:migrate` les applique
transactionnellement via pg, vérifie leurs checksums et utilise un verrou
PostgreSQL ; les métadonnées restent compatibles avec `_prisma_migrations`.
Le moteur JS et l'adaptateur pg évitent les téléchargements natifs dans le cloud.
Pour produire une nouvelle migration, utilisez `prisma migrate diff` entre les
schémas et conservez le SQL dans `backend/prisma/migrations/<timestamp>_<nom>/migration.sql`.

`bun run test` crée la base dédiée si elle n'existe pas, puis applique les migrations.
`TEST_DATABASE_URL` doit se terminer par `_test` ; son compte doit pouvoir créer
cette base de développement. Les tests créent et retirent
leurs propres comptes. Les tests de scraping utilisent de vraies pages Chromium
avec un transport contrôlé, jamais des sites publics instables.

## Collecte, IA et newsletter

L'heure quotidienne (`HH:mm`) et le fuseau IANA sont configurés via
`GET/PATCH /settings/dailybrief`. Le scheduler vérifie les échéances chaque minute.
Les heures absentes au printemps sont décalées vers l'avant ; les heures
doubles à l'automne s'exécutent une seule fois à leur première occurrence.
Le déclenchement manuel conserve la prochaine échéance quotidienne.
Un verrou Redis avec renouvellement et libération conditionnelle protège chaque compte.

```sh
docker compose up -d --wait ollama
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama pull qwen3:4b
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama list
# Réception locale des emails, sans destinataire externe :
docker compose --profile mail up -d mailpit
```

`OLLAMA_MODEL` permet de changer de modèle. Le défaut `qwen3:4b` nécessite
environ 3 Gio pour le modèle et plusieurs Gio de RAM ; le calcul CPU peut être
lent. `OLLAMA_BASE_URL` vaut `http://ollama:11434` depuis un conteneur du même
réseau, ou `http://127.0.0.1:11434` depuis Bun sur l'hôte.
`GET /ai/health` distingue disponibilité, modèle absent et timeout ;
`POST /ai/summarize/test` accepte `{title,content,url?}` et renvoie
`{title,summary,keyPoints}`. L'IA utilise du JSON validé, des entrées nettoyées,
un timeout et une concurrence limitée. `AI_MAX_INPUT_CHARS` borne chaque portion
envoyée au modèle : les articles plus longs sont découpés, résumés par portion,
puis synthétisés. La fin du texte n'est pas supprimée silencieusement. Un échec
d'une portion ou de la synthèse empêche la livraison d'un résumé partiel.
Les valeurs par défaut sont `AI_MAX_INPUT_CHARS=16000` et
`OLLAMA_TIMEOUT_MS=1800000` (30 minutes par génération, chargement du modèle compris).
Le délai d'inactivité HTTP propre à Bun est désactivé pour ces requêtes ; le
signal d'annulation conserve la limite configurée, y compris durant la lecture
de la réponse.
Un article de 10 000 caractères est donc envoyé en une seule portion. Le champ
`summary` accepte jusqu'à 12 000 caractères ; cette limite est transmise au modèle
dans le schéma JSON et vérifiée sur sa réponse. Une réponse trop longue est
signalée, jamais coupée silencieusement. Une limite supérieure autorise une
réponse plus détaillée sans imposer au modèle de la remplir.
Le journal indique la taille de chaque portion, l'attente toutes les 15 secondes
et la durée de chaque génération. Ces messages d'attente ne signifient pas
qu'Ollama a déjà produit du texte. Sur une machine lente, diminuez la taille
des portions ou augmentez le délai ; cela ne garantit pas un traitement plus rapide.
Après mise à jour d'une installation existante, passez `OLLAMA_TIMEOUT_MS` à
`1800000` dans votre `.env` puis redémarrez le backend : les valeurs explicites existantes
restent prioritaires sur les nouveaux défauts.
Les tests mockent Ollama : aucun téléchargement de modèle n'est nécessaire pour eux.
Les résumés demandent explicitement `think: false` afin que Qwen3 fournisse
directement le JSON final. Un contenu de raisonnement seul ne sert jamais de résumé.
Les réponses vides, interrompues par la limite de génération ou mal formatées sont
signalées séparément dans le journal de collecte ; les articles restent réessayables.

`POST /collection/run` et le scheduler mettent la collecte dans la même queue Redis. GUID, URL
canonique sans tracking et hash détectent les doublons. Le fingerprint déterministe
identifie les articles connus ; les relations vers les newsletters envoyées
déterminent ceux déjà livrés. Avant le résumé, la page liée de chaque article
est téléchargée via le transport HTTP protégé, puis Mozilla Readability extrait
le texte principal ; les métadonnées JSON-LD `articleBody` sont également prises
en charge. Navigation, publicités et scripts sont retirés du texte envoyé à l'IA.
Les zones de texte d'article balisées et les panneaux repliés qu'un lecteur peut
ouvrir sont conservés. Un lien manquant, une page protégée,
un texte de moins de 200 caractères ou de plus de 200 000 caractères produit une
erreur explicite ; la description du flux ne sert pas de remplacement silencieux.

Si la requête HTTP est refusée avec un code 403, si le HTML ne contient pas de texte
exploitable ou renvoie une redirection JavaScript, Chromium charge directement l'URL
dans un contexte neuf, exécute ses scripts
et conserve les cookies de cette visite avant l'extraction du HTML rendu.
Ce recours apparaît dans le journal en direct. Le contexte et ses cookies sont
supprimés après l'article ; aucun cookie de connexion DailyBrief n'est transmis.
Le navigateur parcourt la page puis attend la stabilisation du texte, dans une
fenêtre bornée à 8 secondes, pour inclure les sections chargées après l'introduction.
Les articles Drupal composés de blocs de paragraphes (comme sur Vie publique)
réunissent les titres, le chapeau, l'historique et tous les corps de texte dans
l'ordre de la page ; les cartes de contenus associés sont exclues. Le journal
indique le nombre de blocs réunis et la taille du texte envoyé à l'IA.
Pour retester un article déjà enregistré, utilisez « Tester le workflow de A à Z » :
ce test recharge sa page au lieu de réutiliser le texte ou le résumé en base.
Installez le navigateur avec `bun run browser:install` (ou préparez-le avec
`bun run browser:prepare` et `CHROMIUM_EXECUTABLE_PATH` dans le cloud).

Les connexions du navigateur passent par un relais TCP temporaire qui vérifie les
destinations publiques et fixe leur adresse IP ; Chromium réalise lui-même les
requêtes HTTP et HTTPS. Les requêtes et leurs redirections sont contrôlées avant
l'envoi, y compris le domaine du journal lorsqu'il est imposé. Les adresses privées,
WebSockets, service workers et mutations HTTP restent bloqués. Le recours
est borné à 45 secondes, 8 navigations, 2 navigateurs simultanés et 2 Mio de HTML
rendu. Une protection CAPTCHA ou un refus persistant du site reste une erreur
explicite ; le navigateur ne garantit pas l'accès à toutes les pages publiques.

`Article.content` contient le texte extrait après succès ; `contentFetchedAt`
marque sa récupération et `contentError` conserve les erreurs. Le hash de
déduplication reste celui de l'entrée collectée pour conserver son identité.
Le texte est réutilisé après une panne IA ou SMTP. Les articles déjà envoyés
restent exclus. Les anciens résumés d'articles non livrés dont le texte complet
n'a pas encore été récupéré sont régénérés à partir de leur page.
Appliquez la migration et régénérez le client après mise à jour :

```sh
bun install --frozen-lockfile
bun run db:generate
bun run db:migrate
```

Les échecs de téléchargement et les échecs IA sont conservés et exclus du mail ;
ils peuvent être retentés. Les résumés sont persistés avant l'envoi SMTP.
Un échec SMTP laisse la newsletter `FAILED` et les articles réutilisables sans
nouvelle génération IA. Aucun email vide n'est envoyé.

Le bouton « Récupérer maintenant » affiche un journal en direct : récupération de
chaque source, nombre d'articles, sauvegarde et doublons, téléchargement de la
page de chaque article et nombre de caractères extraits, portions envoyées à
Ollama et résultat du résumé, préparation de la newsletter et envoi SMTP.
Les erreurs identifient l'étape qui échoue, notamment l'absence d'Ollama ou du
modèle configuré. Les URLs des sources sont affichées par hôte pour préserver les
paramètres privés. Une panne d'Ollama est visible sur les jobs concernés ; les
articles sont conservés pour une nouvelle tentative.

### Queue Redis et consommateurs

L'API répond immédiatement avec HTTP **202** et l'identifiant de la collecte.
Le processus `bun run dev:worker` récupère les sources, enregistre les entrées,
puis crée **un job `scraping-summary` par article restant à traiter**, RSS comme
scraping. Par exemple, 10 articles uniques dans la première source et 5 dans la
seconde créent 15 jobs. Les doublons et les articles déjà envoyés ne créent pas de
nouveaux jobs. Les articles anciens encore en attente sont également repris.
Le worker extrait le contenu complet, appelle l'IA si aucun résumé valide n'est
déjà sauvegardé et enregistre le résultat en PostgreSQL. Les journaux désactivés
restent recensés ; leurs jobs sont indiqués comme ignorés sans extraction ni IA.
La newsletter est préparée une fois les jobs terminés, avec les articles autorisés
et résumés avec succès. Les tests « A à Z » gardent leur fonctionnement indépendant.

L'organisation reprend le gestionnaire et les consommateurs des exemples fournis,
adaptés à **BullMQ** : `backend/src/queue/jobs-manager.ts`, `consumers.ts` et
`scraping-summary.ts`. API et workers peuvent être démarrés séparément. Le worker
ne lance pas le scheduler ; celui de l'API dépose les collectes quotidiennes.
Une collecte active par utilisateur est autorisée, même après rechargement ou
lorsqu'une collecte manuelle et le scheduler se déclenchent simultanément.

La bannière **« Récupération en cours »** apparaît sur toutes les pages connectées.
Elle affiche le nombre d'articles traités et une barre de progression, puis reste
visible pendant la préparation et l'envoi. Le suivi interroge Redis via l'API ;
fermer ou recharger la page ne supprime pas les jobs. La page
**[http://localhost:5173/jobs](http://localhost:5173/jobs)** présente les 20 dernières
collectes et leurs jobs, paginés par 10 : état, tentatives, étape et erreur.
Chaque utilisateur accède uniquement à ses propres collectes et articles.
Les endpoints sont `GET /collection/current`, `/collection/runs`,
`/collection/runs/:id` et `/collection/runs/:id/jobs?page=1`.

Les jobs et leurs événements sont conservés 30 jours dans Redis ; les 100 derniers
événements de chaque collecte sont affichés. Le bilan reste en PostgreSQL après
expiration. Redis utilise déjà AOF et un volume persistant dans Compose : ne
supprimez pas `redis_data` pour conserver les queues après redémarrage.
Les jobs interrompus sont repris par BullMQ après expiration de leur verrou.
Si l’API s’interrompt entre la sauvegarde de la collecte et sa mise en file, le
scheduler restaure le job au redémarrage ou à son prochain passage (60 secondes),
sans créer une seconde collecte. Ce contrôle respecte `QUEUE_PREFIX`.
Un contenu ou résumé déjà sauvegardé est réutilisé. Les erreurs transitoires sont
retentées jusqu'à trois fois, avec délais de 5 puis 10 secondes ; les erreurs
permanentes telles qu'un modèle manquant restent visibles. « Récupérer maintenant »
permet de lancer une nouvelle collecte pour les articles encore non envoyés.
Un envoi SMTP au résultat incertain reste `SENDING` et n'est pas renvoyé
automatiquement : vérifiez sa réception avant toute réconciliation manuelle.

Après mise à jour, depuis la racine du projet sous Windows/PowerShell :

```powershell
git pull origin main
bun install --frozen-lockfile
bun run services:up
bun run db:generate
bun run db:migrate
bun run browser:install
```

Lancez ensuite **trois terminaux**, tous dans le projet :

```powershell
bun run dev:backend
```

```powershell
bun run dev:worker
```

```powershell
bun run dev:frontend
```

En production, le consommateur utilise `bun run start:worker`. Sans worker, les
collectes restent en attente et la bannière l'indique.

Dans `.env`, aucune nouvelle clé secrète n'est nécessaire. Vérifiez `REDIS_URL`
(`redis://127.0.0.1:6379` en local) et utilisez les mêmes variables pour l'API et le
worker : `DATABASE_URL`, `JOURNAL_ENCRYPTION_KEY`, les réglages Ollama et SMTP.
Les nouvelles options facultatives sont `QUEUE_PREFIX=dailybrief` (identique dans
les deux processus) et `COLLECTION_CONCURRENCY=2`. Gardez **`AI_CONCURRENCY=1`**
pour ne traiter qu'un article à la fois sur votre machine ; cette limite est
appliquée à la queue même avec plusieurs workers. La queue déplace le traitement
hors de l'API et régule la charge ; elle ne rend pas le modèle Ollama plus rapide.
Les contenus d'articles, mots de passe et cookies ne figurent pas dans les données
des jobs : les consommateurs lisent les données et accès protégés côté serveur.

### Modifier une source

La navigation commune propose « Tableau de bord », « Sources » (`/sources`) et
« Journaux » (`/journals`). Le tableau de bord conserve les statistiques et les
réglages de collecte ; chaque page de configuration se charge indépendamment.

La page « Sources » sépare les flux RSS et les sites de scraping en deux onglets.
Chaque tableau affiche au plus cinq sources par page, avec recherche par URL et
filtre sur les sources actives ou inactives. Les URL ouvrent directement le site,
les points verts et rouges indiquent le statut, et les actions utilisent des icônes
avec infobulles. Le bouton d'ajout et le retour après création suivent le type de source.

Dans « Sources », le bouton « Modifier » ouvre une modale avec les mêmes champs que la création,
préremplis avec les valeurs enregistrées : URL pour un flux RSS ; URL, sélecteurs
d'articles, de titre, de lien, de description et de date, mode de récupération,
paramètres de scroll, de pagination ou du bouton de chargement pour une source de scraping.
« Tester » affiche un aperçu sans modifier la source ni enregistrer d'articles.
Une modification invalide l'aperçu. À la création comme à l'édition, l'enregistrement
vérifie uniquement la première page configurée (le numéro de départ en pagination),
sans parcourir les pages suivantes, effectuer de scroll supplémentaire ou cliquer sur le bouton.
Les sélecteurs et l'accès réseau restent vérifiés. « Tester », le workflow de A à Z
et la collecte continuent à parcourir toutes les pages, effectuer les scrolls configurés
ou cliquer sur le bouton jusqu'à la fin des articles.
Une erreur de récupération ou une adresse déjà utilisée laisse la source existante
inchangée. « Annuler » ferme le formulaire sans enregistrer.

L'identifiant, les articles existants et l'état actif ou inactif sont conservés.
Les sélecteurs de description et de date sont obligatoires lors de la création,
du test de configuration et de la modification d'une source de scraping, au même titre
que ceux des articles, du titre et du lien. Le formulaire et l'API refusent les champs
absents, vides ou constitués uniquement d'espaces. Les anciennes configurations restent
lisibles pour la collecte et le workflow ; complétez-les avant de modifier leur URL
ou leurs réglages. Le mode de récupération peut être changé.
Pour une pagination par modèle d'URL, conservez `{page}`. Son préfixe suit l'URL de départ
si le modèle utilise cette adresse et n'a pas été modifié manuellement.
Seul le propriétaire de la source peut la modifier.

Les actions « Modifier » (crayon) et « Supprimer » (corbeille) sont des icônes avec
un libellé accessible et une infobulle. La corbeille ouvre une fenêtre de confirmation
qui nomme le type : « Êtes-vous sûr de vouloir supprimer ce flux RSS ? » ou
« cette source de scraping ? ». La suppression efface aussi ses articles et résumés associés. Les autres
sources et les newsletters restent conservées. L'interrupteur d'activation affiche
un curseur pointeur lorsqu'il est disponible.

### Aide automatique pour les sélecteurs

À la création ou à la modification d'une source, renseignez son adresse puis cliquez
sur « Remplir avec l'IA ». Pour un flux RSS avec lien intermédiaire, l'analyse ouvre
une notice du flux pour chercher le lien vers le journal. Pour le scraping, elle
propose les cinq sélecteurs obligatoires (articles, titre, lien, description et date)
et le mode de chargement lorsqu'ils sont identifiables. Si la description ou la date
ne peut pas être identifiée, l'analyse propose une aide humaine sans inventer de sélecteur.
Les résultats remplissent
le formulaire sans l'enregistrer : vérifiez-les puis utilisez « Tester » avant de sauvegarder.
Une modification de l'adresse invalide les résultats. « Annuler l'analyse » interrompt
la requête IA ; fermer le formulaire l'interrompt également.

Dans la configuration d'accès d'un journal, le même bouton analyse l'adresse du
formulaire de connexion, ou cherche un lien de connexion sur la page publique du
journal. Il propose les champs d'identifiant et de mot de passe et le bouton d'envoi.
L'analyse ne soumet pas le formulaire et ne reçoit pas vos identifiants. Le sélecteur
confirmant une connexion réussie doit être vérifié après connexion ; l'IA ne peut
pas le déduire de la page publique. Les champs déjà renseignés restent conservés.

Les sélecteurs proposés sont contrôlés sur la page chargée dans Chromium : un
résultat ambigu, masqué ou absent est refusé. L'IA reçoit une structure de page
limitée, sans scripts, valeurs des champs ni paramètres d'URL privés, avec des
instructions pour traiter cette structure comme des données et éviter les sélecteurs
inventés. L'analyse ne clique sur aucun bouton, ne se connecte pas et ne parcourt pas les pages suivantes.
Les sites bloqués par un CAPTCHA ou imposant une interaction peuvent nécessiter une aide manuelle.
Une iframe publicitaire indisponible ne bloque pas l'analyse de la page principale.
Chromium charge directement l'URL avec `page.goto()`, exécute JavaScript et conserve
les cookies pendant cette analyse, puis le serveur lit le HTML rendu avec `page.content()`.
La page n'est pas téléchargée à l'avance par le client HTTP du serveur. Chromium
gère lui-même HTTPS, les redirections, les cookies, la compression et les encodages
HTML. Le conteneur `#main` est également reconnu pour donner la priorité aux articles
plutôt qu'aux longs menus. Les sessions sont temporaires et isolées entre analyses.
Le scraping public et le rendu navigateur des articles utilisent le même chargement
natif ; les appels HTTP des flux RSS conservent leur fonctionnement.

Un relais TCP local, propre à chaque navigateur, résout et vérifie les destinations
publiques puis fixe leur adresse IP. Il transmet les octets sans lire ni reconstruire
les requêtes HTTP ou les connexions TLS de Chromium. Les adresses privées sont
bloquées également lors des redirections, avec des limites de taille et de durée.
L'analyse ne soumet aucun formulaire. Les erreurs précisent le refus HTTP,
le problème DNS ou HTTPS et le délai dépassé.

Pour diagnostiquer une page depuis la machine qui exécute le backend :

```bash
bun run diagnose:page "https://www.lemondeinformatique.fr/le-monde-du-cloud-computing-8.html"
```

La commande compare une requête HTTP du serveur à une navigation native de
Chromium, utilisée par l'analyse. Les deux chargements sont indépendants : un refus
HTTP du serveur n'empêche pas de tester le navigateur. Elle affiche uniquement
les statuts et les catégories d'erreur, sans
HTML ni cookies, et n'appelle ni l'IA ni SMTP. Un code HTTP 403 signifie que la
requête du backend a été refusée : un accès réussi dans un autre navigateur ou
avec `curl` ne garantit pas que le site accepte cette requête.
Le statut final de la commande dépend de Chromium ; un échec du client HTTP
simple reste informatif si le navigateur charge correctement la page.

Si l'analyse échoue ou reste incomplète, « Envoyer une demande d'aide » permet
d'envoyer un email à l'adresse configurée dans `SMTP_USER`. Aucun email n'est
envoyé automatiquement. Le message indique le type de configuration, le site,
la notice réellement analysée pour un RSS et les informations restant à trouver.
L'adresse du compte sert de `Reply-To`. Les mots de passe, cookies, contenu HTML,
prompts IA et paramètres privés des URL ne sont jamais inclus.

Les demandes sont isolées par utilisateur et expirent après une heure. Un deuxième
clic sur une demande déjà envoyée ne renvoie pas le mail. Après un refus SMTP
explicite, une nouvelle tentative est possible ; une livraison incertaine bloque
le renvoi de cette demande pour éviter les doublons. L'API limite chaque compte à
10 analyses et 5 demandes d'aide par période de 15 minutes.

Cette fonctionnalité utilise les réglages existants `OLLAMA_BASE_URL`, `OLLAMA_MODEL`,
`OLLAMA_TIMEOUT_MS`, `AI_MAX_INPUT_CHARS` et `SMTP_*`. Préparez Chromium avec
`bun run browser:install` (ou `bun run browser:prepare`). Conservez une limite
`AI_MAX_INPUT_CHARS` suffisante, par exemple `16000`. `SMTP_USER` doit être une
adresse email valide pour recevoir l'aide, même lorsque le serveur SMTP local
n'exige pas d'authentification. Si votre serveur demande un identifiant qui n'est
pas une adresse email, l'envoi d'aide affiche une erreur de configuration.
Redémarrez le backend après avoir modifié `.env`.

Les routes authentifiées sont `POST /ai/selectors/analyze` avec `{kind, url}`
(`SCRAPING`, `RSS_LINK` ou `JOURNAL_LOGIN`) et `POST /ai/selectors/help` avec
`{helpRequestId}`. Le destinataire et le contenu du mail sont déterminés côté serveur.

### Tester une source de A à Z

Dans la liste des sources, « Tester le workflow de A à Z » ouvre une liste
fraîche des articles RSS ou scraping, y compris ceux déjà résumés ou livrés.
Les sources désactivées peuvent aussi être testées. Tous les résultats du
collecteur sont affichés : le RSS direct conserve sa limite de 500 entrées, tandis que
le scraping paginé parcourt la source jusqu'à une page vide ou répétée.
« Faire le résumé avec l'IA » télécharge à nouveau la page
de l'article, affiche les étapes en direct, puis son titre IA, son résumé,
ses points clés et le texte extrait consultable. Chaque résumé peut être
relancé ; « Récupérer à nouveau les articles » recharge la source.

Ce parcours utilise un aperçu temporaire Redis de 30 minutes, isolé par compte
et source. Il ne modifie pas les articles, les résumés ou l'historique du pipeline
et n'envoie aucun email. Les erreurs restent visibles sur l'article concerné.
L'IA et le téléchargement ont les mêmes protections et limites que le pipeline.
Le recours navigateur prend en charge JavaScript et les cookies de visite.
Les pages imposant une connexion, un abonnement ou une protection interactive
ne sont pas garanties lisibles et peuvent nécessiter une autre source.

`POST /sources/:sourceId/workflow` crée l'aperçu. Le résumé utilise
`POST /sources/:sourceId/workflow/:workflowId/articles/:index/summarize` et un
flux NDJSON de progression/résultat. Les deux endpoints exigent une session
et la propriété de la source ; le client ne peut pas remplacer l'URL sélectionnée
dans l'aperçu. Plusieurs onglets peuvent conserver leurs aperçus indépendants.

SMTP se configure dans `.env`. Le destinataire d'une newsletter provient exclusivement de
`User.email` ; les demandes d'aide pour les sélecteurs sont adressées à `SMTP_USER`.
Mailpit utilise les valeurs locales proposées et permet de consulter
les messages sur le port 8025. Le template fournit HTML échappé et texte brut.
Pour un serveur SMTP réel, utilisez vos identifiants et `SMTP_SECURE` conformément
à sa configuration ; ne désactivez pas la vérification TLS.

SMTP et PostgreSQL ne partagent pas de transaction : un crash après acceptation
du mail peut laisser la newsletter `SENDING`. Ces articles ne sont pas renvoyés
automatiquement. Vérifiez la livraison auprès du serveur SMTP avant de corriger
le statut en base (`SENT` si livré, `FAILED` si non livré). Une réponse SMTP
ambiguë exige également cette vérification. Le `Message-ID` contient l'identifiant
de newsletter pour faciliter le diagnostic ; il ne garantit pas la déduplication
par tous les serveurs de réception.

## Interface et validation

Les composants génériques viennent de **shadcn/ui** (style new-york, Tailwind 4,
Radix). Ajoutez des composants via la configuration `frontend/components.json` ;
réutilisez `frontend/src/components/ui` et gardez les compositions métier dans
leurs dossiers. Les pages sont chargées à la demande. Les cookies sont transmis
avec chaque appel API ; aucun token n'est conservé dans le stockage du navigateur.

```sh
bun run format:check
bun run typecheck
bun run test
bun run build
bun run test:e2e
```

Le test navigateur parcourt inscription, connexion, ajout RSS, scraping Chromium,
aide IA pour les trois types de configuration, demande d'aide après erreur ou
résultat incomplet, réglages, collecte, prévention d'un second envoi, affichage
mobile et déconnexion.
Il utilise PostgreSQL/Redis réels et des transports contrôlés pour les sites,
l'IA et Nodemailer. Il n'envoie aucun email externe. Les tests unitaires vérifient
aussi les erreurs, l'isolation des utilisateurs, les verrous, les changements
d'heure et les nouvelles tentatives SMTP. La CI exécute ces mêmes vérifications.

Dans le cloud, autorisez `registry.ollama.ai` et les hôtes de téléchargement
retournés par le registre pour télécharger un modèle. Le navigateur de secours
peut être préparé depuis npm lorsque le CDN Playwright est inaccessible.
Le fonctionnement avec un vrai modèle et un serveur SMTP réel doit être vérifié
avec vos paramètres ; les transports de test ne constituent pas cette validation.

### Flux RSS avec une page intermédiaire

Un item RSS peut pointer vers une notice de bibliothèque plutôt que vers l'article
original. À la création ou à l'édition du flux, renseignez le champ facultatif
« Sélecteur du lien vers l'article ». Pour les notices de bibliotheques.inp.fr,
utilisez `a.accessToPrimaryDoc.primarydoc`, qui cible « Consulter le document ».

Lors du résumé, DailyBrief télécharge la notice, récupère le `href` du lien choisi,
puis extrait le texte complet de cette page cible avant de l'envoyer à l'IA. Le
journal affiche les deux étapes. Les liens relatifs et les liens ajoutés en
JavaScript sont pris en charge. Un lien absent, ambigu ou invalide provoque une
erreur explicite ; la notice n'est pas utilisée à sa place. Le suivi est limité à
un lien configuré et les destinations gardent la validation des adresses publiques.

Le champ `articleLinkSelector` est facultatif sur `POST /sources/rss/test`,
`POST /sources` pour le type `RSS` et `PATCH /sources/:id`. Une valeur `null` le
désactive. Tester ou enregistrer le flux vérifie le RSS et la syntaxe du sélecteur ;
les notices sont chargées dès la récupération du workflow ou de la collecte pour
recenser leurs liens externes ; les pages des journaux ne sont chargées qu'après activation.

L'URL de la notice et le GUID restent utilisés pour identifier les doublons.
L'URL réellement résumée est sauvegardée dans `Article.contentUrl` et utilisée
dans la newsletter et le résultat du workflow. Le sélecteur utilisé est enregistré
dans `Article.contentLinkSelector` : un changement force une nouvelle extraction
et un nouveau résumé pour les articles encore en attente, sans modifier les
newsletters déjà envoyées.

Après récupération de cette version, générez le client et appliquez la migration
additive avant de redémarrer le backend :

```bash
bun run db:generate
bun run db:migrate
bun run dev:backend
```

### Journaux des RSS avec sélecteur

« Tester le workflow de A à Z » résout les notices de tous les items du flux,
y compris ceux déjà enregistrés ou livrés, avant tout appel à l'IA. Les items
répétés (GUID, sinon URL de notice) sont comptés une seule fois. Le tableau affiche
les hôtes externes et leurs comptes pour cet aperçu, par nombre décroissant puis
par ordre alphabétique. Les notices en erreur restent affichées séparément ; elles
ne suppriment pas les autres résultats. Le lien de lecture pointe vers le journal,
et l'URL de notice reste conservée pour l'identité de l'article.

La table `JournalAccess` conserve les réglages par utilisateur, avec une unicité
`(userId, domain)`. Les nouveaux journaux sont désactivés. Leur activation et leurs
identifiants persistent entre sources et aperçus. Un hôte est normalisé en minuscules,
sans point terminal. **`lemonde.fr` et `www.lemonde.fr` restent distincts**, sans
partage de statut ou de secret. Les redirections vers un autre hôte lors de la lecture
sont refusées. Les journaux désactivés sont recensés mais exclus de l'extraction,
de l'IA et de la newsletter, y compris pour les articles en attente déjà résumés.
La collecte manuelle et programmée applique les mêmes règles. Le recensement du
workflow n'écrit ni articles, ni résumés, ni newsletters et n'envoie aucun email.
Les RSS directs et le scraping ne passent pas par ces réglages.

La page **« Journaux »** affiche **« Vos journaux »**, avec ajout, activation,
configuration de l'accès, modification du domaine et suppression. L'ajout, la
modification du domaine et la configuration de l'accès s'ouvrent dans des modales,
y compris pour l'accès depuis le workflow. Échap ou « Annuler » ferme sans enregistrer,
puis le focus revient au bouton d'ouverture. Les champs et les actions sont espacés,
et les longues modales défilent sur mobile. Chaque suppression (journal, formulaire
de connexion ou identifiants) demande une confirmation précisant le type et le domaine.
Une erreur reste visible dans la fenêtre de confirmation et permet de réessayer. `GET /journals`
retourne uniquement les réglages du propriétaire et leurs comptes. Ces comptes
additionnent le dernier recensement enregistré de chaque RSS avec sélecteur, issu
du workflow ou d'une collecte. Chaque recensement remplace le précédent pour sa
source ; les données sont conservées dans `Source.journalInventory`, séparément
des articles et résumés. Les sources supprimées ou dont l'URL ou le sélecteur a
changé sont exclues des comptes jusqu'à un nouveau recensement. Les notices non
résolues sont signalées séparément. Charger la page des journaux ne récupère pas de
flux, ne lance pas d'IA et n'envoie pas d'email.

`POST /journals` accepte `{ "domain": "www.lemonde.fr" }` et crée une configuration
désactivée. Une URL HTTP(S) peut être fournie : seul son hôte normalisé est conservé.
Les doublons par utilisateur sont refusés. `DELETE /journals/:domain` supprime les
réglages et les identifiants du journal, en conservant les articles et newsletters.
Si le domaine réapparaît dans un flux, il est recréé désactivé. Pour le conserver
durablement dans la liste en ignorant ses articles, utilisez la désactivation.

`PATCH /journals/:domain` nécessite la session du propriétaire et un domaine déjà
enregistré. Il accepte `enabled`, `email`, `password`, `clearCredentials: true` et
`loginConfig` (ou `null` pour supprimer seulement le formulaire).
Un corps contenant uniquement `domain` permet de corriger le domaine. Un changement
d'hôte désactive le journal et efface les identifiants et le formulaire : aucun
secret ou accès n'est transféré implicitement à un autre site. Une correction de
casse ou du point terminal conserve les réglages du même hôte. Un conflit avec un
autre journal déjà enregistré est refusé sans modifier l'accès existant.
L'email et le mot de passe peuvent être configurés seulement après activation.
Un mot de passe vide conserve le secret ; changer l'email d'un accès existant exige
un nouveau mot de passe. La suppression explicite efface email et secret, même si
le journal est désactivé. L'API ne retourne que le domaine, son statut, l'email,
`hasCredentials`, `authenticationSupported` et la configuration du formulaire,
jamais le secret chiffré ou en clair. La configuration ne prouve pas une connexion réussie.

Le chiffrement serveur utilise AES-256-GCM, un nonce aléatoire et des données
authentifiées liées à l'utilisateur et au domaine. Configurez une clé stable de
32 octets en hexadécimal via **`JOURNAL_ENCRYPTION_KEY`**, hors de la base, dans le
gestionnaire de secrets du déploiement. `bun run env:prepare` génère une clé pour
le développement local et préserve une clé existante dans le fichier `.env` ignoré,
avec permissions 0600. Sans clé, l'enregistrement des mots de passe est refusé ;
le recensement et l'accès public restent utilisables. Conservez la clé avec une
sauvegarde protégée : la remplacer sans migration rend les secrets existants illisibles.
Les mots de passe ne sont placés ni dans les logs, ni dans Redis, ni dans les prompts.

Le formulaire « Configurer l'accès » accepte une **URL HTTPS** de connexion et les
sélecteurs CSS des champs email et mot de passe, du bouton de connexion et d'un
élément visible après connexion (par exemple le menu du compte). Ce dernier doit
être absent ou masqué avant connexion. Les sélecteurs doivent désigner un seul
élément visible. Le champ de mot de passe doit être de type `password` ; les
formulaires GET sont refusés afin de ne pas mettre le secret dans une URL.

Un sélecteur facultatif désigne la zone du contenu intégral de l'article. Il est
nécessaire pour les pages dont les métadonnées indiquent un accès réservé : la
connexion au compte ne garantit pas que l'abonnement autorise la lecture. Un paywall
visible, une session expirée ou une zone absente empêche l'extraction et l'IA.
La détection générique ne garantit pas la reconnaissance de toutes les protections
propres aux journaux ; choisissez précisément la zone du texte complet.

« Tester la connexion » appelle `POST /journals/:domain/test` avec `{}`. L'endpoint
est réservé au propriétaire, vérifie le marqueur de réussite et ferme la session de
test sans lire d'article, modifier la collecte ou envoyer d'email. Son résultat est
temporaire. Le workflow et le pipeline ouvrent chacun un nouveau contexte Chromium,
se connectent puis lisent l'article **dans le même contexte et avec ses cookies**.
Les cookies ne sont jamais enregistrés en base, dans Redis ou sur disque ; le
contexte est fermé après chaque opération et isolé entre utilisateurs et journaux.

Les identifiants sont envoyés uniquement par POST à l'origine HTTPS de l'URL de
connexion configurée. Les navigations sont limitées à cette origine et à l'origine
HTTPS du journal ; les autres redirections sont refusées. Un formulaire hébergé sur
un sous-domaine ou un fournisseur externe peut donc être déclaré explicitement.
Les requêtes gardent la validation des adresses publiques, l'épinglage DNS, les
limites de taille et la vérification TLS. Les destinations supplémentaires, les
CAPTCHA, la double authentification et les formulaires à plusieurs étapes ne sont
pas automatisés. Aucun contournement de protection n'est tenté.

Un accès ayant des identifiants mais aucun formulaire configuré reste refusé avec
`JOURNAL_AUTH_UNSUPPORTED`. Un journal public activé sans identifiants conserve la
lecture publique habituelle. Toute modification des identifiants ou du formulaire
invalide le contenu et le résumé réutilisables des articles encore en attente, via
`Article.contentAccessVersion`, sans modifier les newsletters déjà envoyées.
Après mise à jour, exécutez `bun run db:generate`, `bun run db:migrate` puis
redémarrez le backend. Aucune nouvelle variable d'environnement n'est nécessaire :
conservez `JOURNAL_ENCRYPTION_KEY` et assurez-vous que Chromium est installé.
