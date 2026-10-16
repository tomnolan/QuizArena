# QuizArena

Compete live. Climb the leaderboard.

A live quiz platform with an admin screen for publishing quizzes and controlling live sessions, plus a player screen for joining and answering questions with a leaderboard at the end and support for 100+ concurrent users. 

![QuizArena info graphic](quiz-arena.png)


## Get it going

The easiest way to get this up and running to use is in Azure. This repo includes Azure Developer CLI (`azd`) configuration for Azure Container Apps in `azure.yaml` and `infra/`. 

This requires you have access to an Azure Subscription. If you want to run it elsewhere, instructions for Docker build are later in this guide.

### Clone the repo

Before running any setup commands, clone this repository and change into the project directory in your terminal:

```bash
git clone <repo-url>
cd quiz-app
```

### Install Azure Developer CLI

Install `azd` from https://aka.ms/azd/install. If you are on windows, open PowerShell and enter:

```powershell
winget install microsoft.azd
```

then open a new terminal and check it is available:

```bash
azd version
```

### Deploy

1. Make sure your terminal is in the repo directory.

   ```bash
   cd quiz-app
   ```

2. Sign in to Azure.

   ```bash
   azd auth login
   ```

3. Create an environment and choose a region.

   ```bash
   azd env new quiz-app
   azd env set AZURE_LOCATION centralus
   ```

4. Set the admin password used by the `/admin` page.

   ```bash
   azd env set ADMIN_PASSWORD "your-strong-password"
   ```

5. **Optional**: set `DATABASE_URL` if you want to use PostgreSQL instead of the default SQLite database. You might want this is if you are hosting quizes for more than 100 people to enable better database persistence and replication as the app tier scales out.

   ```bash
   azd env set DATABASE_URL "postgres://user:password@host:5432/database?sslmode=require"
   ```

   If `DATABASE_URL` is not set, the Azure deployment uses SQLite on the container filesystem and runs one Container Apps replica. This is suitable for demos, but data can be lost when the container is replaced. Use PostgreSQL for durable Azure hosting.

### Migrate existing SQLite data to PostgreSQL

If you already have data in SQLite and want to switch to PostgreSQL, run the migration script in [scripts/migrate-sqlite-to-postgres.mjs](scripts/migrate-sqlite-to-postgres.mjs).

1. Set `DATABASE_URL` for your PostgreSQL server.

   **Windows (PowerShell):**

   ```powershell
   $env:DATABASE_URL = 'postgresql://user:password@host:5432/database?sslmode=require'
   ```

   **macOS/Linux (Bash):**

   ```bash
   export DATABASE_URL='postgresql://user:password@host:5432/database?sslmode=require'
   ```

2. Run the migration script from the repo root.

   **Windows (PowerShell):**

   ```powershell
   node .\scripts\migrate-sqlite-to-postgres.mjs
   ```

   **macOS/Linux (Bash):**

   ```bash
   node ./scripts/migrate-sqlite-to-postgres.mjs
   ```

3. The script prints source and target row counts for quizzes, questions, attempts, live_sessions, live_answers, quiz_runs, run_players, and site_settings.

4. If you want to migrate from a non-default SQLite file, set `SQLITE_PATH` first.

   **Windows (PowerShell):**

   ```powershell
   $env:SQLITE_PATH = '.\data\quiz.sqlite'
   node .\scripts\migrate-sqlite-to-postgres.mjs
   ```

   **macOS/Linux (Bash):**

   ```bash
   export SQLITE_PATH=./data/quiz.sqlite
   node ./scripts/migrate-sqlite-to-postgres.mjs
   ```

Notes:
- The script is safe to re-run because it uses upsert behavior.
- Run migration before scaling out so all replicas use the same PostgreSQL-backed data set.

5. Preview the infrastructure changes.

   ```bash
   azd provision --preview
   ```

6. Deploy the app.

   ```bash
   azd up
   ```

`azd up` prints the deployed web URL when it finishes.

To remove the Azure resources later:

```bash
azd down
```

## Non Azure setup: Docker Compose

This is the simplest way to hand the app to someone else. They only need Docker installed.

### Install Docker

Install Docker before running the app with Docker Compose:

- macOS or Windows: install Docker Desktop from https://www.docker.com/products/docker-desktop/
- Linux: install Docker Engine from https://docs.docker.com/engine/install/

After installing Docker, open a new terminal and check that Docker Compose works:

