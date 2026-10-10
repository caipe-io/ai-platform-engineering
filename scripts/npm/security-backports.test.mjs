import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { braceBefore, braceAfter, forgeBefore, forgeAfter, patchSource } from "./patch-security-dependencies.mjs";

const require = createRequire(resolve(process.cwd(), "package.json"));
const braces = require("braces");

test("normal brace expansion and matching remain compatible", () => {
  assert.deepEqual(braces.expand("{primary,secondary}/{1..3}"),
    ["primary/1", "primary/2", "primary/3", "secondary/1", "secondary/2", "secondary/3"]);
  assert.match("primary/2", new RegExp(braces.compile("{primary,secondary}/{1..3}")));
  assert.deepEqual(braces.expand("\\{literal\\}"), ["{literal}"]);
});

for (const [open, close] of [["{", "}"], ["(", ")"], ["{(", ")}"]]) {
  for (const operation of ["parse", "compile", "expand"]) {
    test(`${operation} rejects excessive ${open} nesting before recursive traversal`, () => {
      const pattern = open.repeat(3500) + "example" + close.repeat(3500);
      // Some inputs exceed the length limit; both guards must fail with SyntaxError.
      assert.throws(() => braces[operation](pattern), SyntaxError);
      const bounded = open.repeat(101) + "example" + close.repeat(101);
      assert.throws(() => braces[operation](bounded), /maximum depth/);
      assert.doesNotThrow(() => braces[operation](open.repeat(10) + "example" + close.repeat(10)));
    });
  }
}

test("patching is idempotent and rejects partial patches or source drift", () => {
  for (const [before, after, count] of [[braceBefore, braceAfter, 2], [forgeBefore, forgeAfter, 1]]) {
    const original = Array(count).fill(before).join("\n");
    const patched = patchSource(original, before, after, count, "example");
    assert.equal(patchSource(patched, before, after, count, "example"), patched);
    assert.throws(() => patchSource("unexpected source", before, after, count, "example"));
    assert.throws(() => patchSource(patched + before, before, after, count, "example"));
  }
});

let forge;
try { forge = require("node-forge"); } catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}

test("RSA verifies valid signatures and rejects extra DigestAlgorithm elements", { skip: !forge }, () => {
  const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 65537 });
  const hash = forge.md.sha256.create().update("example message");
  const digest = hash.digest().getBytes();
  assert.equal(publicKey.verify(digest, privateKey.sign(hash)), true);
  const { Class, Type, create, oidToDer, toDer } = forge.asn1;
  const sequence = values => create(Class.UNIVERSAL, Type.SEQUENCE, true, values);
  const oid = create(Class.UNIVERSAL, Type.OID, false, oidToDer(forge.pki.oids.sha256).getBytes());
  const nil = create(Class.UNIVERSAL, Type.NULL, false, "");
  const extra = create(Class.UNIVERSAL, Type.OCTETSTRING, false, "unexpected");
  const digestValue = create(Class.UNIVERSAL, Type.OCTETSTRING, false, digest);
  for (const algorithm of [[oid], [oid, nil]]) {
    const encoded = toDer(sequence([sequence(algorithm), digestValue])).getBytes();
    assert.equal(publicKey.verify(digest, privateKey.sign(encoded, "NONE")), true);
  }
  for (const algorithm of [[oid, nil, extra], [oid, nil, nil]]) {
    const encoded = toDer(sequence([sequence(algorithm), digestValue])).getBytes();
    const signature = privateKey.sign(encoded, "NONE");
    assert.throws(() => publicKey.verify(digest, signature), /valid RSASSA-PKCS1-v1_5/);
  }
});
