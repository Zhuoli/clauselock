#!/usr/bin/env python3
"""Independent (Python, stdlib-only) implementation of the ClauseLock v1 terms commitment.
Writes vectors/terms-hash-v1.json. The Rust program tests and the TS client both check against it."""
import hashlib, json, struct, pathlib

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58(b: bytes) -> str:
    n = int.from_bytes(b, "big"); s = ""
    while n: n, r = divmod(n, 58); s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s

def preimage(v):
    return (b"CLAUSELOCK_TERMS_V1" + bytes([v["schema_version"]]) + bytes.fromhex(v["sponsor_hex"]) +
            bytes.fromhex(v["contributor_hex"]) + struct.pack("<QQqqqB", v["escrow_id"], v["amount"],
            v["accept_by"], v["submit_by"], v["review_by"], v["refund_policy"]) + bytes.fromhex(v["doc_digest_hex"]))

cases = [
    dict(name="simple", schema_version=1, sponsor_hex="01"*32, contributor_hex="02"*32, escrow_id=7,
         amount=1_000_000_000, accept_by=1_760_000_100, submit_by=1_760_000_200, review_by=1_760_000_300,
         refund_policy=0, doc_digest_hex=hashlib.sha256(b"{}").hexdigest()),
    dict(name="max-ints", schema_version=1, sponsor_hex="ff"*32, contributor_hex="00"*31+"01", escrow_id=2**64-1,
         amount=2**64-1, accept_by=-1, submit_by=2**62, review_by=2**63-1, refund_policy=0, doc_digest_hex="ab"*32),
]
for c in cases:
    p = preimage(c)
    assert len(p) == 157
    c["sponsor"] = b58(bytes.fromhex(c["sponsor_hex"])); c["contributor"] = b58(bytes.fromhex(c["contributor_hex"]))
    c["preimage_hex"] = p.hex(); c["terms_hash_hex"] = hashlib.sha256(p).hexdigest()
out = {"schema": "clauselock-terms-hash-v1",
       "layout": "'CLAUSELOCK_TERMS_V1' | u8 schema_version | 32 sponsor | 32 contributor | u64 escrow_id | u64 amount | i64 accept_by | i64 submit_by | i64 review_by | u8 refund_policy | 32 doc_digest  (little-endian, 157 bytes); terms_hash = sha256(preimage)",
       "cases": cases}
path = pathlib.Path(__file__).resolve().parent.parent / "vectors" / "terms-hash-v1.json"
path.write_text(json.dumps(out, indent=2) + "\n"); print("wrote", path)
