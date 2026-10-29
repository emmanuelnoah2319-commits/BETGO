// Minimal in-memory stand-in for the MongoDB operations the membership services use. Each operation is atomic and
// yields once first, so Promise.all() interleaves callers the way concurrent requests would.
const same = (a, b) => (a == null && b == null) || String(a) === String(b);

function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((branch) => matches(doc, branch));
    const value = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond) && !('_bsontype' in cond) && Object.keys(cond).some((k) => k.startsWith('$'))) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$ne') return Array.isArray(value) ? !value.some((v) => same(v, arg)) : !same(value, arg);
        if (op === '$in') return arg.some((a) => same(value, a));
        if (op === '$lt') return value != null && value < arg;
        if (op === '$gt') return value != null && value > arg;
        throw new Error(`fake-db: unsupported operator ${op}`);
      });
    }
    return same(value, cond);
  });
}

function applyUpdate(doc, update) {
  for (const [k, v] of Object.entries(update.$set || {})) doc[k] = v;
  for (const [k, v] of Object.entries(update.$addToSet || {})) { doc[k] = doc[k] || []; if (!doc[k].some((x) => same(x, v))) doc[k].push(v); }
  for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v;
}

export function createFakeDb({ unique = { users: ['emailNormalized'], payments: ['reference'] } } = {}) {
  const store = new Map();
  let counter = 0;
  const table = (name) => { if (!store.has(name)) store.set(name, []); return store.get(name); };
  const collection = (name) => ({
    async findOne(filter = {}) { await Promise.resolve(); const hit = table(name).find((d) => matches(d, filter)); return hit ? structuredClone(hit) : null; },
    async insertOne(doc) {
      await Promise.resolve();
      for (const field of unique[name] || []) {
        if (table(name).some((d) => same(d[field], doc[field]))) { const error = new Error(`E11000 duplicate key on ${name}.${field}`); error.code = 11000; throw error; }
      }
      const stored = structuredClone(doc); stored._id = stored._id ?? `id${++counter}`; table(name).push(stored);
      return { insertedId: stored._id };
    },
    async updateOne(filter, update) {
      await Promise.resolve(); const hit = table(name).find((d) => matches(d, filter));
      if (!hit) return { matchedCount: 0, modifiedCount: 0 }; applyUpdate(hit, update); return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      await Promise.resolve(); const hit = table(name).find((d) => matches(d, filter));
      if (!hit) return null; const before = structuredClone(hit); applyUpdate(hit, update);
      return options.returnDocument === 'after' ? structuredClone(hit) : before;
    }
  });
  return { collection, rows: (name) => table(name), seed: (name, doc) => { const stored = structuredClone(doc); stored._id = stored._id ?? `id${++counter}`; table(name).push(stored); return stored; } };
}
