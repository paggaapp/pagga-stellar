# pagga-stellar

The Stellar treasury client from [Pagga](https://pagga.io), the AI back office for one-person and small companies. It is extracted from the production app (live on Stellar mainnet since 2026-11-09).

**Non-custodial by construction.** The company owner's own wallet (Freighter) signs every transaction. Pagga's servers never hold a key that can move company funds.

## What it does

`lib/stellar/defindex.ts` deposits USDC into, and withdraws it from, a [DeFindex](https://defindex.io) vault on Stellar mainnet. It builds the Soroban call in the browser and refuses to ask for a signature unless every guard passes:

| Guard | What it enforces |
|---|---|
| Vault allow-list | Only listed vault contracts can ever be called |
| Authorization tree (`defindex-core.ts`) | A deposit may authorize only the vault `deposit` plus **one** USDC `transfer` (wallet → vault, exact amount). A withdraw may authorize only the vault `withdraw`, with nothing beneath it. Anything else is refused before signing. |
| Fee cap | Refuses to sign if the assembled fee is above 0.5 XLM (a deposit costs about 0.03) |
| Price floor | A deposit must mint at least 99.5% of the shares the vault's own price implies; a withdraw passes `min_amounts_out` |
| Signature check | The wallet must return exactly the transaction hash that was built, signed by the connected account |
| Honest outcome | "Confirmed" only after the network returns SUCCESS. "Not applied" only when the network says FAILED, or a ledger closed after the transaction's `maxTime` doesn't contain it. Every other outcome is reported as pending, never as "nothing moved". |

`lib/stellar/defindex-core.ts` holds the pure helpers: USDC amounts as integer stroops (7 decimals, no floats), slippage, share maths and the authorization-tree checks.

## Run the tests

```bash
npm install
npm test           # offline: amounts, auth-tree checks, signing and submit outcomes
STELLAR_DEPOSITOR=G... STELLAR_SHAREHOLDER=G... npm run test:live  # opt-in: reads the mainnet vault, builds + simulates a real
                   # deposit and withdraw. Nothing is signed or submitted.
```

## Architecture

The full Stellar architecture for Pagga's SCF #46 Build Award, including what's built and what's funded, the integrations, the flows and the security model, is in the [technical architecture document](https://docs.google.com/document/d/1LshbNP0TiVTNGGpzUb5MRyrvBsWluBdlwdk6LAhSfXc/edit?usp=sharing).
