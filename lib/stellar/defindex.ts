/**
 * DeFindex on Stellar mainnet — non-custodial deposit/withdraw, entirely client-side.
 *
 * The user's own Stellar wallet (Freighter) signs. This module builds the vault call,
 * simulates it, refuses to continue unless the authorization tree is exactly the call the
 * user asked for (defindex-core.ts) and the fee and price are sane, hands the XDR to the
 * wallet, checks the wallet signed that same transaction, submits it, and only reports
 * success after the network says SUCCESS. No Pagga server or key is involved.
 *
 * Import lazily via lib/stellar/load.ts: the SDK is large.
 */
import {
  Account, Address, Contract, Networks, TransactionBuilder, nativeToScVal, rpc, scValToNative, xdr,
} from '@stellar/stellar-sdk';
import {
  getAddress, getNetwork, isAllowed, isConnected, requestAccess, signTransaction,
} from '@stellar/freighter-api';
import {
  MAX_FEE_STROOPS, checkDepositAuth, checkWithdrawAuth, formatXlm, minAfterSlippage, minSharesForDeposit,
  sharesForAmount, type AuthCall,
} from './defindex-core';

const RPC_URL = process.env.NEXT_PUBLIC_STELLAR_SOROBAN_RPC_URL || 'https://mainnet.sorobanrpc.com';
const PASSPHRASE = Networks.PUBLIC;
const DEFINDEX_API = 'https://api.defindex.io';

/** Circle USDC on Stellar mainnet: the Stellar Asset Contract for USDC:GA5ZSE…KZVN. */
export const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
/** Any existing account works as the source of a read-only simulation; this is Circle's issuer. */
const READ_SOURCE = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Vaults we offer. Only allow-listed contracts can ever be called from this module. */
export const STELLAR_VAULTS = [
  { address: 'CCA2ZJP5BVRXYTQH4FAGHCAUMRYCXVC4CRYC2NXHWMR7TIVX36U7F5HR', asset: 'USDC' as const },
];
const allowed = (vault: string) => STELLAR_VAULTS.some(v => v.address === vault);

// Every RPC call gets a timeout: a hung request must never strand a signed transaction's UI.
const server = new rpc.Server(RPC_URL, { timeout: 15_000 });

/** Signed transactions stay valid this long. Short, so a simulated price can't go stale for long. */
const TX_VALID_SECONDS = 120;

// ── reads ────────────────────────────────────────────────────────────────────

