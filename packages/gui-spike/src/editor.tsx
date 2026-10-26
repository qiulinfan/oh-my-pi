/**
 * The composer: a native textarea that mirrors omp's editor node. Typing,
 * IME composition, selection and deletion stay native and reach omp as TSP
 * `edit` events (the minimal replaced range against the text the previous
 * edit produced); keys omp binds itself (Enter, Tab, Esc, Up/Down at the text
 * edges, Ctrl/Alt chords) go to the pty as terminal bytes. omp echoes every
 * applied edit back as `text`/`splice` ops. An echo of a state this textarea
 * already moved past only acknowledges that edit; any other text is omp's own
 * change (sent, cleared, history, completion) and replaces the textarea's.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { keyBytes } from "./keys";
import { Spans, useSurface } from "./render";
import type { StoreNode } from "./store";

function plain(text: unknown): string {
	if (typeof text === "string") return text;
	if (Array.isArray(text)) return text.map((span: any) => span.t).join("");
	return "";
}

export function Editor({ node, common }: { node: StoreNode; common: Record<string, any> }): ReactNode {
	const { session, store, sf } = useSurface();
	const ref = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	/** The text omp will hold once it has applied every edit sent so far; edits are computed against it. */
	const known = useRef<string>(node.p.text ?? "");
	/** Texts of the edits omp has not echoed yet, oldest first. */
	const pending = useRef<string[]>([]);
	const p = node.p;
	const text: string = p.text ?? "";
	const focused = store.focus === node.id;
	const cursor = typeof p.cursor === "number" ? Math.min(p.cursor, text.length) : text.length;
	const props = useRef({ cursor, maxLines: p.maxLines as number | undefined });
	props.current = { cursor, maxLines: p.maxLines };

	useLayoutEffect(() => {
		const acked = pending.current.indexOf(text);
		if (acked >= 0) {
			// omp caught up to an edit typed here; the textarea is already at or past it.
			pending.current.splice(0, acked + 1);
			return;
		}
		pending.current = [];
		known.current = text;
		const el = ref.current;
		if (!el || composing.current || el.value === text) return;
		el.value = text;
		if (document.activeElement === el) el.setSelectionRange(props.current.cursor, props.current.cursor);
		autosize(el, props.current.maxLines);
	}, [text]);

	// A cursor omp moved on its own (a forwarded Ctrl+A, say); never while edits typed here are in flight.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || composing.current || pending.current.length > 0 || el.value !== known.current) return;
		if (document.activeElement === el && el.selectionStart === el.selectionEnd) el.setSelectionRange(cursor, cursor);
	}, [cursor]);

	useLayoutEffect(() => {
		if (ref.current) autosize(ref.current, p.maxLines);
	}, [p.maxLines]);

	useEffect(() => {
		if (focused && !p.readonly) ref.current?.focus({ preventScroll: true });
	}, [focused, store.focusVersion, p.readonly]);

	const sendEdit = () => {
		const el = ref.current;
		if (!el || composing.current) return;
		const before = known.current;
		const after = el.value;
		if (before === after) return;
		let start = 0;
		while (start < before.length && start < after.length && before[start] === after[start]) start++;
		let endBefore = before.length;
		let endAfter = after.length;
		while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
			endBefore--;
			endAfter--;
		}
		session.event({
			ev: "edit",
			sf,
			id: node.id,
			from: start,
			to: endBefore,
			text: after.slice(start, endAfter),
			cursor: el.selectionStart,
			len: before.length,
		});
		known.current = after;
		pending.current.push(after);
		autosize(el, p.maxLines);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (composing.current || event.nativeEvent.isComposing) return;
		const el = event.currentTarget;
		const atFirstLine = !el.value.slice(0, el.selectionStart).includes("\n");
		const atLastLine = !el.value.slice(el.selectionEnd).includes("\n");
		const plainKey = !event.ctrlKey && !event.altKey && !event.metaKey;
		let forward = false;
		if (event.key === "Enter" && plainKey && !event.shiftKey) forward = true;
		else if (event.key === "Tab" || event.key === "Escape" || event.key === "PageUp" || event.key === "PageDown")
			forward = true;
		else if (event.key === "ArrowUp" && plainKey && atFirstLine) forward = true;
		else if (event.key === "ArrowDown" && plainKey && atLastLine) forward = true;
		else if ((event.ctrlKey || event.altKey) && !event.metaKey) forward = true;
		if (!forward) return;
		const bytes = keyBytes(event.nativeEvent);
		if (bytes === null) return;
		event.preventDefault();
		sendEdit();
		// The key may change the text (submit clears it, Tab completes, Up recalls history), and omp can
		// fold the echoes of the edits before it into that one change: from here omp's text wins.
		pending.current = [];
		session.keys(bytes);
	};

	return (
		<div {...common} className={`${common.className} ${focused ? "focused" : ""}`}>
			{p.prompt ? (
				<span className="editor-prompt">
					<Spans text={p.prompt} />
				</span>
			) : null}
			{p.mode ? <span className="editor-mode">{p.mode}</span> : null}
			<textarea
				ref={ref}
				defaultValue={text}
				rows={1}
				readOnly={p.readonly === true}
				spellCheck={false}
				placeholder={plain(p.placeholder)}
				className={p.lang ? "mono" : ""}
				onInput={sendEdit}
				onKeyDown={onKeyDown}
				onCompositionStart={() => {
					composing.current = true;
				}}
				onCompositionEnd={() => {
					composing.current = false;
					sendEdit();
				}}
				onFocus={() => {
					if (store.focus !== node.id) session.event({ ev: "focus", sf, id: node.id });
				}}
			/>
			{p.ghost ? <span className="editor-ghost">{p.ghost}</span> : null}
		</div>
	);
}

function autosize(el: HTMLTextAreaElement, maxLines: number | undefined): void {
	el.style.height = "auto";
	const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
	const max = (maxLines ?? 12) * line;
	el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}
