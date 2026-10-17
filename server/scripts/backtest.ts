import fs from 'node:fs';
import path from 'node:path';
import { SCENARIOS, runNudgeRecovery, runScenario, toMarkdown } from '../forecast/backtest';

const t0 = Date.now();
const reports = SCENARIOS.map((s) => {
  const r = runScenario(s);
  console.log(`${s.name}: scored ${r.nTest} invoices | coverage 50/80/90 = ${r.coverage.map((c) => (c.observed * 100).toFixed(1)).join('/')} | pinball model ${r.pinball.model.toFixed(2)} vs payer ${r.pinball.payerMedianBaseline.toFixed(2)} global ${r.pinball.globalBaseline.toFixed(2)} due ${r.pinball.dueDateBaseline.toFixed(2)}`);
  return r;
});
const nudge = runNudgeRecovery();
console.log('nudge recovery:', nudge.map((n) => `${n.truth.toFixed(2)}->${n.estimate.toFixed(2)}[${n.lo.toFixed(2)},${n.hi.toFixed(2)}]`).join('  '));
const root = path.resolve(import.meta.dirname, '../..');
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.mkdirSync(path.join(root, 'server/data'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs/BACKTEST.md'), toMarkdown(reports, nudge));
fs.writeFileSync(path.join(root, 'server/data/backtest.json'), JSON.stringify({ reports, nudge }, null, 2));
console.log(`wrote docs/BACKTEST.md and server/data/backtest.json in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
