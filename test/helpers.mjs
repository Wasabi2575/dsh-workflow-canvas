import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const CLIENT_CODE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const CLIENT_STATE_NAMES = [
  ...CLIENT_CODE.slice(CLIENT_CODE.indexOf('function WorkflowCanvas(')).matchAll(/const \[(\w+),\s*\w+\] = useState\(/g),
].map((m) => m[1]);

export function loadClientTestExports(storageMap, stateOverrides = {}) {
  let loaded = null;
  const store = storageMap instanceof Map ? storageMap : null;
  const mockLocalStorage = store
    ? {
        get length() { return store.size; },
        key: (i) => Array.from(store.keys())[i] ?? null,
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(String(k), String(v)); },
        removeItem: (k) => { store.delete(String(k)); },
      }
    : {
        getItem: () => null,
        setItem: () => {},
      };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(mod) { loaded = mod; },
      },
      localStorage: mockLocalStorage,
    },
    console,
    Math,
    Date,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Infinity,
    encodeURIComponent,
    decodeURIComponent,
  };
  for (const key of Object.keys(stateOverrides)) {
    assert.ok(CLIENT_STATE_NAMES.includes(key), 'known state fixture: ' + key);
  }
  let stateIndex = 0;
  vm.runInNewContext(CLIENT_CODE, sandbox);
  assert.ok(loaded, 'client module registered');
  assert.equal(loaded.id, 'dsh-workflow-canvas', 'module id matches published package name');
  const mod = loaded.factory((name) => {
    if (name === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: (v) => {
          const name = CLIENT_STATE_NAMES[stateIndex++];
          return [Object.hasOwn(stateOverrides, name) ? stateOverrides[name] : (typeof v === 'function' ? v() : v), () => {}];
        },
        useRef: (v) => ({ current: v }),
        useEffect: () => {},
        Component: class {},
        Fragment: Symbol('Fragment'),
      };
    }
    throw new Error('unexpected require: ' + name);
  });
  return mod.__test;
}

export async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
