/** The process and terminal handles the GUI owns, independent of the host PTY. */
export interface TerminalProcess {
	pid: number;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	exited: Promise<number>;
	terminal?: {
		readonly closed: boolean;
		write(data: string): unknown;
		resize(cols: number, rows: number): void;
	};
	kill(signal?: NodeJS.Signals): void;
}

export interface TerminalProcessOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	cols: number;
	rows: number;
	data(bytes: Uint8Array): void;
	eof(): void;
}

/** POSIX uses Bun's PTY; Windows carries TSP directly over pipes. */
export async function spawnTerminalProcess(cmd: string[], options: TerminalProcessOptions): Promise<TerminalProcess> {
	if (process.platform !== "win32") {
		return Bun.spawn(cmd, {
			cwd: options.cwd,
			env: options.env,
			terminal: {
				cols: options.cols,
				rows: options.rows,
				data: (_terminal, bytes) => options.data(bytes),
				exit: terminal => {
					terminal.close();
					options.eof();
				},
			},
		});
	}
	// ConPTY interprets and drops APC messages. Pipes keep TSP bytes intact;
	// the child opts into this transport instead of treating stdin as a prompt.
	const proc = Bun.spawn(cmd, {
		cwd: options.cwd,
		env: { ...options.env, OMP_GUI_TRANSPORT: "pipe", COLUMNS: String(options.cols), LINES: String(options.rows) },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		// The child receives graceful stop requests without a Windows console.
		ipc: () => {},
	});
	let closed = false;
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		for await (const bytes of stream) options.data(bytes);
	};
	const output = Promise.all([drain(proc.stdout), drain(proc.stderr)]).finally(() => {
		closed = true;
		options.eof();
	});
	return {
		pid: proc.pid,
		get exitCode() {
			return proc.exitCode;
		},
		get signalCode() {
			return proc.signalCode;
		},
		exited: proc.exited.then(async code => {
			await output;
			return code;
		}),
		terminal: {
			get closed() {
				return closed;
			},
			write: data => proc.stdin.write(data),
			resize: (cols, rows) => {
				proc.stdin.write(`\x1b[48;${rows};${cols};${rows * 18};${cols * 8}t`);
			},
		},
		kill: signal => {
			if (signal === "SIGINT" || signal === "SIGTERM") proc.send({ ompGuiSignal: signal });
			else proc.kill(signal);
		},
	};
}
