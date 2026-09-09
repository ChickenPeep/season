# Season

One board for the semester. Canvas deadlines plotted across every week of the term, a
week-by-week game plan, your git projects with their branch state and open PRs, the files
you touched recently, pinned links, a focus timer, and a ⌘K jump-to-anything palette.

Runs locally. No accounts, no cloud, no build step, zero npm dependencies. Node 20+.

## Run it

```bash
cd ~/Developer/season
npm run open          # starts the server and opens http://localhost:4747
```

`npm start` starts without opening a browser. `npm run mock` forces sample Canvas data.

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
| `pins` | Links that always show under Pinned |

## Keys

| Key | Action |
|---|---|
| `⌘K` or `/` | Jump to any course, deadline, project, file, pin, or action |
| `r` | Refresh Canvas and projects |
| `[` `]` | Previous / next week in the game plan |
| `f` | Start or stop a 25-minute focus block |
| `t` | Whiteboard / chalkboard |

## Where things live

- `data/state.json`: your tasks, pins, focus history, and locally checked-off deadlines
- `data/canvas-cache.json`: the last Canvas pull, so the board paints instantly offline

## Check

```bash
npm run check         # syntax check + unit tests
```
