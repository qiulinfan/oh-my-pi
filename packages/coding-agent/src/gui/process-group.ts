/**
 * What the stop ladder may end besides omp itself. omp runs as the session
 * leader of its terminal, so it leads a process group, and that group is what
 * a terminal would end with it (a hangup reaches the whole group). The ladder
 * never reaches further: its hard kill is a SIGKILL of that group, and once
 * omp has exited, whatever of the group still runs is a leftover and is killed.
 *
 * Every descendant is not swept: omp starts the daemons it shares with other
 * omp processes (the daemon broker, which hosts the LSP mux, the shared
 * browser and persistent `omp launch` daemons; the embedding server) as its
 * own children, detached into their own sessions so they outlive it. They,
 * and everything below them, are left alone. So is what omp starts detached
 * for its own use (bash-tool commands, eval kernels, debug adapters, MCP
 * servers on Linux): omp's own teardown ends those, and a hard kill skips that
 * teardown.
 */
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

function isEsrch(err: unknown): boolean {
	return (err as { code?: string }).code === "ESRCH";
}

/**
 * The processes below `root` in the process group it leads, as stable references (each pins its start
 * time, so a pid reused later is never taken for it). Empty when `root` does not lead its group.
 */
export function groupBelow(root: Process): Process[] {
	const group = root.groupId();
	if (group !== root.pid) return [];
	const out: Process[] = [];
	const walk = (parent: Process): void => {
		for (const child of parent.children()) {
			// A child in another group left it (detached): neither it nor anything below it is omp's to end.
			if (child.groupId() !== group) continue;
			out.push(child);
			walk(child);
		}
	};
	walk(root);
	return out;
}

/**
 * SIGKILL the process group `leader` leads: the leader and whatever is still in its group, never what
 * left the group. False, with nothing signalled, when `leader` does not lead its group, has exited, or
 * its pid names another process now (all read through the pinned reference just before the signal).
 */
export function killGroup(leader: Process): boolean {
	if (leader.groupId() !== leader.pid) return false;
	try {
		process.kill(-leader.pid, "SIGKILL");
		return true;
	} catch (err) {
		if (isEsrch(err)) return false;
		throw err;
	}
}

/** SIGKILL `target` alone when it still runs as itself (read through its pinned reference just before). */
export function killPinned(target: Process): boolean {
	if (target.status() !== ProcessStatus.Running) return false;
	try {
		process.kill(target.pid, "SIGKILL");
		return true;
	} catch (err) {
		if (isEsrch(err)) return false;
		throw err;
	}
}

/**
 * Once the leader of `group` has exited: give each process of `left` (taken from that group by
 * {@link groupBelow}) still running `graceMs` to exit (the hangup reached them with the leader's exit),
 * then SIGKILL every one still running as itself and still in the group; one that has left the group
 * since (detached) is not omp's to end.
 */
export async function killLeftovers(group: number, left: readonly Process[], graceMs: number): Promise<number> {
	const running = left.filter(leftover => leftover.status() === ProcessStatus.Running);
	if (running.length === 0) return 0;
	await Promise.all(running.map(leftover => leftover.waitForExit({ timeoutMs: graceMs })));
	let killed = 0;
	for (const leftover of running) {
		if (leftover.groupId() === group && killPinned(leftover)) killed++;
	}
	if (killed > 0) logger.warn("gui: killed what an ended omp left running in its process group", { killed });
	return killed;
}
