"""Time-lapse screenshots to see if there's an actual visible flicker."""
import asyncio
import time
from playwright.async_api import async_playwright

URL = "https://forestryescenary.com/"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(ignore_https_errors=True)
        page = await context.new_page()

        client = await context.new_cdp_session(page)
        await client.send("Page.enable")
        await client.send("Runtime.enable")

        frame_starts = []
        frame_navigated = []
        document_opens = []
        loads = []

        def on_fsl(p): frame_starts.append({"ts": time.time(), **p})
        def on_fn(p): frame_navigated.append({"ts": time.time(), **p})
        def on_load(p): loads.append({"ts": time.time(), **p})

        client.on("Page.frameStartedLoading", on_fsl)
        client.on("Page.frameNavigated", on_fn)
        client.on("Page.loadEventFired", on_load)

        # Capture every console message with timestamp
        msgs = []
        page.on("console", lambda m: msgs.append({"ts": time.time(), "type": m.type, "text": m.text}))

        # Inject a heartbeat that proves the SAME JS execution context
        # survives or not — if it logs continuously, no reload happened
        # to the script context. If logs stop and restart, a reload happened.
        await context.add_init_script("""
        (() => {
          window.__bootId = Date.now() + ':' + Math.random().toString(36).slice(2,8);
          let n = 0;
          console.log('[BOOT] id=' + window.__bootId + ' time=' + Date.now());
          setInterval(() => {
            n++;
            console.log('[BEAT] id=' + window.__bootId + ' tick=' + n);
          }, 200);
        })();
        """)

        start = time.time()
        await page.goto(URL, wait_until="commit", timeout=30000)

        # Take screenshots rapidly for the first 5 seconds
        shots = []
        for i in range(25):
            await asyncio.sleep(0.2)
            try:
                buf = await page.screenshot()
                shots.append({"ts": time.time(), "i": i, "size": len(buf)})
            except Exception as e:
                shots.append({"ts": time.time(), "i": i, "error": str(e)})

        await asyncio.sleep(3)

        print(f"\n=== Timeline (start={start:.2f}) ===")
        all_events = []
        for x in frame_starts: all_events.append((x["ts"], "frameStartedLoading", ""))
        for x in frame_navigated: all_events.append((x["ts"], "frameNavigated", x.get("frame", {}).get("url", "")))
        for x in loads: all_events.append((x["ts"], "loadEventFired", ""))
        for s in shots:
            label = f"shot #{s['i']}" + (" [ERR]" if "error" in s else f" {s['size']}b")
            all_events.append((s["ts"], label, ""))
        for m in msgs:
            if "[BOOT]" in m["text"] or "[BEAT]" in m["text"]:
                all_events.append((m["ts"], f"console.{m['type']}", m["text"][:120]))
        all_events.sort(key=lambda x: x[0])
        for ts, kind, detail in all_events:
            print(f"  +{ts-start:6.3f}s  {kind:<22}  {detail}")

        # Detect boot id changes — proves a reload
        boot_ids = []
        for m in msgs:
            if "[BOOT]" in m["text"]:
                boot_ids.append(m["text"])
        print(f"\n=== Boot id messages: {len(boot_ids)} ===")
        for b in boot_ids:
            print(f"  {b}")
        print("If there are >1 distinct ids, the JS execution context was REPLACED (= reload).")
        print("If only 1 id, same context survived (= no reload, even if framenavigated fires).")

        await browser.close()


asyncio.run(main())
