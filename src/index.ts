import { VNSyncServer } from "./VNSyncServer";

const server = new VNSyncServer();
server.start(Number.parseInt(process.env.PORT || "8080"));
