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
