// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AccountPage from "@/app/account/page";
import type { ApiMandate } from "@/lib/api";
import { minPauseDate, resumeDate, shortAddress } from "@/lib/format";

/**
 * The account page is the first page rendered in tests because it exercises
 * all three data paths the issue calls out: a wallet-less visitor, the indexer,
 * and the contract-only fallback used by the public demo. The wallet is mocked
 * so the test never touches Stellar Wallets Kit or the network.
 */

const wallet = vi.hoisted(() => ({
  address: null as string | null,
  connecting: false,
  error: null as string | null,
  networkMismatch: false,
  walletNetwork: null as string | null,
  connect: vi.fn(),
  disconnect: vi.fn(),
  signXdr: vi.fn(),
}));

const apiMock = vi.hoisted(() => ({
  mandatesOf: vi.fn(),
  vaultHistory: vi.fn(),
}));

import { config } from "@/lib/config";

const payflowMock = vi.hoisted(() => ({
  vaultBalance: vi.fn(),
  deposit: vi.fn(),
  withdraw: vi.fn(),
  depositFor: vi.fn(),
  setPaused: vi.fn(),
  pauseUntil: vi.fn(),
  cancel: vi.fn(),
  readContract: vi.fn(),
}));

const payflowHelpers = vi.hoisted(() => ({
  mandatePauseUntil: vi.fn(),
  mandateIsPastDue: vi.fn(() => false),
  mandatePastDueUntil: vi.fn(() => null),
  vaultSupportsDepositFor: vi.fn(),
  validateRecipient: vi.fn(),
}));

const chainMock = vi.hoisted(() => ({
  chainMandatesOf: vi.fn(),
}));

vi.mock("@/lib/wallet", () => ({ useWallet: () => wallet }));
vi.mock("@/lib/api", () => ({
  api: { mandatesOf: apiMock.mandatesOf, vaultHistory: apiMock.vaultHistory },
}));
vi.mock("@/lib/payflow", () => ({
  payflow: payflowMock,
  readContract: payflowMock.readContract,
  ...payflowHelpers,
}));
vi.mock("@/lib/chain", () => ({ chainMandatesOf: chainMock.chainMandatesOf }));
// Merchant names come from Horizon + stellar.toml; the page must render
// without either, so the resolver is pinned to "no name published".
vi.mock("@/lib/toml", () => ({ useOrgName: () => null }));

// Pinned so the page has a token contract to ask about. Without it the token
// id is "" in tests and every amount falls back to native XLM.
vi.mock("@/lib/config", () => ({
  config: {
    rpcUrl: "http://localhost:8000/rpc",
    networkPassphrase: "Test SDF Network ; September 2015",
    network: "TESTNET",
    apiUrl: "http://localhost:8080",
    readSource: "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE",
    contracts: {
      planRegistry: "CDQ5EJTVXXX2CBMHWP3BGGUDHSK6D4I25IF5XXH3QGL2TNTBMJUOFKDB",
      vault: "CBNQEWSYYQOKNX5KB62OFT6ID5TCVSWN4PS4AXAJK6IWUEXOLVN6DXII",
      subscription: "CD5YZUJU6WLFIHGAV4J2BV42GCVZE5ZGDUGSW5CBRIA47TQHSZZW3XMM",
      token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    },
  },
  explorerBase: "https://stellar.expert/explorer/testnet",
  requireContracts: () => {},
}));

const SUBSCRIBER = "GAP6QFLXQD73URCC3EXU2WOQHIAREPCGMSIMKF5PFLLI5TR6HTMNDTIE";
const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";

function mandate(overrides: Partial<ApiMandate> = {}): ApiMandate {
  return {
    id: 7,
    subscriber: SUBSCRIBER,
    merchant: MERCHANT,
    plan_id: 1,
    amount: "10000000", // 1 XLM
    period: 2_592_000, // monthly
    next_charge: 0,
    last_charge: 0,
    charges_made: 0,
    max_charges: 0,
    fee_bps: 100,
    status: "Active",
    ended_by: null,
    ...overrides,
  };
}

