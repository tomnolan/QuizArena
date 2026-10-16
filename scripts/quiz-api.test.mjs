import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)
const password = 'quiz-integration-test'
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const question = (changes = {}) => ({
  prompt: 'Which answer is correct?',
  options: ['First', 'Second', 'Third', 'Fourth'],
  correctOptionIndex: 1,
  ...changes,
})
const quizInput = (changes = {}) => ({ title: 'Test quiz', questions: [question()], ...changes })

async function startApp(t, legacy = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'quizarena-test-'))
  const databasePath = path.join(directory, 'quiz.sqlite')
  const sqlite = new DatabaseSync(databasePath)
  if (legacy) {
    sqlite.exec(`
      CREATE TABLE quizzes (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE questions (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE, prompt TEXT NOT NULL, options_json TEXT NOT NULL, correct_option_index INTEGER NOT NULL, sort_order INTEGER NOT NULL);
      CREATE TABLE live_sessions (quiz_id TEXT PRIMARY KEY REFERENCES quizzes(id) ON DELETE CASCADE, current_question_index INTEGER NOT NULL, question_started_at TEXT, status TEXT NOT NULL, answer_seconds INTEGER NOT NULL);
      CREATE TABLE attempts (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE, player_name TEXT NOT NULL, score INTEGER NOT NULL, total_questions INTEGER NOT NULL, completed_at TEXT NOT NULL);
      INSERT INTO quizzes VALUES ('legacy', 'Legacy quiz', '', '2026-01-01T00:00:00.000Z');
      INSERT INTO quizzes VALUES ('legacy-unused', 'Unused legacy quiz', '', '2026-01-01T00:00:00.000Z');
      INSERT INTO quizzes VALUES ('legacy-attempt', 'Attempt-only legacy quiz', '', '2026-01-01T00:00:00.000Z');
      INSERT INTO questions VALUES ('legacy-question', 'legacy', 'Old question', '["A","B","C","D"]', 0, 0);
      INSERT INTO live_sessions VALUES ('legacy', 0, NULL, 'finished', 60);
      INSERT INTO attempts VALUES ('legacy-score', 'legacy-attempt', 'Legacy player', 1, 1, '2026-01-01T00:00:00.000Z');
    `)
  }
  let child
  let origin
  const currentRuns = new Map()
  const lookupClientId = crypto.randomUUID()
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
  t.after(async () => {
    await stop()
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  })
  const launch = async () => {
    child = spawn(process.execPath, [path.join(root, 'dist-server', 'index.js')], {
      cwd: root,
      env: { ...process.env, PORT: '0', DATABASE_PATH: databasePath, DATABASE_URL: '', ADMIN_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10_000)
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${output}`)) })
      child.stderr.on('data', (data) => { output += data })
      child.stdout.on('data', (data) => {
        output += data
        const match = output.match(/Quiz API running on (http:\/\/localhost:\d+)/)
        if (match) {
          origin = match[1]
          clearTimeout(timer)
          resolve()
        }
      })
    })
  }
  await launch()
  const request = async (url, { method = 'GET', body, admin = false, status = 200 } = {}) => {
    const response = await fetch(`${origin}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(url.startsWith('/api/join/') ? { 'x-quiz-client-id': lookupClientId } : {}),
        ...(admin ? { 'x-admin-password': password } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const result = response.status === 204 ? null : await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  await request('/api/health')
  const hold = async (id) => {
    const session = await request(`/api/quizzes/${id}/live/start`, { method: 'POST', admin: true })
    currentRuns.set(id, session.runId)
    return session
  }
  const begin = (id, status = 200) => request(`/api/quizzes/${id}/live/begin`, {
    method: 'POST', admin: true, status, body: { runId: currentRuns.get(id) },
  })
  return {
    sqlite,
    databasePath,
    request,
    raw: (url, options) => fetch(`${origin}${url}`, options),
    restart: async () => { await stop(); await launch(); await request('/api/health') },
    create: (body = quizInput()) => request('/api/quizzes', { method: 'POST', admin: true, body, status: 201 }),
    live: (id, playerId = '', runId = '') => request(`/api/quizzes/${id}/live?playerId=${encodeURIComponent(playerId)}&runId=${encodeURIComponent(runId)}`),
    hold,
    begin,
    start: async (id) => {
      await hold(id)
      return begin(id)
    },
    next: (id, status = 200) => request(`/api/quizzes/${id}/live/next`, { method: 'POST', admin: true, status }),
    answer: (id, questionId, playerId, selectedOptionIndex, status = 200) =>
      request(`/api/quizzes/${id}/live/answer`, {
        method: 'POST', status, body: { runId: currentRuns.get(id), questionId, playerId, playerName: playerId, selectedOptionIndex },
      }),
    expire: (id) => sqlite.prepare(
      "UPDATE live_sessions SET question_started_at = ? WHERE quiz_id = ?",
    ).run(new Date(Date.now() - 120_000).toISOString(), id),
  }
}

test('admin-only authoring and exact question timer/image validation', async (t) => {
  const app = await startApp(t)
  await app.request('/api/quizzes', { method: 'POST', body: quizInput(), status: 401 })
  const quiz = await app.create(quizInput({
    revealAnswers: true,
    questions: [question({ imageUrl: pixel, explanation: 'More detail', answerSeconds: 20 })],
  }))
  assert.equal(quiz.questions[0].answerSeconds, 20)
  assert.equal(quiz.questions[0].imageUrl, `/api/questions/${quiz.questions[0].id}/image`)
  const image = await app.raw(quiz.questions[0].imageUrl)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(image.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(pixel.split(',')[1], 'base64'))
  assert.equal('correctOptionIndex' in quiz.questions[0], false)
  assert.equal('explanation' in quiz.questions[0], false)
  await app.request(`/api/quizzes/${quiz.id}`, { status: 401 })
  await app.request(`/api/quizzes/${quiz.id}`, { method: 'PUT', body: quizInput(), status: 401 })
  const editable = await app.request(`/api/quizzes/${quiz.id}`, { admin: true })
  assert.equal(editable.questions[0].correctOptionIndex, 1)
  assert.equal(editable.questions[0].explanation, 'More detail')
  assert.equal(editable.questions[0].imageUrl, pixel)
  assert.equal(editable.questions[0].afterImageUrl, '')
  assert.equal(editable.questions[0].reuseBeforeImage, false)
  for (const answerSeconds of [19, 0, -1, 20.5, '20']) {
    await app.request('/api/quizzes', {
      method: 'POST', admin: true, status: 400,
      body: quizInput({ questions: [question({ answerSeconds })] }),
    })
  }
  for (const imageUrl of ['javascript:alert(1)', 'file:///image.png', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    await app.request('/api/quizzes', {
      method: 'POST', admin: true, status: 400,
      body: quizInput({ questions: [question({ imageUrl })] }),
    })
  }
  await app.create(quizInput({ questions: [question({ imageUrl: 'https://example.com/image.png' })] }))
  const largeQuiz = await app.create(quizInput({ questions: [question({
    imageUrl: `data:image/png;base64,${Buffer.alloc(2_000_000).toString('base64')}`,
  })] }))
  const liveWithLargeImage = await app.start(largeQuiz.id)
  assert.ok(JSON.stringify(liveWithLargeImage).length < 5000, 'Live polls must reference images, not retransmit image data')
  const largeImage = await app.raw(largeQuiz.questions[0].imageUrl)
  assert.equal((await largeImage.arrayBuffer()).byteLength, 2_000_000)
  await app.request('/api/quizzes', {
    method: 'POST', admin: true, status: 400,
    body: quizInput({ questions: [question({
      imageUrl: `data:image/png;base64,${Buffer.alloc(2_000_001).toString('base64')}`,
    })] }),
  })
})

test('automatic reveal, response stats, admin pacing, and run-specific final leaderboard', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({
    revealAnswers: true,
    questions: [
      question({ imageUrl: pixel, explanation: 'The second option is correct.', answerSeconds: 20 }),
      question({ answerSeconds: 35 }),
    ],
  }))
  const base = `/api/quizzes/${quiz.id}`
  let session = await app.start(quiz.id)
  assert.equal(session.answerSeconds, 20)
  assert.equal(session.currentQuestion.imageUrl, `/api/questions/${quiz.questions[0].id}/image`)
  assert.equal(session.reveal, null)
  assert.deepEqual(session.leaderboard, [])
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 0)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  await app.answer(quiz.id, quiz.questions[0].id, 'Bob', 0)
  await app.request(base, { method: 'PUT', admin: true, body: quizInput(), status: 400 })
  const started = Date.now() - 21_000
  app.sqlite.prepare('UPDATE live_sessions SET question_started_at = ? WHERE quiz_id = ?')
    .run(new Date(started).toISOString(), quiz.id)
  for (const [name, seconds] of [['Alice', 2], ['Bob', 1]]) {
    app.sqlite.prepare('UPDATE live_answers SET answered_at = ? WHERE quiz_id = ? AND player_id = ?')
      .run(new Date(started + seconds * 1000).toISOString(), quiz.id, name)
  }
  session = await app.live(quiz.id, 'Alice')
  assert.equal(session.status, 'revealing')
  assert.equal(session.playerAnswer, 1)
  assert.equal(session.reveal.correctOptionIndex, 1)
  assert.equal(session.reveal.explanation, 'The second option is correct.')
  assert.deepEqual(session.reveal.optionCounts, [1, 1, 0, 0])
  assert.equal(session.reveal.correctCount, 1)
  assert.equal(session.reveal.incorrectCount, 1)
  assert.deepEqual(session.reveal.fastestAnswers, [
    { playerName: 'Bob', responseSeconds: 1, isCorrect: false },
    { playerName: 'Alice', responseSeconds: 2, isCorrect: true },
  ])
  assert.equal((await app.live(quiz.id)).currentQuestionIndex, 0)
  await app.answer(quiz.id, quiz.questions[0].id, 'Late', 1, 400)
  await app.request(base, { method: 'PUT', admin: true, body: quizInput(), status: 400 })
  session = await app.next(quiz.id)
  assert.equal(session.currentQuestionIndex, 1)
  assert.equal(session.answerSeconds, 35)
  assert.equal(session.reveal, null)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1, 400)
  await app.answer(quiz.id, quiz.questions[1].id, 'Alice', 1)
  app.expire(quiz.id)
  session = await app.live(quiz.id)
  assert.equal(session.status, 'revealing')
  assert.equal(session.reveal.unansweredCount, 1)
  session = await app.next(quiz.id)
  assert.equal(session.status, 'finished')
  assert.deepEqual(session.leaderboard, [
    { playerId: 'Alice', playerName: 'Alice', score: 2, totalQuestions: 2 },
    { playerId: 'Bob', playerName: 'Bob', score: 0, totalQuestions: 2 },
  ])
  assert.equal((await app.request('/api/attempts')).length, 2)
  await app.next(quiz.id, 400)
  assert.equal((await app.request('/api/attempts')).length, 2)
  await app.start(quiz.id)
  assert.deepEqual((await app.live(quiz.id)).leaderboard, [])
  assert.equal((await app.live(quiz.id)).playerCount, 0)
  await app.next(quiz.id) // Early reveal also prevents further answers.
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1, 400)
  await app.next(quiz.id)
  await app.answer(quiz.id, quiz.questions[1].id, 'Carol', 1)
  await app.next(quiz.id)
  session = await app.next(quiz.id)
  assert.equal(session.leaderboard.length, 1)
  assert.equal(session.leaderboard[0].playerName, 'Carol')
  assert.equal((await app.request('/api/attempts')).length, 3)
})

