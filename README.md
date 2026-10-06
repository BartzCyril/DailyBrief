# DailyBrief

Veille quotidienne personnelle, en TypeScript strict. Bun 1.4.2, Express 5,
React 19.3, Vite 8, Prisma 6 et PostgreSQL 17. Docker avec Compose est requis.

```sh
git clone https://github.com/BartzCyril/DailyBrief.git
cd DailyBrief
cp .env.example .env
bun install --frozen-lockfile
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

Créez une base dédiée aux tests avant `bun run test` :

```sh
docker compose exec postgres psql -U dailybrief -d postgres -c 'CREATE DATABASE dailybrief_test'
```

`TEST_DATABASE_URL` doit se terminer par `_test`. Les tests créent et retirent
leurs propres comptes. Les tests de scraping utilisent de vraies pages Chromium
avec un transport contrôlé, jamais des sites publics instables.
