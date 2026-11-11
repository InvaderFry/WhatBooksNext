// whatBooksNext look-around script: paste into the browser console on the
// store's library page while signed in. Read-only. Generated from tools/store-collector by
// npm run build:collector; don't edit by hand.
(function() {

// tools/store-collector/probe/mask.ts
/**
	* The look-around script's privacy rules (store purchases plan, Stage 2): it reports a store
	* page's structure so an adapter can be written, and never a value that could name a book, an ID
	* or the owner. Everything it prints goes through these functions.
	*/
	/** Words stores use for how a book was acquired or what it is: labels, never titles. */
	const LABEL_WORDS = new Set([
		"purchase",
		"purchased",
		"sample",
		"free",
		"ebook",
		"audiobook",
		"book",
		"comic",
		"manga",
		"preview",
		"rental",
		"rented",
		"owned",
		"borrowed",
		"loan",
		"subscription",
		"upload",
		"uploaded",
		"archived",
		"active",
		"preorder",
		"gift",
		"promotion",
		"issue",
		"volume",
		"collection",
		"chapter",
		"series",
		"finished",
		"reading",
		"unread",
		"read",
		"true",
		"false"
	].map((w) => w.toLowerCase()));
	/**
	* A string value as it may appear in the report: a known label word, or an UPPER_SNAKE label
	* (like PURCHASE_TYPE_SAMPLE). Anything else is only described ("text, 10–50 characters").
	*/
	function describeString(s, ownHosts) {
		const t = s.trim();
		if (LABEL_WORDS.has(t.toLowerCase())) return JSON.stringify(t);
		if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(t) && t.length <= 40) return JSON.stringify(t);
		if (/^https?:\/\//i.test(t)) return `link ${maskUrl(t, ownHosts)}`;
		if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(t)) return "date text";
		if (/^\d{10,13}$/.test(t)) return `digits(${t.length})`;
		if (/^-?\d+(\.\d+)?$/.test(t)) return "number text";
		if (/^[A-Za-z0-9_-]{8,}$/.test(t) && /\d/.test(t)) return `id-like(${t.length})`;
		return `text(${t.length < 10 ? "<10" : t.length < 50 ? "10–50" : t.length < 200 ? "50–200" : "200+"})`;
	}
	/** A key may be shown unless it looks like an ID, an email or anything not a plain name. */
	function safeKey(k) {
		return /^[A-Za-z_$][A-Za-z0-9_$-]{0,40}$/.test(k) && (k.match(/\d/g) ?? []).length < 3;
	}
	/**
	* A URL as host and path pattern: segments that look like IDs or slugs become :id or :slug, and
	* query values are hidden except a few that name methods (Google's rpcids) or settings.
	*/
	function maskUrl(raw, ownHosts) {
		let u;
		try {
			u = new URL(raw, "https://invalid.example/");
		} catch {
			return "(not a URL)";
		}
		const host = ownHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) ? u.hostname : `other host (${u.hostname.split(".").slice(-2).join(".")})`;
		const path = u.pathname.split("/").map((seg) => {
			if (!seg) return seg;
			if (/^[a-z]{2}(-[a-z]{2})?$/i.test(seg) || /^[a-z_]{1,30}$/i.test(seg)) return seg;
			if (/^v\d{1,2}$/i.test(seg)) return seg;
			if (/\d/.test(seg) && seg.length >= 4) return ":id";
			return ":slug";
		}).join("/");
		const keep = /* @__PURE__ */ new Set([
			"rpcids",
			"source-path",
			"type",
			"sort",
			"sortType",
			"libraryType",
			"page",
			"limit",
			"offset",
			"pageSize",
			"querySize"
		]);
		const q = [...u.searchParams.keys()].filter((k, i, a) => a.indexOf(k) === i).map((k) => {
			if (!safeKey(k)) return ":key=…";
			const v = u.searchParams.get(k) ?? "";
			return keep.has(k) && /^[A-Za-z0-9_,.-]{0,40}$/.test(v) ? `${k}=${v}` : `${k}=…`;
		});
		return `${host}${path}${q.length ? `?${q.join("&")}` : ""}`;
	}