test('editing works before first start; used quizzes are immutable and copies preserve original results', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const updated = await app.request(`/api/quizzes/${quiz.id}`, {
    method: 'PUT', admin: true,
    body: quizInput({
      title: 'Updated title', description: 'Updated description', revealAnswers: true,
      questions: [question({ prompt: 'Updated prompt', imageUrl: pixel, explanation: 'Updated detail', answerSeconds: 20 }), question()],
    }),
  })
  assert.equal(updated.id, quiz.id)
  assert.equal(updated.createdAt, quiz.createdAt)
  assert.equal(updated.questions.length, 2)
  assert.notEqual(updated.questions[0].id, quiz.questions[0].id)
  assert.equal((await app.live(quiz.id)).status, 'idle')
  let attempts = await app.request('/api/attempts')
  assert.equal(attempts.length, 0)
  await app.restart()
  const stored = await app.request(`/api/quizzes/${quiz.id}`, { admin: true })
  assert.equal(stored.title, 'Updated title')
  assert.equal(stored.questions[0].explanation, 'Updated detail')
  assert.equal(stored.questions[0].imageUrl, pixel)
  assert.equal(stored.questions[0].answerSeconds, 20)
  assert.equal(stored.revealAnswers, true)
  assert.equal(stored.hasRun, false)
  assert.equal((await app.start(quiz.id)).answerSeconds, 20)
  let locked = await app.request(`/api/quizzes/${quiz.id}`, { method: 'PUT', admin: true, body: quizInput(), status: 400 })
  assert.match(locked.error, /already been run/)
  await app.answer(quiz.id, stored.questions[0].id, 'Alice', 1)
  await app.next(quiz.id)
  await app.next(quiz.id)
  await app.answer(quiz.id, stored.questions[1].id, 'Alice', 1)
  await app.next(quiz.id)
  await app.next(quiz.id)
  attempts = await app.request('/api/attempts')
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].score, 2)
  assert.equal(attempts[0].totalQuestions, 2)
  await app.restart()
  locked = await app.request(`/api/quizzes/${quiz.id}`, { method: 'PUT', admin: true, body: quizInput(), status: 400 })
  assert.match(locked.error, /Copy it/)
  const copy = await app.request(`/api/quizzes/${quiz.id}/copy`, { method: 'POST', admin: true, status: 201 })
  assert.notEqual(copy.id, quiz.id)
  assert.equal(copy.isPublished, false)
  assert.equal(copy.hasRun, false)
  assert.equal(copy.title, 'Updated title (copy)')
  const copied = await app.request(`/api/quizzes/${copy.id}`, { admin: true })
  assert.equal(copied.questions[0].imageUrl, pixel)
  assert.equal(copied.questions[0].explanation, 'Updated detail')
  assert.equal(copied.questions[0].answerSeconds, 20)
  assert.equal(copied.questions[0].correctOptionIndex, 1)
  assert.notEqual(copied.questions[0].id, stored.questions[0].id)
  assert.equal((await app.live(quiz.id)).status, 'finished')
  assert.equal((await app.request('/api/attempts')).length, 1)
  await app.request(`/api/quizzes/${copy.id}`, { method: 'PUT', admin: true, body: quizInput({ title: 'Modified copy' }) })
  assert.equal((await app.request(`/api/quizzes/${quiz.id}`, { admin: true })).title, 'Updated title')
  await app.request(`/api/quizzes/${quiz.id}`, { method: 'DELETE', admin: true, status: 204 })
  const copyImage = await app.raw(copy.questions[0].imageUrl)
  assert.equal(copyImage.status, 404) // Editing replaced the copy's question IDs.
  await app.request(`/api/quizzes/${copy.id}`, { method: 'DELETE', admin: true, status: 204 })
  assert.equal((await app.request('/api/quizzes')).length, 0)
  assert.equal((await app.request('/api/attempts')).length, 0)
})

test('default mode preserves hidden answers and rejects submissions once the exact time limit is reached', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({ questions: [question({ answerSeconds: 20 }), question()] }))
  assert.equal(quiz.revealAnswers, false)
  await app.start(quiz.id)
  app.sqlite.prepare('UPDATE live_sessions SET question_started_at = ? WHERE quiz_id = ?')
    .run(new Date(Date.now() - 20_000).toISOString(), quiz.id)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1, 400)
  let session = await app.live(quiz.id)
  assert.equal(session.status, 'running')
  assert.equal(session.reveal, null)
  session = await app.next(quiz.id)
  assert.equal(session.currentQuestionIndex, 1)
  assert.equal(session.answerSeconds, 60)
  session = await app.next(quiz.id)
  assert.equal(session.status, 'finished')
  assert.deepEqual(session.leaderboard, [])
})

test('legacy SQLite databases upgrade without losing quizzes and migration is repeatable', async (t) => {
  const app = await startApp(t, true)
  let quiz = (await app.request('/api/quizzes')).find((entry) => entry.id === 'legacy')
  assert.equal(quiz.id, 'legacy')
  assert.equal(quiz.questions[0].answerSeconds, 60)
  assert.equal(quiz.questions[0].imageUrl, '')
  assert.equal(quiz.revealAnswers, false)
  assert.equal(quiz.isPublished, true)
  assert.equal(quiz.hasRun, true)
  const legacyList = await app.request('/api/admin/quizzes', { admin: true })
  assert.equal(legacyList.find((entry) => entry.id === 'legacy-unused').hasRun, false)
  assert.equal(legacyList.find((entry) => entry.id === 'legacy-attempt').hasRun, true)
  await app.request('/api/quizzes/legacy', { method: 'PUT', admin: true, body: quizInput(), status: 400 })
  await app.request('/api/quizzes/legacy-attempt', { method: 'PUT', admin: true, body: quizInput(), status: 400 })
  await app.request('/api/quizzes/legacy-unused', { method: 'PUT', admin: true, body: quizInput() })
  const editable = await app.request('/api/quizzes/legacy', { admin: true })
  assert.equal(editable.questions[0].explanation, '')
  assert.equal(editable.questions[0].correctOptionIndex, 0)
  await app.restart()
  quiz = (await app.request('/api/quizzes')).find((entry) => entry.id === 'legacy')
  assert.equal(quiz.questions.length, 1)
  assert.equal((await app.start(quiz.id)).answerSeconds, 60)
})

test('drafts are private, accept incomplete questions, can be copied, and must be complete to publish', async (t) => {
  const app = await startApp(t)
  await app.request('/api/admin/quizzes', { status: 401 })
  const draft = await app.create(quizInput({
    isPublished: false,
    questions: [question({ prompt: '', options: ['', '', '', ''], imageUrl: pixel })],
  }))
  assert.equal(draft.isPublished, false)
  assert.equal(draft.hasRun, false)
  assert.deepEqual(await app.request('/api/quizzes'), [])
  assert.equal((await app.request('/api/admin/quizzes', { admin: true })).length, 1)
  await app.request(`/api/quizzes/${draft.id}/live`, { status: 404 })
  await app.request(`/api/quizzes/${draft.id}/live/start`, { method: 'POST', admin: true, status: 404 })
  await app.request(`/api/quizzes/${draft.id}/attempts`, { method: 'POST', body: { playerName: 'Alice', answers: {} }, status: 404 })
  assert.equal((await app.raw(draft.questions[0].imageUrl)).status, 401)
  await app.request(`/api/quizzes/${draft.id}/copy`, { method: 'POST', status: 401 })
  const copy = await app.request(`/api/quizzes/${draft.id}/copy`, { method: 'POST', admin: true, status: 201 })
  const editable = await app.request(`/api/quizzes/${copy.id}`, { admin: true })
  assert.equal(editable.isPublished, false)
  assert.equal(editable.questions[0].prompt, '')
  assert.equal(editable.questions[0].imageUrl, pixel)
  assert.notEqual(editable.questions[0].id, draft.questions[0].id)
  await app.request(`/api/quizzes/${copy.id}`, {
    method: 'PUT', admin: true, status: 400,
    body: { ...editable, isPublished: true },
  })
  const published = await app.request(`/api/quizzes/${copy.id}`, {
    method: 'PUT', admin: true, body: quizInput({ questions: [question({ imageUrl: pixel })], isPublished: true }),
  })
  assert.equal(published.id, copy.id)
  assert.equal(published.hasRun, false)
  const publicList = await app.request('/api/quizzes')
  assert.equal(publicList.length, 1)
  assert.equal(publicList[0].id, copy.id)
  assert.equal((await app.request('/api/admin/quizzes', { admin: true })).length, 2)
  await app.restart()
  assert.equal((await app.request('/api/admin/quizzes', { admin: true })).find((quiz) => quiz.id === draft.id).isPublished, false)
  const beforeRunCopy = await app.request(`/api/quizzes/${copy.id}/copy`, { method: 'POST', admin: true, status: 201 })
  assert.equal(beforeRunCopy.isPublished, false)
  assert.equal(beforeRunCopy.hasRun, false)
  await app.start(copy.id)
  const duringRunCopy = await app.request(`/api/quizzes/${copy.id}/copy`, { method: 'POST', admin: true, status: 201 })
  assert.equal(duringRunCopy.hasRun, false)
  assert.equal(duringRunCopy.isPublished, false)
  assert.equal((await app.live(copy.id)).status, 'running')
  const unusedCopy = await app.request(`/api/quizzes/${duringRunCopy.id}/copy`, { method: 'POST', admin: true, status: 201 })
  await app.request(`/api/quizzes/${copy.id}`, { method: 'DELETE', admin: true, status: 204 })
  const copyImage = await app.raw(unusedCopy.questions[0].imageUrl, { headers: { 'x-admin-password': password } })
  assert.equal(copyImage.status, 200)
  assert.deepEqual(Buffer.from(await copyImage.arrayBuffer()), Buffer.from(pixel.split(',')[1], 'base64'))
})

