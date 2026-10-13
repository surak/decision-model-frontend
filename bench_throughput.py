#!/usr/bin/env python3
"""Throughput benchmark for the decision model behind /v1/systemone.

Workloads are the real UI presets from static/app.js (extracted verbatim at
startup via node), so the numbers reflect actual decision payloads: noul /
choice / score questions over text and JSON states.

Two phases:
  1. sequential sweep — per-preset latency (also warms the model up)
  2. concurrency ramp — mixed presets round-robin at rising concurrency
     (default 1 4 8 16 32), reporting sustained req/s and latency percentiles

Configuration (environment or .env next to this file, same as server.py):
  CLEF_API_BASE   upstream API base URL
  CLEF_API_TOKEN  bearer token for the upstream API

Usage: uv run python bench_throughput.py [--model alias-clef] [--reps 2]
       [--duration 10] [--concurrencies 1 4 8 16 32] [--timeout 60]
"""
import argparse
import http.client
import itertools
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def load_env():
    """Load KEY=VALUE lines from .env without overriding real environment vars."""
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def load_presets():
    """Return the UI presets from static/app.js as a list of dicts."""
    src = (ROOT / "static" / "app.js").read_text()
    start = src.index("const PRESETS = ") + len("const PRESETS = ")
    literal = src[start:src.index("\n];", start)] + "]"
    if not shutil.which("node"):
        sys.exit("node is required to extract presets from static/app.js")
    out = subprocess.run(
        ["node", "-e", "console.log(JSON.stringify(eval(process.argv[1])))", literal],
        capture_output=True, text=True, check=True,
    )
    presets = json.loads(out.stdout)
    # Blank starter is a builder convenience, not a runnable workload.
    return [p for p in presets if p["state"].strip()
            and all(q.get("instructions", "").strip() for q in p["questions"].values())]


def payload_for(preset, model):
    state = preset["state"]
    if preset.get("stateMode") == "json":
        state = json.loads(state)
    return {"model": model, "state": state, "questions": preset["questions"]}


class Client:
    """One HTTP/1.1 connection kept alive across requests."""

    def __init__(self, base, token, timeout):
        parts = urlsplit(base)
        if not parts.hostname:
            sys.exit(f"CLEF_API_BASE is not a valid URL: {base}")
        self.path = "/v1/systemone"
        self.token = token
        self.conn = http.client.HTTPSConnection(
            parts.hostname, parts.port or 443, timeout=timeout
        )

    def send(self, payload):
        """Return (seconds, response_dict_or_None, error_or_None)."""
        body = json.dumps(payload)
        t0 = time.perf_counter()
        try:
            self.conn.request("POST", self.path, body=body, headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            })
            resp = self.conn.getresponse()
            data = json.loads(resp.read())
            latency = time.perf_counter() - t0
            if resp.status != 200:
                return latency, None, f"HTTP {resp.status}"
            return latency, data, None
        except Exception as exc:
            self.conn.close()  # next request transparently reconnects
            return time.perf_counter() - t0, None, type(exc).__name__


def pct(values, p):
    if not values:
        return float("nan")
    s = sorted(values)
    k = (len(s) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (k - lo)


def usage_of(data):
    u = (data or {}).get("usage") or {}
    return u.get("input_tokens", 0), u.get("output_tokens", 0)


def phase_sweep(presets, model, base, token, timeout, reps):
    print(f"\n== Phase 1: sequential sweep, {reps}x each of {len(presets)} presets ==")
    client = Client(base, token, timeout)
    lats_by_name = {}
    print(f"{'preset':<38} {'mean ms':>8} {'in tok':>7} {'out tok':>7}")
    for preset in presets:
        lats, usage, errs = [], (0, 0), 0
        for _ in range(reps):
            lat, data, err = client.send(payload_for(preset, model))
            lats.append(lat * 1000)
            if err:
                errs += 1
            else:
                usage = usage_of(data)
        lats_by_name[preset["name"]] = lats
        note = f"  {errs} ERRORS" if errs else ""
        print(f"{preset['name'][:38]:<38} {statistics.mean(lats):>8.0f} "
              f"{usage[0]:>7} {usage[1]:>7}{note}")
    all_lats = [x for lats in lats_by_name.values() for x in lats]
    print(f"{'TOTAL':<38} {statistics.mean(all_lats):>8.0f}")
    print(f"latency over sweep: p50 {pct(all_lats, 50):.0f} ms · "
          f"p95 {pct(all_lats, 95):.0f} ms · min {min(all_lats):.0f} ms · "
          f"max {max(all_lats):.0f} ms")


def phase_ramp(presets, model, base, token, timeout, levels, duration):
    print(f"\n== Phase 2: concurrency ramp, mixed presets, {duration}s per level ==")
    print(f"{'concurrency':>11} {'reqs':>6} {'errors':>6} {'req/s':>7} "
          f"{'p50 ms':>8} {'p95 ms':>8} {'in tok/s':>9}")
    for level in levels:
        results = []
        lock = threading.Lock()
        counter = itertools.count()
        deadline = time.perf_counter() + duration

        def worker():
            client = Client(base, token, timeout)
            while time.perf_counter() < deadline:
                preset = presets[next(counter) % len(presets)]
                lat, data, err = client.send(payload_for(preset, model))
                in_tok, out_tok = usage_of(data)
                with lock:
                    results.append((time.perf_counter(), lat, in_tok, out_tok, err))

        threads = [threading.Thread(target=worker) for _ in range(level)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        ends = [r[0] for r in results]
        starts = [r[0] - r[1] for r in results]
        window = max(ends) - min(starts) if results else 0
        lats = [r[1] * 1000 for r in results if not r[4]]
        errs = [r[4] for r in results if r[4]]
        in_toks = sum(r[2] for r in results if not r[4])
        oks = len(lats)
        req_s = oks / window if window > 0 else 0
        print(f"{level:>11} {oks:>6} {len(errs):>6} {req_s:>7.1f} "
              f"{pct(lats, 50):>8.0f} {pct(lats, 95):>8.0f} {in_toks / window if window > 0 else 0:>9.0f}")
        if errs:
            counts = {}
            for e in errs:
                counts[e] = counts.get(e, 0) + 1
            print(f"{'':>11} errors: " + ", ".join(f"{k} x{v}" for k, v in sorted(counts.items())))


def main():
    load_env()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="alias-clef")
    parser.add_argument("--reps", type=int, default=2, help="sequential sweeps over all presets")
    parser.add_argument("--duration", type=int, default=10, help="seconds per concurrency level")
    parser.add_argument("--concurrencies", type=int, nargs="+", default=[1, 4, 8, 16, 32])
    parser.add_argument("--timeout", type=int, default=60, help="per-request timeout")
    args = parser.parse_args()

    token = os.environ.get("CLEF_API_TOKEN", "")
    if not token:
        sys.exit("CLEF_API_TOKEN is not set (environment or .env) — see .env.example")
    base = os.environ.get("CLEF_API_BASE", "https://api.blablador.fz-juelich.de").rstrip("/")

    presets = load_presets()
    print(f"model {args.model} @ {base}/v1/systemone — {len(presets)} preset workloads")
    phase_sweep(presets, args.model, base, token, args.timeout, args.reps)
    phase_ramp(presets, args.model, base, token, args.timeout, args.concurrencies, args.duration)


if __name__ == "__main__":
    main()