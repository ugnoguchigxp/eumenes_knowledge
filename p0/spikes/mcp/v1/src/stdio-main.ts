// 明示実行した時だけ stdio で待受する入口。
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, dummyApi } from "./server";

await createServer(dummyApi).connect(new StdioServerTransport());