test('run locking survives an empty run and concurrent start/edit requests', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const [, editResponse] = await Promise.all([
    app.start(quiz.id),
    app.raw(`/api/quizzes/${quiz.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify(quizInput({ title: 'Concurrent edit' })),
    }),
  ])
  assert.ok([200, 400].includes(editResponse.status))
  const stored = await app.request(`/api/quizzes/${quiz.id}`, { admin: true })
  assert.equal(stored.hasRun, true)
  assert.equal((await app.live(quiz.id)).currentQuestion.id, stored.questions[0].id)
  await app.next(quiz.id)
  assert.deepEqual(await app.request('/api/attempts'), [])
  await app.restart()
  await app.request(`/api/quizzes/${quiz.id}`, { method: 'PUT', admin: true, body: quizInput(), status: 400 })
  const copy = await app.request(`/api/quizzes/${quiz.id}/copy`, { method: 'POST', admin: true, status: 201 })
  assert.equal(copy.hasRun, false)
  const standalone = await app.create()
  await app.request(`/api/quizzes/${standalone.id}/attempts`, {
    method: 'POST', status: 201,
    body: { playerName: 'Standalone player', answers: { [standalone.questions[0].id]: 1 } },
  })
  assert.equal((await app.request(`/api/quizzes/${standalone.id}`, { admin: true })).hasRun, true)
  await app.request(`/api/quizzes/${standalone.id}`, { method: 'PUT', admin: true, body: quizInput(), status: 400 })
})

test('all 100 waiting players carry into the run with accurate stats and a complete final leaderboard', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({ revealAnswers: true }))
  const holding = await app.hold(quiz.id)
  await Promise.all(Array.from({ length: 100 }, (_, index) =>
    app.request(`/api/quizzes/${quiz.id}/live/join`, {
      method: 'POST', body: { runId: holding.runId, joinCode: holding.joinCode, playerId: `Player ${index}`, playerName: `Player ${index}` },
    }),
  ))
  const waiting = await app.request(`/api/quizzes/${quiz.id}/live`, { admin: true })
  assert.equal(waiting.activePlayerCount, 100)
  assert.equal(waiting.activePlayers.length, 100)
  assert.equal(waiting.status, 'holding')
  await app.begin(quiz.id)
  await Promise.all(Array.from({ length: 100 }, (_, index) =>
    app.answer(quiz.id, quiz.questions[0].id, `Player ${index}`, index % 2),
  ))
  const revealed = await app.next(quiz.id)
  assert.equal(revealed.playerCount, 100)
  assert.equal(revealed.submittedAnswerCount, 100)
  assert.equal(revealed.reveal.correctCount, 50)
  assert.equal(revealed.reveal.incorrectCount, 50)
  assert.equal(revealed.reveal.fastestAnswers.length, 5)
  const finished = await app.next(quiz.id)
  assert.equal(finished.leaderboard.length, 100)
  assert.equal(finished.leaderboard.filter((entry) => entry.score === 1).length, 50)
  assert.equal(app.sqlite.prepare('SELECT COUNT(*) AS count FROM attempts').get().count, 100)
})

test('site settings are admin-only, validated, and persistent', async (t) => {
  const app = await startApp(t)
  const initial = await app.request('/api/settings')
  assert.match(initial.title, /Create quizzes/)
  await app.request('/api/settings', { method: 'PUT', body: initial, status: 401 })
  const settings = { title: 'Team Quiz Night', subtitle: 'Play together', playerBaseUrl: 'http://192.168.1.10:5173/' }
  const saved = await app.request('/api/settings', { method: 'PUT', admin: true, body: settings })
  assert.equal(saved.title, settings.title)
  assert.equal(saved.playerBaseUrl, 'http://192.168.1.10:5173')
  for (const body of [
    { ...settings, title: '' }, { ...settings, title: 'a'.repeat(201) },
    { ...settings, subtitle: 'a'.repeat(1001) },
    ...['javascript:alert(1)', 'https://user:password@example.com', 'http://example.com/path', 'http://example.com?x=1']
      .map((playerBaseUrl) => ({ ...settings, playerBaseUrl })),
  ]) {
    await app.request('/api/settings', { method: 'PUT', admin: true, body, status: 400 })
  }
  await app.restart()
  assert.deepEqual(await app.request('/api/settings'), saved)
  const cleared = await app.request('/api/settings', {
    method: 'PUT', admin: true, body: { ...settings, subtitle: '', playerBaseUrl: '' },
  })
  assert.equal(cleared.subtitle, '')
  assert.equal(cleared.playerBaseUrl, '')
})

test('run history preserves each leaderboard and question stats through restarts and rejects stale answers', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const first = await app.start(quiz.id)
  assert.match(first.joinCode, /^\d{6}$/)
  await app.request(`/api/quizzes/${quiz.id}/runs`, { status: 401 })
  assert.deepEqual(await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true }), [])
  const lookup = await app.request(`/api/join/${first.joinCode}`)
  assert.equal(lookup.quiz.id, quiz.id)
  assert.equal(lookup.runId, first.runId)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  await app.next(quiz.id)
  await app.request(`/api/join/${first.joinCode}`, { status: 404 })
  const historyUrl = `/api/quizzes/${quiz.id}/runs`
  const history1 = await app.request(historyUrl, { admin: true })
  assert.equal(history1.length, 1)
  assert.equal(history1[0].id, first.runId)
  assert.equal(history1[0].results.totalAnswers, 1)
  assert.equal(history1[0].results.correctCount, 1)
  assert.deepEqual(history1[0].results.questions[0].optionCounts, [0, 1, 0, 0])
  assert.equal(history1[0].results.questions[0].fastestAnswers[0].playerName, 'Alice')
  const second = await app.start(quiz.id)
  assert.notEqual(second.joinCode, first.joinCode)
  assert.notEqual(second.runId, first.runId)
  await app.request(`/api/quizzes/${quiz.id}/live/answer`, {
    method: 'POST', status: 400, body: {
      runId: first.runId, playerId: 'Alice', playerName: 'Alice',
      questionId: quiz.questions[0].id, selectedOptionIndex: 1,
    },
  })
  const pinned = await app.live(quiz.id, 'Alice', first.runId)
  assert.equal(pinned.status, 'finished')
  assert.equal(pinned.leaderboard[0].playerName, 'Alice')
  assert.equal(pinned.runId, first.runId)
  await app.answer(quiz.id, quiz.questions[0].id, 'Bob', 0)
  await app.next(quiz.id)
  const history2 = await app.request(historyUrl, { admin: true })
  assert.equal(history2.length, 2)
  assert.deepEqual(history2.find((run) => run.id === first.runId), history1[0])
  assert.equal(history2.find((run) => run.id === second.runId).results.incorrectCount, 1)
  assert.equal((await app.request('/api/attempts')).length, 2)
  await app.restart()
  assert.deepEqual(await app.request(historyUrl, { admin: true }), history2)
})

test('explicitly aborting before a new run preserves partial stats without completed attempts', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({ questions: [question(), question(), question()] }))
  const first = await app.start(quiz.id)
  await app.request(`/api/quizzes/${quiz.id}/live/abort`, { method: 'POST', status: 401 })
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  await app.request(`/api/quizzes/${quiz.id}/live/abort`, { method: 'POST', admin: true })
  const second = await app.start(quiz.id)
  assert.equal((await app.live(quiz.id, 'Alice', first.runId)).status, 'aborted')
  await app.request(`/api/join/${first.joinCode}`, { status: 404 })
  let history = await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  assert.equal(history.length, 1)
  assert.equal(history[0].status, 'aborted')
  assert.equal(history[0].results.correctCount, 1)
  assert.equal(history[0].results.questionsAsked, 1)
  assert.equal(history[0].results.questions[1].wasAsked, false)
  assert.equal((await app.request('/api/attempts')).length, 0)
  await app.answer(quiz.id, quiz.questions[0].id, 'Bob', 0)
  const aborted = await app.request(`/api/quizzes/${quiz.id}/live/abort`, { method: 'POST', admin: true })
  assert.equal(aborted.status, 'aborted')
  assert.equal(aborted.runId, second.runId)
  await app.answer(quiz.id, quiz.questions[0].id, 'Late', 1, 400)
  await app.next(quiz.id, 400)
  await app.request(`/api/quizzes/${quiz.id}/live/abort`, { method: 'POST', admin: true, status: 400 })
  await app.request(`/api/join/${second.joinCode}`, { status: 404 })
  history = await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  assert.equal(history.length, 2)
  assert.equal(history.find((run) => run.id === second.runId).results.incorrectCount, 1)
  assert.equal((await app.request('/api/attempts')).length, 0)
  await app.restart()
  assert.deepEqual(await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true }), history)
})

test('join codes register all players, count unanswered players, and expire with each run', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({ revealAnswers: true }))
  await app.request('/api/join/abc123', { status: 400 })
  await app.request('/api/join/12345', { status: 400 })
  await app.request('/api/join/000000', { status: 404 })
  const session = await app.start(quiz.id)
  const joinUrl = `/api/quizzes/${quiz.id}/live/join`
  const join = (playerId, playerName = playerId) => app.request(joinUrl, {
    method: 'POST', body: { runId: session.runId, joinCode: session.joinCode, playerId, playerName },
  })
  await join('Alice')
  await join('NoAnswer')
  assert.equal((await join('NoAnswer', 'Waiting Player')).playerCount, 2)
  await app.request(joinUrl, { method: 'POST', status: 400, body: { runId: 'wrong', joinCode: session.joinCode, playerId: 'Other', playerName: 'Other' } })
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  const revealed = await app.next(quiz.id)
  assert.equal(revealed.reveal.unansweredCount, 1)
  assert.equal(revealed.playerCount, 2)
  assert.equal((await app.request(`/api/join/${session.joinCode}`)).runId, session.runId)
  const finished = await app.next(quiz.id)
  assert.equal(finished.leaderboard.length, 2)
  assert.equal(finished.leaderboard.find((player) => player.playerId === 'NoAnswer').score, 0)
  assert.equal((await app.request('/api/attempts')).length, 2)
  await app.request(joinUrl, { method: 'POST', status: 400, body: { runId: session.runId, joinCode: session.joinCode, playerId: 'Late', playerName: 'Late' } })
  await app.request(`/api/join/${session.joinCode}`, { status: 404 })
})

test('unpublishing hides a used quiz without deleting history and requires ending the active run first', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const url = `/api/quizzes/${quiz.id}/publication`
  await app.request(url, { method: 'PUT', status: 401, body: { isPublished: false } })
  const first = await app.start(quiz.id)
  await app.request(url, { method: 'PUT', admin: true, status: 400, body: { isPublished: false } })
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  await app.next(quiz.id)
  const history = await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  const unpublished = await app.request(url, { method: 'PUT', admin: true, body: { isPublished: false } })
  assert.equal(unpublished.hasRun, true)
  assert.equal(unpublished.isPublished, false)
  assert.deepEqual(await app.request('/api/quizzes'), [])
  await app.request(`/api/quizzes/${quiz.id}/live`, { status: 404 })
  assert.equal((await app.request(`/api/quizzes/${quiz.id}/live`, { admin: true })).status, 'finished')
  assert.equal((await app.live(quiz.id, 'Alice', first.runId)).leaderboard[0].score, 1)
  await app.request(`/api/quizzes/${quiz.id}/live/start`, { method: 'POST', admin: true, status: 404 })
  assert.deepEqual(await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true }), history)
  assert.equal((await app.request('/api/attempts')).length, 1)
  await app.request(url, { method: 'PUT', admin: true, body: { isPublished: true } })
  assert.equal((await app.request('/api/quizzes')).length, 1)
  await app.request(`/api/quizzes/${quiz.id}`, { method: 'PUT', admin: true, body: quizInput(), status: 400 })
  assert.notEqual((await app.start(quiz.id)).runId, first.runId)
  const draft = await app.create(quizInput({ isPublished: false, questions: [] }))
  await app.request(`/api/quizzes/${draft.id}/publication`, { method: 'PUT', admin: true, status: 400, body: { isPublished: true } })
})

test('legacy scores and current response details are imported once without inventing missing timing data', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const session = await app.start(quiz.id)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  await app.next(quiz.id)
  app.sqlite.prepare('UPDATE attempts SET run_id = NULL WHERE quiz_id = ?').run(quiz.id)
  app.sqlite.prepare('UPDATE live_sessions SET run_id = NULL WHERE quiz_id = ?').run(quiz.id)
  app.sqlite.prepare('DELETE FROM run_players WHERE run_id = ?').run(session.runId)
  app.sqlite.prepare('DELETE FROM quiz_runs WHERE id = ?').run(session.runId)
  await app.restart()
  const history = await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  assert.equal(history.length, 1)
  assert.equal(history[0].results.detailsAvailable, true)
  assert.equal(history[0].results.correctCount, 1)
  assert.equal(history[0].results.leaderboard[0].playerName, 'Alice')
  assert.deepEqual(history[0].results.questions[0].fastestAnswers, [])
  await app.restart()
  assert.deepEqual(await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true }), history)
  const legacyApp = await startApp(t, true)
  const imported = await legacyApp.request('/api/quizzes/legacy-attempt/runs', { admin: true })
  assert.equal(imported.length, 1)
  assert.equal(imported[0].results.detailsAvailable, false)
  assert.equal(imported[0].results.totalAnswers, null)
  assert.equal(imported[0].results.leaderboard[0].score, 1)
})

test('event-code lobby players are visible only to admins and enter the first question without rejoining', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const joinUrl = `/api/quizzes/${quiz.id}/live/join`
  const holding = await app.hold(quiz.id)
  const adminLive = () => app.request(`/api/quizzes/${quiz.id}/live`, { admin: true })
  const join = (playerId, playerName = playerId) => app.request(joinUrl, {
    method: 'POST', body: { runId: holding.runId, joinCode: holding.joinCode, playerId, playerName },
  })
  const waiting = await join('Alice')
  assert.equal(waiting.status, 'holding')
  assert.equal(waiting.playerRunId, holding.runId)
  assert.equal(waiting.playerIsJoined, true)
  assert.equal(waiting.activePlayerCount, 1)
  await join('Bob')
  await join('Bob', 'Bobby')
  const roster = await adminLive()
  assert.equal(roster.status, 'holding')
  assert.equal(roster.activePlayerCount, 2)
  assert.equal(roster.playerCount, 2)
  assert.deepEqual(roster.activePlayers, [
    { playerId: 'Alice', playerName: 'Alice', waiting: true },
    { playerId: 'Bob', playerName: 'Bobby', waiting: true },
  ])
  const publicLive = await app.live(quiz.id)
  assert.equal('activePlayers' in publicLive, false)
  assert.equal('activePlayers' in await app.live(quiz.id, 'Alice'), false)
  assert.equal((await app.request(`/api/quizzes/${quiz.id}`, { admin: true })).hasRun, true)
  assert.equal(app.sqlite.prepare('SELECT COUNT(*) AS count FROM quiz_runs').get().count, 1)
  const started = await app.begin(quiz.id)
  assert.equal(started.playerCount, 2)
  assert.equal(started.activePlayerCount, 2)
  assert.equal(started.activePlayers.every((player) => !player.waiting), true)
  assert.equal((await app.live(quiz.id, 'Alice')).playerRunId, started.runId)
  assert.equal((await app.live(quiz.id, 'Bob')).playerRunId, started.runId)
  const finished = await app.next(quiz.id)
  assert.equal(finished.leaderboard.length, 2)
  assert.equal(finished.leaderboard.every((player) => player.score === 0), true)
})

test('leaving and stale presence remove players from the waiting roster and do not enter them into a run', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const base = `/api/quizzes/${quiz.id}/live`
  const holding = await app.hold(quiz.id)
  const join = (playerId) => app.request(`${base}/join`, {
    method: 'POST', body: { runId: holding.runId, joinCode: holding.joinCode, playerId, playerName: playerId },
  })
  await join('Leaves')
  await join('Expired')
  await join('AtBoundary')
  await join('Active')
  await app.request(`${base}/leave`, { method: 'POST', status: 204, body: { playerId: 'Leaves', runId: null } })
  await app.live(quiz.id, 'Leaves')
  app.sqlite.prepare('UPDATE quiz_presence SET last_seen_at = ? WHERE player_id = ?')
    .run(new Date(Date.now() - 91_000).toISOString(), 'Expired')
  app.sqlite.prepare('UPDATE quiz_presence SET last_seen_at = ? WHERE player_id = ?')
    .run(new Date(Date.now() - 90_000).toISOString(), 'AtBoundary')
  app.sqlite.prepare('UPDATE quiz_presence SET last_seen_at = ? WHERE player_id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), 'Active')
  const roster = await app.request(base, { admin: true })
  assert.deepEqual(roster.activePlayers.map((player) => player.playerId), ['Active'])
  assert.equal(roster.activePlayerCount, 1)
  assert.equal((await app.live(quiz.id, 'Active')).playerIsJoined, true)
  const started = await app.begin(quiz.id)
  assert.equal(started.playerCount, 1)
  assert.equal(started.activePlayerCount, 1)
  const finished = await app.next(quiz.id)
  assert.deepEqual(finished.leaderboard.map((player) => player.playerId), ['Active'])
})

test('polling refreshes presence and leaving a run preserves its historical results', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const base = `/api/quizzes/${quiz.id}/live`
  const started = await app.start(quiz.id)
  await app.request(`${base}/join`, {
    method: 'POST', body: { runId: started.runId, joinCode: started.joinCode, playerId: 'Alice', playerName: 'Alice' },
  })
  app.sqlite.prepare('UPDATE quiz_presence SET last_seen_at = ? WHERE player_id = ?')
    .run(new Date(Date.now() - 120_000).toISOString(), 'Alice')
  assert.equal((await app.request(base, { admin: true })).activePlayerCount, 0)
  assert.equal((await app.live(quiz.id, 'Alice', started.runId)).activePlayerCount, 1)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  await app.request(`${base}/leave`, {
    method: 'POST', status: 204, body: { playerId: 'Alice', runId: started.runId },
  })
  const roster = await app.request(base, { admin: true })
  assert.equal(roster.activePlayerCount, 0)
  assert.equal(roster.playerCount, 1)
  const finished = await app.next(quiz.id)
  assert.equal(finished.leaderboard[0].score, 1)
  assert.equal((await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true }))[0].results.playerCount, 1)
})

test('new waiting players join the next run without moving players from the finished run', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const base = `/api/quizzes/${quiz.id}/live`
  const first = await app.start(quiz.id)
  await app.request(`${base}/join`, {
    method: 'POST', body: { runId: first.runId, joinCode: first.joinCode, playerId: 'First', playerName: 'First' },
  })
  await app.next(quiz.id)
  const secondHold = await app.hold(quiz.id)
  const waiting = await app.request(`${base}/join`, {
    method: 'POST', body: { runId: secondHold.runId, joinCode: secondHold.joinCode, playerId: 'Next', playerName: 'Next' },
  })
  assert.equal(waiting.status, 'holding')
  assert.equal(waiting.playerRunId, secondHold.runId)
  assert.deepEqual((await app.request(base, { admin: true })).activePlayers.map((player) => player.playerId), ['Next'])
  const second = await app.begin(quiz.id)
  assert.equal(second.playerCount, 1)
  assert.deepEqual(second.activePlayers.map((player) => player.playerId), ['Next'])
  assert.equal((await app.live(quiz.id, 'First')).runId, first.runId)
  assert.equal((await app.live(quiz.id, 'Next')).playerRunId, second.runId)
})

test('lobby joins are validated, race safely with start/leave, and are cleared when unpublished', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const base = `/api/quizzes/${quiz.id}/live`
  for (const body of [
    {}, { runId: null, playerId: '', playerName: 'Alice' },
    { runId: null, playerId: 'Alice', playerName: '' },
  ]) {
    await app.request(`${base}/join`, { method: 'POST', body, status: 400 })
  }
  await app.request(`${base}/leave`, { method: 'POST', body: {}, status: 400 })
  const holding = await app.hold(quiz.id)
  const player = { runId: holding.runId, joinCode: holding.joinCode, playerId: 'Alice', playerName: 'Alice' }
  await Promise.all([
    app.request(`${base}/join`, { method: 'POST', body: player }),
    app.begin(quiz.id),
  ])
  const session = await app.request(base, { admin: true })
  assert.equal(session.playerCount, 1)
  assert.equal(session.activePlayerCount, 1)
  assert.equal((await app.live(quiz.id, 'Alice')).playerRunId, session.runId)
  await app.request(`${base}/abort`, { method: 'POST', admin: true })
  await Promise.all([
    app.request(`${base}/leave`, { method: 'POST', status: 204, body: { playerId: 'Alice', runId: null } }),
    app.start(quiz.id),
  ])
  assert.equal((await app.request(base, { admin: true })).activePlayerCount, 0)
  await app.request(`${base}/abort`, { method: 'POST', admin: true })
  const thirdHold = await app.hold(quiz.id)
  await app.request(`${base}/join`, { method: 'POST', body: { ...player, runId: thirdHold.runId, joinCode: thirdHold.joinCode, playerId: 'Waiting' } })
  await app.request(`${base}/abort`, { method: 'POST', admin: true })
  await app.request(`/api/quizzes/${quiz.id}/publication`, { method: 'PUT', admin: true, body: { isPublished: false } })
  assert.equal((await app.request(base, { admin: true })).activePlayerCount, 0)
  await app.request(`${base}/join`, { method: 'POST', body: player, status: 400 })
})

test('starting holds indefinitely with a working join code and no question clock or answers until explicit begin', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({
    revealAnswers: true,
    questions: [question({ answerSeconds: 20 }), question({ answerSeconds: 35 })],
  }))
  const base = `/api/quizzes/${quiz.id}/live`
  await app.hold(quiz.id)
  const held = await app.live(quiz.id)
  await app.request(`${base}/join`, {
    method: 'POST', body: { runId: held.runId, joinCode: held.joinCode, playerId: 'Waiting', playerName: 'Waiting' },
  })
  const holding = await app.request(base, { admin: true })
  assert.equal(holding.status, 'holding')
  assert.equal(holding.currentQuestionIndex, -1)
  assert.equal(holding.currentQuestion, null)
  assert.equal(holding.questionStartedAt, null)
  assert.equal(holding.answerSeconds, 20)
  assert.equal(holding.playerCount, 1)
  assert.equal(holding.activePlayerCount, 1)
  assert.equal(holding.activePlayers[0].waiting, true)
  assert.match(holding.joinCode, /^\d{6}$/)
  const code = await app.request(`/api/join/${holding.joinCode}`)
  assert.equal(code.runId, holding.runId)
  assert.equal((await app.live(quiz.id, 'Waiting')).playerRunId, holding.runId)
  const joinedDuringHold = await app.request(`${base}/join`, {
    method: 'POST', body: { runId: holding.runId, joinCode: holding.joinCode, playerId: 'New', playerName: 'New' },
  })
  assert.equal(joinedDuringHold.status, 'holding')
  assert.equal(joinedDuringHold.playerRunId, holding.runId)
  app.sqlite.prepare('UPDATE quiz_runs SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 600_000).toISOString(), holding.runId)
  const stillHolding = await app.live(quiz.id, 'Waiting')
  assert.equal(stillHolding.status, 'holding')
  assert.equal(stillHolding.currentQuestion, null)
  assert.equal(stillHolding.questionStartedAt, null)
  assert.equal(stillHolding.reveal, null)
  assert.equal(app.sqlite.prepare('SELECT question_times_json FROM quiz_runs WHERE id = ?').get(holding.runId).question_times_json, '{}')
  await app.answer(quiz.id, quiz.questions[0].id, 'Waiting', 1, 400)
  await app.next(quiz.id, 400)
  await app.request(`/api/quizzes/${quiz.id}/publication`, { method: 'PUT', admin: true, body: { isPublished: false }, status: 400 })
  await app.request(`${base}/begin`, { method: 'POST', body: { runId: holding.runId }, status: 401 })
  await app.request(`${base}/begin`, { method: 'POST', admin: true, body: {}, status: 400 })
  const beforeBegin = Date.now()
  const firstQuestion = await app.begin(quiz.id)
  assert.equal(firstQuestion.status, 'running')
  assert.equal(firstQuestion.runId, holding.runId)
  assert.equal(firstQuestion.joinCode, holding.joinCode)
  assert.equal(firstQuestion.currentQuestionIndex, 0)
  assert.equal(firstQuestion.currentQuestion.id, quiz.questions[0].id)
  assert.ok(Date.parse(firstQuestion.questionStartedAt) >= beforeBegin)
  assert.equal(firstQuestion.answerSeconds, 20)
  assert.equal(firstQuestion.activePlayers.every((player) => !player.waiting), true)
  await app.begin(quiz.id, 400)
  const afterDuplicate = await app.live(quiz.id)
  assert.equal(afterDuplicate.currentQuestionIndex, 0)
  assert.equal(afterDuplicate.questionStartedAt, firstQuestion.questionStartedAt)
  await app.answer(quiz.id, quiz.questions[0].id, 'Waiting', 1)
  app.sqlite.prepare('UPDATE live_answers SET answered_at = ? WHERE quiz_id = ? AND player_id = ?')
    .run(new Date(Date.parse(firstQuestion.questionStartedAt) + 2000).toISOString(), quiz.id, 'Waiting')
  const reveal = await app.next(quiz.id)
  assert.equal(reveal.reveal.fastestAnswers[0].responseSeconds, 2)
  const secondQuestion = await app.next(quiz.id)
  assert.equal(secondQuestion.currentQuestionIndex, 1)
  assert.equal(secondQuestion.answerSeconds, 35)
  await app.next(quiz.id)
  await app.next(quiz.id)
  const history = await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  assert.equal(history[0].results.questionsAsked, 2)
  assert.equal(history[0].results.questions[0].fastestAnswers[0].responseSeconds, 2)
})

test('held runs persist across server restarts and explicit aborts before new runs without counting questions', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const first = await app.hold(quiz.id)
  await app.request(`/api/quizzes/${quiz.id}/live/join`, {
    method: 'POST', body: { runId: first.runId, joinCode: first.joinCode, playerId: 'Alice', playerName: 'Alice' },
  })
  await app.restart()
  const restored = await app.live(quiz.id, 'Alice')
  assert.equal(restored.status, 'holding')
  assert.equal(restored.joinCode, first.joinCode)
  assert.equal(restored.questionStartedAt, null)
  await app.request(`/api/quizzes/${quiz.id}/live/abort`, { method: 'POST', admin: true })
  const second = await app.hold(quiz.id)
  assert.equal(second.status, 'holding')
  assert.notEqual(second.runId, first.runId)
  await app.request(`/api/join/${first.joinCode}`, { status: 404 })
  assert.equal((await app.live(quiz.id, 'Alice', first.runId)).status, 'aborted')
  await app.request(`/api/quizzes/${quiz.id}/live/begin`, {
    method: 'POST', admin: true, body: { runId: first.runId }, status: 400,
  })
  assert.equal((await app.live(quiz.id)).status, 'holding')
  await app.request(`/api/quizzes/${quiz.id}/live/abort`, { method: 'POST', admin: true })
  await app.begin(quiz.id, 400)
  const history = await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  assert.equal(history.length, 2)
  for (const run of history) {
    assert.equal(run.status, 'aborted')
    assert.equal(run.results.questionsAsked, 0)
    assert.equal(run.results.totalAnswers, 0)
    assert.equal(run.results.questions.every((question) => !question.wasAsked), true)
  }
  assert.deepEqual(await app.request('/api/attempts'), [])
})

test('admin quiz files round-trip all content and uploaded images into an independent draft on another app', async (t) => {
  const source = await startApp(t)
  const destination = await startApp(t)
  const quiz = await source.create(quizInput({
    title: 'Quiz: café / "round trip"',
    description: 'Portable quiz with images and answer details.',
    revealAnswers: true,
    questions: [
      question({ prompt: 'Choose café', imageUrl: pixel, explanation: 'More detail\non another line.', answerSeconds: 20 }),
      question({ imageUrl: 'https://example.com/picture.png?size=large', correctOptionIndex: 3, answerSeconds: 35 }),
    ],
  }))
  await source.start(quiz.id)
  await source.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  await source.next(quiz.id)
  await source.next(quiz.id)
  await source.answer(quiz.id, quiz.questions[1].id, 'Alice', 3)
  await source.next(quiz.id)
  await source.next(quiz.id)
  const history = await source.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  await source.request(`/api/quizzes/${quiz.id}/export`, { status: 401 })
  await destination.request('/api/quizzes/import', { method: 'POST', body: {}, status: 401 })
  await source.request('/api/quizzes/missing/export', { admin: true, status: 404 })
  const response = await source.raw(`/api/quizzes/${quiz.id}/export`, {
    headers: { 'x-admin-password': password },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="[a-zA-Z0-9-]+\.quizarena\.json"$/)
  const fileText = await response.text()
  const file = JSON.parse(fileText)
  assert.equal(file.format, 'quizarena.quiz')
  assert.equal(file.version, 1)
  assert.ok(Number.isFinite(Date.parse(file.exportedAt)))
  assert.deepEqual(Object.keys(file.quiz).sort(), ['description', 'displayStats', 'questions', 'revealAnswers', 'title'])
  assert.equal(file.quiz.questions[0].imageUrl, pixel)
  assert.equal(file.quiz.questions[1].imageUrl, 'https://example.com/picture.png?size=large')
  assert.equal(file.quiz.questions[0].explanation, 'More detail\non another line.')
  assert.equal(file.quiz.questions[0].correctOptionIndex, 1)
  assert.equal(file.quiz.questions[1].correctOptionIndex, 3)
  assert.equal(fileText.includes(quiz.id), false)
  assert.equal(fileText.includes(quiz.questions[0].id), false)
  assert.equal(fileText.includes('Alice'), false)
  assert.deepEqual(await source.request(`/api/quizzes/${quiz.id}/runs`, { admin: true }), history)
  assert.equal((await source.request('/api/attempts')).length, 1)
  assert.equal((await source.live(quiz.id)).status, 'finished')
  const imported = await destination.request('/api/quizzes/import', {
    method: 'POST', admin: true, status: 201, body: file,
  })
  assert.notEqual(imported.id, quiz.id)
  assert.notEqual(imported.questions[0].id, quiz.questions[0].id)
  assert.equal(imported.title, quiz.title)
  assert.equal(imported.isPublished, false)
  assert.equal(imported.hasRun, false)
  assert.equal(imported.questions[0].imageUrl, pixel)
  assert.deepEqual(await destination.request('/api/quizzes'), [])
  assert.deepEqual(await destination.request('/api/attempts'), [])
  assert.deepEqual(await destination.request(`/api/quizzes/${imported.id}/runs`, { admin: true }), [])
  const roundTrip = await destination.request(`/api/quizzes/${imported.id}/export`, { admin: true })
  assert.deepEqual(roundTrip.quiz, file.quiz)
  const duplicate = await destination.request('/api/quizzes/import', {
    method: 'POST', admin: true, status: 201, body: file,
  })
  assert.notEqual(duplicate.id, imported.id)
  assert.notEqual(duplicate.questions[0].id, imported.questions[0].id)
  assert.equal((await destination.request('/api/admin/quizzes', { admin: true })).length, 2)
  await source.request(`/api/quizzes/${quiz.id}`, { method: 'DELETE', admin: true, status: 204 })
  assert.equal(history.length, 1)
  await destination.restart()
  const stored = await destination.request(`/api/quizzes/${imported.id}`, { admin: true })
  assert.equal(stored.questions[0].imageUrl, pixel)
  const published = await destination.request(`/api/quizzes/${imported.id}/publication`, {
    method: 'PUT', admin: true, body: { isPublished: true },
  })
  const imageResponse = await destination.raw(published.questions[0].imageUrl)
  assert.equal(imageResponse.status, 200)
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), Buffer.from(pixel.split(',')[1], 'base64'))
  await destination.start(imported.id)
  await destination.answer(imported.id, stored.questions[0].id, 'Player', 1)
  await destination.next(imported.id)
  await destination.next(imported.id)
  await destination.answer(imported.id, stored.questions[1].id, 'Player', 3)
  await destination.next(imported.id)
  const finished = await destination.next(imported.id)
  assert.equal(finished.leaderboard[0].score, 2)
})

test('draft exports preserve incomplete content and imports ignore IDs, publication, and run history', async (t) => {
  const app = await startApp(t)
  const draft = await app.create(quizInput({
    isPublished: false,
    questions: [question({ prompt: '', options: ['', '', '', ''], imageUrl: pixel, explanation: 'Draft note' })],
  }))
  const file = await app.request(`/api/quizzes/${draft.id}/export`, { admin: true })
  file.quiz.id = draft.id
  file.quiz.hasRun = true
  file.quiz.isPublished = true
  file.quiz.questions[0].id = draft.questions[0].id
  file.quiz.attempts = [{ playerName: 'Must not import', score: 100 }]
  const imported = await app.request('/api/quizzes/import', {
    method: 'POST', admin: true, status: 201, body: file,
  })
  assert.notEqual(imported.id, draft.id)
  assert.equal(imported.hasRun, false)
  assert.equal(imported.isPublished, false)
  assert.equal(imported.questions[0].prompt, '')
  assert.deepEqual(imported.questions[0].options, ['', '', '', ''])
  assert.equal(imported.questions[0].explanation, 'Draft note')
  assert.deepEqual(await app.request('/api/attempts'), [])
  const original = await app.request(`/api/quizzes/${draft.id}`, { admin: true })
  assert.equal(original.questions[0].id, draft.questions[0].id)
  const emptyDraft = await app.create(quizInput({ isPublished: false, questions: [] }))
  const emptyFile = await app.request(`/api/quizzes/${emptyDraft.id}/export`, { admin: true })
  const emptyImported = await app.request('/api/quizzes/import', {
    method: 'POST', admin: true, status: 201, body: emptyFile,
  })
  assert.deepEqual(emptyImported.questions, [])
  await app.request(`/api/quizzes/${emptyImported.id}/publication`, {
    method: 'PUT', admin: true, body: { isPublished: true }, status: 400,
  })
  const bomResponse = await app.raw('/api/quizzes/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: `\uFEFF${JSON.stringify(emptyFile)}`,
  })
  assert.equal(bomResponse.status, 201)
  await bomResponse.json()
})

test('malformed quiz files, invalid images and unsupported versions do not create partial quizzes', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const file = await app.request(`/api/quizzes/${quiz.id}/export`, { admin: true })
  const changeQuestion = (changes) => ({
    ...file, quiz: { ...file.quiz, questions: [{ ...file.quiz.questions[0], ...changes }] },
  })
  const invalidFiles = [
    null, [], {}, { ...file, format: 'other.app' }, { ...file, version: 2 }, { ...file, version: '1' },
    { ...file, quiz: null }, { ...file, quiz: { ...file.quiz, title: '' } },
    { ...file, quiz: { ...file.quiz, description: null } },
    { ...file, quiz: { ...file.quiz, revealAnswers: 'true' } },
    { ...file, quiz: { ...file.quiz, questions: null } },
    { ...file, quiz: { ...file.quiz, questions: [null] } },
    changeQuestion({ prompt: null }),
    changeQuestion({ correctOptionIndex: '1' }), changeQuestion({ correctOptionIndex: 4 }),
    changeQuestion({ correctOptionIndex: -1 }), changeQuestion({ correctOptionIndex: 0.5 }),
    changeQuestion({ answerSeconds: 19 }), changeQuestion({ answerSeconds: '20' }),
    changeQuestion({ options: ['A', 'B', 'C'] }), changeQuestion({ options: ['A', 'B', 'C', {}] }),
    changeQuestion({ imageUrl: 'javascript:alert(1)' }),
    changeQuestion({ imageUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }),
    changeQuestion({ imageUrl: 'data:image/png;base64,A' }),
    changeQuestion({ imageUrl: 'data:image/png;base64,a===' }),
    changeQuestion({ imageUrl: `data:image/png;base64,${Buffer.alloc(2_000_001).toString('base64')}` }),
    changeQuestion({ explanation: null }),
  ]
  for (const invalid of invalidFiles) {
    const result = await app.request('/api/quizzes/import', {
      method: 'POST', admin: true, body: invalid, status: 400,
    })
    assert.equal(typeof result.error, 'string')
  }
  const malformed = await app.raw('/api/quizzes/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: '{"format":',
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).error, 'The selected file is not valid JSON.')
  assert.equal((await app.request('/api/admin/quizzes', { admin: true })).length, 1)
  assert.equal(app.sqlite.prepare('SELECT COUNT(*) AS count FROM questions').get().count, 1)
  const validFile = changeQuestion({ imageUrl: `data:image/png;base64,${Buffer.alloc(2_000_000).toString('base64')}` })
  const boundaryImport = await app.request('/api/quizzes/import', {
    method: 'POST', admin: true, body: validFile, status: 201,
  })
  assert.equal(Buffer.from(boundaryImport.questions[0].imageUrl.split(',')[1], 'base64').length, 2_000_000)
})

test('quiz file import enforces the exact request-size limit and rolls back database failures', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({ questions: [question(), question()] }))
  const file = await app.request(`/api/quizzes/${quiz.id}/export`, { admin: true })
  const json = JSON.stringify(file)
  const atLimit = await app.raw('/api/quizzes/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: `${' '.repeat(32_000_000 - Buffer.byteLength(json))}${json}`,
  })
  assert.equal(atLimit.status, 201)
  await atLimit.json()
  const overLimit = await app.raw('/api/quizzes/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: `${' '.repeat(32_000_001 - Buffer.byteLength(json))}${json}`,
  })
  assert.equal(overLimit.status, 400)
  assert.match((await overLimit.json()).error, /32 MB/)
  const counts = {
    quizzes: app.sqlite.prepare('SELECT COUNT(*) AS count FROM quizzes').get().count,
    questions: app.sqlite.prepare('SELECT COUNT(*) AS count FROM questions').get().count,
  }
  app.sqlite.exec(`
    CREATE TRIGGER fail_second_import_question BEFORE INSERT ON questions
    WHEN NEW.sort_order = 1 BEGIN SELECT RAISE(ABORT, 'Simulated import storage failure'); END;
  `)
  const failed = await app.request('/api/quizzes/import', {
    method: 'POST', admin: true, body: file, status: 400,
  })
  assert.match(failed.error, /Simulated import storage failure/)
  assert.equal(app.sqlite.prepare('SELECT COUNT(*) AS count FROM quizzes').get().count, counts.quizzes)
  assert.equal(app.sqlite.prepare('SELECT COUNT(*) AS count FROM questions').get().count, counts.questions)
})

test('SQLite backup utility converts legacy quizzes without modifying the source or overwriting exports', async (t) => {
  const app = await startApp(t)
  const directory = path.dirname(app.databasePath)
  const source = path.join(directory, 'legacy-backup.sqlite')
  const output = path.join(directory, 'legacy-exports')
  const db = new DatabaseSync(source)
  try {
    db.exec(`
      CREATE TABLE quizzes (id TEXT PRIMARY KEY, title TEXT, description TEXT, created_at TEXT);
      CREATE TABLE questions (id TEXT PRIMARY KEY, quiz_id TEXT, prompt TEXT, options_json TEXT, correct_option_index INTEGER, sort_order INTEGER);
      INSERT INTO quizzes VALUES ('one', 'Same title', 'Older schema', '2026-01-01');
      INSERT INTO quizzes VALUES ('two', 'Same title', '', '2026-01-02');
      INSERT INTO questions VALUES ('later', 'one', 'Second question', '["A","B","C","D"]', 2, 1);
      INSERT INTO questions VALUES ('earlier', 'one', 'First question', '["A","B","C","D"]', 1, 0);
    `)
  } finally {
    db.close()
  }
  const before = await readFile(source)
  const command = path.join(root, 'scripts', 'export-sqlite-quizzes.mjs')
  const args = [command, source, output]
  const { stdout } = await execFileAsync(process.execPath, args)
  assert.match(stdout, /Exported 2 quizzes/)
  const filenames = (await readdir(output)).sort()
  assert.deepEqual(filenames, ['001-Same-title.quizarena.json', '002-Same-title.quizarena.json'])
  const file = JSON.parse(await readFile(path.join(output, filenames[0]), 'utf8'))
  assert.equal(file.format, 'quizarena.quiz')
  assert.equal(file.version, 1)
  assert.deepEqual(file.quiz.questions.map((question) => question.prompt), ['First question', 'Second question'])
  assert.equal(file.quiz.questions[0].correctOptionIndex, 1)
  assert.equal(file.quiz.questions[0].answerSeconds, 60)
  assert.equal(file.quiz.questions[0].imageUrl, '')
  assert.equal(file.quiz.questions[0].afterImageUrl, '')
  assert.equal(file.quiz.questions[0].reuseBeforeImage, false)
  assert.equal(file.quiz.questions[0].explanation, '')
  assert.equal(file.quiz.revealAnswers, false)
  assert.equal(file.quiz.displayStats, false)
  for (const filename of filenames) {
    const body = JSON.parse(await readFile(path.join(output, filename), 'utf8'))
    const imported = await app.request('/api/quizzes/import', { method: 'POST', admin: true, status: 201, body })
    assert.equal(imported.isPublished, false)
  }
  await assert.rejects(execFileAsync(process.execPath, args), /Export already exists/)
  assert.deepEqual(await readFile(source), before)
  assert.deepEqual(JSON.parse(await readFile(path.join(output, filenames[0]), 'utf8')), file)
  const missing = path.join(directory, 'does-not-exist.sqlite')
  await assert.rejects(execFileAsync(process.execPath, [command, missing, output]), /unable to open database/)
  assert.equal((await readdir(directory)).includes('does-not-exist.sqlite'), false)
})

test('SQLite backup utility preserves image data and exports importable current quizzes', async (t) => {
  const source = await startApp(t)
  const destination = await startApp(t)
  const quiz = await source.create(quizInput({
    revealAnswers: true,
    displayStats: true,
    questions: [
      question({ imageUrl: pixel, afterImageUrl: pixel, reuseBeforeImage: true, explanation: 'Exported context', answerSeconds: 20 }),
      question({ imageUrl: 'https://example.com/picture.png', answerSeconds: 35 }),
    ],
  }))
  const output = path.join(path.dirname(source.databasePath), 'current-exports')
  const before = createHash('sha256').update(await readFile(source.databasePath)).digest('hex')
  await execFileAsync(process.execPath, [path.join(root, 'scripts', 'export-sqlite-quizzes.mjs'), source.databasePath, output])
  const filenames = await readdir(output)
  assert.equal(filenames.length, 1)
  const file = JSON.parse(await readFile(path.join(output, filenames[0]), 'utf8'))
  const appExport = await source.request(`/api/quizzes/${quiz.id}/export`, { admin: true })
  assert.deepEqual(file.quiz, appExport.quiz)
  assert.equal(file.quiz.questions[0].imageUrl, pixel)
  assert.equal(file.quiz.questions[0].afterImageUrl, pixel)
  assert.equal(file.quiz.questions[0].reuseBeforeImage, true)
  assert.equal(file.quiz.questions[0].explanation, 'Exported context')
  assert.equal(file.quiz.questions[0].answerSeconds, 20)
  assert.equal(file.quiz.questions[1].imageUrl, 'https://example.com/picture.png')
  const imported = await destination.request('/api/quizzes/import', { method: 'POST', admin: true, status: 201, body: file })
  assert.notEqual(imported.id, quiz.id)
  assert.equal(imported.questions[0].imageUrl, pixel)
  assert.equal(imported.questions[0].afterImageUrl, pixel)
  assert.equal(imported.questions[0].reuseBeforeImage, true)
  assert.equal(imported.revealAnswers, true)
  assert.equal(imported.displayStats, true)
  assert.equal(createHash('sha256').update(await readFile(source.databasePath)).digest('hex'), before)
})

test('before and after images are phase-specific, persist, copy and export without exposing after images before reveal', async (t) => {
  const app = await startApp(t)
  const after = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
  const quiz = await app.create(quizInput({
    revealAnswers: true,
    questions: [
      question({ imageUrl: pixel, afterImageUrl: after }),
      question({ imageUrl: 'https://example.com/before.png', afterImageUrl: 'https://example.com/after.png' }),
      question({ imageUrl: '', afterImageUrl: after }),
    ],
  }))
  assert.equal(quiz.questions[0].imageUrl, `/api/questions/${quiz.questions[0].id}/image`)
  assert.equal(quiz.questions[1].imageUrl, 'https://example.com/before.png')
  assert.equal(quiz.questions[2].imageUrl, '')
  assert.equal(quiz.questions.some((entry) => 'afterImageUrl' in entry), false)
  const afterPath = `/api/questions/${quiz.questions[0].id}/image/after`
  assert.equal((await app.raw(afterPath)).status, 403)
  const editable = await app.request(`/api/quizzes/${quiz.id}`, { admin: true })
  assert.equal(editable.questions[0].afterImageUrl, after)
  const copied = await app.request(`/api/quizzes/${quiz.id}/copy`, { method: 'POST', admin: true, status: 201 })
  assert.equal((await app.request(`/api/quizzes/${copied.id}`, { admin: true })).questions[0].afterImageUrl, after)
  const exported = await app.request(`/api/quizzes/${quiz.id}/export`, { admin: true })
  assert.equal(exported.quiz.questions[0].afterImageUrl, after)
  const imported = await app.request('/api/quizzes/import', { method: 'POST', admin: true, status: 201, body: exported })
  assert.equal(imported.questions[0].afterImageUrl, after)
  await app.restart()
  assert.equal((await app.request(`/api/quizzes/${quiz.id}`, { admin: true })).questions[0].afterImageUrl, after)
  let session = await app.start(quiz.id)
  assert.equal(session.currentQuestion.imageUrl, quiz.questions[0].imageUrl)
  assert.equal((await app.raw(afterPath)).status, 403)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  session = await app.next(quiz.id)
  assert.equal(session.currentQuestion.imageUrl, afterPath)
  const image = await app.raw(afterPath)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/gif')
  assert.equal(image.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(after.split(',')[1], 'base64'))
  session = await app.next(quiz.id)
  assert.equal(session.currentQuestion.imageUrl, 'https://example.com/before.png')
  session = await app.next(quiz.id)
  assert.equal(session.currentQuestion.imageUrl, 'https://example.com/after.png')
  session = await app.next(quiz.id)
  assert.equal(session.currentQuestion.imageUrl, '')
  const thirdAfterPath = `/api/questions/${quiz.questions[2].id}/image/after`
  assert.equal((await app.raw(thirdAfterPath)).status, 403)
  session = await app.next(quiz.id)
  assert.equal(session.currentQuestion.imageUrl, thirdAfterPath)
  assert.equal((await app.raw(thirdAfterPath)).status, 200)
  await app.next(quiz.id)
  await app.hold(quiz.id)
  assert.equal((await app.raw(afterPath)).status, 403)
  assert.equal((await app.live(quiz.id)).currentQuestion, null)
})

test('old quiz exports and legacy images remain before-only, after images share validation and can be swapped', async (t) => {
  const app = await startApp(t, true)
  const legacy = await app.request('/api/quizzes/legacy', { admin: true })
  assert.equal(legacy.questions[0].afterImageUrl, '')
  const source = await app.create(quizInput({ revealAnswers: true, questions: [question({ imageUrl: pixel })] }))
  const file = await app.request(`/api/quizzes/${source.id}/export`, { admin: true })
  delete file.quiz.questions[0].afterImageUrl
  const imported = await app.request('/api/quizzes/import', { method: 'POST', admin: true, status: 201, body: file })
  assert.equal(imported.questions[0].imageUrl, pixel)
  assert.equal(imported.questions[0].afterImageUrl, '')
  await app.request(`/api/quizzes/${imported.id}/publication`, { method: 'PUT', admin: true, body: { isPublished: true } })
  let session = await app.start(imported.id)
  assert.match(session.currentQuestion.imageUrl, /\/image$/)
  session = await app.next(imported.id)
  assert.equal(session.currentQuestion.imageUrl, '')
  const swapped = await app.request(`/api/quizzes/${source.id}`, {
    method: 'PUT', admin: true,
    body: quizInput({ revealAnswers: true, questions: [question({ imageUrl: '', afterImageUrl: pixel })] }),
  })
  const edited = await app.request(`/api/quizzes/${swapped.id}`, { admin: true })
  assert.equal(edited.questions[0].imageUrl, '')
  assert.equal(edited.questions[0].afterImageUrl, pixel)
  for (const afterImageUrl of [null, 1, 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,A']) {
    await app.request('/api/quizzes', {
      method: 'POST', admin: true, status: 400,
      body: quizInput({ questions: [question({ afterImageUrl })] }),
    })
    await app.request('/api/quizzes/import', {
      method: 'POST', admin: true, status: 400,
      body: { ...file, quiz: { ...file.quiz, questions: [{ ...file.quiz.questions[0], afterImageUrl }] } },
    })
  }
  const maximumAfterImage = `data:image/png;base64,${Buffer.alloc(2_000_000).toString('base64')}`
  const boundaryQuiz = await app.create(quizInput({ questions: [question({ afterImageUrl: maximumAfterImage })] }))
  assert.equal((await app.request(`/api/quizzes/${boundaryQuiz.id}`, { admin: true })).questions[0].afterImageUrl, maximumAfterImage)
  await app.request('/api/quizzes', {
    method: 'POST', admin: true, status: 400,
    body: quizInput({ questions: [question({ afterImageUrl: `data:image/png;base64,${Buffer.alloc(2_000_001).toString('base64')}` })] }),
  })
})

test('question summary counts include all joined players and match the live reveal for three chart categories', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({ revealAnswers: true }))
  const session = await app.start(quiz.id)
  await Promise.all(['Correct Player', 'Incorrect Player', 'Unanswered Player'].map((playerId) =>
    app.request(`/api/quizzes/${quiz.id}/live/join`, {
      method: 'POST', body: { runId: session.runId, joinCode: session.joinCode, playerId, playerName: playerId },
    }),
  ))
  await app.answer(quiz.id, quiz.questions[0].id, 'Correct Player', 1)
  await app.answer(quiz.id, quiz.questions[0].id, 'Incorrect Player', 0)
  const revealed = await app.next(quiz.id)
  assert.equal(revealed.playerCount, 3)
  assert.equal(revealed.reveal.correctCount, 1)
  assert.equal(revealed.reveal.incorrectCount, 1)
  assert.equal(revealed.reveal.unansweredCount, 1)
  assert.deepEqual(revealed.reveal.optionCounts, [1, 1, 0, 0])
  assert.equal(revealed.reveal.fastestAnswers.some((answer) => answer.isCorrect), true)
  assert.equal(revealed.reveal.fastestAnswers.some((answer) => !answer.isCorrect), true)
  await app.next(quiz.id)
  const [history] = await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  assert.equal(history.results.playerCount, 3)
  assert.deepEqual(history.results.questions[0], revealed.reveal)
})

test('reusing the before image preserves the saved after image across persistence, copies, exports and toggling', async (t) => {
  const app = await startApp(t)
  const after = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
  const quiz = await app.create(quizInput({
    revealAnswers: true,
    questions: [question({ imageUrl: pixel, afterImageUrl: after, reuseBeforeImage: true })],
  }))
  const editUrl = `/api/quizzes/${quiz.id}`
  let editable = await app.request(editUrl, { admin: true })
  assert.equal(editable.questions[0].reuseBeforeImage, true)
  assert.equal(editable.questions[0].afterImageUrl, after)
  await app.restart()
  editable = await app.request(editUrl, { admin: true })
  assert.equal(editable.questions[0].reuseBeforeImage, true)
  assert.equal(editable.questions[0].afterImageUrl, after)
  const exported = await app.request(`${editUrl}/export`, { admin: true })
  assert.equal(exported.quiz.questions[0].reuseBeforeImage, true)
  assert.equal(exported.quiz.questions[0].imageUrl, pixel)
  assert.equal(exported.quiz.questions[0].afterImageUrl, after)
  const imported = await app.request('/api/quizzes/import', { method: 'POST', admin: true, status: 201, body: exported })
  assert.equal(imported.questions[0].reuseBeforeImage, true)
  assert.equal(imported.questions[0].afterImageUrl, after)
  const copied = await app.request(`${editUrl}/copy`, { method: 'POST', admin: true, status: 201 })
  const copiedEdit = await app.request(`/api/quizzes/${copied.id}`, { admin: true })
  assert.equal(copiedEdit.questions[0].reuseBeforeImage, true)
  assert.equal(copiedEdit.questions[0].afterImageUrl, after)
  await app.start(quiz.id)
  const revealed = await app.next(quiz.id)
  assert.equal(revealed.currentQuestion.imageUrl, `/api/questions/${quiz.questions[0].id}/image`)
  const image = await app.raw(revealed.currentQuestion.imageUrl)
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  const disabled = await app.request(`/api/quizzes/${imported.id}`, {
    method: 'PUT', admin: true,
    body: { ...imported, isPublished: true, questions: imported.questions.map((entry) => ({ ...entry, reuseBeforeImage: false })) },
  })
  const restored = await app.request(`/api/quizzes/${imported.id}`, { admin: true })
  assert.equal(restored.questions[0].afterImageUrl, after)
  assert.equal(restored.questions[0].reuseBeforeImage, false)
  await app.start(disabled.id)
  const afterReveal = await app.next(disabled.id)
  assert.equal(afterReveal.currentQuestion.imageUrl, `/api/questions/${disabled.questions[0].id}/image/after`)
  const afterResponse = await app.raw(afterReveal.currentQuestion.imageUrl)
  assert.equal(afterResponse.headers.get('content-type'), 'image/gif')
})

test('before-image reuse clears when the before slot is empty, remains enabled on two-image swaps, and defaults off in old files', async (t) => {
  const app = await startApp(t, true)
  assert.equal((await app.request('/api/quizzes/legacy', { admin: true })).questions[0].reuseBeforeImage, false)
  const quiz = await app.create(quizInput({
    revealAnswers: true, questions: [question({ imageUrl: pixel, reuseBeforeImage: true })],
  }))
  const single = await app.request(`/api/quizzes/${quiz.id}`, { admin: true })
  await app.request(`/api/quizzes/${quiz.id}`, {
    method: 'PUT', admin: true,
    body: { ...single, questions: [question({ imageUrl: '', afterImageUrl: pixel, reuseBeforeImage: true })] },
  })
  const moved = await app.request(`/api/quizzes/${quiz.id}`, { admin: true })
  assert.equal(moved.questions[0].imageUrl, '')
  assert.equal(moved.questions[0].afterImageUrl, pixel)
  assert.equal(moved.questions[0].reuseBeforeImage, false)
  await app.request(`/api/quizzes/${quiz.id}`, {
    method: 'PUT', admin: true,
    body: { ...single, questions: [question({
      imageUrl: 'https://example.com/original-after.png', afterImageUrl: pixel, reuseBeforeImage: true,
    })] },
  })
  const swapped = await app.request(`/api/quizzes/${quiz.id}`, { admin: true })
  assert.equal(swapped.questions[0].reuseBeforeImage, true)
  assert.equal(swapped.questions[0].afterImageUrl, pixel)
  await app.start(quiz.id)
  const reveal = await app.next(quiz.id)
  assert.equal(reveal.currentQuestion.imageUrl, 'https://example.com/original-after.png')
  const file = await app.request(`/api/quizzes/${quiz.id}/export`, { admin: true })
  delete file.quiz.questions[0].reuseBeforeImage
  const oldImport = await app.request('/api/quizzes/import', { method: 'POST', admin: true, status: 201, body: file })
  assert.equal(oldImport.questions[0].reuseBeforeImage, false)
  assert.equal(oldImport.questions[0].afterImageUrl, pixel)
  file.quiz.questions[0].reuseBeforeImage = true
  file.quiz.questions[0].imageUrl = ''
  const emptyBeforeImport = await app.request('/api/quizzes/import', { method: 'POST', admin: true, status: 201, body: file })
  assert.equal(emptyBeforeImport.questions[0].reuseBeforeImage, false)
  assert.equal(emptyBeforeImport.questions[0].afterImageUrl, pixel)
  for (const reuseBeforeImage of [null, 'true', 1, {}]) {
    await app.request('/api/quizzes', {
      method: 'POST', admin: true, status: 400,
      body: quizInput({ questions: [question({ imageUrl: pixel, reuseBeforeImage })] }),
    })
    file.quiz.questions[0].reuseBeforeImage = reuseBeforeImage
    await app.request('/api/quizzes/import', { method: 'POST', admin: true, status: 400, body: file })
  }
})

test('starting cannot replace a holding, running, or revealing quiz and leaves its timer, code, answers and history unchanged', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({ revealAnswers: true }))
  const base = `/api/quizzes/${quiz.id}/live`
  const held = await app.hold(quiz.id)
  const rejectStart = async (status) => {
    const before = await app.live(quiz.id)
    assert.equal(before.status, status)
    const rejection = await app.request(`${base}/start`, { method: 'POST', admin: true, status: 400 })
    assert.match(rejection.error, /Finish or abort/)
    const after = await app.live(quiz.id)
    assert.equal(after.status, status)
    assert.equal(after.runId, held.runId)
    assert.equal(after.joinCode, held.joinCode)
    assert.equal(after.questionStartedAt, before.questionStartedAt)
    assert.equal(after.submittedAnswerCount, before.submittedAnswerCount)
    assert.equal(app.sqlite.prepare('SELECT COUNT(*) AS count FROM quiz_runs WHERE quiz_id = ?').get(quiz.id).count, 1)
    assert.deepEqual(await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true }), [])
  }
  await rejectStart('holding')
  await app.begin(quiz.id)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  await rejectStart('running')
  await app.next(quiz.id)
  await rejectStart('revealing')
  const finished = await app.next(quiz.id)
  assert.equal(finished.leaderboard[0].score, 1)
  const afterFinished = await app.hold(quiz.id)
  assert.notEqual(afterFinished.runId, held.runId)
  await app.request(`${base}/abort`, { method: 'POST', admin: true })
  const afterAborted = await app.hold(quiz.id)
  assert.notEqual(afterAborted.runId, afterFinished.runId)
  const history = await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  assert.equal(history.length, 2)
  assert.equal(history.find((run) => run.id === held.runId).results.leaderboard[0].score, 1)
})

test('concurrent start requests create exactly one holding run', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const results = await Promise.all([0, 1].map(() => app.raw(`/api/quizzes/${quiz.id}/live/start`, {
    method: 'POST', headers: { 'x-admin-password': password },
  })))
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400])
  await Promise.all(results.map((result) => result.json()))
  assert.equal((await app.live(quiz.id)).status, 'holding')
  assert.equal(app.sqlite.prepare('SELECT COUNT(*) AS count FROM quiz_runs WHERE quiz_id = ?').get(quiz.id).count, 1)
})

test('joining requires the active event code and matching quiz/run, not just a public quiz ID', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const base = `/api/quizzes/${quiz.id}/live`
  const player = { playerId: 'Player', playerName: 'Player' }
  await app.request(`${base}/join`, { method: 'POST', body: { ...player, runId: null }, status: 400 })
  assert.equal((await app.live(quiz.id)).playerIsJoined, false)
  const hold = await app.hold(quiz.id)
  for (const body of [
    { ...player, runId: hold.runId },
    { ...player, runId: hold.runId, joinCode: '' },
    { ...player, runId: hold.runId, joinCode: '000000' },
    { ...player, runId: 'wrong', joinCode: hold.joinCode },
    { ...player, runId: null, joinCode: hold.joinCode },
  ]) {
    await app.request(`${base}/join`, { method: 'POST', body, status: 400 })
  }
  const other = await app.create()
  const otherHold = await app.hold(other.id)
  await app.request(`${base}/join`, {
    method: 'POST', body: { ...player, runId: hold.runId, joinCode: otherHold.joinCode }, status: 400,
  })
  const found = await app.request(`/api/join/${hold.joinCode}`)
  assert.equal(found.runId, hold.runId)
  assert.equal(found.quiz.id, quiz.id)
  const joined = await app.request(`${base}/join`, {
    method: 'POST', body: { ...player, runId: found.runId, joinCode: found.joinCode },
  })
  assert.equal(joined.status, 'holding')
  assert.equal(joined.playerIsJoined, true)
  await app.request(`${base}/abort`, { method: 'POST', admin: true })
  await app.request(`${base}/join`, {
    method: 'POST', body: { ...player, runId: found.runId, joinCode: found.joinCode }, status: 400,
  })
})

test('event lookup allows exactly 20 searches per browser per minute, includes failures, and persists across server restarts', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const hold = await app.hold(quiz.id)
  const client = crypto.randomUUID()
  const headers = { 'x-quiz-client-id': client }
  for (let index = 0; index < 20; index++) {
    const response = await app.raw(`/api/join/${index % 2 ? '000000' : hold.joinCode}`, { headers })
    assert.equal(response.status, index % 2 ? 404 : 200)
    await response.json()
  }
  const blocked = await app.raw(`/api/join/${hold.joinCode}`, { headers })
  assert.equal(blocked.status, 429)
  assert.equal(blocked.headers.get('cache-control'), 'no-store')
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1)
  assert.ok(Number(blocked.headers.get('retry-after')) <= 60)
  assert.match((await blocked.json()).error, /searched too many times.*try again in a few minutes/i)
  const anotherBrowser = await app.raw(`/api/join/${hold.joinCode}`, {
    headers: { 'x-quiz-client-id': crypto.randomUUID() },
  })
  assert.equal(anotherBrowser.status, 200)
  await anotherBrowser.json()
  await app.request(`/api/quizzes/${quiz.id}/live/join`, {
    method: 'POST', body: { runId: hold.runId, joinCode: hold.joinCode, playerId: 'Player', playerName: 'Player' },
  })
  for (let index = 0; index < 25; index++) {
    await app.live(quiz.id)
  }
  assert.equal(JSON.parse(app.sqlite.prepare('SELECT attempts_json FROM join_lookup_limits WHERE client_id = ?').get(client).attempts_json).length, 20)
  await app.restart()
  const stillBlocked = await app.raw(`/api/join/${hold.joinCode}`, { headers })
  assert.equal(stillBlocked.status, 429)
  await stillBlocked.json()
  const live = await app.live(quiz.id)
  assert.equal(live.status, 'holding')
  assert.equal(live.runId, hold.runId)
})

test('rolling lookup windows free individual slots after 60 seconds and remove expired browser rows', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const hold = await app.hold(quiz.id)
  const client = crypto.randomUUID()
  const oldClient = crypto.randomUUID()
  const now = Date.now()
  app.sqlite.prepare('INSERT INTO join_lookup_limits (client_id, attempts_json, last_seen_at) VALUES (?, ?, ?)')
    .run(client, JSON.stringify([now - 60_001, ...Array(19).fill(now)]), new Date(now).toISOString())
  app.sqlite.prepare('INSERT INTO join_lookup_limits (client_id, attempts_json, last_seen_at) VALUES (?, ?, ?)')
    .run(oldClient, JSON.stringify(Array(20).fill(now - 61_000)), new Date(now - 61_000).toISOString())
  const headers = { 'x-quiz-client-id': client }
  const allowed = await app.raw(`/api/join/${hold.joinCode}`, { headers })
  assert.equal(allowed.status, 200)
  await allowed.json()
  assert.equal(app.sqlite.prepare('SELECT client_id FROM join_lookup_limits WHERE client_id = ?').get(oldClient), undefined)
  const blocked = await app.raw(`/api/join/${hold.joinCode}`, { headers })
  assert.equal(blocked.status, 429)
  await blocked.json()
  const expired = Date.now() - 60_000
  app.sqlite.prepare('UPDATE join_lookup_limits SET attempts_json = ?, last_seen_at = ? WHERE client_id = ?')
    .run(JSON.stringify(Array(20).fill(expired)), new Date(expired).toISOString(), client)
  const renewed = await app.raw(`/api/join/${hold.joinCode}`, { headers })
  assert.equal(renewed.status, 200)
  await renewed.json()
  assert.equal(JSON.parse(app.sqlite.prepare('SELECT attempts_json FROM join_lookup_limits WHERE client_id = ?').get(client).attempts_json).length, 1)
})

test('concurrent event searches cannot exceed the per-browser budget and malformed searches also count', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create()
  const hold = await app.hold(quiz.id)
  const client = crypto.randomUUID()
  const responses = await Promise.all(Array.from({ length: 25 }, () =>
    app.raw(`/api/join/${hold.joinCode}`, { headers: { 'x-quiz-client-id': client } }),
  ))
  assert.equal(responses.filter((response) => response.status === 200).length, 20)
  assert.equal(responses.filter((response) => response.status === 429).length, 5)
  await Promise.all(responses.map((response) => response.json()))
  const malformedClient = crypto.randomUUID()
  for (let index = 0; index < 20; index++) {
    const response = await app.raw('/api/join/abcdef', { headers: { 'x-quiz-client-id': malformedClient } })
    assert.equal(response.status, 400)
    await response.json()
  }
  const limited = await app.raw(`/api/join/${hold.joinCode}`, { headers: { 'x-quiz-client-id': malformedClient } })
  assert.equal(limited.status, 429)
  await limited.json()
  for (const headers of [{}, { 'x-quiz-client-id': '' }, { 'x-quiz-client-id': 'short' }, { 'x-quiz-client-id': 'x'.repeat(81) }]) {
    const response = await app.raw(`/api/join/${hold.joinCode}`, { headers })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /browser identifier/)
  }
})

test('completed stats are off by default and can be enabled after a run without unlocking quiz content', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({
    revealAnswers: true, questions: [question({ explanation: 'Extra answer context' })],
  }))
  assert.equal(quiz.displayStats, false)
  const first = await app.start(quiz.id)
  assert.equal(first.completedStatsCode, null)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  await app.next(quiz.id)
  const finished = await app.next(quiz.id)
  assert.equal(finished.completedStatsCode, null)
  await app.request(`/api/join/${first.joinCode}`, { status: 404 })
  const settingsUrl = `/api/quizzes/${quiz.id}/stats-settings`
  await app.request(settingsUrl, { method: 'PUT', body: { displayStats: true }, status: 401 })
  const original = await app.request(`/api/quizzes/${quiz.id}`, { admin: true })
  const enabled = await app.request(settingsUrl, { method: 'PUT', admin: true, body: { displayStats: true } })
  assert.equal(enabled.displayStats, true)
  assert.equal(enabled.hasRun, true)
  assert.deepEqual((await app.request(`/api/quizzes/${quiz.id}`, { admin: true })).questions, original.questions)
  const lookup = await app.request(`/api/join/${first.joinCode}`)
  assert.equal(lookup.kind, 'completed')
  assert.equal(lookup.runId, first.runId)
  assert.equal(lookup.run.status, 'finished')
  const history = await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })
  assert.deepEqual(lookup.run, history[0])
  assert.equal(lookup.run.results.questions[0].explanation, 'Extra answer context')
  assert.equal(lookup.run.results.questions[0].correctCount, 1)
  assert.equal(lookup.run.results.questions[0].fastestAnswers[0].playerName, 'Alice')
  assert.equal(lookup.run.results.leaderboard[0].score, 1)
  assert.equal((await app.live(quiz.id, 'Alice', first.runId)).completedStatsCode, first.joinCode)
  assert.equal((await app.request('/api/attempts')).length, 1)
  await app.request(`/api/quizzes/${quiz.id}`, { method: 'PUT', admin: true, body: quizInput(), status: 400 })
  await app.request(`/api/quizzes/${quiz.id}/live/join`, {
    method: 'POST', status: 400,
    body: { runId: first.runId, joinCode: first.joinCode, playerId: 'Late', playerName: 'Late' },
  })
  assert.deepEqual(await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true }), history)
  await app.restart()
  assert.equal((await app.request(`/api/join/${first.joinCode}`)).kind, 'completed')
  app.sqlite.prepare('UPDATE quiz_runs SET results_json = NULL WHERE id = ?').run(first.runId)
  assert.equal((await app.live(quiz.id, 'Alice', first.runId)).completedStatsCode, null)
  await app.request(`/api/join/${first.joinCode}`, { status: 404 })
})

test('each original completed code resolves its own run and disabling stats or unpublishing revokes access', async (t) => {
  const app = await startApp(t)
  const quiz = await app.create(quizInput({ displayStats: true }))
  const first = await app.start(quiz.id)
  const activeLookup = await app.request(`/api/join/${first.joinCode}`)
  assert.equal(activeLookup.kind, 'live')
  assert.equal('run' in activeLookup, false)
  await app.answer(quiz.id, quiz.questions[0].id, 'Alice', 1)
  const firstFinished = await app.next(quiz.id)
  assert.equal(firstFinished.completedStatsCode, first.joinCode)
  const second = await app.start(quiz.id)
  assert.equal((await app.live(quiz.id, 'Alice', first.runId)).completedStatsCode, first.joinCode)
  await app.answer(quiz.id, quiz.questions[0].id, 'Bob', 0)
  await app.next(quiz.id)
  const firstStats = await app.request(`/api/join/${first.joinCode}`)
  const secondStats = await app.request(`/api/join/${second.joinCode}`)
  assert.equal(firstStats.run.results.leaderboard[0].playerName, 'Alice')
  assert.equal(firstStats.run.results.leaderboard[0].score, 1)
  assert.equal(secondStats.run.results.leaderboard[0].playerName, 'Bob')
  assert.equal(secondStats.run.results.leaderboard[0].score, 0)
  await app.request(`/api/quizzes/${quiz.id}/stats-settings`, { method: 'PUT', admin: true, body: { displayStats: false } })
  await app.request(`/api/join/${first.joinCode}`, { status: 404 })
  await app.request(`/api/join/${second.joinCode}`, { status: 404 })
  assert.equal((await app.live(quiz.id, 'Alice', first.runId)).completedStatsCode, null)
  assert.equal((await app.live(quiz.id, 'Bob', second.runId)).completedStatsCode, null)
  await app.request(`/api/quizzes/${quiz.id}/stats-settings`, { method: 'PUT', admin: true, body: { displayStats: true } })
  assert.equal((await app.request(`/api/join/${first.joinCode}`)).kind, 'completed')
  await app.request(`/api/quizzes/${quiz.id}/publication`, { method: 'PUT', admin: true, body: { isPublished: false } })
  await app.request(`/api/join/${first.joinCode}`, { status: 404 })
  await app.request(`/api/join/${second.joinCode}`, { status: 404 })
  assert.equal((await app.live(quiz.id, 'Alice', first.runId)).completedStatsCode, null)
  assert.equal((await app.request(`/api/quizzes/${quiz.id}/runs`, { admin: true })).length, 2)
  await app.request(`/api/quizzes/${quiz.id}/publication`, { method: 'PUT', admin: true, body: { isPublished: true } })
  assert.equal((await app.request(`/api/join/${second.joinCode}`)).runId, second.runId)
  const aborted = await app.hold(quiz.id)
  await app.request(`/api/quizzes/${quiz.id}/live/abort`, { method: 'POST', admin: true })
  await app.request(`/api/join/${aborted.joinCode}`, { status: 404 })
  assert.equal((await app.live(quiz.id, '', aborted.runId)).completedStatsCode, null)
  await app.request(`/api/quizzes/${quiz.id}`, { method: 'DELETE', admin: true, status: 204 })
  await app.request(`/api/join/${first.joinCode}`, { status: 404 })
})

test('completed stats settings are validated, copied and portable, with legacy exports defaulting to private', async (t) => {
  const app = await startApp(t, true)
  assert.equal((await app.request('/api/quizzes/legacy', { admin: true })).displayStats, false)
  const quiz = await app.create(quizInput({ displayStats: true }))
  const file = await app.request(`/api/quizzes/${quiz.id}/export`, { admin: true })
  assert.equal(file.quiz.displayStats, true)
  const imported = await app.request('/api/quizzes/import', { method: 'POST', admin: true, body: file, status: 201 })
  assert.equal(imported.displayStats, true)
  assert.equal(imported.isPublished, false)
  const copied = await app.request(`/api/quizzes/${quiz.id}/copy`, { method: 'POST', admin: true, status: 201 })
  assert.equal(copied.displayStats, true)
  assert.equal(copied.isPublished, false)
  delete file.quiz.displayStats
  const oldImport = await app.request('/api/quizzes/import', { method: 'POST', admin: true, body: file, status: 201 })
  assert.equal(oldImport.displayStats, false)
  for (const displayStats of [null, 'true', 1, []]) {
    await app.request(`/api/quizzes/${quiz.id}/stats-settings`, { method: 'PUT', admin: true, body: { displayStats }, status: 400 })
    await app.request('/api/quizzes', { method: 'POST', admin: true, body: quizInput({ displayStats }), status: 400 })
    file.quiz.displayStats = displayStats
    await app.request('/api/quizzes/import', { method: 'POST', admin: true, body: file, status: 400 })
  }
  await app.request('/api/quizzes/missing/stats-settings', { method: 'PUT', admin: true, body: { displayStats: true }, status: 404 })
  await app.restart()
  assert.equal((await app.request(`/api/quizzes/${quiz.id}`, { admin: true })).displayStats, true)
})
