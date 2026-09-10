#!/usr/bin/env node

import { runCli } from "./run.js";
import { createCliApplication } from "../app/application.js";

process.exitCode = await runCli(process.argv.slice(2), {
  application: createCliApplication(),
});
