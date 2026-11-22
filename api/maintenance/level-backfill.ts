import Database from "better-sqlite3";
import { existsSync, linkSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { LEVEL_SCHEMA, migrateLevelColumns } from "../queries/level-schema";
import { readHistory } from "./level-history-source";
import { replayHistory } from "./level-history-replay";

const help = `用法：node dist/maintenance/level-backfill.js --db <原库> [--apply --output <新库>]
默认预览并输出 JSON。--apply 将完整的补算结果写入一个新的 SQLite 文件。`;

function checkOutput(path: string) {
  if (/(?:-wal|-shm|-journal)$/i.test(path))
    throw new Error("结果文件不能使用 SQLite 附属文件名");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix))
      throw new Error("输出路径已有数据库或附属文件，请选择新的文件名");
  }
}

/** Both modes work on a consistent, isolated snapshot. Publish only a closed, verified DB. */
export async function runBackfill(input: string, output?: string) {
  const sourcePath = resolve(input);
  const destination = output === undefined ? undefined : resolve(output);
  if (!statSync(sourcePath).isFile())
    throw new Error("输入必须是已存在的 SQLite 文件");
  if (destination) checkOutput(destination);
  const directory = mkdtempSync(
    join(destination ? dirname(destination) : tmpdir(), ".lucky-levels-")
  );
  const snapshot = join(directory, "snapshot.db");
  try {
    const source = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      // Online Backup API includes committed WAL frames in the snapshot.
      await source.backup(snapshot);
    } finally {
      source.close();
    }
    const db = new Database(snapshot, { fileMustExist: true });
    let result;
    try {
      if (
        !(db.pragma("table_info(users)") as { name: string }[]).some(
          c => c.name === "linuxdo_id"
        )
      )
        throw new Error("输入库缺少本站 users.linuxdo_id，请核对数据库路径");
      db.pragma("journal_mode = DELETE");
      db.pragma("foreign_keys = ON");
      result = db.transaction(() => {
        db.exec(LEVEL_SCHEMA);
        migrateLevelColumns(db);
        const { events, warnings } = readHistory(db);
        if (warnings.length) return { ready: false, warnings } as const;
        const report = replayHistory(db, events, Boolean(destination));
        if (destination) {
          for (const table of [
            "level_profiles",
            "experience_events",
            "level_badges",
          ]) {
            if ((db.pragma(`foreign_key_check(${table})`) as unknown[]).length)
              throw new Error("等级数据外键校验失败：" + table);
          }
        }
        return { ready: true, report } as const;
      })();
      if (db.pragma("quick_check", { simple: true }) !== "ok")
        throw new Error("SQLite quick_check 失败");
    } finally {
      db.close();
    }
    if (destination && result.ready) {
      // Same filesystem. link() refuses an existing destination, even in a race.
      checkOutput(destination);
      linkSync(snapshot, destination);
    }
    return {
      mode: destination ? "apply-to-copy" : "preview",
      input: sourcePath,
      output: result.ready ? (destination ?? null) : null,
      ...result,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      output: { type: "string" },
      apply: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  if (!values.db || Boolean(values.apply) !== Boolean(values.output))
    throw new Error(help);
  const result = await runBackfill(values.db, values.output);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
