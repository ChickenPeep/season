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
npm run app           # the app: sidebar of spaces with real browser tabs, Home as the first tab
npm run open          # just the home page, in your normal browser at http://localhost:4747
```

On a Mac, build a proper application first so it appears in Spotlight and the Dock
under its own name and icon rather than as "Electron":

```bash
npm run install-app
```

That puts `Season.app` in your Applications folder. It links back to this folder, so
editing the code still changes the app. To rename it, change `productName` in
`package.json` and run it again — the old one is removed for you.

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
- A page that opens a new window (a Canvas external tool, a sign-in popup) becomes a tab.
- **Terminal** sits at the top of the sidebar. It is a real shell, not a command box:
  editors, pagers and anything that draws a full screen work, colours work, and it
  resizes with the window. `⌘⌥T` opens another; each one is listed under Terminal.
  Right-click a terminal for a new one in the same folder. The palette can start one
  in any of your projects — search a project name and pick "Terminal here".
- Everything stays on your machine unless you turn on sync below.

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

## Two computers

Season syncs your tasks, checked-off deadlines, spaces and semester dates between
machines through a **private GitHub repository**. Nothing is published; the repo is
private and holds one small JSON file.

Set it up once per machine:

```bash
npm run sync:setup
```

The first machine creates the repo. The second finds it and joins. Both need the
[GitHub CLI](https://cli.github.com) signed in with `gh auth login` — Season borrows
that sign-in rather than asking for a token of its own.

After that it looks after itself. Season syncs when it starts, a couple of seconds
after you change something, every five minutes, and whenever you come back to the
window. The **Sync** button on Home (and in the app's sidebar) forces it and shows
when it last ran; press `s` on Home for the same thing.

**Editing on both machines at once is safe.** Records merge one at a time rather than
whole files, so a task you add on the laptop and a deadline you tick off on the desktop
both survive. If the same task is edited in two places the newer edit wins. Deleting a
task deletes it everywhere. If both machines happen to save at the same instant, GitHub
rejects the second write and Season merges again instead of overwriting.

What does **not** travel: which tab is open, where a tab last navigated, your loose
"Today" tabs, and any file path in `config.json`. Those are per-machine on purpose,
because `~/Developer` and `C:\Users\you\Developer` are not the same place.

### Windows

Season runs on Windows the same way. Install [Node](https://nodejs.org) and the
[GitHub CLI](https://cli.github.com), then:

```bash
git clone https://github.com/ChickenPeep/season.git
cd season
npm install
gh auth login
npm run sync:setup
npm run app
```

Put your Canvas token in a `.env` next to the repo or set `CANVAS_API_TOKEN` and
`CANVAS_API_URL` as environment variables — the token itself is never synced.
Then edit `config.json` so `projects.roots` and `files.roots` point at your Windows
folders. Those stay local, so changing them will not affect the Mac.


## Tune it

`config.json` is yours and stays out of git; it is created from `config.example.json` on first run.

| Key | What it does |
|---|---|
| `semester.start` / `end` / `name` | Drives the week counter and the season strip |
| `semester.breaks` | Optional `[{ "label": "Thanksgiving", "start": "2026-11-23", "end": "2026-11-27" }]` shaded on the strip |
| `projects.roots` | Folders scanned for git repositories |
| `files.roots` / `recentDays` / `ignore` | What shows up under Recent files |
| `shell` | The sidebar: fixed rows, spaces, search engine, `version` |
| `sync.repo` | The private GitHub repo used to sync; `npm run sync:setup` fills it in |
| `sync.auto` | Set false to sync only when you press the button |

## Keys on the home page

| Key | Action |
|---|---|
| `⌘K` or `/` | Jump to any course, deadline, project, or file |
| `r` | Refresh Canvas and projects |
| `s` | Sync with your other computer |

In the app: `⌘⌥T` new terminal, `⌘T` new tab, `⌘W` close, `⌘L` address bar, `⌘K` jump,
`⌘\` hide the sidebar, `⌘⇧H` Home.
| `[` `]` | Previous / next week |

## Where things live

- `data/state.json`: your tasks, checked-off deadlines, and the sidebar layout
- `data/device.json`: this machine's name and id, used to label it in sync

Terminals are not saved: a shell cannot outlive the app, so closing it ends the session.
- `data/canvas-cache.json`: the last Canvas pull, so the board paints instantly offline

## Check

```bash
npm run check         # syntax check + unit tests
```