```bash
docker compose version
```

Then start the app:

1. Clone the repo and enter the folder.

   ```bash
   git clone <repo-url>
   cd quiz-app
   ```

2. Pick an admin password and start the app.

   **Windows (PowerShell):**

   ```powershell
   $env:ADMIN_PASSWORD = 'your-strong-password'
   docker compose up --build
   ```

   **macOS/Linux (Bash):**

   ```bash
   ADMIN_PASSWORD="your-strong-password" docker compose up --build
   ```

3. Open the app.

   - Player view: http://localhost:3000
   - Admin view: http://localhost:3000/admin

Quiz data is stored in a Docker volume named `quiz-data`, so it survives container restarts and rebuilds.

To stop the app:

```bash
docker compose down
```

To delete all saved quiz data as well:

```bash
docker compose down --volumes
```

## Local Development

Use Node 24 because the server uses the built-in `node:sqlite` module.

1. Install dependencies.

   ```bash
   npm install
   ```

2. Set an admin password in the same terminal you will use to start the app.

   **Windows (PowerShell):**

   ```powershell
   $env:ADMIN_PASSWORD = 'your-strong-password'
   ```

   **macOS/Linux (Bash):**

   ```bash
   export ADMIN_PASSWORD="your-strong-password"
   ```

   `export` is a Bash command, not a PowerShell command. PowerShell uses `$env:NAME = 'value'`. These assignments apply to the current terminal session and programs started from it.

3. Run the frontend and backend together.

   ```bash
   npm run dev
   ```

4. Open http://localhost:5173.

## Production Build Without Docker

**Windows (PowerShell):**

```powershell
npm ci
npm run build
$env:ADMIN_PASSWORD = 'your-strong-password'
npm start
```

**macOS/Linux (Bash):**

```bash
npm ci
npm run build
ADMIN_PASSWORD="your-strong-password" npm start
```

The production server listens on `PORT`, defaulting to `3001` outside Docker.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `change-me` | Password required for admin actions. Set this before sharing or hosting the app. |
| `PORT` | `3001` locally, `3000` in Docker | HTTP port for the production server. |
| `DATABASE_PATH` | `data/quiz.sqlite` locally, `/app/data/quiz.sqlite` in Docker | SQLite database location. |
| `DATABASE_URL` | empty | Optional PostgreSQL connection string for shared hosting. |

Admin actions like saving drafts, publishing/unpublishing, editing, copying, and deleting quizzes, changing site settings, and starting, advancing, or aborting live sessions are locked behind the admin password gate in the UI and enforced on the server.

## Authoring and running quizzes

