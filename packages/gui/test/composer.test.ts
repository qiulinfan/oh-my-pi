/**
 * The composer across a reconnect to a live session on the same server boot.
 * Edits sent into a socket that was dying may never reach omp, and echoes of
 * edits that did may never come back. After the reconnect's snapshot omp must
 * hold the textarea's text with every edit applied exactly once, unless omp
 * changed its text on its own in the gap (a message it sent), which wins.
 */
import { describe, expect, test } from "bun:test";
import { ComposerSync, type TextEdit } from "../src/composer";

/** omp's editor node: applies an edit as omp's editor does, dropping a stale one (made against another length). */
class Omp {
	text = "";
	/** Every edit that reached omp, applied or not. */
	readonly received: TextEdit[] = [];

	apply(edit: TextEdit): void {
		this.received.push(edit);
		if (edit.len !== this.text.length) return;
		this.text = this.text.slice(0, edit.from) + edit.text + this.text.slice(edit.to);
	}
}

/** The textarea and its sync, wired as the Editor wires them, over a link that can lose either direction. */
class Composer {
	readonly omp = new Omp();
	readonly sync = new ComposerSync("");
	value = "";

	/** Type `value` one character at a time; `link` says whether each edit reaches omp and its echo comes back. */
	type(value: string, link: { sent: boolean; echoed: boolean }): void {
		for (let n = 1; n <= value.length; n++) {
			this.value += value[n - 1];
			const edit = this.sync.edit(this.value);
			if (!edit || !link.sent) continue;
			this.omp.apply(edit);
			if (link.echoed && this.sync.heard(this.omp.text)) this.value = this.omp.text;
		}
	}

	/** A key omp binds itself (Enter) goes to the pty: omp sends its text, and clears it. */
	submit(): string {
		this.sync.keyed();
		const sent = this.omp.text;
		this.omp.text = "";
		return sent;
	}

	/** A key omp binds itself that leaves its text alone (Ctrl+A moves omp's cursor) goes to the pty. */
	press(): void {
		this.sync.keyed();
	}

	/** The reconnect's `init` shows omp's text; returns the edits sent because of it. */
	reconnect(): TextEdit[] {
		const before = this.omp.received.length;
		if (this.sync.rebase(this.omp.text)) this.value = this.omp.text;
		else {
			const edit = this.sync.edit(this.value);
			if (edit) this.omp.apply(edit);
		}
		return this.omp.received.slice(before);
	}
}

describe("the composer after a reconnect to a live session", () => {
	test("edits that never reached omp are sent once", () => {
		const composer = new Composer();
		composer.type("hello", { sent: true, echoed: true });
		composer.type(" world", { sent: false, echoed: false });
		expect(composer.reconnect()).toEqual([{ from: 5, to: 5, text: " world", len: 5 }]);
		expect(composer.omp.text).toBe("hello world");
		expect(composer.value).toBe("hello world");
	});

	test("edits omp applied whose echoes were lost are not sent again", () => {
		const composer = new Composer();
		composer.type("hello", { sent: true, echoed: false });
		expect(composer.reconnect()).toEqual([]);
		expect(composer.omp.text).toBe("hello");
		expect(composer.value).toBe("hello");
	});

	test("only the edits omp missed are sent when it applied the first ones", () => {
		const composer = new Composer();
		composer.type("hel", { sent: true, echoed: true });
		composer.type("lo", { sent: true, echoed: false });
		composer.type(" world", { sent: false, echoed: false });
		expect(composer.reconnect()).toEqual([{ from: 5, to: 5, text: " world", len: 5 }]);
		expect(composer.omp.text).toBe("hello world");
	});

	test("a message omp sent before any echo of it came back is not typed again", () => {
		const composer = new Composer();
		composer.type("hello", { sent: true, echoed: false });
		// omp cleared its editor, which is the text it last showed: only the key says it may have changed.
		expect(composer.submit()).toBe("hello");
		expect(composer.reconnect()).toEqual([]);
		expect(composer.omp.text).toBe("");
		expect(composer.value).toBe("");
	});

	test("edits typed after a key that left omp's text alone are sent once", () => {
		const composer = new Composer();
		composer.type("hello", { sent: true, echoed: true });
		composer.press();
		composer.type("!", { sent: false, echoed: false });
		expect(composer.reconnect()).toEqual([{ from: 5, to: 5, text: "!", len: 5 }]);
		expect(composer.omp.text).toBe("hello!");
		expect(composer.value).toBe("hello!");
	});

	test("omp's own change in the gap wins and the sent message is not typed again", () => {
		const composer = new Composer();
		composer.type("hello", { sent: true, echoed: true });
		expect(composer.submit()).toBe("hello");
		// omp's echo of its cleared editor was lost with the socket.
		expect(composer.reconnect()).toEqual([]);
		expect(composer.value).toBe("");
		expect(composer.omp.text).toBe("");
	});
});
