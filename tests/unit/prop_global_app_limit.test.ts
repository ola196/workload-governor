/**
 * Property-based tests: Global Application Count Invariant
 *
 * Property: after any sequence of apply / withdraw operations the in-memory
 * model's `globalCount` equals the number of issue IDs that are currently in
 * the "applied" set (i.e. applied and not yet withdrawn).
 *
 * This is a pure model-simulation test — no live contract or network is
 * required. The model is structurally isomorphic to the Rust contract:
 *   - apply increments the counter and records the application
 *   - withdraw decrements the counter and removes the application
 *   - applying while at the cap (GLOBAL_CAP = 15) is rejected
 *   - duplicate applications are rejected
 *   - withdrawing a non-existent application is rejected
 *
 * Runner: vitest (via vitest.config.ts  tests/unit/**‌/*.test.ts pattern)
 * Library: fast-check 3.x
 * Cases: 1 000 (fc default; overridden to 1 000 via numRuns)
 */

import * as fc from 'fast-check';

// ─── Contract constants (mirror src/storage.rs) ──────────────────────────────

const GLOBAL_CAP = 15; // GLOBAL_APP_LIMIT in the Rust contract

// ─── In-memory model ─────────────────────────────────────────────────────────

/**
 * Minimal in-memory model of the contract's global-application state for a
 * single contributor.  Mirrors the logic inside `apply_for_issue` and
 * `withdraw_application` in src/lib.rs exactly.
 */
interface GlobalModel {
  /** Set of issue IDs that have an active (non-withdrawn) application. */
  applied: Set<number>;
}

type ApplyOp   = { type: 'apply';    issueId: number };
type WithdrawOp= { type: 'withdraw'; issueId: number };
type Op = ApplyOp | WithdrawOp;

/** Apply one operation to the model, enforcing the same guards as the contract.
 *  Returns the updated model and a boolean indicating whether the operation
 *  succeeded (true) or was rejected by a guard (false). */
