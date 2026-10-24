# Dashboard

The web dashboard for the platform: team sign-in, apps, deployments, backups, and restores.
React 19 + Vite + TypeScript + Tailwind CSS.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check and build to dist/
```

## Pages

| Route | What it does |
| --- | --- |
| `/` | Landing page |
| `/signin` | Team sign-in (Cognito) |
| `/apps` | All apps, health, image versions, and the **Deploy new app** workbench |
| `/apps/:appId` | One app: URL, source, health, image history with redeploy, backups, logs |
| `/backups` | Backup history, manual backups, restores into a new database with a recovery URL |
| `/settings` | Account, approved repositories, platform defaults |

## Mock mode (current)

The backend isn't deployed yet, so everything runs against an in-memory mock
([`src/api/mock.ts`](src/api/mock.ts)). Deploys, backups, and restores advance step by step on a
timer, the way the real Kubernetes Jobs will. State resets when the page reloads.

- **Sign in:** any email plus a password of 8+ characters.
- **Failed release demo:** deploy `failing-tests-demo`; the Test step fails and blocks the release.

## Connecting the real backend

- **API:** [`src/api/index.ts`](src/api/index.ts) defines `PlatformApi`, the full list of calls the
  dashboard makes, and [`src/api/types.ts`](src/api/types.ts) defines the data shapes. Long-running
  work returns an `Operation` that the dashboard polls with `getOperation(id)`. Add an HTTP client
  that implements `PlatformApi` against `VITE_API_URL` and export it from `index.ts`.
- **Sign-in:** [`src/lib/auth.tsx`](src/lib/auth.tsx) is the only file that changes. Replace the
  mock `signIn`/`signOut` with Amplify Auth using the Cognito user pool from Terraform.

Copy `.env.example` to `.env.local` and fill in the values once they exist.
