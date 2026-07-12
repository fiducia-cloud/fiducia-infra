# envs/e2e — the e2e fleet

The Terraform root config (Tier 2) that instantiates every cloud module behind an
`enable_<cloud>` toggle and emits the kubeconfigs + LB endpoints that feed
`topology.toml` and `fiducia-e2e`'s `FIDUCIA_E2E_ENDPOINTS`. Cluster names/regions
mirror `../../../topology.toml` so provisioned clusters line up with the `clusters/*`
overlays.

**`terraform apply` here spends real money** and is never run in CI (CI only
`fmt`/`validate`s). Toggle any subset of clouds with the `enable_*` vars.

- `main.tf` — module instantiations + endpoint outputs.
- `variables.tf` / `outputs.tf` — the env's inputs and emitted values.
- `terraform.tfvars.example` — copy to `terraform.tfvars` and fill in project ids/credentials.
- `backend.tf.example` — optional S3/GCS remote state with locking (default is throwaway local state).
