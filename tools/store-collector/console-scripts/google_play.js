// whatBooksNext google play script: paste into the browser console on the
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

// tools/store-collector/adapters/googlePlay.ts
/**
	* Google Play Books (store purchases plan, Stage 2). It runs on the owner's purchases,
	* https://play.google.com/books?source=purchases, which leaves out uploads (the owner uploads
	* copies of their own files, which must not come in as purchases). The page shows every book as a
	* card, loaded at once, so the collector only scrolls and reads the cards: no requests at all.
	*
	* From the owner's look-around report (2026-11-11): one `gpb-volume-card` per book, holding
	* `div.card.<type>` (22 of 23 were `ebook`), `a.title` and `a.cover-link` linking to
	* `play.google.com/books/reader?id=<volume ID>`, and `a.author` linking to an author page.
	* NOT CHECKED YET as a scan: the owner's first run (A2) checks it.
	*/
	const GOOGLE_PLAY_VERSION = "2";
	/** Class names that say what a card is. Only these are reported; the rest are layout. */
	const CARD_TYPES = [
		"ebook",
		"audiobook",
		"sample",
		"preview",
		"upload",
		"uploaded",
		"rental"
	];
	const googlePlay = {
		service: "google_play",
		version: "2",
		label: "Google Play Books",
		checkPage(url) {
			if (url.protocol !== "https:" || url.hostname !== "play.google.com" || !url.pathname.startsWith("/books")) return {
				ok: false,
				message: "This isn’t Google Play Books. Open https://play.google.com/books?source=purchases in this tab, sign in if Google asks, then run the script again."
			};
			if (url.searchParams.get("source") !== "purchases") return {
				ok: false,
				message: "Open your purchases only (so your own uploads stay out): go to https://play.google.com/books?source=purchases in this tab, then run the script again."
			};
			return {
				ok: true,
				region: "play.google.com (purchases)"
			};
		},
		parse: parsePlayCards
	};
	/** A Google Play book link's volume ID and what it opens; null for any other link. */
	function bookLink(href) {
		try {
			const u = new URL(String(href ?? ""));
			const id = u.searchParams.get("id");
			if (u.protocol !== "https:" || u.hostname !== "play.google.com" || !id) return null;
			if (!/^\/(books|store\/books)(\/|$)/.test(u.pathname)) return null;
			return {
				id,
				path: u.pathname,
				reader: u.pathname.startsWith("/books/reader")
			};
		} catch {
			return null;
		}
	}
	/** Reads the cards on screen now. Pure, so it's tested on invented cards. */
	function parsePlayCards(cards) {
		if (!Array.isArray(cards)) throw new LayoutChanged("no list of book cards");
		const records = [];
		const fields = /* @__PURE__ */ new Set();
		const labelFor = {};
		for (const raw of cards) {
			const c = raw ?? {};
			const has = Object.entries(c).filter(([, v]) => v !== null && v !== void 0 && v !== "" && !(Array.isArray(v) && v.length === 0)).map(([k]) => k);
			const title = typeof c.title === "string" ? c.title.trim() : "";
			if (!c.href && !title) continue;
			for (const k of has) fields.add(k);
			const link = bookLink(c.href);
			if (!link || !title) throw new LayoutChanged(`a book card ${!link ? "without a Google book link" : "without a title"} (the card had: ${has.sort().join(", ") || "nothing"})`);
			const types = (Array.isArray(c.classes) ? c.classes : []).filter((x) => CARD_TYPES.includes(String(x).toLowerCase()));
			const ebook = types.length === 1 && types[0] === "ebook";
			const rec = {
				storeRecordId: link.id,
				idKind: "volume",
				title,
				unit: "book",
				acquisition: {
					type: ebook ? "purchase" : "uncertain",
					evidence: `listed under Purchases; card type ${types.join("+") || "not shown"}`
				}
			};
			if (link.reader) rec.readUrl = `https://play.google.com/books/reader?id=${encodeURIComponent(link.id)}`;
			else rec.pageUrl = `https://play.google.com${link.path}?id=${encodeURIComponent(link.id)}`;
			const authors = (Array.isArray(c.authors) ? c.authors : []).map((a) => String(a).trim()).filter(Boolean);
			if (authors.length) rec.creators = authors.map((name) => ({
				name,
				role: "author"
			}));
			records.push(rec);
			labelFor[`volume:${link.id}`] = `${types.join("+") || "no card type"} via ${link.path}`;
		}
		return {
			records,
			excluded: [],
			next: null,
			fields: [...fields].sort(),
			labels: [],
			labelFor
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
					errors: this.errors
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
	/**
	* Scrolls the library and reads its cards, keeping every card seen (a list may drop cards that
	* scrolled off screen). Complete when the end of the list brings nothing new twice running.
	*/
	async function scanCards(adapter, d) {
		const lim = limitsOf(d);
		const c = new Collected();
		try {
			const where = adapter.checkPage(d.page);
			if (!where.ok) throw new Stop("error", where.message);
			c.region = where.region;
			let idleAtEnd = 0;
			for (;;) {
				await pace(c, d, lim);
				const here = d.currentUrl();
				if (here.host !== d.page.host || here.pathname !== d.page.pathname) throw /signin|login|accounts\./i.test(here.href) ? new Stop("signed_out", "The store asked you to sign in. Sign in, then run it again.") : new Stop("blocked", "The tab went to another page during the scan. Stopped; open the library again.");
				c.steps++;
				const cards = d.readCards();
				const page = c.read(() => adapter.parse(cards));
				d.onProgress?.({
					requests: c.steps,
					records: c.records.size,
					waiting: false
				});
				const { atBottom } = d.scroll();
				idleAtEnd = atBottom && page.added === 0 ? idleAtEnd + 1 : 0;
				if (idleAtEnd >= lim.maxStalled) break;
			}
			if (c.records.size + c.excluded.size === 0) {
				c.fingerprint = "failed";
				throw new Stop("layout_changed", "No book cards were found on the page. If your library isn’t empty, the store’s page has changed.");
			}
		} catch (e) {
			c.stop(e);
		}
		return c.result(adapter, d.now());
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
			`Requests: ${r.stats.requests}`,
			`Found: ${e.counts.seen}`,
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
	async function runInPage(adapter, go) {
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
		status.textContent = `Reading your ${adapter.label} library…`;
		const cancel = document.createElement("button");
		cancel.textContent = "Cancel";
		cancel.onclick = () => ctrl.abort();
		panel.append(status, cancel);
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

// tools/store-collector/console/google_play.ts
	const text = (el) => (el?.getAttribute("title") || el?.textContent || "").trim();
	const readCards = () => [...document.querySelectorAll("gpb-volume-card")].map((card) => {
		const link = card.querySelector("a.title[href]") ?? card.querySelector("a.cover-link[href]") ?? card.querySelector("a[href*=\"id=\"]");
		return {
			classes: [...card.querySelector("div.card")?.classList ?? []],
			href: link?.href ?? null,
			title: text(card.querySelector("a.title")),
			authors: [...card.querySelectorAll("a.author")].map(text).filter(Boolean)
		};
	});
	/** The element that scrolls the library: the nearest scrolling parent of a card, else the page. */
	function scroller() {
		let el = document.querySelector("gpb-volume-card");
		while (el && el !== document.body) {
			const s = getComputedStyle(el);
			if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
			el = el.parentElement;
		}
		return document.scrollingElement ?? document.documentElement;
	}
	runInPage(googlePlay, (d) => {
		const box = scroller();
		return scanCards(googlePlay, {
			...d,
			currentUrl: () => new URL(location.href),
			readCards,
			scroll: () => {
				box.scrollBy({ top: Math.max(200, box.clientHeight * .8) });
				return { atBottom: box.scrollTop + box.clientHeight >= box.scrollHeight - 4 };
			}
		});
	});

})();