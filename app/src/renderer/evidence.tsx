import { useCallback, useState } from 'react';
import type { ObjectDescription, ReadResult, SearchMatch, SearchResult } from '../shared/evidence';

/**
 * Search across one agent's permitted evidence, with every result expandable to its exact source.
 *
 * The panel's job is to make two things impossible to miss: what was not covered, and where a quoted
 * line actually came from. A result that reads like a clean answer while four logs were unreadable is
 * the failure this view exists to prevent, so the warning is rendered before the matches, not after.
 */
export function EvidencePanel({ agentId, projectId }: { agentId: string; projectId: string }) {
  const [pattern, setPattern] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [expanded, setExpanded] = useState<{
    match: SearchMatch;
    description: ObjectDescription;
    read: ReadResult;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const search = useCallback(
    async (cursor?: string) => {
      setBusy(true);
      setError('');
      try {
        const page = await window.office.queryEvidence({
          agentId,
          projectId,
          pattern,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        setResult(current => (current && cursor ? { ...page, matches: [...current.matches, ...page.matches] } : page));
        if (!cursor) setExpanded(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [agentId, projectId, pattern],
  );

  // Expansion re-reads the object rather than showing a wider slice of the search result, so what is
  // displayed as the source is the stored bytes now, not a copy taken when the search ran.
  const expand = useCallback(
    async (match: SearchMatch) => {
      setBusy(true);
      setError('');
      try {
        const from = Math.max(match.line - 4, 1);
        const [description, read] = await Promise.all([
          window.office.describeObject({ agentId, objectHash: match.sha256 }),
          window.office.readObject({ agentId, objectHash: match.sha256, from, limit: 9 }),
        ]);
        setExpanded({ match, description, read });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [agentId],
  );

  return (
    <section className="evidence">
      <div className="section-toolbar">
        <input
          className="evidence-search"
          value={pattern}
          placeholder="Search permitted evidence"
          aria-label="Search permitted evidence"
          onChange={event => setPattern(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && pattern.trim()) void search();
          }}
        />
        <button className="secondary" disabled={busy || !pattern.trim()} onClick={() => void search()}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {result && result.coverage !== 'COMPLETE' && (
        <p className="notice warning" role="status">
          Incomplete coverage. {result.detail} Treat this result as a partial view, not as the absence of a finding.
        </p>
      )}
      {result && (
        <>
          <p className="muted">
            {result.returned} match{result.returned === 1 ? '' : 'es'} across {result.searchedObjects} readable object
            {result.searchedObjects === 1 ? '' : 's'}
            {result.omitted > 0 && ` · ${result.omitted} not returned`}
            {result.unreadableObjects.length > 0 && ` · unreadable: ${result.unreadableObjects.join(', ')}`}
          </p>
          <ul className="evidence-matches">
            {result.matches.map(match => (
              <li key={`${match.sha256}:${match.line}`}>
                <button className="link" onClick={() => void expand(match)}>
                  {match.name}:{match.line}
                </button>
                <code>{match.text}</code>
              </li>
            ))}
          </ul>
          {result.nextCursor && (
            <button className="secondary" disabled={busy} onClick={() => void search(result.nextCursor!)}>
              Load more matches
            </button>
          )}
          {!result.matches.length && result.coverage === 'COMPLETE' && (
            <p className="muted">No match, and every object in scope was read in full.</p>
          )}
        </>
      )}
      {expanded && (
        <article className="evidence-source">
          <div className="card-heading">
            <h3>{expanded.description.name}</h3>
            <span>
              lines {expanded.read.from}–{expanded.read.to}
            </span>
          </div>
          <p className="muted">
            {expanded.description.provenance} Attested {expanded.description.evidence}.
          </p>
          <pre>
            {expanded.read.lines.map((line, index) => {
              const number = expanded.read.from + index;
              return (
                <span key={number} className={number === expanded.match.line ? 'evidence-hit' : undefined}>
                  <span className="line-no">{number}</span>
                  {'  '}
                  {line}
                  {'\n'}
                </span>
              );
            })}
          </pre>
          <details>
            <summary>Object identity</summary>
            <code className="hash">{expanded.description.sha256}</code>
          </details>
        </article>
      )}
    </section>
  );
}
