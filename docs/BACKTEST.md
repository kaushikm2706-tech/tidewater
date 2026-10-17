# Tidewater backtest (synthetic ground truth)

> **Read this first.** Every number below comes from *synthetic* ledgers whose ground truth is known. They show whether the estimator is calibrated when its assumptions hold, and how it degrades when they do not. They are **not** evidence about real PayPal merchants.

Method: rolling origin (9 monthly origins x 6 random ledgers per scenario). At each origin the model is refit using only data visible at that date; each invoice still open at the origin is scored against its realised payment time. Payment-time scores are conditional on the invoice eventually being paid; ghost (never-pays) probability is scored separately.

## well-specified

Log-normal truth, no reminders: the estimator's home turf.

Scored invoices: 702 (mean ledger size 208).

| Interval | Nominal | Observed |
|---|---|---|
| central 50% | 50% | 55.1% |
| central 80% | 80% | 81.9% |
| central 90% | 90% | 89.3% |

| Forecaster | Mean pinball loss (days) | MAE of median (days) |
|---|---|---|
| **Tidewater model** | **6.90** | **18.88** |
| Payer empirical quantiles | 7.50 | 20.01 |
| Global model (no payer info) | 8.07 | 21.97 |
| Invoice due date | 14.28 | 28.56 |
| *Oracle (true parameters known)* | n/a | *17.97* |

Ghost (never-pays) probability: mean predicted 13.9% vs observed 12.0%; Brier 0.0930 vs base-rate 0.1118 (n=798).

PIT histogram (10 bins, uniform = 0.10 each): 0.08 0.11 0.10 0.10 0.10 0.12 0.12 0.09 0.08 0.10

## misspecified-loglogistic

Log-logistic (heavier-tailed) truth, no reminders: the model assumes log-normal.

Scored invoices: 671 (mean ledger size 211).

| Interval | Nominal | Observed |
|---|---|---|
| central 50% | 50% | 51.1% |
| central 80% | 80% | 79.0% |
| central 90% | 90% | 87.9% |

| Forecaster | Mean pinball loss (days) | MAE of median (days) |
|---|---|---|
| **Tidewater model** | **7.92** | **21.51** |
| Payer empirical quantiles | 8.75 | 22.94 |
| Global model (no payer info) | 9.31 | 25.05 |
| Invoice due date | 15.60 | 31.21 |

Ghost (never-pays) probability: mean predicted 12.2% vs observed 11.2%; Brier 0.0886 vs base-rate 0.1049 (n=756).

PIT histogram (10 bins, uniform = 0.10 each): 0.10 0.08 0.10 0.11 0.11 0.10 0.11 0.09 0.09 0.11

## misspecified-batch

Payers settle in 15-day batch cycles (multi-modal): the model assumes a smooth log-normal.

Scored invoices: 842 (mean ledger size 222).

| Interval | Nominal | Observed |
|---|---|---|
| central 50% | 50% | 49.5% |
| central 80% | 80% | 77.3% |
| central 90% | 90% | 87.1% |

| Forecaster | Mean pinball loss (days) | MAE of median (days) |
|---|---|---|
| **Tidewater model** | **6.74** | **18.14** |
| Payer empirical quantiles | 7.10 | 19.07 |
| Global model (no payer info) | 7.92 | 21.42 |
| Invoice due date | 14.42 | 28.83 |

Ghost (never-pays) probability: mean predicted 15.2% vs observed 12.7%; Brier 0.0962 vs base-rate 0.1147 (n=964).

PIT histogram (10 bins, uniform = 0.10 each): 0.10 0.11 0.10 0.10 0.10 0.12 0.08 0.09 0.07 0.13

## Reminder-effect recovery (kappa)

Ledgers with a 60%-probability merchant reminder policy. `truth` is the geometric mean of the true per-invoice kappa over reminded, eventually-paid invoices; the estimator only sees reminder dates and payment dates.

| Seed | n obs | Truth | Estimate | 80% interval | Covered |
|---|---|---|---|---|---|
| 1 | 59 | 0.65 | 0.61 | 0.52-0.72 | yes |
| 2 | 44 | 0.65 | 0.75 | 0.63-0.91 | yes |
| 3 | 54 | 0.63 | 0.63 | 0.51-0.78 | yes |
| 4 | 39 | 0.68 | 0.83 | 0.70-1.00 | no |
| 5 | 50 | 0.66 | 0.72 | 0.59-0.87 | yes |
| 6 | 55 | 0.65 | 0.75 | 0.61-0.92 | yes |
| 7 | 59 | 0.61 | 0.62 | 0.54-0.72 | yes |
| 8 | 51 | 0.67 | 0.64 | 0.49-0.85 | yes |

First 8 of 40 runs shown. Across all 40: truth fell inside the 80% interval in 35/40 (88%; the standard error of that figure is about 6 points); mean log-bias of the estimate 0.061 (positive = estimate closer to "no effect" than the truth); mean interval width on the log scale 0.41.

The interval is a payer-level cluster bootstrap around a grid posterior (invoices of the same payer share an estimated intercept, so treating them as independent made the earlier interval too narrow: it covered the truth in roughly 55% of 40 runs on a separate seed set); a later check of the final method on a different, untouched set of 40 seeds (601-640) gave 30/40 (75%), so expect roughly 75-90%. The prior (sd 0.6 on ln kappa) is centred on kappa = 1, so with little data the estimate is pulled toward "reminders do nothing". The generator's repeat-reminder exponent (0.35) differs from the exponent the forecaster assumes (0.5); this is deliberate misspecification and is not corrected.