function step(model: GlobalModel, op: Op): boolean {
  if (op.type === 'apply') {
    // Guard: global cap
    if (model.applied.size >= GLOBAL_CAP) return false;
    // Guard: duplicate application
    if (model.applied.has(op.issueId)) return false;
    model.applied.add(op.issueId);
    return true;
  } else {
    // withdraw
    // Guard: application must exist
    if (!model.applied.has(op.issueId)) return false;
    model.applied.delete(op.issueId);
    return true;
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Generates a pool of issue IDs intentionally small (0–19) so that the
 * sequence produces meaningful interactions: duplicates, cap pressure, etc.
 */
const arbIssueId = fc.integer({ min: 0, max: 19 });

/** A single operation drawn from apply | withdraw over the small issue pool. */
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  arbIssueId.map((id): ApplyOp    => ({ type: 'apply',    issueId: id })),
  arbIssueId.map((id): WithdrawOp => ({ type: 'withdraw', issueId: id })),
);

/** A sequence of 1 – 50 operations — enough to exercise the cap and
 *  round-trip behaviour without making each run too slow. */
const arbOps: fc.Arbitrary<Op[]> = fc.array(arbOp, { minLength: 1, maxLength: 50 });

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Global Application Count Invariant (property-based)', () => {
  /**
   * Core invariant:
   * After every step, model.applied.size === globalCount derived from the set.
   * Because our model *is* the set, this trivially holds — the real value is
   * in verifying the surrounding constraints (cap, duplicate rejection, etc.)
   * never corrupt the count, matching the Rust contract behaviour exactly.
   */
  it('count always equals the number of active applications (1 000 cases)', () => {
    fc.assert(
      fc.property(arbOps, (ops) => {
        const model: GlobalModel = { applied: new Set() };

        for (const op of ops) {
          const before = model.applied.size;
          const ok = step(model, op);
          const after = model.applied.size;

          if (op.type === 'apply') {
            if (ok) {
              // Successful apply: count must have incremented by exactly 1
              expect(after).toBe(before + 1);
              expect(model.applied.has(op.issueId)).toBe(true);
            } else {
              // Rejected (cap or duplicate): count must be unchanged
              expect(after).toBe(before);
            }
          } else {
            // withdraw
            if (ok) {
              // Successful withdraw: count must have decremented by exactly 1
              expect(after).toBe(before - 1);
              expect(model.applied.has(op.issueId)).toBe(false);
            } else {
              // Rejected (not found): count must be unchanged
              expect(after).toBe(before);
            }
          }

          // Invariant: count is always in [0, GLOBAL_CAP]
          expect(after).toBeGreaterThanOrEqual(0);
          expect(after).toBeLessThanOrEqual(GLOBAL_CAP);

          // Invariant: set size == "global count" — no phantom entries
          expect(model.applied.size).toBe(after);
        }
      }),
      { numRuns: 1000, verbose: true },
    );
  });

  it('count never exceeds GLOBAL_CAP regardless of apply flood (1 000 cases)', () => {
    /** Apply-only flood — the cap must be the ceiling, always. */
    const arbApplyFlood = fc.array(
      arbIssueId.map((id): ApplyOp => ({ type: 'apply', issueId: id })),
      { minLength: 1, maxLength: 100 },
    );

    fc.assert(
      fc.property(arbApplyFlood, (ops) => {
        const model: GlobalModel = { applied: new Set() };
        for (const op of ops) {
          step(model, op);
          expect(model.applied.size).toBeLessThanOrEqual(GLOBAL_CAP);
        }
      }),
      { numRuns: 1000, verbose: true },
    );
  });

  it('count after withdraw round-trip returns to pre-apply value (1 000 cases)', () => {
    /**
     * For any valid apply followed by an immediate withdraw of the same issue,
     * the count must return to exactly where it was before the apply.
     */
    fc.assert(
      fc.property(
        // Build a model with 0–14 applications already active
        fc.array(arbIssueId, { minLength: 0, maxLength: 14 })
          .chain((seedIds) => {
            // Deduplicate seeds so they can all be applied cleanly
            const unique = [...new Set(seedIds)].slice(0, GLOBAL_CAP - 1);
            // Pick a fresh issue ID not already in the seed set
            const available = Array.from({ length: 20 }, (_, i) => i)
              .filter((id) => !unique.includes(id));
            return fc.constantFrom(...(available.length > 0 ? available : [99])).map(
              (freshId) => ({ seedIds: unique, freshId }),
            );
          }),
        ({ seedIds, freshId }) => {
          const model: GlobalModel = { applied: new Set() };
          // Seed pre-existing applications
          for (const id of seedIds) {
            step(model, { type: 'apply', issueId: id });
          }
          const baseline = model.applied.size;

          // Apply a fresh issue
          const applyOk = step(model, { type: 'apply', issueId: freshId });
          expect(applyOk).toBe(true);
          expect(model.applied.size).toBe(baseline + 1);

          // Withdraw the same issue
          const withdrawOk = step(model, { type: 'withdraw', issueId: freshId });
          expect(withdrawOk).toBe(true);

          // Count must be back to baseline
          expect(model.applied.size).toBe(baseline);
        },
      ),
      { numRuns: 1000, verbose: true },
    );
  });

  it('count is monotonically non-decreasing during apply-only sequences (1 000 cases)', () => {
    /**
     * When operations are exclusively applies (no withdrawals),
     * the count must never decrease.
     */
    const arbApplyOnly = fc.array(
      arbIssueId.map((id): ApplyOp => ({ type: 'apply', issueId: id })),
      { minLength: 1, maxLength: 30 },
    );

    fc.assert(
      fc.property(arbApplyOnly, (ops) => {
        const model: GlobalModel = { applied: new Set() };
        let prev = 0;
        for (const op of ops) {
          step(model, op);
          expect(model.applied.size).toBeGreaterThanOrEqual(prev);
          prev = model.applied.size;
        }
      }),
      { numRuns: 1000, verbose: true },
    );
  });

  it('duplicate apply is always rejected — count unchanged (1 000 cases)', () => {
    fc.assert(
      fc.property(arbIssueId, (issueId) => {
        const model: GlobalModel = { applied: new Set() };
        step(model, { type: 'apply', issueId });
        const after_first = model.applied.size;

        // Second apply of the same issue must be rejected
        const ok = step(model, { type: 'apply', issueId });
        expect(ok).toBe(false);
        expect(model.applied.size).toBe(after_first);
      }),
      { numRuns: 1000, verbose: true },
    );
  });

  it('withdraw of non-existent application is always rejected (1 000 cases)', () => {
    fc.assert(
      fc.property(arbIssueId, (issueId) => {
        const model: GlobalModel = { applied: new Set() };
        // Never applied — withdraw must be rejected
        const ok = step(model, { type: 'withdraw', issueId });
        expect(ok).toBe(false);
        expect(model.applied.size).toBe(0);
      }),
      { numRuns: 1000, verbose: true },
    );
  });
});
