# DailyBrief

Veille quotidienne personnelle, en TypeScript strict. Bun 1.4.2, Express 5,
React 19.3, Vite 8, Prisma 6 et PostgreSQL 17. Docker avec Compose est requis.

```sh
git clone -b main https://github.com/BartzCyril/DailyBrief.git
cd DailyBrief
cp .env.example .env
bun install --frozen-lockfile
bun run env:prepare
bun run browser:install
bun run services:up
bun run db:generate
bun run db:migrate
npm run dev
```

`npm run dev` lance uniquement le backend, le frontend et les consumers dans
**un seul terminal**. Chaque ligne porte un préfixe coloré : `[BACK]` en cyan,
`[FRONT]` en vert et `[CONSUMERS]`
en magenta. Le rechargement automatique du code reste actif. `Ctrl+C` arrête les
trois processus ; si l’un des processus se termine, les autres sont arrêtés.
PostgreSQL, Redis et Ollama doivent être disponibles selon votre configuration ;
cette commande ne démarre ni n’arrête Docker. Bun reste nécessaire pour les
scripts du projet :
installez les dépendances avec `bun install --frozen-lockfile`, même si vous
lancez le développement avec npm.

Le frontend utilise un proxy Vite `/api` vers Express (port 3000).
`GET /health` renvoie HTTP 200. `bun run typecheck` vérifie les deux applications,
`bun run build` construit le frontend. `bun run services:down` arrête les services
sans supprimer leurs volumes. Les valeurs de `.env.example` sont réservées au
développement local : choisissez des identifiants propres et ne versionnez jamais `.env`.

## Accueil et guide d’utilisation

L’accueil public se trouve sur `http://localhost:5173/` et le guide détaillé sur
`http://localhost:5173/documentation`. Ces pages sont accessibles sans compte.
Le guide explique la création des sources RSS et scraping, la recherche de
sélecteurs dans Chrome/Edge, l’assistance IA et la demande d’aide, les accès aux
journaux, les tests du workflow, les réglages de centres d’intérêt et le suivi des collectes. Un exercice de
sélecteurs fonctionne localement dans le navigateur, sans requête IA.

Les captures versionnées dans `frontend/public/documentation/` utilisent les
vrais écrans avec des réponses API de démonstration : sources paginées, switches des
journaux, formulaire d’accès, réglages, Daily Brief du dashboard, historique et fenêtre du résumé IA. Les notifications
temporaires sont fermées avant les captures des formulaires ; l’exemple d’échec de
l’assistance conserve sa notification complète. Pour les régénérer et
vérifier l’accueil et le guide sur ordinateur et mobile :

```sh
bun run docs:capture
```

Cette commande lance temporairement Vite sur le port 5180 et nécessite Chromium
(`bun run browser:install`, ou `browser:prepare` avec `CHROMIUM_EXECUTABLE_PATH`
dans le cloud). Elle simule toutes les réponses API : aucune connexion à une
base, aucun appel IA et aucun email. Les images n’exposent aucun identifiant.
Les pages publiques et le guide n’exigent aucune nouvelle variable d’environnement.

