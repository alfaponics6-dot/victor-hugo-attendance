"""
Static-analysis diagnostic for the 'first-load reload glitch' on
https://forestryescenary.com .

Pure HTTP + regex. No browser automation.
"""
from __future__ import annotations

import hashlib
import re
import sys
from dataclasses import dataclass, field
from typing import Iterable

try:
    import requests
    HAS_REQUESTS = True
except ImportError:  # pragma: no cover
    HAS_REQUESTS = False
    import urllib.request

BASE = "https://forestryescenary.com"
UA = "reload-glitch-diagnostic/1.0 (+static-analysis)"
TIMEOUT = 20


# ---------- transport ----------------------------------------------------
def fetch(url: str) -> tuple[int, dict, str]:
    """Return (status_code, headers_dict_lower, text_body)."""
    if HAS_REQUESTS:
        r = requests.get(url, headers={"User-Agent": UA, "Cache-Control": "no-cache"},
                         timeout=TIMEOUT, allow_redirects=True)
        return r.status_code, {k.lower(): v for k, v in r.headers.items()}, r.text
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # type: ignore
        body = resp.read().decode("utf-8", errors="replace")
        return resp.status, {k.lower(): v for k, v in resp.headers.items()}, body


def safe_fetch(url: str) -> tuple[int | None, dict, str]:
    try:
        return fetch(url)
    except Exception as exc:  # pragma: no cover
        return None, {"_error": str(exc)}, ""


# ---------- regex helpers ------------------------------------------------
def find_all(pat: str, text: str, flags: int = 0) -> list[re.Match]:
    return list(re.finditer(pat, text, flags))


def context(text: str, m: re.Match, pad: int = 80) -> str:
    start = max(0, m.start() - pad)
    end = min(len(text), m.end() + pad)
    snippet = text[start:end].replace("\n", " ").replace("\r", " ")
    snippet = re.sub(r"\s+", " ", snippet)
    return snippet.strip()


def line_no(text: str, idx: int) -> int:
    return text.count("\n", 0, idx) + 1


def extract_handler(js: str, event: str) -> str | None:
    """Extract the body of self.addEventListener('install' | 'activate', fn).

    Returns a quoted excerpt (up to ~600 chars) or None.
    """
    # Find the addEventListener call; capture the start, then balance braces.
    pat = re.compile(
        r"self\.addEventListener\(\s*['\"]" + re.escape(event) + r"['\"]\s*,",
    )
    m = pat.search(js)
    if not m:
        return None
    # Find the first '{' after the match
    brace_start = js.find("{", m.end())
    if brace_start == -1:
        return None
    depth = 0
    i = brace_start
    in_str: str | None = None
    while i < len(js):
        ch = js[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == in_str:
                in_str = None
        else:
            if ch in ('"', "'", "`"):
                in_str = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    body = js[brace_start:i + 1]
                    if len(body) > 600:
                        body = body[:600] + " ... [truncated]"
                    return body
        i += 1
    return None


# ---------- per-resource probes ------------------------------------------
@dataclass
class HtmlInfo:
    status: int | None = None
    headers: dict = field(default_factory=dict)
    html: str = ""
    stylesheets: list[str] = field(default_factory=list)
    module_scripts: list[str] = field(default_factory=list)
    refresh_metas: list[str] = field(default_factory=list)
    inline_scripts: list[str] = field(default_factory=list)
    sha: str = ""


def inspect_html() -> HtmlInfo:
    status, headers, body = safe_fetch(BASE + "/")
    info = HtmlInfo(status=status, headers=headers, html=body,
                    sha=hashlib.sha256(body.encode("utf-8")).hexdigest()[:16])
    for m in re.finditer(r'<link\s+[^>]*rel=["\']?stylesheet["\']?[^>]*>',
                         body, re.IGNORECASE):
        href = re.search(r'href=["\']([^"\']+)["\']', m.group(0))
        if href:
            info.stylesheets.append(href.group(1))
    for m in re.finditer(
        r'<script\s+[^>]*type=["\']module["\'][^>]*src=["\']([^"\']+)["\']',
        body, re.IGNORECASE,
    ):
        info.module_scripts.append(m.group(1))
    # Also catch plain scripts (no type=module) for completeness
    for m in re.finditer(r'<script\s+[^>]*src=["\']([^"\']+)["\']',
                         body, re.IGNORECASE):
        src = m.group(1)
        if src not in info.module_scripts:
            info.module_scripts.append(src)
    for m in re.finditer(r'<meta[^>]+http-equiv=["\']?refresh["\']?[^>]*>',
                         body, re.IGNORECASE):
        info.refresh_metas.append(m.group(0))
    for m in re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>',
                         body, re.DOTALL | re.IGNORECASE):
        snippet = m.group(1).strip()
        if snippet:
            info.inline_scripts.append(snippet[:400])
    return info


