import React from 'react';
import type { Snapshot } from '@shared/types';
import { api } from './api';
import { StudioView } from './studio/StudioView';
import { createCollector, aiToolDisplay, REFRESH_EVENT } from './ai/collector';
import { ActionQueue } from './panels/ActionQueue';
import { ModelPanel } from './panels/ModelPanel';
import { AuditPanel } from './panels/AuditPanel';
import { LensPanel } from './panels/LensPanel';
import { NewInvoice } from './panels/NewInvoice';
import { dayShort, pct, usd } from './format';

type Tab = 'queue' | 'lens' | 'model' | 'audit';

export function App() {
  const [snap, setSnap] = React.useState<Snapshot | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [view, setView] = React.useState<'dashboard' | 'collector' | 'studio'>('dashboard');
  const mode = view === 'dashboard' ? 'view' : 'edit';
  const [tab, setTab] = React.useState<Tab>('queue');
  const [selectedPayer, setSelectedPayer] = React.useState<string | null>(null);
  const [toastMsg, setToastMsg] = React.useState<{ msg: string; err: boolean } | null>(null);
  const [version, setVersion] = React.useState(0);
  const [llm, setLlm] = React.useState<{ configured: boolean; model: string | null } | null>(null);
  const [showNew, setShowNew] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const scenarioRef = React.useRef<string>('');

  const toast = React.useCallback((msg: string, isErr = false) => {
    setToastMsg({ msg, err: isErr });
    setTimeout(() => setToastMsg(null), isErr ? 7000 : 3800);
  }, []);

  const load = React.useCallback(async () => {
    try {
      const first = await api.snapshot(scenarioRef.current ? scenarioRef.current.split(',') : []);
      const pending = first.proposals.filter((p) => p.status === 'pending').map((p) => p.invoiceId).sort();
      const sig = pending.join(',');
      if (sig !== scenarioRef.current) {
        scenarioRef.current = sig;
        setSnap(await api.snapshot(pending));
      } else {
        setSnap(first);
      }
      setVersion((v) => v + 1);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }, []);

  React.useEffect(() => {
    load();
    api.llmStatus().then(setLlm).catch(() => setLlm({ configured: false, model: null }));
    const t = setInterval(load, 20_000);
    const h = () => load();
    window.addEventListener(REFRESH_EVENT, h);
    return () => { clearInterval(t); window.removeEventListener(REFRESH_EVENT, h); };
  }, [load]);

  const ai = React.useMemo(() => (llm ? createCollector(llm.configured) : undefined), [llm]);
  const bridge = React.useMemo(() => ({ selectedPayer, onSelectPayer: (id: string | null) => { setSelectedPayer(id); if (id) setTab('lens'); } }), [selectedPayer]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(String((e as Error).message ?? e), true);
    } finally {
      setBusy(false);
      load();
    }
  };

  if (err && !snap) return <div style={{ padding: 28 }}><h3>Could not reach the Tidewater API</h3><p style={{ color: 'var(--muted)' }}>{err}</p><button className="tw-btn" onClick={load}>Retry</button></div>;
  if (!snap || !ai) return <div style={{ padding: 28, color: 'var(--muted)' }}>Loading the ledger…</div>;

  const m = snap.mode;
  const pendingCount = snap.proposals.filter((p) => p.status === 'pending').length;
  const sim = m.paypal === 'simulator';

  return (
    <div className="tw-shell">
      <header className="tw-top">
        <div className="tw-brand">
          <svg width="26" height="26" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0b1a2b" /><path d="M3 19c4-7 7-7 11 0s7 7 15-2" fill="none" stroke="#2dd4bf" strokeWidth="3" strokeLinecap="round" /></svg>
          <span>Tidewater</span><small>receivables forecasting for PayPal invoices</small>
        </div>
        <div className="tw-badges">
          <span className={`tw-badge ${sim ? 'warn' : 'ok'}`} title={sim ? 'No PayPal sandbox credentials configured: an in-process simulator stands in for PayPal.' : 'Connected to the PayPal sandbox'}><i />{sim ? 'PayPal simulator' : 'PayPal sandbox'}</span>
          {m.syntheticHistory && <span className="tw-badge synthetic" title="History is generated, not real customer data.">{pct(snap.model.syntheticShare)} synthetic data</span>}
          <span className={`tw-badge ${m.llm === 'configured' ? 'ok' : ''}`} title={m.llm === 'configured' ? 'Collector runs on the configured LLM' : 'No LLM key set: the Collector uses a deterministic offline planner, not a language model'}><i />{m.llm === 'configured' ? `LLM: ${m.llmModel}` : 'Offline planner (no LLM)'}</span>
          <span className="tw-badge" title="Open invoices held out of the forecast because they are unpaid after 120 days">{snap.kpis.staleCount} stale ({usd(snap.kpis.staleAmount, 'USD', true)}) excluded</span>
          {sim && <span className="tw-badge" title="Simulated clock">{dayShort(snap.now)}, {new Date(snap.now).getUTCFullYear()}</span>}
        </div>
        <span className="tw-spacer" />
        {sim && (
          <div className="tw-row" style={{ gap: 6 }}>
            <button className="tw-btn" disabled={busy} onClick={() => run(async () => { const r = await api.advance(7); toast(`+7 days: ${r.paid.length} invoice${r.paid.length === 1 ? '' : 's'} paid`); }, undefined)}>+7 days</button>
            <button className="tw-btn" disabled={busy} onClick={() => run(async () => { const r = await api.advance(14); toast(`+14 days: ${r.paid.length} invoice${r.paid.length === 1 ? '' : 's'} paid`); }, undefined)}>+14 days</button>
          </div>
        )}
        <button className="tw-btn" onClick={() => setShowNew(true)}>New invoice</button>
        <div className="tw-seg" title="Dashboard: locked layout. Collector: the AI agent that drafts reminders. Studio: AG Studio's report builder (drag, resize, add widgets).">
          <button className={view === 'dashboard' ? 'on' : ''} onClick={() => setView('dashboard')}>Dashboard</button>
          <button className={view === 'collector' ? 'on' : ''} onClick={() => setView('collector')}>Collector agent</button>
          <button className={view === 'studio' ? 'on' : ''} onClick={() => setView('studio')}>Studio editor</button>
        </div>
      </header>

      <div className="tw-body">
        <main className="tw-studio">
          <StudioView snapshot={snap} mode={mode} panelSet={view === 'studio' ? 'full' : 'collector'} ai={ai} aiToolDisplay={aiToolDisplay} bridge={bridge} />
        </main>
        <aside className="tw-drawer" style={view === 'studio' ? { display: 'none' } : undefined}>
          <div className="tw-tabs">
            <button className={`tw-tab ${tab === 'queue' ? 'on' : ''}`} onClick={() => setTab('queue')}>Action queue{pendingCount > 0 && <span className="tw-count">{pendingCount}</span>}</button>
            <button className={`tw-tab ${tab === 'lens' ? 'on' : ''}`} onClick={() => setTab('lens')}>Invoice lens</button>
            <button className={`tw-tab ${tab === 'model' ? 'on' : ''}`} onClick={() => setTab('model')}>Model</button>
            <button className={`tw-tab ${tab === 'audit' ? 'on' : ''}`} onClick={() => setTab('audit')}>Audit</button>
          </div>
          {tab === 'queue' && <ActionQueue snap={snap} onChanged={load} toast={toast} />}
          {tab === 'lens' && <LensPanel snap={snap} payer={selectedPayer} onClearPayer={() => setSelectedPayer(null)} />}
          {tab === 'model' && <ModelPanel snap={snap} />}
          {tab === 'audit' && <AuditPanel version={version} now={snap.now} />}
        </aside>
      </div>

      {showNew && <NewInvoice snap={snap} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); toast('Invoice created and sent.'); load(); }} toast={toast} />}
      {toastMsg && <div className={`tw-toast ${toastMsg.err ? 'err' : ''}`}>{toastMsg.msg}</div>}
    </div>
  );
}
