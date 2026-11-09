import { describe, expect, it } from 'vitest';
import {
  checkDepositAuth, checkWithdrawAuth, formatUsdc, formatUsdcCompact, minAfterSlippage, minSharesForDeposit,
  normalizeAmountInput, parseUsdc, sharesForAmount, toInputUsdc,
  type AuthCall,
} from '@/lib/stellar/defindex-core';

const VAULT = 'CCA2ZJP5BVRXYTQH4FAGHCAUMRYCXVC4CRYC2NXHWMR7TIVX36U7F5HR';
const USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const ME = 'GCBKNPP5LCGOIS7VOQFFYMNLTNB5ASFIQRTEWAX7FTRNSPR7WSITP3DU';
const EVIL = 'GBEGEVPTNOMHUG3EGYS3J7RFHKIGTFIURJ5JWJAIZS26YIUOLBFDHAND';

const call = (contract: string, fn: string, args: unknown[], sub: AuthCall[] = [], credentials: AuthCall['credentials'] = 'source'): AuthCall =>
  ({ credentials, contract, fn, args, sub });

// Shape recorded from a mainnet simulation of a 1 USDC deposit (Nov 8 2026).
const depositTree = (amount = 10_000_000n, to = VAULT) => [
  call(VAULT, 'deposit', [[amount], [9_950_000n], ME, true], [call(USDC, 'transfer', [ME, to, amount])]),
];

describe('USDC amounts (7 decimals)', () => {
  it('parses typed amounts to stroops', () => {
    expect(parseUsdc('1')).toBe(10_000_000n);
    expect(parseUsdc('12.5')).toBe(125_000_000n);
    expect(parseUsdc('0.0000001')).toBe(1n);
  });
  it('rejects zero, junk and >7 decimals', () => {
    for (const s of ['', '0', '0.0', 'abc', '1.2.3', '-1', '1.00000001']) expect(parseUsdc(s)).toBeNull();
  });
  it('formats down to cents without overstating', () => {
    expect(formatUsdc(10_799_700_607n)).toBe('1,079.97');
    expect(formatUsdc(9_999_999n)).toBe('0.99');
    expect(toInputUsdc(125_000_000n)).toBe('12.5');
    expect(toInputUsdc(10_000_000n)).toBe('1');
  });
  it('applies 0.5% slippage', () => {
    expect(minAfterSlippage(10_000_000n)).toBe(9_950_000n);
  });
  it('treats a single comma as the decimal point, never as a 10x', () => {
    expect(normalizeAmountInput('12,5')).toBe('12.5');
    expect(normalizeAmountInput('$1 000')).toBe('1000');
  });
  it('never re-reads grouped amounts: they stay unparseable', () => {
    for (const s of ['1,234.56', '1.234,56', '1,000,000', '1.2.3']) {
      expect(parseUsdc(normalizeAmountInput(s))).toBeNull();
    }
  });
  it('formats headline totals by size', () => {
    expect(formatUsdcCompact(184_669_473_152_790n)).toBe('$18.5M');
    expect(formatUsdcCompact(2_501_163_574_911n)).toBe('$250.1K');
    expect(formatUsdcCompact(9_500_000_000n)).toBe('$950');
  });
});

describe('minSharesForDeposit', () => {
  // Live vault Nov 8 2026: supply 169,820,173,537,543 / managed 184,669,473,152,790 → 1 USDC ≈ 0.9196 shares.
  it('quotes from the vault price less 0.5%', () => {
    const min = minSharesForDeposit(10_000_000n, 169_820_173_537_543n, 184_669_473_152_790n);
    expect(min).toBe(9_149_918n);
    expect(9_195_898n >= min).toBe(true); // the simulated mainnet mint passes
  });
  it('an empty vault has no floor', () => {
    expect(minSharesForDeposit(10_000_000n, 0n, 0n)).toBe(0n);
  });
});

describe('sharesForAmount', () => {
  it('converts pro rata, rounding down', () => {
    expect(sharesForAmount(5_000_000n, 9_195_898n, 10_000_000n)).toBe(4_597_949n);
  });
  it('withdrawing the whole value burns exactly the position', () => {
    expect(sharesForAmount(10_000_000n, 9_195_898n, 10_000_000n)).toBe(9_195_898n);
    expect(sharesForAmount(99_000_000n, 9_195_898n, 10_000_000n)).toBe(9_195_898n);
  });
  it('empty position → 0', () => {
    expect(sharesForAmount(1n, 0n, 0n)).toBe(0n);
  });
});

