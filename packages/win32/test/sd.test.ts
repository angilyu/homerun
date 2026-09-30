import { describe, expect, test } from "bun:test";
import {
  ACE_ALLOW,
  ACE_DENY,
  aclBytes,
  CONTAINER_INHERIT,
  coversAll,
  INHERIT_ONLY,
  OBJECT_INHERIT,
  parseAcl,
  pipeSddl,
  privacyProblems,
  privateDirSddl,
  privateFileSddl,
  SID,
  sidToBytes,
  sidToString,
  type Ace,
  type SecurityInfo,
} from "../src/sd";

const ME = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OTHER = "S-1-5-21-1111111111-2222222222-3333333333-1002";
const USERS = "S-1-5-32-545";
const FA = 0x001f_01ff;
const GA = 0x1000_0000;
const FR = 0x0012_0089;

const allow = (sid: string, mask = FA, flags = 0): Ace => ({ type: ACE_ALLOW, flags, mask, sid });
const deny = (sid: string, mask = FA, flags = 0): Ace => ({ type: ACE_DENY, flags, mask, sid });
const info = (aces: Ace[], o: { owner?: string; protected?: boolean } = {}): SecurityInfo => ({
  owner: o.owner ?? ME,
  dacl: { protected: o.protected ?? true, aces },
});
/** What the runtime's pipe reads back as (probe round 2, windows-latest). */
const PIPE = info([deny(SID.NETWORK), allow(ME), allow(SID.SYSTEM)]);

describe("SDDL the runtime applies (§5.2)", () => {
  test("the pipe: protected, NETWORK denied first, then the user and SYSTEM", () => {
    expect(pipeSddl(ME)).toBe(`D:P(D;;GA;;;S-1-5-2)(A;;GA;;;${ME})(A;;GA;;;S-1-5-18)`);
  });
  test("a private directory: protected, inherited by files and subdirectories", () => {
    expect(privateDirSddl(ME)).toBe(`D:P(A;OICI;FA;;;${ME})(A;OICI;FA;;;S-1-5-18)`);
  });
  test("a private file: protected, the user and SYSTEM", () => {
    expect(privateFileSddl(ME)).toBe(`D:P(A;;FA;;;${ME})(A;;FA;;;S-1-5-18)`);
  });
  test("anything but a SID is refused, so nothing can be spliced into the SDDL", () => {
    for (const bad of ["", "LA", "S-1-5", `${ME})(A;;GA;;;WD`, "S-1-5-21-x"]) {
      expect(() => pipeSddl(bad)).toThrow(/not a SID/);
      expect(() => privateDirSddl(bad)).toThrow(/not a SID/);
      expect(() => privateFileSddl(bad)).toThrow(/not a SID/);
    }
  });
});

describe("privacyProblems", () => {
  test("the runtime's pipe passes", () => {
    expect(privacyProblems(PIPE, ME, { networkDeny: true, protected: true })).toEqual([]);
  });
  test("a private directory passes", () => {
    const d = info([allow(ME, FA, OBJECT_INHERIT | CONTAINER_INHERIT), allow(SID.SYSTEM, FA, OBJECT_INHERIT | CONTAINER_INHERIT)]);
    expect(privacyProblems(d, ME, { protected: true })).toEqual([]);
  });
  test("owners the user can't be protected from are accepted; anyone else is not", () => {
    for (const owner of [ME, SID.SYSTEM, SID.ADMINISTRATORS]) expect(privacyProblems(info(PIPE.dacl!.aces, { owner }), ME)).toEqual([]);
    expect(privacyProblems(info(PIPE.dacl!.aces, { owner: OTHER }), ME)).toEqual([`owned by ${OTHER}`]);
  });
  test("the named-pipe default (Everyone and Anonymous may read) fails", () => {
    const d = info([allow(SID.SYSTEM), allow(SID.ADMINISTRATORS), allow(ME), allow(SID.EVERYONE, FR), allow(SID.ANONYMOUS, FR)], { protected: false });
    expect(privacyProblems(d, ME, { networkDeny: true, protected: true })).toEqual([
      "DACL not protected from inheritance",
      `allows ${SID.ADMINISTRATORS} (0x1f01ff)`,
      `allows ${SID.EVERYONE} (0x120089)`,
      `allows ${SID.ANONYMOUS} (0x120089)`,
      "no deny for NETWORK ahead of the allows",
    ]);
  });
  test("any other allowed SID fails, whatever the mask", () => {
    for (const sid of [OTHER, USERS, SID.EVERYONE, SID.NETWORK]) {
      expect(privacyProblems(info([...PIPE.dacl!.aces, allow(sid, 0x1)]), ME, { networkDeny: true })).toEqual([`allows ${sid} (0x1)`]);
    }
  });
  test("a null DACL fails: it grants everyone everything", () => {
    expect(privacyProblems({ owner: ME, dacl: null }, ME)).toEqual(["no DACL (everyone has full access)"]);
  });
  test("an empty DACL passes: it grants nobody anything", () => {
    expect(privacyProblems(info([]), ME)).toEqual([]);
  });
  test("unknown ACE types fail closed", () => {
    expect(privacyProblems(info([...PIPE.dacl!.aces, { type: 5, flags: 0, mask: FA, sid: "" }]), ME)).toEqual(["unexpected ACE type 5"]);
    expect(privacyProblems(info([{ type: 9, flags: 0, mask: FA, sid: ME }]), ME)).toEqual([`unexpected ACE type 9 for ${ME}`]);
  });
  test("the NETWORK deny must come first, apply to this object, and cover everything", () => {
    const want = { networkDeny: true };
    expect(privacyProblems(info([allow(ME), deny(SID.NETWORK)]), ME, want)).toEqual(["no deny for NETWORK ahead of the allows"]);
    expect(privacyProblems(info([deny(SID.NETWORK, FR), allow(ME)]), ME, want)).toEqual(["no deny for NETWORK ahead of the allows"]);
    expect(privacyProblems(info([deny(SID.NETWORK, FA, INHERIT_ONLY), allow(ME)]), ME, want)).toEqual(["no deny for NETWORK ahead of the allows"]);
    expect(privacyProblems(info([deny(SID.EVERYONE), allow(ME)]), ME, want)).toEqual(["no deny for NETWORK ahead of the allows"]);
    expect(privacyProblems(info([deny(SID.NETWORK, GA), allow(ME)]), ME, want)).toEqual([]);
  });
  test("other deny ACEs only take access away, so they pass", () => {
    expect(privacyProblems(info([deny(OTHER), deny(SID.EVERYONE, 0x40000), ...PIPE.dacl!.aces]), ME, { networkDeny: true })).toEqual([]);
  });
  test("coversAll: GENERIC_ALL or every file right", () => {
    expect(coversAll(GA)).toBe(true);
    expect(coversAll(FA)).toBe(true);
    expect(coversAll(0xffff_ffff)).toBe(true);
    expect(coversAll(FR)).toBe(false);
    expect(coversAll(FA & ~0x40000)).toBe(false);
  });
});