// tools/store-collector/probe/skeleton.ts
	const MAX_DEPTH = 14;
	const MAX_LABELS = 6;
	function shapeOf(v, own, depth = 0) {
		if (v === null || v === void 0) return { t: "null" };
		if (typeof v === "boolean") return { t: "bool" };
		if (typeof v === "number") return { t: "num" };
		if (typeof v === "string") {
			const s = v.trim();
			if (depth < MAX_DEPTH && s.length > 1 && (s[0] === "[" || s[0] === "{")) try {
				return {
					t: "mixed",
					of: [{
						t: "str",
						seen: ["json text:"]
					}, shapeOf(JSON.parse(s), own, depth + 1)]
				};
			} catch {}
			return {
				t: "str",
				seen: [describeString(v, own)]
			};
		}
		if (depth >= MAX_DEPTH) return {
			t: "str",
			seen: ["(deeper levels left out)"]
		};
		if (Array.isArray(v)) {
			const items = v.map((x) => shapeOf(x, own, depth + 1));
			if (items.length === 0) return {
				t: "list",
				n: [0],
				of: null
			};
			const same = items.every((x) => x.t === items[0].t);
			if (items.length >= 2 && same) return {
				t: "list",
				n: [items.length],
				of: items.reduce((a, b) => a ? merge(a, b) : b, null)
			};
			return {
				t: "tuple",
				items
			};
		}
		const keys = {};
		let idKeys;
		for (const [k, x] of Object.entries(v)) {
			const s = shapeOf(x, own, depth + 1);
			if (safeKey(k)) keys[k] = keys[k] ? merge(keys[k], s) : s;
			else idKeys = idKeys ? merge(idKeys, s) : s;
		}
		return idKeys ? {
			t: "obj",
			keys,
			idKeys
		} : {
			t: "obj",
			keys
		};
	}
	function merge(a, b) {
		if (a.t === "null") return b;
		if (b.t === "null") return a;
		if (a.t !== b.t) {
			const of = a.t === "mixed" ? [...a.of] : [a];
			for (const x of b.t === "mixed" ? b.of : [b]) {
				const i = of.findIndex((y) => y.t === x.t);
				if (i >= 0) of[i] = merge(of[i], x);
				else of.push(x);
			}
			return {
				t: "mixed",
				of
			};
		}
		switch (a.t) {
			case "str": {
				const seen = [...a.seen];
				for (const s of b.seen) if (!seen.includes(s) && seen.length < MAX_LABELS) seen.push(s);
				return {
					t: "str",
					seen
				};
			}
			case "obj": {
				const bb = b;
				const keys = { ...a.keys };
				for (const [k, s] of Object.entries(bb.keys)) keys[k] = keys[k] ? merge(keys[k], s) : s;
				const idKeys = a.idKeys && bb.idKeys ? merge(a.idKeys, bb.idKeys) : a.idKeys ?? bb.idKeys;
				return idKeys ? {
					t: "obj",
					keys,
					idKeys
				} : {
					t: "obj",
					keys
				};
			}
			case "list": {
				const bb = b;
				return {
					t: "list",
					n: [...a.n, ...bb.n].slice(0, 8),
					of: a.of && bb.of ? merge(a.of, bb.of) : a.of ?? bb.of
				};
			}
			case "tuple": {
				const bb = b;
				const len = Math.max(a.items.length, bb.items.length);
				return {
					t: "tuple",
					items: Array.from({ length: len }, (_, i) => a.items[i] && bb.items[i] ? merge(a.items[i], bb.items[i]) : a.items[i] ?? bb.items[i])
				};
			}
			case "mixed": return merge({ t: "null" }, {
				t: "mixed",
				of: [...a.of, ...b.of]
			});
			default: return a;
		}
	}
	/** Shapes as indented text for the report. */
	function render(s, indent = 0, maxLines = 400) {
		const lines = [];
		const pad = (n) => "  ".repeat(n);
		const walk = (x, d, label) => {
			if (lines.length >= maxLines) return;
			const head = `${pad(d)}${label}`;
			if (!x) return void lines.push(`${head}(empty)`);
			switch (x.t) {
				case "null":
					lines.push(`${head}null`);
					return;
				case "bool":
					lines.push(`${head}true/false`);
					return;
				case "num":
					lines.push(`${head}number`);
					return;
				case "str":
					lines.push(`${head}${x.seen.join(" | ")}`);
					return;
				case "obj":
					lines.push(`${head}{`);
					for (const [k, v] of Object.entries(x.keys)) walk(v, d + 1, `${k}: `);
					if (x.idKeys) walk(x.idKeys, d + 1, "<id-like keys>: ");
					lines.push(`${pad(d)}}`);
					return;
				case "list":
					lines.push(`${head}list of ${x.n.join("/")}:`);
					return walk(x.of, d + 1, "");
				case "tuple":
					lines.push(`${head}[`);
					x.items.forEach((v, i) => walk(v, d + 1, `[${i}] `));
					lines.push(`${pad(d)}]`);
					return;
				case "mixed":
					lines.push(`${head}one of:`);
					x.of.forEach((v) => walk(v, d + 1, "- "));
					return;
			}
		};
		walk(s, indent, "");
		if (lines.length >= maxLines) lines.push(`${pad(indent)}… (cut at ${maxLines} lines)`);
		return lines.join("\n");
	}
	/**
	* Reads an answer body as data: JSON, Google's ")]}'"-prefixed batch answers (each line that is
	* JSON), or nothing. Never returns the text itself.
	*/
	function parseBody(text) {
		const t = text.trim();
		if (!t) return [];
		try {
			return [JSON.parse(t)];
		} catch {}
		const out = [];
		for (const line of t.replace(/^\)\]\}'/, "").split("\n")) {
			const l = line.trim();
			if (!l || l[0] !== "[" && l[0] !== "{") continue;
			try {
				out.push(JSON.parse(l));
			} catch {}
		}
		return out;
	}

