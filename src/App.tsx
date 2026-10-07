import { useEffect, useState } from 'react';
import { addOperatorToShift, createShift, moveOperator, movedOnly, returnToStart, type ShiftState } from './lib/shifts';
import { exportShift, loadShift, saveShift } from './lib/storage';
import { filterOperators } from './lib/search';
import { AREA_ORDER, type Area, type BoardAnalysisResult, type Detection, type ImageQuality } from './types';
import { analyzeBoardPhoto } from './ocr/pipeline';
import { buildBoardDiagnostics, exportDiagnosticsJson } from './ocr/diagnostics';
import { DebugPanel } from './ocr/debug';
import { duplicates } from './lib/validation';
import { UnusableImageError } from './lib/image';
import { isAutomaticallyConfirmed, isReviewRequired } from './lib/board';
import './style.css';

const AREAS = AREA_ORDER.filter((area): area is Exclude<Area, 'UNKNOWN'> => area !== 'UNKNOWN');
const DEFAULT_ROSTER = ['NOVAK JAN', 'SVOBODA PETR', 'DVORAK MARTIN'];

type ReviewDraft = { name: string; area: Exclude<Area, 'UNKNOWN'> | '' };

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [roster, setRoster] = useState(DEFAULT_ROSTER.join('\n'));
  const [analysis, setAnalysis] = useState<BoardAnalysisResult | null>(null);
  const [shift, setShift] = useState<ShiftState | null>(loadShift);
  const [quality, setQuality] = useState<ImageQuality | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [overlayUrl, setOverlayUrl] = useState('');
  const [showOverlay, setShowOverlay] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('Připraveno');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [transportOnly, setTransportOnly] = useState(false);
  const [reviewDrafts, setReviewDrafts] = useState<Record<number, ReviewDraft>>({});
  const [resolvedRows, setResolvedRows] = useState<Set<number>>(() => new Set());
  const [reviewNotice, setReviewNotice] = useState('');

  useEffect(() => {
    saveShift(shift);
  }, [shift]);

  const rows = analysis?.detections ?? [];
  const duplicateNames = duplicates(rows);
  const confirmedOperators = (analysis?.assignedOperators ?? []).filter((operator) => isAutomaticallyConfirmed(operator, duplicateNames));
  const reviewRows = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) => isReviewRequired(row, duplicateNames) && !resolvedRows.has(index));
  const rosterNames = roster.split('\n').map((name) => name.trim()).filter(Boolean);
  const operatorCounts = shift
    ? AREAS.map((area) => [area, shift.operators.filter((operator) => operator.current === area).length] as const)
      .filter(([, count]) => count > 0)
    : [];
  const diagnostics = analysis
    ? buildBoardDiagnostics(
      [...new Set(rows.map((row) => row.area).filter((area) => area !== 'UNKNOWN'))],
      rows,
      analysis.assignedOperators,
      analysis.review,
      analysis.boardDetected
    )
    : null;

  const boardStatus = analysis ? (analysis.review.hasBlockingIssues ? 'Kontrola nutná' : 'Hotovo') : 'Čeká na snímek';
  const fleetLoad = shift ? Math.min(100, Math.round((shift.operators.length / Math.max(1, AREAS.length)) * 100)) : 0;
  const transportCount = analysis?.assignedOperators.filter((operator) => operator.area === 'TRANSPORT').length ?? 0;
  const reviewQueueSize = analysis?.review.blockingIssues.reduce((sum, issue) => sum + issue.count, 0) ?? 0;
  const riskLevel = reviewQueueSize === 0 ? 'Bezpečně' : reviewQueueSize <= 2 ? 'Střední' : 'Vysoké';

  async function loadPhoto(file: File): Promise<void> {
    setBusy(true);
    setProgress('Připravuji fotografii');
    setError('');
    setAnalysis(null);
    setQuality(null);
    setPreviewUrl('');
    setOverlayUrl('');
    setReviewDrafts({});
    setResolvedRows(new Set());
    setReviewNotice('');

    try {
      const result = await analyzeBoardPhoto(
        file,
        rosterNames,
        undefined,
        [],
        (current, total) => setProgress(`OCR ${Math.min(current + 1, total)} / ${total}`)
      );
      setAnalysis(result);
      setQuality(result.imageQuality ?? null);
      setPreviewUrl(result.imageUrl ?? '');
      setOverlayUrl(result.overlayUrl ?? '');
      setProgress('Analýza dokončena');
    } catch (caught) {
      if (caught instanceof UnusableImageError) {
        setQuality(caught.quality);
        setPreviewUrl(caught.previewUrl ?? '');
        setOverlayUrl(caught.overlayUrl ?? '');
        setError(caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : 'Analýza fotografie selhala.');
      }
      setProgress('Analýza zastavena');
    } finally {
      setBusy(false);
    }
  }

  function startShift(): void {
    if (confirmedOperators.length === 0) return;
    setShift(createShift(confirmedOperators.map(({ name, area }) => ({ name, area }))));
  }

  function updateReviewDraft(index: number, row: Detection, change: Partial<ReviewDraft>): void {
    const current = reviewDrafts[index] ?? {
      name: row.matched ?? '',
      area: row.area === 'UNKNOWN' ? '' : row.area,
    };
    setReviewDrafts((drafts) => ({ ...drafts, [index]: { ...current, ...change } }));
  }

  function resolveReview(index: number, row: Detection, include: boolean): void {
    if (include) {
      const draft = reviewDrafts[index] ?? {
        name: row.matched ?? '',
        area: row.area === 'UNKNOWN' ? '' : row.area,
      };
      if (!draft.name || !draft.area) {
        setReviewNotice('Vyberte zaměstnance i pracoviště.');
        return;
      }
      const selectedArea = draft.area;
      if (shift?.operators.some((operator) => operator.name === draft.name)) {
        setReviewNotice(`${draft.name} už ve směně je. Duplicitní nález můžete vyřadit.`);
        return;
      }
      setShift((current) => current ? addOperatorToShift(current, draft.name, selectedArea) : current);
    }

    setResolvedRows((resolved) => new Set(resolved).add(index));
    setReviewNotice(include ? 'Případ byl zkontrolován a přiřazen.' : 'Nález byl vyřazen ze směny.');
  }

  function endShift(): void {
    setShift(null);
    setAnalysis(null);
    setReviewDrafts({});
    setResolvedRows(new Set());
  }

  const reviewQueue = shift && (
    <section aria-labelledby="review-heading" className="panel">
      <div className="section-heading">
        <h2 id="review-heading">Případy ke kontrole</h2>
        <strong>{reviewRows.length}</strong>
      </div>
      {reviewRows.length === 0 ? <p className="muted">Všechny zachycené případy jsou vyřešené.</p> : (
        <div className="review-list">
          {reviewRows.map(({ row, index }) => {
            const draft = reviewDrafts[index] ?? {
              name: row.matched ?? '',
              area: row.area === 'UNKNOWN' ? AREAS[0] : row.area,
            };
            return (
              <article className="review-row" key={index}>
                <div className="review-source">
                  <strong>{row.raw || 'Bez čitelného textu'}</strong>
                  <span>{row.warning ?? `${Math.round(row.confidence * 100)}% confidence`}</span>
                </div>
                <label>
                  Zaměstnanec
                  <select value={draft.name} onChange={(event) => updateReviewDraft(index, row, { name: event.target.value })}>
                    <option value="">Vyberte jméno</option>
                    {rosterNames.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label>
                  Pracoviště
                  <select value={draft.area} onChange={(event) => updateReviewDraft(index, row, { area: event.target.value as ReviewDraft['area'] })}>
                    <option value="">Vyberte pracoviště</option>
                    {AREAS.map((area) => <option key={area} value={area}>{area}</option>)}
                  </select>
                </label>
                <div className="review-actions">
                  <button type="button" onClick={() => resolveReview(index, row, true)}>Potvrdit</button>
                  <button type="button" className="secondary" onClick={() => resolveReview(index, row, false)}>Vyřadit</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {reviewNotice && <p role="status" className="muted">{reviewNotice}</p>}
    </section>
  );

  return (
    <main className="zf-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">ZF</div>
          <div>
            <span className="eyebrow">Warehouse Ops</span>
            <h3>Team Lead Board</h3>
          </div>
        </div>
        <div className="status-wrap">
          <span className="status-pill">{analysis ? 'Live OCR' : 'Ready'}</span>
          <i aria-live="polite">{progress}</i>
        </div>
      </header>

      {!shift ? (
        <>
          <section className="hero panel">
            <div className="hero-copy">
              <span className="eyebrow accent">Operation control</span>
              <h1>Vyfoť tabuli. Ověř OCR. Spusť směnu.</h1>
              <p>Digitální nástroj pro team leada k rychlému přiřazení operativních OP a přesunů v skladu bez zbytečného manuálního přepínání.</p>
            </div>
            <div className="hero-actions">
              <label className="upload">
                Načíst fotografii
                <input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void loadPhoto(file);
                }} />
              </label>
              <div className="mini-card">
                <span>OCR status</span>
                <strong>{boardStatus}</strong>
              </div>
            </div>
          </section>

          <section className="summary-strip">
            <article className="summary-tile">
              <span>Detekce tabule</span>
              <strong>{analysis ? (analysis.boardDetected ? 'Ano' : 'Ne') : '—'}</strong>
            </article>
            <article className="summary-tile">
              <span>Transport</span>
              <strong>{transportCount}</strong>
            </article>
            <article className="summary-tile">
              <span>Případy ke kontrole</span>
              <strong>{reviewQueueSize}</strong>
            </article>
            <article className="summary-tile">
              <span>Riziko</span>
              <strong>{riskLevel}</strong>
            </article>
          </section>

          <div className="board-layout">
            <section className="panel">
              <div className="section-heading">
                <h2>Náhled tabule</h2>
                {previewUrl && <label className="toggle"><input type="checkbox" checked={showOverlay} onChange={(event) => setShowOverlay(event.target.checked)} /> Diagnostický overlay</label>}
              </div>
              {previewUrl ? <img className="board-image" src={showOverlay && overlayUrl ? overlayUrl : previewUrl} alt="Zpracovaný snímek směnové tabule" /> : <div className="empty">Zatím žádná fotografie</div>}
              {quality && <div className="quality-grid" aria-label="Kvalita fotografie">
                <span>Ostrost <b>{quality.blurScore.toFixed(2)}</b></span>
                <span>Kontrast <b>{quality.contrastScore.toFixed(2)}</b></span>
                <span>Jas <b>{quality.brightnessScore.toFixed(2)}</b></span>
                <strong className={quality.usable ? 'ok' : 'warn'}>{quality.usable ? 'Použitelný snímek' : 'OCR zastaveno'}</strong>
              </div>}
            </section>

            <section className="panel roster-panel">
              <h2>Seznam zaměstnanců</h2>
              <textarea aria-label="Seznam zaměstnanců" value={roster} onChange={(event) => setRoster(event.target.value)} disabled={busy || Boolean(analysis)} />
              <small>Jedno jméno na řádek. Zaměstnanec mimo seznam se automaticky nepotvrdí.</small>
            </section>
          </div>

          {error && <p className="error" role="alert">{error}</p>}

          {analysis && <>
            <section className="panel">
              <div className="section-heading"><h2>Výsledek OCR</h2><span>{rows.length} nálezů · {reviewRows.length} ke kontrole · {confirmedOperators.length} potvrzených</span></div>
              <div className="stats">
                <span>Preprocessing <b>{analysis.timingsMs?.preprocess.toFixed(0) ?? '–'} ms</b></span>
                <span>OCR <b>{analysis.timingsMs?.ocr.toFixed(0) ?? '–'} ms</b></span>
                <span>Celkem <b>{analysis.timingsMs?.analysis.toFixed(0) ?? '–'} ms</b></span>
              </div>
              <div className="results">
                {rows.map((row, index) => {
                  const uncertain = isReviewRequired(row, duplicateNames);
                  return <article className="result-row" key={index}>
                    <strong>{row.area}</strong>
                    <span>{row.matched ?? row.raw}</span>
                    <span className={uncertain ? 'warn' : 'ok'}>{uncertain ? row.warning ?? 'Vyžaduje kontrolu' : 'Potvrzeno'}</span>
                    <small>{Math.round(row.confidence * 100)}% · OCR {Math.round((row.ocrConfidence ?? 0) * 100)}% · shoda {Math.round((row.matchConfidence ?? 0) * 100)}% · oblast {Math.round((row.areaConfidence ?? 0) * 100)}%</small>
                  </article>;
                })}
              </div>
              <button type="button" disabled={confirmedOperators.length === 0 || busy} onClick={startShift}>
                Spustit směnu s {confirmedOperators.length} potvrzenými
              </button>
              {confirmedOperators.length === 0 && <p className="warn">Směnu nelze založit bez alespoň jednoho bezpečně potvrzeného zaměstnance.</p>}
            </section>
            <section className="debug-controls panel">
              <label className="toggle"><input type="checkbox" checked={showDiagnostics} onChange={(event) => setShowDiagnostics(event.target.checked)} /> Diagnostické údaje</label>
              {diagnostics && <button type="button" className="secondary" onClick={() => downloadBlob(exportDiagnosticsJson(diagnostics), 'ocr-diagnostics.json')}>Export diagnostiky JSON</button>}
              {showDiagnostics && <DebugPanel data={diagnostics} />}
            </section>
          </>}
        </>
      ) : (
        <>
          <section className="hero panel live-panel">
            <div className="hero-copy">
              <span className="eyebrow accent">Shift running</span>
              <h1>Živá směna</h1>
            </div>
            <div className="cards">
              {operatorCounts.map(([area, count]) => <div className={`card ${area === 'TRANSPORT' ? 'primary' : ''}`} key={area}><span>{area}</span><b>{count} OP</b></div>)}
              <div className="card">
                <span>Plnění</span>
                <b>{fleetLoad}%</b>
              </div>
            </div>
          </section>

          {reviewQueue}

          <section className="panel">
            <div className="section-heading"><h2>Přesuny zaměstnanců</h2><div>
              <button type="button" className="secondary" onClick={() => exportShift(shift)}>Export</button>
              <button type="button" className="secondary" onClick={endShift}>Ukončit směnu</button>
            </div></div>
            <div className="toolbar">
              <input aria-label="Hledat zaměstnance" placeholder="Hledat zaměstnance nebo pracoviště" value={query} onChange={(event) => setQuery(event.target.value)} />
              <label><input type="checkbox" checked={transportOnly} onChange={(event) => setTransportOnly(event.target.checked)} /> Jen Transport</label>
            </div>
            <div className="results">
              {filterOperators(shift.operators, query, transportOnly).map((operator) => <div className="move" key={operator.name}>
                <div><strong>{operator.name}</strong><small>Start: {operator.start} · Aktuálně: {operator.current}</small></div>
                <select aria-label={`Pracoviště ${operator.name}`} value={operator.current} onChange={(event) => setShift((current) => current ? moveOperator(current, operator.name, event.target.value as Area) : current)}>
                  {AREAS.map((area) => <option key={area} value={area}>{area}</option>)}
                </select>
                {operator.current !== operator.start && <button type="button" className="tiny" onClick={() => setShift((current) => current ? returnToStart(current, operator.name) : current)}>Vrátit</button>}
              </div>)}
            </div>
          </section>

          <section className="panel">
            <h2>Mimo startovní pozici <span className="pill">{movedOnly(shift).length}</span></h2>
            {movedOnly(shift).length === 0 ? <p className="muted">Nikdo zatím nebyl přesunut.</p> : movedOnly(shift).map((operator) => <div className="movement" key={operator.name}><b>{operator.name}</b><span>{operator.start} → {operator.current}</span></div>)}
            <h3>Historie</h3>
            {[...shift.movements].reverse().map((movement, index) => <div className="movement" key={`${movement.at}-${index}`}>
              <span>{new Date(movement.at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}</span>
              <b>{movement.person}</b><span>{movement.from} → {movement.to}</span>
            </div>)}
          </section>
        </>
      )}

      <footer>Experimentální provozní MVP. Nejisté OCR výsledky zůstávají oddělené od potvrzené směny.</footer>
    </main>
  );
}
