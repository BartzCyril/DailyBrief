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
`GET /sources` liste les sources du compte ; `PATCH /sources/:id` accepte `{enabled}`.

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
à 2 Mio. Playwright bloque WebSockets, service workers et mutations HTTP. Le
scraping est borné à 5 pages ou 8 scrolls, 45 secondes et 2 navigateurs simultanés.
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
`{title,summary,keyPoints}`. L'IA utilise du JSON validé, des entrées nettoyées
et tronquées à `AI_MAX_INPUT_CHARS`, un timeout et une concurrence limitée.
Les tests mockent Ollama : aucun téléchargement de modèle n'est nécessaire pour eux.
Les résumés demandent explicitement `think: false` afin que Qwen3 fournisse
directement le JSON final. Un contenu de raisonnement seul ne sert jamais de résumé.
Les réponses vides, interrompues par la limite de génération ou mal formatées sont
signalées séparément dans le journal de collecte ; les articles restent réessayables.

`POST /collection/run` et le scheduler appellent le même pipeline. GUID, URL
canonique sans tracking et hash détectent les doublons. Le fingerprint déterministe
identifie les articles connus ; les relations vers les newsletters envoyées
déterminent ceux déjà livrés. Les échecs IA sont conservés et exclus du mail ;
ils peuvent être retentés. Les résumés sont persistés avant l'envoi SMTP.
Un échec SMTP laisse la newsletter `FAILED` et les articles réutilisables sans
nouvelle génération IA. Aucun email vide n'est envoyé.

Le bouton « Récupérer maintenant » affiche un journal en direct : récupération de
chaque source, nombre d'articles, sauvegarde et doublons, titre de chaque article
envoyé à Ollama et résultat du résumé, préparation de la newsletter et envoi SMTP.
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
