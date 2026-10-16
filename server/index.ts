import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import pg from 'pg'
import { fileURLToPath } from 'node:url'

type QuestionInput = {
  prompt: string
  options: string[]
  correctOptionIndex: number
  imageUrl?: string
  afterImageUrl?: string
  reuseBeforeImage?: boolean
  explanation?: string
  answerSeconds?: number
}

type QuizInput = {
  title: string
  description?: string
  revealAnswers?: boolean
  displayStats?: boolean
  isPublished?: boolean
  questions: QuestionInput[]
}

type QuizFile = {
  format: 'quizarena.quiz'
  version: 1
  exportedAt: string
  quiz: {
    title: string
    description: string
    revealAnswers: boolean
    displayStats: boolean
    questions: Required<QuestionInput>[]
  }
}

const maxQuizFileBytes = 32_000_000

type AttemptInput = {
  playerName: string
  answers: Record<string, number>
}

type LiveAnswerInput = {
  runId: string
  playerId: string
  playerName: string
  questionId: string
  selectedOptionIndex: number
}

type QuizRow = {
  id: string
  title: string
  description: string
  created_at: string
  reveal_answers: number
  display_stats: number
  is_published: number
  has_run: number
}

type QuestionRow = {
  id: string
  quiz_id: string
  prompt: string
  options_json: string
  correct_option_index: number
  sort_order: number
  image_url: string
  after_image_url: string
  reuse_before_image: number
  explanation: string
  answer_seconds: number
}

type AttemptRow = {
  id: string
  quiz_id: string
  quiz_title: string
  player_name: string
  score: number
  total_questions: number
  completed_at: string
  run_id: string | null
}

type LiveSessionRow = {
  quiz_id: string
  current_question_index: number
  question_started_at: string | null
  status: 'idle' | 'holding' | 'running' | 'revealing' | 'finished' | 'aborted'
  answer_seconds: number
  reveal_answers: number
  run_id: string | null
}

type RunPlayerRow = { run_id: string; player_id: string; player_name: string; joined_at: string }
const activeLiveStatuses: LiveSessionRow['status'][] = ['holding', 'running', 'revealing']
type PresenceRow = {
  quiz_id: string
  player_id: string
  player_name: string
  run_id: string | null
  last_seen_at: string
}
type JoinInput = { runId: string; joinCode: string; playerId: string; playerName: string }
// Hidden tabs may only poll once a minute.
const presenceTimeoutMs = 90_000
type RunRow = {
  id: string
  quiz_id: string
  status: 'running' | 'finished' | 'aborted'
  started_at: string | null
  ended_at: string | null
  join_code: string | null
  question_times_json: string
  results_json: string | null
}
type RunResults = {
  quizTitle: string
  totalQuestions: number
  questionsAsked: number | null
  playerCount: number
  totalAnswers: number | null
  correctCount: number
  incorrectCount: number | null
  detailsAvailable: boolean
  leaderboard: { playerId: string; playerName: string; score: number; totalQuestions: number }[]
  questions: ReturnType<typeof questionStats>[]
}
type SiteSettings = { title: string; subtitle: string; playerBaseUrl: string }
const defaultSiteSettings: SiteSettings = {
  title: 'Create quizzes and let everyone play',
  subtitle: 'Admins publish quizzes, start a live session, and control when players move to the next question. Set each question timer, add pictures, and optionally reveal answers and stats.',
  playerBaseUrl: '',
}

type LiveAnswerRow = {
  quiz_id: string
  question_id: string
  player_id: string
  player_name: string
  selected_option_index: number
  answered_at: string
}

type DbResult = {
  changes: number
}

type DbClient = {
  all<T>(sql: string, params?: SQLInputValue[]): Promise<T[]>
  get<T>(sql: string, params?: SQLInputValue[]): Promise<T | undefined>
  run(sql: string, params?: SQLInputValue[]): Promise<DbResult>
  exec(sql: string): Promise<void>
}

