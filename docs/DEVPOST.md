# Devpost text (draft: edit freely before submitting)

## Tagline
Know when your PayPal invoices will actually be paid, and nudge only the ones worth nudging.

## Inspiration
Invoices carry a due date, but payers do not pay on the due date. Cash-flow tools that assume they do give a forecast that is wrong in a predictable direction. We wanted a forecast that shows uncertainty honestly, and an agent that helps collect without being able to act on its own.

## What it does
Tidewater models each open PayPal invoice's payment date as a probability distribution (with a "may never pay" component), rolls them into a cash-inflow forecast, and shows it in an AG Studio dashboard with two custom widgets: **Cash Tide** (probability ribbon vs the naive due-date curve) and **Payer Orbit** (radial payer risk). A **Collector** agent in the AG Studio AI panel ranks invoices by expected 14-day cash gain from a reminder, simulates the effect on the tide, and drafts a message. It can only propose. A human confirms, and only then does PayPal send the reminder. Server-side policy (max 3 reminders, 5-day spacing, only near/after due date) is enforced at propose and again at confirm, and everything lands in an audit log.

## How we built it
TypeScript, Express, node:sqlite, React 18, AG Studio 3. Hierarchical censored log-normal + cure model fit by EM; reminder effect on a grid posterior; Monte Carlo cash tide with common random numbers. A `PayPalPort` interface has a simulator (hidden ground truth) and a sandbox REST implementation. The agent uses AG Studio's AI harness with an OpenAI-compatible LLM adapter, plus a deterministic offline planner when no key is set.

## Challenges
Open invoices are censored, so naive averages are biased. Very old unpaid invoices distort everything, so they are held out and reported as stale. Keeping an LLM agent from ever sending anything required making confirmation a separate human-only endpoint.

## Accomplishments
Calibrated intervals in backtests (80% interval observed 77-82% across three scenarios, including two misspecified ones), tests for the model, the PayPal client and the full propose/confirm flow, and a UI that runs end to end offline.

## What we learned / limits (please read)
- Demo data is **synthetic**; the simulator badge is always visible. Backtests are synthetic too.
- The sandbox client was tested against a mock, not live PayPal, before submission. [Update this line after running `npm run paypal:smoke`.]
- Median-date error is mostly irreducible noise (18.9 days vs 18.0 for an oracle that knows the true parameters, on synthetic data); the value is calibrated uncertainty.
- The reminder effect is estimated observationally.

## What's next
Real-merchant validation, partial-payment modelling, richer payer features, multi-currency.

## Built with
AG Grid AG Studio, React, TypeScript, Express, SQLite, PayPal Invoicing API (sandbox), Render
