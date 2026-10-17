# Demo video script (target 2:30, hard limit 3:00)

Record the dashboard at 1440x900 with the simulator badge visible. Say "synthetic data" out loud once.

**0:00-0:15 Problem.** "Invoices have due dates, but payers don't pay on them. Tidewater forecasts when each PayPal invoice will really be paid." Show dashboard.

**0:15-0:55 Forecast.** Point at KPI tiles, then Cash Tide: the ribbon is the probability range, the grey line is the naive due-date assumption. Hover a day. Open Payer Orbit; hover a payer. "All data here is synthetic, from a PayPal simulator."

**0:55-1:25 Invoice lens.** Open the Invoice lens tab, pick an invoice, show its payment-date curve and ghost probability.

**1:25-2:05 Agent.** Switch to Collector agent. Ask: "Which invoices should I nudge this week?" It ranks, simulates (amber "if nudges sent" curve) and proposes. "The agent can only propose."

**2:05-2:30 Human in control.** Action queue: edit a draft, Confirm. Show audit log entry and the simulated PayPal send. Try a blocked case if one is available.

**2:30-2:50 Honesty and close.** Show Model panel and backtest: "calibrated, tested on synthetic ground truth." State that sandbox support is built on PayPal's Invoicing API. End on the repo URL.

Before recording: `npm run build && npm start`; if you have sandbox credentials, run the smoke test first and say so only if it passed.