L’espace utilisateur reprend la palette, le logo et les composants du site public :
navigation, en-têtes, cartes, boutons et formulaires. Le script de capture vérifie aussi
les pages du dashboard, des réglages, des sources, des journaux et de l’historique jusqu’à 320px,
ainsi que l’accès au contenu au clavier.

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
`GET /sources` renvoie `{sources, total, page, pageSize}` avec cinq sources au maximum.
Les paramètres `type=RSS|SCRAPING`, `status=all|active|inactive`, `q` (recherche
d'URL sans distinction de casse) et `page` (à partir de 1) sont appliqués en base,
toujours pour le compte connecté. Le total porte sur les sources filtrées ; si
une suppression rend la page demandée inexistante, la dernière page disponible
est renvoyée. La recherche traite `%` et `_` comme des caractères littéraux.
Le tableau `/sources` transmet ces critères à chaque changement et ne charge
que la page affichée. `PATCH /sources/:id` accepte `{enabled}`
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

Les requêtes RSS et Puppeteer refusent les adresses privées (y compris IPv6),
épinglent les résultats DNS, contrôlent les redirections et limitent les réponses
à 2 Mio avant et après décompression. Le transport décode gzip, deflate, Brotli
et zstd avant de lire le texte, même si un site compresse malgré la demande
`Accept-Encoding: identity`. Il tient compte du charset HTTP, de la déclaration
XML et des BOM UTF-8/UTF-16. Les réponses compressées corrompues et les encodages
invalides ont des erreurs distinctes du XML mal formé.
Puppeteer bloque WebSockets, service workers, téléchargements et mutations HTTP. Le
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
Le document principal dispose de 15 secondes pour se charger. La collecte attend
ensuite au plus 2,5 secondes de calme réseau : une iframe ou une requête annexe en
attente ne bloque pas une liste d’articles déjà présente. Sur chaque page, les
articles rendus tardivement par JavaScript disposent de 3 secondes supplémentaires.
Les erreurs précisent le numéro de page et l’étape concernée ; un délai du navigateur
est signalé comme tel. La durée totale de pagination n'est pas plafonnée. Le mode scroll conserve ses 8 scrolls et ses 45 secondes.
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

Tous les parcours navigateur du backend (collecte, rendu des articles, analyse
des sélecteurs et connexion aux journaux) utilisent `puppeteer`, `puppeteer-extra`
et `puppeteer-extra-plugin-stealth`. Le plugin stealth est enregistré une seule
fois dans `backend/src/browser.ts`. Chaque opération dispose d'un contexte isolé.
Les pages publiques conservent leur navigation native via le relais SOCKS avec
validation et épinglage DNS. Puppeteer contrôle chaque requête et redirection ;
les transports HTTP injectés restent réservés aux fixtures et aux sessions journal.
Playwright reste uniquement une dépendance de développement pour les tests
d'interface et leurs captures de documentation, avec le même exécutable.
Cette migration de moteur ne nécessite aucune migration SQL ; les sources et
leurs configurations existantes restent compatibles.

Installez Chrome for Testing avec `bun run browser:install` (ou
`bun run browser:install:deps` pour installer aussi les bibliothèques Linux,
avec les droits administrateur nécessaires). Puppeteer utilise son cache par
défaut ; `CHROMIUM_EXECUTABLE_PATH` permet de choisir un autre exécutable.
Si le CDN Chrome for Testing est indisponible, `bun run browser:prepare` extrait la distribution npm Chromium ;
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

La collecte manuelle et la collecte programmée partagent le même pipeline :

```text
RSS / scraping → dates J et J−1 → déduplication → pertinence et résumé IA
    → fin de toutes les tâches d’article → Daily Brief → affichage / newsletter
```

La période est figée au début de l’exécution dans le fuseau du compte, de minuit la veille
à minuit le lendemain. Ce sont des jours calendaires, y compris aux changements d’heure,
plutôt qu’une durée glissante de 48 heures. Un article sans date exploitable, ancien ou
daté après cette période est ignoré et signalé avant la récupération de son contenu complet.
Les dates françaises et anglaises courantes, ISO, RSS et HTTP sont prises en charge.
Par exemple : `24 Sept. 2026`, `08.10.2026`, `Publié le 29 septembre 2026`,
`1er février 2026`, `October 8, 2026` et les dates avec heure et décalage UTC.
Les espaces insécables, accents, jours de semaine et préfixes de publication sont
normalisés. Sans décalage explicite, l'heure est interprétée dans le fuseau du compte.
Les dates relatives (`hier`, `aujourd'hui`, `il y a 2 heures`) utilisent l'heure de lecture.
Les libellés `Modifié le 25 septembre 2026` sont également reconnus. Quand une
publication est suivie d'une modification, par exemple `Publié aujourd’hui à 01h33,
modifié à 08h18`, la date et l'heure de publication sont conservées.

Le sélecteur de date est évalué dans chaque bloc d'article. Le collecteur privilégie
les attributs `datetime`, `content`, `data-date` et `data-published-at`, y compris
un élément `time` imbriqué, puis utilise le texte visible si l'attribut est vide ou
invalide. Si plusieurs éléments correspondent, l'unique date exploitable est
retenue ; des dates contradictoires sont signalées comme inexploitables.
L'analyse des sélecteurs IA utilise le même parseur, avec un sélecteur précis par bloc.

Pour les dates numériques ambiguës, la convention est **jour/mois/année** ;
le format mois/jour est accepté seulement si le deuxième nombre dépasse 12.
Une année seule, une date incomplète, une plage de dates ou une date impossible
comme `31.02.2026` ne deviennent pas une date de publication. Aucun parseur ne peut
déduire sans contexte si `08/10/2026` signifie le 8 octobre ou le 10 août.
Le workflow de test conserve son aperçu de configuration indépendant.

Les sources sont parcourues du plus récent au plus ancien automatiquement, sans option
à configurer. En collecte, rencontrer une publication antérieure à J−1 arrête le parcours,
la pagination et les chargements supplémentaires si l'ordre observé le permet. Une date
manquante ou une inversion constatée désactive cet arrêt anticipé pour éviter d'écarter
des articles récents. Les autres sources continuent même si une source rencontre une erreur.

La page **Réglages** (`/settings`) permet d’activer la récupération quotidienne, de choisir
l’heure locale entière (`HH:00`) et de décrire ses **centres d’intérêt** (6 000 caractères maximum).
Le tableau de bord conserve l’affichage du planning et la collecte manuelle ; les réglages
ne s’y modifient plus. Les onglets **Collecte automatique** et **Vos centres d’intérêt**
conservent les modifications en cours ; le bouton **Enregistrer les réglages** en haut à droite
sauvegarde les deux sections et reste désactivé sans modification. Un prompt vide conserve tous les sujets. Les préférences orientent
uniquement les articles jamais analysés : une modification ne réanalyse pas automatiquement
les décisions et résumés existants. `PATCH /settings/dailybrief` accepte `interestPrompt`
avec `collectionEnabled`, `collectionTime` et `timezone`.

Le navigateur détecte son fuseau IANA avec `Intl.DateTimeFormat().resolvedOptions().timeZone`
et le synchronise automatiquement à l'ouverture ou à l'actualisation du tableau de bord
ou de la page Réglages,
via `GET /dashboard` et `PATCH /settings/dailybrief` uniquement s'il a changé.
Le serveur conserve ce fuseau et recalcule la prochaine échéance sans modifier
l'heure ni l'activation. La programmation reste valable lorsque le navigateur est
fermé. Après un changement de fuseau, ouvrir le tableau de bord actualise le planning.
Si la détection est indisponible, le dernier fuseau enregistré est conservé.
Le scheduler vérifie les échéances au démarrage puis au début de chaque heure UTC,
sans interrogation chaque minute. Une échéance passée est rattrapée au démarrage.
L’API et la base n’acceptent que les heures entières de `00:00` à `23:00`.
La migration ramène les anciens horaires à l’heure précédente (`07:30` devient `07:00`)
et adapte les prochaines échéances dans le fuseau enregistré. Le nouvel horaire par défaut
est `07:00`. Dans un fuseau dont le décalage UTC contient des minutes, une échéance
locale est traitée à la vérification horaire UTC suivante.
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

En collecte, l’analyse demande la **pertinence et le résumé éventuel ensemble** :
`{relevant, reason, summary}`. Si `relevant=false`, `summary` doit être `null` ; aucun résumé
n’est produit et l’article est persisté comme non pertinent avec sa raison et `analyzedAt`.
Ces articles apparaissent comme ignorés dans l’historique et ne sont pas retraités à chaque
collecte. Pour un article pertinent, le même résultat contient le titre du résumé, le texte
et les points clés. Les longues pages restent traitées intégralement par portions : la
décision et la synthèse suivent le mécanisme de découpage existant. Un JSON invalide,
une pertinence ambiguë ou une synthèse tronquée échouent explicitement et restent réessayables.
Les identifiants de journaux et les cookies ne sont jamais inclus dans ces prompts.

Après la fin de toutes les tâches d’article, une **tâche finale Daily Brief** produit une revue
globale des articles pertinents et résumés de la période. Le prompt regroupe les sujets,
élimine les répétitions, hiérarchise les faits et les explique brièvement ; il ne concatène
pas les résumés et n’impose aucun nombre minimal de sujets. Les références sont validées
contre les articles fournis. Le résultat structuré (`headline`, `lead`, `stories`, `otherNews`,
`trends`) est sauvegardé dans `DailyBrief`, lié à l’exécution par une contrainte unique sur
`runId`. La date, le fuseau, la période et le prompt sont figés pour l’exécution : une reprise
après interruption n’utilise pas soudainement les réglages d’une autre journée.

Le dernier Daily Brief apparaît en priorité sur `/dashboard`. **Lire les résumés individuels**
ouvre les articles utilisés pour cette édition dans une fenêtre paginée par cinq, avec leur
résumé, leurs points clés et leur lien de lecture. Le brief peut réutiliser des résumés déjà
analysés lors d’une collecte précédente, tant qu’ils appartiennent à J / J−1 ; ils ne sont pas
analysés à nouveau. `GET /dailybrief/:id/articles?page=1` charge au plus cinq résumés de cette
édition, avec les contrôles du propriétaire et de l’accès actuel aux articles ; le navigateur
ne reçoit pas la liste entière. `GET /dashboard` retourne `latestBrief` uniquement pour le compte
connecté. Aucun article pertinent et résumé disponible pour la période donne un brief
`EMPTY`, sans appel IA de synthèse ni email vide.
L’email utilise cette même revue : **À retenir aujourd’hui**, **Autres informations
intéressantes** et **Tendances du jour**, avec les liens des articles cités. Les rubriques
vides sont omises ; les résumés individuels ne sont pas concaténés dans le mail.
La date est celle de l’édition enregistrée, même après une reprise plus tardive.
Un échec de génération donne un brief `FAILED` avec une erreur ; aucun email à l’ancien
format n’est envoyé et les résumés déjà sauvegardés restent consultables. Une reprise réutilise un brief terminé au lieu de le générer deux fois.
Appliquez les migrations avec `bun run db:migrate` et régénérez le client avec
`bun run db:generate` après la mise à jour ; aucune nouvelle variable d’environnement n’est requise.

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

Le budget réseau du navigateur est de **32 Mio par chargement**, pour l'ensemble
du HTML, des scripts, des feuilles de style et des requêtes dynamiques. Le scraping
recommence ce budget avant chaque page de pagination, clic « Charger plus » ou
étape de scroll ; le poids des pages précédentes ne bloque plus toute la source.
La limite de 2 Mio par réponse décompressée reste indépendante. Un chargement qui
dépasse son budget est interrompu avec `RESPONSE_TOO_LARGE`, y compris si le
dépassement provient d'une ressource secondaire. Les redirections et les requêtes
du site ne réinitialisent pas le budget. Aucun réglage `.env` supplémentaire n'est
nécessaire.

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
nouveaux jobs. Les articles encore en attente sont repris uniquement s’ils appartiennent
à la période J / J−1 et n’ont pas déjà été jugés non pertinents.
Le worker extrait le contenu complet, analyse la pertinence selon le prompt figé de
l’exécution et résume uniquement les articles retenus. Les résultats sont enregistrés
en PostgreSQL avant la revue finale. Les journaux désactivés
restent recensés ; leurs jobs sont indiqués comme ignorés sans extraction ni IA.
Le Daily Brief commence une fois tous les jobs d’article terminés ; la newsletter est
ensuite préparée avec les articles autorisés et résumés avec succès. Les tests « A à Z »
gardent leur fonctionnement indépendant.

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
collectes dans **« Historique d’exécutions »**, avec leurs articles paginés par 5 : état,
tentatives, étape, erreur et résumé IA. La colonne **Source** ouvre l’article du journal,
en privilégiant `contentUrl` à l’URL de notice ; elle n’ouvre pas le flux ou la rubrique.
Le statut **Ignoré** affiche le motif au survol, au clavier ou par un appui sur mobile.
La décision factuelle donnée par l’IA est conservée, avec un motif distinct pour une source
ou un journal désactivé, un article déjà traité ou une collecte terminée. **« Voir le résumé »** ouvre une fenêtre avec
le titre généré, le texte enregistré et les points clés, sans nouvel appel à l'IA.
Les résumés deviennent visibles automatiquement après la fin du traitement. Les tâches
en attente, ignorées ou en échec n'affichent pas de résumé, y compris si une collecte
ultérieure a résumé l'article. L'API lit uniquement les articles de la page et du propriétaire.
Chaque utilisateur accède uniquement à ses propres collectes et articles.
Les endpoints sont `GET /collection/current`, `/collection/runs`,
`/collection/runs/:id` et `/collection/runs/:id/jobs?page=1&status=all`.
Le suivi de la collecte et le tableau sont côte à côte sur grand écran, et empilés sur mobile.
Le filtre `status=all|waiting|active|completed|failed|skipped` est appliqué côté serveur avant
la pagination : `waiting` inclut les tentatives différées, et `completed` exclut les articles
ignorés, accessibles via `skipped`. Le total correspond au filtre ; le bilan global reste intact.
Le serveur lit les statuts Redis par lots limités et charge uniquement les cinq articles
et résumés de la page en PostgreSQL. Une page devenue inexistante revient à la dernière
page disponible. Les paramètres de page et de statut restent dans l'URL après rechargement.

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

Lancez ensuite tous les processus dans **un seul terminal**, depuis le projet :

```powershell
npm run dev
```

Vous pouvez également les lancer séparément pour un diagnostic :

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

La navigation commune propose « Tableau de bord », « Sources » (`/sources`),
« Journaux » (`/journals`), « Historique d’exécutions » (`/jobs`) et « Réglages » (`/settings`).
Le tableau de bord met le dernier Daily Brief en avant, avec les statistiques,
le planning en lecture seule et la récupération manuelle ; chaque page de configuration
se charge indépendamment.

La page « Sources » sépare les flux RSS et les sites de scraping en deux onglets.
Chaque tableau affiche au plus cinq sources par page, avec recherche par URL et
filtre sur les sources actives ou inactives. Les URL ouvrent directement le site,
les points verts et rouges indiquent le statut, et les actions utilisent des icônes
avec infobulles. Le bouton d'ajout et le retour après création suivent le type de source.

Dans « Sources », l’icône « Modifier » ouvre une page dédiée avec la même présentation et les mêmes champs que la création :
`/sources/edit/rss/{id}` pour un flux RSS et `/sources/edit/scraping/{id}` pour une source de scraping.
Ces pages fonctionnent aussi par accès direct ou après rechargement. Les champs sont
préremplis avec les valeurs enregistrées : URL et sélecteur de lien facultatif pour un flux RSS ; URL, sélecteurs
d'articles, de titre, de lien et de date, mode de récupération,
paramètres de scroll, de pagination ou du bouton de chargement pour une source de scraping.
« Tester » affiche un aperçu sans modifier la source ni enregistrer d'articles.
Une modification invalide l'aperçu. À la création comme à l'édition, l'enregistrement
vérifie uniquement la première page configurée (le numéro de départ en pagination),
sans parcourir les pages suivantes, effectuer de scroll supplémentaire ou cliquer sur le bouton.
Les sélecteurs et l'accès réseau restent vérifiés. « Tester », le workflow de A à Z
et la collecte continuent à parcourir toutes les pages, effectuer les scrolls configurés
ou cliquer sur le bouton jusqu'à la fin des articles.
Une erreur de récupération ou une adresse déjà utilisée laisse la source existante
inchangée. « Annuler » et « Retour aux sources » reviennent à l’onglet RSS ou SCRAPING
sans enregistrer. Une sauvegarde réussie revient au même onglet avec une notification.

L'identifiant, les articles existants et l'état actif ou inactif sont conservés.
Le sélecteur de date est obligatoire lors de la création,
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
propose les quatre sélecteurs obligatoires (articles, titre, lien et date)
et le mode de chargement lorsqu'ils sont identifiables. Les champs omis par l'IA
sont complétés à partir d'éléments observés et non ambigus. La description est extraite
automatiquement depuis l'extrait de la carte, avec le titre comme repli. Les anciens
sélecteurs de description restent lisibles mais ne sont plus affichés ni requis. Une date
absente reste une erreur avec possibilité d'aide humaine ; elle n'est jamais
remplacée par le titre.
Les contrôles de pagination en bas des longues listes sont prioritaires dans le
DOM envoyé à l'IA. Le serveur vérifie les liens de pagination (paramètre d'URL ou
modèle avec `{page}`, en préservant les numéros de catégorie), les boutons de
chargement et les nouveaux liens d'articles observés après un court scroll dans
Chromium. Les réglages et le mode remplissent le formulaire ensemble. Sans
preuve d'un chargement supplémentaire, le mode scroll proposé est signalé comme
à vérifier ; une pagination ambiguë ou un compteur qui avance par grands pas
n'est pas inventé.
Les résultats remplissent
le formulaire sans l'enregistrer : vérifiez-les puis utilisez « Tester » avant de sauvegarder.
Une modification de l'adresse invalide les résultats. « Annuler l'analyse » interrompt
la requête IA ; fermer le formulaire l'interrompt également.

Dans la configuration d'accès d'un journal, commencez par l'adresse HTTPS de sa
page de connexion (par exemple `/login` ou `/connexion`). Le bouton « Remplir avec
l'IA », placé juste dessous, devient disponible quand cette adresse est renseignée.
Il propose les sélecteurs des champs d'identifiant et de mot de passe et du bouton d'envoi.
Les identifiants se renseignent ensuite dans une section séparée, en bas de la modal.
L'analyse ne soumet pas le formulaire et ne reçoit pas vos identifiants. Les sélecteurs
de réussite et de contenu intégral ne sont plus demandés dans la modal. Les anciens
réglages restent conservés ; utilisez « Tester la connexion » après enregistrement.

Les sélecteurs proposés sont contrôlés sur la page chargée dans Chromium : un
résultat ambigu, masqué ou absent est refusé. L'IA reçoit une structure de page
limitée, sans scripts, valeurs des champs ni paramètres d'URL privés, avec des
instructions pour traiter cette structure comme des données et éviter les sélecteurs
inventés. L'analyse peut effectuer deux scrolls courts ; elle ne clique sur aucun
bouton, ne se connecte pas et ne parcourt pas les pages suivantes. Chaque champ de
configuration présente une aide reliée à son contrôle pour les lecteurs d'écran.
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

Si une source de scraping ne trouve aucun article, diagnostiquez ses sélecteurs avec
le même navigateur que le formulaire. Les arguments sont, dans l'ordre : URL,
sélecteur des articles, du titre, du lien, de la date, puis le bouton facultatif.
Exemple avec les sélecteurs à vérifier pour la rubrique Patrimoine du Monde :

```powershell
npm run diagnose:scraping -- "https://www.lemonde.fr/patrimoine/" ".teaser" ".teaser__title" ".teaser__link" ".meta__date" "#js-more-teaser"
```

Cette commande affiche les nombres de blocs, titres, liens et éléments de date,
la présence du bouton visible et les indices de protection/CAPTCHA.
Les correspondances dans la page entière sont également affichées : elles peuvent
être présentes même si le sélecteur du bloc d'article ne correspond plus au site.
La commande produit `diagnostics/scraping-page.png` (le haut de la page reçue)
et `diagnostics/scraping-structure.json` (comptes globaux et ancêtres CSS des titres).
Ces fichiers restent locaux et sont exclus de Git. Les champs de saisie sont masqués
dans la capture ; le JSON ne contient ni HTML, ni textes, ni valeurs de champs,
ni cookies, ni paramètres d'URL. Joignez la capture et le JSON pour examiner un
aperçu vide sans devoir utiliser l'inspecteur du navigateur.
Elle ne clique pas sur le bouton, ne se connecte pas, n'appelle pas l'IA, ne modifie
pas la base et n'envoie pas d'email. Les comptes décrivent le DOM réellement reçu ;
ils ne prouvent pas que les dates sont interprétables ni que le bouton fonctionne.
Le collecteur attend jusqu'à trois secondes supplémentaires sur la première page
si les blocs d’articles ne sont pas encore présents après la navigation. Une protection reconnue
sans article produit une erreur distincte, au lieu d'accuser les sélecteurs.
Les écrans courts « vérifie votre navigateur… », sans articles, titres ou liens,
sont également reconnus même s'ils ne contiennent aucun identifiant de CAPTCHA.
Le navigateur reste ouvert jusqu'à **30 secondes** pour laisser une vérification
transitoire se terminer normalement. Le même navigateur et ses cookies temporaires
sont conservés pendant cette attente. L'extraction reprend si l'écran disparaît ou
si les articles apparaissent ; si la vérification persiste, une erreur explicite
remplace l'aperçu vide. Cela vaut pour le test, la validation avant enregistrement,
la collecte et les pages suivantes de pagination. Les logs signalent le début et
la fin de l'attente, sans texte de page ni cookies.
Si les filtres initiaux ont empêché des ressources de se charger, la page de
vérification est rechargée une seule fois dans le même navigateur. Pendant cette
phase, les images et polices sont autorisées, ainsi que les POST AJAX vers le
site et les domaines HTTPS exacts `geo.captcha-delivery.com`, `api-js.datadome.co`
et `challenges.cloudflare.com`. Les autres POST externes restent bloqués.
La vérification des destinations publiques et les limites de téléchargement
restent actives ; les restrictions habituelles reviennent après l'attente.
Il s'agit de laisser les scripts de validation normaux du site fonctionner,
sans résoudre de CAPTCHA ni modifier l'empreinte du navigateur.

La variable facultative `SCRAPING_VERIFICATION_WAIT_MS=30000` règle ce délai dans
le `.env` commun à l'API et aux consumers. Elle accepte de `0` (aucune attente) à
`120000` (deux minutes). Redémarrez `npm run dev` après un changement. L'attente
ne résout pas un CAPTCHA et ne garantit pas que le site autorisera le navigateur
automatisé ; une vérification toujours présente demande un autre accès autorisé.

Les confirmations et erreurs utilisent un Toaster commun sur toutes les pages et
dans les modales. Les notifications sont fermables, accessibles au clavier et
adaptées au mobile. Les avertissements d'aperçu et les erreurs des articles et jobs
restent consultables dans leurs résultats. Les confirmations de navigation ne sont
pas répétées lors d'un retour en arrière.

Lorsque les champs nécessaires sont remplis, l'analyse affiche simplement
« Sélecteurs remplis. » et masque l'aide, même si une ancienne réponse mentionne
un sélecteur de réussite après connexion. Si le mode de récupération reste incertain,
une courte notification invite à le vérifier.

Si l'analyse échoue ou ne remplit pas les sélecteurs nécessaires, « Demander de l'aide » permet
d'envoyer un email à l'adresse configurée dans `SMTP_USER`. Aucun email n'est
envoyé automatiquement. Le message indique le type de configuration, le site,
la notice réellement analysée pour un RSS et les informations restant à trouver.
L'adresse du compte sert de `Reply-To`. Les mots de passe, cookies, contenu HTML,
prompts IA et paramètres privés des URL ne sont jamais inclus. Le bouton disparaît
après l'envoi réussi de la demande ou une nouvelle analyse réussie.

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
Les liens directs provenant du scraping ou d'un flux RSS utilisent aussi les
identifiants du journal lorsqu'ils sont enregistrés pour le compte et le domaine exact.
Les accès sont relus au moment du résumé : une connexion ajoutée après la création
de l'aperçu est prise en compte. La progression confirme la connexion et la lecture
authentifiée ; un échec ne revient pas silencieusement à l'extrait public. Les métadonnées
d'abonnement empêchent également de présenter un extrait public comme le texte intégral.
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
peut être préparé depuis npm lorsque le CDN Chrome for Testing est inaccessible.
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

La page **« Journaux »** permet l'ajout, l'activation,
la configuration de l'accès, la modification du domaine et la suppression.
Le switch de la colonne Actions active ou désactive le journal, comme pour les sources.
Le point vert ou rouge de la colonne Statut est un indicateur sans action au clic.
Le tableau du workflow utilise également le switch commun pour l'activation.
L'ajout, la
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
sélecteurs CSS des champs email et mot de passe et du bouton de connexion.
Les sélecteurs doivent désigner un seul
élément visible ; les copies cachées d'un formulaire sont ignorées. Le champ de
mot de passe doit être de type `password`. Un formulaire JavaScript peut omettre
`method="post"` s'il intercepte l'envoi et transmet les identifiants par POST.
Toute requête qui placerait le mot de passe dans l'URL est bloquée avant l'envoi.
Le navigateur retrouve les champs et le bouton après les mises à jour JavaScript
du formulaire, déclenche les événements de saisie et de sortie du champ, puis
vérifie les valeurs avant l'envoi. Si la page les efface, il reprend la saisie
(trois tentatives maximum). Des valeurs absentes ou incorrectes déclenchent
`JOURNAL_LOGIN_FIELDS_UNFILLED` sans envoyer le formulaire.
Le contrôle d'envoi est recherché après la saisie, car certaines pages ne le
rendent visible qu'une fois les champs remplis. Les champs ou contrôles absents
sont distingués par `JOURNAL_LOGIN_EMAIL_NOT_FOUND`,
`JOURNAL_LOGIN_PASSWORD_NOT_FOUND` et `JOURNAL_LOGIN_SUBMIT_NOT_FOUND`.
Un contrôle d'envoi peut être un `input[type='submit']` ou un `button[type='submit']`.
Le chargement attend le document principal et un délai borné d'inactivité réseau,
sans attendre indéfiniment les iframes. Les erreurs avant la saisie distinguent
le délai du document (`JOURNAL_LOGIN_PAGE_TIMEOUT`), le refus HTTP de la page
(`JOURNAL_LOGIN_PAGE_HTTP_ERROR`) et les problèmes DNS, TLS ou de connexion réseau
(`JOURNAL_LOGIN_NETWORK_*`). Un échec de chargement ne constitue pas une détection
de CAPTCHA ni un refus des identifiants. Une impossibilité de cliquer après
remplissage renvoie `JOURNAL_LOGIN_SUBMIT_FAILED`.

Après l'envoi du formulaire, le serveur accepte une nouvelle navigation du
document principal vers l'accueil HTTPS du journal (`https://domaine/`, avec ou
sans paramètres et fragment), dès que le document est prêt et qu'aucun champ de
mot de passe n'est visible. Cette règle s'applique à tous les domaines configurés,
y compris si le menu de déconnexion est caché ou si un ancien sélecteur de réussite
ne correspond plus au site. Les redirections HTTP et JavaScript sont prises en compte.
Une requête AJAX, un iframe, un simple changement d'URL via History API ou la
disparition du formulaire sans cette navigation ne suffisent pas.
Pour les sites qui restent sur une autre page, un nouveau contrôle visible de
déconnexion ou le sélecteur de réussite enregistré peuvent confirmer la session.
Sans confirmation, le serveur renvoie `JOURNAL_LOGIN_UNVERIFIED` ou l'erreur de
soumission observée. La redirection vers l'accueil reste un indice de connexion ;
l'accès au contenu de chaque article est vérifié séparément.