@dataclass
class SwInfo:
    status: int | None = None
    headers: dict = field(default_factory=dict)
    size: int = 0
    sha: str = ""
    skip_waiting: int = 0
    clients_claim: int = 0
    workbox_clients_claim: int = 0
    post_messages: list[str] = field(default_factory=list)
    nav_routes: list[str] = field(default_factory=list)
    install_handler: str | None = None
    activate_handler: str | None = None
    raw: str = ""


def inspect_sw() -> SwInfo:
    status, headers, body = safe_fetch(BASE + "/sw.js")
    info = SwInfo(status=status, headers=headers, size=len(body), raw=body,
                  sha=hashlib.sha256(body.encode("utf-8")).hexdigest()[:16])
    if status != 200:
        return info
    info.skip_waiting = len(find_all(r"self\.skipWaiting\s*\(", body))
    info.clients_claim = len(find_all(r"self\.clients\.claim\s*\(", body))
    info.workbox_clients_claim = len(find_all(r"\bclientsClaim\s*\(", body))
    for m in find_all(r"\.postMessage\s*\([^)]*\)", body):
        info.post_messages.append(context(body, m, 40))
    for m in find_all(r"(NavigationRoute|registerRoute\s*\([^)]*NavigationRoute|navigation[A-Z]\w*)",
                      body):
        info.nav_routes.append(context(body, m, 40))
    info.install_handler = extract_handler(body, "install")
    info.activate_handler = extract_handler(body, "activate")
    return info


@dataclass
class ManifestInfo:
    url: str = ""
    status: int | None = None
    body: str = ""


def inspect_manifest() -> ManifestInfo:
    for path in ("/manifest.webmanifest", "/manifest.json", "/site.webmanifest"):
        status, _hdrs, body = safe_fetch(BASE + path)
        if status == 200 and body.strip().startswith("{"):
            return ManifestInfo(url=path, status=status, body=body)
    # Fall back to whatever we got last
    return ManifestInfo(url=path, status=status, body=body)


@dataclass
class BundleInfo:
    url: str = ""
    status: int | None = None
    size: int = 0
    sha: str = ""
    reload_hits: list[tuple[int, str]] = field(default_factory=list)
    controllerchange_hits: list[tuple[int, str]] = field(default_factory=list)
    had_initial_controller_hits: int = 0
    register_sw_hits: int = 0
    virtual_pwa_hits: int = 0
    settimeout_near_reload: list[str] = field(default_factory=list)


def inspect_bundle(url: str) -> BundleInfo:
    if url.startswith("/"):
        full = BASE + url
    elif url.startswith("http"):
        full = url
    else:
        full = BASE + "/" + url
    status, _hdrs, body = safe_fetch(full)
    info = BundleInfo(url=full, status=status, size=len(body),
                      sha=hashlib.sha256(body.encode("utf-8")).hexdigest()[:16])
    if status != 200:
        return info
    for m in find_all(r"window\.location\.reload\s*\(|location\.reload\s*\(",
                      body):
        info.reload_hits.append((line_no(body, m.start()), context(body, m, 80)))
    for m in find_all(r"controllerchange", body):
        info.controllerchange_hits.append(
            (line_no(body, m.start()), context(body, m, 80))
        )
    info.had_initial_controller_hits = len(
        find_all(r"hadInitialController", body)
    )
    info.register_sw_hits = len(find_all(r"\bregisterSW\b", body))
    info.virtual_pwa_hits = len(find_all(r"virtual:pwa-register", body))
    # setTimeout within 200 chars of a reload or controllerchange occurrence
    flags = [m.start() for m in find_all(
        r"location\.reload|controllerchange", body)]
    for st in find_all(r"setTimeout\s*\(", body):
        if any(abs(st.start() - f) < 200 for f in flags):
            info.settimeout_near_reload.append(context(body, st, 80))
    return info