// tools/store-collector/probe/report.ts
	var Probe = class {
		groups = /* @__PURE__ */ new Map();
		embedded = [];
		own;
		constructor(own) {
			this.own = own;
		}
		add(r) {
			const key = `${r.method.toUpperCase()} ${maskUrl(r.url, this.own)}`;
			const g = this.groups.get(key) ?? {
				key,
				count: 0,
				statuses: /* @__PURE__ */ new Set(),
				types: /* @__PURE__ */ new Set(),
				shape: null,
				bytes: 0
			};
			g.count++;
			g.statuses.add(r.status);
			g.types.add((r.contentType.split(";")[0] ?? "").trim() || "unknown");
			if (r.body !== null) {
				g.bytes += r.body.length;
				for (const data of parseBody(r.body)) {
					const s = shapeOf(data, this.own);
					g.shape = g.shape ? merge(g.shape, s) : s;
				}
			}
			this.groups.set(key, g);
		}
		addEmbedded(name, data) {
			this.embedded.push({
				name,
				shape: shapeOf(data, this.own)
			});
		}
		report(head) {
			const groups = [...this.groups.values()].sort((a, b) => Number(!!b.shape) - Number(!!a.shape) || b.bytes - a.bytes);
			const out = [
				"whatBooksNext look-around report (structure only, no titles or IDs)",
				`Page: ${maskUrl(head.page, this.own)}`,
				`Browser: ${head.browser}`,
				`Date: ${head.date}`,
				"",
				`== Requests the page made while you scrolled (${groups.length} kinds) ==`
			];
			for (const g of groups.slice(0, 15)) {
				out.push(`-- ${g.key}  ×${g.count}  status ${[...g.statuses].join("/")}  ${[...g.types].join("/")}  ${Math.round(g.bytes / 1024)} KB`);
				if (g.shape) out.push(render(g.shape, 1, 150));
			}
			if (groups.length > 15) out.push(`(${groups.length - 15} more kinds left out)`);
			out.push("", `== Requests made before the script started (${head.earlier.length}) ==`);
			for (const e of [...new Set(head.earlier)].slice(0, 40)) out.push(`- ${e}`);
			out.push("", `== Data built into the page (${this.embedded.length}) ==`);
			for (const e of this.embedded.slice(0, 12)) {
				out.push(`-- ${e.name}`);
				out.push(render(e.shape, 1, 150));
			}
			out.push("", "== Repeated page elements (likely book cards) ==");
			for (const d of head.dom) out.push(`- ${d.sig} ×${d.count}; attributes: ${d.attrs.join(", ") || "none"}; link: ${d.link ?? "none"}; image: ${d.hasImage ? "yes" : "no"}`);
			return out.join("\n");
		}
	};