La modal n'affiche plus le sélecteur facultatif du contenu intégral. Les valeurs
déjà enregistrées restent conservées lors d'une modification de l'accès. Ce réglage
serveur reste nécessaire pour les pages dont les métadonnées indiquent un accès réservé : la
connexion au compte ne garantit pas que l'abonnement autorise la lecture. Un paywall
visible, une session expirée ou une zone absente empêche l'extraction et l'IA.
La détection générique ne garantit pas la reconnaissance de toutes les protections
propres aux journaux.

« Tester la connexion » appelle `POST /journals/:domain/test` avec `{}`. L'endpoint
est réservé au propriétaire, vérifie la connexion et ferme la session de
test sans lire d'article, modifier la collecte ou envoyer d'email. Son résultat est
temporaire. Le test de connexion et les lectures individuelles du workflow ouvrent
chacun un contexte Chromium isolé. Lors d'une lecture, l'article est ouvert avec
les cookies de cette session.

Les collectes manuelles et programmées regroupent tous les articles à récupérer
par **utilisateur, exécution et hôte exact du journal**, même s'ils proviennent de
sources différentes. Lorsqu'un journal possède des identifiants configurés, un
seul navigateur et un seul contexte se connectent, puis lisent ses articles dans
la même session. Les flux RSS directs et les sources scraping qui pointent vers
cet hôte utilisent également cet accès configuré. La lecture publique conserve
son fonctionnement habituel en l'absence d'identifiants.

