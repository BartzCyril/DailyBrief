# DailyBrief

Veille quotidienne personnelle, en TypeScript strict. Bun 1.4.2, Express 5,
React 19.3, Vite 8, Prisma 6 et PostgreSQL 17. Docker avec Compose est requis.

```sh
git clone -b version/1.0.0 https://github.com/BartzCyril/DailyBrief.git
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
Après chaque clic, il attend la fin des requêtes AJAX et la stabilisation des articles.
Si aucun nouvel article n'apparaît dans le délai, il s'arrête avec un avertissement
et conserve les résultats. Un bouton absent dès le départ est également signalé.
Les chargements JavaScript/AJAX sont pris en charge, y compris les requêtes POST
sur le même site ; les requêtes et redirections conservent la validation des adresses
publiques. Les POST vers un autre site sont bloqués ; une requête annexe, comme une
mesure d'audience, ne fait pas échouer un lot d'articles chargé correctement. Si
aucun chargement sur le site n'aboutit et qu'une requête POST a été bloquée, son
URL est indiquée dans l'erreur. Une réponse de chargement réussie sans nouvel
article termine normalement la collecte avec un avertissement, même si une
requête annexe a été bloquée. Les autres erreurs AJAX restent des échecs de collecte.
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

`POST /collection/run` et le scheduler appellent le même pipeline. GUID, URL
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

Si le HTML ne contient pas de texte exploitable ou renvoie une redirection
JavaScript, Chromium charge la page dans un contexte neuf, exécute ses scripts
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

Chaque requête du navigateur passe par la validation DNS et le transport épinglé.
Les redirections des documents ouvrent une nouvelle navigation contrôlée pour
éviter les suivis natifs échappant à l'interception. Les adresses privées,
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
paramètres privés. Une panne globale d'Ollama suspend les résumés restants ; les
articles sont conservés pour une nouvelle tentative.

Le frontend demande `Accept: application/x-ndjson` sur `POST /collection/run`.
Le backend transmet les événements `progress`, puis un `result` final (ou une
erreur de démarrage `error`), avec un heartbeat toutes les 15 secondes. Sans cet
en-tête, l'endpoint conserve sa réponse JSON. Le proxy doit permettre le streaming
sans mise en tampon (`X-Accel-Buffering: no`). Fermer la page interrompt le suivi,
mais la collecte continue côté serveur ; aucune relance automatique n'est faite.
Le journal est visible pendant la session de la page. Le bilan et les erreurs
restent enregistrés dans l'historique serveur.

### Modifier une source

Dans « Vos sources », le bouton « Modifier » reprend les mêmes champs que la création,
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
Les sélecteurs facultatifs peuvent être effacés et le mode de récupération changé.
Pour une pagination par modèle d'URL, conservez `{page}`. Son préfixe suit l'URL de départ
si le modèle utilise cette adresse et n'a pas été modifié manuellement.
Seul le propriétaire de la source peut la modifier.

Les actions « Modifier » (crayon) et « Supprimer » (corbeille) sont des icônes avec
un libellé accessible et une infobulle. La corbeille demande confirmation avant
de supprimer la source ainsi que ses articles et résumés associés. Les autres
sources et les newsletters restent conservées. L'interrupteur d'activation affiche
un curseur pointeur lorsqu'il est disponible.

### Tester une source de A à Z

Dans la liste des sources, « Tester le workflow de A à Z » ouvre une liste
fraîche des articles RSS ou scraping, y compris ceux déjà résumés ou livrés.
Les sources désactivées peuvent aussi être testées. Tous les résultats du
collecteur sont affichés : le RSS conserve sa limite de 500 entrées, tandis que
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

SMTP se configure dans `.env`. Le destinataire provient exclusivement de
`User.email`. Mailpit utilise les valeurs locales proposées et permet de consulter
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
réglages, collecte, prévention d'un second envoi, affichage mobile et déconnexion.
Il utilise PostgreSQL/Redis réels et des transports contrôlés pour les sites,
l'IA et Nodemailer. Il n'envoie aucun email externe. Les tests unitaires vérifient
aussi les erreurs, l'isolation des utilisateurs, les verrous, les changements
d'heure et les nouvelles tentatives SMTP. La CI exécute ces mêmes vérifications.

Dans le cloud, autorisez `registry.ollama.ai` et les hôtes de téléchargement
retournés par le registre pour télécharger un modèle. Le navigateur de secours
peut être préparé depuis npm lorsque le CDN Playwright est inaccessible.
Le fonctionnement avec un vrai modèle et un serveur SMTP réel doit être vérifié
avec vos paramètres ; les transports de test ne constituent pas cette validation.
