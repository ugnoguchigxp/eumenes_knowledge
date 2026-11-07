// 明示実行した時だけ stdio で待受する入口。
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, dummyApi } from "./server";

serveStdio(() => createServer(dummyApi));
