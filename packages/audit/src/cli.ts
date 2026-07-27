#!/usr/bin/env node
/**
 * `ag-verify` — the command a member of the public runs to check an exported
 * history (§16, §28).
 *
 * Usage:
 *   ag-verify <events.jsonl> [--world <id>] [--anchor <head-hash>] [--require-genesis]
 *
 * Exits 0 on success, 1 on verification failure, 2 on usage error. The exit code
 * matters: this is meant to run in someone else's CI, not just be read.
 */
import { readFile } from "node:fs/promises";
import { formatReport, parseJsonl, verifyExport, type VerifyOptions } from "./verify.js";

interface Args {
  readonly file: string;
  readonly options: VerifyOptions;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const positional: string[] = [];
  let expectedWorldId: string | undefined;
  let expectedHeadHash: string | undefined;
  let requireGenesis = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--world":
        expectedWorldId = argv[++i];
        if (expectedWorldId === undefined) return { error: "--world requires a value" };
        break;
      case "--anchor":
        expectedHeadHash = argv[++i];
        if (expectedHeadHash === undefined) return { error: "--anchor requires a value" };
        break;
      case "--require-genesis":
        requireGenesis = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        if (arg.startsWith("-")) return { error: `unknown flag: ${arg}` };
        positional.push(arg);
    }
  }

  const file = positional[0];
  if (file === undefined) return { error: "an events file is required" };

  return {
    file,
    json,
    options: {
      ...(expectedWorldId !== undefined ? { expectedWorldId } : {}),
      ...(expectedHeadHash !== undefined ? { expectedHeadHash } : {}),
      requireGenesis,
    },
  };
}

const USAGE = `ag-verify — verify an exported After Genesis history

Usage:
  ag-verify <events.jsonl> [options]

Options:
  --world <id>         Require every event to belong to this world
  --anchor <hash>      Compare the head hash against a published anchor.
                       Without this, a wholesale forgery from a different
                       Genesis would still verify as self-consistent.
  --require-genesis    Fail unless the log begins at sequence 0
  --json               Emit the report as JSON

Exit codes: 0 verified, 1 verification failed, 2 usage error.`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return argv.length === 0 ? 2 : 0;
  }

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }

  let contents: string;
  try {
    contents = await readFile(parsed.file, "utf8");
  } catch (error) {
    process.stderr.write(
      `error: cannot read ${parsed.file}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const { values, parseErrors } = parseJsonl(contents);
  const report = verifyExport(values, parsed.options);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ ...report, parseErrors }, null, 2)}\n`);
  } else {
    if (parseErrors.length > 0) {
      process.stderr.write(`  ${parseErrors.length} unparseable line(s):\n`);
      for (const e of parseErrors.slice(0, 10)) process.stderr.write(`    ${e}\n`);
    }
    process.stdout.write(`${formatReport(report)}\n`);
  }

  // Unparseable lines are a failure: a log we cannot fully read is a log we
  // cannot vouch for.
  return report.ok && parseErrors.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  },
);
