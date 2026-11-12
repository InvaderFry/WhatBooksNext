// whatBooksNext globalcomix script: paste into the browser console on the
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

// tools/store-collector/adapters/globalcomix.ts
/**
	* GlobalComix (store purchases plan, Stage 2). The owner's purchases page loads its list from
	* `https://api.globalcomix.com/v1/account/digital-purchases?p=N` (30 per page). Version 1 asked for
	* that list itself and the service answered HTTP 400 (2026-11-11): the site adds something of its
	* own to its requests. Copying that would mean handling the site's sign-in, which the plan rules
	* out. So version 2 **makes no requests**: the owner starts on the home page, pastes the script,
	* and goes to My Shelf → Purchases with the site's menu; the script reads the list answers the
	* page itself receives, like the look-around did.
	*
	* From the owner's fourth look-around report (2026-11-11): `payload.results` is a list of purchase
	* records (`id`, `release_id`, `net_price`, `is_downloadable`, `create_time`), each with its
	* `release`: `id`, `title`, `comic_name`, `chapter`, `release_type_name` ("Volume"), `isbn`,
	* `read_url`, `comic_type.name`, and `user_read_status` (`is_complete`,
	* `read_progress_percentage`). Other list answers carry `pagination` (`page`, `per_page`,
	* `total_pages`) and `filters.perpage`. Only purchases are in this list: Gold reading isn't.
	*/
	const GLOBALCOMIX_VERSION = "2";
	const globalcomix = {
		service: "globalcomix",
		version: "2",
		label: "GlobalComix",
		checkPage(url) {
			if (url.protocol !== "https:" || !/^(www\.)?globalcomix\.com$/.test(url.hostname)) return {
				ok: false,
				message: "This isn’t GlobalComix. Open https://globalcomix.com (the home page), sign in if asked, then run the script there."
			};
			if (url.pathname.startsWith("/my-shelf")) return {
				ok: false,
				message: "Start on the home page: open https://globalcomix.com in this tab (type it in, so the page loads fresh), paste the script there, then go to My Shelf → Purchases with the site’s menu."
			};
			return {
				ok: true,
				region: "globalcomix.com"
			};
		},
		matches: (url) => url.hostname === "api.globalcomix.com" && url.pathname === "/v1/account/digital-purchases",
		parse: parseGlobalComixPage
	};
	const str = (v) => typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
	/** What was bought: GlobalComix's release type → the plan's units. */
	function unitOf(type) {
		const t = type.toLowerCase();
		if (/volume|vol\b/.test(t)) return "volume";
		if (/collection|omnibus|compendium|trade|tpb|bundle|box/.test(t)) return "collection";
		if (/issue|chapter|episode/.test(t)) return "issue";
		return "book";
	}
	/** Reads one page of the purchases list. Pure, so it's tested on invented answers. */
	function parseGlobalComixPage(body) {
		const b = body ?? {};
		if (!b.payload || !Array.isArray(b.payload.results)) throw new LayoutChanged("no payload.results list in the purchases answer");
		const records = [];
		const fields = /* @__PURE__ */ new Set();
		const labelFor = {};
		for (const raw of b.payload.results) {
			const p = raw ?? {};
			for (const k of Object.keys(p)) fields.add(k);
			const rel = p.release ?? null;
			if (!rel || typeof rel !== "object") throw new LayoutChanged("a purchase without its release");
			for (const k of Object.keys(rel)) fields.add(`release.${k}`);
			const id = str(rel.id) || str(p.release_id);
			const series = str(rel.comic_name) || str(rel.comic?.name);
			const own = str(rel.title);
			const title = own && series && /^(vol\.?|volume|issue|chapter|ch\.?|book|part|#)\s*\d/i.test(own) ? `${series}, ${own}` : own || series;
			if (!id) throw new LayoutChanged("a purchase without a release ID");
			if (!title) throw new LayoutChanged("a purchase without a title");
			const type = str(rel.release_type_name) || "unknown type";
			const price = Number(str(p.net_price));
			const free = str(p.net_price) !== "" && Number.isFinite(price) && price === 0;
			const rec = {
				storeRecordId: id,
				idKind: "release",
				title,
				unit: unitOf(type),
				acquisition: {
					type: free ? "free_claim" : "purchase",
					evidence: `GlobalComix digital purchase${free ? ", at no charge" : ""}`
				}
			};
			if (series && series !== title) rec.series = series;
			const number = str(rel.chapter);
			if (series && /^\d+(\.\d+)?$/.test(number)) rec.seriesIndex = number;
			const isbn = str(rel.isbn).replace(/[^0-9Xx]/g, "");
			if (isbn.length === 10 || isbn.length === 13) rec.isbn = isbn;
			const kind = str(rel.comic_type?.name).toLowerCase();
			if (kind === "comic" || kind === "manga") rec.kind = kind;
			const bought = /^(\d{4}-\d{2}-\d{2})/.exec(str(p.create_time));
			if (bought) rec.acquiredAt = {
				value: bought[1],
				precision: "day"
			};
			const status = rel.user_read_status ?? null;
			if (status) {
				const pct = Number(status.read_progress_percentage);
				if (Number(status.is_complete) === 1) rec.readingStatus = "finished";
				else if (Number.isFinite(pct) && pct > 0) rec.readingStatus = "in_progress";
				if (Number.isFinite(pct) && pct >= 0 && pct <= 100) rec.progressPercent = pct;
			}
			const read = str(rel.read_url);
			if (/^https:\/\/(www\.)?globalcomix\.com\/read\//.test(read)) rec.readUrl = read;
			records.push(rec);
			labelFor[`release:${id}`] = `${type}${free ? " (free)" : ""}`;
		}
		const pg = b.payload.pagination ?? null;
		const filters = b.payload.filters ?? null;
		const page = Number(pg?.page ?? b.meta?.params?.p ?? NaN);
		const pages = Number(pg?.total_pages ?? NaN);
		const perPage = Number(pg?.per_page ?? filters?.perpage ?? NaN);
		const n = b.payload.results.length;
		const lastPage = Number.isFinite(pages) ? page >= pages : n === 0 || Number.isFinite(perPage) && n < perPage;
		const next = Number.isFinite(page) && !lastPage ? String(page + 1) : null;
		return {
			records,
			excluded: [],
			next: Number.isFinite(page) ? next : "?",
			fields: [...fields].sort(),
			labels: [],
			labelFor,
			...Number.isFinite(page) ? { page } : {}
		};
	}

// tools/store-collector/core/format.ts
/**
	* The file a collector downloads and the owner chooses in whatBooksNext (store purchases plan,
	* "1b. JSON format"). The app checks every field again on import; this is the collector's side.
	* Titles stay in this file, which is the owner's own and never goes in the repo.
	*/
	const FORMAT = "whatBooksNext-store-purchases";

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
	/** An empty list never counts as an empty library: the page probably looks different. */
	function emptyIsLayout(c) {
		if (c.records.size + c.excluded.size > 0) return;
		c.fingerprint = "failed";
		throw new Stop("layout_changed", "No books were found. If your library isn’t empty, the store’s page has changed.");
	}
	/**
	* Reads the library answers the store's own page received while the owner browsed to it
	* (`WatchAdapter`). Makes no requests. Complete only when the answers seen cover every page from
	* the first to one that says it's the last; otherwise partial, with what was found.
	*/
	function collectAnswers(adapter, answers, how, now) {
		const c = new Collected();
		c.region = how.region;
		try {
			const pages = /* @__PURE__ */ new Set();
			let last = null;
			for (const body of answers) {
				c.steps++;
				const page = c.read(() => adapter.parse(body));
				if (page.page !== void 0) pages.add(page.page);
				if (page.next === null && page.page !== void 0) last = page.page;
			}
			if (answers.length === 0) throw new Stop("error", "The page didn’t load your library while the script watched. Start on the store’s home page, paste the script, then go to your library with the site’s own menu.");
			if (!(last !== null && Array.from({ length: last }, (_, i) => i + 1).every((n) => pages.has(n)))) throw new Stop("cancelled", how.ended === "cancelled" ? "You cancelled the scan." : `Finished before the whole list had loaded (pages seen: ${[...pages].sort((a, b) => a - b).join(", ") || "none"}). Scroll to the bottom of your library before finishing.`);
			emptyIsLayout(c);
		} catch (e) {
			c.stop(e);
		}
		return c.result(adapter, now);
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

// tools/store-collector/console/globalcomix.ts
	runInPage(globalcomix, (d) => new Promise((resolve) => {
		const answers = [];
		const pagesSeen = /* @__PURE__ */ new Set();
		let lastPage = null;
		const origFetch = window.fetch;
		const origOpen = XMLHttpRequest.prototype.open;
		const origSend = XMLHttpRequest.prototype.send;
		const meta = /* @__PURE__ */ new WeakMap();
		const end = (ended) => {
			window.fetch = origFetch;
			XMLHttpRequest.prototype.open = origOpen;
			XMLHttpRequest.prototype.send = origSend;
			resolve(collectAnswers(globalcomix, answers, {
				ended,
				region: "globalcomix.com"
			}, d.now()));
		};
		const take = (url, text) => {
			let u;
			try {
				u = new URL(url, location.href);
			} catch {
				return;
			}
			if (!globalcomix.matches(u)) return;
			let body;
			try {
				body = JSON.parse(text);
			} catch {
				return;
			}
			answers.push(body);
			try {
				const p = globalcomix.parse(body);
				if (p.page !== void 0) pagesSeen.add(p.page);
				if (p.next === null && p.page !== void 0) lastPage = p.page;
				const count = answers.length;
				d.say(`Read ${count} page${count === 1 ? "" : "s"} of your purchases. Keep scrolling to the bottom; it finishes by itself once it has the whole list.`);
				if (lastPage !== null && Array.from({ length: lastPage }, (_, i) => i + 1).every((n) => pagesSeen.has(n))) end("whole_list");
			} catch {
				end("owner");
			}
		};
		window.fetch = async function(...args) {
			const res = await origFetch.apply(this, args);
			try {
				const req = args[0];
				const url = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
				if (globalcomix.matches(new URL(url, location.href))) res.clone().text().then((t) => take(url, t)).catch(() => {});
			} catch {}
			return res;
		};
		XMLHttpRequest.prototype.open = function(...args) {
			meta.set(this, String(args[1]));
			return origOpen.apply(this, args);
		};
		XMLHttpRequest.prototype.send = function(...args) {
			this.addEventListener("loadend", () => {
				try {
					const url = meta.get(this);
					if (!url) return;
					const text = this.responseType === "" || this.responseType === "text" ? this.responseText : this.responseType === "json" ? JSON.stringify(this.response) : null;
					if (text !== null) take(url, text);
				} catch {}
			});
			return origSend.apply(this, args);
		};
		d.signal.addEventListener("abort", () => end("cancelled"));
		d.finished.addEventListener("abort", () => end("owner"));
	}), {
		finish: true,
		first: "Watching. Now use GlobalComix’s menu to go to My Shelf → Purchases, then scroll to the bottom of your purchases. It finishes by itself once it has the whole list (or click Finish)."
	});

})();