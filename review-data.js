// Example review: a coding agent added rate limiting to an API. The fields are listed at the top of review.html.
window.REVIEW_DATA = {
 "review_id": "example-rate-limit",
 "title": "Per-client rate limiting for the public API",
 "task": "Add per-client rate limiting to the public REST API. Clients should get a clear error when they hit the limit, and the docs should say what the limits are. Don't break the webhook receivers.",
 "summary": "The agent added a token-bucket limiter as middleware, moved counters to Redis, returned 429 with Retry-After, and wrote 14 tests. Two findings need a decision before shipping: the limiter keys on a header clients can forge, and two endpoints bypass it.",
 "agent": { "name": "Coding agent", "model": "claude-opus-5-5", "run_id": "run-2026-11-20-0142" },
 "generated": "2026-11-20T21:40:00-05:00",
 "categories": ["Security", "Correctness", "Performance", "API design", "Tests", "Docs", "Maintenance"],
 "reasons": {
  "reject": ["Wrong", "Not needed", "Out of scope", "Breaks clients", "Weak evidence", "Too risky"],
  "rework": ["Wrong approach", "Incomplete", "Needs tests", "Needs a benchmark", "Too broad", "Style"],
  "note": ["Follow up", "Ask why", "Good catch", "Discuss with team", "Later"],
  "run": ["Stayed on task", "Good evidence", "Too verbose", "Missed scope", "Needs more tests", "Ask before big changes"]
 },
 "items": [
  {
   "id": "sec-forwarded-for",
   "kind": "finding",
   "category": "Security",
   "priority": "P0",
   "impact": 0.95,
   "confidence": 0.86,
   "risk": 0.3,
   "title": "Limiter keys on X-Forwarded-For, which clients can forge",
   "summary": "Any client can send a new X-Forwarded-For on each request and get a fresh bucket.",
   "where": "api/middleware/ratelimit.py:42",
   "format": "code",
   "lang": "python",
   "options": [
    {
     "id": "A",
     "label": "Trust the header only from known proxies",
     "recommended": true,
     "text": "def client_key(request):\n    ip = request.remote_addr\n    if ip in settings.TRUSTED_PROXIES:\n        ip = request.headers.get(\"X-Forwarded-For\", ip).split(\",\")[-1].strip()\n    return request.api_key or ip",
     "why": "Keeps per-IP limits for anonymous clients and closes the bypass. Needs TRUSTED_PROXIES set in each environment."
    },
    {
     "id": "B",
     "label": "Key by API key only",
     "text": "def client_key(request):\n    if not request.api_key:\n        raise Unauthorized(\"An API key is required\")\n    return request.api_key",
     "why": "Simplest and unforgeable, but anonymous calls to /v1/status would start failing."
    }
   ],
   "evidence": [
    {
     "id": "e1", "kind": "code", "where": "api/middleware/ratelimit.py:40-44", "stance": "for", "strength": 3,
     "text": "def client_key(request):\n    return request.headers.get(\"X-Forwarded-For\", request.remote_addr)",
     "reason": "The header is read whatever its source, so a client controls its own bucket key."
    },
    {
     "id": "e2", "kind": "test", "where": "tests/test_ratelimit.py::test_spoofed_header_bypass", "stance": "for", "strength": 3,
     "text": "sent 1,000 requests with random X-Forwarded-For\nlimit 600/min, rejected 0 (expected at least 400)\nFAILED",
     "reason": "Reproduces the bypass against the current code."
    },
    {
     "id": "e3", "kind": "doc", "where": "deploy/README.md, Load balancer", "stance": "context", "strength": 2,
     "text": "The ALB appends the client address to X-Forwarded-For.",
     "reason": "Appends, not replaces, so the last entry is the one to trust when the request came through the ALB."
    }
   ],
   "tags": ["blocker"],
   "state": "s-core"
  },
  {
   "id": "cor-monotonic",
   "kind": "change",
   "category": "Correctness",
   "priority": 0,
   "impact": 0.8,
   "confidence": 0.93,
   "risk": 0.1,
   "title": "Refill the token bucket from a monotonic clock",
   "summary": "Wall-clock time jumps on NTP sync, which refilled or drained buckets at random.",
   "where": "api/limiter/bucket.py:18",
   "format": "code",
   "lang": "python",
   "original": "now = time.time()\nelapsed = now - self.updated\nself.tokens = min(self.capacity, self.tokens + elapsed * self.rate)\nself.updated = now",
   "proposed": "now = time.monotonic()\nelapsed = max(0.0, now - self.updated)\nself.tokens = min(self.capacity, self.tokens + elapsed * self.rate)\nself.updated = now",
   "why": "time.monotonic() never goes backwards, and the max() guards the first call after a restart.",
   "evidence": [
    {
     "id": "e1", "kind": "log", "where": "CI run #8812, test_refill_rate", "stance": "for", "strength": 2,
     "text": "AssertionError: tokens=-3.0 after refill (clock moved back 1.6 s)",
     "reason": "A negative token count can only come from the clock going backwards."
    },
    {
     "id": "e2", "kind": "metric", "where": "200 CI reruns before and after", "stance": "for", "strength": 3,
     "value": "0 of 200", "unit": "flaky runs after the change",
     "reason": "The flake rate was 4.2% (8 of 190) before."
    }
   ],
   "state": "s-core"
  },
  {
   "id": "api-bypass",
   "kind": "question",
   "category": "API design",
   "priority": 1,
   "impact": 0.7,
   "confidence": 0.55,
   "title": "/health and /webhooks/* bypass the limiter",
   "summary": "Both are registered before the middleware. Is that intended?",
   "where": "api/app.py:31-37",
   "options": [
    { "id": "A", "label": "Keep both outside the limiter", "recommended": true, "text": "No change. Add a comment in app.py saying why the two routes are registered first.", "why": "Webhook senders retry on 429 and would amplify traffic; health checks must never be limited." },
    { "id": "B", "label": "Limit webhooks with their own high limit", "text": "Register /webhooks/* after the middleware with a 6,000/min bucket per sender.", "why": "Protects against a misbehaving sender, at the cost of retry storms if the limit is hit." }
   ],
   "evidence": [
    {
     "id": "e1", "kind": "code", "where": "api/app.py:31-37", "stance": "for", "strength": 3,
     "text": "app.add_route(\"/health\", health)\napp.add_route(\"/webhooks/<path>\", webhooks)\napp.add_middleware(RateLimitMiddleware)",
     "reason": "Routes added before the middleware are not wrapped by it."
    },
    {
     "id": "e2", "kind": "quote", "where": "Task", "stance": "for", "strength": 2,
     "text": "Don't break the webhook receivers.",
     "reason": "Suggests webhooks should stay outside the limiter."
    },
    {
     "id": "e3", "kind": "log", "where": "Incident INC-2291 (March)", "stance": "against", "strength": 2,
     "text": "Partner retried a failing webhook 40k times in 10 minutes.",
     "reason": "One sender has flooded the webhook route before, which is an argument for some limit."
    }
   ],
   "state": "s-api"
  },
  {
   "id": "perf-redis",
   "kind": "change",
   "category": "Performance",
   "priority": 1,
   "impact": 0.75,
   "confidence": 0.7,
   "risk": 0.5,
   "title": "Keep counters in Redis with an atomic Lua script",
   "summary": "In-process counters let each of the 6 pods allow the full limit.",
   "where": "api/limiter/store.py (new file)",
   "format": "code",
   "lang": "lua",
   "proposed": "local tokens = tonumber(redis.call('HGET', KEYS[1], 't') or ARGV[2])\nlocal updated = tonumber(redis.call('HGET', KEYS[1], 'u') or ARGV[3])\ntokens = math.min(ARGV[2], tokens + (ARGV[3] - updated) * ARGV[1])\nif tokens < 1 then return 0 end\nredis.call('HSET', KEYS[1], 't', tokens - 1, 'u', ARGV[3])\nredis.call('EXPIRE', KEYS[1], 120)\nreturn 1",
   "why": "One round trip per request, and the script runs atomically, so two pods cannot both take the last token.",
   "evidence": [
    {
     "id": "e1", "kind": "command", "where": "bench/ratelimit_bench.py, local", "stance": "for", "strength": 1,
     "text": "$ python bench/ratelimit_bench.py --pods 6 --duration 60\np50 12ms  p95 41ms  p99 63ms  throughput 2390 req/s",
     "reason": "Latency cost is about 3 ms at p95, measured on a laptop with a local Redis."
    },
    {
     "id": "e2", "kind": "test", "where": "tests/test_store.py (6 tests)", "stance": "for", "strength": 2,
     "text": "6 passed in 1.84s",
     "reason": "Covers concurrent takes, expiry and a missing key."
    },
    {
     "id": "e3", "kind": "doc", "where": "infra/redis.tf", "stance": "against", "strength": 2,
     "text": "redis: cache.t3.micro, single node, no replica",
     "reason": "If this node goes down, every request fails unless the limiter fails open."
    }
   ],
   "state": "s-store"
  },
  {
   "id": "api-429",
   "kind": "change",
   "category": "API design",
   "priority": 1,
   "impact": 0.6,
   "confidence": 0.95,
   "risk": 0.15,
   "title": "Return 429 with Retry-After and RateLimit headers",
   "where": "api/middleware/ratelimit.py:71",
   "format": "code",
   "lang": "python",
   "original": "raise Forbidden(\"rate limited\")",
   "proposed": "retry = math.ceil(bucket.seconds_until(1))\nraise TooManyRequests(\n    \"Rate limit reached. Retry after %d seconds.\" % retry,\n    headers={\n        \"Retry-After\": str(retry),\n        \"RateLimit-Limit\": str(bucket.capacity),\n        \"RateLimit-Remaining\": \"0\",\n    },\n)",
   "why": "403 tells clients they are not allowed at all, so most SDKs give up instead of backing off.",
   "evidence": [
    { "id": "e1", "kind": "url", "where": "RFC 6585, section 4", "url": "https://www.rfc-editor.org/rfc/rfc6585#section-4", "stance": "for", "strength": 3, "text": "The 429 status code indicates that the user has sent too many requests in a given amount of time.", "reason": "The standard status for this case." },
    { "id": "e2", "kind": "test", "where": "tests/test_ratelimit.py::test_429_headers", "stance": "for", "strength": 3, "text": "PASSED", "reason": "Checks the status and all three headers." }
   ],
   "state": "s-api"
  },
  {
   "id": "cfg-default-limit",
   "kind": "decision",
   "category": "API design",
   "priority": 1,
   "impact": 0.65,
   "confidence": 0.6,
   "title": "Default limit per API key",
   "summary": "Sets the limit for every key without an override.",
   "where": "api/settings.py:RATE_LIMIT_DEFAULT",
   "options": [
    { "id": "A", "label": "600 per minute", "recommended": true, "text": "RATE_LIMIT_DEFAULT = \"600/min\"", "why": "About 1.5 times the busiest client's p99 last month, so no current client is limited." },
    { "id": "B", "label": "300 per minute", "text": "RATE_LIMIT_DEFAULT = \"300/min\"", "why": "Tighter, but 3 clients would hit it at their p99." },
    { "id": "C", "label": "1200 per minute", "text": "RATE_LIMIT_DEFAULT = \"1200/min\"", "why": "Very unlikely to affect anyone, and gives little protection." }
   ],
   "evidence": [
    { "id": "e1", "kind": "metric", "where": "Access logs, Oct 20 - Nov 19", "stance": "for", "strength": 3, "value": "410", "unit": "req/min, busiest client p99", "reason": "600 leaves about 45% headroom above the busiest client." },
    { "id": "e2", "kind": "data", "where": "Access logs, clients above 300 req/min at p99", "stance": "context", "strength": 2, "value": "3", "unit": "clients", "reason": "Who would be limited by option B." }
   ],
   "state": "s-api"
  },
  {
   "id": "test-suite",
   "kind": "test",
   "category": "Tests",
   "priority": 2,
   "impact": 0.5,
   "confidence": 0.9,
   "title": "Add 14 tests for the limiter and the Redis store",
   "where": "tests/test_ratelimit.py, tests/test_store.py",
   "proposed": "8 tests for the middleware (keys, 429 response, headers, bypassed routes) and 6 for the Redis store (concurrent takes, expiry, missing key, Redis down).",
   "evidence": [
    { "id": "e1", "kind": "test", "where": "pytest tests/ -q", "stance": "for", "strength": 3, "text": "312 passed, 1 failed (test_spoofed_header_bypass), 2 skipped in 44.1s", "reason": "The one failure is the P0 finding, kept failing on purpose until it is fixed." }
   ],
   "state": "s-tests"
  },
  {
   "id": "docs-limits",
   "kind": "change",
   "category": "Docs",
   "priority": 2,
   "impact": 0.45,
   "confidence": 0.85,
   "title": "Document the limits and the 429 response",
   "where": "docs/api/limits.md (new page)",
   "proposed": "## Rate limits\n\nEach API key may send 600 requests per minute. Requests without a key are limited per IP address.\n\nWhen you reach the limit, the API responds with 429 Too Many Requests and a Retry-After header that says how many seconds to wait. Health checks and webhook deliveries are not limited.",
   "why": "The task asks that the docs say what the limits are.",
   "evidence": [
    { "id": "e1", "kind": "quote", "where": "Task", "stance": "for", "strength": 3, "text": "the docs should say what the limits are", "reason": "Directly requested." },
    { "id": "e2", "kind": "file", "where": "docs/api/errors.md", "stance": "context", "strength": 1, "text": "429 is not listed among the error codes.", "reason": "Could be updated too; left for a later change." }
   ],
   "state": "s-docs"
  },
  {
   "id": "obs-metric",
   "kind": "change",
   "category": "Maintenance",
   "priority": 2,
   "impact": 0.4,
   "confidence": 0.8,
   "title": "Count rejected requests in a Prometheus metric",
   "where": "api/middleware/ratelimit.py:80",
   "format": "code",
   "lang": "python",
   "proposed": "RATE_LIMITED = Counter(\n    \"api_rate_limited_total\",\n    \"Requests rejected by the rate limiter\",\n    [\"route\"],\n)\n...\nRATE_LIMITED.labels(route=request.route).inc()",
   "why": "Without it nobody can tell whether the limit is hurting real clients.",
   "evidence": [
    { "id": "e1", "kind": "file", "where": "api/metrics.py", "stance": "for", "strength": 2, "text": "Other middleware counters use the api_*_total naming.", "reason": "Follows the existing naming." }
   ],
   "state": "s-docs"
  },
  {
   "id": "plan-rollout",
   "kind": "plan",
   "category": "Maintenance",
   "priority": 2,
   "impact": 0.6,
   "confidence": 0.65,
   "risk": 0.25,
   "title": "Roll out behind a flag: log-only for a week, then enforce",
   "proposed": "1. Deploy with RATE_LIMIT_MODE=log: count, but never reject.\n2. After 7 days, check api_rate_limited_total by key.\n3. Contact any key that would have been limited.\n4. Switch to RATE_LIMIT_MODE=enforce.",
   "why": "Finds clients that a fixed number would break before they break.",
   "evidence": [
    { "id": "e1", "kind": "doc", "where": "docs/runbooks/feature-flags.md", "stance": "for", "strength": 2, "text": "Behavior changes visible to clients ship behind a flag.", "reason": "Team policy." },
    { "id": "e2", "kind": "metric", "where": "Benchmark item above", "stance": "against", "strength": 1, "value": "1", "unit": "benchmark, local only", "reason": "The latency numbers come from a laptop, so a week of log-only mode in production is also the first real measurement." }
   ],
   "state": "s-report"
  },
  {
   "id": "style-rename",
   "kind": "change",
   "category": "Maintenance",
   "priority": 3,
   "impact": 0.15,
   "confidence": 0.9,
   "title": "Rename RateLimiter.check() to allow()",
   "where": "api/limiter/core.py:12",
   "format": "code",
   "lang": "python",
   "original": "if not limiter.check(key):",
   "proposed": "if not limiter.allow(key):",
   "why": "check() reads as if it had no side effect, but it takes a token.",
   "evidence": [
    { "id": "e1", "kind": "command", "where": "grep -rn \"\\.check(\" api/", "stance": "for", "strength": 2, "text": "api/middleware/ratelimit.py:66\napi/limiter/core.py:12", "reason": "Two call sites, both changed." }
   ],
   "state": "s-core"
  },
  {
   "id": "cleanup-legacy",
   "kind": "change",
   "category": "Maintenance",
   "priority": "low",
   "impact": 0.1,
   "confidence": 0.5,
   "title": "Remove the unused THROTTLE_LEGACY setting",
   "where": "api/settings.py:118",
   "format": "code",
   "lang": "python",
   "original": "THROTTLE_LEGACY = env.bool(\"THROTTLE_LEGACY\", default=False)",
   "proposed": "",
   "why": "Nothing in api/ reads it.",
   "evidence": [
    { "id": "e1", "kind": "command", "where": "grep -rn THROTTLE_LEGACY api/", "stance": "for", "strength": 2, "text": "api/settings.py:118", "reason": "Only the definition." },
    { "id": "e2", "kind": "file", "where": "deploy/helm/values-prod.yaml:54", "stance": "against", "strength": 2, "text": "THROTTLE_LEGACY: \"true\"", "reason": "Production still sets it, so something outside api/ may read it." }
   ],
   "state": "s-core"
  }
 ],
 "machine": {
  "title": "Agent run",
  "caption": "From the request to the report. Each dot is an item, colored by your decision. The dashed loop is the fix after the first test run.",
  "states": [
   { "id": "s-task", "kind": "start", "role": "request", "label": "Task received", "sub": "rate limit the public API", "text": "Read the task and the three constraints in it: clear error, documented limits, webhooks unaffected." },
   { "id": "s-explore", "role": "explore", "label": "Read the code", "sub": "23 files, 2 incidents", "text": "Middleware, settings, deploy config and the last two incidents." },
   { "id": "s-plan", "kind": "choice", "role": "plan", "label": "Plan", "sub": "3 workstreams", "text": "Limiter core, shared storage, API surface." },
   { "id": "s-core", "role": "build", "label": "Limiter core", "sub": "bucket, key, clock", "where": "api/limiter/, api/middleware/ratelimit.py" },
   { "id": "s-store", "role": "build", "label": "Redis store", "sub": "Lua script, 1 round trip", "novel": true, "where": "api/limiter/store.py" },
   { "id": "s-api", "role": "build", "label": "API surface", "sub": "429, headers, routes", "where": "api/app.py, api/settings.py" },
   { "id": "s-tests", "role": "verify", "label": "Tests", "sub": "312 passed, 1 failed", "text": "The failing test is the forged-header bypass, kept on purpose." },
   { "id": "s-bench", "role": "verify", "label": "Benchmark", "sub": "local, 6 simulated pods", "text": "Laptop with a local Redis. Not production numbers." },
   { "id": "s-docs", "role": "finish", "label": "Docs and metrics", "sub": "limits page, 1 counter" },
   { "id": "s-report", "kind": "end", "role": "report", "label": "Report", "sub": "12 items for review" }
  ],
  "transitions": [
   { "from": "s-task", "to": "s-explore" },
   { "from": "s-explore", "to": "s-plan", "label": "found forged header" },
   { "from": "s-plan", "to": "s-core" },
   { "from": "s-plan", "to": "s-store" },
   { "from": "s-plan", "to": "s-api" },
   { "from": "s-core", "to": "s-tests" },
   { "from": "s-api", "to": "s-tests" },
   { "from": "s-store", "to": "s-bench", "label": "+3 ms p95" },
   { "from": "s-tests", "to": "s-core", "label": "fix clock bug" },
   { "from": "s-tests", "to": "s-docs" },
   { "from": "s-bench", "to": "s-report", "label": "local only", "weak": true },
   { "from": "s-docs", "to": "s-report" }
  ]
 }
}
;