1. Open `/admin`. Only the unlock screen is displayed until you enter the admin password. Unlocking opens the **Quizzes** library, showing saved drafts and published quizzes, or a prompt to create your first quiz.
2. Click **Create new quiz** to open the standalone editor. **Save draft** keeps an unpublished quiz, including incomplete questions, in the admin library; a title is required. **Publish quiz** requires complete questions and makes the quiz available to players. Drafts cannot be joined or started, and their questions and images are not publicly available. **Back to quizzes** returns to the library without saving unsaved changes.
3. **Select** opens a published or previously run quiz's hosting view, with live controls at the top, saved **Run history**, and quiz actions below. Selecting an unused draft opens its editor instead. The library, live controls, site settings, and editor are separate views; use **Back to quizzes** to return to the library. Published quizzes remain editable until their first live start. Once started, editing is permanently locked, even if nobody answers or the session has finished or been aborted; the quiz can still be published and run again unchanged.
4. **Copy to new quiz** is available for every saved quiz, including drafts, published quizzes, and quizzes that have already been run or are currently live. It creates an independent draft and opens its editor, copying questions, correct answers, images, summaries, timers, and reveal settings, but no live-session state or results. Changes to the copy never change the original quiz or its scores.
5. Each question supports four lettered answers, a correct-answer selection integrated into the right side of each answer textbox, optional before/after pictures, an optional post-question summary, and its own answer timer. Timers default to 60 seconds and must be whole numbers of at least **20 seconds**. Question editors collapse like saved question summaries; opening an existing quiz, copy, or import starts with questions collapsed. New questions start expanded. Click the question heading to expand or collapse it.
6. **Before answer reveal** and **After answer reveal** are separate optional image slots. Paste an HTTP(S) image URL, or upload a PNG, JPEG, GIF, or WebP file up to **2 MB** per slot. When a Before picture is present, **Use before picture after reveal**, the first input in the After image area, keeps that picture displayed at reveal. The separate After controls and preview are grayed out with **Before picture will be used instead**; their saved image is retained and becomes available again when you uncheck the option. **Swap before / after images** exchanges the two saved slots, or moves a single image into the other slot; it is disabled when both are empty or an upload is in progress. Reuse stays checked if the new Before slot is populated after swapping; it is cleared and hidden if that slot becomes empty (including when removing the Before picture). Existing pictures remain Before images, with reuse off by default. Without reuse, the Before picture is replaced by the After picture at reveal, or removed if After is empty. After/reused images require reveal mode to appear during play. Uploaded images are stored with the quiz in the database and served separately, rather than retransmitted with each live-state poll. They do not depend on a local file or a particular server replica. Quiz saves have a 32 MB total request limit. External image URLs must be accessible to players.
7. Enable **Reveal the correct answer, summary, and stats when time expires** to show the correct answer and explanation automatically at the end of each timer. In the player view, the post-question summary and stats appear above **Your answer** and the lettered answer choices. Live reveals and admin saved-question summaries use the same three responsive cards: a full-width stacked results bar with correct/incorrect/did-not-answer counts, percentages and color key; one player-scaled bar per answer with a single-line truncated label (hover for the full text); and the five fastest responses, colored green for correct and red for incorrect. Response times measure the saved answer, so changing an answer updates its time. Participation counts include everyone who joined the current run, even if they never answered. The admin's live status uses compact cards and a full-width countdown progress bar, with **Reveal answer now**, **Next question**, or **Finish quiz** immediately below it. Both the admin and player timers pulse red during the final **10 seconds**, then stay red at zero; reduced-motion preferences disable the pulsing. Players' **Leave quiz** is a small button at the top right of the play area.
8. Use **Select** in the library, then **Start quiz**. This opens a **holding screen**, creates the join code, and includes waiting players without displaying a question or starting a timer. **Start quiz** is hidden during an active run (holding, answering, or revealing); finish or abort that run before starting another. Players see **The quiz is about to start**. Display **Join Now** while everyone joins, then click **Begin first question** to display question one and start its full answer timer. The holding screen lasts until the admin explicitly begins. In reveal mode, **Reveal answer now** can end answering early; after reveal, **Next question** (or **Finish quiz** on the final question) advances. The revealed answer stays visible until the admin advances. With reveal mode disabled (the default for existing quizzes), answers remain hidden.
9. When the admin finishes, players automatically see a prominent **Final leaderboard** dialog for that live run, including their own score. They can close and reopen it. If completed stats sharing is enabled for the quiz, the dialog includes **View full quiz stats**, linking to that run's report. The recent leaderboard remains available below the player view for historical results.

**Delete** in the quiz library asks for confirmation before permanently deleting a quiz, its questions, saved runs, and scores. **Remove question** in the editor is a red danger button and also asks for confirmation; canceling either prompt leaves the quiz unchanged. Removing a question only affects saved quiz content when the editor is saved.

### Site text and mobile joining

