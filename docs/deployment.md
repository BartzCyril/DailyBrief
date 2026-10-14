# Déploiement Docker sur un VPS

Docker Compose démarre le frontend avec Caddy et HTTPS, l’API Express, le worker
de collecte et de résumé, PostgreSQL, Redis et Ollama. Chromium et les dépendances
Puppeteer sont inclus dans l’image du backend. Bun n’est pas nécessaire sur le VPS.

## Première installation

Prévoyez un VPS Linux avec Docker Engine et Docker Compose v2 récent, un domaine
pointant vers le VPS, et les ports TCP 80 et 443 accessibles. UDP 443 est facultatif
et permet HTTP/3. Pour `qwen3:4b`, prévoyez au moins 8 Go de RAM, idéalement 16 Go,
et 30 Go de disque libre pour les images, le modèle et les données. L’inférence
fonctionne sur CPU ; aucun GPU n’est configuré.

```sh
git clone -b main https://github.com/BartzCyril/DailyBrief.git
cd DailyBrief
./deploy.sh init https://brief.example.com
nano .env.production
./deploy.sh up
```

Remplacez `brief.example.com` par votre domaine. `init` crée les mots de passe
PostgreSQL et Redis, le secret de session et la clé de chiffrement des accès aux
journaux dans `.env.production`, avec des permissions restreintes. Une nouvelle
exécution conserve les secrets existants. Le fichier n’est pas versionné et
n’entre pas dans les images Docker.

`up` construit les images, applique les migrations, télécharge le modèle Ollama
s’il manque et attend les contrôles de santé avant de rendre le site disponible.
Le premier lancement peut être long : le modèle représente plusieurs Go.
Le VPS doit accéder aux registres Docker, aux paquets de construction et au
registre des modèles Ollama. Un échec de migration ou de téléchargement bloque
le démarrage de l’application et apparaît dans les logs.

Caddy obtient et renouvelle automatiquement le certificat HTTPS. `APP_DOMAIN`
doit contenir le domaine, et `APP_ORIGIN` son origine HTTPS exacte. PostgreSQL,
Redis, Ollama et le port de l’API ne sont pas publiés sur le VPS.

## Envoi des emails

Par défaut, Mailpit **capture les emails sans les livrer**. Configurez votre
fournisseur SMTP dans `.env.production` pour envoyer les newsletters :

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=votre-identifiant
SMTP_PASSWORD=votre-mot-de-passe
SMTP_FROM=brief@example.com
```

Pour un SMTP utilisant TLS dès la connexion, généralement sur le port 465,
utilisez `SMTP_SECURE=true`. Pour recevoir les alertes, renseignez
`ERROR_EMAIL_ENABLED=true` et `ERROR_EMAIL_TO`.

Mailpit écoute uniquement sur le VPS à `127.0.0.1:8025`. Pour le consulter pendant
des essais depuis votre ordinateur :

```sh
ssh -L 8025:127.0.0.1:8025 utilisateur@votre-vps
```

Ouvrez ensuite `http://localhost:8025`. Les messages capturés par Mailpit ne sont
pas conservés lors de la recréation de son conteneur ; les données de
l’application le sont.

## Mise à jour et exploitation

```sh
git pull origin main
./deploy.sh update
```

`update` construit les nouvelles images, arrête temporairement le site et les
consommateurs, applique les migrations puis redémarre les services. Les volumes
sont conservés. La génération Prisma est incluse dans la construction de l’image.
Exécutez aussi `update` après une modification de `.env.production`.

```sh
./deploy.sh logs
docker compose --env-file .env.production -f compose.production.yml ps -a
docker compose --env-file .env.production -f compose.production.yml logs migrate ollama-init
./deploy.sh down
```

`down` arrête le déploiement et conserve les volumes ; `up` le relance. Évitez
`down -v`, qui détruit les volumes. Les logs de console de l’API et du worker
sont limités à trois fichiers de 10 Mo par conteneur. Les fichiers d’erreur
persistants se trouvent dans le volume `application_logs` et nécessitent une
rotation ou un archivage selon votre exploitation.

`OLLAMA_MODEL` permet de changer de modèle. Une mise à jour télécharge le modèle
demandé sans supprimer les modèles déjà présents. Ajustez les concurrencences IA
et collecte dans `.env.production` en fonction de la RAM disponible.

## Sauvegarde et transfert d’une installation existante

Sauvegardez PostgreSQL **et `.env.production`**, en particulier
`JOURNAL_ENCRYPTION_KEY`. Sans cette clé, les identifiants des journaux enregistrés
ne peuvent plus être déchiffrés. Ne régénérez pas les secrets d’un déploiement
existant. Le modèle Ollama peut être téléchargé à nouveau ; Redis contient aussi
les jobs en attente et les sessions.

```sh
docker compose --env-file .env.production -f compose.production.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > dailybrief.dump
```

Conservez les sauvegardes hors du VPS. Pour transférer une base existante,
reportez sa clé `JOURNAL_ENCRYPTION_KEY` et son `SESSION_SECRET` dans le nouveau
`.env.production`, démarrez seulement PostgreSQL puis restaurez le dump avant
le premier `up` :

```sh
docker compose --env-file .env.production -f compose.production.yml up -d --wait postgres
docker compose --env-file .env.production -f compose.production.yml exec -T postgres \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --exit-on-error' < dailybrief.dump
./deploy.sh up
```

Cette restauration suppose une base cible vide. Pour remplacer une base déjà
utilisée, arrêtez le site et les workers et préparez une sauvegarde avant de
restaurer. Les migrations manquantes sont appliquées au démarrage suivant.

## Développement local

`docker-compose.yml` reste la composition de développement utilisée par
`bun run services:up`. `compose.production.yml` utilise des volumes et un nom de
projet distincts : il ne réutilise pas automatiquement la base de développement.
Dans les conteneurs, Chromium fonctionne en mode headless. Hors Docker,
`CHROMIUM_HEADLESS=false` conserve le navigateur visible configuré pour les tests
de connexion aux journaux.
