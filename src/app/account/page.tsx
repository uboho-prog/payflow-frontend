"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type ApiMandate, type ApiVaultEvent } from "@/lib/api";
import { buildUpcomingChargesCalendar, CALENDAR_FILENAME } from "@/lib/calendar";
import {
  chainMandatesOf,
  sortVaultEventsNewestFirst,
  vaultEventAmount,
  vaultEventLabel,
  vaultEventTone,
} from "@/lib/chain";
import { config } from "@/lib/config";
import {
  discountBadge,
  nextChargeAmount,
  remainingDiscountCharges,
} from "@/lib/discount";
import {
  mandateIsPastDue,
  mandatePastDueUntil,
  mandatePauseUntil,
  payflow,
  vaultSupportsDepositFor,
  validateRecipient,
} from "@/lib/payflow";
import { mandateStatus } from "@/lib/payflow";
import { useWallet } from "@/lib/wallet";
import {
  checkAmount,
  formatAmount,
  formatDate,
  formatPeriod,
  fromStroops,
  minPauseDate,
  parseAmount,
  parsePauseDate,
  resumeDate,
  shortAddress,
} from "@/lib/format";
import { buildChargeSchedule, chargeShortfall } from "@/lib/schedule";
import { describeTrialEnd } from "@/lib/trial";
import { metaFor, useTokenMetas } from "@/lib/token";
import { AmountInput } from "@/components/AmountInput";
import {
  Badge,
  Empty,
  MerchantAccount,
  Notice,
  Panel,
  SkeletonRows,
  Stat,
  TimeAgo,
  TxLink,
} from "@/components/ui";

