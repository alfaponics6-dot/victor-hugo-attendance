# Victor Hugo - Plataforma de Asistencia Digital

Internal attendance app for Universidad EARTH's "Escenario Forestal 2026"
program. Project leaders mark daily attendance for the students currently
assigned to their rotation; profesores get a cross-project absence dashboard;
admins manage students and rosters.

## Stack

- **server/** - Node.js + Express + SQLite (`better-sqlite3` would be tighter
  but the project uses `sqlite3`). JWT auth via HttpOnly cookie, Helmet,
  rate-limiting, multer for attachments.
- **client/** - React 19 + Vite + axios + recharts. Production bundle is
  served by a tiny `server.cjs` static-file proxy.
- **data/** - `EF_IC_Cuatrimestre_2026F.xlsx`: master roster used to seed the
  DB on first boot.
- **docs/** - leader manual (LaTeX source + built PDF).

## Roles

| Role       | Login credential               | Scope                                                    |
|------------|--------------------------------|----------------------------------------------------------|
| `leader`   | shared `LEADER_ACCESS_CODE`    | Their own project: mark attendance, manage that roster   |
| `profesor` | personal password              | Read-only across all projects, absence dashboard         |
| `admin`    | personal password              | Full read/write across all projects                      |

## First-time setup

```powershell
# 1. Install dependencies
cd server
npm install
cd ../client
npm install
cd ..

# 2. Configure the server environment
cp server/.env.example server/.env
# Then edit server/.env:
#   - JWT_SECRET   : node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
#   - LEADER_ACCESS_CODE : a code you can share with leaders in person
#   - CORS_ORIGINS : comma-separated list of allowed origins
#   - NODE_ENV=production for the public-tunnel deployment

# 3. Seed the database
# The first server start auto-imports projects + leaders from
# data/EF_IC_Cuatrimestre_2026F.xlsx. Set the initial admin password via the
# /auth/setup-status flow or the script below.

# 4. Set the admin password
cd server
npm run reset-password

# 5. (Optional) Add a profesor account
npm run add-profesor

# 6. (Once per cuatrimestre) Import rotation assignments
npm run import-rotations -- 2026-02-09   # the start date of rotation #1
```

## Running

### Local development

```powershell
# Terminal 1
cd server
npm run dev

# Terminal 2
cd client
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to the server.

### Production with public tunnel (Cloudflare Quick Tunnel)

```powershell
.\start-secure.bat
```

The script:

1. Checks Node.js and `cloudflared.exe` (downloads the tunnel binary on first run).
2. Finds free ports (server: 3000–3020, client: 5173–5183).
3. Installs deps if `node_modules` is missing.
4. Starts the API server (`npm run dev` in `server/`).
5. Builds the client and serves it via `client/server.cjs`.
6. Starts a Cloudflare quick tunnel pointed at the client (which proxies
   `/api/*` to the server). The public URL is printed in the tunnel's window.

`Ctrl+C` in the tunnel window stops everything.

### Production (Oracle Cloud / any Linux VM)

See **[deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md)** for the full walkthrough.
The short version:

- nginx terminates TLS (certbot-managed Let's Encrypt cert) and serves
  `client/dist/` directly + reverse-proxies `/api/*` to the Node API on
  127.0.0.1:3000.
- systemd manages the API (`victorhugo-api.service`) with auto-restart,
  sandboxing, and a 1 GB memory cap.
- Daily SQLite backups via cron, last 30 kept locally; ship to object storage
  for off-host durability.
- `node server/scripts/load-test-attendance.js --waves=2` against the
  production URL confirms the concurrency story before going live.

### Concurrency guarantee

The API is built to survive every leader pressing "Guardar" at the same
moment. Specifically:

- Every bulk-attendance submission is serialized through a JS-level mutex in
  `server/src/config/database.js`. The sqlite3 binding has one underlying
  connection, so the mutex is what prevents "cannot start a transaction
  within a transaction" races.
- The duplicate-project-date check happens **inside** the transaction, so two
  leaders on the same project can't both pass an outer check and both
  insert. The losing submitter gets a clean `409` with a "Asistencia ya
  guardada" message.
- SQLite is configured with `journal_mode=WAL`, `synchronous=NORMAL`, and
  `busy_timeout=10000ms` — durable across crashes, ~20× faster commits than
  `synchronous=FULL`.
- Load test: 14 leaders submitting simultaneously → 7 successes (one per
  project) + 7 clean 409 conflicts + 0 server errors, wave clock time
  ~1.3 seconds.

Re-run the load test any time with:

```bash
cd server
BASE=http://127.0.0.1:3000/api LEADER_ACCESS_CODE=<your-code> \
  node scripts/load-test-attendance.js --waves=2 --date=2099-01-01
```

## Security model

- **Leaders** authenticate with the shared `LEADER_ACCESS_CODE`. Rotate it if
  it leaks; restart the server to reload the env. Tokens already issued
  remain valid until they expire (default 8h).
- **Admins/profesores** have personal bcrypt-hashed passwords stored in the
  DB. The `change-password` endpoint requires the current password.
- The JWT lives in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The
  Authorization header is still accepted for scripted use.
- CORS is enforced with a strict allowlist regardless of `TRUST_PROXY`. Set
  `CORS_ORIGINS` for any new origin.
- Auth endpoints are rate-limited (10/min); the rest of `/api/*` at 200/min.
- File uploads are validated by extension, size (5MB), MIME type, AND magic
  bytes (defense against renamed executables).
- Attachments are served only through `/api/attendance/attachment/...` -
  there is no public `/uploads` static mount.
- All cross-project reads are scoped: leaders only see their own project.

## Routine ops

| Task                               | Command                                              |
|------------------------------------|------------------------------------------------------|
| Backup the SQLite DB               | `cd server && npm run backup`                        |
| Reset admin password (CLI)         | `cd server && npm run reset-password`                |
| Add a profesor                     | `cd server && npm run add-profesor`                  |
| Re-import rotations                | `cd server && npm run import-rotations -- YYYY-MM-DD`|
| Re-seed projects/leaders (admin UI) | POST `/api/admin/reimport-spreadsheet`              |

## Project layout

```
.
├── client/                  # React + Vite frontend
│   ├── src/
│   │   ├── api/client.js    # axios wrapper, all API calls
│   │   ├── pages/           # Login, Dashboard, AdminDashboard, ProfesorDashboard, ...
│   │   ├── components/      # common + features
│   │   ├── context/AuthContext.jsx
│   │   └── utils/dateUtils.js
│   ├── server.cjs           # Static-file + API proxy used by start-secure.bat
│   └── vite.config.js
├── server/                  # Express + SQLite backend
│   ├── src/
│   │   ├── index.js         # Express bootstrap
│   │   ├── config/database.js
│   │   ├── middleware/      # auth, validation, upload, errorHandler
│   │   ├── routes/          # auth, projects, attendance, statistics, admin
│   │   └── utils/           # excelParser, rotationImporter
│   ├── scripts/             # CLI: backup, reset-password, add-profesor, import-rotations
│   └── attendance.db        # SQLite (gitignored)
├── data/                    # Seed spreadsheet
├── docs/                    # Leader manual (LaTeX + PDF)
└── start-secure.bat         # One-click launch + Cloudflare tunnel
```

## Database schema

`projects → leaders, students, rotations`. `attendance` references
`students`, `projects`, `leaders` with the appropriate `ON DELETE` policy
(cascade for student/project deletion, set null for leader). The schema is
created on first boot if missing; existing databases are not auto-migrated to
the new cascade rules.

## License

MIT - see `server/package.json`.
