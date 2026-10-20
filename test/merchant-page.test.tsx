// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import MerchantPage from "@/app/merchant/page";

/**
 * The publish form used to accept any text as a price and only fail when the
 * transaction was simulated, so a merchant paid for a failed attempt. These
 * tests pin the two acceptance criteria: invalid input disables Publish with a
 * message, and the fee preview is bigint math rather than a percentage of a
 * rounded display string.
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
  isConfigured: vi.fn(() => true),
  plans: vi.fn(),
  mandatesFor: vi.fn(),
  merchantSummary: vi.fn(),
  merchantRevenue: vi.fn(),
  merchantChurn: vi.fn(),
  planStats: vi.fn(),
  webhooks: vi.fn(),
  addWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  testWebhook: vi.fn(),
}));

const payflowMock = vi.hoisted(() => ({
  feeBps: vi.fn(),
  createPlan: vi.fn(),
  setPlanActive: vi.fn(),
  charge: vi.fn(),
  endMandate: vi.fn(),
}));

const chainMock = vi.hoisted(() => ({
  chainMandatesFor: vi.fn(),
  chainMerchantSummary: vi.fn(),
  chainPlansOf: vi.fn(),
  chainPlanSubscriberCount: vi.fn(),
  endable: vi.fn(() => false),
}));

vi.mock("@/lib/wallet", () => ({ useWallet: () => wallet }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { api: apiMock, checkWebhookUrl: actual.checkWebhookUrl };
});
vi.mock("@/lib/payflow", () => ({ payflow: payflowMock, MAX_NAME_LEN: 64, nameByteLength: (n: string) => n.length }));
vi.mock("@/lib/chain", () => chainMock);

const MERCHANT = "GCH5VHWNS24VI75HLDBHK4SSJ2E5XZA5IB6XEZTNE4BJH7AKZI6Z3MHU";

beforeEach(() => {
  wallet.address = MERCHANT;
  wallet.networkMismatch = false;
  apiMock.isConfigured.mockReturnValue(true);
  apiMock.plans.mockResolvedValue({ plans: [] });
  apiMock.mandatesFor.mockResolvedValue({ mandates: [] });
  apiMock.merchantSummary.mockResolvedValue(null);
  apiMock.merchantRevenue.mockResolvedValue(null);
  apiMock.merchantChurn.mockResolvedValue(null);
  apiMock.planStats.mockResolvedValue(null);
  apiMock.webhooks.mockResolvedValue([]);
  chainMock.chainPlanSubscriberCount.mockResolvedValue(null);
  payflowMock.feeBps.mockResolvedValue(100); // 1%
  payflowMock.createPlan.mockResolvedValue("tx-hash");
  chainMock.chainMerchantSummary.mockReturnValue({
    merchant: MERCHANT,
    activeMandates: 0,
    totalCollected: null,
    chargeCount: 0,
    mrr: "0",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Type into the price field and return the Publish button. */
async function fillPrice(value: string): Promise<HTMLButtonElement> {
  const field = (await screen.findByLabelText(/price/i)) as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
  return screen.getByRole("button", { name: /publish plan/i }) as HTMLButtonElement;
}

