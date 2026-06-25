# WorkloadGovernor — Admin Guide

**Scope:** Deployment, initialization, maintainer registration, upgrades, and emergency procedures for the WorkloadGovernor Soroban contract.

---

## 1. Admin key management

The admin address is written to persistent storage on the first `initialize` call and **cannot be changed afterward** — there is no `transfer_admin` function. Choose it carefully before deployment.

### Best practices

- **Use a hardware wallet or multisig account.** A Stellar multisig account (e.g., 2-of-3 co-signers) means no single machine compromise can authorize a privileged call.
- **Never store the admin secret key in plaintext.** Use a secrets manager (AWS Secrets Manager, HashiCorp Vault) or a hardware security module.
- **Keep the admin key offline for routine operations.** Day-to-day operations (assigning issues, etc.) use maintainer keys. Only take the admin key online to register maintainers or upgrade the contract.
- **Rotate the signing device, not the contract admin.** Because the admin address is immutable, if the key material is ever compromised the only remediation is deploying a new contract instance and migrating users.
- **Audit every admin transaction.** Log all invocations of `initialize`, `register_maintainer`, and `upgrade` to an append-only audit trail.

---

## 2. Deploy, initialize, register first maintainer

### Prerequisites

```bash
# Install Rust wasm32 target
rustup target add wasm32v1-none

# Install Stellar CLI (v21+ recommended)
cargo install --locked stellar-cli --features opt
```

### Step 1 — Build and optimize the WASM

```bash
stellar contract build
stellar contract optimize \
  --wasm target/wasm32v1-none/release/workload_governor.wasm
```

The optimized file is `target/wasm32v1-none/release/workload_governor.optimized.wasm`.

### Step 2 — Deploy to testnet

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/workload_governor.optimized.wasm \
  --network testnet \
  --source <admin-account>
```

Save the printed contract ID — you will need it for every subsequent call.

```bash
export CONTRACT_ID=<printed-contract-id>
```

### Step 3 — Initialize the contract

`initialize` may only be called once. The `--source` account must match `--admin`.

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  --source <admin-account> \
  -- initialize \
  --admin <ADMIN_ADDRESS>
```

On success an `initialized` event is emitted. Any second call returns error `1` (`AlreadyInitialized`).

### Step 4 — Register the first maintainer

The admin must be online to sign this call.

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  --source <admin-account> \
  -- register_maintainer \
  --admin <ADMIN_ADDRESS> \
  --maintainer <MAINTAINER_ADDRESS> \
  --org_id <ORG_SYMBOL>
```

`org_id` is a Soroban `Symbol` (≤ 9 alphanumeric characters, e.g. `my_org`). The call is idempotent — re-registering the same `(maintainer, org_id)` pair is safe.

### Verify

```bash
# Confirm the contract is live
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  -- get_global_application_count \
  --contributor <ANY_ADDRESS>
# Expected: 0
```

---

## 3. Upgrading the contract

Soroban upgrades are in-place: the contract address stays the same, only the WASM changes.

### Step 1 — Build and test the new version

```bash
# Run the full test suite against the new code
cargo test --features testutils

stellar contract build
stellar contract optimize \
  --wasm target/wasm32v1-none/release/workload_governor.wasm
```

### Step 2 — Upload the new WASM to the network

```bash
stellar contract upload \
  --wasm target/wasm32v1-none/release/workload_governor.optimized.wasm \
  --network testnet \
  --source <admin-account>
```

Save the printed 32-byte hash:

```bash
export NEW_WASM_HASH=<printed-hash>
```

### Step 3 — Invoke `upgrade`

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network testnet \
  --source <admin-account> \
  -- upgrade \
  --new_wasm_hash "$NEW_WASM_HASH"
```

All persistent storage (admin, maintainers, assignments) is preserved across an upgrade because only the WASM is replaced, not the contract's ledger entries.

### Step 4 — Verify

```bash
# Fetch the running WASM hash and compare to $NEW_WASM_HASH
stellar contract info \
  --id "$CONTRACT_ID" \
  --network testnet
```

### Rollback considerations

Soroban does **not** provide a built-in rollback for WASM upgrades. To revert:

1. Keep the previous WASM file (or its hash) in version control or artifact storage before every upgrade.
2. If a problem is detected after upgrading, re-upload the previous WASM:
   ```bash
   stellar contract upload \
     --wasm target/wasm32v1-none/release/workload_governor_vPREV.optimized.wasm \
     --network mainnet \
     --source <admin-account>
   # Then call upgrade again with the old hash
   stellar contract invoke \
     --id "$CONTRACT_ID" \
     --network mainnet \
     --source <admin-account> \
     -- upgrade \
     --new_wasm_hash <PREVIOUS_WASM_HASH>
   ```
