"""Detect first-load reload glitch on forestryescenary.com using Playwright.

Loads the live site in a fresh isolated context (mimics incognito: no cookies,
no SW, no cache from previous runs) and watches for:
- Multiple `framenavigated` events on the main frame (= reloads)
- Console errors that might trigger React Router's SPA error reload
- Service worker lifecycle transitions
- Any window.location.reload calls (intercepted via init script)

Reports a verdict at the end.
"""

import asyncio
import time
from playwright.async_api import async_playwright

URL = "https://forestryescenary.com/"
WATCH_SECONDS = 12  # how long to keep the page open after load

# Init script runs BEFORE any page script. Patch every full-load navigation
# vector so the actual culprit reports a stack trace.
INIT_SCRIPT = """
(() => {
  window.__navCalls = [];
  const record = (label, args) => {
    const err = new Error(label);
    window.__navCalls.push({
      ts: Date.now(),
      label,
      args: String(args),
      stack: err.stack,
    });
    console.warn('[INSTRUMENT] ' + label, args, err.stack);
  };

  const loc = window.location;
  const origReload = loc.reload.bind(loc);
  loc.reload = (...a) => { record('location.reload', a); return origReload(...a); };

  const origAssign = loc.assign.bind(loc);
  loc.assign = (...a) => { record('location.assign', a); return origAssign(...a); };

  const origReplace = loc.replace.bind(loc);
  loc.replace = (...a) => { record('location.replace', a); return origReplace(...a); };

  // Setter on Location prototype: trap `window.location = 'x'` and any
  // sub-property writes like location.href, location.pathname, etc.
  try {
    const proto = Object.getPrototypeOf(loc);
    for (const prop of ['href', 'pathname', 'search', 'hash', 'host', 'protocol']) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && desc.set) {
        const origSet = desc.set;
        Object.defineProperty(loc, prop, {
          set(v) { record('location.' + prop + '=', v); origSet.call(loc, v); },
          get: desc.get ? desc.get.bind(loc) : undefined,
          configurable: true,
        });
      }
    }
  } catch (e) { console.warn('[INSTRUMENT] href patch failed', e); }

  // Top-level `window.location = ...`
  try {
    const wDesc = Object.getOwnPropertyDescriptor(window, 'location');
    if (wDesc && wDesc.set) {
      const origWSet = wDesc.set;
      Object.defineProperty(window, 'location', {
        set(v) { record('window.location=', v); origWSet.call(window, v); },
        get: wDesc.get ? wDesc.get.bind(window) : undefined,
        configurable: true,
      });
    }
  } catch (e) {}

  // history.go(0) reloads; history.pushState/replaceState do NOT.
  const origGo = history.go.bind(history);
  history.go = (...a) => { record('history.go', a); return origGo(...a); };

  // Form submission can cause full navigation. Hook submit globally.
  document.addEventListener('submit', (e) => {
    record('form.submit', e.target?.action || '');
  }, true);

  // Service worker controllerchange — if a listener still exists and calls
  // anything, log it (we won't see the listener body, but we see the event).
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      console.warn('[INSTRUMENT] controllerchange fired at ' + Date.now());
    });
  }

  // Beforeunload: triggered before any navigation/reload. Use it as a
  // last-resort marker of "a navigation is about to happen."
  window.addEventListener('beforeunload', () => {
    console.warn('[INSTRUMENT] beforeunload — navigation imminent. Last nav calls so far: ' + JSON.stringify(window.__navCalls.map(c => c.label)));
  });
})();
"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            # Fresh, incognito-like context
            ignore_https_errors=True,
        )
        await context.add_init_script(INIT_SCRIPT)

        page = await context.new_page()

        # Block /sw.js so no SW registers — if the reload still happens
        # without a SW in the picture, the SW is definitely NOT the cause.
        import os
        if os.environ.get("BLOCK_SW") == "1":
            print("BLOCK_SW=1: blocking /sw.js to test if SW is the trigger")
            async def block_sw(route):
                if "/sw.js" in route.request.url:
                    await route.abort()
                else:
                    await route.continue_()
            await context.route("**/*", block_sw)

        navigations = []
        console_msgs = []
        sw_events = []

        def on_frame_nav(frame):
            if frame == page.main_frame:
                navigations.append({
                    "ts": time.time(),
                    "url": frame.url,
                })

        def on_console(msg):
            if msg.type in ("error", "warning"):
                console_msgs.append({
                    "type": msg.type,
                    "text": msg.text,
                })

        page.on("framenavigated", on_frame_nav)
        page.on("console", on_console)

        # Service worker lifecycle - listen on the context
        def on_sw(sw):
            sw_events.append({
                "ts": time.time(),
                "url": sw.url,
            })

        context.on("serviceworker", on_sw)

        print(f"Loading {URL} ...")
        start = time.time()
        try:
            await page.goto(URL, wait_until="networkidle", timeout=30000)
        except Exception as e:
            print(f"goto error (continuing): {e}")

        print(f"Initial load took {time.time() - start:.2f}s")
        print(f"Watching for {WATCH_SECONDS}s ...")
        await asyncio.sleep(WATCH_SECONDS)

        reload_calls = await page.evaluate("window.__navCalls || []")

        print("\n" + "=" * 60)
        print("RESULTS")
        print("=" * 60)

        print(f"\nMain-frame navigations: {len(navigations)}")
        for i, nav in enumerate(navigations):
            rel = nav["ts"] - start
            print(f"  [{i}] +{rel:6.2f}s  {nav['url']}")

        print(f"\nService worker events: {len(sw_events)}")
        for i, sw in enumerate(sw_events):
            rel = sw["ts"] - start
            print(f"  [{i}] +{rel:6.2f}s  {sw['url']}")

        print(f"\nNavigation API calls intercepted: {len(reload_calls)}")
        for i, call in enumerate(reload_calls):
            print(f"  [{i}] {call.get('label')}  args={call.get('args')}")
            for line in (call.get("stack") or "").split("\n")[:10]:
                print(f"        {line}")

        print(f"\nConsole errors/warnings: {len(console_msgs)}")
        for msg in console_msgs[:30]:
            print(f"  [{msg['type']:<7}] {msg['text'][:400]}")

        print("\n" + "=" * 60)
        print("VERDICT")
        print("=" * 60)
        if len(navigations) > 1:
            print(f"!! RELOAD DETECTED: main frame navigated {len(navigations)} times")
            print("   (first navigation = initial load; subsequent = reloads)")
        elif reload_calls:
            print(f"!! reload() WAS CALLED ({len(reload_calls)} times) but no main-frame reload")
            print("   detected — call may have happened too late or was prevented")
        else:
            print("OK: no reload detected. Page loaded once and stayed loaded.")
            print("   The bundle deployed at this URL does NOT trigger a first-load reload.")

        await browser.close()


asyncio.run(main())