beforeEach(async () => {
  wallet.address = SUBSCRIBER;
  wallet.connecting = false;
  wallet.error = null;
  wallet.networkMismatch = false;
  wallet.walletNetwork = null;
  apiMock.mandatesOf.mockReset();
  apiMock.vaultHistory.mockReset();
  payflowMock.vaultBalance.mockReset();
  payflowMock.deposit.mockReset();
  payflowMock.withdraw.mockReset();
  payflowMock.setPaused.mockReset();
  payflowMock.pauseUntil.mockReset();
  // Default: the deployed contract has no pause_until, so the picker is hidden.
  payflowHelpers.mandatePauseUntil.mockReset();
  payflowHelpers.mandatePauseUntil.mockReturnValue(null);
  // Default: the deployed contract has no deposit_for, so the sponsor panel is hidden.
  payflowHelpers.vaultSupportsDepositFor.mockReset();
  payflowHelpers.vaultSupportsDepositFor.mockResolvedValue(false);
  payflowHelpers.validateRecipient.mockReset();
  payflowMock.cancel.mockReset();
  payflowMock.deposit.mockReset();
  payflowMock.depositFor.mockReset();
  payflowMock.withdraw.mockReset();
  payflowMock.setPaused.mockReset();
  payflowMock.pauseUntil.mockReset();
  payflowMock.readContract.mockReset();
  chainMock.chainMandatesOf.mockReset();
  // The token metadata cache is module-level and outlives a single render.
  const { clearTokenMetaCache } = await import("@/lib/token");
  clearTokenMetaCache();
});

afterEach(cleanup);

