import { Socket } from "socket.io";
import { VNSyncData } from "./VNSyncData";

/**
 * Interface that represents the Socket IO instance with VNSync-specific data.
 */
export interface VNSyncSocket extends Socket {
  /**
   * Data associated with the socket.
   */
  data: VNSyncData;
}
