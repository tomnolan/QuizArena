import type { QuestionStats } from './Hosting'

export function QuestionStatsCards({ stats, playerCount }: { stats: QuestionStats; playerCount: number }) {
  const outcomes = [
    { label: 'Correct', count: stats.correctCount, className: 'correct' },
    { label: 'Incorrect', count: stats.incorrectCount, className: 'incorrect' },
    { label: 'Did not answer', count: stats.unansweredCount, className: 'unanswered' },
  ]
  const percentage = (count: number) => playerCount > 0 ? count / playerCount * 100 : 0
  return (
    <div className="question-stats-cards">
      <section className="question-stat-card" aria-label="Answer results">
        <h3>Answer results</h3>
        <div className="outcome-bar" role="img" aria-label={outcomes.map((outcome) =>
          `${outcome.label}: ${outcome.count} (${percentage(outcome.count).toFixed(1)}%)`,
        ).join(', ')}>
          {outcomes.map((outcome) => (
            <span key={outcome.className} className={`outcome-segment ${outcome.className}`}
              style={{ width: `${percentage(outcome.count)}%` }} aria-hidden="true">
              {percentage(outcome.count) >= 18 && <span>{outcome.count} ({percentage(outcome.count).toFixed(1)}%)</span>}
            </span>
          ))}
        </div>
        <ul className="outcome-legend">
          {outcomes.map((outcome) => (
            <li key={outcome.className}>
              <span className={`color-key ${outcome.className}`} aria-hidden="true" />
              <span>{outcome.label}</span>
              <strong>{outcome.count} ({percentage(outcome.count).toFixed(1)}%)</strong>
            </li>
          ))}
        </ul>
        {playerCount === 0 && <p className="help-text">No players joined this run.</p>}
      </section>
      <section className="question-stat-card" aria-label="Responses by answer">
        <h3>Responses by answer</h3>
        <p className="help-text">Scale: 0 to {playerCount} players</p>
        <ol className="answer-bars" type="A">
          {stats.options.map((option, index) => {
            const count = stats.optionCounts[index] ?? 0
            const isCorrect = index === stats.correctOptionIndex
            const label = `${String.fromCharCode(65 + index)}. ${option}${isCorrect ? ' (correct)' : ''}`
            return (
              <li key={index}>
                <span className="answer-bar-label" title={label}>{label}</span>
                <div className="answer-bar-track" role="meter"
                  aria-label={`${label}: ${count} of ${playerCount} players`}
                  aria-valuenow={count} aria-valuemin={0} aria-valuemax={playerCount}
                  aria-valuetext={`${count} of ${playerCount} players`}>
                  <span className={`answer-bar-fill${isCorrect ? ' correct' : ''}`}
                    style={{ width: `${percentage(count)}%` }} />
                  <strong>{count}</strong>
                </div>
              </li>
            )
          })}
        </ol>
        <div className="answer-axis" aria-hidden="true"><span>0</span><span>{playerCount}</span></div>
      </section>
      <section className="question-stat-card" aria-label="Fastest responses">
        <h3>Fastest responses</h3>
        {stats.fastestAnswers.length ? (
          <ol className="fastest-list">
            {stats.fastestAnswers.map((answer, index) => (
              <li key={index} className={answer.isCorrect ? 'correct-text' : 'incorrect-text'}>
                <strong>{answer.playerName}</strong> - {answer.responseSeconds.toFixed(2)}s
                {' '}({answer.isCorrect ? 'correct' : 'incorrect'})
              </li>
            ))}
          </ol>
        ) : <p className="help-text">No response times recorded.</p>}
      </section>
    </div>
  )
}
