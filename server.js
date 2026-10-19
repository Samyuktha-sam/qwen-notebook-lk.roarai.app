// Notebook — notes that organise themselves, answered by Qwen 3.8 via the Roar AI gateway.
// Storage: managed Postgres (DATABASE_URL). Roar injects ROAR_API_KEY, ROAR_BASE_URL, DATABASE_URL.
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.ROAR_BASE_URL || "https://api.roar-ai.com/v1").replace(/\/+$/, "");
const API_KEY = process.env.ROAR_API_KEY || "";
// In-country Qwen 3.8 variant (shown as "Served in-country" in the Roar console). Override with QWEN_MODEL.
const MODEL = process.env.QWEN_MODEL || "qwen3.8-27b-lk";
const REASONING = process.env.REASONING_EFFORT || ""; // optional: low | medium | high
const APP_PASSWORD = process.env.APP_PASSWORD || "";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- optional password gate (HTTP Basic, any username) ----------
app.use((req, res, next) => {
  if (!APP_PASSWORD || req.path === "/healthz") return next();
  const hdr = req.headers.authorization || "";
  const given = Buffer.from(hdr.replace(/^Basic /, ""), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(given), b = Buffer.from(APP_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Notebook"').status(401).send("Password required");
});

// ---------- database ----------
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notes (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    pinned BOOLEAN NOT NULL DEFAULT false,
    ai_status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS qa (
    id SERIAL PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    source_ids TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ai_calls (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

let pool = null;
let dbError = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function initDb() {
  if (!process.env.DATABASE_URL) {
    dbError = "DATABASE_URL is not set. Turn on the database for this app in the Roar console, then redeploy.";
    return;
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  for (let i = 1; i <= 5; i++) {
    try {
      await pool.query(SCHEMA);
      dbError = null;
      return;
    } catch (e) {
      dbError = "Database not reachable: " + e.message;
      console.error(`DB init attempt ${i} failed:`, e.message);
      await sleep(2000 * i);
    }
  }
}

const q = (text, params) => pool.query(text, params);

// ---------- helpers ----------
const ah = (fn) => (req, res) =>
  fn(req, res).catch((e) => res.status(e.status || 500).json({ error: e.message, requestId: e.requestId || undefined }));

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const tagList = (s) => (s ? s.split(",").map((t) => t.trim()).filter(Boolean) : []);
const normTags = (arr) =>
  [...new Set((Array.isArray(arr) ? arr : []).map((t) => String(t).toLowerCase().replace(/[,#]/g, "").trim().slice(0, 24)).filter(Boolean))]
    .slice(0, 6)
    .join(",");
const present = (r) => ({ ...r, tags: tagList(r.tags) });
const stripThink = (s) => String(s || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
const likeEscape = (s) => s.replace(/[\\%_]/g, "\\$&");

function parseJsonLoose(text) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

async function callQwen(kind, messages) {
  if (!API_KEY) throw httpErr(500, "ROAR_API_KEY is not set (Roar injects it when the app is deployed).");
  const body = { model: MODEL, messages };
  if (REASONING) body.reasoning_effort = REASONING;
  const r = await fetch(BASE_URL + "/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = httpErr(502, String((j.error && (j.error.message || j.error)) || `Gateway error ${r.status}`));
    e.requestId = r.headers.get("x-roar-request-id");
    throw e;
  }
  const u = j.usage || {};
  await q("INSERT INTO ai_calls (kind, prompt_tokens, completion_tokens) VALUES ($1,$2,$3)",
    [kind, u.prompt_tokens || 0, u.completion_tokens || 0]).catch(() => {});
  return stripThink(j.choices?.[0]?.message?.content);
}

// Ask Qwen to title / summarise / tag a note. Never throws: a failed call just marks ai_status = 'failed'.
async function enrich(id) {
  const { rows } = await q("SELECT * FROM notes WHERE id=$1", [id]);
  const note = rows[0];
  if (!note) return null;
  try {
    const text = await callQwen("enrich", [
      {
        role: "system",
        content:
          'You organise personal notes. Reply with ONLY a JSON object, no markdown: ' +
          '{"title": string (max 8 words), "summary": string (1-2 plain sentences), "tags": array of 2-5 short lowercase tags}. ' +
          "Write in the same language as the note.",
      },
      { role: "user", content: note.body.slice(0, 6000) },
    ]);
    const j = parseJsonLoose(text);
    if (!j) throw new Error("Model did not return JSON");
    const title = note.title || String(j.title || "").slice(0, 120);
    await q("UPDATE notes SET title=$2, summary=$3, tags=$4, ai_status='ok' WHERE id=$1",
      [id, title, String(j.summary || "").slice(0, 600), normTags(j.tags)]);
  } catch (e) {
    console.error("enrich failed:", e.message);
    await q("UPDATE notes SET ai_status='failed' WHERE id=$1", [id]);
  }
  return (await q("SELECT * FROM notes WHERE id=$1", [id])).rows[0];
}

// ---------- retrieval for "Ask your notes": simple weighted keyword scoring ----------
const STOP = new Set("the and for are but not you your with this that what when where which who whom how why was were have has had from into about can could would should did does their there them they then than also any all out our its his her she him just like get got been being will shall may might must say said tell show give find list what's".split(" "));
function rank(question, notes) {
  const terms = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter((t) => !STOP.has(t));
  if (!terms.length) return [];
  const count = (hay, t) => (hay.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  return notes
    .map((n) => {
      const title = n.title.toLowerCase(), tags = n.tags.toLowerCase(), sum = n.summary.toLowerCase(), body = n.body.toLowerCase();
      let score = 0;
      for (const t of terms) score += 3 * count(title, t) + 3 * count(tags, t) + 2 * count(sum, t) + Math.min(count(body, t), 5);
      return { n, score: score > 0 && n.pinned ? score + 1 : score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.n);
}

// ---------- routes ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/api/status", (_req, res) =>
  res.json({
    app: process.env.APP_NAME || "notebook",
    model: MODEL,
    gateway: BASE_URL,
    hasApiKey: !!API_KEY,
    database: dbError ? "error" : pool ? "connected" : "missing",
    databaseError: dbError,
  }));

// Everything below needs the database.
app.use("/api", (_req, res, next) => (pool && !dbError ? next() : res.status(503).json({ error: dbError || "Database not ready" })));

app.get("/api/notes", ah(async (req, res) => {
  const where = [], params = [];
  const term = (req.query.q || "").toString().trim().slice(0, 100);
  const tag = (req.query.tag || "").toString().trim().toLowerCase().slice(0, 24);
  if (term) {
    params.push(`%${likeEscape(term)}%`);
    const p = `$${params.length}`;
    where.push(`(title ILIKE ${p} OR body ILIKE ${p} OR summary ILIKE ${p} OR tags ILIKE ${p})`);
  }
  if (tag) {
    params.push(`%,${likeEscape(tag)},%`);
    where.push(`(',' || tags || ',') LIKE $${params.length}`);
  }
  const sql = `SELECT * FROM notes ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY pinned DESC, updated_at DESC LIMIT 200`;
  res.json((await q(sql, params)).rows.map(present));
}));

app.get("/api/tags", ah(async (_req, res) => {
  const counts = {};
  for (const r of (await q("SELECT tags FROM notes WHERE tags <> ''")).rows)
    for (const t of tagList(r.tags)) counts[t] = (counts[t] || 0) + 1;
  res.json(Object.entries(counts).map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)));
}));

app.post("/api/notes", ah(async (req, res) => {
  const body = (req.body.body || "").toString().trim();
  const title = (req.body.title || "").toString().trim().slice(0, 200);
  if (!body) throw httpErr(400, "Note text is required");
  if (body.length > 20000) throw httpErr(400, "Note is too long (max 20,000 characters)");
  const { rows } = await q("INSERT INTO notes (title, body) VALUES ($1,$2) RETURNING id", [title, body]);
  res.status(201).json(present(await enrich(rows[0].id)));
}));

app.put("/api/notes/:id", ah(async (req, res) => {
  const body = (req.body.body || "").toString().trim();
  const title = (req.body.title || "").toString().trim().slice(0, 200);
  if (!body) throw httpErr(400, "Note text is required");
  if (body.length > 20000) throw httpErr(400, "Note is too long (max 20,000 characters)");
  const r = await q("UPDATE notes SET title=$2, body=$3, updated_at=now(), ai_status='pending' WHERE id=$1 RETURNING id", [req.params.id, title, body]);
  if (!r.rows[0]) throw httpErr(404, "Note not found");
  res.json(present(await enrich(r.rows[0].id)));
}));

app.post("/api/notes/:id/enrich", ah(async (req, res) => {
  const n = await enrich(req.params.id);
  if (!n) throw httpErr(404, "Note not found");
  res.json(present(n));
}));

app.post("/api/notes/:id/pin", ah(async (req, res) => {
  const r = await q("UPDATE notes SET pinned=$2 WHERE id=$1 RETURNING *", [req.params.id, !!req.body.pinned]);
  if (!r.rows[0]) throw httpErr(404, "Note not found");
  res.json(present(r.rows[0]));
}));

app.delete("/api/notes/:id", ah(async (req, res) => {
  await q("DELETE FROM notes WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
}));

app.post("/api/ask", ah(async (req, res) => {
  const question = (req.body.question || "").toString().trim().slice(0, 1000);
  if (!question) throw httpErr(400, "Question is required");
  const all = (await q("SELECT id, title, body, summary, tags, pinned FROM notes ORDER BY updated_at DESC LIMIT 500")).rows;
  const top = rank(question, all).slice(0, 6);
  let answer;
  if (!top.length) {
    answer = "I couldn't find any notes related to that question.";
  } else {
    const context = top
      .map((n) => `[#${n.id}] ${n.title || "Untitled"}\nTags: ${n.tags || "-"}\n${n.body.slice(0, 1500)}`)
      .join("\n\n---\n\n");
    answer = await callQwen("ask", [
      {
        role: "system",
        content:
          "Answer the user's question using ONLY the notes provided. Cite the notes you used like [#12]. " +
          "If the notes do not contain the answer, say so plainly. Be concise. Reply in the language of the question.",
      },
      { role: "user", content: `NOTES:\n${context}\n\nQUESTION: ${question}` },
    ]);
  }
  const ids = top.map((n) => n.id);
  const saved = (await q("INSERT INTO qa (question, answer, source_ids) VALUES ($1,$2,$3) RETURNING *", [question, answer, ids.join(",")])).rows[0];
  res.json({ ...saved, sources: top.map((n) => ({ id: n.id, title: n.title || "Untitled" })) });
}));

app.get("/api/qa", ah(async (_req, res) => {
  const rows = (await q("SELECT * FROM qa ORDER BY id DESC LIMIT 50")).rows;
  const titles = new Map((await q("SELECT id, title FROM notes")).rows.map((n) => [n.id, n.title || "Untitled"]));
  res.json(rows.map((r) => ({
    ...r,
    sources: r.source_ids ? r.source_ids.split(",").map(Number).filter((id) => titles.has(id)).map((id) => ({ id, title: titles.get(id) })) : [],
  })));
}));

app.delete("/api/qa/:id", ah(async (req, res) => {
  await q("DELETE FROM qa WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
}));

app.get("/api/stats", ah(async (_req, res) => {
  const c = (await q(
    `SELECT (SELECT count(*) FROM notes)::int AS notes,
            (SELECT count(*) FROM notes WHERE pinned)::int AS pinned,
            (SELECT count(*) FROM qa)::int AS questions`)).rows[0];
  const usage = (await q(
    `SELECT kind, count(*)::int AS calls, coalesce(sum(prompt_tokens),0)::int AS prompt_tokens,
            coalesce(sum(completion_tokens),0)::int AS completion_tokens
     FROM ai_calls GROUP BY kind ORDER BY kind`)).rows;
  res.json({ ...c, usage });
}));

app.get("/api/export", ah(async (_req, res) => {
  const notes = (await q("SELECT * FROM notes ORDER BY id")).rows.map(present);
  const qaRows = (await q("SELECT * FROM qa ORDER BY id")).rows;
  res.set("Content-Disposition", 'attachment; filename="notebook-export.json"');
  res.json({ exported_at: new Date().toISOString(), notes, qa: qaRows });
}));

app.use(express.static(path.join(__dirname, "public")));

// Start listening immediately so the platform health check passes while the DB connects.
app.listen(PORT, "0.0.0.0", () => console.log(`Notebook listening on ${PORT} — model ${MODEL} — gateway ${BASE_URL}`));
initDb().then(() => console.log(dbError ? `Database problem: ${dbError}` : "Database ready"));