3. Storage schema changes in the new WASM that are incompatible with existing data cannot be rolled back by reverting the WASM. If a schema migration was applied, assess data integrity before re-invoking the old code.
4. Test every upgrade on testnet before applying to mainnet. The smoke test suite at `tests/smoke/testnet-smoke.sh` covers the core flows.

---

## 4. Emergency procedures

### 4a. Suspected admin key compromise

The contract has no `transfer_admin` function. If the admin key is compromised:

1. **Immediately stop using the compromised account** — revoke signing authority at the wallet/multisig level if possible.
2. **Assess blast radius:** an attacker with the admin key can call `register_maintainer` (adding unauthorized maintainers) and `upgrade` (replacing the contract logic). They cannot directly move funds — this is a governance contract, not a token contract.
3. **Deploy a new contract instance** using a freshly generated admin key:
   ```bash
   stellar contract deploy \
     --wasm target/wasm32v1-none/release/workload_governor.optimized.wasm \
     --network mainnet \
     --source <new-admin-account>
   stellar contract invoke --id <NEW_CONTRACT_ID> ... -- initialize --admin <NEW_ADMIN>
   ```
4. **Update all integrations** (backend `CONTRACT_ID` env var, frontend config) to point to the new contract.
5. **Communicate to maintainers and contributors** — existing applications and assignments on the old contract are lost; contributors must reapply on the new contract.

### 4b. Unauthorized maintainer registered

If a malicious `register_maintainer` call succeeded:

- There is no `deregister_maintainer` function in the current contract. The unauthorized maintainer can call `assign_issue`, `complete_assignment`, and `revoke_assignment` for their registered `org_id`.
- **Mitigation:** upgrade the contract to a new WASM that adds a `deregister_maintainer` function, then call it to remove the entry.
- **Interim:** monitor all `issue_assigned` / `assignment_revoked` events for the affected `org_id` and treat suspicious activity as invalid off-chain.

### 4c. Contract instance TTL expiry

The contract instance TTL is bumped (~30 days forward) on every state-changing call. If no activity occurs for an extended period, the instance entry may approach expiry.

To extend it manually without a state-changing call, call any no-op write or use the Stellar CLI:

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --network mainnet \
  --source <any-account> \
  -- extend_application_ttl \
  --contributor <ANY_ADDRESS_WITH_ACTIVE_APP> \
  --org_id <ORG> \
  --issue_id <ISSUE_ID>
```

Alternatively, integrate a scheduled job (e.g. a cron or GitHub Actions workflow) that calls any read-write function at least once every 25 days.

### 4d. All applications expired (wave end)

Application and global-app-count entries use temporary storage with `APP_TTL_LEDGERS` (17,280 ledgers ≈ 24 hours). At wave end, all temporary entries expire automatically — no admin action required. Persistent assignment entries remain until explicitly cleared by a maintainer.

### 4e. Contract incorrectly initialized (wrong admin address)

Because `initialize` is idempotent-guarded (error `1` on second call), there is no way to change the stored admin address. The only path forward is deploying a new contract instance (see §4a, steps 3–5).

---

## 5. Quick reference

| Action | Command |
|---|---|
| Deploy | `stellar contract deploy --wasm <wasm> --network <net> --source <account>` |
| Initialize | `stellar contract invoke ... -- initialize --admin <addr>` |
| Register maintainer | `stellar contract invoke ... -- register_maintainer --admin <a> --maintainer <m> --org_id <o>` |
| Upload new WASM | `stellar contract upload --wasm <wasm> --network <net> --source <account>` |
| Upgrade | `stellar contract invoke ... -- upgrade --new_wasm_hash <hash>` |
| Check app count | `stellar contract invoke ... -- get_global_application_count --contributor <addr>` |
| Check assignment count | `stellar contract invoke ... -- get_org_assignment_count --contributor <addr> --org_id <org>` |

Storage constants (defined in `src/storage.rs`):

| Constant | Value | Meaning |
|---|---|---|
| `GLOBAL_APP_LIMIT` | 15 | Max pending applications per contributor globally |
| `ORG_ASSIGNMENT_LIMIT` | 4 | Max active assignments per contributor per org |
| `APP_TTL_LEDGERS` | 17,280 | Application TTL (~24 h at 5 s/ledger) |
| `INSTANCE_TTL_LEDGERS` | 518,400 | Contract instance TTL (~30 days) |
