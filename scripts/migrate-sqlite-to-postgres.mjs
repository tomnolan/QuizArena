import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

const sqlitePath = process.env.SQLITE_PATH || './data/quiz.sqlite'
const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required')
}

const sqlite = new DatabaseSync(sqlitePath)
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
})

const readAll = (sql) => sqlite.prepare(sql).all()

const quizzes = readAll('SELECT * FROM quizzes')
const questions = readAll('SELECT * FROM questions')
const attempts = readAll('SELECT * FROM attempts')
const liveSessions = readAll('SELECT * FROM live_sessions')
const liveAnswers = readAll(
  'SELECT quiz_id, question_id, player_id, player_name, selected_option_index, answered_at FROM live_answers',
)
const readOptionalTable = (table) =>
  sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    ? readAll(`SELECT * FROM ${table}`) : []
const runs = readOptionalTable('quiz_runs')
const players = readOptionalTable('run_players')
const settings = readOptionalTable('site_settings')

const client = await pool.connect()

try {
  await client.query('BEGIN')

  await client.query(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      options_json TEXT NOT NULL,
      correct_option_index INTEGER NOT NULL,
      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      player_name TEXT NOT NULL,
      score INTEGER NOT NULL,
      total_questions INTEGER NOT NULL,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_sessions (
      quiz_id TEXT PRIMARY KEY REFERENCES quizzes(id) ON DELETE CASCADE,
      current_question_index INTEGER NOT NULL,
      question_started_at TEXT,
      status TEXT NOT NULL,
      answer_seconds INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_answers (
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      selected_option_index INTEGER NOT NULL,
      answered_at TEXT NOT NULL,
      PRIMARY KEY (quiz_id, question_id, player_id)
    );

    CREATE INDEX IF NOT EXISTS idx_live_answers_quiz_id ON live_answers (quiz_id);
    CREATE INDEX IF NOT EXISTS idx_live_answers_quiz_question ON live_answers (quiz_id, question_id);

    CREATE TABLE IF NOT EXISTS site_settings (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, subtitle TEXT NOT NULL, player_base_url TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS quiz_runs (
      id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      status TEXT NOT NULL, started_at TEXT, ended_at TEXT, join_code TEXT UNIQUE,
      question_times_json TEXT NOT NULL DEFAULT '{}', results_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quiz_runs_quiz ON quiz_runs (quiz_id, ended_at);
    CREATE TABLE IF NOT EXISTS run_players (
      run_id TEXT NOT NULL REFERENCES quiz_runs(id) ON DELETE CASCADE, player_id TEXT NOT NULL,
      player_name TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (run_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS quiz_presence (
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE, player_id TEXT NOT NULL,
      player_name TEXT NOT NULL, run_id TEXT, last_seen_at TEXT NOT NULL, PRIMARY KEY (quiz_id, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_quiz_presence_seen ON quiz_presence (quiz_id, last_seen_at);
    CREATE TABLE IF NOT EXISTS join_lookup_limits (
      client_id TEXT PRIMARY KEY, attempts_json TEXT NOT NULL DEFAULT '[]', last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_join_lookup_limits_seen ON join_lookup_limits (last_seen_at);
  `)

  await client.query(`
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS reveal_answers INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS display_stats INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS is_published INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS has_run INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS after_image_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS reuse_before_image INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS explanation TEXT NOT NULL DEFAULT '';
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS answer_seconds INTEGER NOT NULL DEFAULT 60;
    ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS reveal_answers INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS run_id TEXT;
    ALTER TABLE attempts ADD COLUMN IF NOT EXISTS run_id TEXT;
  `)

  for (const row of quizzes) {
    await client.query(
      `INSERT INTO quizzes (id, title, description, created_at, reveal_answers, is_published, has_run, display_stats)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         created_at = EXCLUDED.created_at,
         reveal_answers = EXCLUDED.reveal_answers,
         is_published = EXCLUDED.is_published,
         has_run = GREATEST(quizzes.has_run, EXCLUDED.has_run),
         display_stats = EXCLUDED.display_stats`,
      [
        row.id, row.title, row.description, row.created_at, row.reveal_answers ?? 0,
        row.is_published ?? 1,
        row.has_run || liveSessions.some((session) => session.quiz_id === row.id && session.status !== 'idle') ||
          attempts.some((attempt) => attempt.quiz_id === row.id) ? 1 : 0,
        row.display_stats ?? 0,
      ],
    )
  }

  for (const row of questions) {
    await client.query(
      `INSERT INTO questions (id, quiz_id, prompt, options_json, correct_option_index, sort_order, image_url, explanation, answer_seconds, after_image_url, reuse_before_image)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         quiz_id = EXCLUDED.quiz_id,
         prompt = EXCLUDED.prompt,
         options_json = EXCLUDED.options_json,
         correct_option_index = EXCLUDED.correct_option_index,
         sort_order = EXCLUDED.sort_order,
         image_url = EXCLUDED.image_url,
         explanation = EXCLUDED.explanation,
         answer_seconds = EXCLUDED.answer_seconds,
         after_image_url = EXCLUDED.after_image_url,
         reuse_before_image = EXCLUDED.reuse_before_image`,
      [
        row.id,
        row.quiz_id,
        row.prompt,
        row.options_json,
        row.correct_option_index,
        row.sort_order,
        row.image_url ?? '',
        row.explanation ?? '',
        row.answer_seconds ?? 60,
        row.after_image_url ?? '',
        row.reuse_before_image ?? 0,
      ],
    )
  }

  for (const row of runs) {
    await client.query(
      `INSERT INTO quiz_runs (id, quiz_id, status, started_at, ended_at, join_code, question_times_json, results_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at, join_code = EXCLUDED.join_code,
         question_times_json = EXCLUDED.question_times_json, results_json = EXCLUDED.results_json`,
      [row.id, row.quiz_id, row.status, row.started_at, row.ended_at, row.join_code, row.question_times_json, row.results_json],
    )
  }
  for (const row of players) {
    await client.query(
      `INSERT INTO run_players (run_id, player_id, player_name, joined_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id, player_id) DO UPDATE SET player_name = EXCLUDED.player_name, joined_at = EXCLUDED.joined_at`,
      [row.run_id, row.player_id, row.player_name, row.joined_at],
    )
  }
  for (const row of settings) {
    await client.query(
      `INSERT INTO site_settings (id, title, subtitle, player_base_url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, player_base_url = EXCLUDED.player_base_url`,
      [row.id, row.title, row.subtitle, row.player_base_url],
    )
  }
  for (const row of attempts) {
    await client.query(
      `INSERT INTO attempts (id, quiz_id, player_name, score, total_questions, completed_at, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         quiz_id = EXCLUDED.quiz_id,
         player_name = EXCLUDED.player_name,
         score = EXCLUDED.score,
         total_questions = EXCLUDED.total_questions,
         completed_at = EXCLUDED.completed_at,
         run_id = COALESCE(EXCLUDED.run_id, attempts.run_id)`,
      [
        row.id,
        row.quiz_id,
        row.player_name,
        row.score,
        row.total_questions,
        row.completed_at,
        row.run_id ?? null,
      ],
    )
  }

  for (const row of liveSessions) {
    await client.query(
      `INSERT INTO live_sessions (quiz_id, current_question_index, question_started_at, status, answer_seconds, reveal_answers, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (quiz_id) DO UPDATE SET
         current_question_index = EXCLUDED.current_question_index,
         question_started_at = EXCLUDED.question_started_at,
         status = EXCLUDED.status,
         answer_seconds = EXCLUDED.answer_seconds,
         reveal_answers = EXCLUDED.reveal_answers,
         run_id = COALESCE(EXCLUDED.run_id, live_sessions.run_id)`,
      [
        row.quiz_id,
        row.current_question_index,
        row.question_started_at,
        row.status,
        row.answer_seconds,
        row.reveal_answers ?? 0,
        row.run_id ?? null,
      ],
    )
  }

  for (const row of liveAnswers) {
    await client.query(
      `INSERT INTO live_answers
       (quiz_id, question_id, player_id, player_name, selected_option_index, answered_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (quiz_id, question_id, player_id) DO UPDATE SET
         player_name = EXCLUDED.player_name,
         selected_option_index = EXCLUDED.selected_option_index,
         answered_at = EXCLUDED.answered_at`,
      [
        row.quiz_id,
        row.question_id,
        row.player_id,
        row.player_name,
        row.selected_option_index,
        row.answered_at,
      ],
    )
  }

  await client.query('COMMIT')

  const targetCounts = {
    quizzes: Number((await client.query('SELECT COUNT(*)::int AS count FROM quizzes')).rows[0].count),
    questions: Number((await client.query('SELECT COUNT(*)::int AS count FROM questions')).rows[0].count),
    attempts: Number((await client.query('SELECT COUNT(*)::int AS count FROM attempts')).rows[0].count),
    live_sessions: Number(
      (await client.query('SELECT COUNT(*)::int AS count FROM live_sessions')).rows[0].count,
    ),
    live_answers: Number(
      (await client.query('SELECT COUNT(*)::int AS count FROM live_answers')).rows[0].count,
    ),
    quiz_runs: Number((await client.query('SELECT COUNT(*)::int AS count FROM quiz_runs')).rows[0].count),
    run_players: Number((await client.query('SELECT COUNT(*)::int AS count FROM run_players')).rows[0].count),
    site_settings: Number((await client.query('SELECT COUNT(*)::int AS count FROM site_settings')).rows[0].count),
  }

  const sourceCounts = {
    quizzes: quizzes.length,
    questions: questions.length,
    attempts: attempts.length,
    live_sessions: liveSessions.length,
    live_answers: liveAnswers.length,
    quiz_runs: runs.length,
    run_players: players.length,
    site_settings: settings.length,
  }

  console.log('Migration complete.')
  console.log('Source counts:', sourceCounts)
  console.log('Target counts:', targetCounts)
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}