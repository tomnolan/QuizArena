import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createClientId, getPlayerId, lookupEvent, playerUrl, requestJson, requestResponse } from './api'
import { JoinNowPage, JoinQr, RunStatistics } from './Hosting'
import type { QuestionStats, RunSummary, SiteSettings } from './Hosting'
import { QuestionStatsCards } from './QuestionStats'
import './App.css'

type Question = {
  id: string
  prompt: string
  options: string[]
  imageUrl: string
  answerSeconds: number
}

type Quiz = {
  id: string
  title: string
  description: string
  questions: Question[]
  createdAt: string
  revealAnswers: boolean
  displayStats: boolean
  isPublished: boolean
  hasRun: boolean
}

type Attempt = {
  id: string
  quizId: string
  quizTitle: string
  playerName: string
  score: number
  totalQuestions: number
  completedAt: string
}

type DraftQuestion = {
  id: string
  prompt: string
  options: string[]
  correctOptionIndex: number
  imageUrl: string
  afterImageUrl: string
  reuseBeforeImage: boolean
  explanation: string
  answerSeconds: number
}

type EditableQuiz = Omit<Quiz, 'questions'> & { questions: DraftQuestion[] }

type ActiveQuiz = {
  quiz: Quiz
  playerId: string
  playerName: string
  runId: string
}

type JoinTarget =
  | { kind: 'live'; quiz: Quiz; runId: string; joinCode: string }
  | { kind: 'completed'; quiz: Quiz; runId: string; joinCode: string; run: RunSummary }

type LiveSession = {
  quizId: string
  status: 'idle' | 'holding' | 'running' | 'revealing' | 'finished' | 'aborted'
  runId: string | null
  joinCode: string | null
  completedStatsCode: string | null
  currentQuestionIndex: number
  questionStartedAt: string | null
  answerSeconds: number
  totalQuestions: number
  currentQuestion: Question | null
  playerAnswer: number | null
  playerCount: number
  activePlayerCount: number
  playerRunId: string | null
  playerIsJoined: boolean
  activePlayers?: { playerId: string; playerName: string; waiting: boolean }[]
  submittedAnswerCount: number
  revealAnswers: boolean
  reveal: QuestionStats | null
  leaderboard: { playerId: string; playerName: string; score: number; totalQuestions: number }[]
}

const activeLiveStatuses: LiveSession['status'][] = ['holding', 'running', 'revealing']
const emptyQuestion = (): DraftQuestion => ({
  id: createClientId(),
  prompt: '',
  options: ['', '', '', ''],
  correctOptionIndex: 0,
  imageUrl: '',
  afterImageUrl: '',
  reuseBeforeImage: false,
  explanation: '',
  answerSeconds: 60,
})

function QuestionImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  if (!src) {
    return null
  }
  return failed ? (
    <p role="alert" className="error-message">The question image could not be loaded.</p>
  ) : (
    <img className="question-image" src={src} alt="Question illustration" onError={() => setFailed(true)} />
  )
}

function AnswerSummary({ session, playerView = false }: { session: LiveSession; playerView?: boolean }) {
  const { reveal, currentQuestion } = session
  if (!reveal || !currentQuestion) {
    return null
  }
  return (
    <section className="answer-summary" aria-label="Answer summary" aria-live="polite">
      {playerView ? (
        <p className={session.playerAnswer === reveal.correctOptionIndex ? 'correct-text' : 'incorrect-text'}>
          {session.playerAnswer === reveal.correctOptionIndex ? 'You got it right!' : 'You got it wrong.'}
        </p>
      ) : (
        <>
          <p className="eyebrow">Correct answer</p>
          <h3>{currentQuestion.options[reveal.correctOptionIndex]}</h3>
        </>
      )}
      {reveal.explanation && <p className="explanation">{reveal.explanation}</p>}
      <QuestionStatsCards stats={reveal} playerCount={session.playerCount} />
      <p className="help-text">Counts include players who joined this live run, including those who did not answer.</p>
      <p>Waiting for the admin to {session.currentQuestionIndex + 1 === session.totalQuestions ? 'finish the quiz' : 'advance to the next question'}.</p>
    </section>
  )
}