// tools/store-collector/console/probe.ts
	(() => {
		const base = location.hostname.split(".").slice(-2).join(".");
		const own = [base, ...base === "google.com" ? ["googleapis.com"] : []];
		const probe = new Probe(own);
		const earlier = performance.getEntriesByType("resource").map((e) => e).filter((e) => e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest").map((e) => maskUrl(e.name, own));
		const isOwn = (u) => {
			try {
				const h = new URL(u, location.href).hostname;
				return own.some((o) => h === o || h.endsWith(`.${o}`));
			} catch {
				return false;
			}
		};
		const readable = (type) => /json|javascript|text\/plain|protobuf/i.test(type);
		const origFetch = window.fetch;
		window.fetch = async function(...args) {
			const res = await origFetch.apply(this, args);
			try {
				const req = args[0];
				const url = typeof req === "string" ? req : req instanceof URL ? req.href : req.url;
				const method = (args[1]?.method ?? (req instanceof Request ? req.method : "GET")) || "GET";
				const type = res.headers.get("content-type") ?? "";
				const body = isOwn(url) && readable(type) ? await res.clone().text().catch(() => null) : null;
				probe.add({
					method,
					url,
					status: res.status,
					contentType: type,
					body
				});
			} catch {}
			return res;
		};
		const origOpen = XMLHttpRequest.prototype.open;
		const origSend = XMLHttpRequest.prototype.send;
		const meta = /* @__PURE__ */ new WeakMap();
		XMLHttpRequest.prototype.open = function(...args) {
			meta.set(this, {
				method: String(args[0]),
				url: String(args[1])
			});
			return origOpen.apply(this, args);
		};
		XMLHttpRequest.prototype.send = function(...args) {
			this.addEventListener("loadend", () => {
				try {
					const m = meta.get(this);
					if (!m) return;
					const type = this.getResponseHeader("content-type") ?? "";
					const text = this.responseType === "" || this.responseType === "text" ? this.responseText : this.responseType === "json" ? JSON.stringify(this.response) : null;
					probe.add({
						method: m.method,
						url: new URL(m.url, location.href).href,
						status: this.status,
						contentType: type,
						body: isOwn(m.url) && readable(type) ? text : null
					});
				} catch {}
			});
			return origSend.apply(this, args);
		};
		const readEmbedded = () => {
			document.querySelectorAll("script").forEach((s, i) => {
				const t = s.textContent ?? "";
				if (s.type === "application/json" || s.type === "application/ld+json" || s.id === "__NEXT_DATA__") try {
					probe.addEmbedded(`script ${s.id ? "#" + s.id : i} (${s.type || "json"})`, JSON.parse(t));
				} catch {}
				for (const m of t.matchAll(/AF_initDataCallback\(\{key:\s*'([^']+)'[\s\S]*?data:([\s\S]*?), sideChannel/g)) try {
					probe.addEmbedded(`AF_initDataCallback ${m[1]}`, JSON.parse(m[2]));
				} catch {}
			});
			const w = window;
			for (const k of [
				"__NUXT__",
				"__INITIAL_STATE__",
				"__APOLLO_STATE__",
				"__PRELOADED_STATE__"
			]) if (w[k] && typeof w[k] === "object") probe.addEmbedded(`window.${k}`, w[k]);
		};
		const domSignatures = () => {
			const counts = /* @__PURE__ */ new Map();
			for (const el of document.body.querySelectorAll("*")) {
				const cls = [...el.classList].map((c) => /\d{3,}|^[a-z0-9_-]{1,3}$/i.test(c) ? null : c.replace(/\d+/g, "#")).filter(Boolean).slice(0, 4).join(".");
				const sig = `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
				const got = counts.get(sig);
				if (got) got.count++;
				else {
					const a = el.querySelector("a[href]") ?? (el.matches("a[href]") ? el : null);
					counts.set(sig, {
						sig,
						count: 1,
						el,
						attrs: [...el.attributes].map((x) => x.name).filter((n) => n !== "class" && n !== "style" && /^[a-z-]{1,30}$/.test(n)).slice(0, 8),
						link: a ? maskUrl(a.href, own) : null,
						hasImage: !!el.querySelector("img")
					});
				}
			}
			return [...counts.values()].filter((d) => d.count >= 5 && d.count <= 5e3 && (d.link || d.hasImage)).sort((a, b) => b.count - a.count).slice(0, 15).map(({ el: _el, ...d }) => d);
		};
		const panel = document.createElement("div");
		panel.setAttribute("role", "dialog");
		panel.setAttribute("aria-label", "whatBooksNext look-around");
		panel.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;width:min(440px,calc(100vw - 32px));background:#fff;color:#111;border:2px solid #2e6b57;border-radius:8px;padding:12px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25)";
		const status = document.createElement("p");
		status.style.margin = "0 0 8px";
		status.textContent = "Looking around. Now scroll your library slowly to the very bottom, until no more books load (click any “Show more” button the page has). Then click Finish.";
		const finish = document.createElement("button");
		finish.textContent = "Finish";
		const cancel = document.createElement("button");
		cancel.textContent = "Cancel";
		cancel.style.marginLeft = "8px";
		const restore = () => {
			window.fetch = origFetch;
			XMLHttpRequest.prototype.open = origOpen;
			XMLHttpRequest.prototype.send = origSend;
		};
		cancel.onclick = () => {
			restore();
			panel.remove();
		};
		finish.onclick = () => {
			restore();
			readEmbedded();
			const text = probe.report({
				page: location.href,
				browser: navigator.userAgent,
				date: (/* @__PURE__ */ new Date()).toISOString(),
				dom: domSignatures(),
				earlier
			});
			console.log(text);
			finish.remove();
			cancel.remove();
			status.textContent = "Done. Copy the report and paste it into chat. It has no titles or IDs.";
			const box = document.createElement("textarea");
			box.readOnly = true;
			box.value = text;
			box.rows = 12;
			box.setAttribute("aria-label", "Look-around report");
			box.style.cssText = "width:100%;box-sizing:border-box;font:11px monospace;margin:4px 0";
			const copy = document.createElement("button");
			copy.textContent = "Copy report";
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
		};
		panel.append(status, finish, cancel);
		document.body.append(panel);
	})();

})();