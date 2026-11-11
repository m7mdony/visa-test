This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Grafana / Loki (server-side)

If Grafana sign-in is **Google OAuth** (or anything other than username/password), `POST /login` no longer returns a session cookie for automation. Configure a **long-lived token** instead:

- `GRAFANA_API` (or `GRAFANA_TOKEN` / `GRAFANA_SERVICE_ACCOUNT_TOKEN` / `GRAFANA_API_TOKEN`) — `Authorization: Bearer …`; Loki is read via Grafana’s datasource proxy `…/loki/api/v1/query_range` (same as `pull_loki.py`).
- Fallback when unset: `GRAFANA_USER` + `GRAFANA_PASSWORD` — cookie session from `POST /login` (only if that still works on your instance).

Also set `GRAFANA_URL` and (when applicable) `LOKI_DATASOURCE_UID`.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
