import { Connection } from "./Connection";

export interface Room {
  connections: Connection[];
  host: Connection;
}
