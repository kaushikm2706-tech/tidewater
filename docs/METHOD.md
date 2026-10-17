# Method

## Payment-time model

For invoice *i* of payer *p*, T is days from sending to payment:

    ln T = a_p + b1 ln(net/30) + b2 z(ln amount) + sigma_p * eps,   eps ~ N(0,1)
    a_p ~ N(mu_a, tau^2)           payer intercept, shrunk to the population
    sigma_p^2 ~ scaled-inv-chi^2   payer noise, shrunk to the pooled noise
    ghost probability pi_p         payer never pays (cure/mixture component)

- Open invoices are **right-censored**. EM weights each censored invoice by its posterior probability of belonging to the "will eventually pay" group.
- Invoices unpaid after 120 days are hard-labelled ghosts for fitting, and are excluded from forecasts and KPIs (reported as stale).
- Conditional predictive: given an invoice is still unpaid after `r` days, quantiles and CDF come from the truncated distribution, with `ghostProb` updated accordingly.

## Reminder effect

A reminder sent at day `r` shortens the remaining time: `T = r + kappa (T0 - r)`, kappa in (0, 1]. kappa has a grid posterior; the reported range is its 10%/90% quantiles (an **80%** interval). A repeat reminder uses `kappa^0.5` (an assumption, not identified from data). The estimate is observational and assumes comparability between reminded and un-reminded invoices.

## Cash tide

Monte Carlo with common random numbers: each invoice's conditional predictive is sampled, summed per day, and compared to a naive curve that assumes payment on the due date. Expected inflow is also computed exactly. The "if nudges sent" curve reuses the same random draws with kappa applied.

## Validation

Rolling-origin backtests on synthetic ledgers with known truth, including misspecified scenarios (log-logistic, batch-cycle payers). Results and caveats are in BACKTEST.md. None of this validates the model on real PayPal data.

## Guardrails

Reminder policy lives in `server/services/proposals.ts` and is checked at propose and again at confirm. The agent has no code path to send; only `Actions.confirm`, reachable from a human-only endpoint, calls PayPal.
