/**
 * TSP node renderers. Each node kind maps to one component; components
 * subscribe to their own node (see store.ts), so a streaming `md` tail or a
 * ticking agent card re-renders alone. `role` lands on `data-role` so the
 * stylesheet can give omp's semantic parts (composer, welcome, hud, user
 * turn) their own look without the renderer knowing them.
 */
import { StreamingMarkdown } from "@oh-my-pi/collab-web/src/components/transcript/Markdown";
import katex from "katex";
import {
	createContext,
	type CSSProperties,
	memo,
	type MouseEvent,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { AnsiBlock } from "./ansi";
import { Editor } from "./editor";
import { Icon } from "./icons";
import type { SessionConnection } from "./session";
import type { StoreNode, SurfaceStore } from "./store";

export interface SurfaceContextValue {
	session: SessionConnection;
	store: SurfaceStore;
	sf: string;
	palette: Record<string, string>;
}

export const SurfaceContext = createContext<SurfaceContextValue | null>(null);

export function useSurface(): SurfaceContextValue {
	const value = useContext(SurfaceContext);
	if (!value) throw new Error("no surface");
	return value;
}

export function useNode(id: string): StoreNode | undefined {
	const { store } = useSurface();
	useSyncExternalStore(
		listener => store.subscribe(id, listener),
		() => store.get(id)?.v ?? -1,
	);
	return store.get(id);
}

// ─── Text and spans ──────────────────────────────────────────────────────────

const SPAN_TOKENS = new Set([
	"muted",
	"dim",
	"strong",
	"em",
	"accent",
	"success",
	"warning",
	"error",
	"info",
	"code",
	"mono",
	"path",
	"key",
	"link",
	"num",
	"ins",
	"del",
	"mark",
	"typo",
	"icon",
	"hide",
]);

function spanStyle(tokens: string[], palette: Record<string, string>): { className: string; style?: CSSProperties } {
	const classes: string[] = [];
	let color: string | undefined;
	for (const token of tokens) {
		if (SPAN_TOKENS.has(token)) classes.push(`s-${token}`);
		else if (palette[token]) color = `var(--p-${token})`;
	}
	return { className: classes.join(" "), style: color ? { color } : undefined };
}

export function Spans({ text }: { text: unknown }): ReactNode {
	const { palette } = useSurface();
	if (text === undefined || text === null) return null;
	if (typeof text === "string") return text;
	if (!Array.isArray(text)) return String(text);
	return text.map((span: any, i: number) => {
		const { className, style } = spanStyle(
			String(span.s ?? "")
				.split(/\s+/)
				.filter(Boolean),
			palette,
		);
		const fx = span.fx && span.fx !== "none" ? ` fx-${span.fx}` : "";
		if (span.href)
			return (
				<a key={i} className={`${className}${fx}`} style={style} href={span.href} target="_blank" rel="noreferrer">
					{span.t}
				</a>
			);
		return (
			<span key={i} className={`${className}${fx}`} style={style}>
				{span.t}
			</span>
		);
	});
}

// ─── Common props ────────────────────────────────────────────────────────────

function extent(value: unknown): string | undefined {
	if (typeof value === "number") return `${value * 100}%`;
	if (typeof value === "string") {
		if (value.endsWith("ch")) return value;
		if (value.endsWith("lines")) return `${parseFloat(value) * 1.45}em`;
	}
	return undefined;
}

function useCommon(
	node: StoreNode,
	extraClass = "",
): {
	className: string;
	style: CSSProperties;
	title?: string;
	"data-role"?: string;
	onClick?: (event: MouseEvent) => void;
	onDoubleClick?: (event: MouseEvent) => void;
} {
	const { session, store, sf } = useSurface();
	const p = node.p;
	const style: CSSProperties = {};
	if (typeof p.grow === "number") style.flexGrow = p.grow;
	if (typeof p.shrink === "number") style.flexShrink = p.shrink;
	if (typeof p.basis === "number") style.flexBasis = `${p.basis * 100}%`;
	if (p.min?.w) style.minWidth = extent(p.min.w);
	if (p.min?.h) style.minHeight = extent(p.min.h);
	if (p.max?.w) style.maxWidth = extent(p.max.w);
	if (p.max?.h) {
		style.maxHeight = extent(p.max.h);
		style.overflow = "auto";
	}
	const classes = [`k-${node.k}`, extraClass];
	if (p.tone) classes.push(`tone-${p.tone}`);
	if (p.mark) classes.push(`mark-${p.mark}`);
	const act = (action: string | undefined, event: MouseEvent) => {
		if (!action) return;
		event.stopPropagation();
		if (action === "copy") {
			void navigator.clipboard?.writeText(store.textOf(node.id));
			return;
		}
		if (action === "open" && p.href) {
			if (/^https?:/.test(p.href)) window.open(p.href, "_blank", "noreferrer");
			else if (p.href.startsWith("file://")) session.openHref(p.href);
			return;
		}
		if (action === "toggle") {
			session.event({ ev: "toggle", sf, id: node.id, key: p.key, collapsed: !p.collapsed });
			return;
		}
		session.event({ ev: "action", sf, id: node.id, act: action, mods: event.shiftKey ? ["shift"] : undefined });
	};
	return {
		className: classes.filter(Boolean).join(" "),
		style,
		title: typeof p.title === "string" && node.k !== "picker" ? p.title : undefined,
		"data-role": p.role,
		onClick: p.actions?.click ? event => act(p.actions.click, event) : undefined,
		onDoubleClick: p.actions?.dblclick ? event => act(p.actions.dblclick, event) : undefined,
	};
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export const N = memo(function N({ id }: { id: string }): ReactNode {
	const node = useNode(id);
	if (!node || node.p.hidden) return null;
	const Renderer = RENDERERS[node.k] ?? Generic;
	return <Renderer node={node} />;
});

function Kids({ node }: { node: StoreNode }): ReactNode {
	return node.c.map(child => <N key={child} id={child} />);
}

/** A message that starts a turn: the user's, or one from an agent in another session (`<agent>@<session>`). */
function startsTurn(node: StoreNode | undefined): boolean {
	if (!node) return false;
	if (node.p.role === "omp.user") return true;
	if (node.p.role !== "omp.irc.incoming") return false;
	const head = node.p.head;
	const text = Array.isArray(head) ? head.map((span: any) => span.t ?? "").join("") : String(head ?? "");
	return text.includes("@");
}

/**
 * The main region as turns: each message that starts one (see startsTurn)
 * with the steps that answer it (assistant prose, thinking, tools) in a
 * column the stylesheet draws as a timeline. Whatever precedes the first
 * message (omp's welcome) stays above.
 */
export const Transcript = memo(function Transcript({ id }: { id: string }): ReactNode {
	const node = useNode(id);
	const { store } = useSurface();
	if (!node || node.p.hidden) return null;
	const lead: string[] = [];
	const turns: { user: string; steps: string[] }[] = [];
	for (const child of node.c) {
		if (startsTurn(store.get(child))) turns.push({ user: child, steps: [] });
		else if (turns.length > 0) turns.at(-1)!.steps.push(child);
		else lead.push(child);
	}
	return (
		<div className="k-col transcript">
			{lead.map(child => (
				<N key={child} id={child} />
			))}
			{turns.map(turn => (
				<section key={turn.user} className="turn">
					<N id={turn.user} />
					{turn.steps.length > 0 ? (
						<div className="steps">
							{turn.steps.map(child => (
								<N key={child} id={child} />
							))}
						</div>
					) : null}
				</section>
			))}
		</div>
	);
});

type R = (props: { node: StoreNode }) => ReactNode;

const Generic: R = ({ node }) => (
	<div {...useCommon(node)}>
		<Kids node={node} />
	</div>
);

const GAP: Record<string, string> = { none: "0", xs: "2px", sm: "4px", md: "8px", lg: "14px" };

const Col: R = ({ node }) => {
	const common = useCommon(node);
	const p = node.p;
	return (
		<div
			{...common}
			style={{
				...common.style,
				gap: GAP[p.gap] ?? undefined,
				alignItems: p.align === "stretch" ? undefined : p.align,
			}}
		>
			<Kids node={node} />
		</div>
	);
};

const JUSTIFY: Record<string, string> = { start: "flex-start", between: "space-between", end: "flex-end" };

const Row: R = ({ node }) => {
	const common = useCommon(node);
	const p = node.p;
	return (
		<div
			{...common}
			style={{
				...common.style,
				gap: GAP[p.gap] ?? "6px",
				alignItems: p.align ?? "center",
				justifyContent: JUSTIFY[p.justify],
				flexWrap: p.wrap ? "wrap" : undefined,
			}}
		>
			<Kids node={node} />
		</div>
	);
};

/**
 * A card/section `head` is either text or the id of one of its own children
 * (omp's thinking sections describe their head as a child node): split that
 * child out so it draws in the head and not in the body.
 */
function splitHead(node: StoreNode): { head: ReactNode; body: string[] } {
	const head = node.p.head;
	if (typeof head === "string" && node.c.includes(head))
		return { head: <N id={head} />, body: node.c.filter(child => child !== head) };
	return { head: head === undefined ? undefined : <Spans text={head} />, body: node.c };
}

function StatusMark({ status }: { status?: string }): ReactNode {
	if (!status) return null;
	if (status === "running" || status === "pending") return <span className={`status-spin status-${status}`} />;
	return <span className={`status-dot status-${status}`} title={status} />;
}

const Card: R = ({ node }) => {
	const { session, sf } = useSurface();
	const common = useCommon(node);
	const p = node.p;
	const toggle = p.collapsible
		? (event: MouseEvent) => {
				event.stopPropagation();
				session.event({ ev: "toggle", sf, id: node.id, key: p.key, collapsed: !p.collapsed });
			}
		: undefined;
	const classes = [
		common.className,
		p.variant === "bare" ? "bare" : "",
		p.selected ? "selected" : "",
		p.inset ? "inset" : "",
	];
	const clamp =
		p.collapsed && p.preview && typeof p.preview === "object"
			? { maxHeight: `${p.preview.lines * 1.45}em`, overflow: "hidden" }
			: undefined;
	const { head, body } = splitHead(node);
	return (
		<div {...common} className={classes.join(" ")}>
			{head !== undefined || p.collapsible ? (
				<div className="card-head" onClick={toggle}>
					{p.collapsible ? <Icon name={p.collapsed ? "chevron-right" : "chevron-down"} size={12} /> : null}
					<StatusMark status={p.status} />
					<span className="card-head-text">{head}</span>
				</div>
			) : null}
			{p.collapsed && !p.preview ? null : (
				<div className="card-body" style={clamp}>
					{body.map(child => (
						<N key={child} id={child} />
					))}
				</div>
			)}
		</div>
	);
};

const Section: R = ({ node }) => {
	const { session, sf } = useSurface();
	const common = useCommon(node);
	const p = node.p;
	const toggle = p.collapsible
		? () => session.event({ ev: "toggle", sf, id: node.id, key: p.key, collapsed: !p.collapsed })
		: undefined;
	const { head, body } = splitHead(node);
	return (
		<div {...common}>
			{head !== undefined ? (
				<div className="section-head" onClick={toggle}>
					{p.collapsible ? <Icon name={p.collapsed ? "chevron-right" : "chevron-down"} size={12} /> : null}
					{head}
					{typeof p.took === "number" ? <span className="s-dim section-took"> · {formatMs(p.took)}</span> : null}
				</div>
			) : null}
			{p.collapsed ? null : (
				<div className="section-body">
					{body.map(child => (
						<N key={child} id={child} />
					))}
				</div>
			)}
		</div>
	);
};

const Rule: R = ({ node }) => (
	<div {...useCommon(node)}>
		{node.p.label ? (
			<span className="rule-label">
				<Spans text={node.p.label} />
			</span>
		) : null}
	</div>
);

const SPACE: Record<string, number> = { none: 0, xs: 2, sm: 4, md: 8, lg: 16 };
const Spacer: R = ({ node }) => <div className="k-spacer" style={{ height: SPACE[node.p.size] ?? 6 }} />;

const Text: R = ({ node }) => {
	const common = useCommon(node);
	const p = node.p;
	const style: CSSProperties = { ...common.style };
	if (p.wrap === "none") style.whiteSpace = "pre";
	if (p.wrap === "char") style.wordBreak = "break-all";
	if (p.truncate) {
		style.overflow = "hidden";
		style.textOverflow = "ellipsis";
		style.whiteSpace = "nowrap";
	}
	if (typeof p.lines === "number") {
		style.display = "-webkit-box";
		style.WebkitLineClamp = p.lines;
		style.WebkitBoxOrient = "vertical";
		style.overflow = "hidden";
	}
	// In a row, only text that says how to fit (truncate, wrap, grow) may shrink;
	// short labels (times, glyphs) keep their width instead of drawing over a neighbour.
	const shrink = p.truncate || p.grow || p.lines || p.wrap === "word" || p.wrap === "char" || p.measure;
	if (p.role === "omp.composer.stop")
		return (
			<button
				type="button"
				className="composer-send stop"
				data-role={p.role}
				title={p.title}
				aria-label="Stop"
				onClick={common.onClick}
			>
				<Icon name="square" size={12} />
			</button>
		);
	return (
		<span {...common} className={`${common.className}${shrink ? " shrink" : ""}`} style={style}>
			<Spans text={p.spans ?? p.text} />
			<Kids node={node} />
		</span>
	);
};

const Markdown: R = ({ node }) => (
	<div {...useCommon(node)}>
		<StreamingMarkdown text={node.p.text ?? ""} />
	</div>
);

function Clamp({ lines, children, tail }: { lines?: number; children: ReactNode; tail?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	if (!lines || open) return children;
	return (
		<div className={`clamp ${tail ? "tail" : ""}`}>
			<div className="clamp-inner" style={{ maxHeight: `${lines * 1.45}em` }}>
				{children}
			</div>
			<button type="button" className="clamp-more" onClick={() => setOpen(true)}>
				Show all
			</button>
		</div>
	);
}

const Code: R = ({ node }) => {
	const p = node.p;
	const text: string = p.text ?? "";
	const lines = text.split("\n");
	const start = typeof p.start === "number" ? p.start : 1;
	const preview =
		p.preview && typeof p.preview === "object" && lines.length > p.preview.lines ? p.preview.lines : undefined;
	return (
		<div {...useCommon(node)}>
			{p.path && !p.lang ? <div className="code-path">{p.path}</div> : null}
			<Clamp lines={preview}>
				<pre className={p.wrap ? "wrap" : ""}>
					{p.numbers
						? lines.map((line, i) => (
								<div key={i} className="code-line">
									<span className="ln">{start + i}</span>
									{line || " "}
								</div>
							))
						: text}
				</pre>
			</Clamp>
		</div>
	);
};

const Diff: R = ({ node }) => {
	const p = node.p;
	const lines: string[] = useMemo(() => {
		if (typeof p.text === "string") return p.text.split("\n");
		const out: string[] = [];
		for (const hunk of p.hunks ?? []) {
			out.push(`@@ -${hunk.oldStart} +${hunk.newStart} @@`);
			out.push(...hunk.lines);
		}
		return out;
	}, [p.text, p.hunks]);
	return (
		<div {...useCommon(node)}>
			<pre>
				{lines.map((line, i) => {
					const cls =
						line.startsWith("+") && !line.startsWith("+++")
							? "add"
							: line.startsWith("-") && !line.startsWith("---")
								? "del"
								: line.startsWith("@@")
									? "hunk"
									: "ctx";
					return (
						<div key={i} className={`diff-line ${cls}`}>
							{line || " "}
						</div>
					);
				})}
			</pre>
		</div>
	);
};

const Ansi: R = ({ node }) => {
	const p = node.p;
	const text: string = p.text ?? "";
	const preview = p.preview && typeof p.preview === "object" ? p.preview.lines : undefined;
	return (
		<div {...useCommon(node)}>
			<Clamp lines={preview && text.split("\n").length > preview ? preview : undefined} tail={p.follow}>
				<AnsiBlock text={text} />
			</Clamp>
		</div>
	);
};

const Rows: R = ({ node }) => (
	<div {...useCommon(node)}>
		<AnsiBlock text={(node.p.lines ?? []).join("\n")} />
	</div>
);

const MathNode: R = ({ node }) => {
	const html = useMemo(() => {
		try {
			return katex.renderToString(node.p.text ?? "", { displayMode: node.p.display === true, throwOnError: false });
		} catch {
			return node.p.text ?? "";
		}
	}, [node.p.text, node.p.display]);
	return <span {...useCommon(node)} dangerouslySetInnerHTML={{ __html: html }} />;
};

/** omp's mark: a clay π set in the interface serif. */
function OmpMark({ size }: { size: number }): ReactNode {
	return (
		<svg width={size} height={size} viewBox="0 0 64 64" aria-label="omp">
			<text
				x="32"
				y="50"
				textAnchor="middle"
				fontSize="58"
				style={{ fill: "var(--clay)", fontFamily: "var(--serif)" }}
			>
				π
			</text>
		</svg>
	);
}

const Image: R = ({ node }) => {
	const { session } = useSurface();
	const p = node.p;
	const common = useCommon(node);
	if (p.builtin === "omp")
		return (
			<span {...common}>
				<OmpMark size={Math.min(p.w ?? 48, 56)} />
			</span>
		);
	const url = p.blob ? session.blobs.get(p.blob) : undefined;
	if (!url)
		return (
			<span {...common} className={`${common.className} image-pending`}>
				{p.alt ?? "image"}
			</span>
		);
	return (
		<img {...common} src={url} alt={p.alt ?? ""} style={{ ...common.style, maxWidth: p.w ? `${p.w}px` : "100%" }} />
	);
};

const Kv: R = ({ node }) => (
	<div {...useCommon(node, node.p.layout === "inline" ? "inline" : "")}>
		{(node.p.items ?? []).map((item: any, i: number) => (
			<div key={i} className="kv-item">
				<span className="kv-k">
					<Spans text={item.k} />
				</span>
				<span className="kv-v">
					<Spans text={item.v} />
				</span>
			</div>
		))}
	</div>
);

const Table: R = ({ node }) => {
	const cols: any[] = node.p.cols ?? [];
	return (
		<div {...useCommon(node)}>
			<table>
				<thead>
					<tr>
						{cols.map(col => (
							<th key={col.id} style={{ textAlign: col.align }}>
								<Spans text={col.head} />
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{(node.p.rows ?? []).map((row: any) => (
						<tr key={row.id}>
							{cols.map(col => (
								<td key={col.id} style={{ textAlign: col.align }}>
									<Spans text={row.cells?.[col.id]} />
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
};

function TreeItems({ nodes }: { nodes: any[] }): ReactNode {
	return (
		<ul>
			{nodes.map(item => (
				<li key={item.id}>
					{item.icon ? <Icon name={item.icon} size={12} /> : null} <Spans text={item.label} />
					{item.children?.length && item.open !== false ? <TreeItems nodes={item.children} /> : null}
				</li>
			))}
		</ul>
	);
}

const Tree: R = ({ node }) => (
	<div {...useCommon(node)}>
		<TreeItems nodes={node.p.nodes ?? []} />
	</div>
);

const Badge: R = ({ node }) => <span {...useCommon(node)}>{node.p.text}</span>;

const KEY_GLYPH: Record<string, string> = {
	enter: "⏎",
	return: "⏎",
	esc: "Esc",
	escape: "Esc",
	tab: "⇥",
	shift: "⇧",
	alt: "⌥",
	option: "⌥",
	ctrl: "⌃",
	cmd: "⌘",
	meta: "⌘",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	backspace: "⌫",
	space: "Space",
};

const Kbd: R = ({ node }) => {
	const common = useCommon(node);
	const keys: string[] = node.p.keys ?? [];
	if (node.p.role === "omp.composer.send")
		return (
			<button
				type="button"
				className="composer-send"
				data-role={node.p.role}
				title={node.p.title}
				aria-label="Send"
				disabled={!common.onClick}
				onClick={common.onClick}
			>
				<Icon name="arrow-up" size={16} />
			</button>
		);
	return (
		<span {...common}>
			{keys.length ? (
				keys.map((key, i) => <kbd key={i}>{KEY_GLYPH[key.toLowerCase()] ?? key}</kbd>)
			) : (
				<Kids node={node} />
			)}
		</span>
	);
};

const IconNode: R = ({ node }) => (
	<span {...useCommon(node)} aria-label={node.p.aria}>
		<Icon name={node.p.name} />
	</span>
);

const Spinner: R = ({ node }) => (
	<span {...useCommon(node)}>
		<span className={node.p.style === "starburst" ? "starburst" : "spin"} />
		{node.p.label ? (
			<span className="spinner-label">
				<Spans text={node.p.label} />
			</span>
		) : null}
	</span>
);

const Shimmer: R = ({ node }) => (
	<span {...useCommon(node)}>
		<Spans text={node.p.spans ?? node.p.text} />
	</span>
);

export function formatMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function useClock(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

function Elapsed({ age, stopped }: { age: number; stopped?: number }): ReactNode {
	const [received] = useState(() => Date.now() - age);
	const now = useClock(stopped === undefined);
	return <>{formatMs(stopped ?? now - received)}</>;
}

const ElapsedNode: R = ({ node }) => (
	<span {...useCommon(node)}>
		<Elapsed key={`${node.p.age}`} age={node.p.age ?? 0} stopped={node.p.stopped} />
	</span>
);

const Progress: R = ({ node }) => {
	const value = node.p.value;
	return (
		<span {...useCommon(node)}>
			<span className="bar">
				<span
					className={`fill ${value === null ? "indeterminate" : ""}`}
					style={{ width: value === null ? undefined : `${Math.round(value * 100)}%` }}
				/>
			</span>
			{node.p.label ? (
				<span className="progress-label">
					<Spans text={node.p.label} />
				</span>
			) : null}
		</span>
	);
};

const Rate: R = ({ node }) => (
	<span {...useCommon(node)}>
		{Number(node.p.value).toFixed(node.p.value < 10 ? 1 : 0)}
		{node.p.unit ? ` ${node.p.unit}` : ""}
	</span>
);

const List: R = ({ node }) => {
	const common = useCommon(node);
	return (
		<div {...common} data-selected={node.p.selected ?? undefined}>
			{node.c.length === 0 && node.p.empty ? (
				<div className="list-empty">
					<Spans text={node.p.empty} />
				</div>
			) : (
				<Kids node={node} />
			)}
		</div>
	);
};

const Item: R = ({ node }) => {
	const { session, store, sf } = useSurface();
	const common = useCommon(node);
	const p = node.p;
	const list = node.parent ? store.get(node.parent) : undefined;
	const selected = list?.p.selected === node.id || list?.p.selected === p.key;
	const send = (ev: "select" | "activate") => () => {
		if (p.disabled || !list) return;
		session.event({ ev, sf, id: list.id, item: node.id });
	};
	return (
		<div
			{...common}
			className={`${common.className} ${selected ? "selected" : ""} ${p.disabled ? "disabled" : ""}`}
			onClick={common.onClick ?? send("select")}
			onDoubleClick={send("activate")}
		>
			{p.icon ? <Icon name={p.icon} /> : null}
			<span className="item-label">
				<Spans text={p.label} />
			</span>
			{p.detail ? (
				<span className="item-detail">
					<Spans text={p.detail} />
				</span>
			) : null}
			{p.value ? (
				<span className="item-value">
					<Spans text={p.value} />
				</span>
			) : null}
			{p.hint?.length ? (
				<span className="item-hint">
					{p.hint.map((key: string, i: number) => (
						<kbd key={i}>{KEY_GLYPH[key.toLowerCase()] ?? key}</kbd>
					))}
				</span>
			) : null}
			<Kids node={node} />
		</div>
	);
};

const Tabs: R = ({ node }) => {
	const { session, sf } = useSurface();
	return (
		<div {...useCommon(node)}>
			{(node.p.items ?? []).map((tab: any) => (
				<button
					type="button"
					key={tab.id}
					className={`tab ${tab.id === node.p.active ? "active" : ""}`}
					onClick={() => session.event({ ev: "select", sf, id: node.id, item: tab.id })}
				>
					<Spans text={tab.label} />
				</button>
			))}
		</div>
	);
};

const Status: R = ({ node }) => {
	const left = node.c.filter(() => true);
	return (
		<div {...useCommon(node, node.p.transparent ? "transparent" : "")}>
			{left.map(child => (
				<N key={child} id={child} />
			))}
		</div>
	);
};

const Seg: R = ({ node }) => (
	<span {...useCommon(node, node.p.side === "right" ? "right" : "")}>
		{node.p.icon ? <Icon name={node.p.icon} size={12} /> : null}
		<Spans text={node.p.spans} />
		<Kids node={node} />
	</span>
);

const Overlay: R = ({ node }) => {
	const p = node.p;
	const anchor = typeof p.anchor === "string" ? p.anchor : "center";
	return (
		<div className={`overlay-wrap anchor-${anchor} ${p.modal === false ? "" : "modal"}`}>
			<div {...useCommon(node, `size-${p.size ?? "md"}`)}>
				{p.head ? (
					<div className="overlay-head">
						<Spans text={p.head} />
					</div>
				) : null}
				<div className="overlay-body">
					<Kids node={node} />
				</div>
			</div>
		</div>
	);
};

const Toast: R = ({ node }) => {
	const [gone, setGone] = useState(false);
	useEffect(() => {
		if (!node.p.ttl) return;
		const timer = setTimeout(() => setGone(true), node.p.ttl);
		return () => clearTimeout(timer);
	}, [node.p.ttl, node.p.text]);
	if (gone) return null;
	return (
		<div {...useCommon(node)}>
			<div className="toast-text">{node.p.text}</div>
			{node.p.sub ? <div className="toast-sub">{node.p.sub}</div> : null}
		</div>
	);
};

const EditorNode: R = ({ node }) => <Editor node={node} common={useCommon(node)} />;

// ─── Data-first kinds ────────────────────────────────────────────────────────

const Tool: R = ({ node }) => {
	const { session, sf } = useSurface();
	const common = useCommon(node);
	const p = node.p;
	const running = p.status === "running" || p.status === "pending";
	const toggle = p.collapsible
		? () => session.event({ ev: "toggle", sf, id: node.id, key: p.key, collapsed: !p.collapsed })
		: undefined;
	const bodyClamp =
		p.collapsed && p.preview && typeof p.preview === "object"
			? "lines" in p.preview
				? { maxHeight: `${p.preview.lines * 1.45}em`, overflow: "hidden" }
				: {
						maxHeight: `${p.preview.tail * 1.45}em`,
						overflow: "hidden",
						display: "flex",
						flexDirection: "column-reverse" as const,
					}
			: undefined;
	const hideBody = p.collapsed && (!p.preview || p.preview === "none");
	return (
		<div {...common} className={`${common.className} frame-${p.frame ?? "card"} status-${p.status}`}>
			<div className="tool-head" onClick={toggle} title={p.intent} data-toggle={toggle ? "" : undefined}>
				<StatusMark status={p.status} />
				<Icon name={p.name} size={13} />
				<span className="tool-title">
					<Spans text={p.title} />
				</span>
				{p.target !== undefined ? (
					<span
						className={`tool-target target-${p.targetKind ?? "text"} ${p.href ? "linked" : ""}`}
						title={p.href ? "Open file" : undefined}
						onClick={
							typeof p.href === "string" && p.href.startsWith("file://")
								? event => {
										event.stopPropagation();
										session.openHref(p.href);
									}
								: undefined
						}
					>
						<Spans text={p.target} />
					</span>
				) : null}
				{(p.meta ?? []).map((fact: unknown, i: number) => (
					<span key={i} className="tool-meta">
						<Spans text={fact} />
					</span>
				))}
				{(p.badges ?? []).map((badge: any, i: number) => (
					<span key={i} className={`k-badge tone-${badge.tone ?? "neutral"}`} title={badge.title}>
						{badge.text}
					</span>
				))}
				{p.note ? (
					<span className="tool-note">
						<Spans text={p.note} />
					</span>
				) : null}
				{typeof p.exit === "number" && p.exit !== 0 ? (
					<span className="k-badge tone-error">exit {p.exit}</span>
				) : null}
				<span className="tool-time">
					{running && typeof p.age === "number" ? (
						<Elapsed age={p.age} />
					) : typeof p.took === "number" ? (
						formatMs(p.took)
					) : null}
				</span>
				{p.collapsible ? <Icon name={p.collapsed ? "chevron-right" : "chevron-down"} size={12} /> : null}
			</div>
			{hideBody || node.c.length === 0 ? null : (
				<div className="tool-body" style={bodyClamp}>
					<Kids node={node} />
				</div>
			)}
		</div>
	);
};

const CHECK_ICON: Record<string, string> = {
	pending: "circle",
	active: "circle-dot",
	done: "circle-check",
	dropped: "circle-x",
	blocked: "circle-alert",
};

const Checklist: R = ({ node }) => {
	const p = node.p;
	const phases: any[] = p.phases ?? [];
	const items = phases.flatMap(phase => phase.items ?? []);
	const done = items.filter(item => item.status === "done").length;
	if (p.mode === "hud") {
		const active = items.find(item => item.status === "active");
		return (
			<div {...useCommon(node, "hud")}>
				<Icon name="list-todo" size={13} />
				<span className="s-strong">
					{done}/{items.length}
				</span>
				{active ? (
					<span className="checklist-active">
						<Spans text={active.text} />
					</span>
				) : null}
			</div>
		);
	}
	return (
		<div {...useCommon(node, p.mode ?? "full")}>
			{p.note ? (
				<div className="s-dim">
					<Spans text={p.note} />
				</div>
			) : null}
			{phases.map(phase => (
				<div key={phase.id} className="phase">
					{phases.length > 1 || phase.title ? (
						<div className="phase-title">
							<Spans text={phase.title} />
						</div>
					) : null}
					{phase.collapsed
						? null
						: (phase.items ?? []).map((item: any) => (
								<div key={item.id} className={`check-item check-${item.status}`}>
									<Icon name={CHECK_ICON[item.status] ?? "circle"} size={13} />
									<span>
										<Spans text={item.text} />
										{item.note ? (
											<span className="check-note">
												{" "}
												<Spans text={item.note} />
											</span>
										) : null}
									</span>
								</div>
							))}
				</div>
			))}
		</div>
	);
};

function formatTokens(n: number | undefined): string | undefined {
	if (n === undefined) return undefined;
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

const AGENT_TONE: Record<string, string> = {
	running: "accent",
	pending: "muted",
	done: "success",
	failed: "error",
	aborted: "warning",
	idle: "muted",
	parked: "muted",
};

const Agent: R = ({ node }) => {
	const { session, sf } = useSurface();
	const common = useCommon(node);
	const p = node.p;
	const stats = p.stats ?? {};
	const running = p.status === "running";
	const toggle = p.collapsible
		? () => session.event({ ev: "toggle", sf, id: node.id, key: p.key, collapsed: !p.collapsed })
		: undefined;
	return (
		<div
			{...common}
			className={`${common.className} agent-${p.status}`}
			style={{ ...common.style, marginLeft: p.depth ? p.depth * 14 : undefined }}
		>
			<div className="agent-head" onClick={toggle}>
				<StatusMark status={running ? "running" : p.status === "failed" ? "error" : p.status} />
				<span className="agent-name">{p.name}</span>
				{p.agent ? <span className="k-badge tone-accent">{p.agent}</span> : null}
				{(p.badges ?? []).map((badge: any, i: number) => (
					<span key={i} className={`k-badge tone-${badge.tone ?? "neutral"}`}>
						{badge.text}
					</span>
				))}
				<span className={`agent-status tone-${AGENT_TONE[p.status] ?? "muted"}`}>{p.status}</span>
				{p.model ? <span className="agent-model">{p.model}</span> : null}
			</div>
			{p.task ? (
				<div className="agent-task">
					<Spans text={p.task} />
				</div>
			) : null}
			{p.tool ? (
				<div className="agent-tool">
					<Icon name={p.tool.name} size={12} />
					<span className="s-strong">{p.tool.name}</span>
					{p.tool.intent ? (
						<span className="s-dim">
							<Spans text={p.tool.intent} />
						</span>
					) : null}
					{typeof p.tool.age === "number" ? (
						<span className="s-dim">
							<Elapsed age={p.tool.age} />
						</span>
					) : null}
				</div>
			) : null}
			<div className="agent-stats">
				{stats.tools !== undefined ? <span>{stats.tools} tools</span> : null}
				{stats.requests !== undefined ? <span>{stats.requests} req</span> : null}
				{stats.tokens !== undefined ? <span>{formatTokens(stats.tokens)} tok</span> : null}
				{stats.contextLabel ? <span>ctx {stats.contextLabel}</span> : null}
				{typeof stats.cost === "number" ? <span>${stats.cost.toFixed(stats.cost < 1 ? 3 : 2)}</span> : null}
				{running && typeof stats.age === "number" ? (
					<span>
						<Elapsed age={stats.age} />
					</span>
				) : typeof stats.took === "number" ? (
					<span>{formatMs(stats.took)}</span>
				) : null}
				{running && typeof stats.done === "number" ? (
					<span className="bar agent-done">
						<span className="fill" style={{ width: `${Math.round(stats.done * 100)}%` }} />
					</span>
				) : null}
			</div>
			{p.retry ? (
				<div className="agent-retry tone-warning">
					retry {p.retry.attempt}/{p.retry.max}
					{p.retry.error ? ` · ${p.retry.error}` : ""}
				</div>
			) : null}
			{p.collapsed || node.c.length === 0 ? null : (
				<div className="agent-body">
					<Kids node={node} />
				</div>
			)}
		</div>
	);
};

const Effort: R = ({ node }) => {
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const index = levels.indexOf(node.p.level);
	const fraction = index <= 0 ? 0 : index / (levels.length - 1);
	const r = 6;
	const c = 2 * Math.PI * r;
	return (
		<span {...useCommon(node)} title={node.p.title ?? `effort ${node.p.level}`}>
			<svg width="16" height="16" viewBox="0 0 16 16">
				<circle
					cx="8"
					cy="8"
					r={r}
					fill="none"
					stroke="var(--border)"
					strokeWidth="2"
					strokeDasharray={index < 0 ? "2 2" : undefined}
				/>
				<circle
					cx="8"
					cy="8"
					r={r}
					fill="none"
					stroke={node.p.level === "max" ? "var(--warning)" : "var(--accent)"}
					strokeWidth="2"
					strokeDasharray={`${c * fraction} ${c}`}
					transform="rotate(-90 8 8)"
				/>
			</svg>
		</span>
	);
};

const Meter: R = ({ node }) => {
	const p = node.p;
	const value: number | null = p.value;
	const tone =
		value !== null && p.thresholds?.bad !== undefined && value >= p.thresholds.bad
			? "error"
			: value !== null && p.thresholds?.warn !== undefined && value >= p.thresholds.warn
				? "warning"
				: "accent";
	if (p.style === "ring") {
		const r = 7;
		const c = 2 * Math.PI * r;
		return (
			<span {...useCommon(node)}>
				<svg width="18" height="18" viewBox="0 0 18 18">
					<circle cx="9" cy="9" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
					<circle
						cx="9"
						cy="9"
						r={r}
						fill="none"
						stroke={`var(--${tone})`}
						strokeWidth="2.5"
						strokeDasharray={`${c * (value ?? 0)} ${c}`}
						transform="rotate(-90 9 9)"
					/>
				</svg>
				{p.label ? (
					<span className="meter-label">
						<Spans text={p.label} />
					</span>
				) : null}
			</span>
		);
	}
	return (
		<span {...useCommon(node)}>
			<span className={`bar tone-${tone}`}>
				{p.parts?.length ? (
					p.parts.map((part: any, i: number) => (
						<span
							key={i}
							className="fill"
							style={{
								width: `${part.value * 100}%`,
								background: part.token ? `var(--p-${part.token})` : undefined,
							}}
							title={part.label}
						/>
					))
				) : (
					<span className="fill" style={{ width: `${(value ?? 0) * 100}%` }} />
				)}
				{(p.marks ?? []).map((mark: any, i: number) => (
					<span key={`m${i}`} className="meter-mark" style={{ left: `${mark.at * 100}%` }} title={mark.title} />
				))}
			</span>
			{p.label ? (
				<span className="meter-label">
					<Spans text={p.label} />
					{p.total ? (
						<span className="s-dim">
							{" "}
							/ <Spans text={p.total} />
						</span>
					) : null}
				</span>
			) : null}
		</span>
	);
};

const Chart: R = ({ node }) => {
	const p = node.p;
	if (p.kind === "heatmap") {
		const cells: (number | null)[][] = p.cells ?? [];
		return (
			<div {...useCommon(node, "heatmap")}>
				{cells.map((row, r) => (
					<div key={r} className="heat-row">
						{row.map((cell, c) => (
							<span
								key={c}
								className="heat-cell"
								title={p.tips?.[r]?.[c] ?? undefined}
								style={{ opacity: cell === null ? 0.08 : 0.15 + cell * 0.85 }}
							/>
						))}
					</div>
				))}
				{p.summary ? (
					<div className="s-dim">
						<Spans text={p.summary} />
					</div>
				) : null}
			</div>
		);
	}
	const series: any[] = p.series ?? [];
	const max = p.max ?? Math.max(1, ...series.map(s => s.value), ...(p.marks ?? []).map((m: any) => m.value));
	const min = p.min ?? 0;
	const h = p.size === "lg" ? 80 : p.size === "sm" ? 24 : 44;
	const w = Math.max(60, series.length * 8);
	const y = (v: number) => h - ((v - min) / (max - min || 1)) * h;
	return (
		<div {...useCommon(node)}>
			<svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
				{p.kind === "spark" ? (
					<polyline
						fill="none"
						stroke={`var(--p-${p.token ?? "accent"}, var(--accent))`}
						strokeWidth="1.5"
						points={series.map((s, i) => `${(i / Math.max(1, series.length - 1)) * w},${y(s.value)}`).join(" ")}
					/>
				) : (
					series.map((s, i) => (
						<rect
							key={i}
							x={i * (w / series.length) + 1}
							y={y(s.value)}
							width={w / series.length - 2}
							height={h - y(s.value)}
							fill={s.tone ? `var(--${s.tone})` : `var(--p-${p.token ?? "accent"}, var(--accent))`}
						>
							<title>{s.title ?? `${s.label ?? ""} ${s.value}`}</title>
						</rect>
					))
				)}
				{(p.marks ?? []).map((mark: any, i: number) => (
					<line
						key={i}
						x1="0"
						x2={w}
						y1={y(mark.value)}
						y2={y(mark.value)}
						stroke="var(--warning)"
						strokeDasharray="3 3"
					/>
				))}
			</svg>
			{p.summary ? (
				<div className="s-dim">
					<Spans text={p.summary} />
				</div>
			) : null}
		</div>
	);
};

const Picker: R = ({ node }) => {
	const { session, sf } = useSurface();
	const p = node.p;
	const items = useMemo(() => {
		const map = new Map<string, any>();
		for (const item of p.items ?? []) map.set(item.id, item);
		for (const item of p.itemsAdd ?? []) map.set(item.id, item);
		for (const id of p.itemsDel ?? []) map.delete(id);
		return map;
	}, [p.items, p.itemsAdd, p.itemsDel]);
	const order: (string | any)[] = p.order ?? [...items.keys()];
	const columns: any[] = p.columns ?? [];
	const ev = (type: "select" | "activate", item: string) => () => session.event({ ev: type, sf, id: node.id, item });
	const query: string | null | undefined = p.query;
	const caret = typeof p.cursor === "number" ? p.cursor : (query ?? "").length;
	return (
		<div {...useCommon(node, `size-${p.size ?? "md"} layout-${p.layout ?? "rows"}`)}>
			<div className="picker-head">
				{p.icon ? <Icon name={p.icon} size={15} /> : null}
				{p.title ? <span className="picker-title">{p.title}</span> : null}
				{p.subtitle ? (
					<span className="s-dim">
						<Spans text={p.subtitle} />
					</span>
				) : null}
				{query !== null ? (
					<span className="picker-query">
						<Icon name="search" size={13} />
						{query ? (
							<span>
								{query.slice(0, caret)}
								<span className="caret" />
								{query.slice(caret)}
							</span>
						) : (
							<span className="s-dim">
								{p.placeholder ?? "Search"}
								<span className="caret" />
							</span>
						)}
					</span>
				) : null}
				{typeof p.total === "number" ? (
					<span className="s-dim picker-count">
						{items.size === p.total
							? p.total
							: `${order.filter(x => typeof x === "string").length} of ${p.total}`}
					</span>
				) : null}
			</div>
			{p.tabs?.length ? (
				<div className="k-tabs">
					{p.tabs.map((tab: any) => (
						<button
							type="button"
							key={tab.id}
							className={`tab ${tab.id === p.tab ? "active" : ""}`}
							onClick={() => session.event({ ev: "action", sf, id: node.id, act: "tab", value: tab.id })}
						>
							<Spans text={tab.label} />
							{tab.count !== undefined ? <span className="s-dim"> {tab.count}</span> : null}
						</button>
					))}
				</div>
			) : null}
			<div className={`picker-main preview-${p.preview ?? "none"}`}>
				{p.scopes?.length ? (
					<div className="picker-scopes">
						{p.scopes.map((scope: any) => (
							<div
								key={scope.id}
								className={`picker-scope ${scope.id === p.scope ? "active" : ""}`}
								onClick={() => session.event({ ev: "action", sf, id: node.id, act: "scope", value: scope.id })}
							>
								{scope.dot ? <span className={`dot tone-${scope.dot}`} /> : null}
								<Spans text={scope.label} />
								{scope.count !== undefined ? <span className="s-dim"> {scope.count}</span> : null}
							</div>
						))}
					</div>
				) : null}
				<div className="picker-list">
					{p.state === "loading" ? <div className="s-dim picker-msg">Loading…</div> : null}
					{p.message ? (
						<div className="picker-msg">
							<Spans text={p.message} />
						</div>
					) : null}
					{order.length === 0 && p.empty ? (
						<div className="s-dim picker-msg">
							<Spans text={p.empty} />
						</div>
					) : null}
					{order.map((entry, i) => {
						if (typeof entry !== "string")
							return (
								<div key={`g${i}`} className="picker-group">
									<Spans text={entry.label} />
									{entry.count !== undefined ? <span className="s-dim"> {entry.count}</span> : null}
								</div>
							);
						const item = items.get(entry);
						if (!item) return null;
						const selected = entry === p.selected;
						const current = p.current?.includes(entry);
						return (
							<div
								key={entry}
								className={`picker-item ${selected ? "selected" : ""} ${current ? "current" : ""} ${item.disabled ? "disabled" : ""} tone-${item.tone ?? "none"}`}
								style={{ paddingLeft: item.depth ? 10 + item.depth * 14 : undefined }}
								onClick={ev("select", entry)}
								onDoubleClick={ev("activate", entry)}
								title={typeof item.disabled === "string" ? item.disabled : item.title}
								ref={selected ? el => el?.scrollIntoView({ block: "nearest" }) : undefined}
							>
								{item.dot ? (
									<span className={`dot tone-${item.dot}`} />
								) : item.mark ? (
									<span className="avatar">{item.mark.text.slice(0, 2)}</span>
								) : item.icon ? (
									<Icon name={item.icon} size={14} />
								) : item.role ? (
									<Icon name={item.role} size={13} />
								) : null}
								<span className={`picker-label ${item.mono ? "mono" : ""}`}>
									<Spans text={item.label} />
									{(item.chips ?? []).map((chip: any, j: number) => (
										<span key={j} className={`chip ${chip.on ? "on" : ""}`}>
											{chip.text}
										</span>
									))}
									{(item.badges ?? []).map((badge: any, j: number) => (
										<span
											key={`b${j}`}
											className={`k-badge tone-${badge.tone ?? "neutral"}`}
											title={badge.title}
										>
											{badge.text}
										</span>
									))}
								</span>
								{item.detail ? (
									<span className="picker-detail">
										<Spans text={item.detail} />
									</span>
								) : null}
								{columns.map(col => {
									const fact = item.facts?.[col.id];
									const low = typeof col.priority === "number" && col.priority <= 3 ? " low" : "";
									if (fact === undefined) return <span key={col.id} className={`picker-fact${low}`} />;
									if (col.format === "bar" && typeof fact === "number")
										return (
											<span key={col.id} className={`picker-fact${low}`}>
												<span className="bar">
													<span className="fill" style={{ width: `${fact * 100}%` }} />
												</span>
											</span>
										);
									if (col.format === "elapsed" && typeof fact === "number")
										return (
											<span key={col.id} className={`picker-fact s-dim${low}`}>
												{formatMs(fact)} ago
											</span>
										);
									return (
										<span key={col.id} className={`picker-fact ${col.format === "dim" ? "s-dim" : ""}${low}`}>
											<Spans text={fact} />
										</span>
									);
								})}
							</div>
						);
					})}
				</div>
				{node.c.length && p.preview !== "none" ? (
					<div className="picker-preview">
						<Kids node={node} />
					</div>
				) : null}
			</div>
			{p.confirm ? (
				<div className="picker-confirm">
					<Spans text={p.confirm.text} />
					<button
						type="button"
						className="btn danger"
						onClick={() => session.event({ ev: "action", sf, id: node.id, act: p.confirm.act })}
					>
						{p.confirm.label ?? "Confirm"}
					</button>
				</div>
			) : null}
			{p.actions?.length ? (
				<div className="picker-actions">
					{p.actions.map((action: any) => (
						<button
							type="button"
							key={action.id}
							disabled={Boolean(action.disabled)}
							title={typeof action.disabled === "string" ? action.disabled : undefined}
							className={`btn ${action.primary ? "primary" : ""} ${action.danger ? "danger" : ""} ${action.end ? "end" : ""} ${action.on ? "on" : ""}`}
							onClick={() => session.event({ ev: "action", sf, id: node.id, act: action.id })}
						>
							{action.label}
							{action.keys?.length ? (
								<span className="btn-keys">
									{action.keys.map((key: string) => KEY_GLYPH[key.toLowerCase()] ?? key).join("")}
								</span>
							) : null}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
};

const Prefs: R = ({ node }) => {
	const { session, sf } = useSurface();
	const p = node.p;
	const change = (item: string, value: unknown) => session.event({ ev: "change", sf, id: node.id, item, value });
	return (
		<div {...useCommon(node)}>
			<div className="prefs-head">{p.title}</div>
			<div className="prefs-main">
				<div className="prefs-pages">
					{(p.pages ?? []).map((page: any) => (
						<div
							key={page.id}
							className={`prefs-page ${page.id === p.page ? "active" : ""}`}
							onClick={() => session.event({ ev: "action", sf, id: node.id, act: "page", value: page.id })}
						>
							{page.icon ? <Icon name={page.icon} size={13} /> : null}
							{page.label}
							{page.changed ? <span className="s-accent"> •</span> : null}
						</div>
					))}
				</div>
				<div className="prefs-sections">
					{p.lead ? <div className="s-dim prefs-lead">{p.lead}</div> : null}
					{(p.sections ?? []).map((section: any) => (
						<div key={section.id} className="prefs-section">
							<div className="prefs-section-title">{section.title}</div>
							{section.rows.map((row: any) => (
								<div
									key={row.id}
									className={`prefs-row ${row.id === p.focus ? "focused" : ""}`}
									title={row.hint}
								>
									<div className="prefs-label">
										{row.label}
										{row.changed ? (
											<span className="s-accent" title={`default: ${row.defaultLabel ?? ""}`}>
												{" "}
												•
											</span>
										) : null}
										{row.hint ? <div className="s-dim prefs-hint">{row.hint}</div> : null}
									</div>
									<div className="prefs-control">
										{row.control.k === "switch" ? (
											<input
												type="checkbox"
												checked={row.control.on}
												disabled={Boolean(row.disabled)}
												onChange={event => change(row.id, event.target.checked)}
											/>
										) : row.control.k === "choice" ? (
											<select
												value={row.control.value}
												disabled={Boolean(row.disabled)}
												onChange={event => change(row.id, event.target.value)}
											>
												{row.control.options.map((option: any) => (
													<option key={option.value} value={option.value}>
														{option.label}
													</option>
												))}
											</select>
										) : row.control.k === "number" ? (
											<input
												type="number"
												value={row.control.value}
												min={row.control.min}
												max={row.control.max}
												step={row.control.step}
												onChange={event => change(row.id, Number(event.target.value))}
											/>
										) : row.control.k === "text" ? (
											<input
												type={row.control.secret ? "password" : "text"}
												defaultValue={row.control.value}
												placeholder={row.control.placeholder}
												onBlur={event => change(row.id, event.target.value)}
											/>
										) : row.control.k === "action" ? (
											<button
												type="button"
												className="btn"
												onClick={() =>
													session.event({ ev: "action", sf, id: node.id, act: row.control.act })
												}
											>
												{row.control.label}
											</button>
										) : row.control.k === "keys" ? (
											<span>
												{row.control.keys.map((combo: string[], i: number) => (
													<kbd key={i}>{combo.join("+")}</kbd>
												))}
											</span>
										) : (
											<span className="s-dim">{(row.control.values ?? []).join(", ")}</span>
										)}
									</div>
								</div>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
};

const RENDERERS: Record<string, R> = {
	col: Col,
	row: Row,
	card: Card,
	section: Section,
	rule: Rule,
	spacer: Spacer,
	text: Text,
	md: Markdown,
	code: Code,
	diff: Diff,
	ansi: Ansi,
	math: MathNode,
	image: Image,
	kv: Kv,
	table: Table,
	tree: Tree,
	badge: Badge,
	kbd: Kbd,
	icon: IconNode,
	spinner: Spinner,
	shimmer: Shimmer,
	elapsed: ElapsedNode,
	progress: Progress,
	rate: Rate,
	list: List,
	item: Item,
	tabs: Tabs,
	editor: EditorNode,
	input: EditorNode,
	status: Status,
	seg: Seg,
	overlay: Overlay,
	toast: Toast,
	rows: Rows,
	picker: Picker,
	prefs: Prefs,
	tool: Tool,
	checklist: Checklist,
	agent: Agent,
	chart: Chart,
	meter: Meter,
	effort: Effort,
};
