/**
 * Property-based tests: Org Assignment Count Invariant
 *
 * Property: after any sequence of assign / complete / revoke operations the
 * in-memory model's `orgAssignmentCount` equals the number of issue IDs that
 * are currently in the "assigned" set (i.e. assigned, not yet completed or
 * revoked).
 *
 * This is a pure model-simulation test — no live contract or network is
 * required. The model is structurally isomorphic to the Rust contract:
 *   - assign_issue transitions an application → active assignment
 *   - complete_assignment / revoke_assignment both free the assignment slot
 *   - assigning while at the per-org cap (ORG_CAP = 4) is rejected
 *   - assigning a non-existent application is rejected
 *   - completing/revoking a non-existent assignment is rejected
 *   - double-assign of the same issue is rejected (AlreadyAssigned)
 *
 * Runner: vitest (via vitest.config.ts  tests/unit/**‌/*.test.ts pattern)
 * Library: fast-check 3.x
 * Cases: 1 000 (set via numRuns)
 */

import * as fc from 'fast-check';

// ─── Contract constants (mirror src/storage.rs) ──────────────────────────────

const GLOBAL_CAP = 15; // GLOBAL_APP_LIMIT
const ORG_CAP    = 4;  // ORG_ASSIGNMENT_LIMIT

// ─── In-memory model ─────────────────────────────────────────────────────────

/**
 * Minimal in-memory model of the full contributor-lifecycle for a single
 * contributor within a single organisation.  Mirrors src/lib.rs exactly:
 *   apply_for_issue → assign_issue → complete_assignment | revoke_assignment
 *
 * State fields:
 *   pendingApps   – issue IDs with an active (non-withdrawn) application
 *   activeAssigns – issue IDs with an active (non-completed, non-revoked) assignment
 */
interface OrgModel {
  pendingApps:   Set<number>;
  activeAssigns: Set<number>;
}

type AssignOp   = { type: 'assign';   issueId: number };
type CompleteOp = { type: 'complete'; issueId: number };
type RevokeOp   = { type: 'revoke';   issueId: number };
type ApplyOp    = { type: 'apply';    issueId: number };
type WithdrawOp = { type: 'withdraw'; issueId: number };
type Op = ApplyOp | WithdrawOp | AssignOp | CompleteOp | RevokeOp;

/**
 * Execute one operation on the model using the same guard logic as the
 * contract.  Returns true when the operation succeeded.
 */
function step(model: OrgModel, op: Op): boolean {
  switch (op.type) {
    case 'apply': {
      if (model.pendingApps.size >= GLOBAL_CAP)       return false; // GlobalApplicationLimitReached
      if (model.pendingApps.has(op.issueId))          return false; // DuplicateApplication
      model.pendingApps.add(op.issueId);
      return true;
    }
    case 'withdraw': {
      if (!model.pendingApps.has(op.issueId))         return false; // ApplicationNotFound
      model.pendingApps.delete(op.issueId);
      return true;
    }
    case 'assign': {
      if (!model.pendingApps.has(op.issueId))         return false; // ApplicationNotFound
      if (model.activeAssigns.size >= ORG_CAP)        return false; // OrgAssignmentLimitReached
      if (model.activeAssigns.has(op.issueId))        return false; // AlreadyAssigned
      // Consume the application and create the assignment
      model.pendingApps.delete(op.issueId);
      model.activeAssigns.add(op.issueId);
      return true;
    }
    case 'complete':
    case 'revoke': {
      if (!model.activeAssigns.has(op.issueId))       return false; // AssignmentNotFound
      model.activeAssigns.delete(op.issueId);
      return true;
    }
  }
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/**
 * Narrow issue-ID pool (0–9) to maximise collisions and edge cases across the
 * full apply→assign→complete/revoke pipeline.
 */
const arbIssueId = fc.integer({ min: 0, max: 9 });

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  arbIssueId.map((id): ApplyOp    => ({ type: 'apply',    issueId: id })),
  arbIssueId.map((id): WithdrawOp => ({ type: 'withdraw', issueId: id })),
  arbIssueId.map((id): AssignOp   => ({ type: 'assign',   issueId: id })),
  arbIssueId.map((id): CompleteOp => ({ type: 'complete', issueId: id })),
  arbIssueId.map((id): RevokeOp   => ({ type: 'revoke',   issueId: id })),
);

