# Shared Auth topology

DEN-2843 records Fiducia Cloud's stricter dual-provider policy. Because Fiducia
coordinates locks, leases, fencing tokens, and privileged control operations,
customer and admin routes both default to strict paired Supabase + Neon proof.
Customer servers use only the two auth database settings; admin servers use only
the two independent admin settings. The shared Supabase runtime org is a
schema-isolated transition; `fiducia-cloud` is the target Supabase and dedicated
Neon org. Product-local auth helpers must delegate to Shared Auth/ores-middleware,
not define another identity format. Run `node shared-auth/validate.mjs`.
