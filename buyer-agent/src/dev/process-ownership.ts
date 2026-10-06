import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type PortOwnership =
  | "SETRA_ACTIVE"
  | "SETRA_STALE"
  | "FOREIGN"
  | "UNKNOWN";

interface ProcessIdentity {
  pid: number;
  parentPid: number;
  name: string;
  executablePath: string | null;
  commandLine: string | null;
  startTime: string | null;
}

interface ProcessTree {
  listener: ProcessIdentity;
  ancestors: ProcessIdentity[];
}

interface OwnedChild {
  role: string;
  pid: number;
  command: string;
  startedAt: string;
}

interface OwnershipRecord {
  version: 1;
  instanceId: string;
  repositoryRoot: string;
  launcherPid: number;
  children: OwnedChild[];
}

export interface PortOwner {
  pid?: number;
  processName?: string;
  executablePath?: string;
  commandLine?: string;
  startTime?: string;
  ownership: PortOwnership;
  detail: string;
}

const ownershipDirectory = (stateDirectory: string) =>
  join(stateDirectory, "launcher");

const ownershipPath = (stateDirectory: string) =>
  join(ownershipDirectory(stateDirectory), "ownership.json");

export function createOwnershipRecord(
  stateDirectory: string,
  repositoryRoot: string
): {
  instanceId: string;
  recordChild: (child: OwnedChild) => void;
  remove: () => void;
} {
  const path = ownershipPath(stateDirectory);
  const instanceId = `${process.pid}-${Date.now()}`;
  const record: OwnershipRecord = {
    version: 1,
    instanceId,
    repositoryRoot: resolve(repositoryRoot),
    launcherPid: process.pid,
    children: [],
  };
  const write = () => {
    mkdirSync(ownershipDirectory(stateDirectory), { recursive: true });
    const temporaryPath = `${path}.${instanceId}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(record), { flag: "w" });
    renameSync(temporaryPath, path);
  };
  write();
  return {
    instanceId,
    recordChild: (child) => {
      record.children.push(child);
      write();
    },
    remove: () => {
      try {
        const current = JSON.parse(
          readFileSync(path, "utf8")
        ) as Partial<OwnershipRecord>;
        if (current.instanceId === instanceId) {
          unlinkSync(path);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function readOwnershipRecord(
  stateDirectory: string
): OwnershipRecord | undefined {
  const path = ownershipPath(stateDirectory);
  if (!existsSync(path)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as OwnershipRecord;
    if (
      record.version !== 1 ||
      typeof record.instanceId !== "string" ||
      typeof record.repositoryRoot !== "string" ||
      !Number.isInteger(record.launcherPid) ||
      !Array.isArray(record.children)
    )
      return undefined;
    return record;
  } catch {
    return undefined;
  }
}

function processTrees(port: number): ProcessTree[] {
  if (process.platform !== "win32") return [];
  const script = [
    "$ErrorActionPreference='Stop'",
    `$ids = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)`,
    "$trees = @()",
    "foreach ($listenerId in $ids) {",
    "  $chain = @()",
    "  $currentId = [int]$listenerId",
    "  for ($depth = 0; $currentId -and $depth -lt 12; $depth++) {",
    '    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId" -ErrorAction SilentlyContinue',
    "    if (-not $p) { break }",
    "    $chain += [pscustomobject]@{ pid=[int]$p.ProcessId; parentPid=[int]$p.ParentProcessId; name=$p.Name; executablePath=$p.ExecutablePath; commandLine=$p.CommandLine; startTime=if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString('o')}else{$null} }",
    "    $currentId = [int]$p.ParentProcessId",
    "  }",
    "  if ($chain.Count -gt 0) { $trees += [pscustomobject]@{ listener=$chain[0]; ancestors=@($chain | Select-Object -Skip 1) } }",
    "}",
    "ConvertTo-Json -InputObject @($trees) -Compress -Depth 5",
  ].join("; ");
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();
    if (!output) return [];
    const parsed: unknown = JSON.parse(output);
    return Array.isArray(parsed)
      ? (parsed as ProcessTree[])
      : [parsed as ProcessTree];
  } catch {
    return [];
  }
}

function normalized(value: string): string {
  return value.replaceAll("/", "\\").toLowerCase();
}

function containsPath(commandLine: string | null, path: string): boolean {
  return (
    commandLine !== null && normalized(commandLine).includes(normalized(path))
  );
}

function withinSeconds(
  actual: string | null,
  expected: string,
  seconds: number
): boolean {
  if (!actual) return false;
  const delta = Math.abs(Date.parse(actual) - Date.parse(expected));
  return Number.isFinite(delta) && delta <= seconds * 1000;
}

function classify(
  tree: ProcessTree,
  repositoryRoot: string,
  stateDirectory: string
): PortOwnership {
  const buyerDirectory = join(repositoryRoot, "buyer-agent");
  const controlPath = join(buyerDirectory, "dist", "web", "start.js");
  const launcherPath = join(buyerDirectory, "dist", "dev", "launcher.js");
  const listenerCommand = tree.listener.commandLine;
  const isSetraControl = containsPath(listenerCommand, controlPath);
  const activeLauncher = tree.ancestors.some((process) => {
    if (containsPath(process.commandLine, launcherPath)) return true;
    const commandLine = process.commandLine ?? "";
    return (
      /^node(?:\.exe)?$/i.test(process.name) &&
      /(?:^|[\\/ ])dist[\\/]dev[\\/]launcher\.js(?:\s|$)/i.test(commandLine) &&
      process.startTime !== null &&
      tree.listener.startTime !== null &&
      Date.parse(process.startTime) <= Date.parse(tree.listener.startTime)
    );
  });
  if (activeLauncher) return "SETRA_ACTIVE";
  if (!isSetraControl) {
    return listenerCommand ? "FOREIGN" : "UNKNOWN";
  }

  const record = readOwnershipRecord(stateDirectory);
  const ownedChild = record?.children.find(
    (child) =>
      child.pid === tree.listener.pid &&
      containsPath(listenerCommand, child.command)
  );
  const recordedLauncher = record
    ? tree.ancestors.find(
        (process) =>
          process.pid === record.launcherPid &&
          /(?:^|[\\/ ])launcher\.js(?:\s|$)/i.test(process.commandLine ?? "") &&
          ownedChild !== undefined &&
          process.startTime !== null &&
          Date.parse(process.startTime) <= Date.parse(ownedChild.startedAt)
      )
    : undefined;
  if (recordedLauncher) return "SETRA_ACTIVE";
  if (
    ownedChild &&
    withinSeconds(tree.listener.startTime, ownedChild.startedAt, 5)
  )
    return "SETRA_STALE";
  return "UNKNOWN";
}

export function inspectPortOwner(
  port: number,
  repositoryRoot: string,
  stateDirectory: string
): PortOwner {
  const trees = processTrees(port);
  const tree = trees[0];
  if (!tree) {
    return {
      ownership: "UNKNOWN",
      detail: "owner details unavailable; no process was touched",
    };
  }
  const ownership = classify(tree, repositoryRoot, stateDirectory);
  const listener = tree.listener;
  const processName = listener.name || "unknown process";
  const detail = {
    SETRA_ACTIVE: "another Setra environment appears active",
    SETRA_STALE: "stale Setra child verified by launcher ownership record",
    FOREIGN: "foreign process; not touched",
    UNKNOWN: "Setra ownership could not be proven; process not touched",
  }[ownership];
  return {
    pid: listener.pid,
    ...(listener.name ? { processName: listener.name } : {}),
    ...(listener.executablePath
      ? { executablePath: listener.executablePath }
      : {}),
    ...(listener.commandLine ? { commandLine: listener.commandLine } : {}),
    ...(listener.startTime ? { startTime: listener.startTime } : {}),
    ownership,
    detail: `${detail} (PID ${listener.pid}, ${processName})`,
  };
}

export function ownerAction(owner: PortOwner): string {
  switch (owner.ownership) {
    case "SETRA_ACTIVE":
      return "Use the active environment or stop its launcher with Ctrl+C; this launcher will not terminate it.";
    case "SETRA_STALE":
      return `Verified stale Setra PID ${owner.pid}; stop it manually with Stop-Process -Id ${owner.pid} after confirming the recorded identity.`;
    case "FOREIGN":
      return "Stop or reconfigure the owning application yourself; dev:setra will not terminate it.";
    case "UNKNOWN":
      return "Inspect the listener manually; dev:setra cannot prove ownership and will not terminate it.";
  }
}
