/**
 * The model and thinking-effort menus. The start page sets them for the session it starts; a running
 * session's composer draws them in place of omp's own model chip and sends the pick back to omp.
 */
import { createContext, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

/** Closes a popover when the pointer goes down outside `ref`. */
export function useDismiss(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!ref.current?.contains(event.target as Node)) close();
		};
		addEventListener("mousedown", onDown);
		return () => removeEventListener("mousedown", onDown);
	}, [ref, open, close]);
}

export interface ModelChoice {
	selector: string;
	name: string;
	provider: string;
	/** What `--thinking` can set on the model, in the order omp's `/effort` picker offers it; empty when it does not think. */
	thinkingSelectors: string[];
	/** The level a session on it starts at when nothing names one; null when it does not think. */
	thinkingStart: string | null;
}

export interface ModelList {
	models: ModelChoice[];
	/** omp's `default` model role, e.g. "anthropic/claude-opus-5-5:high". */
	default: string | null;
}

/** Every `--thinking` value omp accepts: the choices for a model the page cannot look up. */
const ALL_THINKING = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The model a selector names: the exact selector, else one ending in `:<level>` (a level is never part of an id). */
export function findModel(selector: string, list: ModelList): { choice: ModelChoice; level?: string } | undefined {
	const exact = list.models.find(entry => entry.selector === selector);
	if (exact) return { choice: exact };
	const at = selector.lastIndexOf(":");
	const level = selector.slice(at + 1);
	if (at < 0 || !ALL_THINKING.includes(level)) return undefined;
	const choice = list.models.find(entry => entry.selector === selector.slice(0, at));
	return choice && { choice, level };
}

/**
 * The thinking choices for a new session with the model picker at `model` ("" for omp's default), and
 * the level it starts at when none is picked. A model the page cannot look up (the list has not loaded,
 * the default role is an alias) gets every level: omp checks and clamps what it is given.
 */
export function thinkingFor(
	model: string,
	list: ModelList | null,
): { choices: string[]; start: string | null; known: boolean } {
	const found = list ? findModel(model || list.default || "", list) : undefined;
	if (!found) return { choices: ALL_THINKING, start: null, known: false };
	// The default role's own `:level` is where a session on it starts.
	return {
		choices: found.choice.thinkingSelectors,
		start: (!model && found.level) || found.choice.thinkingStart,
		known: true,
	};
}

function effortLabel(level: string): string {
	return level === "auto" ? "Auto · adaptive" : level;
}

export interface Choice {
	value: string;
	text: string;
	meta?: string;
	title?: string;
}

/**
 * A start-page chip that opens a menu of choices. Opening puts focus on the current choice, so the
 * arrows, Enter and Escape work at once; `lead` choices sit above a separator.
 */
export function ChoicePicker({
	icon,
	label,
	title,
	menuLabel,
	value,
	lead = [],
	choices,
	onPick,
}: {
	icon: string;
	label: string;
	title: string;
	menuLabel: string;
	value: string;
	lead?: Choice[];
	choices: Choice[];
	onPick: (value: string) => void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	useDismiss(
		ref,
		open,
		useCallback(() => setOpen(false), []),
	);
	useEffect(() => {
		if (open) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
	}, [open]);
	const close = () => {
		setOpen(false);
		trigger.current?.focus();
	};
	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			close();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
		const at = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === "ArrowDown" ? at + 1 : at - 1;
		items[(next + items.length) % items.length]?.focus();
	};
	const item = (choice: Choice) => (
		<button
			key={choice.value || "default"}
			type="button"
			role="menuitemradio"
			aria-checked={choice.value === value}
			className={`picker-item ${choice.value === value ? "on" : ""}`}
			title={choice.title}
			onClick={() => {
				close();
				onPick(choice.value);
			}}
		>
			<span className="side-label">{choice.text}</span>
			{choice.meta ? <span className="side-meta">{choice.meta}</span> : null}
		</button>
	);
	return (
		<div className="picker effort-picker" ref={ref}>
			<button
				ref={trigger}
				type="button"
				className="field-chip project"
				aria-haspopup="menu"
				aria-expanded={open}
				title={title}
				onClick={() => setOpen(current => !current)}
			>
				<Icon name={icon} size={14} />
				<span className="chip-label">{label}</span>
				<Icon name="chev-down" size={12} />
			</button>
			{open ? (
				<div className="picker-menu" role="menu" aria-label={menuLabel} ref={menu} onKeyDown={onKeyDown}>
					{lead.map(item)}
					{lead.length ? <div className="picker-sep" /> : null}
					{choices.map(item)}
				</div>
			) : null}
		</div>
	);
}

