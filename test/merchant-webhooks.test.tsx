// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MerchantPage from "@/app/merchant/page";

/**
 * Webhook settings are a payflow-backend feature (#5). The panel is hidden
 * entirely when the backend is not configured or does not serve webhooks, and
 * only https endpoints may be registered.
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
// importOriginal keeps the real checkWebhookUrl validation while the api
// client itself is mocked.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { api: apiMock, checkWebhookUrl: actual.checkWebhookUrl };
});
vi.mock("@/lib/payflow", () => ({ payflow: payflowMock, MAX_NAME_LEN: 64, nameByteLength: (n: string) => n.length }));
vi.mock("@/lib/chain", () => chainMock);
// Merchant names come from Horizon + stellar.toml; the page must render
// without either, so the resolver is pinned to "no name published".
vi.mock("@/lib/toml", () => ({ useOrgName: () => null }));

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
  apiMock.addWebhook.mockResolvedValue({
    id: "wh_1",
    url: "https://hooks.example.com/payflow",
    events: ["charge"],
    secret: "whsec_test",
  });
  apiMock.deleteWebhook.mockResolvedValue(true);
  apiMock.testWebhook.mockResolvedValue({ ok: true });
  chainMock.chainPlanSubscriberCount.mockResolvedValue(null);
  payflowMock.feeBps.mockResolvedValue(100);
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

describe("MerchantPage webhooks", () => {
  it("hides webhook settings in contract-only mode", async () => {
    apiMock.isConfigured.mockReturnValue(false);

    render(<MerchantPage />);

    expect(screen.queryByText(/webhook settings/i)).toBeNull();
    expect(apiMock.webhooks).not.toHaveBeenCalled();
  });

  it("renders the webhook panel when the API is configured", async () => {
    render(<MerchantPage />);

    expect(await screen.findByText(/webhook settings/i)).toBeTruthy();
    expect(screen.getByLabelText(/url/i)).toBeTruthy();
    expect(apiMock.webhooks).toHaveBeenCalledWith(MERCHANT);
  });

  it("rejects a URL that is not https before anything is sent", async () => {
    render(<MerchantPage />);
    await screen.findByText(/webhook settings/i);

    const url = screen.getByLabelText(/url/i) as HTMLInputElement;
    fireEvent.change(url, { target: { value: "http://hooks.example.com/payflow" } });

    expect(screen.getByText(/must use https/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /^add webhook$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(apiMock.addWebhook).not.toHaveBeenCalled();
  });

  it("creates a webhook and shows the signing secret once", async () => {
    render(<MerchantPage />);
    await screen.findByText(/webhook settings/i);

    const url = screen.getByLabelText(/url/i) as HTMLInputElement;
    fireEvent.change(url, { target: { value: "https://hooks.example.com/payflow" } });
    fireEvent.click(screen.getByLabelText(/charge settled/i) as HTMLInputElement);

    const add = screen.getByRole("button", { name: /^add webhook$/i }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);

    await waitFor(() =>
      expect(apiMock.addWebhook).toHaveBeenCalledWith(MERCHANT, {
        url: "https://hooks.example.com/payflow",
        events: ["charge"],
      }),
    );
    expect(screen.getByText(/webhook created/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /copy signing secret/i }),
    ).toBeTruthy();
  });

  it("deletes a webhook after confirmation", async () => {
    apiMock.webhooks.mockResolvedValue([
      { id: "wh_1", url: "https://hooks.example.com/payflow", events: ["charge"], created_at: 1_000_000_000 },
    ]);

    render(<MerchantPage />);
    await screen.findByText("https://hooks.example.com/payflow");

    fireEvent.click(screen.getByRole("button", { name: /delete webhook/i }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() =>
      expect(apiMock.deleteWebhook).toHaveBeenCalledWith(MERCHANT, "wh_1"),
    );
    expect(screen.getByText(/webhook deleted/i)).toBeTruthy();
  });

  it("sends a test event to a registered webhook", async () => {
    apiMock.webhooks.mockResolvedValue([
      { id: "wh_1", url: "https://hooks.example.com/payflow", events: ["charge"], created_at: 1_000_000_000 },
    ]);

    render(<MerchantPage />);
    await screen.findByText("https://hooks.example.com/payflow");

    fireEvent.click(screen.getByRole("button", { name: /^send test$/i }));

    await waitFor(() =>
      expect(apiMock.testWebhook).toHaveBeenCalledWith(MERCHANT, "wh_1"),
    );
    expect(screen.getByText(/test event sent/i)).toBeTruthy();
  });
});
