# Tidewater

**A receivables-forecasting cockpit for PayPal invoices, built on AG Grid's AG Studio.**

Tidewater predicts *when* each open PayPal invoice will be paid, as a probability distribution rather than a single date. It rolls those into a cash-inflow forecast, and lets an AI agent propose payment reminders that a human confirms before PayPal sends them.

![Dashboard](docs/img/dashboard.png)

> **Data disclosure.** The default demo runs on a **PayPal simulator with synthetic invoices** (clearly badged in the header). Synthetic payers have hidden payment behaviour so the forecast can be checked against ground truth. Nothing here is evidence about real merchants. Sandbox mode (below) talks to the PayPal **sandbox** only; the code refuses any other host.

## What it does

- **Payment-date distribution per invoice.** A hierarchical censored log-normal model with a "never pays" (ghost) component, fit by EM. Open invoices are right-censored, not treated as missing.
- **Cash Tide** (custom AG Studio widget). A probability ribbon of expected inflow over time, compared with a naive due-date curve.
- **Payer Orbit** (custom AG Studio widget). A radial view of payers by open dollars and risk.
- **Collector agent** (AG Studio AI panel). Ranks invoices by expected 14-day cash gain from a reminder, simulates the effect on the tide, and drafts a reminder. It can only *propose*.
- **Human-only confirm.** Sending goes through a confirm endpoint the agent cannot call. Policy is enforced on the server at propose time and again at confirm time: invoice must be sent/unpaid, max 3 reminders, at least 5 days apart, only within 3 days of due or overdue, one pending proposal per invoice.
- **Audit log** of every proposal, confirmation, block and send.
- **Model panel** showing estimated reminder effect with an 80% interval, and a backtest summary.
- AG Studio view mode (dashboard), edit mode (drag, rearrange, build your own widgets), and the AI panel.

![Collector agent](docs/img/collector.png)

## Run it

Requires Node >= 22.13.

```bash
npm ci
npm run dev          # API on :8787, web on :5173
```

Or as a single process:

```bash
npm run build
npm start            # http://localhost:8787
```

With no environment variables it runs offline: PayPal simulator, synthetic data, and the deterministic offline planner for the agent (this is **not** a language model; the header badge says so).

Use **+7 days / +14 days** in the header to advance the simulated clock and watch invoices settle against their hidden truth.

### Optional: PayPal sandbox

Copy `.env.example` to `.env`, fill `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` from a sandbox REST app. Then:

```bash
npm run paypal:smoke   # create -> send -> remind -> record payment -> read, against your sandbox
```

### Optional: a real LLM

Set `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` to any OpenAI-compatible `/chat/completions` endpoint. The key stays on the server (`/api/llm/chat` proxies).

## Tests and backtest

```bash
npm run typecheck
npm test             # 58 tests
npm run backtest     # regenerates docs/BACKTEST.md
```

See [docs/BACKTEST.md](docs/BACKTEST.md) and [docs/METHOD.md](docs/METHOD.md).

## Architecture

```
web/ (React 18 + AG Studio 3)  <->  server/ (Express + node:sqlite)
  studio/  widgets, state, theme       forecast/  model, math, portfolio, backtest
  ai/      Collector tools + adapters  services/  ledger, actions, proposals, seed
  panels/  queue, lens, model, audit   paypal/    port, sim (simulator), live (sandbox REST)
```

`PayPalPort` has two implementations: `SimPayPal` (hidden ground truth, virtual clock) and `LivePayPal` (sandbox REST, OAuth, retries, webhook verification).

## Honest limitations

- **`LivePayPal` has been tested only against a local mock of the Invoicing API**, not PayPal's servers. Endpoint paths, field names and webhook event names were written from PayPal's documentation as I understood it and may need adjusting. `npm run paypal:smoke` exists to find out on first run.
- **The LLM path has been tested only against a mock OpenAI-compatible server.** Compatibility with specific providers is unverified.
- **All backtests and reminder-effect results are on synthetic data.** The reminder effect is estimated observationally and assumes reminded and un-reminded invoices are comparable. The weaker effect of repeat reminders (exponent 0.5) is an assumption.
- Point accuracy is modest: in the well-specified backtest the median-payment MAE is ~19 days (vs ~29 for the due date). The value is calibrated uncertainty (80% interval observed 77-82%), not precise dates.
- Reminder-effect recovery was inside its 80% interval in 5 of 8 synthetic runs, with estimates biased toward "no effect" on small samples.
- Invoices unpaid after 120 days are held out of forecasts and reported separately as stale.
- AG Studio is a commercial product; running it beyond a trial needs a licence key from AG Grid. Check their current terms. The AI panel is only available in edit mode.
- The production bundle is large (~5.6 MB JS).

## Licence

MIT, see [LICENSE](LICENSE). AG Studio / AG Grid are third-party software under their own licence.