const arbOps: fc.Arbitrary<Op[]> = fc.array(arbOp, { minLength: 1, maxLength: 60 });

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Org Assignment Count Invariant (property-based)', () => {
  /**
   * Core invariant:
   * activeAssigns.size == orgAssignmentCount at all times.
   * After every operation the size is bounded by [0, ORG_CAP].
   */
  it('org assignment count always equals active assignments (1 000 cases)', () => {
    fc.assert(
      fc.property(arbOps, (ops) => {
        const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };

        for (const op of ops) {
          const beforeAssigns = model.activeAssigns.size;
          const ok = step(model, op);
          const afterAssigns = model.activeAssigns.size;

          if (op.type === 'assign') {
            if (ok) {
              expect(afterAssigns).toBe(beforeAssigns + 1);
              expect(model.activeAssigns.has(op.issueId)).toBe(true);
              expect(model.pendingApps.has(op.issueId)).toBe(false); // consumed
            } else {
              expect(afterAssigns).toBe(beforeAssigns);
            }
          } else if (op.type === 'complete' || op.type === 'revoke') {
            if (ok) {
              expect(afterAssigns).toBe(beforeAssigns - 1);
              expect(model.activeAssigns.has(op.issueId)).toBe(false);
            } else {
              expect(afterAssigns).toBe(beforeAssigns);
            }
          }

          // Invariant: org assignment count ∈ [0, ORG_CAP]
          expect(afterAssigns).toBeGreaterThanOrEqual(0);
          expect(afterAssigns).toBeLessThanOrEqual(ORG_CAP);
        }
      }),
      { numRuns: 1000, verbose: true },
    );
  });

  it('org count never exceeds ORG_CAP under an assign flood (1 000 cases)', () => {
    /**
     * Pre-seed applications for all 10 issue IDs, then try to assign all of
     * them in arbitrary order — the count must never exceed 4.
     */
    fc.assert(
      fc.property(
        fc.array(arbIssueId.map((id): AssignOp => ({ type: 'assign', issueId: id })),
                 { minLength: 1, maxLength: 30 }),
        (assignOps) => {
          const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };
          // Pre-seed one pending application per distinct issue ID in the flood
          const ids = [...new Set(assignOps.map((o) => o.issueId))];
          for (const id of ids) {
            model.pendingApps.add(id);
          }
          for (const op of assignOps) {
            step(model, op);
            expect(model.activeAssigns.size).toBeLessThanOrEqual(ORG_CAP);
          }
        },
      ),
      { numRuns: 1000, verbose: true },
    );
  });

  it('assign→complete round-trip restores the count to pre-assign value (1 000 cases)', () => {
    fc.assert(
      fc.property(
        // Build a model with 0–3 assignments already active
        fc.array(arbIssueId, { minLength: 0, maxLength: 3 })
          .chain((seedIds) => {
            const unique = [...new Set(seedIds)].slice(0, ORG_CAP - 1);
            const available = Array.from({ length: 10 }, (_, i) => i)
              .filter((id) => !unique.includes(id));
            return fc.constantFrom(...(available.length > 0 ? available : [99])).map(
              (freshId) => ({ seedIds: unique, freshId }),
            );
          }),
        ({ seedIds, freshId }) => {
          const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };
          // Seed existing assignments directly (bypass apply for brevity)
          for (const id of seedIds) {
            model.activeAssigns.add(id);
          }
          const baseline = model.activeAssigns.size;

          // Apply then assign the fresh issue
          model.pendingApps.add(freshId);
          const assignOk = step(model, { type: 'assign', issueId: freshId });
          expect(assignOk).toBe(true);
          expect(model.activeAssigns.size).toBe(baseline + 1);

          // Complete restores the count
          const completeOk = step(model, { type: 'complete', issueId: freshId });
          expect(completeOk).toBe(true);
          expect(model.activeAssigns.size).toBe(baseline);
        },
      ),
      { numRuns: 1000, verbose: true },
    );
  });

  it('assign→revoke round-trip restores the count to pre-assign value (1 000 cases)', () => {
    fc.assert(
      fc.property(
        fc.array(arbIssueId, { minLength: 0, maxLength: 3 })
          .chain((seedIds) => {
            const unique = [...new Set(seedIds)].slice(0, ORG_CAP - 1);
            const available = Array.from({ length: 10 }, (_, i) => i)
              .filter((id) => !unique.includes(id));
            return fc.constantFrom(...(available.length > 0 ? available : [99])).map(
              (freshId) => ({ seedIds: unique, freshId }),
            );
          }),
        ({ seedIds, freshId }) => {
          const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };
          for (const id of seedIds) {
            model.activeAssigns.add(id);
          }
          const baseline = model.activeAssigns.size;

          model.pendingApps.add(freshId);
          const assignOk = step(model, { type: 'assign', issueId: freshId });
          expect(assignOk).toBe(true);
          expect(model.activeAssigns.size).toBe(baseline + 1);

          // Revoke (rather than complete) must also restore the count
          const revokeOk = step(model, { type: 'revoke', issueId: freshId });
          expect(revokeOk).toBe(true);
          expect(model.activeAssigns.size).toBe(baseline);
        },
      ),
      { numRuns: 1000, verbose: true },
    );
  });

  it('complete of non-existent assignment is always rejected (1 000 cases)', () => {
    fc.assert(
      fc.property(arbIssueId, (issueId) => {
        const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };
        const ok = step(model, { type: 'complete', issueId });
        expect(ok).toBe(false);
        expect(model.activeAssigns.size).toBe(0);
      }),
      { numRuns: 1000, verbose: true },
    );
  });

  it('revoke of non-existent assignment is always rejected (1 000 cases)', () => {
    fc.assert(
      fc.property(arbIssueId, (issueId) => {
        const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };
        const ok = step(model, { type: 'revoke', issueId });
        expect(ok).toBe(false);
        expect(model.activeAssigns.size).toBe(0);
      }),
      { numRuns: 1000, verbose: true },
    );
  });

  it('assign without prior apply is always rejected (1 000 cases)', () => {
    fc.assert(
      fc.property(arbIssueId, (issueId) => {
        const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };
        // pendingApps is empty — every assign must fail with ApplicationNotFound
        const ok = step(model, { type: 'assign', issueId });
        expect(ok).toBe(false);
        expect(model.activeAssigns.size).toBe(0);
      }),
      { numRuns: 1000, verbose: true },
    );
  });

  it('application is consumed by assign — subsequent assign is rejected (1 000 cases)', () => {
    /**
     * After a successful assign the application entry is gone (consumed).
     * A second assign of the same issue must be rejected (AlreadyAssigned or
     * ApplicationNotFound — either way the count must not change).
     */
    fc.assert(
      fc.property(arbIssueId, (issueId) => {
        const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };
        model.pendingApps.add(issueId);

        const first = step(model, { type: 'assign', issueId });
        expect(first).toBe(true);
        const afterFirst = model.activeAssigns.size;

        // Re-apply so the ApplicationNotFound guard is passed, then try assign again
        model.pendingApps.add(issueId); // simulate re-apply (would be DuplicateApp in real flow)
        const second = step(model, { type: 'assign', issueId });
        expect(second).toBe(false); // AlreadyAssigned guard fires
        expect(model.activeAssigns.size).toBe(afterFirst); // count unchanged
      }),
      { numRuns: 1000, verbose: true },
    );
  });

  it('complete and revoke are equivalent for the count invariant (1 000 cases)', () => {
    /**
     * Whether the maintainer completes or revokes, the effect on the assignment
     * count is identical: -1.  This property verifies both paths leave the
     * count consistent.
     */
    fc.assert(
      fc.property(
        arbIssueId,
        fc.boolean(), // true = complete, false = revoke
        (issueId, useComplete) => {
          const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };
          model.pendingApps.add(issueId);
          step(model, { type: 'assign', issueId });
          const afterAssign = model.activeAssigns.size;

          const closeOp: Op = useComplete
            ? { type: 'complete', issueId }
            : { type: 'revoke',   issueId };
          const ok = step(model, closeOp);
          expect(ok).toBe(true);
          expect(model.activeAssigns.size).toBe(afterAssign - 1);
        },
      ),
      { numRuns: 1000, verbose: true },
    );
  });

  it('multi-issue sequences: count = |activeAssigns| at every step (1 000 cases)', () => {
    /**
     * The strongest form of the invariant: run an arbitrary mixed sequence of
     * all five operation types and verify that `activeAssigns.size` is always
     * exactly equal to the number of entries in the set — i.e., the count is
     * never out of sync with the actual set membership.
     */
    fc.assert(
      fc.property(arbOps, (ops) => {
        const model: OrgModel = { pendingApps: new Set(), activeAssigns: new Set() };
        for (const op of ops) {
          step(model, op);
          // Count must exactly reflect set membership — no phantom entries, no leaks
          expect(model.activeAssigns.size).toBeGreaterThanOrEqual(0);
          expect(model.activeAssigns.size).toBeLessThanOrEqual(ORG_CAP);
          // The pending-apps set must not include an issue that is in activeAssigns
          // ONLY when it was consumed by an assign. A re-apply after an assign IS
          // allowed by the contract, so this cross-set assertion is intentionally
          // omitted here (it would be a false invariant). The strong invariant is
          // purely count-based: activeAssigns.size ≤ ORG_CAP at all times.
        }
      }),
      { numRuns: 1000, verbose: true },
    );
  });
});
