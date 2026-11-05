#!/usr/bin/env python3
"""Read-only brain/sidecar/node distributed E2E convergence probe.

Unlike local mocks or a single LB health check, this contacts THREE
independent brain /v1/nodes and /v1/placement listeners and optionally
THREE direct node /v1/status listeners. It proves observable convergence
of sidecar->brain registry, brain->brain placement snapshots, and Raft's
per-shard/per-term single-leader safety (when direct nodes are supplied).

Use independent loopback port forwards on a NONPRODUCTION cluster:
  FIDUCIA_E2E_BRAIN_URLS=http://127.0.0.1:18095,http://127.0.0.1:18096,http://127.0.0.1:18097 \
  FIDUCIA_E2E_NODE_URLS=http://127.0.0.1:18090,http://127.0.0.1:18091,http://127.0.0.1:18092 \
  python3 tools/brain_node_convergence_e2e.py

It does not modify the cluster, inject faults, or claim to establish
provider-loss tolerance. Use kind/multicluster/test/run.sh for chaos.
No endpoint => nonzero exit; never count unexecuted tests as a pass.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from collections import defaultdict
from urllib.parse import urlsplit


def origins(name, count):
    urls = [s.strip().rstrip("/") for s in os.getenv(name, "").split(",") if s.strip()]
    if len(urls) < count or len(set(urls)) != len(urls):
        raise ValueError("%s needs at least %s distinct origins" % (name, count))
    for origin in urls:
        parsed = urlsplit(origin)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.path not in ("", "/"):
            raise ValueError("invalid %s origin: %r" % (name, origin))
    return urls


def get_json(origin, path):
    request = urllib.request.Request(origin + path, method="GET")
    # This optional secret is never logged, even when a request fails.
    secret = os.getenv("FIDUCIA_E2E_INTERNAL_SECRET")
    if secret:
        request.add_header("x-fiducia-internal-auth", secret)
    with urllib.request.urlopen(request, timeout=6) as response:
        if response.status != 200:
            raise AssertionError("%s%s returned HTTP %s" % (origin, path, response.status))
        data = response.read(2_000_001)
        if len(data) > 2_000_000:
            raise AssertionError("%s%s returned oversized JSON" % (origin, path))
        payload = json.loads(data)
        if not isinstance(payload, dict):
            raise AssertionError("%s%s: JSON object expected" % (origin, path))
        return payload


def snapshot(origin):
    nodes = get_json(origin, "/v1/nodes").get("nodes")
    shards = get_json(origin, "/v1/placement").get("shards")
    if not isinstance(nodes, list) or not nodes or not isinstance(shards, list) or not shards:
        raise AssertionError("%s: missing node or placement records" % origin)
    identities, normalized_nodes = set(), []
    for node in nodes:
        if not isinstance(node, dict) or not node.get("node_id"):
            raise AssertionError("%s: malformed node record" % origin)
        node_id = node["node_id"]
        if node_id in identities:
            raise AssertionError("%s: duplicate node id %s" % (origin, node_id))
        identities.add(node_id)
        normalized_nodes.append((node_id, node.get("cluster_id")))
    normalized_shards, seen = [], set()
    for shard in shards:
        if not isinstance(shard, dict) or "shard_id" not in shard:
            raise AssertionError("%s: malformed shard" % origin)
        sid = shard["shard_id"]
        if sid in seen:
            raise AssertionError("%s: duplicate shard %s" % (origin, sid))
        seen.add(sid)
        replicas = shard.get("replicas")
        if not isinstance(replicas, list) or not replicas or len(set(replicas)) != len(replicas):
            raise AssertionError("%s: absent or duplicate replica in shard %s" % (origin, sid))
        if not set(replicas).issubset(identities):
            raise AssertionError("%s: shard %s references unregistered node" % (origin, sid))
        preferred = shard.get("preferred_leader")
        if preferred is not None and preferred not in replicas:
            raise AssertionError("%s: preferred leader is not a replica" % origin)
        normalized_shards.append((str(sid), tuple(sorted(replicas)), preferred))
    return tuple(sorted(normalized_nodes)), tuple(sorted(normalized_shards))


def assert_no_same_term_dual_leaders(node_urls):
    leaders = defaultdict(set)
    saw_shard = False
    for url in node_urls:
        consensus = get_json(url, "/v1/status").get("consensus")
        if not isinstance(consensus, dict) or not isinstance(consensus.get("shards"), list):
            raise AssertionError("%s: missing consensus.shards" % url)
        for shard in consensus["shards"]:
            if not isinstance(shard, dict):
                raise AssertionError("%s: malformed shard status" % url)
            shard_id = shard.get("shard_id", shard.get("id"))
            term = shard.get("term")
            if shard_id is None or term is None:
                raise AssertionError("%s: status missing shard id or term" % url)
            saw_shard = True
            if shard.get("role") == "leader":
                leaders[(str(shard_id), str(term))].add(url)
    if not saw_shard:
        raise AssertionError("no shard status observed")
    conflicts = {key: sorted(urls) for key, urls in leaders.items() if len(urls) > 1}
    if conflicts:
        raise AssertionError("same-term dual leader: %r" % conflicts)


def main():
    brains = origins("FIDUCIA_E2E_BRAIN_URLS", 3)
    nodes = origins("FIDUCIA_E2E_NODE_URLS", 3) if os.getenv("FIDUCIA_E2E_NODE_URLS") else []
    if os.getenv("FIDUCIA_E2E_ALLOW_PROD") != "1":
        for origin in brains + nodes:
            if "fiducia.cloud" in (urlsplit(origin).hostname or "").lower():
                raise ValueError("use local port-forwards, not production DNS")
    deadline = time.monotonic() + float(os.getenv("FIDUCIA_E2E_CONVERGENCE_TIMEOUT_S", "30"))
    previous, last_error = None, "never reached a stable snapshot"
    while time.monotonic() < deadline:
        try:
            views = [snapshot(brain) for brain in brains]
            if any(view != views[0] for view in views[1:]):
                raise AssertionError("brain replicas disagree about nodes or placement")
            clusters = {cluster for _, cluster in views[0][0] if cluster}
            if len(views[0][0]) < 3 or len(clusters) < 2:
                raise AssertionError("expected >=3 nodes across >=2 cluster failure domains")
            if nodes:
                assert_no_same_term_dual_leaders(nodes)
            if previous == views[0]:
                print("PASS: %s brains converge on %s nodes, %s shards in %s failure domains" %
                      (len(brains), len(views[0][0]), len(views[0][1]), len(clusters)))
                if nodes:
                    print("PASS: no same-term dual leaders across %s direct node status endpoints" % len(nodes))
                return
            previous, last_error = views[0], None
        except (AssertionError, OSError, ValueError, json.JSONDecodeError) as exc:
            previous, last_error = None, str(exc)
        time.sleep(1)
    raise AssertionError("cross-brain/node convergence NOT proven: %s" % last_error)


if __name__ == "__main__":
    main()
