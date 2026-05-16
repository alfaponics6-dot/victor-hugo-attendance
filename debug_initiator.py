"""Capture the initiator for the second navigation request via CDP."""
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
        await client.send("Network.enable")
        await client.send("Page.enable")

        events = []
        nav_starts = []

        def on_request_will_be_sent(params):
            req = params.get("request", {})
            if req.get("url", "").rstrip("/") == URL.rstrip("/"):
                events.append({
                    "ts": time.time(),
                    "url": req.get("url"),
                    "initiator": params.get("initiator"),
                    "type": params.get("type"),
                    "frameId": params.get("frameId"),
                    "loaderId": params.get("loaderId"),
                    "requestId": params.get("requestId"),
                })

        def on_frame_started_loading(params):
            nav_starts.append({
                "ts": time.time(),
                "frameId": params.get("frameId"),
            })

        client.on("Network.requestWillBeSent", on_request_will_be_sent)
        client.on("Page.frameStartedLoading", on_frame_started_loading)

        page.on("console", lambda m: print(f"  [console.{m.type}] {m.text[:200]}") if m.type in ("error", "warning") else None)

        start = time.time()
        try:
            await page.goto(URL, wait_until="networkidle", timeout=30000)
        except Exception as e:
            print(f"goto error (continuing): {e}")
        await asyncio.sleep(8)

        print("\n=== Document-level requests to root URL ===")
        for i, e in enumerate(events):
            print(f"[{i}] +{e['ts']-start:6.2f}s  loaderId={e['loaderId'][:8]}  type={e['type']}")
            init = e.get("initiator", {})
            print(f"     initiator.type: {init.get('type')}")
            if init.get("stack"):
                print(f"     initiator.stack:")
                for frame in (init.get("stack") or {}).get("callFrames", [])[:5]:
                    print(f"       {frame.get('functionName') or '<anon>'}  {frame.get('url')}:{frame.get('lineNumber')}:{frame.get('columnNumber')}")

        print(f"\n=== Frame started loading events: {len(nav_starts)} ===")
        for i, n in enumerate(nav_starts):
            print(f"[{i}] +{n['ts']-start:6.2f}s  frameId={n['frameId'][:8]}")

        await browser.close()


asyncio.run(main())