describe("AccountPage", () => {
  it("asks for a wallet when none is connected", () => {
    wallet.address = null;
    render(<AccountPage />);

    expect(
      screen.getByText(/connect a wallet to see your vault balance/i),
    ).toBeTruthy();
    expect(apiMock.mandatesOf).not.toHaveBeenCalled();
  });

  it("renders the vault balance and mandates served by the indexer", async () => {
    payflowMock.vaultBalance.mockResolvedValue(50_000_000n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    // 50_000_000 stroops renders as 5 XLM, not 50000000.
    expect(await screen.findByText("5 XLM")).toBeTruthy();
    expect(screen.getByText("Mandate #7")).toBeTruthy();
    expect(screen.getByText(/1 XLM per month/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel subscription #7" }),
    ).toBeTruthy();
    expect(screen.getByText("Active subscriptions").parentElement?.textContent).toContain(
      "1",
    );
    expect(payflowMock.vaultBalance).toHaveBeenCalledWith(
      SUBSCRIBER,
      SUBSCRIBER,
      expect.any(String),
    );
    expect(chainMock.chainMandatesOf).not.toHaveBeenCalled();
  });

  it("falls back to contract state when the indexer is unavailable", async () => {
    // The public demo runs without a backend; api methods return null rather
    // than throwing, and the page must still list the subscriber's mandates.
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue(null);
    chainMock.chainMandatesOf.mockResolvedValue([
      mandate({ id: 9, status: "Cancelled" }),
    ]);

    render(<AccountPage />);

    expect(await screen.findByText("Mandate #9")).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(chainMock.chainMandatesOf).toHaveBeenCalledWith(SUBSCRIBER, SUBSCRIBER);
    // Cancelled mandates are terminal, so the page must not offer Cancel.
    expect(screen.queryByRole("button", { name: /^Cancel subscription/ })).toBeNull();
  });

  it("disables write actions while the wallet is on the wrong network", async () => {
    wallet.networkMismatch = true;
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    const deposit = (await screen.findByRole("button", {
      name: "Deposit",
    })) as HTMLButtonElement;
    const withdraw = screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement;
    const pause = (await screen.findByRole("button", {
      name: "Pause",
    })) as HTMLButtonElement;

    expect(deposit.disabled).toBe(true);
    expect(withdraw.disabled).toBe(true);
    expect(pause.disabled).toBe(true);
  });

  it("labels and scales amounts with the token's own metadata", async () => {
    // A 6-decimal token: 50_000_000 smallest units is 50, not 5. Reading it as
    // XLM is the bug this page used to have.
    payflowMock.readContract.mockImplementation(async (_id: string, method: string) =>
      method === "symbol" ? "USDC" : 6,
    );
    payflowMock.vaultBalance.mockResolvedValue(50_000_000n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    expect(await screen.findByText("50 USDC")).toBeTruthy();
    expect(await screen.findByText(/10 USDC per month/)).toBeTruthy();
    expect(screen.getByLabelText("Amount (USDC)")).toBeTruthy();
    expect(payflowMock.readContract).toHaveBeenCalledWith(
      expect.any(String),
      "decimals",
      expect.any(String),
    );
  });

  it("still shows amounts when the token's metadata cannot be read", async () => {
    payflowMock.readContract.mockRejectedValue(new Error("host error: missing contract"));
    payflowMock.vaultBalance.mockResolvedValue(50_000_000n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    // Degrades to the native assumption rather than blanking the page.
    expect(await screen.findByText("5 XLM")).toBeTruthy();
  });

  it("asks for confirmation before cancelling a subscription", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    payflowMock.cancel.mockResolvedValue("c0ffee");
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel subscription #7" }),
    );

    // The irreversible write has not happened yet.
    expect(payflowMock.cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Confirm cancelling subscription #7",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(payflowMock.cancel).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Cancel subscription #7" }),
    ).toBeTruthy();
  });

  it("only sends the cancel transaction from Confirm", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    payflowMock.cancel.mockResolvedValue("c0ffee");
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate()] });

    render(<AccountPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel subscription #7" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm cancelling subscription #7",
      }),
    );

    await waitFor(() =>
      expect(payflowMock.cancel).toHaveBeenCalledWith(
        SUBSCRIBER,
        expect.any(Function),
        7,
      ),
    );
    expect(payflowMock.cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps only one mandate in the confirming state at a time", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ id: 7 }), mandate({ id: 8 })],
    });

    render(<AccountPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel subscription #7" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel subscription #8" }));

    expect(screen.getAllByRole("button", { name: "Keep" })).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: "Confirm cancelling subscription #8",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Confirm cancelling subscription #7",
      }),
    ).toBeNull();
  });

  it("renders the next six charges and their running total", async () => {
    payflowMock.vaultBalance.mockResolvedValue(100_000_000n); // 10 XLM
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ next_charge: 1_700_000_000, period: 2_592_000 })],
    });

    render(<AccountPage />);

    const timeline = await screen.findByRole("region", {
      name: "Upcoming charges",
    });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(6);
    expect(within(timeline).getByText(/Next 6 total/).textContent).toContain(
      "6 XLM",
    );
    expect(within(timeline).getByText(/Running total/).textContent).toContain(
      "6 XLM",
    );
  });

  it("renders the timeline from contract state when the indexer is offline", async () => {
    payflowMock.vaultBalance.mockResolvedValue(100_000_000n);
    apiMock.mandatesOf.mockResolvedValue(null);
    chainMock.chainMandatesOf.mockResolvedValue([
      mandate({ next_charge: 1_700_000_000, period: 2_592_000 }),
    ]);

    render(<AccountPage />);

    const timeline = await screen.findByRole("region", {
      name: "Upcoming charges",
    });
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(6);
    expect(chainMock.chainMandatesOf).toHaveBeenCalledWith(SUBSCRIBER, SUBSCRIBER);
  });

  it("does not render a timeline for paused mandates", async () => {
    payflowMock.vaultBalance.mockResolvedValue(100_000_000n);
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [
        mandate({
          status: "Paused",
          next_charge: 1_700_000_000,
          period: 2_592_000,
        }),
      ],
    });

    render(<AccountPage />);

    await screen.findByText("Mandate #7");
    expect(screen.queryByRole("region", { name: "Upcoming charges" })).toBeNull();
  });

  it("warns when the vault cannot cover the next charge", async () => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ next_charge: 1_700_000_000, period: 2_592_000 })],
    });

    render(<AccountPage />);

    const timeline = await screen.findByRole("region", {
      name: "Upcoming charges",
    });
    const warning = within(timeline).getByRole("status");
    expect(warning.textContent).toContain("Your vault is short by 1 XLM");
  });
});