async function read(contract: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(READ_SOURCE, '0'), { fee: '100', networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contract).call(method, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error.split('\n')[0]}`);
  return scValToNative(sim.result!.retval);
}

const i128 = (v: bigint) => nativeToScVal(v, { type: 'i128' });
const i128Vec = (v: bigint) => nativeToScVal([v], { type: ['i128'] });
const addr = (a: string) => new Address(a).toScVal();
const big = (v: unknown) => BigInt(String(v));

type ManagedFunds = { total_amount: unknown; strategy_allocations: { strategy_address: string; amount: unknown }[] }[];

export interface StellarVaultInfo {
  address: string;
  name: string;
  /** Total USDC under management, stroops. */
  tvl: bigint;
  /** Percent, e.g. 5.11. null when the DeFindex API is unreachable or malformed. */
  apy: number | null;
  strategies: { name: string; paused: boolean; share: number }[];
}

async function fetchApy(vault: string): Promise<number | null> {
  try {
    const r = await fetch(`${DEFINDEX_API}/vault/discover`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = (await r.json()) as { vaults?: { address: string; apy: unknown }[] };
    const apy = d?.vaults?.find(v => v.address === vault)?.apy;
    return typeof apy === 'number' && Number.isFinite(apy) ? apy : null;
  } catch { return null; }
}

export async function readVault(vault: string): Promise<StellarVaultInfo> {
  const [name, assets, funds, apy] = await Promise.all([
    read(vault, 'name'),
    read(vault, 'get_assets'),
    read(vault, 'fetch_total_managed_funds'),
    fetchApy(vault),
  ]);
  const f = (funds as ManagedFunds)[0];
  const tvl = big(f.total_amount);
  const strategies = ((assets as { strategies: { address: string; name: string; paused: boolean }[] }[])[0]?.strategies ?? [])
    .map(s => {
      const alloc = f.strategy_allocations.find(a => a.strategy_address === s.address);
      const amt = alloc ? big(alloc.amount) : 0n;
      return { name: s.name, paused: s.paused, share: tvl > 0n ? Number((amt * 10_000n) / tvl) / 100 : 0 };
    });
  return { address: vault, name: String(name), tvl, apy, strategies };
}

export interface StellarPosition {
  shares: bigint;
  /** Shares valued in USDC, stroops. */
  underlying: bigint;
  /** USDC sitting in the wallet, stroops. null = no USDC trustline. */
  walletUsdc: bigint | null;
}

/** The USDC SAC answers Error(Contract, #13) for an account with no USDC trustline. */
const isMissingTrustline = (e: unknown) => /Error\(Contract, #13\)/.test(String((e as Error)?.message));

export async function readPosition(vault: string, account: string): Promise<StellarPosition> {
  const [shares, walletUsdc] = await Promise.all([
    read(vault, 'balance', [addr(account)]).then(big),
    read(USDC_SAC, 'balance', [addr(account)]).then(big).catch(e => {
      if (isMissingTrustline(e)) return null;
      throw e;
    }),
  ]);
  const underlying = shares > 0n ? big((await read(vault, 'get_asset_amounts_per_shares', [i128(shares)]) as unknown[])[0]) : 0n;
  return { shares, underlying, walletUsdc };
}

// ── wallet (Freighter) ───────────────────────────────────────────────────────

export class WalletError extends Error {}
export class WalletNotInstalledError extends WalletError {
  constructor() { super('Freighter is not installed.'); }
}

/** Returns the connected mainnet address without prompting, or null. */
export async function silentWallet(): Promise<string | null> {
  try {
    if (!(await isConnected()).isConnected) return null;
    if (!(await isAllowed()).isAllowed) return null;
    if ((await getNetwork()).networkPassphrase !== PASSPHRASE) return null;
    const { address, error } = await getAddress();
    return error || !address ? null : address;
  } catch { return null; }
}

export async function connectWallet(): Promise<string> {
  const c = await isConnected();
  if (!c.isConnected) throw new WalletNotInstalledError();
  const { address, error } = await requestAccess();
  if (error || !address) throw new WalletError(error?.message || 'Wallet access was declined.');
  const net = await getNetwork();
  if (net.networkPassphrase !== PASSPHRASE) throw new WalletError('Switch Freighter to Mainnet, then connect again.');
  return address;
}

// ── build + sign + submit ────────────────────────────────────────────────────

/** XDR auth entries → plain tree for the checks in defindex-core. */
export function authCalls(auth: xdr.SorobanAuthorizationEntry[]): AuthCall[] {
  const walk = (inv: xdr.SorobanAuthorizedInvocation): AuthCall => {
    const fn = inv.function();
    const sub = inv.subInvocations().map(walk);
    if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') {
      return { credentials: 'other', contract: '', fn: fn.switch().name, args: [], sub };
    }
    const c = fn.contractFn();
    return {
      credentials: 'other',
      contract: Address.fromScAddress(c.contractAddress()).toString(),
      fn: c.functionName().toString(),
      args: c.args().map(a => scValToNative(a)),
      sub,
    };
  };
  return auth.map(e => {
    const kind = e.credentials().switch().name;
    return {
      ...walk(e.rootInvocation()),
      credentials: kind === 'sorobanCredentialsSourceAccount' ? 'source' : kind === 'sorobanCredentialsAddress' ? 'address' : 'other',
    };
  });
}

export interface Prepared {
  xdr: string;
  hash: string;
  /** Deposit: shares minted. Withdraw: USDC returned. Stroops, from the simulation. */
  expected: bigint;
  /** Network fee, stroops of XLM (paid by the wallet). */
  fee: bigint;
  /** Unix seconds after which the network will never apply it. */
  maxTime: number;
}

type Method = 'deposit' | 'withdraw';

async function prepare(
  account: string,
  vault: string,
  method: Method,
  args: xdr.ScVal[],
  check: (a: AuthCall[]) => string | null,
  expected: (ret: unknown) => bigint,
): Promise<Prepared> {
  if (!allowed(vault)) throw new Error('This vault is not on the allow-list.');
  const src = await server.getAccount(account).catch((e: Error) => {
    if (/Account not found/.test(e?.message)) throw new Error('This Stellar account is not active on mainnet — fund it with XLM first.');
    throw e;
  });
  const raw = new TransactionBuilder(src, { fee: '1000', networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(vault).call(method, ...args)).setTimeout(TX_VALID_SECONDS).build();
  const sim = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(sim)) throw new Error(simulationMessage(method, sim.error));
  const bad = check(authCalls(sim.result!.auth));
  if (bad) throw new Error(`Refused to sign: ${bad}.`);
  const tx = rpc.assembleTransaction(raw, sim).build();
  const fee = BigInt(tx.fee);
  if (fee > MAX_FEE_STROOPS) throw new Error(`Refused to sign: the network fee (${formatXlm(fee)}) is far above normal. Try again later.`);
  return {
    xdr: tx.toXDR(), hash: tx.hash().toString('hex'), expected: expected(scValToNative(sim.result!.retval)), fee,
    maxTime: Number(tx.timeBounds?.maxTime ?? 0),
  };
}

function simulationMessage(method: Method, e: string): string {
  if (method === 'withdraw' && /InsufficientOutputAmount/.test(e)) {
    return "The vault can't release this amount right now. Try a smaller amount or later.";
  }
  if (/Error\(Contract, #13\)|Error\(Contract, #10\)/.test(e)) return 'Your wallet does not hold enough USDC for this.';
  return `The network rejected this transaction in simulation: ${e.split('\n')[0]}`;
}

export async function prepareDeposit(account: string, vault: string, amount: bigint) {
  const [supply, funds] = await Promise.all([read(vault, 'total_supply'), read(vault, 'fetch_total_managed_funds')]);
  const minShares = minSharesForDeposit(amount, big(supply), big((funds as ManagedFunds)[0].total_amount));
  const p = await prepare(
    account, vault, 'deposit',
    [i128Vec(amount), i128Vec(minAfterSlippage(amount)), addr(account), nativeToScVal(true)],
    a => checkDepositAuth(a, { vault, asset: USDC_SAC, from: account, amount }),
    ret => big((ret as unknown[])[1]),
  );
  if (p.expected < minShares) throw new Error('Refused to sign: the vault would mint fewer shares than its current price. Try again later.');
  return p;
}

/** `amount` in USDC stroops; pass the whole position's value to withdraw everything. */
export async function prepareWithdraw(account: string, vault: string, amount: bigint, position: StellarPosition) {
  const shares = sharesForAmount(amount, position.shares, position.underlying);
  if (shares <= 0n) throw new Error('Nothing to withdraw.');
  const quote = big((await read(vault, 'get_asset_amounts_per_shares', [i128(shares)]) as unknown[])[0]);
  const minOut = minAfterSlippage(quote);
  const p = await prepare(
    account, vault, 'withdraw',
    [i128(shares), i128Vec(minOut), addr(account)],
    a => checkWithdrawAuth(a, { vault, from: account, shares }),
    ret => big((ret as unknown[])[0]),
  );
  if (p.expected < minOut) throw new Error("The vault can't release this amount right now. Try a smaller amount or later.");
  return p;
}

/** Wallet signs; we verify it signed exactly what we built, as the connected account. */
export async function signPrepared(p: Prepared, account: string): Promise<string> {
  const res = await signTransaction(p.xdr, { networkPassphrase: PASSPHRASE, address: account });
  if (res.error || !res.signedTxXdr) throw new WalletError(res.error?.message || 'Signing was cancelled.');
  if (res.signerAddress && res.signerAddress !== account) {
    throw new WalletError('Freighter signed with a different account. Reconnect and try again.');
  }
  const signed = TransactionBuilder.fromXDR(res.signedTxXdr, PASSPHRASE);
  if (signed.hash().toString('hex') !== p.hash) throw new Error('The wallet returned a different transaction. Nothing was sent.');
  return res.signedTxXdr;
}

/** The network definitively did not apply the transaction. The USDC did not move. */
export class NotAppliedError extends Error {}

/** Submitted; the outcome is not known yet. The hash is real — check it before trying again. */
export class PendingError extends Error {
  constructor(public hash: string, public maxTime: number) { super('Submitted, not confirmed yet.'); }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * 'final' = it can no longer land, but this RPC's history no longer covers its window, so
 * whether it landed is unknown here — the balances on chain and the explorer are the truth.
 */
export type TxOutcome = 'success' | 'pending' | 'final' | { notApplied: string };

/**
 * One look at a submitted transaction. "Not applied" only on the network's own word: FAILED,
 * or NOT_FOUND from an RPC whose history covers the transaction's whole validity window and
 * whose latest ledger closed after its maxTime. Any error, or NOT_FOUND before expiry, is 'pending'.
 */
export async function checkTransaction(hash: string, maxTime: number): Promise<TxOutcome> {
  let r: rpc.Api.GetTransactionResponse;
  try { r = await server.getTransaction(hash); } catch { return 'pending'; }
  if (r.status === rpc.Api.GetTransactionStatus.SUCCESS) return 'success';
  if (r.status === rpc.Api.GetTransactionStatus.FAILED) {
    return { notApplied: 'The transaction failed on-chain. Your USDC did not move; the network fee was charged.' };
  }
  if (maxTime > 0 && Number(r.latestLedgerCloseTime) > maxTime) {
    // Validity window starts ≤ TX_VALID_SECONDS before maxTime; history must reach back that far.
    if (Number(r.oldestLedgerCloseTime) <= maxTime - TX_VALID_SECONDS) {
      return { notApplied: 'The transaction expired without landing. Nothing was moved.' };
    }
    return 'final';
  }
  return 'pending';
}

/**
 * Submits and waits for the ledger. Resolves with the hash only on SUCCESS. Throws
 * NotAppliedError only when the network has definitively not applied it (refused at submit,
 * FAILED, or expired by the network's clock); every uncertain outcome is a PendingError.
 */
export async function submit(signedXdr: string, opts: { pollMs?: number } = {}): Promise<string> {
  const pollMs = opts.pollMs ?? 2000;
  const tx = TransactionBuilder.fromXDR(signedXdr, PASSPHRASE);
  const hash = tx.hash().toString('hex');
  const maxTime = Number(('timeBounds' in tx ? tx.timeBounds?.maxTime : undefined) ?? 0);
  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await server.sendTransaction(tx);
  } catch {
    throw new PendingError(hash, maxTime); // the request may have reached the node
  }
  if (sent.status === 'ERROR') throw new NotAppliedError('The network refused the transaction. Nothing was moved.');
  if (sent.status === 'TRY_AGAIN_LATER') throw new NotAppliedError('The network is busy and did not accept the transaction. Nothing was moved — try again.');

  // Poll a little past expiry so the network's ledger clock can pass maxTime.
  const deadline = (maxTime > 0 ? maxTime + 60 : Date.now() / 1000 + TX_VALID_SECONDS + 60) * 1000;
  while (Date.now() < deadline) {
    const out = await checkTransaction(hash, maxTime);
    if (out === 'success') return hash;
    if (out === 'final') break; // can't land any more, outcome unknown here: report as pending
    if (out !== 'pending') throw new NotAppliedError(out.notApplied);
    await sleep(pollMs);
  }
  throw new PendingError(hash, maxTime);
}
