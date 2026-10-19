# Demo video script (target 2:30, hard limit 3:00)

Record the dashboard at 1440x900 with the simulator badge visible. Say "synthetic data" out loud once.

**0:00-0:15 Problem.** "Invoices have due dates, but payers don't pay on them. Tidewater forecasts when each PayPal invoice will really be paid." Show dashboard.

**0:15-0:55 Forecast.** Point at KPI tiles, then Cash Tide: the ribbon is the probability range, the grey line is the naive due-date assumption. Hover a day. Open Payer Orbit; hover a payer. "All data here is synthetic, from a PayPal simulator."

**0:55-1:25 Invoice lens.** Open the Invoice lens tab, pick an invoice, show its payment-date curve and ghost probability.

**1:25-2:05 Agent.** Switch to Collector agent. Ask: "Which invoices should I nudge this week?" It ranks, simulates (amber "if nudges sent" curve) and proposes. "The agent can only propose."

**2:05-2:30 Human in control.** Action queue: edit a draft, Confirm. Show the audit log entry (drafted by agent, human confirmed, sent). Use the simulator for the headline scenes: its queue has proposals with real dollar gains. Optional 10-second cut to a sandbox run (local, with your keys): Confirm, then the Audit tab showing "Reminder sent via PayPal". Do not use a proposal whose estimated gain is about +$1 as the headline.

**2:30-2:50 Honesty and close.** Show Model panel and backtest: "calibrated, tested on synthetic ground truth." State that sandbox support is built on PayPal's Invoicing API. End on the repo URL.

Before recording: open the app, press **Reset demo** (twice) so the clock and queue start clean, then `npm run build && npm start` if running locally; if you have sandbox credentials, run the smoke test first and say so only if it passed.