describe('checkDepositAuth', () => {
  const want = { vault: VAULT, asset: USDC, from: ME, amount: 10_000_000n };
  it('accepts exactly deposit + one transfer wallet → vault', () => {
    expect(checkDepositAuth(depositTree(), want)).toBeNull();
  });
  it('rejects a transfer to anyone but the vault', () => {
    expect(checkDepositAuth(depositTree(10_000_000n, EVIL), want)).toMatch(/wallet → vault/);
  });
  it('rejects a different amount', () => {
    expect(checkDepositAuth(depositTree(20_000_000n), want)).toMatch(/amount/);
  });
  it('rejects an extra sub-invocation', () => {
    const t = depositTree();
    t[0].sub.push(call(USDC, 'approve', [ME, EVIL, 1n]));
    expect(checkDepositAuth(t, want)).toMatch(/1 transfer/);
  });
  it('rejects a second authorization entry', () => {
    expect(checkDepositAuth([...depositTree(), call(USDC, 'transfer', [ME, EVIL, 1n])], want)).toMatch(/1 authorization/);
  });
  it('rejects a call on another contract', () => {
    const t = [call(EVIL, 'deposit', [[10_000_000n], [9_950_000n], ME, true], depositTree()[0].sub)];
    expect(checkDepositAuth(t, want)).toMatch(/unexpected call/);
  });
  it('rejects a deposit from another account', () => {
    const t = [call(VAULT, 'deposit', [[10_000_000n], [9_950_000n], EVIL, true], [call(USDC, 'transfer', [ME, VAULT, 10_000_000n])])];
    expect(checkDepositAuth(t, want)).toMatch(/not from your wallet/);
  });
  it('rejects a transfer out of another account', () => {
    expect(checkDepositAuth([call(VAULT, 'deposit', [[10_000_000n], [9_950_000n], ME, true], [call(USDC, 'transfer', [EVIL, VAULT, 10_000_000n])])], want))
      .toMatch(/wallet → vault/);
  });
  it('rejects a transfer that carries nested calls', () => {
    const t = depositTree();
    t[0].sub[0].sub.push(call(USDC, 'approve', [ME, EVIL, 1n]));
    expect(checkDepositAuth(t, want)).toMatch(/extra calls/);
  });
  it('rejects non-source credentials', () => {
    const t = depositTree();
    t[0].credentials = 'address';
    expect(checkDepositAuth(t, want)).toMatch(/your own signature/);
  });
});

describe('checkWithdrawAuth', () => {
  const want = { vault: VAULT, from: ME, shares: 1_000_000n };
  it('accepts a bare vault withdraw', () => {
    expect(checkWithdrawAuth([call(VAULT, 'withdraw', [1_000_000n, [1_082_000n], ME])], want)).toBeNull();
  });
  it('rejects any sub-invocation (nothing may leave the wallet)', () => {
    const t = [call(VAULT, 'withdraw', [1_000_000n, [1_082_000n], ME], [call(USDC, 'transfer', [ME, EVIL, 5n])])];
    expect(checkWithdrawAuth(t, want)).toMatch(/extra calls/);
  });
  it('rejects another contract or function', () => {
    expect(checkWithdrawAuth([call(EVIL, 'withdraw', [1_000_000n, [1n], ME])], want)).toMatch(/unexpected call/);
    expect(checkWithdrawAuth([call(VAULT, 'deposit', [1_000_000n, [1n], ME])], want)).toMatch(/unexpected call/);
  });
  it('rejects a withdraw from another account', () => {
    expect(checkWithdrawAuth([call(VAULT, 'withdraw', [1_000_000n, [1n], EVIL])], want)).toMatch(/not from your wallet/);
  });
  it('rejects a share amount other than the quote', () => {
    expect(checkWithdrawAuth([call(VAULT, 'withdraw', [9_000_000n, [1n], ME])], want)).toMatch(/share amount/);
  });
});