export default function AccountPage() {
  const { address, networkMismatch, signXdr, connect, connecting } = useWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [mandates, setMandates] = useState<ApiMandate[] | null>(null);
  const [history, setHistory] = useState<ApiVaultEvent[] | null>(null);
  const [indexerAvailable, setIndexerAvailable] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Cancelling is permanent, so the first click only reveals Keep/Confirm.
  // One id, not a set: only one mandate can be awaiting confirmation at a
  // time, which keeps the destructive action unambiguous.
  const [confirmCancel, setConfirmCancel] = useState<number | null>(null);
  // The mandate whose date picker is open, and the date typed into it. Like
  // `confirmCancel`, one at a time keeps the pending write unambiguous.
  const [pauseFor, setPauseFor] = useState<number | null>(null);
  const [pauseDate, setPauseDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Whether the deployed vault contract supports depositing into another
  // account's vault (payflow-contract#29). null while the probe is in flight.
  const [fundSupport, setFundSupport] = useState<boolean | null>(null);
  const [fundRecipient, setFundRecipient] = useState("");
  const [fundAmount, setFundAmount] = useState("");
  // The recipient awaiting a second-click confirmation — one at a time.
  const [fundFor, setFundFor] = useState<string | null>(null);

  // The vault holds the configured token; each mandate carries the token it
  // was opened against, which the indexer does not report.
  const metas = useTokenMetas([
    config.contracts.token,
    ...(mandates ?? []).map((m) => m.token ?? config.contracts.token),
  ]);
  const vaultMeta = metaFor(metas, config.contracts.token);

  /** Whether the recipient address and amount are right to submit right now. */
  const recipientDisplayError = fundRecipient.trim()
    ? validateRecipient(fundRecipient)
    : null;
  const fundAmountCheck = checkAmount(fundAmount, vaultMeta.decimals);
  const fundStroops = fundAmountCheck.ok ? fundAmountCheck.stroops : 0n;

  const load = useCallback(async () => {
    if (!address) return;
    const [bal, res, hist] = await Promise.allSettled([
      payflow.vaultBalance(address, address, config.contracts.token),
      api.mandatesOf(address),
      api.vaultHistory(address),
    ]);
    if (bal.status === "fulfilled") setBalance(bal.value);

    if (res.status === "fulfilled" && res.value) {
      setMandates(res.value.mandates);
    } else {
      // No indexer: read the subscriber's mandates from the contract.
      try {
        setMandates(await chainMandatesOf(address, address));
      } catch {
        setMandates([]);
      }
    }

    // Vault history lives only in the indexer; without a backend there is no
    // contract-side event log to fall back to, so we report what is knowable.
    if (hist.status === "fulfilled" && hist.value) {
      setHistory(sortVaultEventsNewestFirst(hist.value.events));
      setIndexerAvailable(true);
    } else {
      setHistory([]);
      setIndexerAvailable(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  // A wallet switch mid-flow must not leave another account's mandate in the
  // confirming state.
  useEffect(() => {
    setConfirmCancel(null);
    setPauseFor(null);
    setFundFor(null);
  }, [address]);

  // Probe whether the deployed vault contract carries deposit_for. The sponsor
  // control stays hidden until the contract answers: a contract that predates
  // payflow-contract#29 cannot service the write, so offering it would only
  // fail at signing time.
  useEffect(() => {
    if (!address) {
      setFundSupport(null);
      return;
    }
    let live = true;
    void vaultSupportsDepositFor(address).then((supported) => {
      if (live) setFundSupport(supported);
    });
    return () => {
      live = false;
    };
  }, [address]);

  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  /** Reveal Keep/Confirm for the sponsor deposit. One recipient at a time. */
  async function fundAnother() {
    if (recipientDisplayError || !fundAmountCheck.ok) return;
    setFundFor(fundRecipient.trim());
  }

  async function fundConfirmed() {
    if (!address || !signXdr || !fundFor || !fundAmountCheck.ok) return;
    await run(`fund-for-${fundFor}`, () =>
      payflow.depositFor(address, signXdr, fundFor, config.contracts.token, fundAmountCheck.stroops),
    );
    setFundFor(null);
    setFundRecipient("");
    setFundAmount("");
  }

  async function handleCancelAll() {
    if (!address) return;

    const allMandates = await chainMandatesOf(address, address);
    const toCancel = allMandates.filter((m) =>
      mandateStatus(m.status) === "Active" || mandateStatus(m.status) === "Paused",
    );

    if (toCancel.length === 0) {
      setError("No active or paused mandates to cancel.");
      return;
    }

    if (!window.confirm(`This will cancel ${toCancel.length} mandate${toCancel.length !== 1 ? "s" : ""}. Continue?`)) {
      return;
    }

    setBusy("cancel-all");
    setError(null);
    setDone(null);

    const PAGE_SIZE = 50;
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < toCancel.length; i += PAGE_SIZE) {
      const page = toCancel.slice(i, i + PAGE_SIZE);
      const promises = page.map((m) =>
        payflow.cancel(address, signXdr, m.id).then(() => {
          completed += 1;
        }).catch((err) => {
          failed += 1;
          setError(
            err instanceof Error ? err.message : String(err),
          );
        }),
      );
      await Promise.all(promises);
    }

    const result = completed
      ? `Cancelled ${completed} mandate${completed !== 1 ? "s" : ""}${
          failed > 0 ? ` (${failed} failed)` : ""
        }`
      : "No mandates were cancelled";

    setDone(result);
    await load();
    setBusy(null);
  }

  const activeCount = mandates?.filter((m) => m.status === "Active").length ?? 0;

  /**
   * Whether the contract behind these mandates can service a dated pause.
   *
   * A contract built before payflow-contract#41 decodes its mandates without
   * `pause_until`, so the absence of that field is the signal; there is no
   * method to probe. Checking the mandates already on screen costs no extra
   * round trip. With an indexer configured, it has to serve the field too —
   * when it cannot, hiding the control is still the honest choice, because
   * offering it would send a transaction the deployed contract may reject.
   */
  const pauseSupported = (mandates ?? []).some(
    (m) => mandatePauseUntil(m) !== null,
  );

  function openPausePicker(mandateId: number) {
    setPauseFor(mandateId);
    // Default to a week out: long enough to be the common case, short enough
    // that the user can still see what they picked.
    const week = new Date(Date.now() + 7 * 86_400_000);
    setPauseDate(week.toISOString().slice(0, 10));
    setConfirmCancel(null);
    setError(null);
  }

  async function pauseUntil(mandateId: number) {
    if (!address) return;
    const until = parsePauseDate(pauseDate);
    if (until === null) {
      setError("Pick a date for the mandate to resume on.");
      return;
    }
    if (until * 1000 <= Date.now()) {
      setError("Pick a date in the future.");
      return;
    }
    await run(`pause-until-${mandateId}`, () =>
      payflow.pauseUntil(address, signXdr, mandateId, until),
    );
    setPauseFor(null);
  }

  /**
   * The .ics is generated in the browser from the same mandates shown on this
   * page, so the calendar also works when the indexer is unreachable and the
   * list came from contract state.
   */
  function downloadCalendar() {
    if (!mandates) return;
    try {
      const calendar = buildUpcomingChargesCalendar(mandates);
      const blob = new Blob([calendar], { type: "text/calendar;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = CALENDAR_FILENAME;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoke after the browser has started the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the calendar file.");
    }
  }

  if (!address) {
    return (
      <Panel title="My account">
        <Empty
          title="No wallet connected"
          action={
            <button
              type="button"
              className="btn-primary"
              disabled={connecting}
              onClick={() => void connect()}
            >
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          }
        >
          Connect a wallet to see your vault balance, fund it, and manage your
          subscriptions. Nothing is sent to the network until you approve a
          transaction in your wallet.
        </Empty>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Vault balance"
          loading={balance === null}
          value={`${fromStroops(balance ?? 0n, 4, vaultMeta.decimals)} ${vaultMeta.symbol}`}
          hint="Available to be charged"
        />
        <Stat
          label="Active subscriptions"
          loading={mandates === null}
          value={activeCount}
        />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {done && (
        <Notice tone="ok">
          Done. Transaction <TxLink hash={done} />
        </Notice>
      )}

      <Panel
        title="Fund your vault"
        subtitle="Charges are debited from this balance. Withdraw at any time — nothing is locked."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem] flex-1">
            <AmountInput
              id="amount"
              label={`Amount (${vaultMeta.symbol})`}
              value={amount}
              onChange={setAmount}
              decimals={vaultMeta.decimals}
              placeholder="5.0"
              disabled={busy !== null}
              hint="Accepts 5, 5.0 — and 5,0 where commas are decimals."
            />
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={busy !== null || networkMismatch}
            onClick={() =>
              void run("deposit", () =>
                payflow.deposit(
                  address,
                  signXdr,
                  config.contracts.token,
                  parseAmount(amount, vaultMeta.decimals),
                ),
              )
            }
          >
            {busy === "deposit" ? "Depositing…" : "Deposit"}
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null || networkMismatch}
            onClick={() =>
              void run("withdraw", () =>
                payflow.withdraw(
                  address,
                  signXdr,
                  config.contracts.token,
                  parseAmount(amount, vaultMeta.decimals),
                ),
              )
            }
          >
            {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
          </button>
        </div>
      </Panel>

      {fundSupport === true && (
        <Panel
          title="Fund another account"
          subtitle="Send tokens to someone else's vault. Only the recipient can withdraw — you cannot cancel or refund the deposit."
        >
          {fundFor ? (
            <div className="space-y-3">
              <p className="text-sm">
                <span className="font-mono truncate">{shortAddress(address)}</span>{" "}
                pays{" "}
                <span className="font-medium">{formatAmount(fundStroops, vaultMeta)}</span>{" "}
                into <span className="font-mono truncate">{shortAddress(fundFor)}</span>{"'s vault"}
              </p>
              <p className="mt-1 text-xs text-muted">
                Only{" "}
                <span className="font-mono truncate">{shortAddress(fundFor)}</span> can withdraw
                it — you cannot cancel or refund this deposit.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy !== null || networkMismatch}
                  onClick={fundConfirmed}
                >
                  {busy === `fund-for-${fundFor}` ? "Funding…" : "Fund"}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy !== null}
                  onClick={() => setFundFor(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[14rem] flex-1">
                <label className="label" htmlFor="fund-recipient">
                  Recipient address
                </label>
                <input
                  id="fund-recipient"
                  className="input"
                  placeholder="GABC…"
                  value={fundRecipient}
                  onChange={(e) => setFundRecipient(e.target.value)}
                  aria-invalid={Boolean(recipientDisplayError)}
                  aria-describedby={recipientDisplayError ? "fund-recipient-error" : undefined}
                  disabled={busy !== null}
                />
                {recipientDisplayError && (
                  <p id="fund-recipient-error" className="mt-1 text-sm text-danger">
                    {recipientDisplayError}
                  </p>
                )}
              </div>
              <div className="min-w-[12rem] flex-1">
                <AmountInput
                  id="fund-amount"
                  label={`Amount (${vaultMeta.symbol})`}
                  value={fundAmount}
                  onChange={setFundAmount}
                  decimals={vaultMeta.decimals}
                  placeholder="5.0"
                  disabled={busy !== null}
                />
              </div>
              <button
                type="button"
                className="btn-primary"
                disabled={
                  busy !== null ||
                  networkMismatch ||
                  Boolean(recipientDisplayError) ||
                  !fundAmountCheck.ok
                }
                onClick={fundAnother}
              >
                {busy === "fund-another" ? "Funding…" : "Fund"}
              </button>
            </div>
          )}
        </Panel>
      )}

      <Panel
        title="Vault history"
        subtitle="Deposits, withdrawals and debits behind your balance."
      >
        {history === null ? (
          <Empty>Loading history…</Empty>
        ) : history.length === 0 ? (
          indexerAvailable ? (
            <Empty
              title="No vault activity yet"
              action={
                <a href="#amount" className="btn-primary">
                  Make a deposit
                </a>
              }
            >
              Deposits, withdrawals and debit charges appear here as they
              settle. Fund the vault above so charges have a balance to draw
              from.
            </Empty>
          ) : (
            // No indexer, no event log: the notice below says why there is
            // nothing to show. An empty list here would claim “no events”
            // when the truth is “no event source”.
            null
          )
        ) : (
          <div className="space-y-2">
            {history.map((event) => {
              const label = vaultEventLabel(event);
              const eventAmount = vaultEventAmount(event);
              const isCredit = vaultEventTone(event) === "ok";
              return (
                <div
                  key={event.tx_hash}
                  className="flex items-center justify-between gap-3 rounded-lg border border-edge p-3"
                  aria-label={`${label} ${eventAmount} ${vaultMeta.symbol}, ledger ${event.ledger}`}
                >
                  <div className="flex items-center gap-3 text-sm">
                    <span className="font-medium">{label}</span>
                    <span className="mono text-xs text-muted">tx</span>
                    <TxLink hash={event.tx_hash} />
                  </div>
                  <div className="text-right">
                    <span
                      className={`font-semibold tabular-nums ${
                        isCredit ? "text-accent" : "text-danger"
                      }`}
                    >
                      {eventAmount} {vaultMeta.symbol}
                    </span>
                    <div className="text-xs text-muted">ledger {event.ledger}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {history !== null && !indexerAvailable && (
          <Notice tone="info">
            Vault history is not available in contract-only mode. It requires
            the payflow-backend indexer (set NEXT_PUBLIC_API_URL). Deposits,
            withdrawals and debits still update your on-chain balance; only
            the event list is missing.
          </Notice>
        )}
      </Panel>

      <Panel
        title="My subscriptions"
        subtitle="Add the next charge of each active mandate to Google or Apple Calendar."
        actions={
          <button
            type="button"
            className="btn-ghost whitespace-nowrap"
            disabled={activeCount === 0}
            onClick={downloadCalendar}
            title={
              activeCount === 0
                ? "No active subscriptions to add"
                : "Download an .ics file for Google or Apple Calendar"
            }
          >
            Add to calendar
          </button>
        }
      >
        {mandates === null ? (
          <SkeletonRows rows={2} label="Loading subscriptions" />
        ) : mandates.length === 0 ? (
          <Empty
            title="No subscriptions yet"
            action={
              <Link href="/subscribe" className="btn-primary">
                Browse plans
              </Link>
            }
          >
            Subscribing to a plan opens a mandate, and every mandate shows up
            here with its next charge date. You can pause or cancel any of them
            from this page.
          </Empty>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null || networkMismatch}
                onClick={handleCancelAll}
              >
                {busy !== null || networkMismatch ? "Cancelling…" : "Cancel all"}
              </button>
            </div>
{mandates.map((m) => {
                const terminal = m.status === "Cancelled" || m.status === "Completed";
                const meta = metaFor(metas, m.token ?? config.contracts.token);
                const resumes = resumeDate(mandatePauseUntil(m));
                const pastDueUntil = mandatePastDueUntil(m);
                const isPastDue = mandateIsPastDue(m);
                const trial = describeTrialEnd(m);
                // What the next charge costs while the merchant's discount runs.
                const discounted = nextChargeAmount(m);
                const badge = discountBadge(m);
                const remaining = remainingDiscountCharges(m);
                // Both of these read from data the page already has, so the
                // timeline works in contract-only mode: the mandates may come
                // from chain state and the balance from a vault read.
                const schedule = buildChargeSchedule(m);
                const nextAmount = schedule.charges[0]?.amount;
                // `balance` is the configured token's vault balance. A mandate
                // denominated in another token cannot be compared against it, so
                // leave the warning out rather than reporting a false shortfall.
                const sameToken =
                  (m.token ?? config.contracts.token) === config.contracts.token;
                const shortfall =
                  nextAmount === undefined || !sameToken
                    ? null
                    : chargeShortfall(balance, nextAmount);
                // Past-due shortfall is the same as the next charge shortfall.
                const pastDueShortfall = isPastDue && sameToken && nextAmount !== undefined
                  ? chargeShortfall(balance, nextAmount)
                  : null;
                return (
                  <div key={m.id} className="rounded-lg border border-edge p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">Mandate #{m.id}</span>
                          <Badge status={m.status} />
                          {isPastDue && (
                            <span className="rounded-full bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger">
                              Past due
                            </span>
                          )}
                          {resumes && (
                            <span className="text-xs text-muted">resumes {resumes}</span>
                          )}
                          {pastDueUntil && (
                            <span className="text-xs text-muted">grace period ends {formatDate(pastDueUntil)}</span>
                          )}
                          {trial && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                              Free trial
                            </span>
                          )}
                          {badge && (
                            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                              {badge}
                            </span>
                          )}
                          {m.ended_by === "merchant" && (
                            <span className="text-xs text-muted">ended by the merchant</span>
                          )}
                        </div>
                        <div className="mt-1 text-sm text-muted">
                          {discounted !== null ? (
                            <>
                              <span className="font-medium text-fg">
                                {fromStroops(discounted, 4, meta.decimals)} {meta.symbol}
                              </span>{" "}
                              <span className="text-xs line-through">
                                {fromStroops(m.amount, 4, meta.decimals)} {meta.symbol}
                              </span>{" "}
                            </>
                          ) : (
                            <>
                              {fromStroops(m.amount, 4, meta.decimals)} {meta.symbol}{" "}
                            </>
                          )}
                          {formatPeriod(m.period)} · to <MerchantAccount value={m.merchant} />
                        </div>
                        {badge && (
                          <div className="mt-1 text-xs text-accent">
                            {discounted !== null ? (
                              <>
                                You pay {fromStroops(discounted, 4, meta.decimals)}{" "}
                                {meta.symbol} for the next charge
                                {remaining === null
                                  ? "."
                                  : remaining === 1
                                    ? ", then the full price."
                                    : `, then the full price. ${remaining} discounted charges left.`}
                              </>
                            ) : remaining === 0 ? (
                              <>The discount has run out — you pay the full price now.</>
                            ) : (
                              <>The merchant set a discount on this subscription.</>
                            )}
                          </div>
                        )}
                        <div className="mt-1 text-xs text-muted">
                          {m.charges_made} charge{m.charges_made === 1 ? "" : "s"} taken
                          {m.max_charges > 0 && ` of ${m.max_charges}`}
                          {" · next "}
                          {m.status === "Active" ? <TimeAgo value={m.next_charge} /> : "—"}
                        </div>
                        {trial && (
                          <div className="mt-1 text-xs text-accent">
                            {trial}. Cancel before then and you pay nothing.
                          </div>
                        )}
                        {isPastDue && pastDueShortfall !== null && (
                          <Notice tone="error">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div>
                                <p className="font-medium">
                                  This subscription is past due — your vault is short by{" "}
                                  {formatAmount(pastDueShortfall, meta)} for the next charge.
                                </p>
                                {pastDueUntil && (
                                  <p className="mt-1 text-xs text-muted">
                                    The grace period ends {formatDate(pastDueUntil)}. After that, the
                                    mandate may expire if the charge cannot be settled.
                                  </p>
                                )}
                              </div>
                              <button
                                type="button"
                                className="btn-primary whitespace-nowrap"
                                disabled={busy !== null || networkMismatch}
                                onClick={() =>
                                  void run(`deposit-past-due-${m.id}`, () =>
                                    payflow.deposit(
                                      address,
                                      signXdr,
                                      config.contracts.token,
                                      parseAmount(
                                        fromStroops(pastDueShortfall + 1n, 4, meta.decimals),
                                        meta.decimals,
                                      ),
                                    ),
                                  )
                                }
                              >
                                {busy === `deposit-past-due-${m.id}` ? "Depositing…" : "Deposit to fix"}
                              </button>
                            </div>
                          </Notice>
                        )}
                      </div>

                    {!terminal && (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={busy !== null || networkMismatch}
                          onClick={() =>
                            void run(`pause-${m.id}`, () =>
                              payflow.setPaused(
                                address,
                                signXdr,
                                m.id,
                                m.status === "Active",
                              ),
                            )
                          }
                        >
                          {m.status === "Active" ? "Pause" : "Resume"}
                        </button>
                        {/* Offered only against a contract that carries
                            pause_until; see `pauseSupported`. */}
                        {pauseSupported &&
                          (pauseFor === m.id ? (
                            <>
                              <label className="sr-only" htmlFor={`pause-until-${m.id}`}>
                                Resume date for mandate {m.id}
                              </label>
                              <input
                                id={`pause-until-${m.id}`}
                                type="date"
                                className="input"
                                min={minPauseDate()}
                                value={pauseDate}
                                disabled={busy !== null}
                                onChange={(e) => setPauseDate(e.target.value)}
                              />
                              <button
                                type="button"
                                className="btn-primary"
                                disabled={busy !== null || networkMismatch}
                                onClick={() => void pauseUntil(m.id)}
                              >
                                {busy === `pause-until-${m.id}` ? "Pausing…" : "Pause until…"}
                              </button>
                              <button
                                type="button"
                                className="btn-ghost"
                                disabled={busy !== null}
                                onClick={() => setPauseFor(null)}
                              >
                                Back
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={busy !== null || networkMismatch}
                              onClick={() => openPausePicker(m.id)}
                            >
                              Pause until…
                            </button>
                          ))}
                        {confirmCancel === m.id ? (
                          <>
                            <button
                              type="button"
                              className="btn-ghost"
                              disabled={busy !== null}
                              autoFocus
                              onClick={() => setConfirmCancel(null)}
                            >
                              Keep
                            </button>
                            <button
                              type="button"
                              className="btn-danger"
                              disabled={busy !== null || networkMismatch}
                              aria-label={`Confirm cancelling subscription #${m.id}`}
                              onClick={() =>
                                void run(`cancel-${m.id}`, () =>
                                  payflow.cancel(address, signXdr, m.id),
                                ).then(() => setConfirmCancel(null))
                              }
                            >
                              {busy === `cancel-${m.id}` ? "Cancelling…" : "Confirm"}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn-ghost text-danger"
                            disabled={busy !== null || networkMismatch}
                            aria-label={`Cancel subscription #${m.id}`}
                            onClick={() => setConfirmCancel(m.id)}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {schedule.charges.length > 0 && (
                    <section
                      className="mt-4 border-t border-edge pt-3"
                      aria-labelledby={`schedule-${m.id}`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <h3 id={`schedule-${m.id}`} className="text-sm font-medium">
                          Upcoming charges
                        </h3>
                        <span className="text-xs text-muted">
                          Next {schedule.charges.length} total{" "}
                          {formatAmount(schedule.total, meta)}
                        </span>
                      </div>
                      <ol className="mt-2 space-y-1.5">
                        {schedule.charges.map((charge) => (
                          <li
                            key={charge.due}
                            className="flex items-baseline justify-between gap-3 text-sm"
                          >
                            <time
                              dateTime={new Date(charge.due * 1000).toISOString()}
                              className="text-muted"
                            >
                              {formatDate(charge.due)}
                            </time>
                            <span className="tabular-nums">
                              {formatAmount(charge.amount, meta)}
                            </span>
                          </li>
                        ))}
                      </ol>
                      <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
                        <span>
                          Running total{" "}
                          <strong className="font-medium text-fg">
                            {formatAmount(schedule.total, meta)}
                          </strong>
                        </span>
                        {schedule.finalDate !== null && (
                          <span>Final charge {formatDate(schedule.finalDate)}</span>
                        )}
                      </div>
                      {shortfall !== null && (
                        <p
                          role="status"
                          className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
                        >
                          Your vault is short by{" "}
                          {formatAmount(shortfall, meta)} for the next charge.
                          Deposit before {formatDate(m.next_charge)} or it will
                          fail.
                        </p>
                      )}
                    </section>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
