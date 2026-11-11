// whatBooksNext kindle script: paste into the browser console on the
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

// tools/store-collector/adapters/kindle.ts
/**
	* Kindle on amazon.com (store purchases plan, Stage 1). It runs on the Kindle web library,
	* https://read.amazon.com/kindle-library, and makes the same read-only request that page makes to
	* list the library: a GET of `/kindle-library/search` (a search; it changes nothing). It never
	* clicks, buys, returns, deletes, lends, downloads or marks anything.
	*
	* NOT CHECKED YET on a signed-in account: the request and its fields come from how the page is
	* publicly described. The owner's first run (owner action A2) confirms them; until then the
	* fingerprint stops the scan the moment anything differs.
	*/
	const KINDLE_VERSION = "1";
	/** Library pages this adapter knows. Other Amazon countries are added once one is checked. */
	const HOSTS = ["read.amazon.com"];
	const PAGE_SIZE = 50;
	/**
	* How Amazon labels the way a book came into the library (`originType`). Anything not listed
	* goes to review as uncertain: a purchase is never guessed.
	*/
	const ORIGINS = {
		PURCHASE: { type: "purchase" },
		KINDLE_UNLIMITED: { excluded: "subscription" },
		COMICS_UNLIMITED: { excluded: "subscription" },
		PRIME: { excluded: "subscription" },
		PRIME_READING: { excluded: "subscription" },
		SAMPLE: { excluded: "sample" },
		LENDING: { excluded: "loan" },
		LOAN: { excluded: "loan" },
		PUBLIC_LIBRARY_LENDING: { excluded: "loan" },
		KINDLE_OWNERS_LENDING_LIBRARY: { excluded: "loan" },
		PDOCS: { excluded: "personal_document" },
		PERSONAL_DOCUMENT: { excluded: "personal_document" }
	};
	const kindle = {
		service: "kindle",
		version: "1",
		label: "Kindle",
		checkPage(url) {
			if (url.protocol !== "https:" || !HOSTS.includes(url.hostname)) return {
				ok: false,
				message: "This isn’t the Kindle library. Open https://read.amazon.com/kindle-library in this tab, sign in if Amazon asks, then run the script again."
			};
			if (!url.pathname.startsWith("/kindle-library")) return {
				ok: false,
				message: "Open your library first: go to https://read.amazon.com/kindle-library in this tab, then run the script again."
			};
			return {
				ok: true,
				region: url.hostname
			};
		},
		firstCursor: "0",
		request(cursor, page) {
			const u = new URL("/kindle-library/search", page.origin);
			u.searchParams.set("query", "");
			u.searchParams.set("libraryType", "BOOKS");
			u.searchParams.set("paginationToken", cursor);
			u.searchParams.set("sortType", "recency");
			u.searchParams.set("querySize", String(PAGE_SIZE));
			return {
				url: u.href,
				init: {
					method: "GET",
					headers: { accept: "application/json" }
				}
			};
		},
		parse: parseKindlePage
	};
	/** Reads one answer of the Kindle library search. Pure, so it's tested on invented answers. */
	function parseKindlePage(body) {
		if (!body || typeof body !== "object" || !Array.isArray(body.itemsList)) throw new LayoutChanged("no itemsList in the library answer");
		const b = body;
		const records = [];
		const excluded = [];
		const fields = /* @__PURE__ */ new Set();
		const labels = [];
		for (const raw of b.itemsList) {
			if (!raw || typeof raw !== "object") throw new LayoutChanged("an item that isn’t a record");
			const it = raw;
			for (const k of Object.keys(it)) fields.add(k);
			const asin = typeof it.asin === "string" ? it.asin.trim() : "";
			const title = typeof it.title === "string" ? it.title.trim() : "";
			if (!asin) throw new LayoutChanged("an item without asin");
			if (!title) throw new LayoutChanged("an item without title");
			const origin = typeof it.originType === "string" ? it.originType : "";
			const resource = typeof it.resourceType === "string" ? it.resourceType : "";
			labels.push(`${origin || "no originType"}/${resource || "no resourceType"}`);
			const known = ORIGINS[origin];
			const reason = /SAMPLE/i.test(resource) ? "sample" : /PDOC|PERSONAL/i.test(resource) ? "personal_document" : known && "excluded" in known ? known.excluded : null;
			if (reason) {
				excluded.push({
					id: `asin:${asin}`,
					reason
				});
				continue;
			}
			const evidence = `originType ${origin || "missing"}, resourceType ${resource || "missing"}`;
			const rec = {
				storeRecordId: asin,
				idKind: "asin",
				title,
				unit: "book",
				acquisition: {
					type: known ? "purchase" : "uncertain",
					evidence
				}
			};
			const creators = authorsOf(it.authors);
			if (creators.length) rec.creators = creators;
			if (typeof it.percentageRead === "number" && it.percentageRead >= 0 && it.percentageRead <= 100) rec.progressPercent = it.percentageRead;
			if (typeof it.webReaderUrl === "string" && /^https:\/\/read\.amazon\.com\//.test(it.webReaderUrl)) rec.readUrl = it.webReaderUrl;
			records.push(rec);
		}
		const token = b.paginationToken;
		return {
			records,
			excluded,
			next: b.itemsList.length > 0 && (typeof token === "string" || typeof token === "number") && String(token) ? String(token) : null,
			fields: [...fields].sort(),
			labels
		};
	}
	/**
	* Amazon lists authors as "Last, First:" with a trailing colon. Shown as "First Last"; anything
	* else is kept as written. The role is "author" because the store calls them authors.
	*/
	function authorsOf(v) {
		if (!Array.isArray(v)) return [];
		return v.filter((x) => typeof x === "string").map((x) => x.trim().replace(/:+$/, "").trim()).filter(Boolean).map((x) => {
			const parts = x.split(",").map((p) => p.trim());
			return {
				name: parts.length === 2 && parts[0] && parts[1] ? `${parts[1]} ${parts[0]}` : x,
				role: "author"
			};
		});
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
				const body = await send(d, url, init);
				const page = c.read(() => adapter.parse(body));
				d.onProgress?.({
					requests: c.steps,
					records: c.records.size,
					waiting: false
				});
				if (page.next !== null && cursors.has(page.next)) throw new Stop("error", "The store sent the same page twice; stopped instead of looping.");
				stalled = page.added === 0 && page.next !== null ? stalled + 1 : 0;
				if (stalled >= lim.maxStalled) throw new Stop("error", "The store kept sending no new books; stopped instead of looping.");
				cursor = page.next;
			}
		} catch (e) {
			c.stop(e);
		}
		return c.result(adapter, d.now());
	}
	/**
	* Sends one request in the owner's own signed-in tab. Stops at the first sign of trouble: a
	* sign-in page, 401/403/429, an unexpected redirect, or an answer that isn't the library's.
	*/
	async function send(d, url, init) {
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
		if (!/json/i.test(res.headers.get("content-type") ?? "")) throw new Stop("blocked", "The store answered with a page instead of the library list (maybe a check that you’re a person). Stopped.");
		try {
			return await res.json();
		} catch {
			throw new Stop("layout_changed", "The store’s answer couldn’t be read.");
		}
	}

// tools/store-collector/console/run.ts
/**
	* The console script's page side: a small panel on the store's page with progress and Cancel,
	* the one-time account notice, then the file download and the title-free report. It talks only
	* to the store's page it runs on, never to whatBooksNext.
	*/
	const RISK = "whatBooksNext will now read your library list on this page, slowly and read-only.\n\nAutomated reading of a store page may break the store’s terms of use, and a store could challenge or restrict an account that does unusual things. This script goes at about a person’s pace and stops at the first warning or sign-in check.\n\nContinue? (Cancel to stop; you can add books by spreadsheet or by hand instead.)";
	/** A store whose page asks its server for the library (Kindle). */
	function runRequestScan(adapter) {
		return runInPage(adapter, (d) => scan(adapter, {
			...d,
			fetch: (u, i) => fetch(u, i)
		}));
	}
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

// tools/store-collector/console/kindle.ts
	runRequestScan(kindle);

})();