describe("AccountPage pause until", () => {
  const DAY_MS = 86_400_000;
  const inDays = (n: number) => Math.floor((Date.now() + n * DAY_MS) / 1000);

  beforeEach(() => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [] });
  });

  it("hides the picker when the contract has no pause_until", async () => {
    // A contract built before payflow-contract#41 decodes mandates without it.
    payflowHelpers.mandatePauseUntil.mockReturnValue(null);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    await screen.findByText("Mandate #7");

    expect(screen.queryByRole("button", { name: "Pause until…" })).toBeNull();
    // The existing pause toggle is untouched.
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("offers a date picker once the contract carries pause_until", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause until…" }));

    const input = screen.getByLabelText(/Resume date for mandate 7/) as HTMLInputElement;
    expect(input.type).toBe("date");
    // Today is not offered: resuming at midnight tonight has already passed.
    expect(input.min).toBe(minPauseDate());
  });

  it("sends the chosen date as a Unix time", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });
    payflowMock.pauseUntil.mockResolvedValue("cafe");

    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause until…" }));

    const chosen = "2027-03-14";
    fireEvent.change(screen.getByLabelText(/Resume date for mandate 7/), {
      target: { value: chosen },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause until…" }));

    await waitFor(() =>
      expect(payflowMock.pauseUntil).toHaveBeenCalledWith(
        SUBSCRIBER,
        expect.any(Function),
        7,
        Date.UTC(2027, 2, 14) / 1000,
      ),
    );
  });

  it("refuses a date in the past instead of sending it", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause until…" }));
    fireEvent.change(screen.getByLabelText(/Resume date for mandate 7/), {
      target: { value: "2020-01-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause until…" }));

    expect(await screen.findByText("Pick a date in the future.")).toBeTruthy();
    expect(payflowMock.pauseUntil).not.toHaveBeenCalled();
  });

  it("refuses an empty date instead of sending it", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause until…" }));
    fireEvent.change(screen.getByLabelText(/Resume date for mandate 7/), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause until…" }));

    expect(await screen.findByText(/Pick a date for the mandate to resume on/)).toBeTruthy();
    expect(payflowMock.pauseUntil).not.toHaveBeenCalled();
  });

  it("shows the resume date on a paused mandate", async () => {
    const until = inDays(3);
    payflowHelpers.mandatePauseUntil.mockReturnValue(until);
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ status: "Paused", pause_until: until })],
    });

    render(<AccountPage />);

    expect(await screen.findByText(`resumes ${resumeDate(until)}`)).toBeTruthy();
  });

  it("shows no resume date once it has passed", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(-1));
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ status: "Active", pause_until: inDays(-1) })],
    });

    render(<AccountPage />);
    await screen.findByText("Mandate #7");

    expect(screen.queryByText(/resumes \d{4}-/)).toBeNull();
  });

  it("does not offer a picker on a cancelled mandate", async () => {
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({
      mandates: [mandate({ status: "Cancelled" })],
    });

    render(<AccountPage />);
    await screen.findByText("Cancelled");

    expect(screen.queryByRole("button", { name: "Pause until…" })).toBeNull();
  });

  it("disables the picker while the wallet is on the wrong network", async () => {
    wallet.networkMismatch = true;
    payflowHelpers.mandatePauseUntil.mockReturnValue(inDays(3));
    apiMock.mandatesOf.mockResolvedValue({ mandates: [mandate({ status: "Active" })] });

    render(<AccountPage />);
    const picker = (await screen.findByRole("button", { name: "Pause until…" })) as HTMLButtonElement;

    expect(picker.disabled).toBe(true);
  });

  it("works in contract-only mode when chain state carries the field", async () => {
    // The public demo has no indexer. The mandates come from the contract, so
    // the capability signal and the resume date must survive that path too.
    apiMock.mandatesOf.mockResolvedValue(null);
    chainMock.chainMandatesOf.mockResolvedValue([
      mandate({ status: "Paused", pause_until: inDays(3) }),
    ]);
    payflowHelpers.mandatePauseUntil.mockImplementation(
      (m: { pause_until?: number } | null) => m?.pause_until ?? null,
    );

    render(<AccountPage />);

    expect(await screen.findByRole("button", { name: "Pause until…" })).toBeTruthy();
    expect(chainMock.chainMandatesOf).toHaveBeenCalledWith(SUBSCRIBER, SUBSCRIBER);
  });
});

