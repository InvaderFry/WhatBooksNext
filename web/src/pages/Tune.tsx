import { useEffect, useState } from 'react';
import { api, type TasteStrength, type Tune as TuneData, type WeightKey } from '../api.ts';
import { Notice } from '../components.tsx';
import { hrefFor, onLinkClick } from '../url.ts';

/**
 * Tune (PLAN.md §13.7, §13.11): the ranking weights with plain explanations and a Reset, the
 * taste strength, and what taste has learned so far. Topic interests are in Settings.
 */

const STRENGTHS: { id: TasteStrength; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'High' },
];

export function Tune() {
  const [data, setData] = useState<TuneData | null>(null);
  const [draft, setDraft] = useState<Record<WeightKey, number> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const t = await api.get<TuneData>('/api/tune');
    setData(t);
    setDraft(t.weights);
  };
  useEffect(() => {
    void load();
  }, []);

  if (!data || !draft) return <div className="page narrow" />;
  const keys = Object.keys(data.defaults) as WeightKey[];
  const changed = keys.some((k) => draft[k] !== data.weights[k]);
  const custom = keys.some((k) => data.weights[k] !== data.defaults[k]);
  const t = data.taste;

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Tune</h1>
        <p className="muted">
          How much each part counts in Read next and the other ranked lists. Unknown data always
          counts as average, whatever the weight.
        </p>
      </div>
      <div className="visually-hidden" aria-live="polite">
        {message}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      <section className="section" aria-labelledby="weights-h">
        <h2 id="weights-h">Weights</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.put('/api/tune', { weights: draft });
              setMessage('Weights saved.');
              setError(null);
              await load();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <div className="tune-weights">
            {keys.map((k) => (
              <div key={k} className="tune-weight">
                <label htmlFor={`w-${k}`}>
                  <span>{data.explain[k].label}</span>
                  <span>
                    {draft[k].toFixed(2)}
                    {draft[k] !== data.defaults[k] && (
                      <span className="muted small">
                        {' '}
                        (starts at {data.defaults[k].toFixed(2)})
                      </span>
                    )}
                  </span>
                </label>
                <input
                  id={`w-${k}`}
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft[k]}
                  aria-describedby={`w-${k}-help`}
                  onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
                />
                <p id={`w-${k}-help`} className="muted small">
                  {data.explain[k].explain}
                </p>
              </div>
            ))}
          </div>
          <div className="row-actions wrap">
            <button type="submit" disabled={!changed}>
              Save weights
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!custom && !changed}
              onClick={async () => {
                await api.post('/api/tune/reset');
                setMessage('Weights reset to their starting values.');
                await load();
              }}
            >
              Reset
            </button>
          </div>
        </form>
      </section>

      <section className="section" aria-labelledby="taste-h">
        <h2 id="taste-h">Taste learning</h2>
        <p>
          Learns from genres, authors, comic artists, publishers and kinds that stand out in what
          you rate highly or finish. A “Did not finish — Not for me” counts against; other reasons
          don’t. One series counts as at most two books.
        </p>
        <p className="muted">
          It tends to suggest more of what you already read. Turn it down or off if picks start to
          feel samey.
        </p>
        <fieldset className="segmented">
          <legend>Strength</legend>
          {STRENGTHS.map((s) => (
            <label key={s.id} className={data.strength === s.id ? 'on' : ''}>
              <input
                type="radio"
                name="strength"
                value={s.id}
                checked={data.strength === s.id}
                onChange={async () => {
                  await api.put('/api/tune', { strength: s.id });
                  setMessage(`Taste learning: ${s.label}.`);
                  await load();
                }}
              />
              {s.label}
            </label>
          ))}
        </fieldset>
        {!t.active ? (
          <Notice>
            Not on yet: it needs {t.threshold} books you’ve rated, finished or stopped as “Not for
            me”, from at least {t.minGroups} different authors or series. So far: {t.outcomes} from{' '}
            {t.groups}. Until then it changes nothing.
          </Notice>
        ) : (
          <>
            <p>
              Learning from {t.outcomes} books by {t.groups} different authors or series
              {data.strength === 'off' ? ' — but it’s switched off, so it changes nothing.' : '.'}
            </p>
            {t.likes.length > 0 && (
              <>
                <h3>What it has learned you like</h3>
                <ul>
                  {t.likes.map((s) => (
                    <li key={s.key}>
                      {s.text} <span className="muted small">({s.evidence} books)</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {t.dislikes.length > 0 && (
              <>
                <h3>And what you like less</h3>
                <ul>
                  {t.dislikes.map((s) => (
                    <li key={s.key}>
                      {s.text} <span className="muted small">({s.evidence} books)</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {t.likes.length + t.dislikes.length === 0 && (
              <p className="muted">Nothing stands out from your average yet.</p>
            )}
          </>
        )}
      </section>

      <p>
        <a href={hrefFor({ view: 'next' })} onClick={onLinkClick({ view: 'next' })}>
          Back to What next
        </a>
      </p>
    </div>
  );
}

/** Topic interests: what the owner wants to learn about (Learn, Still relevant?, the Topic filter). */
export function TopicsSection() {
  const [topics, setTopics] = useState<string[] | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.get<{ topics: string[] }>('/api/settings/topics').then((r) => setTopics(r.topics));
  }, []);
  const save = async (next: string[]) => {
    try {
      setTopics(
        (await api.put<{ topics: string[] }>('/api/settings/topics', { topics: next })).topics,
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="section" aria-labelledby="topics-h">
      <h2 id="topics-h">Topic interests</h2>
      <p className="muted">
        Subjects you want to read about, like “Rust” or “gardening”. What next can show just one
        topic (reference books included), and Still relevant? puts tech books outside them first.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {topics && topics.length > 0 && (
        <ul className="chips" aria-label="Your topics">
          {topics.map((t) => (
            <li key={t}>
              {t}{' '}
              <button
                type="button"
                className="link-button"
                aria-label={`Remove ${t}`}
                onClick={() => void save(topics.filter((x) => x !== t))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() || !topics) return;
          void save([...topics, text]);
          setText('');
        }}
      >
        <label htmlFor="topic-new">Add a topic</label>
        <input
          id="topic-new"
          value={text}
          maxLength={40}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="small">
          Add
        </button>
      </form>
    </section>
  );
}
