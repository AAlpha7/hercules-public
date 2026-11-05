#!/usr/bin/env node
// Pre-promote gate: compare hashCanonicalJson(parseTaskFile(file)) between two
// BUILT trees over every task file in a control repo.
//
//   node scripts/check-task-hash-stability.mjs <old-dist> <new-dist> <control>/tasks
//
// The shadow reconciler binds every historical projection envelope to the
// canonical hash of the parsed Task; a parser change that alters the hash of an
// EXISTING task (e.g. a new optional field parsed as `null`) makes production
// boot fail closed ("reconciliation envelope is not bound to its exact task
// tree") — 2026-09-06 rollback. Run it with the running release's dist as
// <old-dist> and the candidate's dist as <new-dist> before promoting; exit 1
// on any difference. Differences are legitimate only for tasks whose FILE
// changed to carry a field the old parser drops (then a rollback below that
// build is no longer boot-safe — record it in the ledger).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [oldDist, newDist, tasksDir] = process.argv.slice(2).map((p) => resolve(p));
if (!oldDist || !newDist || !tasksDir) {
  console.error('usage: check-task-hash-stability.mjs <old-dist> <new-dist> <control>/tasks');
  process.exit(2);
}
const oldTf = await import(join(oldDist, 'src/control/taskFile.js'));
const newTf = await import(join(newDist, 'src/control/taskFile.js'));
const oldCj = await import(join(oldDist, 'src/domain/canonicalJson.js'));
const newCj = await import(join(newDist, 'src/domain/canonicalJson.js'));
let same = 0; const diffs = [];
for (const f of readdirSync(tasksDir).filter((n) => n.endsWith('.md'))) {
  const text = readFileSync(join(tasksDir, f), 'utf8'); const id = f.slice(0, -3);
  let a, b;
  try { a = oldCj.hashCanonicalJson(oldTf.parseTaskFile(text, id)); } catch (e) { a = 'ERR:' + e.message; }
  try { b = newCj.hashCanonicalJson(newTf.parseTaskFile(text, id)); } catch (e) { b = 'ERR:' + e.message; }
  if (a === b) same += 1; else diffs.push({ id, a: a.slice(0, 12), b: b.slice(0, 12) });
}
console.log(JSON.stringify({ tasks: same + diffs.length, same, diffs: diffs.slice(0, 10), diffCount: diffs.length }));
process.exit(diffs.length === 0 ? 0 : 1);
