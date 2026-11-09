/**
 * Live mainnet check of lib/stellar/defindex.ts — reads + build/simulate/auth-check only,
 * nothing is signed or submitted. Opt-in: STELLAR_LIVE=1 npx vitest run __tests__/stellar-defindex.live.test.ts
 * Set STELLAR_DEPOSITOR (a mainnet account holding ≥1 USDC) and STELLAR_SHAREHOLDER (an account holding vault shares).
 */
import { describe, expect, it } from 'vitest';
import { TransactionBuilder, Networks } from '@stellar/stellar-sdk';
import { STELLAR_VAULTS, prepareDeposit, prepareWithdraw, readPosition, readVault } from '@/lib/stellar/defindex';

const VAULT = STELLAR_VAULTS[0].address;
const DEPOSITOR = process.env.STELLAR_DEPOSITOR ?? '';
const SHAREHOLDER = process.env.STELLAR_SHAREHOLDER ?? '';

describe.skipIf(!process.env.STELLAR_LIVE || !DEPOSITOR || !SHAREHOLDER)('DeFindex mainnet (live, read-only)', () => {
  it('reads the vault', async () => {
    const v = await readVault(VAULT);
    expect(v.tvl).toBeGreaterThan(0n);
    expect(v.strategies.length).toBeGreaterThan(0);
    console.log(v.name, v.apy, v.tvl, v.strategies);
  }, 60_000);

  it('builds a 1 USDC deposit whose auth passes the check', async () => {
    const p = await prepareDeposit(DEPOSITOR, VAULT, 10_000_000n);
    expect(p.expected).toBeGreaterThan(0n);
    const tx = TransactionBuilder.fromXDR(p.xdr, Networks.PUBLIC);
    expect(tx.hash().toString('hex')).toBe(p.hash);
    console.log('deposit shares', p.expected, 'fee', p.fee);
  }, 60_000);

  it('builds a withdraw of 0.10 USDC whose auth passes the check', async () => {
    const pos = await readPosition(VAULT, SHAREHOLDER);
    expect(pos.shares).toBeGreaterThan(0n);
    const p = await prepareWithdraw(SHAREHOLDER, VAULT, 1_000_000n, pos);
    expect(p.expected).toBeGreaterThanOrEqual(990_000n);
    console.log('withdraw out', p.expected, 'fee', p.fee);
  }, 60_000);
});
