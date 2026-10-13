#!/usr/bin/env python3
"""Serves the decision-model UI and proxies /v1/* to the decision-model API.

The proxy exists because the upstream API sends no CORS headers and the API
token must stay out of the browser. Static files come from ./static; every
/v1/* request is forwarded to CLEF_API_BASE with the bearer token attached.

Configuration (environment or .env next to this file):
  CLEF_API_BASE   upstream API base URL
  CLEF_API_TOKEN  bearer token for the upstream API

Usage: uv run python server.py [--host 127.0.0.1] [--port 8787]
"""
import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
PROXY_TIMEOUT = 300  # decision models can be slow on cold start


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


class Handler(BaseHTTPRequestHandler):
    api_base = ""
    api_token = ""

    def do_GET(self):
        if urlsplit(self.path).path.startswith("/v1/"):
            self.proxy("GET")
        else:
            self.serve_static()

    def do_POST(self):
        if urlsplit(self.path).path.startswith("/v1/"):
            self.proxy("POST")
        else:
            self.send_json(404, {"error": "not found"})

    def proxy(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {"Accept": "application/json"}
        if body:
            headers["Content-Type"] = "application/json"
        if self.api_token:
            headers["Authorization"] = f"Bearer {self.api_token}"
        req = urllib.request.Request(
            self.api_base + self.path, data=body, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=PROXY_TIMEOUT) as resp:
                self.send_json_bytes(resp.status, resp.read())
        except urllib.error.HTTPError as exc:
            self.send_json_bytes(exc.code, exc.read())
        except Exception as exc:  # network-level failure
            self.send_json(502, {"error": f"upstream unreachable: {exc}"})

    def serve_static(self):
        path = urlsplit(self.path).path
        rel = "index.html" if path == "/" else path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            self.send_json(404, {"error": "not found"})
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, obj):
        self.send_json_bytes(status, json.dumps(obj).encode())

    def send_json_bytes(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main():
    load_env()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    Handler.api_base = os.environ.get("CLEF_API_BASE", "https://api.blablador.fz-juelich.de").rstrip("/")
    Handler.api_token = os.environ.get("CLEF_API_TOKEN", "")
    if not Handler.api_token:
        print("WARNING: CLEF_API_TOKEN is not set — proxied calls will likely get 401.", file=sys.stderr)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"decision-model-frontend on http://{args.host}:{args.port} -> {Handler.api_base}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()