describe("MerchantPage publish form", () => {
  it("keeps Publish disabled and explains why while the price is unusable", async () => {
    render(<MerchantPage />);

    // An untouched empty field is not an error yet, but Publish stays off.
    const empty = await fillPrice("");
    expect(empty.disabled).toBe(true);
    expect(screen.queryByText("Enter an amount.")).toBeNull();

    // Letters are stripped at the keyboard now, so the garbage that reaches
    // the parser is a malformed number like 1.2.3 (issue #46's filter).
    fireEvent.change(screen.getByLabelText(/price/i), { target: { value: "1.2.3" } });
    expect(
      (screen.getByRole("button", { name: /publish plan/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Enter a positive number/i)).toBeTruthy();
  });

  it("explains the empty field once the merchant has blurred it", async () => {
    render(<MerchantPage />);
    const field = (await screen.findByLabelText(/price/i)) as HTMLInputElement;
    fireEvent.blur(field);

    expect(screen.getByText("Enter an amount.")).toBeTruthy();
  });

  it("rejects more decimal places than the token can represent", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("1.00000001");
    expect(publish.disabled).toBe(true);
    expect(screen.getByText(/At most 7 decimal places\./i)).toBeTruthy();
  });

  it("accepts the separators the merchant's locale uses", async () => {
    // Issue #46: a comma-decimal keyboard produces "1,5" or "1.234,5";
    // both must publish the same bigint as their dot-decimal twins.
    render(<MerchantPage />);

    const publish = await fillPrice("1.234,5");
    expect(publish.disabled).toBe(false);

    fireEvent.click(publish);
    await waitFor(() => expect(payflowMock.createPlan).toHaveBeenCalled());
    expect(payflowMock.createPlan.mock.calls[0]?.[2]).toMatchObject({
      amount: 12_345_000_000n,
    });
  });

  it("rejects a price of zero, which the contract would reject too", async () => {
    render(<MerchantPage />);

    const publish = await fillPrice("0");
    expect(publish.disabled).toBe(true);
    expect(screen.getByText("Amount must be greater than zero.")).toBeTruthy();
    expect(payflowMock.createPlan).not.toHaveBeenCalled();
  });

  it("marks the field invalid and points it at the message for screen readers", async () => {
    render(<MerchantPage />);
    await fillPrice("1.2.3");

    const field = screen.getByLabelText(/price/i);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toMatch(
      /Enter a positive number/i,
    );
  });

  it("previews the fee split in bigint, not a percentage of a rounded display", async () => {
    render(<MerchantPage />);
    // 0.1 XLM at 1% is a fee of exactly 0.001 XLM. Rounding to 4dp for display
    // before taking the percentage would give 0.00099, and the merchant would
    // never see a charge they could reconcile.
    await fillPrice("0.1");

    await waitFor(() =>
      expect(screen.getByText(/you receive/)).toBeTruthy(),
    );
    const preview = document.getElementById("price-preview")?.textContent ?? "";
    expect(preview).toContain("Subscriber pays 0.1 XLM");
    expect(preview).toContain("protocol fee 0.001 XLM (1%)");
    expect(preview).toContain("you receive 0.099 XLM");
  });

  it("publishes the parsed amount rather than re-reading the field", async () => {
    render(<MerchantPage />);
    // "1." passes validation as an unfinished entry; re-parsing it would throw
    // after the merchant had already approved the transaction in their wallet.
    await fillPrice("1.");
    payflowMock.createPlan.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /publish plan/i }));

    await waitFor(() => expect(payflowMock.createPlan).toHaveBeenCalled());
    expect(payflowMock.createPlan.mock.calls[0]?.[2]).toMatchObject({ amount: 10_000_000n });
  });

  it("still previews a 0% split when the contract fee cannot be read", async () => {
    payflowMock.feeBps.mockRejectedValue(new Error("RPC down"));
    render(<MerchantPage />);

    await fillPrice("5");

    await waitFor(() => expect(screen.getByText(/you receive/)).toBeTruthy());
    expect(document.getElementById("price-preview")?.textContent).toContain("you receive 5 XLM");
    // The form is still usable: an unreadable fee must not block publishing.
    expect(screen.getByRole("button", { name: /publish plan/i }).hasAttribute("disabled")).toBe(
      false,
    );
  });
});

function plan(over: Partial<import("@/lib/api").ApiPlan> = {}): import("@/lib/api").ApiPlan {
  return {
    id: 1,
    merchant: MERCHANT,
    name: "Pro Monthly",
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    amount: "10000000",
    period: 2_592_000,
    active: 1,
    ledger: 1000,
    ...over,
  };
}

/** Find the plan card that contains the given plan name, scoped for queries. */
async function planCardByName(name: string) {
  const nameEl = await screen.findByText(name);
  return within(nameEl.closest("div.border-edge") as HTMLElement);
}

