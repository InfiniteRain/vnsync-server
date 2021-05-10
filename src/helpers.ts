import { Server } from "socket.io";
import { VNSyncSocket } from "./interfaces/VNSyncSocket";

/**
 * Checks whether a room with the given name exists.
 *
 * @param io The server instance.
 * @param roomName The name of the room in question.
 * @returns True if the room exists, false otherwise.
 */
export const roomExists = (io: Server, roomName: string): boolean =>
  !!io.sockets.adapter.rooms.get(roomName);

/**
 * Gets room members.
 *
 * @param io The server instance.
 * @param roomName The name of the room in question.
 * @returns An array of members.
 */
export const getRoomMembers = (
  io: Server,
  roomName: string
): VNSyncSocket[] => {
  const membersSet = io.sockets.adapter.rooms.get(roomName);

  if (!membersSet) {
    throw new Error("Room doesn't exist.");
  }

  const members: VNSyncSocket[] = [];

  for (const memberId of membersSet.values()) {
    members.push(getClientById(io, memberId));
  }

  return members;
};

/**
 * Gets all clients currently connected to the server.
 *
 * @param io The server instance.
 * @returns A map of clients.
 */
export const getAllClients = (io: Server): Map<string, VNSyncSocket> =>
  io.of("/").sockets as Map<string, VNSyncSocket>;

/**
 * Gets a client by its session ID.
 *
 * @param io The server instance.
 * @param sessionId The session ID of the client in question.
 * @returns The client in question.
 */
export const getClientBySessionId = (
  io: Server,
  sessionId: string
): VNSyncSocket | null => {
  const clients = getAllClients(io);

  for (const client of clients.values()) {
    if (client.data.sessionId === sessionId) {
      return client;
    }
  }

  return null;
};

/**
 * Gets a client by its socket ID.
 *
 * @param io The server instance.
 * @param id The ID of the client in question.
 * @returns The client in question.
 */
const getClientById = (io: Server, id: string): VNSyncSocket => {
  const client = io.of("/").sockets.get(id);

  if (!client) {
    throw new Error("Client doesn't exist.");
  }

  return client as VNSyncSocket;
};