describe("binary SIDs and ACLs", () => {
  test("SIDs round-trip", () => {
    for (const s of [ME, SID.SYSTEM, SID.NETWORK, SID.EVERYONE, SID.ADMINISTRATORS, "S-1-5-21-4294967295-1-2-500"]) {
      expect(sidToString(sidToBytes(s))).toBe(s);
    }
  });
  test("the layout: revision, count, big-endian authority, little-endian sub-authorities", () => {
    expect([...sidToBytes("S-1-5-18")]).toEqual([1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0]);
    expect(sidToString(new Uint8Array([9, 9, 1, 1, 0, 0, 0, 0, 0, 5, 18, 0, 0, 0]), 2)).toBe("S-1-5-18");
  });
  test("a large identifier authority prints in hex, as Windows does", () => {
    expect(sidToString(new Uint8Array([1, 0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]))).toBe("S-1-0x123456789ABC");
  });
  test("malformed SIDs throw", () => {
    expect(() => sidToString(new Uint8Array([1, 1, 0, 0, 0, 0, 0, 5]))).toThrow(/truncated/);
    expect(() => sidToString(new Uint8Array([2, 0, 0, 0, 0, 0, 0, 5]))).toThrow(/not a SID/);
    expect(() => sidToString(new Uint8Array([1, 16, 0, 0, 0, 0, 0, 5]))).toThrow(/not a SID/);
  });
  test("ACLs round-trip, and unknown ACE types come back without a SID", () => {
    const aces = [deny(SID.NETWORK, FA), allow(ME, FA, OBJECT_INHERIT | CONTAINER_INHERIT), allow(SID.SYSTEM, GA)];
    expect(parseAcl(aclBytes(aces))).toEqual(aces);
    expect(parseAcl(aclBytes([{ type: 5, flags: 0, mask: FA, sid: ME }]))).toEqual([{ type: 5, flags: 0, mask: FA, sid: "" }]);
    expect(parseAcl(aclBytes([]))).toEqual([]);
  });
  test("an ACL parsed from bytes goes through the same check", () => {
    const parsed = parseAcl(aclBytes(PIPE.dacl!.aces));
    expect(privacyProblems({ owner: ME, dacl: { protected: true, aces: parsed } }, ME, { networkDeny: true, protected: true })).toEqual([]);
  });
  test("malformed ACLs throw rather than pass", () => {
    const good = aclBytes([allow(ME)]);
    expect(() => parseAcl(good.subarray(0, 6))).toThrow(/truncated/);
    expect(() => parseAcl(good.subarray(0, good.length - 1))).toThrow(/truncated/);
    const bad = good.slice();
    new DataView(bad.buffer).setUint16(10, 200, true);
    expect(() => parseAcl(bad)).toThrow(/out of range/);
    const moreAces = good.slice();
    new DataView(moreAces.buffer).setUint16(4, 2, true);
    expect(() => parseAcl(moreAces)).toThrow(/truncated/);
  });
});
