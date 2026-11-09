/**
 * DeFindex on Stellar — pure helpers (no SDK import, safe to bundle anywhere).
 *
 * Amounts are bigint stroops: Stellar USDC has 7 decimals, so 1 USDC = 10_000_000.
 * Never floats for money.
 */

export const USDC_DECIMALS = 7;
export const UNIT = 10n ** BigInt(USDC_DECIMALS);

/**
 * 0.5% tolerance. Withdraw: on-chain `min_amounts_out`. Deposit: the vault takes no min-shares
 * argument, so we refuse to sign if the simulated shares fall below the vault's own price by more.
 */
export const SLIPPAGE_BPS = 50n;

/** Never ask the wallet to sign a fee above 0.5 XLM. A measured deposit costs ~0.03 XLM. */
export const MAX_FEE_STROOPS = 5_000_000n;

/**
 * Keystroke filter for the amount field. A single comma is a decimal separator (Czech UI):
 * "12,5" is 12.5, never 125. Input with grouping separators ("1,234.56", "1.234,56", "1,000,000")
 * is ambiguous, so it is kept as typed and parseUsdc rejects it — never silently re-read.
 */
export function normalizeAmountInput(raw: string): string {
  const s = raw.replace(/[^\d.,]/g, '');
  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  if (commas + dots > 1) return s;
  return s.replace(',', '.');
}

/** Parses a user-typed USDC amount ("12.5") into stroops. null if not a positive amount. */
export function parseUsdc(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{0,7})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const v = BigInt(whole) * UNIT + BigInt((frac + '0000000').slice(0, USDC_DECIMALS));
  return v > 0n ? v : null;
}

/** Stroops → "1,234.56" (2 dp, rounded down so we never overstate a balance). */
export function formatUsdc(stroops: bigint): string {
  const cents = stroops / (UNIT / 100n);
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

/** Stroops → exact decimal string for an input field ("12.5000000" → "12.5"). */
export function toInputUsdc(stroops: bigint): string {
  const whole = stroops / UNIT;
  const frac = (stroops % UNIT).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Stroops → "$18.5M" / "$250.1K" / "$950" for headline stats. */
export function formatUsdcCompact(stroops: bigint): string {
  const usd = Number(stroops / UNIT);
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toLocaleString('en-US')}`;
}

/** XLM stroops → "0.0323 XLM". */
export function formatXlm(stroops: bigint): string {
  return `${(Number(stroops) / 1e7).toFixed(4)} XLM`;
}

export function minAfterSlippage(amount: bigint): bigint {
  return (amount * (10_000n - SLIPPAGE_BPS)) / 10_000n;
}

/** Least shares a deposit of `amount` may mint at the vault's current price (supply / managed), less slippage. */
export function minSharesForDeposit(amount: bigint, totalSupply: bigint, totalManaged: bigint): bigint {
  if (totalManaged <= 0n || totalSupply <= 0n) return 0n;
  return minAfterSlippage((amount * totalSupply) / totalManaged);
}

/**
 * Shares to burn for a withdrawal of `amount` underlying, given the current position.
 * Rounded down and capped at the position, so a withdrawal never asks for more shares
 * than the wallet holds.
 */
export function sharesForAmount(amount: bigint, positionShares: bigint, positionUnderlying: bigint): bigint {
  if (positionUnderlying <= 0n || positionShares <= 0n) return 0n;
  if (amount >= positionUnderlying) return positionShares;
  const s = (amount * positionShares) / positionUnderlying;
  return s > positionShares ? positionShares : s;
}

// ── Authorization check ──────────────────────────────────────────────────────
//
// The wallet signs whatever authorization tree the simulation returns. Before we ask the
// user to sign, the tree must be exactly the call they asked for — nothing else may be able
// to move their money. A deposit authorizes the vault deposit plus ONE USDC transfer
// (wallet → vault, exact amount). A withdraw authorizes the vault withdraw and nothing below it.

export interface AuthCall {
  /** 'source' = authorized by the transaction's own signature; anything else is rejected. */
  credentials: 'source' | 'address' | 'other';
  contract: string;
  fn: string;
  args: unknown[];
  sub: AuthCall[];
}

const asBig = (v: unknown): bigint | null => {
  try { return typeof v === 'bigint' ? v : BigInt(String(v)); } catch { return null; }
};

function single(entries: AuthCall[]): AuthCall | string {
  if (entries.length !== 1) return `expected 1 authorization, got ${entries.length}`;
  const e = entries[0];
  if (e.credentials !== 'source') return 'authorization must come from your own signature';
  return e;
}

export function checkDepositAuth(
  entries: AuthCall[],
  want: { vault: string; asset: string; from: string; amount: bigint },
): string | null {
  const e = single(entries);
  if (typeof e === 'string') return e;
  if (e.contract !== want.vault || e.fn !== 'deposit') return `unexpected call ${e.fn} on ${e.contract}`;
  if (e.args[2] !== want.from) return 'deposit is not from your wallet';
  if (e.sub.length !== 1) return `expected 1 transfer under the deposit, got ${e.sub.length}`;
  const t = e.sub[0];
  if (t.contract !== want.asset || t.fn !== 'transfer') return `unexpected call ${t.fn} on ${t.contract}`;
  if (t.args[0] !== want.from || t.args[1] !== want.vault) return 'transfer is not wallet → vault';
  if (asBig(t.args[2]) !== want.amount) return 'transfer amount differs from what you entered';
  if (t.sub.length !== 0) return 'transfer carries extra calls';
  return null;
}

export function checkWithdrawAuth(
  entries: AuthCall[],
  want: { vault: string; from: string; shares: bigint },
): string | null {
  const e = single(entries);
  if (typeof e === 'string') return e;
  if (e.contract !== want.vault || e.fn !== 'withdraw') return `unexpected call ${e.fn} on ${e.contract}`;
  if (asBig(e.args[0]) !== want.shares) return 'share amount differs from the quote';
  if (e.args[2] !== want.from) return 'withdraw is not from your wallet';
  if (e.sub.length !== 0) return 'withdraw carries extra calls';
  return null;
}

export const stellarTxUrl = (hash: string) => `https://stellar.expert/explorer/public/tx/${hash}`;

export const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