- From the unlocked admin library, open **Site settings** to change the home page title and subtitle. Settings are saved in the database and apply to all visitors.
- The home page's **Join a live quiz** area requires a **6-digit event code**; there is no quiz dropdown or direct quiz-ID joining. Until **Find quiz** resolves a code, quiz content stays hidden. An active event shows player-name entry, quiz details, and a QR code; a completed event only shows its stats report when the admin has enabled sharing. Changing the entered code or a failed/expired lookup clears the previous result. A code-bearing QR link can resolve the event automatically.
- After an active event is found, enter a player name and click **Join quiz**. The name box has an **Enter your name** placeholder that disappears on focus; validation and lookup failures use pink/red error boxes. The event's QR code carries its event code so players on another device go through the same lookup flow. The **Play on your phone** prompt and QR code are hidden on small screens (600px or less) and touch-first devices, including landscape phones; the separate admin **Join Now** display keeps its QR code. On answer reveal, players see **You got it right!** in green or **You got it wrong.** in red above the summary and stats. The answer choices remain below: the correct choice is green and the player's selected incorrect choice is pink.
- The admin must click **Start quiz** to open the holding screen and allocate the event code before players can join. Players joining during that hold see **The quiz is about to start**. In the admin hosting view, **Active players** shows their names and a live count before any question is started. The roster is admin-only and refreshes with the live controls. **Begin first question** includes connected waiting players without requiring them to join again; players who left or timed out during the hold are excluded.
- **Leave quiz** removes a player from the active roster immediately. Closing or navigating away from the page sends a best-effort leave notification; if the browser disconnects without sending it, the player disappears after **90 seconds** without a successful live-state poll. This grace period tolerates background-tab timer throttling. Leaving or timing out during a run does not erase that player's answers or saved scores. Active presence is separate from historical participation and is not copied during database migration; players should rejoin after moving the app to a new server.
- Each new live run receives a fresh **6-digit event code**. Players enter it in **6-digit event code** on the home page, click **Find quiz**, and then join with their name. The server also requires the matching active code and run when registering the player.
- Event-code searches are limited to **20 requests in a rolling 60-second window per browser/device**, including unsuccessful searches. The next search returns HTTP **429** with `Retry-After` and **You have searched too many times. Please try again in a few minutes.** Normal gameplay, presence updates, and Join Now display polling do not consume lookup attempts. The small limiter uses the existing database (no extra service or package), so replicas using the same PostgreSQL database share the same allowance, and restarting the app does not reset it. Browser identity uses local storage: devices on the same Wi-Fi have independent allowances, but clearing storage, using another browser/profile, or private browsing creates a new identity. This is a per-browser convenience limit, not a tamper-proof abuse-prevention boundary. Temporary lookup counters, like active presence, are not copied by the SQLite-to-PostgreSQL migration utility.
- From the holding screen or a running quiz, **Display Join Now** opens a separate, projector-friendly page showing a large QR code and the join code, without exposing admin controls or credentials. Players can join during the hold; the code stays the same when the admin begins the first question. Codes stop accepting players when their run finishes or is aborted.
- QR images are generated locally in the browser, not by an external QR service.
- **For local phone testing:** use the same network on the phone and computer. Open the app using the computer's LAN address (for example, `http://192.168.1.10:5173` for development), or save that address in **Player-facing URL** under **Site settings**. Leave this setting blank on a deployed site to use its current address. **Do not use `localhost` in a phone's QR link**: it refers to the phone itself. Vite already listens on all interfaces; allow its port through Windows Firewall on your private network if necessary.

### Exporting and importing quizzes

1. Unlock `/admin`, then click **Export quiz** on any quiz in the library, or in its hosting view. The browser downloads a `.quizarena.json` file. Drafts, unpublished quizzes, and previously run quizzes can all be exported; exporting does not change them. Export saves the current **saved** content, not unsaved editor changes.
2. To restore or transfer a quiz, click **Import quiz** in the admin library and select that JSON file. The import creates a **new, editable, unpublished draft** and opens its editor. Review it, then click **Publish quiz** when ready. Importing never overwrites an existing quiz, even when names match; importing the same file twice creates two independent drafts.
3. The file includes the title, description, reveal setting, completed-stats sharing setting (`displayStats`), ordered questions, four answer options per question, correct-answer indexes, individual timers, post-question summaries, and optional Before/After images. `imageUrl` is the Before image; `afterImageUrl` is the separate saved After image; `reuseBeforeImage` controls whether the Before image is used at reveal instead. Uploaded images are embedded as base64 data URLs such as `data:image/png;base64,...`, so no separate image files or original app instance are needed. External HTTP(S) image URLs remain links; their contents are not downloaded or embedded. Older version-1 exports without `afterImageUrl`, `reuseBeforeImage`, or `displayStats` still import with an empty After slot, reuse disabled, and completed stats sharing off.
4. Export/import uses the versioned format below. Files are limited to **32 MB** (32,000,000 bytes), with the existing **2 MB** limit per uploaded image. Invalid JSON, unsupported versions, invalid timers/options/images, and incomplete file structures are rejected without saving a partial quiz. Incomplete question text/options from saved drafts are allowed, but must be completed before publishing.

```json
{
  "format": "quizarena.quiz",
  "version": 1,
  "exportedAt": "2026-10-16T01:00:00.000Z",
  "quiz": {
    "title": "Example quiz",
    "description": "A portable quiz",
    "revealAnswers": true,
    "displayStats": false,
    "questions": [
      {
        "prompt": "Which answer is correct?",
        "options": ["First", "Second", "Third", "Fourth"],
        "correctOptionIndex": 1,
        "answerSeconds": 20,
        "imageUrl": "",
        "afterImageUrl": "",
        "reuseBeforeImage": false,
        "explanation": "The second answer is correct."
      }
    ]
  }
}
```

