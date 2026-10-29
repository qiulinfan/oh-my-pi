/**
 * The composer: a native textarea that mirrors omp's editor node. Typing,
 * IME composition, selection and deletion stay native and reach omp as TSP
 * `edit` events; keys omp binds itself (Enter, Tab, Esc, Up/Down at the text
 * edges, Ctrl/Alt chords) go to the pty as terminal bytes. omp echoes every
 * applied edit back as `text`/`splice` ops; `ComposerSync` (composer.ts) tells
 * an acknowledgement from omp's own change.
 *
 * While the session's socket is down, or omp has exited, the textarea is
 * read-only and the keys omp binds do nothing; edits sent into a dying socket
 * may never have reached omp.
 * A reconnect's `init` brings new stores holding omp's text: the textarea is
 * diffed against that text once more, so omp gets what it missed, unless
 * omp's text changed in the gap, which then wins. Keys and events are never
 * replayed.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { ComposerSync } from "./composer";
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
	// Its own subscription: the surface context does not change when the socket drops or omp exits.
	const live = useSyncExternalStore(
		listener => session.subscribe(listener),
		() => session.connected && !session.exited,
	);
	const ref = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const p = node.p;
	const text: string = p.text ?? "";
	const sync = useRef<ComposerSync | null>(null);
	sync.current ??= new ComposerSync(text);
	/** The store the text effect last saw: another one is a reconnect's fresh snapshot. */
	const seen = useRef(store);
	const focused = store.focus === node.id;
	const cursor = typeof p.cursor === "number" ? Math.min(p.cursor, text.length) : text.length;
	const props = useRef({ cursor, maxLines: p.maxLines as number | undefined });
	props.current = { cursor, maxLines: p.maxLines };

	/** Put omp's own text in the textarea (never mid-composition). */
	const show = (value: string) => {
		const el = ref.current;
		if (!el || composing.current || el.value === value) return;
		el.value = value;
		if (document.activeElement === el) el.setSelectionRange(props.current.cursor, props.current.cursor);
		autosize(el, props.current.maxLines);
	};

	const sendEdit = () => {
		const el = ref.current;
		if (!el || composing.current) return;
		const edit = sync.current!.edit(el.value);
		if (!edit) return;
		session.event({ ev: "edit", sf, id: node.id, ...edit, cursor: el.selectionStart });
		autosize(el, p.maxLines);
	};

	useLayoutEffect(() => {
		if (seen.current === store) {
			// omp's text changed on the same snapshot: an echo of edits sent from here, or omp's own change.
			if (sync.current!.heard(text)) show(text);
			return;
		}
		// A reconnect's `init` made new stores holding omp's own text: send what omp missed, or take omp's text
		// when it changed on its own in the gap.
		seen.current = store;
		if (sync.current!.rebase(text)) show(text);
		else sendEdit();
	}, [text, store]);

	// A cursor omp moved on its own (a forwarded Ctrl+A, say); never while edits typed here are in flight.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || composing.current || !sync.current!.settled(el.value)) return;
		if (document.activeElement === el && el.selectionStart === el.selectionEnd) el.setSelectionRange(cursor, cursor);
	}, [cursor]);

	useLayoutEffect(() => {
		if (ref.current) autosize(ref.current, p.maxLines);
	}, [p.maxLines]);

	useEffect(() => {
		if (focused && !p.readonly) ref.current?.focus({ preventScroll: true });
	}, [focused, store.focusVersion, p.readonly]);

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
		// While the socket is down or omp has exited the key cannot reach omp: it does nothing, and the record of
		// the edits in flight stays for the reconnect.
		if (!session.connected || session.exited) return;
		sendEdit();
		sync.current!.keyed();
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
				readOnly={p.readonly === true || !live}
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
