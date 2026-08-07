# DEN-945 laptop JetStream risk register

| Risk | Consequence | Required mitigation/evidence |
|---|---|---|
| All laptops share one ISP/power/site | Correlated loss of all voters | Separate sites/networks or explicit beta-only classification |
| WAN jitter causes route churn | Elections, lag, redelivery, backpressure | Measured RTT/loss envelope, conservative timing, alerts, soak |
| Static membership changed unsafely | Split brain or lost quorum | Runtime-safe one-member replacement and joint-consensus evidence |
| Route certificate copied across hosts | Identity ambiguity and broad compromise | Unique per-member SAN/key, external secret storage, revocation drill |
| JetStream becomes sole system of record | Irrecoverable workflow state | PostgreSQL outbox/inbox authority and tested replay |
| Duplicate external side effect | Customer billing/control corruption | Fiducia fencing plus durable idempotency proof |
| Laptop SSD failure | Lost local replica and slow recovery | Health alerts, encrypted off-host snapshots, clean replacement restore |
| Thermal or power throttling | Latency and catch-up instability | Temperature/battery/I/O monitoring and bounded operating limits |
| Automated multi-member rollout | Quorum loss | Manual stateful gate, follower-first and leader-last sequencing |
| CI evidence mistaken for production proof | Unsafe launch | DEN-946 live campaign and explicit evidence-mode validation |