describe("AccountPage fund another account", () => {
  const RECIPIENT = MERCHANT;
  const AMOUNT = "5";

  beforeEach(() => {
    payflowMock.vaultBalance.mockResolvedValue(0n);
    apiMock.mandatesOf.mockResolvedValue({ mandates: [] });
    payflowHelpers.validateRecipient.mockImplementation(
      (raw) => (raw.trim() === RECIPIENT ? null : "That is not a valid Stellar account address."),
    );
  });

  it("hides the sponsor panel when the contract does not support deposit_for", async () => {
    payflowHelpers.vaultSupportsDepositFor.mockResolvedValue(false);

    render(<AccountPage />);
    await screen.findByText("No subscriptions yet");

    expect(screen.queryByText(/fund another account/i)).toBeNull();
    expect(payflowHelpers.vaultSupportsDepositFor).toHaveBeenCalledWith(SUBSCRIBER);
    expect(payflowMock.depositFor).not.toHaveBeenCalled();
  });

  it("shows the sponsor panel when the contract supports deposit_for", async () => {
    payflowHelpers.vaultSupportsDepositFor.mockResolvedValue(true);

    render(<AccountPage />);
    await screen.findByText(/fund another account/i);
    expect(screen.getByLabelText(/recipient address/i)).toBeTruthy();
    expect(document.getElementById("fund-amount")).not.toBeNull();
  });

  it("rejects an invalid recipient address without signing anything", async () => {
    payflowHelpers.vaultSupportsDepositFor.mockResolvedValue(true);

    render(<AccountPage />);
    await screen.findByText(/fund another account/i);

    const recipient = screen.getByLabelText(/recipient address/i) as HTMLInputElement;
    fireEvent.change(recipient, { target: { value: "not an address" } });

    expect(
      screen.getByText(/That is not a valid Stellar account address/),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /^fund$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^fund$/i }));
    expect(payflowMock.depositFor).not.toHaveBeenCalled();
  });

  it("shows both parties in the confirmation before sending", async () => {
    payflowHelpers.vaultSupportsDepositFor.mockResolvedValue(true);
    payflowMock.depositFor.mockResolvedValue("deposited");

    render(<AccountPage />);
    await screen.findByText(/fund another account/i);

    const recipient = screen.getByLabelText(/recipient address/i) as HTMLInputElement;
    const amount = document.getElementById("fund-amount") as HTMLInputElement;
    fireEvent.change(recipient, { target: { value: RECIPIENT } });
    fireEvent.change(amount, { target: { value: AMOUNT } });

    fireEvent.click(screen.getByRole("button", { name: /^fund$/i }));

    // Confirmation names sponsor and recipient, and states who can withdraw.
    expect(screen.getByText(/pays/)).toBeTruthy();
    expect(screen.getByText(/5 XLM/)).toBeTruthy();
    expect(screen.getByText(shortAddress(SUBSCRIBER))).toBeTruthy();
    expect(screen.getAllByText(shortAddress(RECIPIENT))).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^fund$/i }));

    await waitFor(() =>
      expect(payflowMock.depositFor).toHaveBeenCalledWith(
        SUBSCRIBER,
        expect.any(Function),
        RECIPIENT,
        config.contracts.token,
        50_000_000n,
      ),
    );
    expect(screen.getByText(/Done\./)).toBeTruthy();
  });

  it("disables the sponsor write while the wallet is on the wrong network", async () => {
    payflowHelpers.vaultSupportsDepositFor.mockResolvedValue(true);
    wallet.networkMismatch = true;

    render(<AccountPage />);
    await screen.findByText(/fund another account/i);

    expect(
      (screen.getByRole("button", { name: /^fund$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
