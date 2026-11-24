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

## Backend: mock or real

`src/api/index.ts` picks the implementation of `PlatformApi` (all calls the dashboard makes; data shapes in
`src/api/types.ts`):

| Setting (`.env.local`) | Uses |
| --- | --- |
| nothing set | **Mock** (`src/api/mock.ts`): in-memory, deploys/backups/restores advance on a timer |
| `VITE_API_URL=http://localhost:8080` | **Real API** (`src/api/http.ts`) running locally (`docker compose --profile api up` in `sample-apps/notes-app`) |
| `VITE_API_URL=` + `VITE_USE_MOCK=false` | **Real API on the same origin**, i.e. the deployed dashboard behind CloudFront (`infra/scripts/up.sh` builds it this way) |

The HTTP client sends the Cognito ID token, adds an `Idempotency-Key` to every POST, turns API errors into
readable messages ("The platform API is not running…" between sessions), and signs the user out on 401.
The sidebar shows whether the cluster is online and when mock data is in use.

Mock-only demos: deploy `failing-tests-demo` and the Test step fails and blocks the release. With the real API,
new deployments go through the GitHub Actions pipeline; redeploying an image from an app's history works.

## Sign-in

`src/lib/auth.tsx` uses Cognito when `VITE_COGNITO_CLIENT_ID` is set (`src/lib/cognito.ts`, no Amplify: one
HTTPS call to Cognito, tokens in `sessionStorage`, refreshed before expiry). Team members are created by
Terraform (`infra/foundation`, `team_emails`); Cognito emails a temporary password and the sign-in page asks
for a new one on first sign-in. Without Cognito settings, sign-in is mocked (any email + 8-character password).

## Hosting

Static build on a private S3 bucket behind CloudFront (`infra/foundation/edge.tf`), same HTTPS origin as
`/api/*` and `/apps/*`. `infra/scripts/up.sh` builds and publishes it; by hand:

```bash
VITE_USE_MOCK=false VITE_COGNITO_CLIENT_ID=... VITE_COGNITO_USER_POOL_ID=... npm run build
aws s3 sync dist s3://<dashboard bucket> --delete
aws cloudfront create-invalidation --distribution-id <id> --paths '/*'
```
