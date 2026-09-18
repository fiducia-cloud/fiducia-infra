# fiducia-cloud Durable Object coordinator

`FiduciaLeaseCoordinator` provides SQLite-backed lease/lock/control-plane coordination. Cloudflare Builds root is `modules/cloudflare/durable-coordinator`. Terraform owns only stable Worker shells; Wrangler owns versions, bindings, and declarative `exports`. Durable Object bindings are repeated per environment because they are non-inheritable. `workers.dev` is disabled; only preview enables preview URLs; no production route is declared here.

Run `npm install && npm run check`. Deploy with `npm run deploy:preview|staging|production`. The internal coordinator supports health plus versioned state GET/PUT/DELETE and optional `If-Match` optimistic concurrency, partitioned by `?object=<aggregate-name>`.
