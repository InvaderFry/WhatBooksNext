// whatBooksNext kobo script: paste into the browser console on the
// store's library page while signed in. Read-only. Generated from tools/store-collector by
// npm run build:collector; don't edit by hand.
(function() {

// tools/store-collector/core/adapter.ts
/** The store's page or answer no longer looks like what the adapter knows: stop, never guess. */
	var LayoutChanged = class extends Error {
		constructor(what) {
			super(`The store's library looks different from what this collector knows (${what}).`);
			this.name = "LayoutChanged";
		}
	};

// tools/store-collector/adapters/kobo.ts
/**
	* Kobo, kobo.com/us (store purchases plan, Stage 2). It runs on the owner's Books library,
	* https://www.kobo.com/us/en/library/books, and fetches the same library pages that page fetches
	* while you scroll (`?pageNumber=N`, plain HTML, 24 books each). It reads and changes nothing:
	* every button on the card (mark as finished, remove, archive) is left alone.
	*
	* From the owner's look-around reports (2026-11-11): one `li.item-wrapper.book` per book, whose
	* `data-track-info` JSON holds `productId` (36 characters), `title`, `readStatus` and the store's
	* `totalBooks`; `h2.title a` links the book's page (`/us/en/ebook/<slug>`); `a.contributor-name`
	* per author; `a.button.readnow` links Kobo's web reader (`readnow.kobo.com/<id>`); and
	* `span.item-status` shows a status like "Unread". NOT CHECKED YET as a scan (A2).
	*/
	const KOBO_VERSION = "1";
	/** Marks that say a card isn't owned for good. Seeing one makes the book uncertain. */
	const NOT_OWNED = /preview|sample|kobo ?plus|subscription|borrow|loan|rental/i;
	const kobo = {
		service: "kobo",
		version: "1",
		label: "Kobo",
		checkPage(url) {
			if (url.protocol !== "https:" || url.hostname !== "www.kobo.com") return {
				ok: false,
				message: "This isn’t Kobo. Open https://www.kobo.com/us/en/library/books in this tab, sign in if Kobo asks, then run the script again."
			};
			if (!/^\/[a-z]{2}\/[a-z]{2}\/library\/books\/?$/.test(url.pathname)) return {
				ok: false,
				message: "Open your Books library: go to https://www.kobo.com/us/en/library/books in this tab, then run the script again."
			};
			return {
				ok: true,
				region: `kobo.com/${url.pathname.split("/")[1]}`
			};
		},
		firstCursor: "1",
		request(cursor, page) {
			const u = new URL(page.pathname, page.origin);
			u.searchParams.set("pageNumber", cursor);
			return {
				url: u.href,
				init: {
					method: "GET",
					headers: { accept: "text/html" }
				}
			};
		},
		answer: "html",
		endsWhenNothingNew: true,
		parse: parseKoboPage
	};
	/** Kobo's status → reading status. Only the clear ones; anything else is left out. */
	function statusOf(s) {
		const t = s.trim().toLowerCase();
		if (t === "unread") return "not_started";
		if (t === "finished" || t === "read") return "finished";
		if (t === "reading" || t === "in progress" || /^\d{1,2}% read$/.test(t)) return "in_progress";
	}
	/** Reads one library page: `{ page, cards }` from the page side. Pure, tested on invented cards. */
	function parseKoboPage(data) {
		const d = data ?? {};
		if (!Array.isArray(d.cards) || typeof d.page !== "number") throw new LayoutChanged("no list of book cards");
		const records = [];
		const fields = /* @__PURE__ */ new Set();
		const labelFor = {};
		let storeTotal;
		for (const raw of d.cards) {
			const c = raw ?? {};
			let track = {};
			try {
				track = JSON.parse(c.trackInfo ?? "{}");
			} catch {}
			const has = [...Object.entries(c).filter(([k, v]) => k !== "trackInfo" && v !== null && v !== "" && !(Array.isArray(v) && !v.length)).map(([k]) => k), ...Object.keys(track).map((k) => `trackInfo.${k}`)].sort();
			for (const k of has) fields.add(k);
			const id = typeof track.productId === "string" ? track.productId.trim() : "";
			const title = (c.title ?? "").trim() || (typeof track.title === "string" ? track.title.trim() : "");
			if (!id || !title) throw new LayoutChanged(`a book card without ${!id ? "a product ID" : "a title"} (the card had: ${has.join(", ") || "nothing"})`);
			if (typeof track.totalBooks === "number") storeTotal = track.totalBooks;
			const classes = (Array.isArray(c.classes) ? c.classes : []).filter((x) => x !== "item-wrapper");
			const marks = (Array.isArray(c.marks) ? c.marks : []).filter((m) => NOT_OWNED.test(m));
			const plainBook = classes.length === 1 && classes[0] === "book" && marks.length === 0;
			const kinds = [...classes, ...marks.map((m) => (m.match(NOT_OWNED)?.[0] ?? "").toLowerCase())];
			const rec = {
				storeRecordId: id,
				idKind: "product",
				title,
				unit: "book",
				acquisition: {
					type: plainBook ? "purchase" : "uncertain",
					evidence: plainBook ? "in your Kobo Books library, with no preview or Kobo Plus mark" : `in your Kobo Books library, marked ${kinds.join(", ") || "differently"}`
				}
			};
			const authors = (Array.isArray(c.authors) ? c.authors : []).map((a) => String(a).trim()).filter(Boolean);
			if (authors.length) rec.creators = authors.map((name) => ({
				name,
				role: "author"
			}));
			try {
				const r = new URL(String(c.readHref ?? ""));
				if (r.protocol === "https:" && r.hostname === "readnow.kobo.com") rec.readUrl = `${r.origin}${r.pathname}`;
			} catch {}
			try {
				const p = new URL(String(c.pageHref ?? ""));
				if (p.protocol === "https:" && p.hostname === "www.kobo.com") rec.pageUrl = `${p.origin}${p.pathname}`;
			} catch {}
			const status = statusOf(c.status ?? "");
			if (status) rec.readingStatus = status;
			records.push(rec);
			labelFor[`product:${id}`] = `${kinds.join("+") || "no type"}${status ? ` (${status})` : ""}`;
		}
		return {
			records,
			excluded: [],
			next: d.cards.length > 0 ? String(d.page + 1) : null,
			fields: [...fields],
			labels: [],
			labelFor,
			...storeTotal !== void 0 ? { storeTotal } : {}
		};
	}

// tools/store-collector/core/format.ts
/**
	* The file a collector downloads and the owner chooses in whatBooksNext (store purchases plan,
	* "1b. JSON format"). The app checks every field again on import; this is the collector's side.
	* Titles stay in this file, which is the owner's own and never goes in the repo.
	*/
	const FORMAT = "whatBooksNext-store-purchases";

// tools/store-collector/core/limits.ts
/**
	* Account safety limits for every collector (store purchases plan, "Account safety"; PLAN.md
	* §20 assumptions). They keep a scan close to the owner scrolling their own library. Change them
	* only with a reason, here and in PLAN.md §20.
	*/
	/** At least this long between two page loads or library requests: about a person's pace. */
	const MIN_GAP_MS = 2e3;
	/** The longer pause. */
	const PAUSE_MS = 3e4;

// tools/store-collector/core/scan.ts
	var Stop = class extends Error {
		reason;
		constructor(reason, text) {
			super(text);
			this.reason = reason;
		}
	};
	/** What a scan has found so far, and the file and stats it ends with. */
	var Collected = class {
		records = /* @__PURE__ */ new Map();
		excluded = /* @__PURE__ */ new Map();
		labels = {};
		fields = /* @__PURE__ */ new Set();
		errors = [];
		steps = 0;
		fingerprint = "not reached";
		reason = "finished";
		text = "The store’s list ended normally.";
		region;
		storeTotal;
		/** Reads one answer or one look at the page; returns how many new books it brought. */
		read(parse) {
			let page;
			try {
				page = parse();
				this.fingerprint = "passed";
			} catch (e) {
				if (e instanceof LayoutChanged) {
					this.fingerprint = "failed";
					throw new Stop("layout_changed", e.message);
				}
				throw e;
			}
			for (const f of page.fields) this.fields.add(f);
			if (page.storeTotal !== void 0) this.storeTotal = Math.max(this.storeTotal ?? 0, page.storeTotal);
			const count = (l) => this.labels[l] = (this.labels[l] ?? 0) + 1;
			if (page.labelFor) {
				for (const [k, l] of Object.entries(page.labelFor)) if (!this.records.has(k) && !this.excluded.has(k)) count(l);
			} else page.labels.forEach(count);
			const before = this.records.size + this.excluded.size;
			for (const r of page.records) {
				const key = `${r.idKind}:${r.storeRecordId}`;
				if (!this.records.has(key) && !this.excluded.has(key)) this.records.set(key, r);
			}
			for (const x of page.excluded) if (!this.excluded.has(x.id)) this.excluded.set(x.id, x.reason);
			return {
				...page,
				added: this.records.size + this.excluded.size - before
			};
		}
		stop(e) {
			if (e instanceof Stop) {
				this.reason = e.reason;
				this.text = e.message;
			} else {
				this.reason = "error";
				this.text = `Something went wrong: ${e.message}`;
			}
			this.errors.push(this.text);
		}
		result(adapter, now) {
			const list = [...this.records.values()];
			const excludedCounts = {};
			for (const r of this.excluded.values()) excludedCounts[r] = (excludedCounts[r] ?? 0) + 1;
			const uncertain = list.filter((r) => r.acquisition.type === "uncertain").length;
			const status = this.reason === "finished" ? "complete" : list.length + this.excluded.size === 0 ? "failed" : "partial";
			return {
				envelope: {
					format: FORMAT,
					formatVersion: 1,
					service: adapter.service,
					adapterVersion: adapter.version,
					source: { type: "collector" },
					collectedAt: now.toISOString(),
					...this.region ? { region: this.region } : {},
					completion: {
						status,
						reason: this.reason,
						text: this.text
					},
					counts: {
						seen: list.length + this.excluded.size,
						included: list.length - uncertain,
						uncertain,
						excluded: excludedCounts
					},
					records: list
				},
				stats: {
					requests: this.steps,
					fingerprint: this.fingerprint,
					fields: [...this.fields].sort(),
					labels: this.labels,
					errors: this.errors,
					...this.storeTotal !== void 0 ? { storeTotal: this.storeTotal } : {}
				}
			};
		}
	};
	const limitsOf = (d) => ({
		minGapMs: MIN_GAP_MS,
		pauseEvery: 50,
		pauseMs: PAUSE_MS,
		maxRequests: 300,
		maxStalled: 2,
		...d.limits
	});
	/** Before every step but the first: the usual gap, or the longer pause; and the cancel check. */
	async function pace(c, d, lim) {
		if (d.signal.aborted) throw new Stop("cancelled", "You cancelled the scan.");
		if (c.steps >= lim.maxRequests) throw new Stop("limit_reached", `Stopped at the safety limit of ${lim.maxRequests} steps in one scan.`);
		if (c.steps > 0) {
			const wait = c.steps % lim.pauseEvery === 0 ? lim.pauseMs : lim.minGapMs;
			d.onProgress?.({
				requests: c.steps,
				records: c.records.size,
				waiting: wait > lim.minGapMs
			});
			await d.sleep(wait, d.signal);
			if (d.signal.aborted) throw new Stop("cancelled", "You cancelled the scan.");
		}
	}
	async function scan(adapter, d) {
		const lim = limitsOf(d);
		const c = new Collected();
		try {
			const where = adapter.checkPage(d.page);
			if (!where.ok) throw new Stop("error", where.message);
			c.region = where.region;
			const cursors = /* @__PURE__ */ new Set();
			let cursor = adapter.firstCursor;
			let stalled = 0;
			while (cursor !== null) {
				await pace(c, d, lim);
				cursors.add(cursor);
				const { url, init } = adapter.request(cursor, d.page);
				c.steps++;
				const body = await send(d, url, init, adapter.answer ?? "json");
				const data = adapter.answer === "html" ? d.fromHtml(body, url) : body;
				const page = c.read(() => adapter.parse(data));
				d.onProgress?.({
					requests: c.steps,
					records: c.records.size,
					waiting: false
				});
				if (page.next !== null && cursors.has(page.next)) throw new Stop("error", "The store sent the same page twice; stopped instead of looping.");
				if (adapter.endsWhenNothingNew && page.added === 0 && c.steps > 1) break;
				stalled = page.added === 0 && page.next !== null ? stalled + 1 : 0;
				if (stalled >= lim.maxStalled) throw new Stop("error", "The store kept sending no new books; stopped instead of looping.");
				cursor = page.next;
			}
			emptyIsLayout(c);
		} catch (e) {
			c.stop(e);
		}
		return c.result(adapter, d.now());
	}
	/** An empty list never counts as an empty library: the page probably looks different. */
	function emptyIsLayout(c) {
		if (c.records.size + c.excluded.size > 0) return;
		c.fingerprint = "failed";
		throw new Stop("layout_changed", "No books were found. If your library isn’t empty, the store’s page has changed.");
	}
	/**
	* Sends one request in the owner's own signed-in tab. Stops at the first sign of trouble: a
	* sign-in page, 401/403/429, an unexpected redirect, or an answer that isn't the library's.
	*/
	async function send(d, url, init, answer) {
		let res;
		try {
			res = await d.fetch(url, {
				credentials: "include",
				...init,
				signal: d.signal
			});
		} catch (e) {
			if (d.signal.aborted) throw new Stop("cancelled", "You cancelled the scan.");
			throw new Stop("error", `The request failed: ${e.message}`);
		}
		const final = res.url ? new URL(res.url) : new URL(url);
		if (/\/ap\/(signin|mfa|cvf)|signin|login/i.test(final.pathname)) throw new Stop("signed_out", "The store asked you to sign in. Sign in, then run it again.");
		if (res.status === 401) throw new Stop("signed_out", "The store says you’re signed out. Sign in, then run it again.");
		if (res.status === 403 || res.status === 429) throw new Stop("blocked", `The store refused the request (HTTP ${res.status}). Stopped; don’t run it again today.`);
		if (res.redirected && final.host !== new URL(url).host) throw new Stop("blocked", `The store sent the request somewhere else (${final.host}).`);
		if (!res.ok) throw new Stop("error", `The store answered HTTP ${res.status}.`);
		if (answer === "html") {
			if (!/html/i.test(res.headers.get("content-type") ?? "")) throw new Stop("blocked", "The store answered with something other than a library page. Stopped.");
			return await res.text();
		}
		if (!/json/i.test(res.headers.get("content-type") ?? "")) throw new Stop("blocked", "The store answered with a page instead of the library list (maybe a check that you’re a person). Stopped.");
		try {
			return await res.json();
		} catch {
			throw new Stop("layout_changed", "The store’s answer couldn’t be read.");
		}
	}

// tools/store-collector/core/report.ts
/**
	* The title-free report the owner pastes into chat (store purchases plan, "1a"): counts, labels
	* and field names only. Never titles, IDs, account names or emails.
	*/
	function report(adapter, r, browser) {
		const e = r.envelope;
		const excluded = Object.entries(e.counts.excluded).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ");
		const acquired = {
			purchase: e.records.filter((x) => x.acquisition.type === "purchase").length,
			free: e.records.filter((x) => x.acquisition.type === "free_claim").length
		};
		const has = (k) => e.records.filter((x) => x[k] !== void 0).length;
		return [
			"whatBooksNext store collector report (no titles)",
			`Store: ${adapter.label} (${e.region ?? "region unknown"})`,
			`Collector: ${adapter.service} version ${e.adapterVersion}`,
			`Browser: ${browser}`,
			`Date: ${e.collectedAt}`,
			`Steps (requests, pages or answers read): ${r.stats.requests}`,
			`Found: ${e.counts.seen}${r.stats.storeTotal !== void 0 ? ` (the store's own count: ${r.stats.storeTotal})` : ""}`,
			`Included: ${e.counts.included} (purchases ${acquired.purchase}, free ${acquired.free})`,
			`Uncertain: ${e.counts.uncertain}`,
			`Excluded: ${excluded || "none"}`,
			`How acquired (store's labels): ${Object.entries(r.stats.labels).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
			`With a reader link: ${has("readUrl")}, a page link: ${has("pageUrl")}, an ISBN: ${has("isbn")}, progress: ${has("progressPercent")}`,
			`Fields on the store's items: ${r.stats.fields.join(", ") || "none"}`,
			`Completeness: ${e.completion.status} (${e.completion.reason}): ${e.completion.text}`,
			`Layout check: ${r.stats.fingerprint}`,
			`Errors: ${r.stats.errors.length ? r.stats.errors.join(" | ") : "none"}`
		].join("\n");
	}

// tools/store-collector/console/run.ts
/**
	* The console script's page side: a small panel on the store's page with progress and Cancel,
	* the one-time account notice, then the file download and the title-free report. It talks only
	* to the store's page it runs on, never to whatBooksNext.
	*/
	const RISK = "whatBooksNext will now read your library list on this page, slowly and read-only.\n\nAutomated reading of a store page may break the store’s terms of use, and a store could challenge or restrict an account that does unusual things. This script goes at about a person’s pace and stops at the first warning or sign-in check.\n\nContinue? (Cancel to stop; you can add books by spreadsheet or by hand instead.)";
	async function runInPage(adapter, go, opts = {}) {
		const page = new URL(location.href);
		const where = adapter.checkPage(page);
		if (!where.ok) {
			alert(where.message);
			return;
		}
		if (!confirm(RISK)) return;
		const ctrl = new AbortController();
		const panel = document.createElement("div");
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "whatBooksNext collector");
		panel.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;width:min(420px,calc(100vw - 32px));background:#fff;color:#111;border:2px solid #2e6b57;border-radius:8px;padding:12px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
		const status = document.createElement("p");
		status.style.margin = "0 0 8px";
		status.setAttribute("aria-live", "polite");
		status.textContent = opts.first ?? `Reading your ${adapter.label} library…`;
		const cancel = document.createElement("button");
		cancel.textContent = "Cancel";
		cancel.onclick = () => ctrl.abort();
		const done = new AbortController();
		const finish = document.createElement("button");
		finish.textContent = "Finish";
		finish.style.marginRight = "8px";
		finish.onclick = () => done.abort();
		panel.append(status, ...opts.finish ? [finish] : [], cancel);
		document.body.append(panel);
		const result = await go({
			page,
			sleep: (ms, signal) => new Promise((resolve) => {
				const t = setTimeout(resolve, ms);
				signal.addEventListener("abort", () => {
					clearTimeout(t);
					resolve();
				});
			}),
			now: () => /* @__PURE__ */ new Date(),
			signal: ctrl.signal,
			finished: done.signal,
			say: (t) => status.textContent = t,
			onProgress: (p) => {
				status.textContent = `${p.records} books so far, ${p.requests} steps${p.waiting ? " (a longer pause, to go easy on the store)" : ""}…`;
			}
		});
		const e = result.envelope;
		const day = e.collectedAt.slice(0, 10);
		const blob = new Blob([JSON.stringify(e, null, 2)], { type: "application/json" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `whatbooksnext-${adapter.service}-${day}${e.completion.status === "complete" ? "" : "-" + e.completion.status}.json`;
		document.body.append(a);
		a.click();
		a.remove();
		const text = report(adapter, result, navigator.userAgent);
		console.log(text);
		cancel.remove();
		finish.remove();
		status.textContent = e.completion.status === "complete" ? `Done: ${e.counts.included + e.counts.uncertain} books. The file is in your Downloads folder; keep it private.` : `Stopped (${e.completion.status}): ${e.completion.text} The file has what was found so far.`;
		const box = document.createElement("textarea");
		box.readOnly = true;
		box.value = text;
		box.rows = 10;
		box.setAttribute("aria-label", "Report (no titles)");
		box.style.cssText = "width:100%;box-sizing:border-box;font:12px monospace;margin:4px 0";
		const copy = document.createElement("button");
		copy.textContent = "Copy report (no titles)";
		copy.onclick = async () => {
			try {
				await navigator.clipboard.writeText(text);
				copy.textContent = "Copied";
			} catch {
				box.select();
			}
		};
		const close = document.createElement("button");
		close.textContent = "Close";
		close.style.marginLeft = "8px";
		close.onclick = () => panel.remove();
		panel.append(box, copy, close);
	}

// tools/store-collector/console/kobo.ts
	const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
	function cardsOf(html, url) {
		const doc = new DOMParser().parseFromString(html, "text/html");
		return {
			page: Number(new URL(url).searchParams.get("pageNumber") ?? "1"),
			cards: [...doc.querySelectorAll("li.item-wrapper")].map((li) => {
				const titleLink = li.querySelector("h2.title a");
				const titleText = text(titleLink);
				return {
					classes: [...li.classList],
					trackInfo: li.getAttribute("data-track-info"),
					title: titleText,
					pageHref: titleLink?.getAttribute("href") ? new URL(titleLink.getAttribute("href"), url).href : null,
					authors: [...li.querySelectorAll("a.contributor-name")].map(text).filter(Boolean),
					readHref: (() => {
						const a = li.querySelector("a.button.readnow");
						return a?.getAttribute("href") ? new URL(a.getAttribute("href"), url).href : null;
					})(),
					status: text(li.querySelector("span.item-status")),
					marks: [...li.querySelectorAll("[class*=\"badge\"], [class*=\"ribbon\"], [class*=\"preview\"], [class*=\"plus\"], [class*=\"subscription\"], .product-type-icon")].flatMap((el) => [text(el), ...[...el.classList]]).map((t) => t.toLowerCase()).filter((t) => t && t.length < 40 && t !== titleText.toLowerCase())
				};
			})
		};
	}
	runInPage(kobo, (d) => scan(kobo, {
		...d,
		fetch: (u, i) => fetch(u, i),
		fromHtml: cardsOf
	}));

})();