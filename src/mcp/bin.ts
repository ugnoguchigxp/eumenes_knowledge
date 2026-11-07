#!/usr/bin/env bun
import { runMcp } from "./index.js";

process.exitCode = await runMcp(process.argv.slice(2));