type Db = DbClient & {
  transaction<T>(operation: (tx: DbClient) => Promise<T>): Promise<T>
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const databasePath = process.env.DATABASE_PATH ?? path.join(projectRoot, 'data', 'quiz.sqlite')
const databaseUrl = process.env.DATABASE_URL?.trim() ?? ''
const distPath = path.join(projectRoot, 'dist')
const port = Number(process.env.PORT ?? 3001)
const adminPassword = (process.env.ADMIN_PASSWORD ?? 'change-me').trim()

if (adminPassword === 'change-me') {
  console.warn('Using default ADMIN_PASSWORD. Set ADMIN_PASSWORD in your environment for security.')
}

mkdirSync(path.dirname(databasePath), { recursive: true })

const toPostgresSql = (sql: string) => {
  let parameterIndex = 0
  return sql.replace(/\?/g, () => {
    parameterIndex += 1
    return `$${parameterIndex}`
  })
}

const initializeSchema = async (db: DbClient, includePragmas: boolean) => {
  if (includePragmas) {
    await db.exec('PRAGMA foreign_keys = ON;')
    await db.exec('PRAGMA journal_mode = WAL;')
  }

  await db.exec(`
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
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL,
      player_base_url TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS quiz_runs (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      join_code TEXT UNIQUE,
      question_times_json TEXT NOT NULL DEFAULT '{}',
      results_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quiz_runs_quiz ON quiz_runs (quiz_id, ended_at);

    CREATE TABLE IF NOT EXISTS run_players (
      run_id TEXT NOT NULL REFERENCES quiz_runs(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (run_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS quiz_presence (
      quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      run_id TEXT,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (quiz_id, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_quiz_presence_seen ON quiz_presence (quiz_id, last_seen_at);

    CREATE TABLE IF NOT EXISTS join_lookup_limits (
      client_id TEXT PRIMARY KEY,
      attempts_json TEXT NOT NULL DEFAULT '[]',
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_join_lookup_limits_seen ON join_lookup_limits (last_seen_at);
  `)

  const additions = [
    ['quizzes', 'reveal_answers', 'INTEGER NOT NULL DEFAULT 0'],
    ['quizzes', 'display_stats', 'INTEGER NOT NULL DEFAULT 0'],
    ['quizzes', 'is_published', 'INTEGER NOT NULL DEFAULT 1'],
    ['quizzes', 'has_run', 'INTEGER NOT NULL DEFAULT 0'],
    ['questions', 'image_url', "TEXT NOT NULL DEFAULT ''"],
    ['questions', 'after_image_url', "TEXT NOT NULL DEFAULT ''"],
    ['questions', 'reuse_before_image', 'INTEGER NOT NULL DEFAULT 0'],
    ['questions', 'explanation', "TEXT NOT NULL DEFAULT ''"],
    ['questions', 'answer_seconds', 'INTEGER NOT NULL DEFAULT 60'],
    ['live_sessions', 'reveal_answers', 'INTEGER NOT NULL DEFAULT 0'],
    ['live_sessions', 'run_id', 'TEXT'],
    ['attempts', 'run_id', 'TEXT'],
  ]

  for (const [table, column, definition] of additions) {
    if (includePragmas) {
      const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table})`)
      if (!columns.some((entry) => entry.name === column)) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      }
    } else {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`)
    }
  }
  await db.exec(`
    UPDATE quizzes SET has_run = 1
    WHERE has_run = 0 AND (
      EXISTS (SELECT 1 FROM live_sessions WHERE live_sessions.quiz_id = quizzes.id AND status <> 'idle')
      OR EXISTS (SELECT 1 FROM attempts WHERE attempts.quiz_id = quizzes.id)
    )
  `)
  await db.run(
    `INSERT INTO site_settings (id, title, subtitle, player_base_url) VALUES ('home', ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [defaultSiteSettings.title, defaultSiteSettings.subtitle, defaultSiteSettings.playerBaseUrl],
  )
}

const createSqliteDatabase = async (): Promise<Db> => {
  const sqlite = new DatabaseSync(databasePath)
  let transactionTail = Promise.resolve()

  const client: DbClient = {
    all: async <T,>(sql: string, params: SQLInputValue[] = []) =>
      sqlite.prepare(sql).all(...params) as T[],
    get: async <T,>(sql: string, params: SQLInputValue[] = []) =>
      sqlite.prepare(sql).get(...params) as T | undefined,
    run: async (sql: string, params: SQLInputValue[] = []) => {
      const result = sqlite.prepare(sql).run(...params)
      return { changes: Number(result.changes ?? 0) }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql)
    },
  }

  const db: Db = {
    ...client,
    transaction: async <T,>(operation: (tx: DbClient) => Promise<T>) => {
      const previousTransaction = transactionTail
      let release = () => {}
      transactionTail = new Promise<void>((resolve) => { release = resolve })
      await previousTransaction
      try {
        sqlite.exec('BEGIN')
        try {
          const result = await operation(client)
          sqlite.exec('COMMIT')
          return result
        } catch (error) {
          sqlite.exec('ROLLBACK')
          throw error
        }
      } finally {
        release()
      }
    },
  }

  await initializeSchema(db, true)
  await db.transaction(migrateRunHistory)
  return db
}

const createPostgresDatabase = async (): Promise<Db> => {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  })

  const client: DbClient = {
    all: async <T,>(sql: string, params: SQLInputValue[] = []) => {
      const result = await pool.query(toPostgresSql(sql), params)
      return result.rows as T[]
    },
    get: async <T,>(sql: string, params: SQLInputValue[] = []) => {
      const result = await pool.query(toPostgresSql(sql), params)
      return result.rows[0] as T | undefined
    },
    run: async (sql: string, params: SQLInputValue[] = []) => {
      const result = await pool.query(toPostgresSql(sql), params)
      return { changes: result.rowCount ?? 0 }
    },
    exec: async (sql: string) => {
      await pool.query(sql)
    },
  }

  const db: Db = {
    ...client,
    transaction: async <T,>(operation: (tx: DbClient) => Promise<T>) => {
      const transactionClient = await pool.connect()
      const tx: DbClient = {
        all: async <T2,>(sql: string, params: SQLInputValue[] = []) => {
          const result = await transactionClient.query(toPostgresSql(sql), params)
          return result.rows as T2[]
        },
        get: async <T2,>(sql: string, params: SQLInputValue[] = []) => {
          const result = await transactionClient.query(toPostgresSql(sql), params)
          return result.rows[0] as T2 | undefined
        },
        run: async (sql: string, params: SQLInputValue[] = []) => {
          const result = await transactionClient.query(toPostgresSql(sql), params)
          return { changes: result.rowCount ?? 0 }
        },
        exec: async (sql: string) => {
          await transactionClient.query(sql)
        },
      }

      try {
        await transactionClient.query('BEGIN')
        const result = await operation(tx)
        await transactionClient.query('COMMIT')
        return result
      } catch (error) {
        await transactionClient.query('ROLLBACK')
        throw error
      } finally {
        transactionClient.release()
      }
    },
  }

  await db.transaction(async (tx) => {
    // Serialize upgrades and legacy imports across PostgreSQL app replicas.
    await tx.exec('SELECT pg_advisory_xact_lock(21647205)')
    await initializeSchema(tx, false)
    await migrateRunHistory(tx)
  })
  return db
}

const createDatabase = async (): Promise<Db> =>
  databaseUrl ? createPostgresDatabase() : createSqliteDatabase()

const createId = () => crypto.randomUUID()

const sendJson = (res: ServerResponse, statusCode: number, body: unknown, headers: OutgoingHttpHeaders = {}) => {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-password, x-quiz-client-id',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, POST, PUT',
    'Content-Type': 'application/json',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

const sendError = (res: ServerResponse, statusCode: number, message: string) => {
  sendJson(res, statusCode, { error: message })
}

const isAdminAuthorized = (req: IncomingMessage) => {
  const header = req.headers['x-admin-password']
  const providedPassword = Array.isArray(header) ? header[0] : header
  return typeof providedPassword === 'string' && providedPassword.trim() === adminPassword
}

const requireAdmin = (req: IncomingMessage, res: ServerResponse) => {
  if (!isAdminAuthorized(req)) {
    sendError(res, 401, 'Admin password required for this action.')
    return false
  }

  return true
}

const readJsonBody = async <T,>(req: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length

    if (size > maxQuizFileBytes) {
      throw new Error('Quiz data exceeds the 32 MB request limit. Use smaller images or image URLs.')
    }

    chunks.push(buffer)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')) as T
}

const normalizeImageUrl = (value: unknown) => {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error('Question images must be an HTTP(S) URL or an uploaded image.')
  }
  const imageUrl = typeof value === 'string' ? value.trim() : ''
  if (imageUrl) {
    if (imageUrl.startsWith('data:')) {
      const image = imageUrl.match(/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/)
      if (!image || Buffer.byteLength(image[2], 'base64') > 2_000_000 ||
        Buffer.from(image[2], 'base64').toString('base64') !== image[2]) {
        throw new Error('Upload a PNG, JPEG, GIF, or WebP image no larger than 2 MB.')
      }
    } else {
      const url = URL.parse(imageUrl)
      if (!url || !['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Question images must use an HTTP(S) URL or an uploaded image.')
      }
    }
  }
  return imageUrl
}

const normalizeQuizInput = (input: QuizInput): QuizInput => {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const questions = Array.isArray(input.questions) ? input.questions : []
  const isPublished = input.isPublished ?? true

  if (typeof isPublished !== 'boolean') {
    throw new Error('Publication state must be enabled or disabled.')
  }

  if (!title) {
    throw new Error('Quiz title is required.')
  }

  if (isPublished && questions.length === 0) {
    throw new Error('At least one question is required.')
  }

  if (input.revealAnswers !== undefined && typeof input.revealAnswers !== 'boolean') {
    throw new Error('Reveal answers must be enabled or disabled.')
  }
  if (input.displayStats !== undefined && typeof input.displayStats !== 'boolean') {
    throw new Error('Completed stats display must be enabled or disabled.')
  }

  return {
    title,
    description,
    revealAnswers: input.revealAnswers ?? false,
    displayStats: input.displayStats ?? false,
    isPublished,
    questions: questions.map((question) => {
      const prompt = typeof question.prompt === 'string' ? question.prompt.trim() : ''
      const options = Array.isArray(question.options)
        ? question.options.map((option) => String(option).trim())
        : []
      const correctOptionIndex = Number(question.correctOptionIndex)
      const answerSeconds = question.answerSeconds ?? 60
      const imageUrl = normalizeImageUrl(question.imageUrl)
      const afterImageUrl = normalizeImageUrl(question.afterImageUrl)
      if (question.reuseBeforeImage !== undefined && typeof question.reuseBeforeImage !== 'boolean') {
        throw new Error('Use before picture after reveal must be enabled or disabled.')
      }
      const reuseBeforeImage = Boolean(imageUrl) && (question.reuseBeforeImage ?? false)
      const explanation = typeof question.explanation === 'string' ? question.explanation.trim() : ''

      if (!Number.isSafeInteger(answerSeconds) || answerSeconds < 20) {
        throw new Error('Each question timer must be a whole number of at least 20 seconds.')
      }

      if (
        (isPublished && (!prompt || options.some((option) => !option))) ||
        options.length !== 4 ||
        !Number.isInteger(correctOptionIndex) ||
        correctOptionIndex < 0 ||
        correctOptionIndex >= options.length
      ) {
        throw new Error('Each question needs text, four answers, and a correct answer.')
      }

      return { prompt, options, correctOptionIndex, imageUrl, afterImageUrl, reuseBeforeImage, explanation, answerSeconds }
    }),
  }
}

const publicQuestionColumns = `id, quiz_id, prompt, options_json, correct_option_index,
  sort_order, explanation, answer_seconds, reuse_before_image,
  CASE WHEN image_url LIKE 'data:%' THEN '/api/questions/' || id || '/image' ELSE image_url END AS image_url,
  CASE WHEN after_image_url LIKE 'data:%' THEN '/api/questions/' || id || '/image/after' ELSE after_image_url END AS after_image_url`

const listQuizzes = async (db: DbClient, includeDrafts = false) => {
  const quizRows = await db.all<QuizRow>(
    `SELECT * FROM quizzes ${includeDrafts ? '' : 'WHERE is_published = 1'} ORDER BY created_at DESC`,
  )
  const questionRows = await db.all<QuestionRow>(
    `SELECT ${publicQuestionColumns}
     FROM questions
     ORDER BY sort_order ASC`,
  )

  return quizRows.map((quiz) => ({
    id: quiz.id,
    title: quiz.title,
    description: quiz.description,
    createdAt: quiz.created_at,
    revealAnswers: Boolean(quiz.reveal_answers),
    displayStats: Boolean(quiz.display_stats),
    isPublished: Boolean(quiz.is_published),
    hasRun: Boolean(quiz.has_run),
    questions: questionRows
      .filter((question) => question.quiz_id === quiz.id)
      .map((question) => toPublicQuestion(question)),
  }))
}

const listAttempts = async (db: DbClient) =>
  (
    await db.all<AttemptRow>(
      `SELECT attempts.id, attempts.quiz_id, quizzes.title AS quiz_title, attempts.player_name,
              attempts.score, attempts.total_questions, attempts.completed_at
       FROM attempts
       JOIN quizzes ON quizzes.id = attempts.quiz_id
       ORDER BY
         CAST(attempts.score AS REAL) / attempts.total_questions DESC,
         attempts.completed_at DESC
       LIMIT 50`,
    )
  ).map((attempt) => ({
    id: attempt.id,
    quizId: attempt.quiz_id,
    quizTitle: attempt.quiz_title,
    playerName: attempt.player_name,
    score: attempt.score,
    totalQuestions: attempt.total_questions,
    completedAt: attempt.completed_at,
  }))

const insertQuestions = async (db: DbClient, quizId: string, questions: QuestionInput[]) => {
  for (const [index, question] of questions.entries()) {
    await db.run(
      `INSERT INTO questions
       (id, quiz_id, prompt, options_json, correct_option_index, sort_order, image_url, after_image_url, explanation, answer_seconds, reuse_before_image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId(), quizId, question.prompt, JSON.stringify(question.options),
        question.correctOptionIndex, index, question.imageUrl ?? '', question.afterImageUrl ?? '',
        question.explanation ?? '', question.answerSeconds ?? 60,
        question.reuseBeforeImage ? 1 : 0,
      ],
    )
  }
}

