import React from 'react';
import type { Snapshot } from '@shared/types';
import { api } from '../api';

export function NewInvoice({ snap, onClose, onCreated, toast }: { snap: Snapshot; onClose: () => void; onCreated: () => void; toast: (m: string, e?: boolean) => void }) {
  const [payerId, setPayerId] = React.useState(snap.payers[0]?.payerId ?? '');
  const [amount, setAmount] = React.useState('4200');
  const [netDays, setNetDays] = React.useState('30');
  const [desc, setDesc] = React.useState('Consulting services');
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.createInvoice({ payerId, amount: Number(amount), netDays: Number(netDays), description: desc });
      onCreated();
    } catch (e) {
      toast(String((e as Error).message), true);
    } finally {
      setBusy(false);
    }
  };
  const bad = !(Number(amount) > 0) || !(Number(netDays) >= 1) || !desc.trim() || !payerId;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,12,.66)', display: 'grid', placeItems: 'center', zIndex: 40 }} onClick={onClose}>
      <div className="tw-card" style={{ width: 420, padding: 18, background: '#0a1626' }} onClick={(e) => e.stopPropagation()}>
        <h4 style={{ fontSize: 16 }}>New invoice</h4>
        <p>{snap.mode.paypal === 'sandbox' ? 'Creates and sends a real invoice in your PayPal sandbox account.' : 'Creates an invoice in the PayPal simulator. The payer\'s behaviour is hidden from the forecaster.'}</p>
        <label className="tw-label">Payer</label>
        <select className="tw-select" value={payerId} onChange={(e) => setPayerId(e.target.value)}>
          {snap.payers.map((p) => <option key={p.payerId} value={p.payerId}>{p.name}</option>)}
        </select>
        <div className="tw-row" style={{ gap: 10 }}>
          <div style={{ flex: 1 }}><label className="tw-label">Amount (USD)</label><input className="tw-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div style={{ flex: 1 }}><label className="tw-label">Net days</label><input className="tw-input" inputMode="numeric" value={netDays} onChange={(e) => setNetDays(e.target.value)} /></div>
        </div>
        <label className="tw-label">Description</label>
        <input className="tw-input" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} />
        <div className="tw-row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="tw-btn" onClick={onClose}>Cancel</button>
          <button className="tw-btn primary" disabled={busy || bad} onClick={submit}>{busy ? 'Creating…' : 'Create & send'}</button>
        </div>
      </div>
    </div>
  );
}
