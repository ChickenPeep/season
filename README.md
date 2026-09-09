# Season

A quiet home for the semester and a small browser built around it. The home page is one
agenda: Canvas deadlines and your own tasks for the week, what's coming up, your courses,
your git projects, and the files you touched recently. The app wraps that in a sidebar of
spaces (School, Nexum, Business) whose tabs are real web pages with persistent logins.

Runs locally. No accounts, no cloud, no build step, zero runtime dependencies. Node 20+.

## Run it

Two ways in, same data:

```bash
cd ~/Developer/season
npm run app           # the Season app: sidebar of spaces with real browser tabs, board as home
npm run open          # just the board, in your normal browser at http://localhost:4747
```

`npm install` once first (it pulls Electron for the app). `npm start` runs the server without
opening anything. `npm run mock` forces sample Canvas data.

## The app

The left sidebar starts with two fixed rows, Home and Claude, then **spaces** (School, Work,
Business by default; edit them in `config.json` under `shell`). Each space unfolds into tabs
that are real web pages with their own persistent logins. The School space adds one tab per
current Canvas course on its own. Bump `shell.version` in the config to reseed the sidebar.

- Tabs in a space are pinned: closing one puts it to sleep, right-click to remove it.
- Links you open land under **Today**. Drag one onto a space to pin it there.
- `⌘T` new tab, `⌘W` close, `⌘L` address bar, `⌘K` jump anywhere, `⌘\` hide the sidebar,
  `⌘⇧H` back to the board, `⌘1…9` switch tabs, `⌘⇧O` open the page in your default browser.
- Everything stays on your machine. No sync, no accounts.

## Connect Canvas (one-time)

Season reads the same credentials file as the Canvas MCP server in Claude Code, so you
only set the token once:

1. In Canvas: **Account → Settings → Approved Integrations → + New Access Token**.
   If that button is missing, your school has disabled student tokens; ask IT.
2. Edit `~/tools/canvas-mcp/.env`:
   ```
   CANVAS_API_TOKEN=<paste>
   CANVAS_API_URL=https://<your-school>.instructure.com/api/v1
   ```
3. Restart Season. The yellow banner disappears once real data loads.

The token never leaves your machine. Season binds to `127.0.0.1` only and refuses
cross-origin writes.

## Tune it

`config.json` is yours and stays out of git; it is created from `config.example.json` on first run.

| Key | What it does |
|---|---|
| `semester.start` / `end` / `name` | Drives the week counter and the season strip |
| `semester.breaks` | Optional `[{ "label": "Thanksgiving", "start": "2026-11-23", "end": "2026-11-27" }]` shaded on the strip |
| `projects.roots` | Folders scanned for git repositories |
| `files.roots` / `recentDays` / `ignore` | What shows up under Recent files |
| `shell` | The sidebar: fixed rows, spaces, search engine, `version` |

## Keys on the home page

| Key | Action |
|---|---|
| `⌘K` or `/` | Jump to any course, deadline, project, or file |
| `r` | Refresh Canvas and projects |
| `[` `]` | Previous / next week |

## Where things live

- `data/state.json`: your tasks, locally checked-off deadlines, and the sidebar layout
- `data/canvas-cache.json`: the last Canvas pull, so the board paints instantly offline

## Check

```bash
npm run check         # syntax check + unit tests
```