const insertQuiz = async (db: DbClient, input: QuizInput) => {
  const quiz = normalizeQuizInput(input)
  const quizId = createId()
  const createdAt = new Date().toISOString()

  await db.run('INSERT INTO quizzes (id, title, description, created_at, reveal_answers, is_published, display_stats) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      quizId,
      quiz.title,
      quiz.description ?? '',
      createdAt,
      quiz.revealAnswers ? 1 : 0,
      quiz.isPublished ? 1 : 0,
      quiz.displayStats ? 1 : 0,
  ])
  await insertQuestions(db, quizId, quiz.questions)

  return (await listQuizzes(db, true)).find((storedQuiz) => storedQuiz.id === quizId)
}

const createQuiz = (db: Db, input: QuizInput) => db.transaction((tx) => insertQuiz(tx, input))

const getEditableQuiz = async (db: DbClient, quizId: string) => {
  const quiz = (await listQuizzes(db, true)).find((entry) => entry.id === quizId)
  if (!quiz) {
    return undefined
  }

  return {
    ...quiz,
    questions: (await getQuestionRows(db, quizId, true)).map((question) => ({
      ...toPublicQuestion(question),
      imageUrl: question.image_url,
      afterImageUrl: question.after_image_url,
      reuseBeforeImage: Boolean(question.reuse_before_image),
      correctOptionIndex: question.correct_option_index,
      explanation: question.explanation,
    })),
  }
}

const updateQuiz = async (db: Db, quizId: string, input: QuizInput) => {
  const quiz = normalizeQuizInput(input)
  return db.transaction(async (tx) => {
    const result = await tx.run(
      `UPDATE quizzes SET title = ?, description = ?, reveal_answers = ?, is_published = ?, display_stats = ?
       WHERE id = ? AND has_run = 0`,
      [quiz.title, quiz.description ?? '', quiz.revealAnswers ? 1 : 0, quiz.isPublished ? 1 : 0, quiz.displayStats ? 1 : 0, quizId],
    )
    if (!result.changes) {
      const existing = await tx.get<QuizRow>('SELECT * FROM quizzes WHERE id = ?', [quizId])
      if (!existing) {
        return undefined
      }
      throw new Error('This quiz has already been run and cannot be edited. Copy it to a new quiz instead.')
    }

    await tx.run('DELETE FROM live_sessions WHERE quiz_id = ?', [quizId])
    await tx.run('DELETE FROM questions WHERE quiz_id = ?', [quizId])
    await insertQuestions(tx, quizId, quiz.questions)
    return (await listQuizzes(tx, true)).find((entry) => entry.id === quizId)
  })
}

const copyQuiz = (db: Db, quizId: string) => db.transaction(async (tx) => {
  const source = await getEditableQuiz(tx, quizId)
  if (!source) {
    return undefined
  }
  return insertQuiz(tx, { ...source, title: `${source.title} (copy)`, isPublished: false })
})

