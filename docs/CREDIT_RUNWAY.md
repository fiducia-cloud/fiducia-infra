# Infrastructure credit runway modeling

`tools/credit_runway.py` estimates how many months a fixed infrastructure credit can cover under an explicitly supplied monthly-spend assumption and eligible-spend fraction.

The tool is deliberately provider-neutral. It does **not** encode or attest to startup-program eligibility, provider terms, credit amounts, expiration rules, pricing, incorporation facts, funding status, or actual Fiducia spend. Those values must come from reviewed program terms and verified company data.

## Example

```bash
python3 tools/credit_runway.py --credit 10000 --monthly-spend 2000 --eligible-fraction 0.75
```

This models a hypothetical credit of 10,000 against hypothetical monthly spend of 2,000 where 75% of spend is eligible. It is a planning calculation only, not a billing forecast or commitment.

## Intended use

- compare scenario sensitivity before an application is submitted;
- estimate whether a credit tier materially changes the duration of multi-cluster testing;
- separate eligible infrastructure spend from excluded services;
- attach reproducible assumptions to Linear/application review rather than putting guesses into application forms.

## Guardrails

Never populate the inputs from unverified company facts. Do not use this utility to commit spend, choose a paid plan, accept provider terms, or represent that Fiducia qualifies for a program.

Related Linear work: DEN-854 and DEN-519.
