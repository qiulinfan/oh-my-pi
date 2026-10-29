/**
 * omp icon names → lucide icons. omp names icons semantically (`model`,
 * `chev`, `rewind`); most map straight onto a lucide name, a few need an
 * alias, and anything unknown draws a small dot rather than nothing.
 */
import { icons, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

const ALIASES: Record<string, string> = {
	model: "cpu",
	chev: "chevron-down",
	"chev-right": "chevron-right",
	"chev-down": "chevron-down",
	"chev-up": "chevron-up",
	rewind: "undo-2",
	history: "rotate-ccw",
	irc: "messages-square",
	copy: "copy",
	send: "arrow-up",
	stop: "square",
	agent: "bot",
	agents: "users",
	subagent: "bot",
	job: "loader",
	jobs: "list-checks",
	todo: "list-todo",
	file: "file-text",
	folder: "folder",
	edit: "pencil",
	read: "file-search",
	bash: "terminal",
	shell: "terminal",
	search: "search",
	grep: "search-code",
	glob: "folder-search",
	web: "globe",
	fetch: "globe",
	browser: "app-window",
	eval: "square-function",
	python: "square-function",
	task: "workflow",
	wait: "hourglass",
	think: "brain",
	thinking: "brain",
	settings: "settings",
	gear: "settings",
	close: "x",
	check: "check",
	error: "circle-alert",
	warning: "triangle-alert",
	info: "info",
	cost: "coins",
	usage: "gauge",
	context: "gauge",
	mic: "mic",
	image: "image",
	attach: "paperclip",
	branch: "git-branch",
	git: "git-branch",
	diff: "file-diff",
	link: "link",
	external: "external-link",
	plan: "map",
	goal: "target",
	memory: "brain-circuit",
	skill: "sparkles",
	mcp: "plug",
	plugin: "puzzle",
	key: "key-round",
	user: "user",
	assistant: "sparkles",
	tool: "wrench",
	download: "download",
	judge: "scale",
	lightbulb: "lightbulb",
	pending: "circle-dashed",
	restart: "rotate-cw",
	refresh: "refresh-cw",
	extension: "puzzle",
	plugins: "puzzle",
	warn: "triangle-alert",
	tools: "wrench",
	time: "clock",
	stats: "chart-column",
	throughput: "activity",
	loop: "repeat",
	fast: "zap",
	vibe: "wand-sparkles",
	export: "upload",
	broadcast: "radio-tower",
	collab: "share-2",
	advisor: "graduation-cap",
	"x-circle": "circle-x",
	done: "circle-check",
	question: "circle-question-mark",
	wave: "audio-waveform",
	voice: "mic",
	tree: "list-tree",
	swap: "arrow-left-right",
	sliders: "sliders-horizontal",
	session: "messages-square",
	message: "message-square",
	changelog: "scroll-text",
	news: "newspaper",
	rule: "book-check",
	review: "file-search",
	prewalk: "footprints",
	ink: "pen-tool",
	host: "server",
	ssh: "server",
	home: "house",
	handoff: "handshake",
	doc: "file-text",
	compress: "minimize-2",
	cart: "shopping-cart",
	"context.compaction": "minimize-2",
	"context.speculation": "telescope",
	"tab.tools": "wrench",
	"tab.tasks": "list-checks",
	"tab.shell": "terminal",
	"tab.providers": "plug",
	"tab.model": "cpu",
	"tab.memory": "brain",
	"tab.interaction": "mouse-pointer-click",
	"tab.files": "folder",
	"tab.context": "gauge",
	"tab.appearance": "palette",
};

function pascal(name: string): string {
	return name
		.split(/[-_.:\s]+/)
		.filter(Boolean)
		.map(part => part[0]!.toUpperCase() + part.slice(1))
		.join("");
}

const LOOKUP = icons as Record<string, LucideIcon>;

export function iconFor(name: string | undefined): LucideIcon | null {
	if (!name) return null;
	const base = name.startsWith("omp.tool.") ? name.slice("omp.tool.".length) : name;
	const resolved = ALIASES[base] ?? base;
	return LOOKUP[pascal(resolved)] ?? LOOKUP[pascal(base)] ?? null;
}

export function Icon({ name, size = 14, className }: { name?: string; size?: number; className?: string }): ReactNode {
	const Found = iconFor(name);
	if (!Found) return <span className={`icon-dot ${className ?? ""}`} title={name} />;
	return <Found size={size} strokeWidth={1.75} className={`icon ${className ?? ""}`} />;
}