describe("MerchantPage plan stats", () => {
  it("shows subscriber count, collected, and cancellations from the API", async () => {
    apiMock.plans.mockResolvedValue({ plans: [plan({ id: 3 })] });
    apiMock.planStats.mockResolvedValue({
      subscriber_count: 42,
      total_collected: "420000000",
      cancellations: 5,
    });

    render(<MerchantPage />);

    const card = await planCardByName("Pro Monthly");
    // Subscriber count, Collected (42 XLM = 420000000 stroops), Cancellations.
    await waitFor(() => expect(card.getByText("42")).toBeTruthy());
    expect(card.getByText(/Subscribers/)).toBeTruthy();
    expect(card.getByText(/Collected/)).toBeTruthy();
    expect(card.getByText(/42 XLM/)).toBeTruthy();
    expect(card.getByText(/Cancellations/)).toBeTruthy();
    expect(card.getByText("5")).toBeTruthy();
  });

  it("shows only subscriber count in contract-only mode when the contract supports it", async () => {
    // API down for plans and for plan stats; contract fallback returns plans
    // and a subscriber count.
    apiMock.plans.mockResolvedValue(null);
    chainMock.chainPlansOf.mockResolvedValue([plan({ id: 7 })]);
    apiMock.planStats.mockResolvedValue(null);
    chainMock.chainPlanSubscriberCount.mockResolvedValue(9);

    render(<MerchantPage />);

    const card = await planCardByName("Pro Monthly");
    await waitFor(() => expect(card.getByText("9")).toBeTruthy());
    expect(card.getByText(/Subscribers/)).toBeTruthy();
    // total_collected and cancellations require the indexer; they must not
    // appear when only the contract is available.
    expect(card.queryByText(/Collected/)).toBeNull();
    expect(card.queryByText(/Cancellations/)).toBeNull();
  });

  it("hides the stats block entirely when neither the API nor the contract can supply counts", async () => {
    apiMock.plans.mockResolvedValue({ plans: [plan({ id: 2 })] });
    apiMock.planStats.mockResolvedValue(null);
    chainMock.chainPlanSubscriberCount.mockResolvedValue(null);

    render(<MerchantPage />);

    // Wait for the plan card itself to appear and for stats to settle.
    const card = await planCardByName("Pro Monthly");
    await waitFor(() => {
      expect(card.queryByText(/Subscribers/)).toBeNull();
      expect(card.queryByText(/Collected/)).toBeNull();
      expect(card.queryByText(/Cancellations/)).toBeNull();
    });
  });

  function churnResponse(merchant = MERCHANT) {
    return {
      merchant,
      bucket: "month",
      buckets: [
        { bucket: "2026-10", started: 5, cancelled: 1, ended: 1, completed: 1, net: 2 },
      ],
      totals: { started: 5, cancelled: 1, ended: 1, completed: 1, net: 2 },
    };
  }

  describe("MerchantChurnPanel", () => {
    it("shows the required monthly metrics in an accessible table", async () => {
      apiMock.merchantChurn.mockResolvedValue(churnResponse());
      render(<MerchantPage />);

      const table = await screen.findByRole("table");
      expect(within(table).getByRole("columnheader", { name: "Month (UTC)" })).toBeTruthy();
      expect(within(table).getByRole("columnheader", { name: "Started" })).toBeTruthy();
      expect(
        within(table).getByRole("columnheader", { name: "Subscriber cancellations" }),
      ).toBeTruthy();
      expect(within(table).getByRole("columnheader", { name: "Merchant-ended" })).toBeTruthy();
      expect(within(table).getByRole("columnheader", { name: "Completed" })).toBeTruthy();
      expect(
        within(table).getByRole("columnheader", { name: "Net subscriber change" }),
      ).toBeTruthy();
      expect(within(table).getByRole("rowheader", { name: "2026-10" })).toBeTruthy();
      expect(within(table).getByText("5")).toBeTruthy();
      expect(within(table).getAllByText("1")).toHaveLength(3);
      expect(within(table).getByText("+2 (increase)")).toBeTruthy();
      expect(apiMock.merchantChurn).toHaveBeenCalledWith(MERCHANT);
    });

    it("shows loading and empty states", async () => {
      let resolveChurn!: (body: unknown) => void;
      apiMock.merchantChurn.mockReturnValue(
        new Promise((resolve) => {
          resolveChurn = resolve;
        }),
      );
      render(<MerchantPage />);

      expect(screen.getByText("Loading monthly subscriber activity…")).toBeTruthy();
      resolveChurn({
        merchant: MERCHANT,
        bucket: "month",
        buckets: [],
        totals: { started: 0, cancelled: 0, ended: 0, completed: 0, net: 0 },
      });
      expect(await screen.findByText("No subscription activity in this report")).toBeTruthy();
    });

    it("does not retain the previous merchant's metrics after an account switch", async () => {
      const otherMerchant = "GOTHER";
      let resolveNext!: (body: unknown) => void;
      apiMock.merchantChurn
        .mockResolvedValueOnce(churnResponse())
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveNext = resolve;
            }),
        );
      const { rerender } = render(<MerchantPage />);

      expect(await screen.findByText("2026-10")).toBeTruthy();
      wallet.address = otherMerchant;
      rerender(<MerchantPage />);

      await waitFor(() => expect(apiMock.merchantChurn).toHaveBeenLastCalledWith(otherMerchant));
      expect(screen.queryByText("2026-10")).toBeNull();
      expect(screen.getByText("Loading monthly subscriber activity…")).toBeTruthy();

      resolveNext({
        ...churnResponse(otherMerchant),
        buckets: [{ bucket: "2026-11", started: 7, cancelled: 0, ended: 0, completed: 0, net: 7 }],
        totals: { started: 7, cancelled: 0, ended: 0, completed: 0, net: 7 },
      });
      expect(await screen.findByText("2026-11")).toBeTruthy();
      expect(screen.queryByText("2026-10")).toBeNull();
    });

    it("explains unavailable and malformed backend responses", async () => {
      apiMock.merchantChurn.mockResolvedValue(null);
      const { unmount } = render(<MerchantPage />);
      expect(await screen.findByText("Historical churn analytics unavailable")).toBeTruthy();

      unmount();
      apiMock.merchantChurn.mockResolvedValue({ unexpected: true });
      render(<MerchantPage />);
      expect(await screen.findByText(/incomplete or inconsistent churn report/)).toBeTruthy();
    });
  });

  it("amounts formatted from strings with bigint, never floats", async () => {
    // 50 million stroops = 5 XLM at 7 decimals. The total_collected string is
    // parsed by fromStroops via BigInt(raw), so large amounts stay exact — a
    // float conversion would lose precision beyond Number.MAX_SAFE_INTEGER.
    // Using 5 XLM (not 1 XLM like the plan price) avoids a duplicate match.
    apiMock.plans.mockResolvedValue({ plans: [plan({ id: 4 })] });
    apiMock.planStats.mockResolvedValue({
      subscriber_count: 1,
      total_collected: "50000000",
      cancellations: 0,
    });

    render(<MerchantPage />);

    const card = await planCardByName("Pro Monthly");
    // The Collected value must read "5 XLM" — exact, from a bigint path.
    await waitFor(() => expect(card.getByText(/5 XLM/)).toBeTruthy());
    expect(card.getByText(/Subscribers/)).toBeTruthy();
  });
});