Le job de collecte sauvegarde le contenu en PostgreSQL et ferme le navigateur
avant de créer les jobs IA individuels. Ceux-ci utilisent le contenu préparé,
y compris avec plusieurs processus consumers : aucun job IA ne se reconnecte
pour ce lot. Redis conserve uniquement les identifiants d'articles, le résultat
de préparation et les empreintes des réglages ; ni HTML ni secrets. Les cookies
restent en mémoire et ne sont enregistrés ni en base, ni dans Redis, ni sur disque.
Les hôtes avec et sans `www` gardent des sessions distinctes.

Un article inaccessible est signalé sans empêcher les suivants. Un échec de
connexion ou une session expirée ne déclenche pas une nouvelle connexion pour
chaque article : les jobs concernés échouent explicitement. Toute modification
des accès entre la préparation et l'IA bloque les résumés concernés. Le contenu
déjà sauvegardé avec les mêmes réglages est réutilisé sans ouvrir de navigateur.
Après un arrêt du consumer pendant la préparation, la reprise peut nécessiter
une nouvelle session pour les articles restants ; les cookies ne sont pas persistés.
Les logs `journal.batch_started` et `journal.batch_finished` indiquent le domaine
et le nombre d'articles du lot sans exposer d'identifiants.

Les identifiants sont envoyés uniquement par POST aux origines HTTPS déclarées
du formulaire de connexion et du journal, pendant l'authentification. Les appels
de vérification de session sur le domaine du journal après la redirection sont
donc pris en charge. Les prévols CORS `OPTIONS` sont autorisés sur ces deux origines
durant cette phase ; l'origine réelle et les autorisations CORS reçues du serveur
sont conservées pour que Chromium applique les contrôles habituels. Les navigations
sont limitées à ces deux origines ; les autres redirections sont refusées. Un formulaire hébergé sur
un sous-domaine ou un fournisseur externe peut donc être déclaré explicitement.
Les redirections HTTP des formulaires et des appels AJAX sont suivies par Chromium,
avec sa gestion des cookies : 302/303 transforment un POST en GET, tandis que
307/308 conservent la méthode et le corps. Chaque destination est vérifiée avant
la poursuite ; les boucles sont limitées à douze étapes. L'origine CORS opaque
`null`, produite par Chromium sur certaines chaînes entre les deux origines,
est conservée. Les en-têtes applicatifs du navigateur (jetons CSRF, XSRF ou
Authorization) sont transmis aux origines déclarées, avec filtrage des en-têtes
réservés au transport ; ils ne sont pas réutilisés par le transport HTTP sur une
autre destination de redirection.
Une erreur sur une requête AJAX secondaire n'annule pas une connexion confirmée.
Les erreurs de navigation principale restent bloquantes. Après confirmation,
le navigateur attend brièvement la fin des appels réseau (au plus 2,5 secondes)
pour terminer l'initialisation des cookies de session, puis navigue vers l'article
dans le même onglet authentifié. Les cookies et le stockage de session de cet
onglet (`sessionStorage`) restent disponibles. Les lectures du lot sont séquentielles ;
un échec de navigation arrête le chargement sans fermer l'onglet, afin de pouvoir
lire l'article suivant dans cette session. Le navigateur est fermé après la fin
du test ou du lot, et non juste après la connexion.
Un refus de page conserve le statut HTTP du document principal dans un message
expurgé (`JOURNAL_ARTICLE_HTTP_ERROR`, par exemple HTTP 403 ou 429), sans URL,
paramètre, corps de réponse ou identifiant. Les délais de chargement de la page
(`JOURNAL_ARTICLE_PAGE_TIMEOUT`) et d'apparition du contenu
(`JOURNAL_ARTICLE_CONTENT_TIMEOUT`) sont distingués des refus HTTP et des erreurs
réseau (`JOURNAL_ARTICLE_NETWORK_*`).
Les iframes externes sont bloquées sans interrompre la connexion du document
principal ; leurs navigations ne sont pas des redirections du formulaire.
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

