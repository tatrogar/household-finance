# Household Finance

A local-first household budget app modeled on a Household Budget spreadsheet —
no accounts, no server, no build step. All data lives in your browser's
localStorage; use the Data tab to export/import a JSON backup between devices.

**Live app:** https://tatrogar.github.io/household-finance/

## Tabs

- **Dashboard** — monthly snapshot: income, recurring bills (monthly
  equivalent), debt minimums, savings contributions, total budgeted, and the
  income-minus-budget cushion; 12-month spending chart; upcoming bills; goal
  progress
- **Budget** — monthly limit per category vs. actuals, with YTD rollups;
  categories flag near/over their limit
- **Spending** — the expense log; entries flow into Budget actuals and the
  Dashboard automatically
- **Income** — sources by owner (his / hers / joint) with totals
- **Bills** — recurring bills at their real frequency (weekly → annual), with a
  computed monthly equivalent
- **Debts** — balances, rates, asset value/equity, minimum payments, payoff
  progress
- **Goals** — savings targets with months-remaining projections
- **Data** — JSON export/import backup, reset to seed data

## Development

It's three static files (`index.html`, `styles.css`, `app.js`). Serve the
folder any way you like, e.g.:

```sh
python3 -m http.server 8000
```

Pushes to `main` deploy to GitHub Pages via the workflow in
`.github/workflows/deploy.yml`.

The seed figures are examples from the original spreadsheet — replace them
with real numbers in the app (or hit "Reset to spreadsheet seed" on the Data
tab to start over).
