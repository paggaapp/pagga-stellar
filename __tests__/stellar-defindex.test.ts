// @vitest-environment node
// (jsdom swaps the global Uint8Array for its own realm's, which the SDK's ed25519 signer rejects.)
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The money-safety guards in lib/stellar/defindex.ts, offline: the wallet must sign exactly
// what we built, and submit() may resolve only on SUCCESS — every uncertain outcome is
// Pending, only a definitive network answer is NotApplied.

const fake = vi.hoisted(() => ({
  send: vi.fn(),
  get: vi.fn(),
  sign: vi.fn(),
}));

vi.mock('@stellar/freighter-api', () => ({
  signTransaction: (...a: any[]) => fake.sign(...a),
  getAddress: vi.fn(), getNetwork: vi.fn(), isAllowed: vi.fn(), isConnected: vi.fn(), requestAccess: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', async importOriginal => {
  const sdk: any = await importOriginal();
  class FakeServer {
    sendTransaction(...a: any[]) { return fake.send(...a); }
    getTransaction(...a: any[]) { return fake.get(...a); }
  }
  return { ...sdk, rpc: { ...sdk.rpc, Server: FakeServer } };
});

import { Account, Address, Asset, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { NotAppliedError, PendingError, authCalls, checkTransaction, signPrepared, submit, type Prepared } from '@/lib/stellar/defindex';
import { checkDepositAuth } from '@/lib/stellar/defindex-core';

const kp = Keypair.random();
const ME = kp.publicKey();
const VAULT = 'CCA2ZJP5BVRXYTQH4FAGHCAUMRYCXVC4CRYC2NXHWMR7TIVX36U7F5HR';
const USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';

function signedTx({ seq = '1', maxTimeOffset }: { seq?: string; maxTimeOffset?: number } = {}) {
  const b = new TransactionBuilder(new Account(ME, seq), { fee: '100', networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.payment({ destination: ME, asset: Asset.native(), amount: '1' }));
  if (maxTimeOffset === undefined) b.setTimeout(300);
  else b.setTimebounds(0, Math.floor(Date.now() / 1000) + maxTimeOffset);
  const tx = b.build();
  tx.sign(kp);
  return tx;
}

beforeEach(() => {
  fake.send.mockReset();
  fake.get.mockReset();
  fake.sign.mockReset();
});

describe('signPrepared', () => {
  const tx = signedTx();
  const prepared: Prepared = { xdr: tx.toXDR(), hash: tx.hash().toString('hex'), expected: 0n, fee: 100n, maxTime: 0 };

  it('returns the wallet signature when it signed what we built', async () => {
    fake.sign.mockResolvedValue({ signedTxXdr: tx.toXDR(), signerAddress: ME });
    expect(await signPrepared(prepared, ME)).toBe(tx.toXDR());
  });
  it('refuses a different transaction from the wallet', async () => {
    fake.sign.mockResolvedValue({ signedTxXdr: signedTx({ seq: '7' }).toXDR(), signerAddress: ME });
    await expect(signPrepared(prepared, ME)).rejects.toThrow(/different transaction/);
  });
  it('refuses a signature from another account', async () => {
    fake.sign.mockResolvedValue({ signedTxXdr: tx.toXDR(), signerAddress: Keypair.random().publicKey() });
    await expect(signPrepared(prepared, ME)).rejects.toThrow(/different account/);
  });
  it('a cancelled signature is an error, not a send', async () => {
    fake.sign.mockResolvedValue({ signedTxXdr: '', signerAddress: '', error: { message: 'User declined' } });
    await expect(signPrepared(prepared, ME)).rejects.toThrow(/declined/);
  });
});

describe('submit', () => {
  const xdrOk = () => signedTx().toXDR();

  it('resolves only on SUCCESS, after transient poll errors', async () => {
    fake.send.mockResolvedValue({ status: 'PENDING', hash: 'h' });
    fake.get.mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce({ status: 'NOT_FOUND' }).mockResolvedValue({ status: 'SUCCESS' });
    const tx = signedTx();
    expect(await submit(tx.toXDR(), { pollMs: 1 })).toBe(tx.hash().toString('hex'));
  });
  it('a refusal at submit is NotApplied', async () => {
    fake.send.mockResolvedValue({ status: 'ERROR' });
    await expect(submit(xdrOk(), { pollMs: 1 })).rejects.toBeInstanceOf(NotAppliedError);
    fake.send.mockResolvedValue({ status: 'TRY_AGAIN_LATER' });
    await expect(submit(xdrOk(), { pollMs: 1 })).rejects.toBeInstanceOf(NotAppliedError);
  });
  it('a network error at submit is Pending with the real hash (it may have reached the node)', async () => {
    fake.send.mockRejectedValue(new Error('socket hang up'));
    const tx = signedTx();
    const e = await submit(tx.toXDR(), { pollMs: 1 }).catch(x => x);
    expect(e).toBeInstanceOf(PendingError);
    expect(e.hash).toBe(tx.hash().toString('hex'));
  });
  it('FAILED on-chain is NotApplied', async () => {
    fake.send.mockResolvedValue({ status: 'PENDING' });
    fake.get.mockResolvedValue({ status: 'FAILED' });
    await expect(submit(xdrOk(), { pollMs: 1 })).rejects.toBeInstanceOf(NotAppliedError);
  });
  it('NOT_FOUND from a ledger that closed after maxTime is NotApplied (expired)', async () => {
    fake.send.mockResolvedValue({ status: 'PENDING' });
    const tx = signedTx({ maxTimeOffset: 60 });
    const maxTime = Number(tx.timeBounds!.maxTime);
    fake.get.mockResolvedValueOnce({ status: 'NOT_FOUND', latestLedgerCloseTime: maxTime - 5, oldestLedgerCloseTime: 0 })
      .mockResolvedValue({ status: 'NOT_FOUND', latestLedgerCloseTime: maxTime + 1, oldestLedgerCloseTime: 0 });
    await expect(submit(tx.toXDR(), { pollMs: 1 })).rejects.toThrow(/expired/);
  });
  it('past expiry but outside the RPC history window is "final", never "nothing moved"', async () => {
    const maxTime = 1_800_000_000;
    fake.get.mockResolvedValue({ status: 'NOT_FOUND', latestLedgerCloseTime: maxTime + 9_000, oldestLedgerCloseTime: maxTime + 1 });
    expect(await checkTransaction('ab'.repeat(32), maxTime)).toBe('final');
    fake.get.mockResolvedValue({ status: 'NOT_FOUND', latestLedgerCloseTime: maxTime + 10, oldestLedgerCloseTime: maxTime - 7_200 });
    expect(await checkTransaction('ab'.repeat(32), maxTime)).toEqual({ notApplied: expect.stringMatching(/expired/) });
  });
  it('NOT_FOUND by the client clock alone is never "expired" — the network clock decides', async () => {
    fake.send.mockResolvedValue({ status: 'PENDING' });
    const tx = signedTx({ maxTimeOffset: -59 }); // our deadline (maxTime + 60 s) is ~1 s away
    fake.get.mockResolvedValue({ status: 'NOT_FOUND', latestLedgerCloseTime: Number(tx.timeBounds!.maxTime) - 1 });
    await expect(submit(tx.toXDR(), { pollMs: 10 })).rejects.toBeInstanceOf(PendingError);
  });
  it('one NOT_FOUND then an RPC outage until the deadline stays Pending (it may have landed)', async () => {
    fake.send.mockResolvedValue({ status: 'PENDING' });
    const tx = signedTx({ maxTimeOffset: -59 });
    fake.get.mockResolvedValueOnce({ status: 'NOT_FOUND', latestLedgerCloseTime: 0 }).mockRejectedValue(new Error('429'));
    const e = await submit(tx.toXDR(), { pollMs: 10 }).catch(x => x);
    expect(e).toBeInstanceOf(PendingError);
    expect(e.maxTime).toBe(Number(tx.timeBounds!.maxTime));
  });
});

describe('authCalls', () => {
  it('maps a real XDR auth entry to the tree the deposit check accepts', () => {
    const contractFn = (contract: string, fn: string, args: xdr.ScVal[]) =>
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(), functionName: fn, args,
      }));
    const transfer = new xdr.SorobanAuthorizedInvocation({
      function: contractFn(USDC, 'transfer', [new Address(ME).toScVal(), new Address(VAULT).toScVal(), nativeToScVal(10_000_000n, { type: 'i128' })]),
      subInvocations: [],
    });
    const root = new xdr.SorobanAuthorizedInvocation({
      function: contractFn(VAULT, 'deposit', [
        nativeToScVal([10_000_000n], { type: ['i128'] }), nativeToScVal([9_950_000n], { type: ['i128'] }),
        new Address(ME).toScVal(), nativeToScVal(true),
      ]),
      subInvocations: [transfer],
    });
    const entry = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: root });
    const tree = authCalls([entry]);
    expect(tree[0]).toMatchObject({ credentials: 'source', contract: VAULT, fn: 'deposit' });
    expect(checkDepositAuth(tree, { vault: VAULT, asset: USDC, from: ME, amount: 10_000_000n })).toBeNull();
  });
});