## Logs et alertes email

Le backend et les consommateurs utilisent un logger commun avec `info`, `debug`
et `error`. Chaque message contient une date UTC, le service (`backend` ou
`consumers`), un nom d'événement et un contexte structuré. Les collectes et les jobs
sont suivis avec `runId`, `jobId`, `sourceId`, le numéro de tentative, les comptes
et les durées. Les requêtes HTTP reçoivent un `X-Request-Id` généré par le serveur,
présent dans les logs d'erreur pour faciliter un diagnostic.

`LOG_LEVEL=info` affiche les démarrages, les collectes, les jobs et leurs résultats.
`LOG_LEVEL=debug` ajoute les requêtes HTTP et les nouvelles tentatives.
`LOG_LEVEL=error` conserve uniquement les erreurs et les erreurs fatales.
Le format est lisible dans le terminal en développement et JSON en production.
`LOG_FORMAT=pretty` ou `LOG_FORMAT=json` permet de choisir explicitement.

```text
2026-10-11T12:00:00.000Z INFO [consumers] job.completed — Job terminé. {"queue":"article-summaries","jobId":"…","runId":"…","status":"completed","durationMs":2500}
```

Toutes les erreurs de niveau `error`, y compris les erreurs fatales, sont ajoutées
au fichier **`.error` à la racine du projet**, en JSON, une erreur par ligne.
`LOG_ERROR_FILE` accepte un autre chemin ; un chemin relatif part toujours de la
racine du projet, même sur Windows. Le fichier est créé à la première erreur,
ignoré par Git et restreint au propriétaire sur les systèmes qui gèrent les
permissions POSIX. Le backend et les consommateurs ajoutent leurs lignes au même
fichier. Prévoir sa rotation ou son archivage dans un déploiement de longue durée.

