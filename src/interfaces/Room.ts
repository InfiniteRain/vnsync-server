import { Connection } from "./Connection";

/**
 * Interface representing a room on the server.
 */
export interface Room {
  /**
   * Name of the room.
   */
  name: string;

  /**
   * The list of connections that belong to the room.
   */
  connections: Connection[];
}