function FinalLeaderboard({ session, playerId, title }: { session: LiveSession; playerId: string; title: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  const personalResult = session.leaderboard.find((entry) => entry.playerId === playerId)
  return (
    <article className="quiz-summary">
      <h3>Quiz complete - scores are posted!</h3>
      <p>{personalResult ? `Your score: ${personalResult.score}/${personalResult.totalQuestions}.` : 'No answers were recorded for you in this run.'}</p>
      <button type="button" onClick={() => dialog.current?.showModal()}>View final leaderboard</button>
      <dialog ref={dialog} className="leaderboard-dialog" aria-labelledby="final-leaderboard-title">
        <p className="eyebrow">Quiz complete</p>
        <h2 id="final-leaderboard-title">Final leaderboard</h2>
        <p>{title}</p>
        {personalResult && <p className="status-message">Your score: {personalResult.score}/{personalResult.totalQuestions}</p>}
        {session.leaderboard.length ? (
          <ol className="results-list final-results">
            {session.leaderboard.map((entry, index) => (
              <li key={entry.playerId} className={`result-card${entry.playerId === playerId ? ' current-player' : ''}`}>
                <strong>#{index + 1} {entry.playerName}{entry.playerId === playerId ? ' (you)' : ''}</strong>
                <strong>{entry.score}/{entry.totalQuestions}</strong>
              </li>
            ))}
          </ol>
        ) : <p>No answers were recorded in this run.</p>}
        {session.completedStatsCode && (
          <p><a href={playerUrl('', session.completedStatsCode)}>View full quiz stats</a></p>
        )}
        <form method="dialog" className="button-row">
          <button autoFocus>Close leaderboard</button>
        </form>
      </dialog>
    </article>
  )
}

function App() {
  const [activeSection, setActiveSection] = useState<'home' | 'admin'>(() =>
    window.location.pathname === '/admin' ? 'admin' : 'home',
  )
  const [quizzes, setQuizzes] = useState<Quiz[]>([])
  const [adminQuizzes, setAdminQuizzes] = useState<Quiz[]>([])
  const [adminView, setAdminView] = useState<'library' | 'quiz' | 'editor' | 'settings'>('library')
  const [siteSettings, setSiteSettings] = useState<SiteSettings | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<SiteSettings | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [runsError, setRunsError] = useState('')
  const [runsLoading, setRunsLoading] = useState(false)
  const [joinCodeInput, setJoinCodeInput] = useState(() => new URLSearchParams(window.location.search).get('code') ?? '')
  const [joinTarget, setJoinTarget] = useState<JoinTarget | null>(null)
  const [isJoining, setIsJoining] = useState(false)
  const [selectedAdminQuizId, setSelectedAdminQuizId] = useState('')
  const [attempts, setAttempts] = useState<Attempt[]>([])
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [revealAnswers, setRevealAnswers] = useState(false)
  const [displayStats, setDisplayStats] = useState(false)
  const [editingQuizId, setEditingQuizId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const importFileInput = useRef<HTMLInputElement>(null)
  const [pendingUploads, setPendingUploads] = useState(0)
  const [isLiveBusy, setIsLiveBusy] = useState(false)
  const [draftQuestions, setDraftQuestions] = useState<DraftQuestion[]>([emptyQuestion()])
  const [collapsedQuestionIds, setCollapsedQuestionIds] = useState<string[]>([])
  const [formMessage, setFormMessage] = useState('')
  const [playerName, setPlayerName] = useState('')
  const [activeQuiz, setActiveQuiz] = useState<ActiveQuiz | null>(null)
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null)
  const [playMessage, setPlayMessage] = useState('')
  const [playError, setPlayError] = useState('')
  const [adminPasswordInput, setAdminPasswordInput] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [now, setNow] = useState(Date.now())

  const selectedAdminQuiz = adminQuizzes.find((quiz) => quiz.id === selectedAdminQuizId)
  const editingQuiz = adminQuizzes.find((quiz) => quiz.id === editingQuizId)
  const liveQuizId = activeSection === 'admin'
    ? isAdminUnlocked && adminView === 'quiz' ? selectedAdminQuiz?.id : undefined
    : activeQuiz?.quiz.id ?? (joinTarget?.kind === 'live' ? joinTarget.quiz.id : undefined)
  const editorIsDisabled = !isAdminUnlocked || isSaving
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0]
  const liveIsActive = liveSession?.quizId === selectedAdminQuiz?.id && activeLiveStatuses.includes(liveSession?.status ?? 'idle')

  const leaderboard = useMemo(
    () =>
      attempts
        .toSorted((left, right) => {
          const scoreDelta = right.score / right.totalQuestions - left.score / left.totalQuestions

          if (scoreDelta !== 0) {
            return scoreDelta
          }

          return Date.parse(right.completedAt) - Date.parse(left.completedAt)
        })
        .slice(0, 10),
    [attempts],
  )

  const remainingSeconds = useMemo(() => {
    if (
      !liveSession ||
      liveSession.status !== 'running' ||
      !liveSession.questionStartedAt ||
      !liveSession.currentQuestion
    ) {
      return 0
    }

    const elapsedSeconds = (now - Date.parse(liveSession.questionStartedAt)) / 1000
    return Math.min(liveSession.answerSeconds, Math.max(0, Math.ceil(liveSession.answerSeconds - elapsedSeconds)))
  }, [liveSession, now])
  const countdownProgress = liveSession?.status === 'running' && liveSession.questionStartedAt
    ? Math.max(0, Math.min(100, (1 - (now - Date.parse(liveSession.questionStartedAt)) / (liveSession.answerSeconds * 1000)) * 100))
    : 0
  const questionIsLocked = liveSession?.status !== 'running' || remainingSeconds === 0
  const timerWarningClass = liveSession?.status === 'running' && remainingSeconds <= 10
    ? `timer-urgent${remainingSeconds === 0 ? ' timer-expired' : ''}` : ''

  const refreshAttempts = async () => {
    setAttempts(await requestJson<Attempt[]>('/api/attempts'))
  }

  const getAdminHeaders = () => ({ 'x-admin-password': adminPassword })

  useEffect(() => {
    const loadSharedData = async () => {
      try {
        const [storedQuizzes, storedAttempts, storedSettings] = await Promise.all([
          requestJson<Quiz[]>('/api/quizzes'),
          requestJson<Attempt[]>('/api/attempts'),
          requestJson<SiteSettings>('/api/settings'),
        ])
        setQuizzes(storedQuizzes)
        setAttempts(storedAttempts)
        setSiteSettings(storedSettings)
        const code = new URLSearchParams(window.location.search).get('code')
        if (code && !new URLSearchParams(window.location.search).has('display')) {
          setJoinTarget(await lookupEvent<JoinTarget>(code))
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not load quiz data.'
        setPlayError(message)
      } finally {
        setIsLoading(false)
      }
    }

    void loadSharedData()
  }, [])

  useEffect(() => {
    if (siteSettings) {
      document.title = siteSettings.title
    }
  }, [siteSettings])

  useEffect(() => {
    if (activeSection !== 'home' || activeQuiz) {
      return undefined
    }
    let cancelled = false
    const poller = window.setInterval(() => {
      void Promise.all([requestJson<Quiz[]>('/api/quizzes'), requestJson<SiteSettings>('/api/settings')])
        .then(([nextQuizzes, nextSettings]) => {
          if (!cancelled) {
            setQuizzes(nextQuizzes)
            setSiteSettings(nextSettings)
            if (joinTarget && !nextQuizzes.some((quiz) =>
              quiz.id === joinTarget.quiz.id && (joinTarget.kind === 'live' || quiz.displayStats),
            )) {
              setJoinTarget(null)
              setPlayError('This event code is no longer active. Check the code with the admin.')
            }
          }
        }).catch((error: unknown) => {
          if (!cancelled) {
            setPlayError(error instanceof Error ? error.message : 'Could not refresh quiz information.')
          }
        })
    }, 5000)
    return () => { cancelled = true; window.clearInterval(poller) }
  }, [activeSection, activeQuiz, joinTarget])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const handleLocationChange = () => {
      setActiveSection(window.location.pathname === '/admin' ? 'admin' : 'home')
    }

    window.addEventListener('popstate', handleLocationChange)
    return () => window.removeEventListener('popstate', handleLocationChange)
  }, [])

  const navigateToSection = (section: 'home' | 'admin') => {
    const nextPath = section === 'admin' ? '/admin' : '/'

    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath)
    }

    setActiveSection(section)
  }

  useEffect(() => {
    if (!liveQuizId) {
      setLiveSession(null)
      return undefined
    }

    let isCancelled = false
    let lastQuestionState = ''

    const loadLiveSession = async () => {
      const query = new URLSearchParams()
      if (activeQuiz && activeSection === 'home') {
        query.set('playerId', activeQuiz.playerId)
        query.set('runId', activeQuiz.runId)
      } else if (joinTarget?.kind === 'live' && activeSection === 'home') {
        query.set('runId', joinTarget.runId)
      }
      const session = await requestJson<LiveSession>(`/api/quizzes/${liveQuizId}/live?${query}`, {
        headers: activeSection === 'admin' ? { 'x-admin-password': adminPassword } : {},
      })

      if (isCancelled) {
        return
      }
      if (activeSection === 'home' && !activeQuiz && joinTarget?.kind === 'live' &&
        (session.runId !== joinTarget.runId || !activeLiveStatuses.includes(session.status))) {
        setJoinTarget(null)
        setPlayMessage('')
        setPlayError('This event code is no longer active. Check the code with the admin.')
        return
      }
      if (activeQuiz && activeSection === 'home' && !session.playerIsJoined &&
        !['finished', 'aborted'].includes(session.status)) {
        setActiveQuiz(null)
        setJoinTarget(null)
        setPlayError('You are no longer joined. Enter the event code and join again.')
        return
      }

      setLiveSession(session)
      if (activeSection === 'admin' && session.status !== 'idle') {
        setAdminQuizzes((current) => current.map((quiz) =>
          quiz.id === session.quizId && !quiz.hasRun ? { ...quiz, hasRun: true } : quiz,
        ))
      }
      const questionState = `${session.quizId}:${session.currentQuestion?.id}:${session.status}:${session.questionStartedAt}`
      if (activeQuiz && questionState !== lastQuestionState) {
        setPlayMessage('')
        setPlayError('')
        lastQuestionState = questionState
      }

      if (session.status === 'finished') {
        await refreshAttempts()
      }
    }

    const reportError = (error: unknown) => {
      if (isCancelled) {
        return
      }
      const message = error instanceof Error ? error.message : 'Could not load live quiz state.'
      if (activeSection === 'admin') {
        setFormMessage(message)
      } else {
        setPlayError(message)
        if (!activeQuiz && activeSection === 'home') {
          setJoinTarget(null)
        }
      }
    }
    void loadLiveSession().catch(reportError)

    const poller = window.setInterval(() => {
      void loadLiveSession().catch(reportError)
    }, 1000)

    return () => {
      isCancelled = true
      window.clearInterval(poller)
    }
  }, [activeQuiz, liveQuizId, activeSection, adminPassword, joinTarget])

  useEffect(() => {
    if (!activeQuiz) {
      return undefined
    }
    const notifyLeave = () => {
      void fetch(`/api/quizzes/${activeQuiz.quiz.id}/live/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: activeQuiz.playerId, runId: activeQuiz.runId }),
        keepalive: true,
      }).then((response) => {
        if (!response.ok) {
          console.warn('Could not notify the server that this player left. Presence will expire automatically.')
        }
      }).catch((error: unknown) => {
        console.warn('Could not notify the server that this player left. Presence will expire automatically.', error)
      })
    }
    window.addEventListener('pagehide', notifyLeave)
    return () => window.removeEventListener('pagehide', notifyLeave)
  }, [activeQuiz])

  useEffect(() => {
    if (activeSection !== 'admin' || !isAdminUnlocked || adminView !== 'quiz' || !selectedAdminQuizId) {
      return undefined
    }
    let cancelled = false
    setRunsLoading(true)
    void requestJson<RunSummary[]>(`/api/quizzes/${selectedAdminQuizId}/runs`, {
      headers: { 'x-admin-password': adminPassword },
    }).then((nextRuns) => {
      if (!cancelled) {
        setRuns(nextRuns)
        setRunsError('')
      }
    }).catch((error: unknown) => {
      if (!cancelled) {
        setRunsError(error instanceof Error ? error.message : 'Could not load run history.')
      }
    }).finally(() => {
      if (!cancelled) {
        setRunsLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [activeSection, isAdminUnlocked, adminView, selectedAdminQuizId, liveSession?.status, liveSession?.runId, adminPassword])

  const updateQuestion = (questionIndex: number, changes: Partial<DraftQuestion>) => {
    setDraftQuestions((currentQuestions) =>
      currentQuestions.map((question, index) =>
        index === questionIndex
          ? {
            ...question, ...changes,
            reuseBeforeImage: Boolean((changes.imageUrl ?? question.imageUrl).trim()) &&
              (changes.reuseBeforeImage ?? question.reuseBeforeImage),
          }
          : question,
      ),
    )
  }

  const updateOption = (questionIndex: number, optionIndex: number, value: string) => {
    setDraftQuestions((currentQuestions) =>
      currentQuestions.map((question, index) => {
        if (index !== questionIndex) {
          return question
        }

        const nextOptions = [...question.options]
        nextOptions[optionIndex] = value

        return { ...question, options: nextOptions }
      }),
    )
  }

  const addQuestionImage = async (questionId: string, field: 'imageUrl' | 'afterImageUrl', file: File) => {
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 2_000_000) {
      setFormMessage('Choose a PNG, JPEG, GIF, or WebP image no larger than 2 MB.')
      return
    }
    setPendingUploads((count) => count + 1)
    try {
      const imageUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => typeof reader.result === 'string'
          ? resolve(reader.result)
          : reject(new Error('Could not read image.'))
        reader.onerror = () => reject(reader.error ?? new Error('Could not read image.'))
        reader.readAsDataURL(file)
      })
      setDraftQuestions((questions) => questions.map((question) =>
        question.id === questionId ? { ...question, [field]: imageUrl } : question,
      ))
      setFormMessage('Image added. Save the quiz to keep it.')
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not read image.')
    } finally {
      setPendingUploads((count) => count - 1)
    }
  }

  const resetEditor = () => {
    setEditingQuizId(null)
    setTitle('')
    setDescription('')
    setRevealAnswers(false)
    setDisplayStats(false)
    setDraftQuestions([emptyQuestion()])
    setCollapsedQuestionIds([])
  }

  const showLibrary = async () => {
    setIsSaving(true)
    try {
      setAdminQuizzes(await requestJson<Quiz[]>('/api/admin/quizzes', { headers: getAdminHeaders() }))
      resetEditor()
      setSelectedAdminQuizId('')
      setAdminView('library')
      setFormMessage('')
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not load the quiz library.')
    } finally {
      setIsSaving(false)
    }
  }

  const populateEditor = (quiz: EditableQuiz) => {
    setEditingQuizId(quiz.id)
    setSelectedAdminQuizId(quiz.id)
    setTitle(quiz.title)
    setDescription(quiz.description)
    setRevealAnswers(quiz.revealAnswers)
    setDisplayStats(quiz.displayStats)
    setDraftQuestions(quiz.questions.length ? quiz.questions : [emptyQuestion()])
    setCollapsedQuestionIds(quiz.questions.map((question) => question.id))
    setAdminView('editor')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const editQuiz = async (quizId: string) => {
    setIsSaving(true)
    try {
      const quiz = await requestJson<EditableQuiz>(`/api/quizzes/${quizId}`, { headers: getAdminHeaders() })
      setAdminQuizzes((current) => current.map((entry) => entry.id === quiz.id ? quiz : entry))
      if (quiz.hasRun) {
        setFormMessage('This quiz has already been run and cannot be edited. Copy it to a new quiz instead.')
        return
      }
      populateEditor(quiz)
      setFormMessage('')
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not load quiz for editing.')
    } finally {
      setIsSaving(false)
    }
  }

  const copyQuiz = async (quizId: string) => {
    setIsSaving(true)
    try {
      const copy = await requestJson<Quiz>(`/api/quizzes/${quizId}/copy`, { method: 'POST', headers: getAdminHeaders() })
      setAdminQuizzes((current) => [copy, ...current])
      const editable = await requestJson<EditableQuiz>(`/api/quizzes/${copy.id}`, { headers: getAdminHeaders() })
      populateEditor(editable)
      setFormMessage(`Created "${copy.title}" as a draft. The original quiz is unchanged.`)
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not copy quiz.')
    } finally {
      setIsSaving(false)
    }
  }

  const exportQuiz = async (quizId: string) => {
    setIsSaving(true)
    try {
      const response = await requestResponse(`/api/quizzes/${quizId}/export`, { headers: getAdminHeaders() })
      const blob = await response.blob()
      const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'quiz.quizarena.json'
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      try {
        link.click()
      } finally {
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      setFormMessage('Quiz export download started. The JSON includes uploaded images, but not scores or run history.')
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not export quiz.')
    } finally {
      setIsSaving(false)
    }
  }

  const importQuiz = async (file: File) => {
    if (file.size > 32_000_000) {
      setFormMessage('The quiz file exceeds the 32 MB import limit.')
      return
    }
    setIsSaving(true)
    try {
      const imported = await requestJson<EditableQuiz>('/api/quizzes/import', {
        method: 'POST',
        headers: getAdminHeaders(),
        body: await file.text(),
      })
      setAdminQuizzes((current) => [imported, ...current])
      populateEditor(imported)
      setFormMessage(`Imported "${imported.title}" as a new draft. Review it and publish when ready. Existing quizzes are unchanged.`)
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not import quiz.')
    } finally {
      setIsSaving(false)
    }
  }

  const selectAdminQuiz = (quiz: Quiz) => {
    if (!quiz.isPublished && !quiz.hasRun) {
      void editQuiz(quiz.id)
      return
    }
    setSelectedAdminQuizId(quiz.id)
    setRuns([])
    setSelectedRunId('')
    setRunsError('')
    setLiveSession(null)
    setAdminView('quiz')
    setFormMessage('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const saveQuiz = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const submitEvent = event.nativeEvent
    const isPublished = Boolean(editingQuiz?.isPublished) || (
      submitEvent instanceof SubmitEvent && submitEvent.submitter instanceof HTMLButtonElement &&
      submitEvent.submitter.value === 'publish'
    )

    const trimmedTitle = title.trim()
    const normalizedQuestions = draftQuestions.map((question) => ({
      ...question,
      prompt: question.prompt.trim(),
      options: question.options.map((option) => option.trim()),
    }))

    if (!trimmedTitle) {
      setFormMessage('Add a quiz title before saving.')
      return
    }

    const incompleteQuestions = normalizedQuestions.filter((question) =>
      !question.prompt || question.options.some((option) => !option) ||
      !question.options[question.correctOptionIndex],
    )
    if (isPublished && incompleteQuestions.length) {
      setCollapsedQuestionIds((current) => current.filter((id) =>
        !incompleteQuestions.some((question) => question.id === id),
      ))
      setFormMessage('Every question needs text, four answers, and a correct answer.')
      return
    }

    if (!isAdminUnlocked) {
      setFormMessage('Enter the admin password to publish quizzes.')
      return
    }

    if (normalizedQuestions.some((question) => !Number.isSafeInteger(question.answerSeconds) || question.answerSeconds < 20)) {
      setFormMessage('Each question timer must be a whole number of at least 20 seconds.')
      return
    }
    setIsSaving(true)
    try {
      const quiz = await requestJson<Quiz>(editingQuizId ? `/api/quizzes/${editingQuizId}` : '/api/quizzes', {
        method: editingQuizId ? 'PUT' : 'POST',
        headers: getAdminHeaders(),
        body: JSON.stringify({
          title: trimmedTitle,
          description: description.trim(),
          revealAnswers,
          displayStats,
          isPublished,
          questions: normalizedQuestions,
        }),
      })

      setAdminQuizzes((current) => editingQuizId
        ? current.map((entry) => entry.id === quiz.id ? quiz : entry)
        : [quiz, ...current])
      setQuizzes((current) => [quiz, ...current.filter((entry) => entry.id !== quiz.id)].filter((entry) => entry.isPublished))
      setSelectedAdminQuizId(quiz.id)
      if (quiz.isPublished) {
        resetEditor()
        setLiveSession(null)
        setAdminView('quiz')
      } else {
        setEditingQuizId(quiz.id)
      }
      setFormMessage(`${quiz.isPublished ? 'Saved published quiz' : 'Saved draft'} "${quiz.title}".`)
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not save quiz.')
    } finally {
      setIsSaving(false)
    }
  }

  const startLiveQuiz = async () => {
    if (!selectedAdminQuiz) {
      setFormMessage('Create a quiz before starting a live session.')
      return
    }

    if (!isAdminUnlocked) {
      setFormMessage('Enter the admin password to control live quizzes.')
      return
    }

    setIsLiveBusy(true)
    try {
      setLiveSession(
        await requestJson<LiveSession>(`/api/quizzes/${selectedAdminQuiz.id}/live/start`, {
          method: 'POST',
          headers: getAdminHeaders(),
        }),
      )
      setAdminQuizzes((current) => current.map((quiz) => quiz.id === selectedAdminQuiz.id ? { ...quiz, hasRun: true } : quiz))
      setSelectedRunId('')
      setFormMessage(`Holding lobby opened for "${selectedAdminQuiz.title}". Display Join Now, then begin the first question when ready.`)
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not start live quiz.')
    } finally {
      setIsLiveBusy(false)
    }
  }

  const abortLiveQuiz = async () => {
      if (!selectedAdminQuiz) {
        return
      }
      setIsLiveBusy(true)
      try {
        setLiveSession(await requestJson<LiveSession>(`/api/quizzes/${selectedAdminQuiz.id}/live/abort`, {
          method: 'POST', headers: getAdminHeaders(),
        }))
        setSelectedRunId('')
        setFormMessage('Run aborted. Partial statistics are saved in history, without posting completed scores.')
      } catch (error) {
        setFormMessage(error instanceof Error ? error.message : 'Could not abort this run.')
      } finally {
        setIsLiveBusy(false)
      }
  }

  const changePublication = async (quiz: Quiz) => {
      setIsSaving(true)
      try {
        const updated = await requestJson<Quiz>(`/api/quizzes/${quiz.id}/publication`, {
          method: 'PUT', headers: getAdminHeaders(), body: JSON.stringify({ isPublished: !quiz.isPublished }),
        })
        setAdminQuizzes((current) => current.map((entry) => entry.id === updated.id ? updated : entry))
        setQuizzes((current) => [updated, ...current.filter((entry) => entry.id !== updated.id)].filter((entry) => entry.isPublished))
        setFormMessage(`"${updated.title}" is ${updated.isPublished ? 'published' : 'unpublished'}. Saved runs are unchanged.`)
      } catch (error) {
        setFormMessage(error instanceof Error ? error.message : 'Could not change publication.')
      } finally {
        setIsSaving(false)
      }
  }

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!settingsDraft) {
        return
      }
      setIsSaving(true)
      try {
        const saved = await requestJson<SiteSettings>('/api/settings', {
          method: 'PUT', headers: getAdminHeaders(), body: JSON.stringify(settingsDraft),
        })
        setSiteSettings(saved)
        setSettingsDraft(saved)
        setFormMessage('Site settings saved.')
      } catch (error) {
        setFormMessage(error instanceof Error ? error.message : 'Could not save site settings.')
      } finally {
        setIsSaving(false)
      }
  }

  const advanceLiveQuiz = async () => {
    if (!selectedAdminQuiz) {
      return
    }
    if (!isAdminUnlocked) {
      setFormMessage('Enter the admin password to control live quizzes.')
      return
    }

    setIsLiveBusy(true)
    try {
      const isBeginning = liveSession?.status === 'holding'
      const session = await requestJson<LiveSession>(`/api/quizzes/${selectedAdminQuiz.id}/live/${isBeginning ? 'begin' : 'next'}`, {
        method: 'POST',
        headers: getAdminHeaders(),
        body: isBeginning ? JSON.stringify({ runId: liveSession.runId }) : undefined,
      })
      setLiveSession(session)

      if (session.status === 'finished') {
        setSelectedRunId('')
        await refreshAttempts()
        setFormMessage(`"${selectedAdminQuiz.title}" is finished and scores are posted.`)
      } else if (session.status === 'revealing') {
        setFormMessage('Answer and response stats are displayed. Advance when ready.')
      } else if (isBeginning) {
        setFormMessage('The first question has begun. The answer timer is now running.')
      } else {
        setFormMessage(`Advanced to question ${session.currentQuestionIndex + 1}.`)
      }
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not advance live quiz.')
    } finally {
      setIsLiveBusy(false)
    }
  }

  const changeStatsDisplay = async (quiz: Quiz, enabled: boolean) => {
    setIsSaving(true)
    try {
      const updated = await requestJson<Quiz>(`/api/quizzes/${quiz.id}/stats-settings`, {
        method: 'PUT', headers: getAdminHeaders(), body: JSON.stringify({ displayStats: enabled }),
      })
      setAdminQuizzes((current) => current.map((entry) => entry.id === updated.id ? updated : entry))
      setQuizzes((current) => current.map((entry) => entry.id === updated.id ? updated : entry))
      setFormMessage(`Completed stats ${updated.displayStats ? 'enabled' : 'disabled'} for "${updated.title}".`)
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not change completed stats display.')
    } finally {
      setIsSaving(false)
    }
  }

  const deleteQuiz = async (quiz: Quiz) => {
    const quizId = quiz.id
    if (!isAdminUnlocked) {
      setFormMessage('Enter the admin password to delete quizzes.')
      return
    }
    if (!window.confirm(`Delete "${quiz.title}"? Its questions, saved runs, and scores will be permanently deleted. This cannot be undone.`)) {
      return
    }

    setIsSaving(true)
    try {
      await requestJson<void>(`/api/quizzes/${quizId}`, {
        method: 'DELETE',
        headers: getAdminHeaders(),
      })
      setQuizzes((currentQuizzes) => currentQuizzes.filter((quiz) => quiz.id !== quizId))
      setAdminQuizzes((current) => current.filter((quiz) => quiz.id !== quizId))
      setAttempts((currentAttempts) =>
        currentAttempts.filter((attempt) => attempt.quizId !== quizId),
      )

      if (joinTarget?.quiz.id === quizId) {
        setJoinTarget(null)
      }
      if (editingQuizId === quizId) {
        resetEditor()
      }
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : 'Could not delete quiz.')
    } finally {
      setIsSaving(false)
    }
  }

  const unlockAdmin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const trimmedPassword = adminPasswordInput.trim()

    if (!trimmedPassword) {
      setFormMessage('Enter an admin password to unlock admin controls.')
      return
    }

    try {
      await requestJson<{ ok: true }>('/api/admin/auth', {
        method: 'POST',
        headers: { 'x-admin-password': trimmedPassword },
      })
      const storedQuizzes = await requestJson<Quiz[]>('/api/admin/quizzes', {
        headers: { 'x-admin-password': trimmedPassword },
      })
      setAdminQuizzes(storedQuizzes)
      setAdminPassword(trimmedPassword)
      setIsAdminUnlocked(true)
      setAdminView('library')
      setSelectedAdminQuizId('')
      setFormMessage('')
    } catch (error) {
      setIsAdminUnlocked(false)
      setAdminPassword('')
      setFormMessage(error instanceof Error ? error.message : 'Admin password check failed.')
    }
  }

  const lockAdmin = () => {
    setIsAdminUnlocked(false)
    setAdminPassword('')
    setAdminPasswordInput('')
    setAdminQuizzes([])
    setAdminView('library')
    setSelectedAdminQuizId('')
    resetEditor()
    setFormMessage('')
  }

  const findQuizByCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setJoinTarget(null)
    setPlayMessage('')
    setPlayError('')
    if (!/^\d{6}$/.test(joinCodeInput.trim())) {
      setPlayError('Enter a 6-digit event code.')
      return
    }
    setIsJoining(true)
    try {
      const target = await lookupEvent<JoinTarget>(joinCodeInput.trim())
      setJoinTarget(target)
      window.history.replaceState({}, '', `/?code=${encodeURIComponent(joinCodeInput.trim())}`)
      setPlayMessage(target.kind === 'completed'
        ? `Showing completed statistics for "${target.quiz.title}".`
        : `Found "${target.quiz.title}". Enter your player name to join.`)
    } catch (error) {
      setPlayError(error instanceof Error ? error.message : 'Could not find a quiz with that event code.')
    } finally {
      setIsJoining(false)
    }
  }

  const joinQuiz = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    setPlayMessage('')
    setPlayError('')
    if (!joinTarget || joinTarget.kind !== 'live') {
      setPlayError('Enter a valid event code before joining a quiz.')
      return
    }

    const trimmedPlayerName = playerName.trim()

    if (!trimmedPlayerName) {
      setPlayError('Enter a player name to begin.')
      return
    }

    setIsJoining(true)
    try {
      const playerId = getPlayerId()
      const joined = await requestJson<LiveSession>(`/api/quizzes/${joinTarget.quiz.id}/live/join`, {
        method: 'POST', body: JSON.stringify({
          runId: joinTarget.runId,
          joinCode: joinTarget.joinCode,
          playerId, playerName: trimmedPlayerName,
        }),
      })
      setLiveSession(joined)
      setActiveQuiz({ quiz: joinTarget.quiz, playerId, playerName: trimmedPlayerName, runId: joinTarget.runId })
      setPlayMessage('')
    } catch (error) {
      setJoinTarget(null)
      setPlayError(error instanceof Error ? error.message : 'Could not join this quiz.')
    } finally {
      setIsJoining(false)
    }
  }

  const leaveQuiz = async () => {
    if (!activeQuiz) {
      return
    }
    setIsJoining(true)
    try {
      await requestJson<void>(`/api/quizzes/${activeQuiz.quiz.id}/live/leave`, {
        method: 'POST', body: JSON.stringify({ playerId: activeQuiz.playerId, runId: activeQuiz.runId }),
      })
      setActiveQuiz(null)
      setJoinTarget(null)
      setPlayMessage('')
      setPlayError('')
    } catch (error) {
      setPlayError(error instanceof Error ? error.message : 'Could not leave this quiz.')
    } finally {
      setIsJoining(false)
    }
  }

  const submitLiveAnswer = async (selectedOptionIndex: number) => {
    if (!activeQuiz || !liveSession?.currentQuestion || questionIsLocked) {
      return
    }
    try {
      setLiveSession(
        await requestJson<LiveSession>(`/api/quizzes/${activeQuiz.quiz.id}/live/answer`, {
          method: 'POST',
          body: JSON.stringify({
            playerId: activeQuiz.playerId,
            runId: activeQuiz.runId,
            playerName: activeQuiz.playerName,
            questionId: liveSession.currentQuestion.id,
            selectedOptionIndex,
          }),
        }),
      )
      setPlayMessage('Answer saved. You can change it until time is up.')
      setPlayError('')
    } catch (error) {
      setPlayError(error instanceof Error ? error.message : 'Could not save answer.')
    }
  }

  const displayCode = new URLSearchParams(window.location.search).get('display')
  if (displayCode) {
    return <JoinNowPage code={displayCode} />
  }

  return (
    <main className="app-shell">
      {activeSection === 'home' && (
      <section className="hero">
        <div>
          <p className="eyebrow">Live quiz builder</p>
          <h1>{siteSettings?.title ?? 'QuizArena'}</h1>
          <p className="hero-copy">
            {siteSettings?.subtitle}
          </p>
          <div className="button-row hero-actions">
            <button
              type="button"
              onClick={() => navigateToSection('home')}
            >
              Home
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => navigateToSection('admin')}
            >
              Admin
            </button>
          </div>
        </div>
        <div className="stat-card" aria-label="Quiz app stats">
          <strong>{quizzes.length}</strong>
          <span>published quizzes</span>
          <strong>{attempts.length}</strong>
          <span>completed plays</span>
        </div>
      </section>
      )}

      {isLoading && activeSection === 'home' ? (
        <section className="panel full-width">
          <p>Loading shared quiz data...</p>
        </section>
      ) : (
        <>
          <div className="workspace workspace-single">
            {activeSection === 'admin' ? (
              <section className="panel">
              {!isAdminUnlocked ? (
              <>
              <div className="panel-heading">
                <p className="eyebrow">Admin</p>
                <h2>Unlock admin</h2>
              </div>

              <form onSubmit={unlockAdmin} className="stack admin-gate">
                <label>
                  Admin password
                  <input
                    type="password"
                    value={adminPasswordInput}
                    onChange={(event) => setAdminPasswordInput(event.target.value)}
                    autoComplete="current-password"
                  />
                </label>

                <div className="button-row">
                  <button type="submit">Unlock admin controls</button>
                  <button type="button" className="secondary-button" onClick={() => navigateToSection('home')}>Player view</button>
                </div>
              </form>
              </>
              ) : adminView === 'library' ? (
              <>
                <div className="admin-heading">
                  <div>
                    <p className="eyebrow">Admin library</p>
                    <h2>Quizzes</h2>
                  </div>
                  <div className="button-row">
                    <button type="button" disabled={isSaving} onClick={() => {
                      resetEditor()
                      setSelectedAdminQuizId('')
                      setFormMessage('')
                      setAdminView('editor')
                    }}>Create new quiz</button>
                    <button type="button" className="secondary-button" disabled={isSaving} onClick={() => importFileInput.current?.click()}>Import quiz</button>
                    <input
                      ref={importFileInput}
                      type="file"
                      accept=".json,application/json"
                      aria-label="Quiz JSON file"
                      hidden
                      disabled={isSaving}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0]
                        event.currentTarget.value = ''
                        if (file) {
                          void importQuiz(file)
                        }
                      }}
                    />
                    <button type="button" className="secondary-button" disabled={isSaving || !siteSettings} onClick={() => {
                      setSettingsDraft(siteSettings)
                      setFormMessage('')
                      setAdminView('settings')
                    }}>Site settings</button>
                    <button type="button" className="secondary-button" disabled={isSaving} onClick={lockAdmin}>Lock</button>
                    <button type="button" className="secondary-button" onClick={() => navigateToSection('home')}>Player view</button>
                  </div>
                </div>
                {adminQuizzes.length === 0 ? (
                  <p>No quizzes yet. Create a new quiz to get started.</p>
                ) : (
                  <div className="quiz-library">
                    {adminQuizzes.map((quiz) => (
                      <article key={quiz.id} className="quiz-summary">
                        <h3>{quiz.title}</h3>
                        <p>{quiz.description || 'No description provided.'}</p>
                        <p className="help-text">
                          {quiz.isPublished ? 'Published' : quiz.hasRun ? 'Unpublished' : 'Draft'} - {quiz.questions.length} questions
                          {quiz.hasRun ? ' - Already run - copy to edit' : ''}
                        </p>
                        <div className="button-row">
                          <button type="button" disabled={isSaving} onClick={() => selectAdminQuiz(quiz)}>Select</button>
                          <button type="button" className="secondary-button" disabled={isSaving} onClick={() => void copyQuiz(quiz.id)}>Copy to new quiz</button>
                          <button type="button" className="secondary-button" disabled={isSaving} onClick={() => void exportQuiz(quiz.id)}>Export quiz</button>
                          {(quiz.isPublished || quiz.hasRun) && (
                            <button type="button" className="secondary-button" disabled={isSaving} onClick={() => void changePublication(quiz)}>{quiz.isPublished ? 'Unpublish' : 'Publish'}</button>
                          )}
                          <button type="button" className="danger-button" disabled={isSaving} onClick={() => void deleteQuiz(quiz)}>Delete</button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </>
              ) : adminView === 'settings' && settingsDraft ? (
                <>
                  <div className="admin-heading">
                    <div><p className="eyebrow">Admin</p><h2>Site settings</h2></div>
                    <button type="button" className="secondary-button" disabled={isSaving} onClick={() => void showLibrary()}>Back to quizzes</button>
                  </div>
                  <form className="stack" onSubmit={saveSettings}>
                    <label>Home page title
                      <input value={settingsDraft.title} required maxLength={200} disabled={isSaving} onChange={(event) => setSettingsDraft({ ...settingsDraft, title: event.target.value })} />
                    </label>
                    <label>Home page subtitle
                      <textarea value={settingsDraft.subtitle} maxLength={1000} rows={3} disabled={isSaving} onChange={(event) => setSettingsDraft({ ...settingsDraft, subtitle: event.target.value })} />
                    </label>
                    <label>Player-facing URL (optional)
                      <input type="url" value={settingsDraft.playerBaseUrl} placeholder="https://quiz.example.com or http://192.168.1.10:5173" disabled={isSaving} onChange={(event) => setSettingsDraft({ ...settingsDraft, playerBaseUrl: event.target.value })} />
                    </label>
                    <p className="help-text">Used in QR codes and the Join Now display. Leave blank to use the current site address. For local phone testing, use this computer's reachable LAN address, not localhost.</p>
                    <div className="button-row"><button disabled={isSaving} type="submit">{isSaving ? 'Saving...' : 'Save site settings'}</button></div>
                  </form>
                </>
              ) : adminView === 'editor' ? (
              <>
                <div className="admin-heading">
                  <div>
                    <p className="eyebrow">Quiz editor</p>
                    <h2>{editingQuizId ? `Edit ${editingQuiz?.isPublished ? 'published quiz' : 'draft'}` : 'Create a quiz'}</h2>
                  </div>
                  <button type="button" className="secondary-button" disabled={isSaving || pendingUploads > 0} onClick={() => void showLibrary()}>Back to quizzes</button>
                </div>
              <form onSubmit={saveQuiz} className="stack" onInvalidCapture={(event) => {
                if (event.target instanceof HTMLElement) {
                  const details = event.target.closest('details')
                  if (details) {
                    details.open = true
                  }
                }
              }}>
                <label>
                  Quiz title
                  <input
                    value={title}
                    disabled={editorIsDisabled}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>

                <label>
                  Description
                  <textarea
                    value={description}
                    disabled={editorIsDisabled}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={3}
                  />
                </label>

                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={revealAnswers}
                    disabled={editorIsDisabled}
                    onChange={(event) => setRevealAnswers(event.target.checked)}
                  />
                  Reveal the correct answer, summary, and stats when time expires
                </label>
                <p className="help-text">
                  When enabled, the answer stays on screen until the admin advances.
                  When disabled, answers stay hidden and the admin advances as before.
                </p>
                <label className="checkbox-label">
                  <input type="checkbox" checked={displayStats} disabled={editorIsDisabled}
                    onChange={(event) => setDisplayStats(event.target.checked)} />
                  Allow players to view completed quiz stats
                </label>
                <p className="help-text">Anyone with a completed run's event code can view its leaderboard, answer keys, summaries, and question stats while this quiz is published.</p>

                {draftQuestions.map((question, questionIndex) => (
                  <details key={question.id} className="question-card question-editor"
                    open={!collapsedQuestionIds.includes(question.id)}
                    onToggle={(event) => {
                      const isOpen = event.currentTarget.open
                      setCollapsedQuestionIds((current) => isOpen
                        ? current.filter((id) => id !== question.id)
                        : current.includes(question.id) ? current : [...current, question.id])
                    }}>
                    <summary>
                      <span className="question-editor-title">Question {questionIndex + 1}: {question.prompt.trim() || 'New question'}</span>
                    </summary>
                    <fieldset disabled={editorIsDisabled}>
                    <legend className="sr-only">Question {questionIndex + 1}</legend>
                    <label>
                      Prompt
                      <input
                        value={question.prompt}
                        disabled={editorIsDisabled}
                        onChange={(event) =>
                          updateQuestion(questionIndex, { prompt: event.target.value })
                        }
                      />
                    </label>

                    <label>
                      Answer time (seconds, minimum 20)
                      <input
                        type="number"
                        min={20}
                        step={1}
                        required
                        value={Number.isNaN(question.answerSeconds) ? '' : question.answerSeconds}
                        onChange={(event) =>
                          updateQuestion(questionIndex, { answerSeconds: event.target.valueAsNumber })
                        }
                      />
                    </label>
                    <div className="question-images-editor">
                      {(['imageUrl', 'afterImageUrl'] as const).map((field) => {
                        const phase = field === 'imageUrl' ? 'Before' : 'After'
                        const value = question[field]
                        const overridden = field === 'afterImageUrl' && question.reuseBeforeImage
                        return (
                          <section className={`image-editor-slot${overridden ? ' is-overridden' : ''}`} key={field} aria-label={`${phase} answer reveal image`}>
                            <h3>{phase} answer reveal</h3>
                            {field === 'afterImageUrl' && question.imageUrl.trim() && (
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={question.reuseBeforeImage}
                                  disabled={pendingUploads > 0}
                                  onChange={(event) => updateQuestion(questionIndex, { reuseBeforeImage: event.target.checked })}
                                />
                                Use before picture after reveal
                              </label>
                            )}
                            {overridden && <p className="help-text">Before picture will be used instead</p>}
                            <fieldset className="image-editor-fields" disabled={overridden}>
                              <legend className="sr-only">{phase} image settings</legend>
                            <label>
                              {phase} image URL (optional)
                              <input
                                type="url"
                                value={value.startsWith('data:') ? '' : value}
                                placeholder={value.startsWith('data:') ? 'Uploaded image attached; paste a URL to replace it' : 'https://example.com/picture.png'}
                                onChange={(event) => updateQuestion(questionIndex, { [field]: event.target.value })}
                              />
                            </label>
                            <label>
                              Upload {phase.toLowerCase()} picture (optional, maximum 2 MB)
                              <input
                                type="file"
                                accept="image/png,image/jpeg,image/gif,image/webp"
                                onChange={(event) => {
                                  const file = event.currentTarget.files?.[0]
                                  event.currentTarget.value = ''
                                  if (file) {
                                    void addQuestionImage(question.id, field, file)
                                  }
                                }}
                              />
                            </label>
                            <QuestionImage key={value} src={value} />
                            {value && (
                              <button type="button" className="secondary-button"
                                onClick={() => updateQuestion(questionIndex, { [field]: '' })}>
                                Remove {phase.toLowerCase()} picture
                              </button>
                            )}
                            </fieldset>
                          </section>
                        )
                      })}
                    </div>
                    <div className="button-row image-swap-row">
                      <button type="button" className="secondary-button"
                        disabled={pendingUploads > 0 || (!question.imageUrl && !question.afterImageUrl)}
                        onClick={() => updateQuestion(questionIndex, {
                          imageUrl: question.afterImageUrl, afterImageUrl: question.imageUrl,
                        })}>
                        Swap before / after images
                      </button>
                    </div>
                    <p className="help-text">After images appear only when the answer is revealed. Swapping also moves a single image into the other slot.</p>
                    <label>
                      Post-question summary (optional)
                      <textarea
                        value={question.explanation}
                        rows={3}
                        onChange={(event) => updateQuestion(questionIndex, { explanation: event.target.value })}
                      />
                    </label>
                    <p className="help-text">Shown with the correct answer when answer reveal is enabled.</p>

                    <div className="answers-grid">
                      {question.options.map((option, optionIndex) => (
                        <div key={optionIndex}>
                          <label htmlFor={`answer-${question.id}-${optionIndex}`}>Answer {String.fromCharCode(65 + optionIndex)}</label>
                          <div className={`answer-input-control${question.correctOptionIndex === optionIndex ? ' is-correct' : ''}`}>
                            <input
                              id={`answer-${question.id}-${optionIndex}`}
                              className="answer-text-input"
                              value={option}
                              disabled={editorIsDisabled}
                              onChange={(event) =>
                                updateOption(questionIndex, optionIndex, event.target.value)
                              }
                            />
                            <label className="correct-answer-control" title={`Mark answer ${String.fromCharCode(65 + optionIndex)} as correct`}>
                              <input
                                type="radio"
                                name={`correct-${question.id}`}
                                disabled={editorIsDisabled}
                                checked={question.correctOptionIndex === optionIndex}
                                onChange={() =>
                                  updateQuestion(questionIndex, { correctOptionIndex: optionIndex })
                                }
                                aria-label={`Mark answer ${String.fromCharCode(65 + optionIndex)} as correct`}
                              />
                              <span className="sr-only">Correct answer</span>
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>

                    {draftQuestions.length > 1 && (
                      <button
                        type="button"
                        className="danger-button"
                        disabled={editorIsDisabled}
                        onClick={() => {
                          if (!window.confirm(`Remove question ${questionIndex + 1}? This cannot be undone in the editor.`)) {
                            return
                          }
                          setDraftQuestions((currentQuestions) =>
                            currentQuestions.filter((entry) => entry.id !== question.id),
                          )
                          setCollapsedQuestionIds((current) => current.filter((id) => id !== question.id))
                        }}
                      >
                        Remove question
                      </button>
                    )}
                    </fieldset>
                  </details>
                ))}

                <div className="button-row">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={editorIsDisabled}
                    onClick={() =>
                      setDraftQuestions((questions) => [...questions, emptyQuestion()])
                    }
                  >
                    Add question
                  </button>
                  {!editingQuiz?.isPublished && (
                    <button type="submit" value="draft" className="secondary-button" disabled={editorIsDisabled || pendingUploads > 0}>Save draft</button>
                  )}
                  <button type="submit" value="publish" disabled={editorIsDisabled || pendingUploads > 0}>
                    {isSaving ? 'Saving...' : editingQuiz?.isPublished ? 'Save changes' : 'Publish quiz'}
                  </button>
                </div>
              </form>
              </>
              ) : selectedAdminQuiz ? (
              <>
              <div className="admin-heading">
                <div>
                  <p className="eyebrow">Live controls</p>
                  <h2>{selectedAdminQuiz.title}</h2>
                </div>
                <div className="button-row">
                  <button type="button" className="secondary-button" disabled={isLiveBusy || isSaving} onClick={() => void showLibrary()}>Back to quizzes</button>
                  <button type="button" className="secondary-button" disabled={isLiveBusy || isSaving} onClick={lockAdmin}>Lock</button>
                </div>
              </div>
              <section className="live-controls">
                <div className="button-row">
                  {liveSession?.quizId === selectedAdminQuiz.id && !liveIsActive && (
                  <button
                    type="button"
                    disabled={isLiveBusy || isSaving || !selectedAdminQuiz.isPublished}
                    onClick={() => void startLiveQuiz()}
                  >
                    Start quiz
                  </button>
                  )}
                  {liveIsActive && (
                    <button type="button" className="danger-button" disabled={isLiveBusy || isSaving} onClick={() => void abortLiveQuiz()}>Abort run</button>
                  )}
                  {liveIsActive && liveSession?.joinCode && (
                    <a className="button-link secondary-button" href={`/?display=${liveSession.joinCode}`} target="_blank" rel="noopener noreferrer">Display Join Now</a>
                  )}
                </div>
                {!selectedAdminQuiz.isPublished && <p className="status-message">This quiz is unpublished and hidden from the home page. Publish it to start a new run.</p>}
                {liveIsActive && liveSession?.joinCode && <p>Join code: <strong className="inline-join-code">{liveSession.joinCode}</strong></p>}
                {liveSession?.quizId === selectedAdminQuiz.id && liveSession.status === 'holding' && (
                  <article className="quiz-summary hold-screen" role="status">
                    <h3>Quiz ready to begin</h3>
                    <p>Display Join Now while players join. No question is displayed and no timer is running.</p>
                    <p>Select Begin first question when everyone is ready.</p>
                  </article>
                )}
                {liveSession && liveSession.quizId === selectedAdminQuiz.id && (
                  <>
                  <div className="stat-cards">
                    <div className="metric-card"><span>Status</span><strong>{liveSession.status}</strong></div>
                    <div className="metric-card"><span>Question</span><strong>
                      {liveSession.status === 'holding'
                        ? 'No questions started'
                        : `${Math.min(liveSession.currentQuestionIndex + 1, liveSession.totalQuestions)} of ${liveSession.totalQuestions}`}
                    </strong></div>
                    <div className="metric-card"><span>Participating players</span><strong>{liveSession.playerCount}</strong></div>
                    <div className="metric-card"><span>Answered</span><strong>
                      {liveSession.submittedAnswerCount}/{liveSession.playerCount} answered
                    </strong></div>
                  </div>
                  <div className={`countdown-bar ${timerWarningClass}`} role="progressbar" aria-label="Question time remaining"
                    aria-valuemin={0} aria-valuemax={liveSession.answerSeconds}
                    aria-valuenow={remainingSeconds}
                    aria-valuetext={liveSession.status === 'running' ? `${remainingSeconds} seconds remaining` : 'No timer running'}>
                    <span className="countdown-fill" style={{ width: `${countdownProgress}%` }} aria-hidden="true" />
                    <strong>{liveSession.status === 'holding'
                      ? 'Holding - no timer running'
                      : liveSession.status === 'revealing'
                      ? 'Answer revealed - waiting for admin'
                      : liveSession.status === 'running'
                        ? remainingSeconds > 0 ? `${remainingSeconds}s accepting answers` : 'Time is up'
                        : 'Not accepting answers'}</strong>
                  </div>
                  </>
                )}
                <div className="button-row question-advance-actions">
                  <button
                    type="button"
                    disabled={isLiveBusy || liveSession?.quizId !== selectedAdminQuiz.id || !activeLiveStatuses.includes(liveSession?.status ?? 'idle')}
                    onClick={() => void advanceLiveQuiz()}
                  >
                    {liveSession?.status === 'holding'
                      ? 'Begin first question'
                      : liveSession?.status === 'running' && liveSession.revealAnswers
                        ? 'Reveal answer now'
                        : liveSession && liveSession.currentQuestionIndex + 1 >= liveSession.totalQuestions
                          ? 'Finish quiz' : 'Next question'}
                  </button>
                </div>
                {liveSession?.quizId === selectedAdminQuiz.id && (
                  <section className="player-roster" aria-label="Active players">
                    <h3 aria-live="polite">Active players ({liveSession.activePlayerCount})</h3>
                    <p className="help-text">
                      Waiting players join automatically when you start. Names disappear when players leave or stop sending updates for 90 seconds.
                    </p>
                    {liveSession.activePlayers?.length ? (
                      <ul className="player-roster-list">
                        {liveSession.activePlayers.map((player) => (
                          <li key={player.playerId}>
                            <strong>{player.playerName}</strong>
                            <span>{player.waiting ? 'Waiting to start' : 'In this run'}</span>
                          </li>
                        ))}
                      </ul>
                    ) : <p>No players are currently joined. Players can select this quiz and click Join quiz before you start.</p>}
                  </section>
                )}
                {liveSession?.currentQuestion && liveSession.quizId === selectedAdminQuiz.id && ['running', 'revealing'].includes(liveSession.status) && (
                  <article className="question-card active-question">
                    <h3>{liveSession.currentQuestion.prompt}</h3>
                    <QuestionImage key={liveSession.currentQuestion.imageUrl} src={liveSession.currentQuestion.imageUrl} />
                    {liveSession.reveal ? <AnswerSummary session={liveSession} /> : (
                      <ol className="lettered-answers" type="A">{liveSession.currentQuestion.options.map((option, index) => <li key={index}>{option}</li>)}</ol>
                    )}
                  </article>
                )}
              </section>
              <section className="run-history">
                <h3>Run history</h3>
                {runsLoading ? <p>Loading saved runs...</p> : runsError ? <p role="alert" className="status-message">{runsError}</p> : runs.length ? (
                  <>
                    <label>Saved run
                      <select value={selectedRun?.id ?? ''} onChange={(event) => setSelectedRunId(event.target.value)}>
                        {runs.map((run, index) => (
                          <option value={run.id} key={run.id}>
                            {run.endedAt ? new Date(run.endedAt).toLocaleString() : `Imported run ${index + 1}`} - {run.status}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selectedRun && <RunStatistics run={selectedRun} />}
                  </>
                ) : <p>No completed or aborted runs yet.</p>}
              </section>
              <section className="quiz-actions">
                <label className="checkbox-label">
                  <input type="checkbox" checked={selectedAdminQuiz.displayStats} disabled={isSaving}
                    onChange={(event) => void changeStatsDisplay(selectedAdminQuiz, event.target.checked)} />
                  Allow players to view completed quiz stats
                </label>
                <p className="help-text">
                  Anyone with an original completed event code can view that run's leaderboard, answer keys, summaries, and question stats.
                  Disabling this option or unpublishing the quiz hides them. Aborted runs are never shared.
                </p>
                {selectedAdminQuiz.hasRun && <p className="help-text">This quiz has already been run. Editing is locked; copy it to make changes without affecting the original or its scores.</p>}
                <div className="button-row">
                  <button type="button" className="secondary-button" disabled={selectedAdminQuiz.hasRun || isSaving || isLiveBusy} onClick={() => void editQuiz(selectedAdminQuiz.id)}>Edit quiz</button>
                  <button type="button" className="secondary-button" disabled={isSaving || isLiveBusy} onClick={() => void copyQuiz(selectedAdminQuiz.id)}>Copy to new quiz</button>
                  <button type="button" className="secondary-button" disabled={isSaving || isLiveBusy} onClick={() => void exportQuiz(selectedAdminQuiz.id)}>Export quiz</button>
                  <button type="button" className="secondary-button" disabled={isSaving || isLiveBusy || liveIsActive} onClick={() => void changePublication(selectedAdminQuiz)}>{selectedAdminQuiz.isPublished ? 'Unpublish' : 'Publish'}</button>
                </div>
              </section>
              </>
              ) : null}
              {formMessage && <p className="status-message" role="status">{formMessage}</p>}
              </section>
            ) : (
              <section className="panel">
              <div className="panel-heading">
                <p className="eyebrow">Players</p>
                <h2>Join a live quiz</h2>
              </div>

              {!activeQuiz ? (
                <>
                <form onSubmit={(event) => void findQuizByCode(event)} className="join-code-form" noValidate>
                  <label>6-digit event code
                    <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={joinCodeInput} disabled={isJoining}
                      onChange={(event) => {
                        setJoinCodeInput(event.target.value)
                        setJoinTarget(null)
                        setPlayMessage('')
                        setPlayError('')
                        window.history.replaceState({}, '', '/')
                      }} autoComplete="off" />
                  </label>
                  <button type="submit" disabled={isJoining}>Find quiz</button>
                </form>
                {joinTarget?.kind === 'completed' ? (
                  <section aria-label="Completed quiz stats">
                    <h2>{joinTarget.run.results?.quizTitle ?? joinTarget.quiz.title}</h2>
                    <RunStatistics run={joinTarget.run} />
                  </section>
                ) : joinTarget?.kind === 'live' && (
                <form onSubmit={joinQuiz} className="stack">
                  <label>
                    Player name
                    <input
                      className="player-name-input"
                      placeholder="Enter your name"
                      disabled={isJoining}
                      value={playerName}
                      onChange={(event) => setPlayerName(event.target.value)}
                    />
                  </label>

                    <article className="quiz-summary">
                      <h3>{joinTarget.quiz.title}</h3>
                      <p>{joinTarget.quiz.description || 'No description provided.'}</p>
                      <span>{joinTarget.quiz.questions.length} questions</span>
                      <div className="phone-handoff">
                        <h3 className="qr-heading">Play on your phone</h3>
                        <JoinQr url={playerUrl(siteSettings?.playerBaseUrl ?? '', joinTarget.joinCode)} />
                      </div>
                    </article>

                  <button type="submit" disabled={isJoining}>
                    Join quiz
                  </button>
                </form>
                )}
                </>
              ) : (
                <div className="stack">
                  <div className="player-heading">
                    <div>
                      <p className="eyebrow">Playing as {activeQuiz.playerName}</p>
                      <h3>{activeQuiz.quiz.title}</h3>
                    </div>
                    <button
                      type="button"
                      className="secondary-button leave-quiz-button"
                      disabled={isJoining}
                      onClick={() => void leaveQuiz()}
                    >
                      Leave quiz
                    </button>
                  </div>

                  {liveSession && ['running', 'revealing'].includes(liveSession.status) && liveSession.currentQuestion ? (
                    <fieldset className="question-card active-question">
                      <legend>
                        Question {liveSession.currentQuestionIndex + 1} of{' '}
                        {liveSession.totalQuestions}
                      </legend>
                      <div className={`timer-pill ${timerWarningClass}`}>
                        {liveSession.status === 'revealing'
                          ? 'Answer revealed'
                          : remainingSeconds > 0
                          ? `${remainingSeconds}s left`
                          : 'Time is up. Wait for the admin.'}
                      </div>
                      <h3>{liveSession.currentQuestion.prompt}</h3>
                      <QuestionImage key={liveSession.currentQuestion.imageUrl} src={liveSession.currentQuestion.imageUrl} />
                      <AnswerSummary session={liveSession} playerView />
                      {liveSession.reveal && <h3>Your answer</h3>}
                      <ol className="option-list" type="A">
                        {liveSession.currentQuestion.options.map((option, optionIndex) => (
                          <li key={`${liveSession.currentQuestion?.id}-${optionIndex}`}>
                          <span className="answer-letter" aria-hidden="true">{String.fromCharCode(65 + optionIndex)}.</span>
                          <label className={liveSession.reveal
                            ? liveSession.reveal.correctOptionIndex === optionIndex ? 'correct-option'
                              : liveSession.playerAnswer === optionIndex ? 'incorrect-option' : undefined
                            : undefined}>
                            <input
                              type="radio"
                              name={liveSession.currentQuestion?.id}
                              disabled={questionIsLocked}
                              checked={liveSession.playerAnswer === optionIndex}
                              onChange={() => void submitLiveAnswer(optionIndex)}
                            />
                            <span className="option-text">{option}</span>
                          </label>
                          </li>
                        ))}
                      </ol>
                    </fieldset>
                  ) : liveSession?.status === 'holding' ? (
                    <article className="quiz-summary hold-screen" role="status">
                      <h3>The quiz is about to start</h3>
                      <p>You are joined. The first question will appear when the admin begins.</p>
                    </article>
                  ) : liveSession?.status === 'finished' ? (
                    <FinalLeaderboard key={liveSession.runId} session={liveSession} playerId={activeQuiz.playerId} title={activeQuiz.quiz.title} />
                  ) : liveSession?.status === 'aborted' ? (
                    <article className="quiz-summary" role="status">
                      <h3>Quiz run aborted</h3>
                      <p>The admin stopped this run. Partial statistics were saved, but no completed scores were posted. Leave and rejoin to play a new run.</p>
                    </article>
                  ) : (
                    <article className="quiz-summary">
                      <h3>Waiting for the admin</h3>
                      <p>The next question will appear here when the admin starts or advances.</p>
                    </article>
                  )}

                </div>
              )}

              {playError ? <p className="error-message" role="alert">{playError}</p>
                : playMessage && <p className="status-message" role="status">{playMessage}</p>}
              </section>
            )}
          </div>

          {activeSection === 'home' && (
            <section className="panel full-width">
              <div className="panel-heading">
                <p className="eyebrow">Results</p>
                <h2>Recent leaderboard</h2>
              </div>

              {leaderboard.length === 0 ? (
                <p>No one has completed a quiz yet.</p>
              ) : (
                <div className="results-list">
                  {leaderboard.map((attempt) => (
                    <article key={attempt.id} className="result-card">
                      <div>
                        <strong>{attempt.playerName}</strong>
                        <span>{attempt.quizTitle}</span>
                      </div>
                      <strong>
                        {attempt.score}/{attempt.totalQuestions}
                      </strong>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

        </>
      )}
    </main>
  )
}

export default App
