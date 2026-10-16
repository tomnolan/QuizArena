import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { lookupEvent, playerUrl, requestJson, RequestError } from './api'
import { QuestionStatsCards } from './QuestionStats'

export type SiteSettings = { title: string; subtitle: string; playerBaseUrl: string }
export type QuestionStats = {
  questionId: string
  prompt: string
  options: string[]
  correctOptionIndex: number
  explanation: string
  wasAsked: boolean
  correctCount: number
  incorrectCount: number
  unansweredCount: number
  optionCounts: number[]
  fastestAnswers: { playerName: string; responseSeconds: number; isCorrect: boolean }[]
}
export type RunResults = {
  quizTitle: string
  totalQuestions: number
  questionsAsked: number | null
  playerCount: number
  totalAnswers: number | null
  correctCount: number
  incorrectCount: number | null
  detailsAvailable: boolean
  leaderboard: { playerId: string; playerName: string; score: number; totalQuestions: number }[]
  questions: QuestionStats[]
}
export type RunSummary = {
  id: string
  status: 'finished' | 'aborted'
  startedAt: string | null
  endedAt: string | null
  results: RunResults | null
}

export function JoinQr({ url, large = false }: { url: string; large?: boolean }) {
  const hostname = new URL(url).hostname
  const isLocalhost = hostname === 'localhost' || hostname.startsWith('127.') || hostname === '[::1]'
  return (
    <div className={`join-qr${large ? ' join-qr-large' : ''}`}>
      <QRCodeSVG value={url} size={large ? 320 : 192} marginSize={4} level="M" title="Scan to join this quiz" />
      <p><a href={url}>{url}</a></p>
      {isLocalhost && <p className="status-message">Phones cannot reach localhost on your computer. Open this site using its LAN address, or set the player-facing URL in Site settings. Both devices must be on the same network for LAN testing.</p>}
    </div>
  )
}

export function RunStatistics({ run }: { run: RunSummary }) {
  const results = run.results
  if (!results) {
    return <p className="error-message" role="alert">Saved statistics are unavailable for this run.</p>
  }
  return (
    <section className="run-statistics" aria-label="Saved run statistics">
      <h3>{run.status === 'aborted' ? 'Aborted run - partial results' : 'Final game statistics'}</h3>
      <p>{run.endedAt ? `Ended ${new Date(run.endedAt).toLocaleString()}` : 'Imported run - original run time unavailable.'}</p>
      {run.status === 'aborted' && <p>These partial results are saved in history, but are not posted as completed scores.</p>}
      <div className="stat-cards">
        <div className="metric-card"><span>Players</span><strong>{results.playerCount}</strong></div>
        <div className="metric-card"><span>Questions shown</span><strong>{results.questionsAsked ?? '?'} / {results.totalQuestions}</strong></div>
        <div className="metric-card"><span>Answers submitted</span><strong>{results.totalAnswers ?? 'Unknown'}</strong></div>
        <div className="metric-card"><span>Correct</span><strong>{results.correctCount}</strong></div>
        <div className="metric-card"><span>Incorrect</span><strong>{results.incorrectCount ?? 'Unknown'}</strong></div>
      </div>
      <h3>Leaderboard</h3>
      {results.leaderboard.length ? (
        <ol className="results-list final-results">
          {results.leaderboard.map((player, index) => (
            <li className="result-card" key={player.playerId}>
              <strong>#{index + 1} {player.playerName}</strong>
              <strong>{player.score}/{player.totalQuestions}</strong>
            </li>
          ))}
        </ol>
      ) : <p>No players joined this run.</p>}
      {!results.detailsAvailable && <p className="help-text">Imported scores: detailed question statistics were not recorded by the older app.</p>}
      {results.questions.map((question, index) => (
        <details className="question-card" key={question.questionId}>
          <summary>Question {index + 1}: {question.prompt}{question.wasAsked ? '' : ' (not reached)'}</summary>
          <p>Correct answer: <strong>{question.options[question.correctOptionIndex]}</strong></p>
          {question.explanation && <p className="explanation">{question.explanation}</p>}
          {question.wasAsked ? <QuestionStatsCards stats={question} playerCount={results.playerCount} /> : <p>This question was not reached.</p>}
        </details>
      ))}
    </section>
  )
}

export function JoinNowPage({ code }: { code: string }) {
  const [target, setTarget] = useState<{ quiz: { title: string }; runId: string } | null>(null)
  const [settings, setSettings] = useState<SiteSettings | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    let resolved: { quiz: { id: string; title: string }; runId: string } | null = null
    let loading = false
    const load = async () => {
      if (loading) {
        return
      }
      loading = true
      try {
        if (!resolved) {
          resolved = await lookupEvent<{ quiz: { id: string; title: string }; runId: string }>(code)
        }
        const [nextTarget, nextSettings] = await Promise.all([
          requestJson<{ status: string; joinCode: string | null }>(`/api/quizzes/${resolved.quiz.id}/live?runId=${encodeURIComponent(resolved.runId)}`),
          requestJson<SiteSettings>('/api/settings'),
        ])
        if (!['holding', 'running', 'revealing'].includes(nextTarget.status) || nextTarget.joinCode !== code) {
          throw new RequestError('This event code is not active. Check the code with the admin.', 404)
        }
        if (!cancelled) {
          setTarget(resolved)
          setSettings(nextSettings)
          setError('')
        }
      } catch (failure) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : 'Could not load this join display.')
          if (failure instanceof RequestError && [400, 404, 429].includes(failure.status)) {
            window.clearInterval(poller)
          }
        }
      } finally {
        loading = false
      }
    }
    const poller = window.setInterval(() => void load(), 2000)
    void load()
    return () => { cancelled = true; window.clearInterval(poller) }
  }, [code])
  return (
    <main className="app-shell join-display">
      <section className="panel">
        <p className="eyebrow">{settings?.title ?? 'QuizArena'}</p>
        <h1>Join Now</h1>
        {error ? <p className="error-message" role="alert">{error}</p> : target && settings ? (
          <>
            <h2>{target.quiz.title}</h2>
            <JoinQr url={playerUrl(settings.playerBaseUrl, code)} large />
            <p>Or open <strong>{settings.playerBaseUrl || window.location.origin}</strong> and enter:</p>
            <p className="join-code" aria-label={`Join code ${code}`}>{code}</p>
          </>
        ) : <p>Loading join display...</p>}
        <p><a href="/">Back to home</a></p>
      </section>
    </main>
  )
}
