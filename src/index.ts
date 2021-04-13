import { getLogger } from "loglevel";
import { VNSyncServer } from "./VNSyncServer";

const log = getLogger("vnsync");
log.setLevel("info");

const server = new VNSyncServer(log);
server.start(Number.parseInt(process.env.PORT || "8080"));