Quiz exports include the answer key, so export/import requires admin access. They do **not** include database IDs, publication/run-lock state, players, scores, run history, join codes, presence, or site settings. Use a database backup if you need to preserve all app data. If the currently deployed version does not yet support export, back up its database **before** redeploying; deploying this feature does not first export data from the old container.

#### Export directly from a SQLite backup

Using Node 24, run the [SQLite export utility](scripts/export-sqlite-quizzes.mjs) locally. It does not start the app or modify/migrate the backup.

```powershell
node .\scripts\export-sqlite-quizzes.mjs .\private\sqlite-backup-20261015.sqlite
```

This creates one `.quizarena.json` file per quiz in `private\quiz-exports`, which is ignored by Git. Import those files individually through **Import quiz** in the admin library. Older backups without images, summaries, timers, or reveal settings export with no image/summary, a 60-second timer, and reveal disabled. Completed stats sharing defaults off in older backups. Newer backups retain those fields, including both Before/After uploaded base64 image slots, the Before-image reuse setting, and completed stats sharing. Scores and sessions are not exported.

An optional second argument selects another output folder. Existing export files are never overwritten; to export again, choose a fresh folder:

```powershell
node .\scripts\export-sqlite-quizzes.mjs .\private\sqlite-backup-20261015.sqlite .\private\quiz-exports-second-copy
```

### Saved runs, unpublishing, and aborting

- **Allow players to view completed quiz stats** is off by default. Enable it in the quiz editor or its hosting view. The hosting toggle remains available after a quiz has been run and does not unlock or change the questions. It applies to **all completed runs** of that quiz, including runs finished before the setting was enabled.
- While sharing is enabled and the quiz is published, entering a completed run's original event code on the home page (or opening its `/?code=...` link) shows that specific run's leaderboard, question text, correct answers, explanations, answer-option counts, correct/incorrect/unanswered counts, percentages, and fastest responses using the same cards as live reveals. Player names appear in the leaderboard and fastest-response lists. The final leaderboard popup also includes a **View full quiz stats** link. Viewing stats does not join the run or create scores, and the existing code lookup rate limit still applies.
- Turning sharing off or unpublishing immediately blocks new access through completed codes and removes the link from refreshed player results. An open report is hidden on the next home-page refresh. Republish or re-enable sharing to restore access to the original reports. Aborted runs are never shared through their codes. Historical runs without a saved event code remain available to admins only.
- **Run history** shows each finished or aborted run separately. Choose a saved run to view its leaderboard, player count, questions shown, correct/incorrect totals, per-option counts, unanswered counts, and fastest responses. Registered players who submit no answers receive a score of zero.
- **Start quiz** creates an independent run in the holding screen without deleting previous results. There is no restart action: finish or explicitly **Abort run** before starting another. The server also rejects attempts to start over an active run, preserving its join code, timer, answers, and history. Aborting during the hold records zero questions shown and does not post completed scores. Time spent holding is not included in question response times.
- **Abort run** immediately stops accepting answers without requiring the admin to advance through remaining questions. Partial statistics are retained in history, labelled aborted, and are **not** posted as completed scores.
- Players already in an old run retain that run's final results or aborted message when another run starts. They must leave and rejoin to play the new run; late answers from old runs cannot be counted in the new one.
- **Unpublish** hides a quiz from the home page without deleting its questions, history, or scores. Finish or abort an active run first. A used, unpublished quiz remains selectable in the admin library for reviewing history and can be republished with **Publish** without unlocking question editing. Deleting a quiz still deletes its data.

Existing SQLite and PostgreSQL databases are upgraded automatically at server startup. Existing quizzes remain published, and quizzes with an existing non-idle live session or saved attempts are marked as already run. Older questions retain their 60-second timers and start without images or summaries. Older saved scores are imported into run history in completion-time batches; any remaining current-run response data is also preserved. Question details or timing data already discarded by older restarts cannot be reconstructed and are shown as unavailable rather than invented. The SQLite-to-PostgreSQL migration script supports both old and upgraded databases and preserves run history, joined players, site settings, publication, and run-lock state.

## Validation

Using Node 24, run `npm test` for isolated API integration tests (including database upgrades), `npm run build` for client/server type checks and production output, and `npm run lint` for lint checks. Tests use temporary SQLite databases and do not touch saved quiz data.
