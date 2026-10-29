import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { postmortem, setTerminalHeadless } from "@oh-my-pi/pi-utils";

// On Windows omp cannot send itself SIGHUP. When its terminal went away there (stdin
// ended: an SSH session or the console host gone), it used to quit, which records a
// normal exit, so the session saved a reply it cut off as one the user stopped instead
// of the interrupted turn `omp --restore` goes on with. The disconnect has to take the
// hangup teardown, as the real SIGHUP does on POSIX.

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const stdinIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdinSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	delete (target as Record<string, unknown>)[key];
}

describe("ProcessTerminal disconnect on Windows", () => {
	let previousHeadless: boolean;

	beforeEach(() => {
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
		vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreProperty(process.stdin, "isTTY", stdinIsTtyDescriptor);
		restoreProperty(process.stdout, "isTTY", stdoutIsTtyDescriptor);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawModeDescriptor);
		setTerminalHeadless(previousHeadless);
		restoreProperty(process, "platform", platformDescriptor);
	});

	it("runs the SIGHUP teardown when stdin ends, not a normal quit", () => {
		// The SIGHUP listeners are postmortem's hangup teardown, which ends this process.
		const hangups: unknown[] = [];
		const emit = process.emit.bind(process) as (event: string | symbol, ...args: unknown[]) => boolean;
		vi.spyOn(process, "emit").mockImplementation(((event: string | symbol, ...args: unknown[]) => {
			if (event !== "SIGHUP") return emit(event, ...args);
			hangups.push(args[0]);
			return true;
		}) as typeof process.emit);
		const quit = vi.spyOn(postmortem, "quit").mockResolvedValue();

		const terminal = new ProcessTerminal();
		terminal.start(
			() => {},
			() => {},
			() => terminal.stop(), // what the app wires as onDisconnect
		);
		process.stdin.emit("end");

		expect(hangups).toEqual(["SIGHUP"]);
		expect(quit).not.toHaveBeenCalled();
	});
});
