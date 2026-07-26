# Runbook: Emergency Global Cap Increase

**Contract function:** `emergency_set_global_cap(admin, new_cap)`  
**Issue:** #355  
**Last updated:** 2026-07-26  
**Owner:** Platform Admin

---

## 1. Overview

The `emergency_set_global_cap` function allows an authorised admin to immediately raise (or lower) the global application cap during a live wave — without waiting for a contract upgrade.

The default cap is **15 pending applications per contributor** across all organisations. When an unusually large cohort joins a wave simultaneously, contributors may hit this limit before a maintainer has time to process their existing applications, blocking further participation.

This function bypasses the normal governance process and takes effect **on the very next transaction**. Use it only when the criteria in section 2 are met.

---

## 2. When to Use This Runbook

**Trigger condition (all of the following must be true):**

1. A measurable surge of new contributors has joined the current wave (≥ 30 % growth over the baseline 24-hour average, or > 50 absolute new contributors per hour).
2. Multiple contributors have already hit the 15-application cap and are unable to apply for new issues.
3. The maintainer queue is not the bottleneck — i.e., issues are available but the cap is blocking applications.
4. The wave is still active (raising the cap after a wave closes has no practical effect).

**Do NOT use this function if:**

- The queue is backed up because maintainers are slow — a higher cap will make the backlog worse.
- The root cause is a bug in the application counter — fix the bug first.
- More than 48 hours remain in the wave and the situation can be resolved through normal throughput.

---

## 3. Approval Process

Emergency cap changes must be authorised before execution.

| Step | Who | Action |
|------|-----|--------|
| 1 | On-call engineer | Files an incident report linking this runbook and the triggering metrics |
| 2 | Platform lead or CTO | Reviews the metrics, approves the specific `new_cap` value |
| 3 | On-call engineer | Executes the function (section 5) and records the transaction hash |
| 4 | Platform lead | Confirms the event appears in the event log within 2 minutes |
| 5 | On-call engineer | Monitors for 15 minutes; triggers rollback (section 6) if unintended side effects appear |

**Approval must be explicit (Slack/email/ticket) before step 3.** Verbal approval is not sufficient.

**Maximum approved cap:** **100** (enforced on-chain by `CapOutOfRange` = error 12).  
**Recommended increment:** raise by 5–10 above the current value. Avoid jumping to 100 unless the wave is extremely large.

---

## 4. Pre-Execution Checklist

- [ ] Incident report created and linked to this runbook
- [ ] Approval documented (name, timestamp, approved `new_cap` value)
- [ ] Admin key available in an HSM or equivalent secure credential store
- [ ] Network (testnet / mainnet) confirmed — **double-check before signing**
- [ ] Current cap confirmed via `get_global_cap` query (should be 15 unless already overridden)
- [ ] Stellar CLI version pinned (`stellar --version` output recorded in the incident)

---

## 5. Execution

### 5.1 Query the current cap

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  -- get_global_cap
```

Expected output: `15` (or the last overridden value).

### 5.2 Apply the emergency cap increase

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  --source <admin-account> \
  -- emergency_set_global_cap \
  --admin <ADMIN_ADDRESS> \
  --new_cap <APPROVED_VALUE>
```

**Record the transaction hash immediately.**

### 5.3 Verify the change took effect

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  -- get_global_cap
```

Expected output: `<APPROVED_VALUE>`.

### 5.4 Confirm the EmergencyCapUpdated event

Query the contract events and verify that the most recent event has:
- Topic 0: `emrg_cap`
- Topic 1: `<ADMIN_ADDRESS>`
- Data: `(<APPROVED_VALUE>,)`

```bash
stellar contract events \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  --start-ledger <ledger_before_tx>
```

---

## 6. Rollback Procedure

The cap can be restored to any value, including the default of 15, by calling `emergency_set_global_cap` again.

### 6.1 Restore the default cap

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  --source <admin-account> \
  -- emergency_set_global_cap \
  --admin <ADMIN_ADDRESS> \
  --new_cap 15
```

### 6.2 Verify rollback

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network <testnet|mainnet> \
  -- get_global_cap
```

Expected output: `15`.

### 6.3 Confirm a second EmergencyCapUpdated event was emitted

Follow the same event-verification steps as section 5.4. The new event's data should show `(15,)`.

### 6.4 When to roll back

Roll back immediately if any of the following occur within 15 minutes of the cap raise:

- The total pending application count grows faster than maintainers can process (backlog growing, not shrinking)
- Any contributor exceeds the new cap before maintainers review their applications (indicates the cap is too high)
- Unexpected contract errors appear in the event stream
- The transaction hash from section 5.2 cannot be confirmed on-chain

---

## 7. Monitoring Alert

### Alert: Global cap changed more than twice in 24 hours

**Definition:** Two or more `emrg_cap` events emitted by the same contract within a rolling 24-hour window.

**Rationale:** A single emergency increase is expected during a surge event and is followed by one restoration. A third change in the same window indicates either runbook misuse, an automated script calling the function without approval, or repeated wave instability requiring a structural fix.

**Implementation (CloudWatch / Datadog / equivalent):**

```
METRIC: count of EmergencyCapUpdated events per contract per 24h rolling window
THRESHOLD: > 2
SEVERITY: P1 — page the platform lead immediately
ACTION: Freeze further emergency cap changes until the platform lead reviews the event history
```

**Stellar event filter:**

```json
{
  "type": "contract",
  "contractId": "<CONTRACT_ID>",
  "topic": ["emrg_cap"]
}
```

Count events matching this filter over a 24-hour sliding window. If the count exceeds **2**, trigger the alert.

**False-positive suppression:** Suppress the alert for 1 hour after a planned, pre-approved cap change that was recorded in the incident ticket.

---

## 8. Post-Incident Actions

After the wave closes or the surge subsides, complete the following:

1. **Close the incident report** with the final cap value and the total duration of the override.
2. **Update the wave baseline** — if > 50 contributors in a single wave is now the norm, consider raising `DEFAULT_GLOBAL_CAP` via a standard contract upgrade (not this emergency function).
3. **Retrospective** — within 48 hours, answer: what triggered the surge? Could it have been anticipated? Should the default cap be raised permanently?
4. **Verify the cap is back to 15** before the next wave begins.

---

## 9. Error Reference

| Code | Variant | Meaning in this context |
|------|---------|------------------------|
| 2 | `NotInitialized` | Contract not yet initialised — cannot call this function |
| 3 | `UnauthorizedAdmin` | Auth check failed — wrong signing key or wrong admin address |
| 12 | `CapOutOfRange` | `new_cap` was outside `[0, 100]` — check the approved value |

---

## 10. Related Documents

- [docs/error-reference.md](../error-reference.md) — full error code reference
- [docs/deployment-runbook.md](../deployment-runbook.md) — standard upgrade procedure
- [docs/rollback-runbook.md](../rollback-runbook.md) — full contract rollback (last resort)
- [docs/storage-design.md](../storage-design.md) — storage key layout including `g_cap`
