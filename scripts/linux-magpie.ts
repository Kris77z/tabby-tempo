import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxBridge = "/run/agentfuel-magpie";
/** Separate network namespace: only configured loopback peers are reachable through private Unix sockets. */
export function linuxMagpieScript(port: number, peers: number[]) {
  if (![port, ...peers].every(value => Number.isSafeInteger(value) && value > 0 && value < 65536) || peers.includes(port)) throw new Error("MAGPIE_LINUX_PORT_INVALID");
  const proxies = [...new Set(peers)].map(peer => `/usr/bin/socat TCP4-LISTEN:${peer},bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:${sandboxBridge}/peer-${peer}.sock &\npids="$pids $!"`);
  return `#!/bin/sh
set -eu
pids=""
cleanup() { for pid in $pids; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
${proxies.join("\n")}
/usr/bin/socat UNIX-LISTEN:${sandboxBridge}/gateway.sock,fork,mode=0600 TCP4:127.0.0.1:${port} &
pids="$pids $!"
/magpie serve &
pids="$pids $!"
wait "$!"
`;
}

function forward(server: Server, sockets: Set<Socket>, destination: () => Socket) {
  server.on("connection", source => {
    const target = destination(); sockets.add(source); sockets.add(target);
    source.on("error", () => target.destroy()); target.on("error", () => source.destroy());
    source.on("close", () => { sockets.delete(source); target.destroy(); });
    target.on("close", () => { sockets.delete(target); source.destroy(); });
    source.pipe(target); target.pipe(source);
  });
}

export async function startLinuxMagpie(options: { binary: string; state: string; port: number; peers: number[]; env: NodeJS.ProcessEnv }) {
  // Neither an absent sandbox tool nor a disabled user/network namespace can fall back to host execution.
  for (const binary of ["/usr/bin/bwrap", "/usr/bin/socat"]) if (!(await stat(binary).catch(() => undefined))?.isFile()) throw new Error("MAGPIE_LINUX_SANDBOX_DEPENDENCY_REQUIRED");
  const script = linuxMagpieScript(options.port, options.peers);
  const temporary = await mkdtemp(join(tmpdir(), "af-magpie-linux-"));
  const servers: Server[] = [], sockets = new Set<Socket>(); let child: ChildProcess | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise<void>(done => { if (server.listening) server.close(() => done()); else done(); })));
    await rm(temporary, { recursive: true, force: true });
  })();
  try {
    for (const peer of [...new Set(options.peers)]) {
      const server = createServer(); servers.push(server);
      forward(server, sockets, () => createConnection({ host: "127.0.0.1", port: peer }));
      const socket = join(temporary, `peer-${peer}.sock`); server.listen(socket); await once(server, "listening"); await chmod(socket, 0o600);
    }
    const gateway = createServer(); servers.push(gateway);
    forward(gateway, sockets, () => createConnection(join(temporary, "gateway.sock")));
    gateway.listen(options.port, "127.0.0.1"); await once(gateway, "listening");
    await writeFile(join(temporary, "launch.sh"), script, { mode: 0o500, flag: "wx" });
    const args = ["--die-with-parent", "--new-session", "--unshare-all", "--ro-bind", "/usr", "/usr"];
    for (const path of ["/bin", "/lib", "/lib64"]) if (await stat(path).catch(() => undefined)) args.push("--ro-bind", path, path);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", options.state, options.state,
      "--bind", temporary, sandboxBridge, "--ro-bind", options.binary, "/magpie", "--chdir", options.state,
      "--", "/bin/sh", `${sandboxBridge}/launch.sh`);
    child = spawn("/usr/bin/bwrap", args, { cwd: options.state, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    // Keep shutdown order explicit: callers stop the sandbox before deleting its socket bridges.
    return { child, close };
  } catch (error) { if (child?.pid) child.kill("SIGKILL"); await close(); throw error; }
}
