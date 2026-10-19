# Notebook

Notes that organise themselves. Each note you save is titled, summarised and tagged by
**Qwen 3.8** through the Roar AI gateway, and everything lives in a managed **Postgres**
database. You can search and filter by tag, pin notes, and **ask questions that are answered
only from your own notes** (with clickable citations). An Insights tab shows counts and AI
token usage straight from the database, and you can export everything as JSON.

## Deploy on Roar AI

1. Put these files at the top level of a GitHub repo (`package.json`, `server.js`, `public/`).
2. Roar console → **Apps → New application** → connect GitHub and pick the repo.
3. Choose your region and turn the **database** on (it is created in the same region as the app).
4. On the app's **Environment** tab add `APP_PASSWORD` (any password you choose) and, if you
   need a different model, `QWEN_MODEL`.
5. Launch. Roar injects `ROAR_API_KEY`, `ROAR_BASE_URL` and `DATABASE_URL`.

Tables (`notes`, `qa`, `ai_calls`) are created automatically on first start. Leave Roar's
"migrations" setting on its default — the app creates its own tables.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `QWEN_MODEL` | `qwen3.8-27b-lk` | Model id. `-lk` is the in-country variant. |
| `APP_PASSWORD` | none | If set, the app asks for it (any username). **Set this**, otherwise anyone with the URL can use your AI credit and read your notes. |
| `REASONING_EFFORT` | not sent | Optional `low` / `medium` / `high` for models that support it. |

Do not set `ROAR_API_KEY`, `ROAR_BASE_URL` or `DATABASE_URL`; Roar provides them.

## API

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/notes?q=&tag=` | List / search notes |
| POST | `/api/notes` | Create a note (AI adds title, summary, tags) |
| PUT | `/api/notes/:id` | Edit a note and re-organise it |
| POST | `/api/notes/:id/enrich` | Re-run the AI organiser |
| POST | `/api/notes/:id/pin` | `{ "pinned": true }` |
| DELETE | `/api/notes/:id` | Delete |
| GET | `/api/tags` | Tags with counts |
| POST | `/api/ask` | `{ "question": "…" }` answered from your notes |
| GET / DELETE | `/api/qa`, `/api/qa/:id` | Saved questions and answers |
| GET | `/api/stats`, `/api/status`, `/api/export` | Insights, health, JSON export |

## Run locally

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/notes ROAR_API_KEY=roar_live_... npm start
```

## Notes on how "Ask your notes" works

It scores your notes by keyword matches (title and tags count most), sends the best six to
Qwen, and tells it to answer only from them. If nothing matches, it says so without calling
the model. This is simple and fast for a personal notebook (it looks at your 500 most recent
notes); for thousands of notes you would switch to embeddings.