const exportQuiz = (db: Db, quizId: string): Promise<QuizFile | undefined> => db.transaction(async (tx) => {
  const locked = await tx.run('UPDATE quizzes SET has_run = has_run WHERE id = ?', [quizId])
  if (!locked.changes) {
    return undefined
  }
  const quiz = await getEditableQuiz(tx, quizId)
  if (!quiz) {
    return undefined
  }
  return {
    format: 'quizarena.quiz',
    version: 1,
    exportedAt: new Date().toISOString(),
    quiz: {
      title: quiz.title,
      description: quiz.description,
      revealAnswers: quiz.revealAnswers,
      displayStats: quiz.displayStats,
      questions: quiz.questions.map((question) => ({
        prompt: question.prompt,
        options: question.options,
        correctOptionIndex: question.correctOptionIndex,
        answerSeconds: question.answerSeconds,
        imageUrl: question.imageUrl,
        afterImageUrl: question.afterImageUrl,
        reuseBeforeImage: question.reuseBeforeImage,
        explanation: question.explanation,
      })),
    },
  }
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const parseQuizFile = (input: unknown): QuizInput => {
  if (!isRecord(input) || input.format !== 'quizarena.quiz') {
    throw new Error('Choose a QuizArena quiz export JSON file (format: quizarena.quiz).')
  }
  if (input.version !== 1) {
    throw new Error('Unsupported quiz export version. This app supports version 1.')
  }
  const quiz = input.quiz
  if (!isRecord(quiz) || typeof quiz.title !== 'string' || typeof quiz.description !== 'string' ||
    typeof quiz.revealAnswers !== 'boolean' || !Array.isArray(quiz.questions) ||
    (quiz.displayStats !== undefined && typeof quiz.displayStats !== 'boolean')) {
    throw new Error('The quiz file must include a title, description, reveal setting, and questions array.')
  }
  const questions: QuestionInput[] = quiz.questions.map((question: unknown, index: number) => {
    if (!isRecord(question) || typeof question.prompt !== 'string' ||
      !Array.isArray(question.options) || !question.options.every((option: unknown) => typeof option === 'string') ||
      typeof question.correctOptionIndex !== 'number' || typeof question.answerSeconds !== 'number' ||
      typeof question.imageUrl !== 'string' || typeof question.explanation !== 'string' ||
      (question.afterImageUrl !== undefined && typeof question.afterImageUrl !== 'string') ||
      (question.reuseBeforeImage !== undefined && typeof question.reuseBeforeImage !== 'boolean')) {
      throw new Error(`Question ${index + 1} is missing valid text, answers, correct answer, timer, image, or summary fields.`)
    }
    return {
      prompt: question.prompt,
      options: question.options,
      correctOptionIndex: question.correctOptionIndex,
      answerSeconds: question.answerSeconds,
      imageUrl: question.imageUrl,
      afterImageUrl: typeof question.afterImageUrl === 'string' ? question.afterImageUrl : '',
      reuseBeforeImage: question.reuseBeforeImage ?? false,
      explanation: question.explanation,
    }
  })
  return normalizeQuizInput({
    title: quiz.title,
    description: quiz.description,
    revealAnswers: quiz.revealAnswers,
    displayStats: typeof quiz.displayStats === 'boolean' ? quiz.displayStats : false,
    isPublished: false,
    questions,
  })
}

const importQuiz = (db: Db, input: unknown) => db.transaction(async (tx) => {
  const quiz = await insertQuiz(tx, parseQuizFile(input))
  const editable = quiz ? await getEditableQuiz(tx, quiz.id) : undefined
  if (!editable) {
    throw new Error('Could not load the imported quiz. No quiz was saved.')
  }
  return editable
})

const deleteQuiz = async (db: DbClient, quizId: string) => {
  const result = await db.run('DELETE FROM quizzes WHERE id = ?', [quizId])
  return result.changes > 0
}

const createAttempt = async (db: Db, quizId: string, input: AttemptInput) => db.transaction(async (tx) => {
  const playerName = typeof input.playerName === 'string' ? input.playerName.trim() : ''
  const answers =
    input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers)
      ? input.answers
      : {}

  if (!playerName) {
    throw new Error('Player name is required.')
  }

  const locked = await tx.run('UPDATE quizzes SET has_run = 1 WHERE id = ? AND is_published = 1', [quizId])
  if (!locked.changes) {
    return undefined
  }
  const quiz = await tx.get<Pick<QuizRow, 'id' | 'title'>>('SELECT id, title FROM quizzes WHERE id = ? AND is_published = 1', [
    quizId,
  ])

  if (!quiz) {
    return undefined
  }

  const questions = await tx.all<QuestionRow>(
    `SELECT *
     FROM questions
     WHERE quiz_id = ?
     ORDER BY sort_order ASC`,
    [quizId],
  )

  if (questions.some((question) => answers[question.id] === undefined)) {
    throw new Error('Every question must be answered.')
  }

  const score = questions.filter(
    (question) => answers[question.id] === question.correct_option_index,
  ).length
  const attemptId = createId()
  const completedAt = new Date().toISOString()
  const runId = createId()
  const runAnswers: LiveAnswerRow[] = questions.map((question) => ({
    quiz_id: quizId, question_id: question.id, player_id: attemptId, player_name: playerName,
    selected_option_index: answers[question.id], answered_at: completedAt,
  }))
  const results = buildRunResults(quiz.title, questions, runAnswers, [], {}, questions.length - 1)
  await tx.run(
    `INSERT INTO quiz_runs (id, quiz_id, status, ended_at, results_json) VALUES (?, ?, 'finished', ?, ?)`,
    [runId, quizId, completedAt, JSON.stringify(results)],
  )

  await tx.run(
    `INSERT INTO attempts
     (id, quiz_id, player_name, score, total_questions, completed_at, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [attemptId, quizId, playerName, score, questions.length, completedAt, runId],
  )

  return {
    id: attemptId,
    quizId,
    quizTitle: quiz.title,
    playerName,
    score,
    totalQuestions: questions.length,
    completedAt,
  }
})

const getQuestionRows = (db: DbClient, quizId: string, includeImageData = false) =>
  db.all<QuestionRow>(
    `SELECT ${includeImageData ? '*' : publicQuestionColumns}
     FROM questions
     WHERE quiz_id = ?
     ORDER BY sort_order ASC`,
    [quizId],
  )

const getLiveSessionRow = (db: DbClient, quizId: string) =>
  db.get<LiveSessionRow>(
    `SELECT *
     FROM live_sessions
     WHERE quiz_id = ?`,
    [quizId],
  )

const toPublicQuestion = (question: QuestionRow, revealed = false) => ({
  id: question.id,
  prompt: question.prompt,
  options: JSON.parse(question.options_json) as string[],
  imageUrl: revealed && !(question.reuse_before_image && question.image_url)
    ? question.after_image_url.startsWith('data:') ? `/api/questions/${question.id}/image/after` : question.after_image_url
    : question.image_url.startsWith('data:') ? `/api/questions/${question.id}/image` : question.image_url,
  answerSeconds: question.answer_seconds,
})

const scorePlayers = (questions: QuestionRow[], answers: LiveAnswerRow[], registered: RunPlayerRow[] = []) => {
  const players = new Map<string, string>()
  for (const answer of answers.toSorted((a, b) => a.answered_at.localeCompare(b.answered_at))) {
    players.set(answer.player_id, answer.player_name)
  }
  for (const player of registered) {
    players.set(player.player_id, player.player_name)
  }
  return [...players].map(([playerId, playerName]) => ({
    playerId,
    playerName,
    score: questions.filter((question) =>
      answers.some((answer) =>
        answer.player_id === playerId &&
        answer.question_id === question.id &&
        answer.selected_option_index === question.correct_option_index,
      ),
    ).length,
    totalQuestions: questions.length,
  })).sort((a, b) => b.score - a.score || a.playerName.localeCompare(b.playerName))
}

const questionStats = (
  question: QuestionRow, answers: LiveAnswerRow[], playerCount: number,
  startedAt: string | undefined, wasAsked: boolean,
) => {
  const responses = answers.filter((answer) => answer.question_id === question.id)
  const correctCount = responses.filter((answer) => answer.selected_option_index === question.correct_option_index).length
  return {
    questionId: question.id,
    prompt: question.prompt,
    options: JSON.parse(question.options_json) as string[],
    correctOptionIndex: question.correct_option_index,
    explanation: question.explanation,
    wasAsked,
    correctCount,
    incorrectCount: responses.length - correctCount,
    unansweredCount: wasAsked ? Math.max(0, playerCount - responses.length) : 0,
    optionCounts: (JSON.parse(question.options_json) as string[]).map((_, index) =>
      responses.filter((answer) => answer.selected_option_index === index).length,
    ),
    fastestAnswers: startedAt ? responses
      .toSorted((a, b) => a.answered_at.localeCompare(b.answered_at) || a.player_id.localeCompare(b.player_id))
      .slice(0, 5)
      .map((answer) => ({
        playerName: answer.player_name,
        responseSeconds: Math.max(0, (Date.parse(answer.answered_at) - Date.parse(startedAt)) / 1000),
        isCorrect: answer.selected_option_index === question.correct_option_index,
      })) : [],
  }
}

const buildRunResults = (
  title: string, questions: QuestionRow[], answers: LiveAnswerRow[], players: RunPlayerRow[],
  times: Record<string, string>, currentQuestionIndex: number,
): RunResults => {
  const leaderboard = scorePlayers(questions, answers, players)
  const correctCount = leaderboard.reduce((sum, player) => sum + player.score, 0)
  return {
    quizTitle: title,
    totalQuestions: questions.length,
    questionsAsked: Math.min(currentQuestionIndex + 1, questions.length),
    playerCount: leaderboard.length,
    totalAnswers: answers.length,
    correctCount,
    incorrectCount: answers.length - correctCount,
    detailsAvailable: true,
    leaderboard,
    questions: questions.map((question, index) =>
      questionStats(question, answers, leaderboard.length, times[question.id], index <= currentQuestionIndex),
    ),
  }
}

const getRunPlayers = (db: DbClient, runId: string) =>
  db.all<RunPlayerRow>('SELECT * FROM run_players WHERE run_id = ?', [runId])
const getRun = (db: DbClient, runId: string) =>
  db.get<RunRow>('SELECT * FROM quiz_runs WHERE id = ?', [runId])
const toPublicRun = (run: RunRow) => ({
  id: run.id, status: run.status, startedAt: run.started_at, endedAt: run.ended_at,
  results: run.results_json ? JSON.parse(run.results_json) as RunResults : null,
})

const insertRun = async (db: DbClient, quizId: string, startedAt: string | null, times: Record<string, string>) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = createId()
    const code = String(randomInt(100000, 1000000))
    const result = await db.run(
      `INSERT INTO quiz_runs (id, quiz_id, status, started_at, join_code, question_times_json)
       VALUES (?, ?, 'running', ?, ?, ?) ON CONFLICT (join_code) DO NOTHING`,
      [id, quizId, startedAt, code, JSON.stringify(times)],
    )
    if (result.changes) {
      return id
    }
  }
  throw new Error('Could not allocate a unique join code. Please try again.')
}

const migrateRunHistory = async (db: DbClient) => {
  const attempts = await db.all<AttemptRow>(
    `SELECT attempts.*, quizzes.title AS quiz_title FROM attempts
     JOIN quizzes ON quizzes.id = attempts.quiz_id WHERE run_id IS NULL ORDER BY completed_at`,
  )
  const batches = new Map<string, AttemptRow[]>()
  for (const attempt of attempts) {
    const key = JSON.stringify([attempt.quiz_id, attempt.completed_at])
    const batch = batches.get(key) ?? []
    batch.push(attempt)
    batches.set(key, batch)
  }
  for (const batch of batches.values()) {
    const first = batch[0]
    const id = `imported-${first.id}`
    const results: RunResults = {
      quizTitle: first.quiz_title, totalQuestions: first.total_questions, questionsAsked: null,
      playerCount: batch.length, totalAnswers: null, incorrectCount: null, detailsAvailable: false,
      correctCount: batch.reduce((sum, attempt) => sum + attempt.score, 0),
      questions: [],
      leaderboard: batch.map((attempt) => ({
        playerId: `imported-${attempt.id}`, playerName: attempt.player_name,
        score: attempt.score, totalQuestions: attempt.total_questions,
      })).sort((a, b) => b.score - a.score || a.playerName.localeCompare(b.playerName)),
    }
    await db.run(
      `INSERT INTO quiz_runs (id, quiz_id, status, ended_at, results_json)
       VALUES (?, ?, 'finished', ?, ?) ON CONFLICT (id) DO NOTHING`,
      [id, first.quiz_id, first.completed_at, JSON.stringify(results)],
    )
    for (const attempt of batch) {
      await db.run('UPDATE attempts SET run_id = ? WHERE id = ?', [id, attempt.id])
    }
  }
  const sessions = await db.all<LiveSessionRow>(
    "SELECT * FROM live_sessions WHERE run_id IS NULL AND status <> 'idle'",
  )
  for (const session of sessions) {
    const quiz = await db.get<QuizRow>('SELECT * FROM quizzes WHERE id = ?', [session.quiz_id])
    if (!quiz) {
      throw new Error('A legacy live session references a missing quiz.')
    }
    const questions = await getQuestionRows(db, session.quiz_id)
    const answers = await db.all<LiveAnswerRow>('SELECT * FROM live_answers WHERE quiz_id = ?', [session.quiz_id])
    const times: Record<string, string> = {}
    if (session.question_started_at && questions[session.current_question_index]) {
      times[questions[session.current_question_index].id] = session.question_started_at
    }
    const results = buildRunResults(quiz.title, questions, answers, [], times, session.current_question_index)
    let runId: string | undefined
    if (session.status === 'finished') {
      const candidates = await db.all<RunRow>("SELECT * FROM quiz_runs WHERE quiz_id = ? AND status = 'finished' ORDER BY ended_at DESC", [quiz.id])
      const signature = (entries: RunResults['leaderboard']) => JSON.stringify(
        entries.map((entry) => [entry.playerName, entry.score, entry.totalQuestions]).sort(),
      )
      runId = candidates.find((run) =>
        run.results_json && signature((JSON.parse(run.results_json) as RunResults).leaderboard) === signature(results.leaderboard),
      )?.id
    }
    if (!runId) {
      runId = await insertRun(db, quiz.id, null, times)
    }
    if (session.status === 'finished' || session.status === 'aborted') {
      await db.run('UPDATE quiz_runs SET status = ?, results_json = ? WHERE id = ?', [
        session.status, JSON.stringify(results), runId,
      ])
    }
    await db.run('UPDATE live_sessions SET run_id = ? WHERE quiz_id = ?', [runId, quiz.id])
    for (const player of results.leaderboard) {
      await db.run(
        `INSERT INTO run_players (run_id, player_id, player_name, joined_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (run_id, player_id) DO NOTHING`,
        [runId, player.playerId, player.playerName, answers.find((answer) => answer.player_id === player.playerId)?.answered_at ?? new Date().toISOString()],
      )
    }
  }
}

const getLiveSession = async (
  db: DbClient, quizId: string, playerId?: string, requestedRunId?: string, admin = false,
) => {
  const quiz = await db.get<QuizRow>('SELECT * FROM quizzes WHERE id = ?', [quizId])

  if (!quiz) {
    return undefined
  }
  const statsCodeFor = (run?: RunRow) =>
    quiz.is_published && quiz.display_stats && run?.status === 'finished' && run.results_json ? run.join_code : null
  const questions = await getQuestionRows(db, quizId)
  let session = await getLiveSessionRow(db, quizId)
  if (playerId) {
    await db.run(
      `UPDATE quiz_presence SET last_seen_at = ? WHERE quiz_id = ? AND player_id = ?
       ${requestedRunId ? 'AND run_id = ?' : ''}`,
      [new Date().toISOString(), quizId, playerId, ...(requestedRunId ? [requestedRunId] : [])],
    )
  }
  const presence = playerId ? await db.get<PresenceRow>(
    'SELECT * FROM quiz_presence WHERE quiz_id = ? AND player_id = ?', [quizId, playerId],
  ) : undefined
  const playerRunId = presence?.run_id ?? null
  const effectiveRunId = requestedRunId || playerRunId
  const activePresence = await db.all<PresenceRow>(
    `SELECT * FROM quiz_presence WHERE quiz_id = ? AND last_seen_at > ?
     AND (run_id IS NULL OR run_id = ?) ORDER BY player_name, player_id`,
    [quizId, new Date(Date.now() - presenceTimeoutMs).toISOString(),
      session && activeLiveStatuses.includes(session.status) ? session.run_id : null],
  )
  const roster = {
    activePlayerCount: activePresence.length,
    playerRunId,
    playerIsJoined: Boolean(presence),
    ...(admin ? {
      activePlayers: activePresence.map((player) => ({
        playerId: player.player_id, playerName: player.player_name,
        waiting: player.run_id === null || session?.status === 'holding',
      })),
    } : {}),
  }
  const empty = {
    quizId, status: 'idle' as const, runId: null as string | null, joinCode: null as string | null,
    currentQuestionIndex: 0, questionStartedAt: null as string | null,
    answerSeconds: 60, totalQuestions: questions.length, currentQuestion: null,
    playerAnswer: null, playerCount: activePresence.length, submittedAnswerCount: 0,
    revealAnswers: false, reveal: null, leaderboard: [] as RunResults['leaderboard'],
    completedStatsCode: null as string | null,
    ...roster,
  }
  if (effectiveRunId && effectiveRunId !== session?.run_id) {
    const pastRun = await getRun(db, effectiveRunId)
    if (!pastRun || pastRun.quiz_id !== quizId || pastRun.status === 'running' || !pastRun.results_json) {
      return undefined
    }
    const results = JSON.parse(pastRun.results_json) as RunResults
    return { ...empty, status: pastRun.status, runId: pastRun.id, playerCount: results.playerCount, totalQuestions: results.totalQuestions, leaderboard: results.leaderboard, completedStatsCode: statsCodeFor(pastRun) }
  }
  if (!quiz.is_published && !admin && !(
    effectiveRunId && session && ['finished', 'aborted'].includes(session.status)
  )) {
    return undefined
  }

  if (
    session?.status === 'running' && session.reveal_answers &&
    session.question_started_at &&
    Date.now() >= Date.parse(session.question_started_at) + session.answer_seconds * 1000
  ) {
    await db.run(
      `UPDATE live_sessions SET status = 'revealing'
       WHERE quiz_id = ? AND status = 'running' AND question_started_at = ? AND run_id = ?`,
      [quizId, session.question_started_at, session.run_id],
    )
    session = await getLiveSessionRow(db, quizId)
  }

  if (!session) {
    return empty
  }
  if (presence && !presence.run_id && !requestedRunId && ['finished', 'aborted'].includes(session.status)) {
    return empty
  }

  const currentQuestion = questions[session.current_question_index]
  const answers = await db.all<LiveAnswerRow>('SELECT * FROM live_answers WHERE quiz_id = ?', [quizId])
  const currentAnswers = answers.filter((answer) => answer.question_id === currentQuestion?.id)
  const playerAnswer = currentAnswers.find((answer) => answer.player_id === playerId)
  const players = session.run_id ? await getRunPlayers(db, session.run_id) : []
  const playerCount = scorePlayers(questions, answers, players).length
  const run = session.run_id ? await getRun(db, session.run_id) : undefined
  const reveal = session.status === 'revealing' && currentQuestion
    ? questionStats(currentQuestion, answers, playerCount, session.question_started_at ?? undefined, true) : null

  return {
    quizId,
    runId: session.run_id,
    joinCode: activeLiveStatuses.includes(session.status) ? run?.join_code ?? null : null,
    status: session.status,
    currentQuestionIndex: session.current_question_index,
    questionStartedAt: session.question_started_at,
    answerSeconds: session.answer_seconds,
    totalQuestions: questions.length,
    currentQuestion: currentQuestion ? toPublicQuestion(currentQuestion, session.status === 'revealing') : null,
    playerAnswer: playerAnswer?.selected_option_index ?? null,
    playerCount,
    submittedAnswerCount: currentAnswers.length,
    ...roster,
    revealAnswers: Boolean(session.reveal_answers),
    reveal,
    completedStatsCode: statsCodeFor(run),
    leaderboard: ['finished', 'aborted'].includes(session.status) && run?.results_json
      ? (JSON.parse(run.results_json) as RunResults).leaderboard : [],
  }
}

const startLiveQuiz = async (db: Db, quizId: string) => {
  const started = await db.transaction(async (tx) => {
    const result = await tx.run(
      'UPDATE quizzes SET has_run = 1 WHERE id = ? AND is_published = 1', [quizId],
    )
    if (!result.changes) {
      return false
    }
    const questions = await getQuestionRows(tx, quizId)
    const quiz = await tx.get<QuizRow>('SELECT * FROM quizzes WHERE id = ?', [quizId])
    if (!quiz || !questions.length) {
      throw new Error('Publish a quiz with questions before starting it.')
    }
    const session = await getLiveSessionRow(tx, quizId)
    if (session && activeLiveStatuses.includes(session.status)) {
      throw new Error('Finish or abort the active run before starting a new quiz run.')
    }
    const startedAt = new Date().toISOString()
    const runId = await insertRun(tx, quizId, startedAt, {})
    await tx.run('DELETE FROM live_answers WHERE quiz_id = ?', [quizId])
    await tx.run(
      `INSERT INTO live_sessions
       (quiz_id, current_question_index, question_started_at, status, answer_seconds, reveal_answers, run_id)
       VALUES (?, -1, NULL, 'holding', ?, ?, ?)
       ON CONFLICT(quiz_id) DO UPDATE SET
         current_question_index = excluded.current_question_index,
         question_started_at = excluded.question_started_at,
         status = excluded.status,
         answer_seconds = excluded.answer_seconds,
         reveal_answers = excluded.reveal_answers,
         run_id = excluded.run_id`,
      [quizId, questions[0].answer_seconds, quiz.reveal_answers, runId],
    )
    const waitingPlayers = await tx.all<PresenceRow>(
      'SELECT * FROM quiz_presence WHERE quiz_id = ? AND run_id IS NULL AND last_seen_at > ?',
      [quizId, new Date(Date.now() - presenceTimeoutMs).toISOString()],
    )
    for (const player of waitingPlayers) {
      await registerPlayer(tx, runId, player.player_id, player.player_name)
      await tx.run('UPDATE quiz_presence SET run_id = ? WHERE quiz_id = ? AND player_id = ?', [
        runId, quizId, player.player_id,
      ])
    }
    return true
  })

  return started ? getLiveSession(db, quizId, undefined, undefined, true) : undefined
}

const archiveLiveRun = async (db: DbClient, quizId: string, status: 'finished' | 'aborted') => {
  const session = await getLiveSessionRow(db, quizId)
  if (!session?.run_id || !activeLiveStatuses.includes(session.status)) {
    return false
  }
  const quiz = await db.get<QuizRow>('SELECT * FROM quizzes WHERE id = ?', [quizId])
  const run = await getRun(db, session.run_id)
  const questions = await getQuestionRows(db, quizId)
  if (!quiz || !run) {
    throw new Error('The live run could not be found.')
  }

  const answers = await db.all<LiveAnswerRow>(
    `SELECT quiz_id, question_id, player_id, player_name, selected_option_index, answered_at
     FROM live_answers
     WHERE quiz_id = ?`,
    [quizId],
  )
  const completedAt = new Date().toISOString()
  const times = JSON.parse(run.question_times_json) as Record<string, string>
  if (session.question_started_at && questions[session.current_question_index]) {
    times[questions[session.current_question_index].id] = session.question_started_at
  }
  const results = buildRunResults(quiz.title, questions, answers, await getRunPlayers(db, run.id), times, session.current_question_index)
  const updated = await db.run(
    `UPDATE quiz_runs SET status = ?, ended_at = ?, results_json = ?, question_times_json = ?
     WHERE id = ? AND status = 'running'`,
    [status, completedAt, JSON.stringify(results), JSON.stringify(times), run.id],
  )
  if (!updated.changes) {
    return false
  }
  if (status === 'finished') {
    for (const player of results.leaderboard) {
      await db.run(
        `INSERT INTO attempts
         (id, quiz_id, player_name, score, total_questions, completed_at, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [createId(), quizId, player.playerName, player.score, questions.length, completedAt, run.id],
      )
    }
  }
  await db.run('UPDATE live_sessions SET status = ?, question_started_at = NULL WHERE quiz_id = ? AND run_id = ?', [status, quizId, run.id])
  return true
}

const activateQuestion = async (db: DbClient, session: LiveSessionRow, questions: QuestionRow[], nextIndex: number) => {
  const run = session.run_id ? await getRun(db, session.run_id) : undefined
  const nextQuestion = questions[nextIndex]
  if (!run || !nextQuestion) {
    throw new Error('The live run or next question could not be found.')
  }
  const times = JSON.parse(run.question_times_json) as Record<string, string>
  const startedAt = new Date().toISOString()
  const previousQuestion = questions[session.current_question_index]
  if (session.question_started_at && previousQuestion) {
    times[previousQuestion.id] = session.question_started_at
  }
  times[nextQuestion.id] = startedAt
  await db.run('UPDATE quiz_runs SET question_times_json = ? WHERE id = ?', [JSON.stringify(times), run.id])
  await db.run(
    `UPDATE live_sessions SET current_question_index = ?, question_started_at = ?, status = 'running', answer_seconds = ?
     WHERE quiz_id = ? AND run_id = ?`,
    [nextIndex, startedAt, nextQuestion.answer_seconds, session.quiz_id, run.id],
  )
}

const beginLiveQuiz = async (db: Db, quizId: string, runId: string) => {
  const begun = await db.transaction(async (tx) => {
    await tx.run('UPDATE quizzes SET has_run = has_run WHERE id = ?', [quizId])
    const session = await getLiveSessionRow(tx, quizId)
    if (session?.status !== 'holding' || session.run_id !== runId) {
      return false
    }
    await tx.run(
      `DELETE FROM run_players WHERE run_id = ? AND player_id NOT IN (
         SELECT player_id FROM quiz_presence WHERE quiz_id = ? AND run_id = ? AND last_seen_at > ?
       )`,
      [runId, quizId, runId, new Date(Date.now() - presenceTimeoutMs).toISOString()],
    )
    await activateQuestion(tx, session, await getQuestionRows(tx, quizId), 0)
    return true
  })
  return begun ? getLiveSession(db, quizId, undefined, undefined, true) : undefined
}

const advanceLiveQuiz = async (db: Db, quizId: string) => {
  const advanced = await db.transaction(async (tx) => {
    await tx.run('UPDATE quizzes SET has_run = has_run WHERE id = ?', [quizId])
    const session = await getLiveSessionRow(tx, quizId)
    const questions = await getQuestionRows(tx, quizId)
    if (!session?.run_id || !['running', 'revealing'].includes(session.status) || !questions.length) {
      return false
    }
    if (session.status === 'running' && session.reveal_answers) {
      await tx.run("UPDATE live_sessions SET status = 'revealing' WHERE quiz_id = ?", [quizId])
    } else if (session.current_question_index + 1 >= questions.length) {
      await archiveLiveRun(tx, quizId, 'finished')
    } else {
      await activateQuestion(tx, session, questions, session.current_question_index + 1)
    }
    return true
  })
  return advanced ? getLiveSession(db, quizId, undefined, undefined, true) : undefined
}

const registerPlayer = async (db: DbClient, runId: string, playerId: string, playerName: string) => {
  if (!playerId.trim() || !playerName.trim()) {
    throw new Error('A player ID and player name are required.')
  }
  await db.run(
    `INSERT INTO run_players (run_id, player_id, player_name, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (run_id, player_id) DO UPDATE SET player_name = excluded.player_name`,
    [runId, playerId.trim(), playerName.trim(), new Date().toISOString()],
  )
}

const joinLiveQuiz = async (db: Db, quizId: string, input: JoinInput) => {
  const playerId = typeof input?.playerId === 'string' ? input.playerId.trim() : ''
  const playerName = typeof input?.playerName === 'string' ? input.playerName.trim() : ''
  if (!playerId || !playerName || typeof input.runId !== 'string' || !input.runId ||
    typeof input.joinCode !== 'string' || !/^\d{6}$/.test(input.joinCode)) {
    throw new Error('A valid event code, player name, player ID, and live run ID are required.')
  }
  await db.transaction(async (tx) => {
    const quiz = await tx.run('UPDATE quizzes SET has_run = has_run WHERE id = ? AND is_published = 1', [quizId])
    if (!quiz.changes) {
      throw new Error('This quiz is not currently published. Choose another quiz or ask the admin.')
    }
    const session = await getLiveSessionRow(tx, quizId)
    const activeRunId = session && activeLiveStatuses.includes(session.status) ? session.run_id : null
    const run = activeRunId ? await getRun(tx, activeRunId) : undefined
    if (!activeRunId || activeRunId !== input.runId || run?.join_code !== input.joinCode || run.status !== 'running') {
      throw new Error('This event code is not active. Check the code with the admin.')
    }
    await registerPlayer(tx, activeRunId, playerId, playerName)
    await tx.run(
      `INSERT INTO quiz_presence (quiz_id, player_id, player_name, run_id, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (quiz_id, player_id) DO UPDATE SET
         player_name = excluded.player_name, run_id = excluded.run_id, last_seen_at = excluded.last_seen_at`,
      [quizId, playerId, playerName, activeRunId, new Date().toISOString()],
    )
  })
  return getLiveSession(db, quizId, playerId)
}

const leaveLiveQuiz = async (db: Db, quizId: string, input: { playerId: string; runId: string | null }) => {
  if (typeof input?.playerId !== 'string' || !input.playerId.trim() ||
    (input.runId !== null && typeof input.runId !== 'string')) {
    throw new Error('A player ID and the joined run or waiting room are required.')
  }
  await db.transaction(async (tx) => {
    await tx.run('UPDATE quizzes SET has_run = has_run WHERE id = ?', [quizId])
    await tx.run(
      `DELETE FROM quiz_presence WHERE quiz_id = ? AND player_id = ? ${input.runId === null ? '' : 'AND run_id = ?'}`,
      [quizId, input.playerId.trim(), ...(input.runId === null ? [] : [input.runId])],
    )
  })
}

const submitLiveAnswer = async (db: Db, quizId: string, input: LiveAnswerInput) => {
  await db.transaction(async (db) => {
  await db.run('UPDATE quizzes SET has_run = has_run WHERE id = ?', [quizId])
  const session = await getLiveSessionRow(db, quizId)
  const questions = await getQuestionRows(db, quizId)
  const currentQuestion = questions[session?.current_question_index ?? -1]

  if (!session || session.status !== 'running' || !currentQuestion || !session.question_started_at) {
    throw new Error('This quiz is not accepting answers right now.')
  }
  if (!input.runId || input.runId !== session.run_id) {
    throw new Error('That answer belongs to a different run. Rejoin the current live quiz.')
  }

  if (currentQuestion.id !== input.questionId) {
    throw new Error('That question is not currently active.')
  }

  const elapsedSeconds = (Date.now() - Date.parse(session.question_started_at)) / 1000

  if (elapsedSeconds >= session.answer_seconds) {
    throw new Error('Time is up for this question.')
  }

  const playerId = typeof input.playerId === 'string' ? input.playerId.trim() : ''
  const playerName = typeof input.playerName === 'string' ? input.playerName.trim() : ''
  const selectedOptionIndex = Number(input.selectedOptionIndex)

  if (
    !playerId ||
    !playerName ||
    !Number.isInteger(selectedOptionIndex) ||
    selectedOptionIndex < 0 ||
    selectedOptionIndex >= JSON.parse(currentQuestion.options_json).length
  ) {
    throw new Error('Answer payload is invalid.')
  }
  await registerPlayer(db, input.runId, playerId, playerName)

  await db.run(
    `INSERT INTO live_answers
     (quiz_id, question_id, player_id, player_name, selected_option_index, answered_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(quiz_id, question_id, player_id) DO UPDATE SET
       player_name = excluded.player_name,
       selected_option_index = excluded.selected_option_index,
       answered_at = excluded.answered_at`,
    [quizId, input.questionId, playerId, playerName, selectedOptionIndex, new Date().toISOString()],
  )
  })
  return getLiveSession(db, quizId, input.playerId, input.runId)
}

const getSiteSettings = async (db: DbClient): Promise<SiteSettings> => {
  const row = await db.get<{ title: string; subtitle: string; player_base_url: string }>(
    "SELECT * FROM site_settings WHERE id = 'home'",
  )
  if (!row) {
    throw new Error('Site settings could not be found.')
  }
  return { title: row.title, subtitle: row.subtitle, playerBaseUrl: row.player_base_url }
}

const recordJoinLookup = (db: Db, clientId: string) => db.transaction(async (tx) => {
  const now = Date.now()
  const cutoff = now - 60_000
  await tx.run('DELETE FROM join_lookup_limits WHERE last_seen_at <= ?', [new Date(cutoff).toISOString()])
  // The upsert locks this browser's row on PostgreSQL; SQLite serializes transactions.
  await tx.run(
    `INSERT INTO join_lookup_limits (client_id, last_seen_at) VALUES (?, ?)
     ON CONFLICT (client_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    [clientId, new Date(now).toISOString()],
  )
  const row = await tx.get<{ attempts_json: string }>('SELECT attempts_json FROM join_lookup_limits WHERE client_id = ?', [clientId])
  if (!row) {
    throw new Error('Could not record the event lookup.')
  }
  const attempts = (JSON.parse(row.attempts_json) as number[]).filter((time) => time > cutoff)
  if (attempts.length >= 20) {
    return Math.max(1, Math.ceil((attempts[0] + 60_000 - now) / 1000))
  }
  await tx.run('UPDATE join_lookup_limits SET attempts_json = ? WHERE client_id = ?', [
    JSON.stringify([...attempts, now]), clientId,
  ])
  return 0
})

const saveSiteSettings = async (db: DbClient, input: SiteSettings) => {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200 ||
    typeof input.subtitle !== 'string' || input.subtitle.length > 1000 || typeof input.playerBaseUrl !== 'string') {
    throw new Error('Provide a title (1-200 characters), subtitle (up to 1000 characters), and optional player URL.')
  }
  const base = input.playerBaseUrl.trim()
  const url = base ? URL.parse(base) : null
  if (base && (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.search || url.hash || url.pathname !== '/')) {
    throw new Error('The player URL must be an HTTP(S) site origin, such as http://192.168.1.10:5173, without a path or credentials.')
  }
  await db.run("UPDATE site_settings SET title = ?, subtitle = ?, player_base_url = ? WHERE id = 'home'", [
    input.title.trim(), input.subtitle.trim(), url?.origin ?? '',
  ])
  return getSiteSettings(db)
}

const changePublication = (db: Db, quizId: string, isPublished: boolean) => db.transaction(async (tx) => {
  const locked = await tx.run('UPDATE quizzes SET is_published = is_published WHERE id = ?', [quizId])
  if (!locked.changes) {
    return undefined
  }
  const quiz = await getEditableQuiz(tx, quizId)
  if (!quiz) {
    return undefined
  }
  const session = await getLiveSessionRow(tx, quizId)
  if (!isPublished && session && activeLiveStatuses.includes(session.status)) {
    throw new Error('Finish or abort the live run before unpublishing this quiz.')
  }
  if (isPublished) {
    normalizeQuizInput({ ...quiz, isPublished: true })
  }
  await tx.run('UPDATE quizzes SET is_published = ? WHERE id = ?', [isPublished ? 1 : 0, quizId])
  if (!isPublished) {
    await tx.run('DELETE FROM quiz_presence WHERE quiz_id = ?', [quizId])
  }
  return (await listQuizzes(tx, true)).find((entry) => entry.id === quizId)
})

const contentTypes: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const serveStatic = (res: ServerResponse, pathname: string) => {
  if (!existsSync(distPath)) {
    sendError(res, 404, 'Build the client with npm run build before using the production server.')
    return
  }

  const requestedPath = pathname === '/' ? '/index.html' : pathname
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = path.join(distPath, safePath)
  const finalPath =
    existsSync(filePath) && statSync(filePath).isFile() ? filePath : path.join(distPath, 'index.html')
  const extension = path.extname(finalPath)

  res.writeHead(200, { 'Content-Type': contentTypes[extension] ?? 'application/octet-stream' })
  createReadStream(finalPath).pipe(res)
}

const handleApiRequest = async (db: Db, req: IncomingMessage, res: ServerResponse, pathname: string) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, null)
    return
  }

  if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/health')) {
    sendJson(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && pathname === '/api/admin/auth') {
    if (!requireAdmin(req, res)) {
      return
    }
    sendJson(res, 200, { ok: true })
    return
  }
    if (pathname === '/api/settings' && req.method === 'GET') {
      sendJson(res, 200, await getSiteSettings(db))
      return
    }
    if (pathname === '/api/settings' && req.method === 'PUT') {
      if (!requireAdmin(req, res)) {
        return
      }
      try {
        sendJson(res, 200, await saveSiteSettings(db, await readJsonBody<SiteSettings>(req)))
      } catch (error) {
        sendError(res, 400, error instanceof Error ? error.message : 'Could not save site settings.')
      }
      return
    }
    const joinCodeMatch = pathname.match(/^\/api\/join\/([^/]+)$/)
    if (req.method === 'GET' && joinCodeMatch) {
      res.setHeader('Cache-Control', 'no-store')
      const clientId = req.headers['x-quiz-client-id']
      if (typeof clientId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(clientId)) {
        sendError(res, 400, 'A browser identifier is required to look up an event code. Enable browser storage and try again.')
        return
      }
      const retryAfter = await recordJoinLookup(db, clientId)
      if (retryAfter) {
        sendJson(res, 429, { error: 'You have searched too many times. Please try again in a few minutes.' }, {
          'Retry-After': String(retryAfter), 'Cache-Control': 'no-store',
        })
        return
      }
      if (!/^\d{6}$/.test(joinCodeMatch[1])) {
        sendError(res, 400, 'Enter a 6-digit event code.')
        return
      }
      const run = await db.get<RunRow>('SELECT * FROM quiz_runs WHERE join_code = ?', [joinCodeMatch[1]])
      const quiz = run ? (await listQuizzes(db)).find((entry) => entry.id === run.quiz_id) : undefined
      if (!run || !quiz || run.status === 'aborted' ||
        (run.status === 'finished' && (!quiz.displayStats || !run.results_json))) {
        sendError(res, 404, 'This event code is not active. Check the code with the admin.')
        return
      }
      sendJson(res, 200, run.status === 'finished'
        ? { kind: 'completed', quiz, runId: run.id, joinCode: run.join_code, run: toPublicRun(run) }
        : { kind: 'live', quiz, runId: run.id, joinCode: run.join_code }, { 'Cache-Control': 'no-store' })
      return
    }
  if (req.method === 'GET' && pathname === '/api/quizzes') {
    sendJson(res, 200, await listQuizzes(db))
    return
  }

  if (req.method === 'GET' && pathname === '/api/admin/quizzes') {
    if (!requireAdmin(req, res)) {
      return
    }
    sendJson(res, 200, await listQuizzes(db, true))
    return
  }

  const imageMatch = pathname.match(/^\/api\/questions\/([^/]+)\/image(\/after)?$/)
  if (req.method === 'GET' && imageMatch) {
    const question = await db.get<Pick<QuestionRow, 'quiz_id' | 'sort_order' | 'image_url' | 'after_image_url'> & Pick<QuizRow, 'is_published'>>(
      `SELECT questions.quiz_id, questions.sort_order, questions.image_url, questions.after_image_url, quizzes.is_published FROM questions
       JOIN quizzes ON quizzes.id = questions.quiz_id WHERE questions.id = ?`, [imageMatch[1]],
    )
    if (question && !question.is_published && !requireAdmin(req, res)) {
      return
    }
    const after = Boolean(imageMatch[2])
    if (question && after && !isAdminAuthorized(req)) {
      const session = await getLiveSessionRow(db, question.quiz_id)
      const wasRevealed = session?.reveal_answers && (
        question.sort_order < session.current_question_index ||
        (question.sort_order === session.current_question_index && ['revealing', 'finished'].includes(session.status))
      )
      if (!wasRevealed) {
        sendError(res, 403, 'This picture is available after the answer is revealed.')
        return
      }
    }
    const image = (after ? question?.after_image_url : question?.image_url)?.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/)
    if (!image) {
      sendError(res, 404, 'Question image was not found.')
      return
    }
    const data = Buffer.from(image[2], 'base64')
    res.writeHead(200, {
      'Content-Type': image[1],
      'Content-Length': data.length,
      'Cache-Control': question?.is_published && !after ? 'public, max-age=31536000, immutable' : 'private, no-store',
    })
    res.end(data)
    return
  }

  if (req.method === 'POST' && pathname === '/api/quizzes') {
    if (!requireAdmin(req, res)) {
      return
    }

    try {
      const quiz = await createQuiz(db, await readJsonBody<QuizInput>(req))
      sendJson(res, 201, quiz)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not create quiz.')
    }
    return
  }

  if (req.method === 'POST' && pathname === '/api/quizzes/import') {
    if (!requireAdmin(req, res)) {
      return
    }
    try {
      sendJson(res, 201, await importQuiz(db, await readJsonBody<unknown>(req)))
    } catch (error) {
      sendError(res, 400, error instanceof SyntaxError ? 'The selected file is not valid JSON.' :
        error instanceof Error ? error.message : 'Could not import quiz.')
    }
    return
  }

  const exportMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/export$/)
  if (req.method === 'GET' && exportMatch) {
    if (!requireAdmin(req, res)) {
      return
    }
    const exported = await exportQuiz(db, exportMatch[1])
    if (!exported) {
      sendError(res, 404, 'Quiz was not found.')
      return
    }
    if (Buffer.byteLength(JSON.stringify(exported), 'utf8') > maxQuizFileBytes) {
      sendError(res, 400, 'This quiz exceeds the 32 MB export/import limit. Reduce its image data before exporting.')
      return
    }
    const filename = exported.quiz.title.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'quiz'
    sendJson(res, 200, exported, {
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${filename}.quizarena.json"`,
    })
    return
  }

  const quizMatch = pathname.match(/^\/api\/quizzes\/([^/]+)$/)
  const statsSettingsMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/stats-settings$/)
  if (req.method === 'PUT' && statsSettingsMatch) {
    if (!requireAdmin(req, res)) {
      return
    }
    try {
      const input = await readJsonBody<{ displayStats: boolean }>(req)
      if (typeof input?.displayStats !== 'boolean') {
        throw new Error('Completed stats display must be enabled or disabled.')
      }
      const result = await db.run('UPDATE quizzes SET display_stats = ? WHERE id = ?', [
        input.displayStats ? 1 : 0, statsSettingsMatch[1],
      ])
      if (!result.changes) {
        sendError(res, 404, 'Quiz was not found.')
        return
      }
      sendJson(res, 200, (await listQuizzes(db, true)).find((quiz) => quiz.id === statsSettingsMatch[1]))
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not change completed stats display.')
    }
    return
  }
  const copyMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/copy$/)
  const runsMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/runs$/)
  if (req.method === 'GET' && runsMatch) {
    if (!requireAdmin(req, res)) {
      return
    }
    const quiz = await db.get<QuizRow>('SELECT * FROM quizzes WHERE id = ?', [runsMatch[1]])
    if (!quiz) {
      sendError(res, 404, 'Quiz was not found.')
      return
    }
    const runs = await db.all<RunRow>(
      "SELECT * FROM quiz_runs WHERE quiz_id = ? AND status <> 'running' ORDER BY ended_at DESC, id DESC", [quiz.id],
    )
    sendJson(res, 200, runs.map(toPublicRun))
    return
  }
  const publicationMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/publication$/)
  if (req.method === 'PUT' && publicationMatch) {
    if (!requireAdmin(req, res)) {
      return
    }
    try {
      const input = await readJsonBody<{ isPublished: boolean }>(req)
      if (typeof input?.isPublished !== 'boolean') {
        throw new Error('Choose whether to publish or unpublish the quiz.')
      }
      const quiz = await changePublication(db, publicationMatch[1], input.isPublished)
      if (!quiz) {
        sendError(res, 404, 'Quiz was not found.')
        return
      }
      sendJson(res, 200, quiz)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not change publication.')
    }
    return
  }

  if (req.method === 'POST' && copyMatch) {
    if (!requireAdmin(req, res)) {
      return
    }
    const quiz = await copyQuiz(db, copyMatch[1])
    if (!quiz) {
      sendError(res, 404, 'Quiz was not found.')
      return
    }
    sendJson(res, 201, quiz)
    return
  }

  if (req.method === 'GET' && quizMatch) {
    if (!requireAdmin(req, res)) {
      return
    }
    const quiz = await getEditableQuiz(db, quizMatch[1])
    if (!quiz) {
      sendError(res, 404, 'Quiz was not found.')
      return
    }
    sendJson(res, 200, quiz)
    return
  }

  if (req.method === 'PUT' && quizMatch) {
    if (!requireAdmin(req, res)) {
      return
    }
    try {
      const quiz = await updateQuiz(db, quizMatch[1], await readJsonBody<QuizInput>(req))
      if (!quiz) {
        sendError(res, 404, 'Quiz was not found.')
        return
      }
      sendJson(res, 200, quiz)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not update quiz.')
    }
    return
  }

  if (req.method === 'DELETE' && quizMatch) {
    if (!requireAdmin(req, res)) {
      return
    }

    sendJson(res, (await deleteQuiz(db, quizMatch[1])) ? 204 : 404, null)
    return
  }

  const attemptMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/attempts$/)

  if (req.method === 'POST' && attemptMatch) {
    try {
      const attempt = await createAttempt(db, attemptMatch[1], await readJsonBody<AttemptInput>(req))

      if (!attempt) {
        sendError(res, 404, 'Quiz was not found.')
        return
      }

      sendJson(res, 201, attempt)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not save attempt.')
    }
    return
  }

  if (req.method === 'GET' && pathname === '/api/attempts') {
    sendJson(res, 200, await listAttempts(db))
    return
  }

  const liveMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live$/)

  if (req.method === 'GET' && liveMatch) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const session = await getLiveSession(
      db, liveMatch[1], url.searchParams.get('playerId') ?? undefined,
      url.searchParams.get('runId') ?? undefined, isAdminAuthorized(req),
    )

    if (!session) {
      sendError(res, 404, 'Quiz was not found.')
      return
    }

    sendJson(res, 200, session)
    return
  }

  const liveStartMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/start$/)

  if (req.method === 'POST' && liveStartMatch) {
    if (!requireAdmin(req, res)) {
      return
    }

    try {
      const session = await startLiveQuiz(db, liveStartMatch[1])
      if (!session) {
        sendError(res, 404, 'Quiz was not found.')
        return
      }
      sendJson(res, 200, session)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not start this quiz.')
    }
    return
  }

  const liveBeginMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/begin$/)
  if (req.method === 'POST' && liveBeginMatch) {
    if (!requireAdmin(req, res)) {
      return
    }
    try {
      const input = await readJsonBody<{ runId: string }>(req)
      if (typeof input?.runId !== 'string' || !input.runId) {
        throw new Error('Select the active holding run before beginning the first question.')
      }
      const session = await beginLiveQuiz(db, liveBeginMatch[1], input.runId)
      if (!session) {
        sendError(res, 400, 'This run is not holding for its first question. Refresh the live controls.')
        return
      }
      sendJson(res, 200, session)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not begin the first question.')
    }
    return
  }

  const liveNextMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/next$/)
  const liveAbortMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/abort$/)
  if (req.method === 'POST' && liveAbortMatch) {
    if (!requireAdmin(req, res)) {
      return
    }
    const aborted = await db.transaction(async (tx) => {
      await tx.run('UPDATE quizzes SET has_run = has_run WHERE id = ?', [liveAbortMatch[1]])
      return archiveLiveRun(tx, liveAbortMatch[1], 'aborted')
    })
    if (!aborted) {
      sendError(res, 400, 'There is no active live run to abort.')
      return
    }
    sendJson(res, 200, await getLiveSession(db, liveAbortMatch[1], undefined, undefined, true))
    return
  }
  const liveJoinMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/join$/)
  const liveLeaveMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/leave$/)
  if (req.method === 'POST' && liveLeaveMatch) {
    try {
      await leaveLiveQuiz(db, liveLeaveMatch[1], await readJsonBody<{ playerId: string; runId: string | null }>(req))
      sendJson(res, 204, null)
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not leave this quiz.')
    }
    return
  }
  if (req.method === 'POST' && liveJoinMatch) {
    try {
      sendJson(res, 200, await joinLiveQuiz(db, liveJoinMatch[1], await readJsonBody<JoinInput>(req)))
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not join this run.')
    }
    return
  }

  if (req.method === 'POST' && liveNextMatch) {
    if (!requireAdmin(req, res)) {
      return
    }

    const session = await advanceLiveQuiz(db, liveNextMatch[1])

    if (!session) {
      sendError(res, 400, 'Begin the first question before advancing, or start a new live quiz.')
      return
    }

    sendJson(res, 200, session)
    return
  }

  const liveAnswerMatch = pathname.match(/^\/api\/quizzes\/([^/]+)\/live\/answer$/)

  if (req.method === 'POST' && liveAnswerMatch) {
    try {
      sendJson(
        res,
        200,
        await submitLiveAnswer(db, liveAnswerMatch[1], await readJsonBody<LiveAnswerInput>(req)),
      )
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : 'Could not save answer.')
    }
    return
  }

  sendError(res, 404, 'Not found.')
}

const bootstrap = async () => {
  const db = await createDatabase()

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname.startsWith('/api/')) {
      const handle = async () => {
        try {
          await handleApiRequest(db, req, res, url.pathname)
        } catch (error) {
          console.error('API request failed.', error)
          if (!res.headersSent) {
            sendError(res, 500, 'The server could not complete this request.')
          } else {
            res.end()
          }
        }
      }
      void handle()
      return
    }

    serveStatic(res, url.pathname)
  })

  server.listen(port, () => {
    const address = server.address()
    console.log(`Quiz API running on http://localhost:${typeof address === 'object' && address ? address.port : port}`)
    if (databaseUrl) {
      console.log('Connected to shared PostgreSQL database.')
    } else {
      console.log(`Using local SQLite database at ${databasePath}.`)
    }
  })
}

void bootstrap().catch((error: unknown) => {
  console.error('Failed to start server.', error)
  process.exit(1)
})