Avec `ERROR_EMAIL_ENABLED=true` (valeur par défaut), les erreurs sont aussi envoyées
par SMTP à **`ERROR_EMAIL_TO`**, ou à **`SMTP_USER`** si l'adresse de remplacement
est vide. Renseignez les paramètres `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
`SMTP_FROM`, `SMTP_USER` et `SMTP_PASSWORD` selon votre serveur. Si l'identifiant
SMTP n'est pas une adresse email, renseignez `ERROR_EMAIL_TO`. Sans destinataire
valide, un message au démarrage signale que les alertes email sont indisponibles ;
les erreurs restent dans la console et dans `.error`.

Seule la première occurrence d'un même événement/code d'erreur par processus
déclenche un email pendant `ERROR_EMAIL_COOLDOWN_MS` (cinq minutes par défaut).
Une limite de dix alertes ordinaires par période protège contre une panne en
boucle ; **toutes les occurrences restent enregistrées dans `.error`**. Une erreur
fatale a une priorité d'envoi et contourne cette limite. Les nouvelles tentatives
de jobs et les erreurs attendues de validation utilisateur ne déclenchent pas
d'alerte ; les échecs définitifs de jobs, de sources, de pipelines, de Redis ou du
planificateur sont signalés.

Les exceptions non interceptées, les promesses rejetées sans traitement et les
échecs de démarrage ou d'arrêt sont marqués `fatal: true`. Le processus attend
l'écriture du log et l'envoi des alertes, avec un délai maximal de quinze secondes,
puis sort avec le code `1`. Un arrêt normal par `Ctrl+C` ou `SIGTERM` ne déclenche
pas d'alerte. Si SMTP échoue, cet échec est écrit localement sans envoyer une
nouvelle alerte en boucle. Les alertes ne sont pas une file de livraison durable :
une indisponibilité SMTP laisse la trace locale mais ne garantit pas l'email.
L'arrêt normal attend les tâches actives pendant trente secondes au maximum ;
les jobs Redis interrompus sont repris par les consommateurs au redémarrage.

Les mots de passe, identifiants, cookies, sessions, corps HTTP, HTML et prompts
sont masqués. Les messages bruts des exceptions externes sont exclus : leurs
codes et leurs emplacements d'appel permettent le diagnostic sans exposer une
réponse de fournisseur ou des secrets. Les logs HTTP utilisent les modèles de
routes, sans paramètres d'URL, en-têtes ni champs du formulaire.

Pour tester localement, mettez `LOG_LEVEL=debug` dans `.env`, configurez le SMTP et
son destinataire, puis redémarrez avec **`npm run dev`**. Aucune migration ni nouvelle
dépendance n'est nécessaire. Les tests du logger utilisent un transport SMTP
simulé ; `NODE_ENV=test` désactive les alertes réelles.