# ---------- determinism check --------------------------------------------
def determinism_check(n: int = 3) -> list[dict]:
    rows = []
    for _ in range(n):
        status, _h, body = safe_fetch(BASE + "/")
        sha = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
        assets = re.findall(
            r'<(?:script[^>]*src|link[^>]*href)=["\']([^"\']+\.(?:js|css))["\']',
            body, re.IGNORECASE,
        )
        rows.append({"status": status, "html_sha": sha, "assets": assets})
    return rows


# ---------- report -------------------------------------------------------
def fmt_headers(h: dict, keys: Iterable[str]) -> str:
    lines = []
    for k in keys:
        v = h.get(k)
        if v:
            lines.append(f"- `{k}`: `{v}`")
    return "\n".join(lines) if lines else "_(none of interest)_"


def build_report(html: HtmlInfo, sw: SwInfo, mani: ManifestInfo,
                 bundle: BundleInfo, det: list[dict]) -> str:
    out: list[str] = []
    out.append("# Reload-glitch static analysis: forestryescenary.com\n")

    # --- HTML
    out.append("## HTML inspection")
    out.append(f"- URL: `{BASE}/`  status: `{html.status}`  sha256[:16]: `{html.sha}`")
    out.append("\n**Headers of interest**")
    out.append(fmt_headers(html.headers, [
        "cache-control", "content-security-policy", "etag", "last-modified",
        "service-worker-allowed", "x-frame-options", "content-type",
    ]))
    out.append(f"\n**Stylesheets ({len(html.stylesheets)})**")
    for s in html.stylesheets:
        out.append(f"- `{s}`")
    out.append(f"\n**Module / src scripts ({len(html.module_scripts)})**")
    for s in html.module_scripts:
        out.append(f"- `{s}`")
    out.append(f"\n**`<meta http-equiv=refresh>` tags: {len(html.refresh_metas)}**")
    for m in html.refresh_metas:
        out.append(f"- `{m}`")
    out.append(f"\n**Inline scripts ({len(html.inline_scripts)})**")
    for i, snip in enumerate(html.inline_scripts):
        out.append(f"- inline[{i}] (first 400 chars):\n```\n{snip}\n```")

    # --- SW
    out.append("\n## Service Worker analysis")
    out.append(f"- URL: `{BASE}/sw.js`  status: `{sw.status}`  "
               f"size: `{sw.size}` bytes  sha256[:16]: `{sw.sha}`")
    out.append(f"- `self.skipWaiting()` occurrences: **{sw.skip_waiting}**")
    out.append(f"- `self.clients.claim()` occurrences: **{sw.clients_claim}**")
    out.append(f"- workbox `clientsClaim()` occurrences: **{sw.workbox_clients_claim}**")
    out.append(f"- `postMessage(...)` call sites: **{len(sw.post_messages)}**")
    for p in sw.post_messages[:5]:
        out.append(f"  - `{p}`")
    out.append(f"- Navigation route refs: **{len(sw.nav_routes)}**")
    for n in sw.nav_routes[:5]:
        out.append(f"  - `{n}`")
    out.append("\n**install handler**")
    out.append(f"```js\n{sw.install_handler or '(not found)'}\n```")
    out.append("\n**activate handler**")
    out.append(f"```js\n{sw.activate_handler or '(not found)'}\n```")

    # --- Manifest
    out.append("\n## Manifest contents")
    out.append(f"- URL tried last: `{mani.url}`  status: `{mani.status}`")
    out.append(f"```json\n{mani.body[:1500]}\n```")

    # --- Bundle
    out.append("\n## Main bundle reload-related references")
    out.append(f"- URL: `{bundle.url}`  status: `{bundle.status}`  "
               f"size: `{bundle.size}`  sha256[:16]: `{bundle.sha}`")
    out.append(f"- `location.reload(` matches: **{len(bundle.reload_hits)}**")
    for ln, ctx in bundle.reload_hits[:5]:
        out.append(f"  - line {ln}: `{ctx}`")
    out.append(f"- `controllerchange` matches: **{len(bundle.controllerchange_hits)}**")
    for ln, ctx in bundle.controllerchange_hits[:5]:
        out.append(f"  - line {ln}: `{ctx}`")
    out.append(f"- `hadInitialController` matches: **{bundle.had_initial_controller_hits}** "
               f"{'(GATE PRESENT)' if bundle.had_initial_controller_hits else '(GATE MISSING)'}")
    out.append(f"- `registerSW` matches: **{bundle.register_sw_hits}**")
    out.append(f"- `virtual:pwa-register` matches: **{bundle.virtual_pwa_hits}**")
    out.append(f"- `setTimeout(...)` near reload/controllerchange: "
               f"**{len(bundle.settimeout_near_reload)}**")
    for s in bundle.settimeout_near_reload[:5]:
        out.append(f"  - `{s}`")

    # --- Determinism
    out.append("\n## Determinism (3 sequential fetches of /)")
    shas = {r["html_sha"] for r in det}
    out.append(f"- distinct HTML sha256[:16] values across 3 fetches: **{len(shas)}** "
               f"({', '.join(sorted(shas))})")
    asset_sets = [tuple(sorted(set(r["assets"]))) for r in det]
    out.append(f"- distinct asset URL sets across 3 fetches: **{len(set(asset_sets))}**")

    # --- Diagnosis
    out.append("\n## Diagnosis")
    findings: list[str] = []
    if html.refresh_metas:
        findings.append("HTML contains a `<meta http-equiv=refresh>` tag - that "
                        "alone can cause a one-shot reload on first load.")
    if sw.status == 200 and (sw.clients_claim or sw.workbox_clients_claim):
        if not bundle.had_initial_controller_hits and bundle.controllerchange_hits:
            findings.append(
                "Deployed sw.js calls `clients.claim()` AND the deployed bundle "
                "has a `controllerchange` listener but **no `hadInitialController` "
                "gate**. On a hard refresh the page loads uncontrolled, the SW "
                "activates, claims the page, fires `controllerchange`, and the "
                "ungated listener calls `location.reload()` -> the single "
                "spontaneous reload you observe."
            )
        elif bundle.had_initial_controller_hits and bundle.controllerchange_hits:
            findings.append(
                "Deployed sw.js calls `clients.claim()`, but the bundle DOES "
                "contain `hadInitialController` -> the gate fix is deployed. "
                "If the glitch persists, the listener may still fire because "
                "the initial-controller snapshot is taken AFTER the SW already "
                "claimed (race), or another reload path exists (see below)."
            )
    if sw.status == 200 and sw.skip_waiting and not (sw.clients_claim or sw.workbox_clients_claim):
        findings.append(
            "SW calls `skipWaiting()` but not `clients.claim()` -> by itself "
            "this only matters on update; not the first-load cause."
        )
    if bundle.settimeout_near_reload:
        findings.append(
            "There is a `setTimeout(...)` adjacent to reload/controllerchange "
            "code in the bundle - inspect this; deferred reloads are a classic "
            "source of the 'render then reload' visual flicker."
        )
    if len(shas) > 1:
        findings.append(
            "HTML sha changed across 3 sequential fetches - a deploy or A/B "
            "swap may be running mid-test; rerun before trusting other findings."
        )
    if not findings:
        findings.append(
            "No obvious reload trigger found in HTML, SW, or bundle. "
            "Likely client-side state (e.g. a runtime feature flag, "
            "first-visit telemetry redirect, or an oauth/storage migration) "
            "deserves the next look."
        )

    most_likely = findings[0]
    out.append(f"\n**Most likely cause:** {most_likely}\n")
    out.append("**All findings:**")
    for f in findings:
        out.append(f"- {f}")

    return "\n".join(out)


# ---------- main ---------------------------------------------------------
def main() -> int:
    print(f"[probe] using {'requests' if HAS_REQUESTS else 'urllib'}", file=sys.stderr)
    html = inspect_html()
    print(f"[probe] html status={html.status} bytes={len(html.html)}", file=sys.stderr)
    sw = inspect_sw()
    print(f"[probe] sw   status={sw.status} bytes={sw.size}", file=sys.stderr)
    mani = inspect_manifest()
    print(f"[probe] manifest status={mani.status} url={mani.url}", file=sys.stderr)
    # Pick first module script for bundle analysis; if absent, first plain src
    bundle_url = html.module_scripts[0] if html.module_scripts else ""
    if not bundle_url:
        bundle = BundleInfo()
    else:
        bundle = inspect_bundle(bundle_url)
        print(f"[probe] bundle status={bundle.status} bytes={bundle.size}", file=sys.stderr)
    det = determinism_check(3)
    print(f"[probe] determinism rows={len(det)}", file=sys.stderr)

    report = build_report(html, sw, mani, bundle, det)
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
