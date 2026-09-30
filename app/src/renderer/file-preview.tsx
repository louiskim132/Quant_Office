import React from 'react';
import { previewCsv } from './preview-data';
export type FilePreview = { name: string; text: string; truncated: boolean; binary: boolean };
/** Text is rendered as React text, never HTML from an agent or imported file. */
export function FilePreviewPane({
  preview,
  loading,
  onOpen,
}: {
  preview: FilePreview | null;
  loading: boolean;
  onOpen?: () => void;
}) {
  const csv = preview && /\.csv$/i.test(preview.name) && !preview.binary ? previewCsv(preview.text) : null;
  return (
    <aside className="file-preview" aria-label="File preview" aria-busy={loading}>
      <div className="card-heading">
        <h3>{preview?.name.split(/[\\/]/).pop() ?? 'Preview'}</h3>
        {preview && onOpen && (
          <button className="text-button" onClick={onOpen}>
            Open full preview
          </button>
        )}
      </div>
      {loading ? (
        <p role="status">Loading preview…</p>
      ) : !preview ? (
        <p className="muted">Select a file to read its stored contents.</p>
      ) : preview.binary ? (
        <p className="muted">Binary file — a text preview is unavailable.</p>
      ) : csv ? (
        <div className="table-wrap">
          <p className="muted">
            {Math.max(0, csv.rows.length - 1)} preview rows{csv.truncated ? ' · limited to 200 lines' : ''} · first 20
            columns
          </p>
          <table>
            <thead>
              <tr>
                {csv.rows[0]?.slice(0, 20).map((cell, i) => (
                  <th key={i}>{cell}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {csv.rows.slice(1).map((row, i) => (
                <tr key={i}>
                  {row.slice(0, 20).map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : /\.md$/i.test(preview.name) ? (
        <div className="markdown-preview">
          {preview.text.split('\n').map((line, i) => {
            const heading = /^(#{1,3})\s+(.+)$/.exec(line);
            return heading ? <h4 key={i}>{heading[2]}</h4> : <p key={i}>{line || '\u00a0'}</p>;
          })}
        </div>
      ) : (
        <pre>{preview.text}</pre>
      )}
      {preview?.truncated && (
        <p className="muted">Preview truncated. Export the project for the complete stored file.</p>
      )}
    </aside>
  );
}