export function EffortPicker({
	value,
	model,
	list,
	running = false,
	onPick,
}: {
	/** A `--thinking` level, or "" for the default. */
	value: string;
	model: string;
	list: ModelList | null;
	/** A running session's level, which has no default to fall back to. */
	running?: boolean;
	onPick: (value: string) => void;
}): ReactNode {
	const { choices, start, known } = thinkingFor(model, list);
	if (known && choices.length === 0) {
		return (
			<div className="picker effort-picker">
				<button type="button" className="field-chip project" disabled title="This model does not think">
					<Icon name="brain" size={14} />
					<span className="chip-label">No thinking</span>
				</button>
			</div>
		);
	}
	const fallback = start ? `Default · ${effortLabel(start)}` : "Default";
	return (
		<ChoicePicker
			icon="brain"
			label={value ? effortLabel(value) : fallback}
			title={`Thinking effort for ${running ? "this" : "the new"} session. Auto picks a level for each message by how hard it looks.`}
			menuLabel="Thinking effort"
			value={value}
			lead={running ? [] : [{ value: "", text: fallback, meta: "default" }]}
			choices={choices.map(level => ({
				value: level,
				text: effortLabel(level),
				title: level === "auto" ? "Picks a level for each message by how hard it looks" : undefined,
			}))}
			onPick={onPick}
		/>
	);
}

/** A selector's model name; a `:level` suffix shows in the effort picker instead. */
export function modelName(selector: string, list: ModelList | null): string {
	const found = list ? findModel(selector, list) : undefined;
	return found?.choice.name ?? selector.split("/").pop()!;
}

export function ModelPicker({
	value,
	list,
	running = false,
	unsetLabel,
	onPick,
}: {
	/** A model selector, or "" for omp's default. */
	value: string;
	list: ModelList | null;
	/** A running session's model: a pick switches it for this session only, and there is no default entry. */
	running?: boolean;
	/** What "" stands for, in place of omp's default model (a model role left unset). */
	unsetLabel?: string;
	onPick: (value: string) => void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const ref = useRef<HTMLDivElement>(null);
	useDismiss(
		ref,
		open,
		useCallback(() => setOpen(false), []),
	);
	const pick = (selector: string) => {
		setOpen(false);
		setQuery("");
		onPick(selector);
	};
	const needle = query.trim().toLowerCase();
	const matches = (list?.models ?? []).filter(
		model => !needle || model.name.toLowerCase().includes(needle) || model.selector.toLowerCase().includes(needle),
	);
	const providers = [...new Set(matches.map(model => model.provider))];
	const fallback = unsetLabel ?? (list?.default ? modelName(list.default, list) : "omp's default");
	return (
		<div className="picker model-picker" ref={ref}>
			<button
				type="button"
				className="field-chip project"
				title={
					running
						? `${value} · switch for this session`
						: value || `Default model: ${list?.default ?? "omp's default"}`
				}
				onClick={() => setOpen(current => !current)}
			>
				<Icon name="cpu" size={14} />
				<span className="chip-label">{value ? modelName(value, list) : fallback}</span>
				<Icon name="chev-down" size={12} />
			</button>
			{open ? (
				<div className="picker-menu">
					<input
						className="picker-search"
						autoFocus
						value={query}
						placeholder="Search models"
						spellCheck={false}
						onChange={event => setQuery(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Escape") setOpen(false);
							if (event.key === "Enter" && matches[0]) pick(matches[0].selector);
						}}
					/>
					{needle || running ? null : (
						<>
							<div className={`picker-item ${value ? "" : "on"}`} onClick={() => pick("")}>
								<Icon name="sparkles" size={14} />
								<span className="side-label">{fallback}</span>
								<span className="side-meta">default</span>
							</div>
							<div className="picker-sep" />
						</>
					)}
					<div className="picker-scroll">
						{list === null ? <div className="side-empty">Loading models…</div> : null}
						{list && matches.length === 0 ? <div className="side-empty">No model matches</div> : null}
						{providers.map(provider => (
							<div key={provider}>
								<div className="picker-group">{provider}</div>
								{matches
									.filter(model => model.provider === provider)
									.map(model => (
										<div
											key={model.selector}
											className={`picker-item ${model.selector === value ? "on" : ""}`}
											title={model.selector}
											onClick={() => pick(model.selector)}
										>
											<span className="side-label">{model.name}</span>
										</div>
									))}
							</div>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

/** The models `omp gui` can start or switch to; null until the list loads. */
export const ModelListContext = createContext<ModelList | null>(null);
