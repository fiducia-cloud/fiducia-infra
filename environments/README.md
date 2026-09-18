# Terraform environment roots

`preview/`, `staging/`, and `production/` are independent roots for **fiducia-cloud** and never share Terraform state. Provider-native source remains canonical under `modules/`: Cloudflare under `modules/cloudflare/<worker-or-site>`, Neon under `modules/neon/neon.ts`, and Supabase under `modules/supabase/`.

This repo includes `modules/cloudflare/durable-coordinator`. Terraform owns only the stable Worker shell; Wrangler owns Worker versions, bindings, and Durable Object `exports`. Live Worker creation is opt-in with `-var=enable_cloudflare_worker=true` after account/root wiring.

For R2 state: `terraform init -backend-config=../backend.r2.hcl.example -backend-config="key=fiducia-cloud/<environment>/terraform.tfstate"`. Supply R2 credentials through `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, and Cloudflare provider auth through `CLOUDFLARE_API_TOKEN`. Never commit credentials.
