#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.51,<2"]
# ///
"""Exercise the actual viewer server against a selected local session (read-only).

uv run tests/browser_smoke.py --url http://127.0.0.1:8787 \
  --source opencode --session SESSION_ID --screenshots .session-viewer
"""
import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("--url", default="http://127.0.0.1:8787")
parser.add_argument("--source", default="opencode", choices=["opencode", "claude"])
parser.add_argument("--session", required=True)
parser.add_argument("--screenshots", type=Path)
parser.add_argument("--snapshot", type=Path, help="Also verify a static HTML export of the selected session")
args = parser.parse_args()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1512, "height": 1000}, permissions=["clipboard-read", "clipboard-write"])
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def check_new_tab(link, *, middle=False):
        """Use the browser's real default action, not window.open or fake clicks."""
        href = link.get_attribute("href")
        assert href and href.startswith(("#session-", "#b-"))
        original_url = page.url
        original_thread = page.locator(".tree-item.active").get_attribute("href")
        with context.expect_page() as opened:
            if middle:
                link.click(button="middle")
            else:
                link.click(modifiers=["ControlOrMeta"])
        tab = opened.value
        tab.on("pageerror", lambda error: errors.append(str(error)))
        try:
            tab.wait_for_url(lambda url: url.endswith(href), wait_until="networkidle")
            assert tab.url.endswith(href), tab.url
            if href.startswith("#session-"):
                expect(tab.locator("#main > .session .session-head .sid")).to_have_text(href.removeprefix("#session-"))
            else:
                target = tab.locator(f"[id='{href[1:]}']")
                expect(target).to_be_visible()
                if target.evaluate("el => el.tagName === 'DETAILS'"):
                    expect(target).to_have_attribute("open", "")
            assert page.url == original_url, "New-tab navigation changed the original tab URL"
            expect(page.locator(".tree-item.active")).to_have_attribute("href", original_thread)
        finally:
            tab.close()

    page.goto(args.url, wait_until="networkidle")
    expect(page.get_by_role("heading", name="From instruction to execution.")).to_be_visible()
    page.get_by_label("Search sessions").fill("this-session-does-not-exist")
    expect(page.locator("#no-results")).to_be_visible()
    page.get_by_label("Search sessions").fill("")
    page.get_by_label("Filter source").select_option(args.source)
    if args.screenshots:
        args.screenshots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(args.screenshots / "index-desktop.png"), full_page=True)

    route = f"{args.url}/run/{args.source}/{args.session}"
    page.goto(route, wait_until="networkidle")
    payload = page.evaluate("({id: __RUN__.rootId, threads: __RUN__.sessions.length, rootTurns: __RUN__.sessions[0].turns.length, steps: (__RUN__.workflows || []).flatMap(w => w.steps).length})")
    expect(page.locator(".tree-item")).to_have_count(payload["threads"])
    expect(page.locator(".turn[open]")).to_have_count(0)
    expect(page.locator(".workflow-step[open]")).to_have_count(0)
    if payload["threads"] > 1:
        check_new_tab(page.locator(".tree-item").nth(1))
        check_new_tab(page.locator(".tree-item").nth(1), middle=True)
        page.locator(".tree-item").nth(1).press("Enter")
        expect(page.locator(".crumbs a.link")).to_be_visible()
        check_new_tab(page.locator(".crumbs a.link").first)
        page.go_back()
        expect(page.locator(".tree-item.active")).to_have_attribute("href", f"#session-{payload['id']}")
    check_new_tab(page.locator(".ol-target").first)
    if page.locator(".outline a.link").count():
        check_new_tab(page.locator(".outline a.link").first)
    if payload["steps"]:
        page.locator(".workflow-step > summary").first.click()
        expect(page.locator(".workflow-body")).to_be_visible()
        expect(page.get_by_text("Assigned work", exact=True)).to_be_visible()
        expect(page.get_by_text("Observed activity", exact=True)).to_be_visible()
        if page.locator(".workflow-body .thread-link").count():
            check_new_tab(page.locator(".workflow-body .thread-link").first)
        if page.locator(".workflow-body a.link").count():
            check_new_tab(page.locator(".workflow-body a.link").first)

    turn = page.evaluate("__RUN__.sessions[0].turns.find(t => t.blocks.some(b => b.kind === 'tool'))?.index")
    assert turn is not None, "Select a session with at least one tool call"
    page.locator(f"[id='b-{payload['id']}-{turn}--1'] > summary").click()
    tool = page.locator(".blk-tool").first
    tool.locator(":scope > summary").click()
    expect(tool.locator(".tool-body")).to_be_visible()
    expect(tool.get_by_text("Output", exact=True)).to_be_visible()
    check_new_tab(tool.locator(":scope > summary .anchor"))
    if args.screenshots:
        page.screenshot(path=str(args.screenshots / f"{args.source}-thread-desktop.png"))

    page.get_by_label("Search all threads").fill("bash")
    expect(page.locator(".search-hit").first).to_be_visible()
    check_new_tab(page.locator(".search-hit").first)
    expect(page.get_by_label("Search all threads")).to_have_value("bash")
    page.locator(".search-hit").first.click()
    assert "#b-" in page.url
    expect(page.locator(".blk-tool[open]").first).to_be_visible()
    deep_link = page.url
    page.reload(wait_until="networkidle")
    expect(page.locator(".blk-tool[open]").first).to_be_visible()
    assert page.url == deep_link

    if payload["threads"] > 1:
        agent_call = page.evaluate("__RUN__.sessions[0].turns.flatMap(t => t.blocks.map((b, i) => ({turn: t.index, block: i, child: b.childSessionId}))).find(b => __RUN__.sessions.some(s => s.id === b.child))")
        if agent_call:
            page.goto(f"{route}#b-{payload['id']}-{agent_call['turn']}-{agent_call['block']}", wait_until="networkidle")
            nested_link = page.locator(".child > summary a.link").first
            if nested_link.count():
                check_new_tab(nested_link)
                expect(page.locator(".child[open]")).to_have_count(0)
        page.locator(".tree-item").nth(1).click()
        expect(page.locator(".assigned")).to_have_count(1)
        page.get_by_role("button", name="Copy thread for AI", exact=True).click()
        copied = page.evaluate("navigator.clipboard.readText()")
        assert "Session ID:" in copied
        page.locator(".tree-item").first.click()

    error_session = page.evaluate("__RUN__.sessions.find(s => s.stats.errors)?.id")
    if error_session:
        page.goto(f"{route}#session-{error_session}", wait_until="networkidle")
        page.get_by_label("Errors only", exact=True).check()
        expect(page.locator("#main .blk-tool:not(.st-error)")).to_have_count(0)
        expect(page.locator("#main .blk-text")).to_have_count(0)
        assert page.locator("#main .blk-tool.st-error, #main .blk-sys.lvl-error").count() > 0
        page.get_by_label("Errors only", exact=True).uncheck()
        page.locator(".tree-item").first.click()

    page.get_by_role("button", name="Collapse", exact=True).click()
    expect(page.locator(".turn[open]")).to_have_count(0)
    with page.expect_download() as download:
        page.get_by_role("link", name="Full transcript ↓").click()
    assert download.value.suggested_filename.endswith(".md")
    data = page.request.get(f"{args.url}/data/{args.source}/{args.session}").json()
    assert len(data["sessions"]) == payload["threads"]

    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(route, wait_until="networkidle")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile page overflows horizontally"
    if args.screenshots:
        page.screenshot(path=str(args.screenshots / f"{args.source}-thread-mobile.png"), full_page=True)
    if args.snapshot:
        page.goto(args.snapshot.resolve().as_uri(), wait_until="networkidle")
        expect(page.locator(".tree-item")).to_have_count(payload["threads"])
        expect(page.locator(".turn[open]")).to_have_count(0)
        expect(page.get_by_text("Offline snapshot.", exact=False)).to_be_visible()
        check_new_tab(page.locator(".tree-item").last)
        page.get_by_label("Search all threads").fill("bash")
        expect(page.locator(".search-hit").first).to_be_visible()
        page.locator(".search-hit").first.click()
        expect(page.locator(".blk-tool[open]").first).to_be_visible()
    assert not errors, errors
    print(f"Browser checks passed: {payload['threads']} threads, {payload['rootTurns']} turns, {payload['steps']} workflow assignments; desktop + mobile; modifier/middle-click new tabs and history.")
    browser.close()
