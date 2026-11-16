import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "package.json"));
const payload = () => JSON.parse('{"__proto__":{"injected":true}}');

function assertSafe(value) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(value.injected, undefined);
  assert.equal(Object.hasOwn(value, "__proto__"), false);
  assert.equal(Object.prototype.injected, undefined);
}

// Exercise both shipped bundles; require("deepmerge") loads the CJS bundle.
for (const bundle of ["cjs", "umd"]) {
  const merge = require(`deepmerge/dist/${bundle}.js`);

  test(`${bundle}: merging into a null-prototype target preserves a safe prototype`, () => {
    const target = Object.assign(Object.create(null), { enabled: false });
    const result = merge(target, payload());
    assertSafe(result);
    assert.equal(result.enabled, false);
  });

  for (const placeholder of [null, undefined, false, 0, "example"]) {
    test(`${bundle}: nested ${String(placeholder)} placeholder cannot acquire a prototype`, () => {
      const result = merge({ options: placeholder }, { options: payload() });
      assertSafe(result.options);
    });
  }

  test(`${bundle}: own __proto__ keys on either merge operand are ignored`, () => {
    const target = { ...payload(), enabled: true };
    const result = merge(target, { ...payload(), count: 2 });
    assertSafe(result);
    assert.equal(result.enabled, true);
    assert.equal(result.count, 2);
    assertSafe(merge(target, {}));
    assertSafe(merge({}, payload()));
  });

  test(`${bundle}: nested array elements and merge.all cannot acquire a prototype`, () => {
    const result = merge({ items: [payload()] }, { items: [payload()] });
    result.items.forEach(assertSafe);
    assertSafe(merge.all([payload(), { enabled: true }]));
  });

  test(`${bundle}: forbidden getters are never evaluated on either operand`, () => {
    const hostile = Object.defineProperty({}, "__proto__", {
      enumerable: true,
      get() { throw new Error("unsafe property was read"); },
    });
    assertSafe(merge(hostile, {}));
    assertSafe(merge(Object.create(null), hostile));
  });

  test(`${bundle}: ordinary objects, arrays, symbols and custom merge remain compatible`, () => {
    const key = Symbol("example");
    const target = { config: { enabled: true }, items: [1], [key]: { first: true } };
    const source = { config: { count: 2 }, items: [2], [key]: { second: true } };
    const result = merge(target, source);
    assert.deepEqual(result, {
      config: { enabled: true, count: 2 }, items: [1, 2], [key]: { first: true, second: true },
    });
    assert.notEqual(result.config, target.config);
    assert.deepEqual(merge(target, source, {
      customMerge: name => name === "items" ? (_, next) => next : undefined,
    }).items, [2]);
  });
}
