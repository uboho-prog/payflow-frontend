import { describe, expect, it } from "vitest";
import { scValToNative } from "@stellar/stellar-sdk";
import { MAX_NAME_LEN, MAX_PAGE, arg, validateRecipient } from "@/lib/payflow";

/**
 * The typed wrappers in `payflow.ts` encode every contract argument through
 * `arg`. A wrong ScVal type is only caught by the network at submission time,
 * so these tests decode the encoded values back and check the SDK types the
 * contract expects — especially u64/i128, where a Number would lose precision.
 */

const ADDRESS = "GAEWDXVDI3WI35TWTZXNQ4NTRYIG6J34XPRSNKX655LBA377M5ZOCBY5";

describe("contract argument encoding", () => {
  it("encodes an address and decodes it back to the same StrKey", () => {
    expect(scValToNative(arg.address(ADDRESS))).toBe(ADDRESS);
  });

  it("encodes u64 as a bigint without losing precision", () => {
    const large = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2
    const decoded = scValToNative(arg.u64(large));

    expect(decoded).toBe(large);
    expect(typeof decoded).toBe("bigint");
  });

  it("encodes u32 ids and periods as numbers", () => {
    expect(scValToNative(arg.u32(604_800))).toBe(604_800);
    expect(typeof scValToNative(arg.u32(604_800))).toBe("number");
  });

  it("encodes i128 amounts as bigint, never floating point", () => {
    const amount = 10_000_000n;
    const decoded = scValToNative(arg.i128(amount));

    expect(decoded).toBe(amount);
    expect(typeof decoded).toBe("bigint");
  });

  it("encodes booleans and UTF-8 plan names", () => {
    expect(scValToNative(arg.bool(true))).toBe(true);
    expect(scValToNative(arg.bool(false))).toBe(false);
    expect(scValToNative(arg.string("Pro Monthly"))).toBe("Pro Monthly");
    expect(scValToNative(arg.string("日本語プラン"))).toBe("日本語プラン");
  });
});

describe("contract limits", () => {
  it("matches the page size the contracts return", () => {
    expect(MAX_PAGE).toBe(50);
  });

  it("matches the plan-name byte limit", () => {
    expect(MAX_NAME_LEN).toBe(64);
  });
});

describe("deposit_for argument encoding", () => {
  it("encodes recipient, token and amount exactly as the contract expects", () => {
    const recipient = "GAEWDXVDI3WI35TWTZXNQ4NTRYIG6J34XPRSNKX655LBA377M5ZOCBY5";
    const token = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const amount = 12_500_000n;

    // The caller is the transaction source and is not an argument.
    const [recipientArg, tokenArg, amountArg] = [
      arg.address(recipient),
      arg.address(token),
      arg.i128(amount),
    ];

    expect(scValToNative(recipientArg)).toBe(recipient);
    expect(scValToNative(tokenArg)).toBe(token);
    expect(scValToNative(amountArg)).toBe(amount);
    expect(typeof scValToNative(amountArg)).toBe("bigint");
  });
});

describe("validateRecipient", () => {
  const VALID = "GAEWDXVDI3WI35TWTZXNQ4NTRYIG6J34XPRSNKX655LBA377M5ZOCBY5";

  it("accepts a valid Stellar account address", () => {
    expect(validateRecipient(VALID)).toBeNull();
    expect(validateRecipient(` ${VALID} `)).toBeNull();
  });

  it("rejects empty input", () => {
    expect(validateRecipient("")).toBe("Enter a Stellar address.");
    expect(validateRecipient("   ")).toBe("Enter a Stellar address.");
  });

  it("rejects addresses that are not valid ed25519 public keys", () => {
    expect(validateRecipient("GBAD…")).toBe("That is not a valid Stellar account address.");
    expect(validateRecipient("not an address")).toBe(
      "That is not a valid Stellar account address.",
    );
    expect(validateRecipient("C" + VALID.slice(1))).toBe(
      "That is not a valid Stellar account address.",
    );
  });
});
