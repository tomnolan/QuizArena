import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [input, output = path.join(root, 'private', 'quiz-exports')] = process.argv.slice(2)

if (!input || process.argv.length > 4 || input === '--help') {
  console.log('Usage: node .\\scripts\\export-sqlite-quizzes.mjs <backup.sqlite> [output-folder]')
  console.log('Requires Node 24. Defaults to private\\quiz-exports. The backup is read-only; existing exports are never overwritten.')
  process.exitCode = input === '--help' ? 0 : 1
} else {
  let db
  try {
    db = new DatabaseSync(path.resolve(input), { readOnly: true })
    db.exec('BEGIN')
    const quizzes = db.prepare('SELECT * FROM quizzes ORDER BY created_at, id').all()
    const questions = db.prepare('SELECT * FROM questions ORDER BY sort_order, id').all()
    const exportedAt = new Date().toISOString()
    const files = quizzes.map((quiz, index) => {
      const document = {
        format: 'quizarena.quiz',
        version: 1,
        exportedAt,
        quiz: {
          title: quiz.title,
          description: quiz.description ?? '',
          revealAnswers: Boolean(quiz.reveal_answers ?? 0),
          displayStats: Boolean(quiz.display_stats ?? 0),
          questions: questions.filter((question) => question.quiz_id === quiz.id).map((question) => ({
            prompt: question.prompt,
            options: JSON.parse(question.options_json),
            correctOptionIndex: question.correct_option_index,
            answerSeconds: question.answer_seconds ?? 60,
            imageUrl: question.image_url ?? '',
            afterImageUrl: question.after_image_url ?? '',
            reuseBeforeImage: Boolean(question.reuse_before_image ?? 0),
            explanation: question.explanation ?? '',
          })),
        },
      }
      const json = JSON.stringify(document)
      if (Buffer.byteLength(json, 'utf8') > 32_000_000) {
        throw new Error(`"${quiz.title}" exceeds the 32 MB quiz import limit.`)
      }
      const title = quiz.title.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'quiz'
      const filename = `${String(index + 1).padStart(3, '0')}-${title}.quizarena.json`
      const destination = path.resolve(output, filename)
      if (existsSync(destination)) {
        throw new Error(`Export already exists: ${destination}. Choose a different output folder.`)
      }
      return { destination, json, count: document.quiz.questions.length }
    })
    db.exec('COMMIT')
    if (files.length) {
      mkdirSync(path.resolve(output), { recursive: true })
      for (const file of files) {
        writeFileSync(file.destination, file.json, { encoding: 'utf8', flag: 'wx' })
        console.log(`${file.destination} (${file.count} questions)`)
      }
    }
    console.log(`Exported ${files.length} quizzes. The SQLite backup was not modified.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    db?.close()
  }
}
